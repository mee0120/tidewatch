// Tidewatch strategy: "buy the dip, but only if the whales are not draining the pool".
//
// Pure functions only (no I/O, no clock, no randomness) so the exact same code runs
//  - inside the Chainlink CRE workflow (WASM, every DON node must agree), and
//  - inside the off-chain practice-trading agent.
// Same evidence in => same decision and same reasoning trail out.

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number }

export type WhaleTransfer = { token: string; dir: "in" | "out"; usd: number; exchange: string; tx: string }

export type WhaleEvidence = {
  fromBlock: number
  toBlock: number
  stableInUsd: number // large stablecoin transfers INTO exchange hot wallets (fresh buying power)
  stableOutUsd: number // large stablecoin transfers OUT of exchange hot wallets (buying power leaving)
  ignoredUsd?: number // single transfers too large to be customer flow (exchange treasury moves), excluded
  largest: WhaleTransfer[] // up to 5 largest, for the reasoning trail
}

export type Evidence = {
  asset: string
  source: string
  asOf: number // unix seconds, close time of the last CLOSED hourly candle
  candles: Candle[] // hourly, oldest first, closed candles only
  whale: WhaleEvidence | null
}

export type Params = {
  dipMinPct: number // price must be at least this far below the 24h high
  rsiMax: number // RSI(14, 1h) must be at or below this
  knifeAtrMult: number // last candle body > N x ATR = falling knife, wait
  whaleDrainUsd: number // net stablecoin OUTflow from exchanges above this = avoid
  whaleSupportUsd: number // net stablecoin INflow to exchanges above this = support
  trendEma: number // regime filter: EMA length in hours (0 = off)
  trendMaxBelowPct: number // skip dips when price is more than this % below the trend EMA
}

export const DEFAULT_PARAMS: Params = {
  dipMinPct: 5,
  rsiMax: 38,
  knifeAtrMult: 2.5,
  whaleDrainUsd: 15_000_000,
  whaleSupportUsd: 5_000_000,
  trendEma: 100,
  trendMaxBelowPct: 3,
}

export type Check = { id: string; label: string; value: string; rule: string; pass: boolean }

export type Signal = "BUY" | "WAIT" | "AVOID"

export type Decision = {
  asset: string
  asOf: number
  signal: Signal
  confidence: number // 0..100
  reasonCode: string
  summary: string
  metrics: {
    price: number
    high24: number
    dipPct: number
    rsi14: number
    atr14: number
    ret24Pct: number
    netStableFlowUsd: number | null
  }
  checks: Check[]
}

const round = (x: number, d = 2) => {
  const f = 10 ** d
  return Math.round(x * f) / f
}
const usd = (x: number) => (Math.abs(x) >= 1e6 ? `$${round(x / 1e6, 1)}M` : `$${round(x, 0)}`)

export function rsi(closes: number[], period = 14): number {
  if (closes.length <= period) return 50
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
  }
  if (loss === 0) return 100
  return 100 - 100 / (1 + gain / loss)
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const pc = candles[i - 1].c
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)))
  }
  const last = trs.slice(-period)
  return last.reduce((a, b) => a + b, 0) / last.length
}

export function ema(xs: number[], n: number): number {
  const k = 2 / (n + 1)
  let e = xs[0]
  for (let i = 1; i < xs.length; i++) e = xs[i] * k + e * (1 - k)
  return e
}

