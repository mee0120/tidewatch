// Practice-trading engine: turns strategy decisions into practice trades with explicit
// risk limits, and writes a reasoning trail that links every exit back to the entry
// decision (and evidence) that caused it.
import { decide, DEFAULT_PARAMS, type Candle, type Decision, type Evidence, type Params } from "../shared/strategy"

export type Risk = {
  startEquity: number
  riskPerTradePct: number // equity at risk if the stop is hit
  maxPositionPct: number // cap on position notional as % of equity
  stopAtr: number // stop distance in ATRs
  targetR: number // take profit at N x risk
  maxHoldHours: number // time stop
  cooldownHoursAfterLoss: number
}

export const DEFAULT_RISK: Risk = {
  startEquity: 10_000,
  riskPerTradePct: 1,
  maxPositionPct: 25,
  stopAtr: 1.5,
  targetR: 2,
  maxHoldHours: 48,
  cooldownHoursAfterLoss: 6,
}

export type Position = {
  entryDecisionId: string
  openedAt: number
  entry: number
  qty: number
  stop: number
  target: number
  riskUsd: number
}

export type Trade = Position & {
  closedAt: number
  exit: number
  exitReason: string
  exitDecisionId: string
  pnlUsd: number
  rMultiple: number
}

export type State = {
  equity: number
  position: Position | null
  trades: Trade[]
  lastLossAt: number | null
  lastCandleT: number | null
}

export type TrailEntry = {
  id: string
  at: number // evidence time (unix s)
  mode: "live" | "replay"
  evidenceHash: string | null
  decision: Decision
  action: "OPEN" | "CLOSE" | "HOLD" | "SKIP" | "NONE"
  actionReason: string
  linkedEntryId?: string
  trade?: Trade
  position?: Position | null
  equity: number
  attestation?: { tx?: string; signal?: string; match?: boolean }
}

export const newState = (r: Risk = DEFAULT_RISK): State => ({ equity: r.startEquity, position: null, trades: [], lastLossAt: null, lastCandleT: null })

const r2 = (x: number) => Math.round(x * 100) / 100
const fmt = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 })

// Step the engine with one new piece of evidence. `newCandles` are the closed candles since the
// previous step (used to check whether the stop or target was touched in between).
export function step(
  st: State,
  ev: Evidence,
  id: string,
  mode: "live" | "replay",
  evidenceHash: string | null,
  risk: Risk = DEFAULT_RISK,
  params: Params = DEFAULT_PARAMS,
): TrailEntry {
  const d = decide(ev, params)
  const newCandles: Candle[] = ev.candles.filter((c) => st.lastCandleT === null || c.t > st.lastCandleT)
  st.lastCandleT = ev.candles[ev.candles.length - 1].t
  const base = { id, at: ev.asOf, mode, evidenceHash, decision: d }

  // ---- manage an open position first ----
  if (st.position) {
    const p = st.position
    let exit: number | null = null
    let why = ""
    for (const c of newCandles) {
      if (c.l <= p.stop) { exit = p.stop; why = `stop-loss hit at ${fmt(p.stop)} (1h low ${fmt(c.l)})`; break }
      if (c.h >= p.target) { exit = p.target; why = `target ${risk.targetR}R hit at ${fmt(p.target)} (1h high ${fmt(c.h)})`; break }
    }
    if (exit === null && d.signal === "AVOID") { exit = d.metrics.price; why = `whales draining exchanges (${d.reasonCode}) - exit at market` }
    if (exit === null && ev.asOf - p.openedAt >= risk.maxHoldHours * 3600) { exit = d.metrics.price; why = `time stop: held ${risk.maxHoldHours}h without hitting stop or target` }
    if (exit === null && d.metrics.rsi14 >= 70) { exit = d.metrics.price; why = `RSI ${d.metrics.rsi14} >= 70 - bounce is extended, take it` }

    if (exit !== null) {
      const pnl = (exit - p.entry) * p.qty
      const trade: Trade = { ...p, closedAt: ev.asOf, exit: r2(exit), exitReason: why, exitDecisionId: id, pnlUsd: r2(pnl), rMultiple: r2(pnl / p.riskUsd) }
      st.equity = r2(st.equity + pnl)
      st.trades.push(trade)
      st.position = null
      if (pnl < 0) st.lastLossAt = ev.asOf
      return { ...base, action: "CLOSE", actionReason: `${why}. P&L ${pnl >= 0 ? "+" : ""}${fmt(pnl)} USD (${trade.rMultiple}R)`, linkedEntryId: p.entryDecisionId, trade, position: null, equity: st.equity }
    }
    return { ...base, action: "HOLD", actionReason: `holding since ${new Date(p.openedAt * 1000).toISOString().slice(0, 16)}Z; stop ${fmt(p.stop)}, target ${fmt(p.target)}`, linkedEntryId: p.entryDecisionId, position: p, equity: st.equity }
  }

  // ---- flat: consider an entry ----
  if (d.signal !== "BUY") return { ...base, action: "NONE", actionReason: d.summary, position: null, equity: st.equity }
  if (st.lastLossAt !== null && ev.asOf - st.lastLossAt < risk.cooldownHoursAfterLoss * 3600) {
    return { ...base, action: "SKIP", actionReason: `BUY signal ignored: cooling down ${risk.cooldownHoursAfterLoss}h after a losing trade`, position: null, equity: st.equity }
  }
  const entry = d.metrics.price
  const stop = entry - risk.stopAtr * d.metrics.atr14
  const riskUsd = (st.equity * risk.riskPerTradePct) / 100
  let qty = riskUsd / (entry - stop)
  const cap = (st.equity * risk.maxPositionPct) / 100 / entry
  let capped = ""
  if (qty > cap) { qty = cap; capped = ` (size capped at ${risk.maxPositionPct}% of equity)` }
  const pos: Position = {
    entryDecisionId: id,
    openedAt: ev.asOf,
    entry,
    qty: Math.round(qty * 1e6) / 1e6,
    stop: r2(stop),
    target: r2(entry + risk.targetR * (entry - stop)),
    riskUsd: r2((entry - stop) * Math.min(qty, cap)),
  }
  st.position = pos
  return {
    ...base,
    action: "OPEN",
    actionReason: `practice BUY ${pos.qty} ${ev.asset} @ ${fmt(entry)}${capped}; stop ${fmt(pos.stop)} (${risk.stopAtr} ATR), target ${fmt(pos.target)} (${risk.targetR}R), risking ${fmt(pos.riskUsd)} USD`,
    position: pos,
    equity: st.equity,
  }
}

export function stats(st: State, risk: Risk = DEFAULT_RISK) {
  const t = st.trades
  const wins = t.filter((x) => x.pnlUsd > 0)
  const gross = (f: (x: Trade) => boolean) => t.filter(f).reduce((a, x) => a + x.pnlUsd, 0)
  const gp = gross((x) => x.pnlUsd > 0)
  const gl = -gross((x) => x.pnlUsd < 0)
  return {
    trades: t.length,
    winRatePct: t.length ? Math.round((wins.length / t.length) * 1000) / 10 : 0,
    profitFactor: gl > 0 ? Math.round((gp / gl) * 100) / 100 : t.length ? null : 0,
    avgR: t.length ? Math.round((t.reduce((a, x) => a + x.rMultiple, 0) / t.length) * 100) / 100 : 0,
    returnPct: Math.round(((st.equity - risk.startEquity) / risk.startEquity) * 10000) / 100,
    equity: st.equity,
  }
}