export function decide(ev: Evidence, p: Params = DEFAULT_PARAMS): Decision {
  const cs = ev.candles
  if (cs.length < 30) throw new Error(`need >= 30 hourly candles, got ${cs.length}`)
  const last = cs[cs.length - 1]
  const day = cs.slice(-24)
  const price = last.c
  const high24 = Math.max(...day.map((c) => c.h))
  const dipPct = ((high24 - price) / high24) * 100
  const r = rsi(cs.map((c) => c.c))
  const a = atr(cs)
  const ret24 = ((price - day[0].o) / day[0].o) * 100
  const body = last.o - last.c // positive = red candle
  const net = ev.whale ? ev.whale.stableInUsd - ev.whale.stableOutUsd : null
  const useTrend = p.trendEma > 0 && cs.length >= p.trendEma
  const trend = useTrend ? ema(cs.map((c) => c.c), p.trendEma) : 0
  const belowTrendPct = useTrend ? ((trend - price) / trend) * 100 : 0

  const checks: Check[] = [
    {
      id: "dip",
      label: "Price is in a dip",
      value: `${round(dipPct)}% below 24h high ${round(high24)}`,
      rule: `>= ${p.dipMinPct}%`,
      pass: dipPct >= p.dipMinPct,
    },
    {
      id: "rsi",
      label: "Selling looks exhausted",
      value: `RSI(14,1h) ${round(r, 1)}`,
      rule: `<= ${p.rsiMax}`,
      pass: r <= p.rsiMax,
    },
    {
      id: "knife",
      label: "Not a falling knife",
      value: `last candle ${body > 0 ? "-" : "+"}${round(Math.abs(body))} vs ATR ${round(a)}`,
      rule: `red body < ${p.knifeAtrMult} x ATR`,
      pass: !(body > 0 && body > p.knifeAtrMult * a),
    },
    {
      id: "trend",
      label: "Not fighting a downtrend",
      value: useTrend ? `price ${belowTrendPct >= 0 ? round(belowTrendPct) + "% below" : round(-belowTrendPct) + "% above"} EMA${p.trendEma}h ${round(trend)}` : "not enough history",
      rule: useTrend ? `<= ${p.trendMaxBelowPct}% below` : "skipped",
      pass: !useTrend || belowTrendPct <= p.trendMaxBelowPct,
    },
  ]
  if (net === null) {
    checks.push({ id: "whale", label: "Whales not draining exchanges", value: "no on-chain data", rule: "skipped", pass: true })
  } else {
    checks.push({
      id: "whale",
      label: "Whales not draining exchanges",
      value:
        `net stablecoin flow to exchanges ${net >= 0 ? "+" : "-"}${usd(Math.abs(net))} (in ${usd(ev.whale!.stableInUsd)} / out ${usd(ev.whale!.stableOutUsd)})` +
        (ev.whale!.ignoredUsd ? `; ignored ${usd(ev.whale!.ignoredUsd)} of treasury-size moves` : ""),
      rule: `net > -${usd(p.whaleDrainUsd)}`,
      pass: net > -p.whaleDrainUsd,
    })
  }

  const ok = (id: string) => checks.find((c) => c.id === id)!.pass
  let signal: Signal
  let reasonCode: string
  let summary: string
  if (!ok("whale")) {
    signal = "AVOID"
    reasonCode = "WHALE_DRAIN"
    summary = `Large stablecoin outflows from exchanges (${usd(-(net as number))} net) - buying power is leaving, no dip buying.`
  } else if (ok("dip") && ok("rsi") && ok("knife") && ok("trend")) {
    signal = "BUY"
    reasonCode = net !== null && net >= p.whaleSupportUsd ? "DIP_WHALE_SUPPORT" : "DIP_EXHAUSTION"
    summary =
      `${ev.asset} is ${round(dipPct)}% below its 24h high with RSI ${round(r, 1)} - sellers look exhausted` +
      (reasonCode === "DIP_WHALE_SUPPORT" ? `, and ${usd(net as number)} of stablecoins just moved onto exchanges.` : ".")
  } else if (ok("dip") && ok("rsi") && !ok("knife")) {
    signal = "WAIT"
    reasonCode = "FALLING_KNIFE"
    summary = `Dip qualifies but the last hour fell more than ${p.knifeAtrMult} x ATR - waiting for the drop to slow.`
  } else if (ok("dip") && ok("rsi") && !ok("trend")) {
    signal = "WAIT"
    reasonCode = "DOWNTREND"
    summary = `Dip qualifies but price is ${round(belowTrendPct)}% under its ${p.trendEma}h trend - this looks like a downtrend, not a dip.`
  } else {
    signal = "WAIT"
    reasonCode = ok("dip") ? "RSI_NOT_LOW" : "NO_DIP"
    summary = ok("dip")
      ? `Price is down ${round(dipPct)}% but RSI ${round(r, 1)} says selling is not exhausted yet.`
      : `No dip: price only ${round(dipPct)}% below the 24h high.`
  }

  let confidence = 0
  if (signal === "BUY") {
    confidence = 55
    confidence += Math.min(20, (p.rsiMax - r) * 2)
    confidence += Math.min(10, (dipPct - p.dipMinPct) * 3)
    if (reasonCode === "DIP_WHALE_SUPPORT") confidence += 15
    confidence = Math.round(Math.min(100, confidence))
  }

  return {
    asset: ev.asset,
    asOf: ev.asOf,
    signal,
    confidence,
    reasonCode,
    summary,
    metrics: {
      price: round(price),
      high24: round(high24),
      dipPct: round(dipPct),
      rsi14: round(r, 1),
      atr14: round(a),
      ret24Pct: round(ret24),
      netStableFlowUsd: net === null ? null : Math.round(net),
    },
    checks,
  }
}

// Deterministic JSON (sorted keys) so the evidence hash is reproducible by anyone.
export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x)
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`
  const o = x as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`
}

export const SIGNAL_CODE: Record<Signal, number> = { WAIT: 0, BUY: 1, AVOID: 2 }

// ---- parsing helpers shared by the workflow and the agent ----

// Coinbase Exchange candles: [[time, low, high, open, close, volume], ...] newest first
export function parseCoinbaseCandles(body: string, nowSec: number, keep = 168): Candle[] {
  const raw = JSON.parse(body) as number[][]
  return raw
    .map((r) => ({ t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }))
    .filter((c) => c.t + 3600 <= nowSec) // closed candles only
    .sort((a, b) => a.t - b.t)
    .slice(-keep)
}
