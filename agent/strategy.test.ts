import { expect, test } from "bun:test"
import { canonicalJson, decide, type Candle } from "../shared/strategy"
import { newState, stats, step } from "./engine"
import { summarizeWhaleLogs, addressTopic } from "../shared/whales"

const mk = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ t: 1_700_000_000 + i * 3600, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c) + 2, l: Math.min(c, i ? closes[i - 1] : c) - 2, c, v: 1 }))

test("flat market -> WAIT/NO_DIP", () => {
  const cs = mk(Array.from({ length: 48 }, () => 3000))
  const d = decide({ asset: "ETH", source: "t", asOf: 0, candles: cs, whale: null })
  expect(d.signal).toBe("WAIT")
  expect(d.reasonCode).toBe("NO_DIP")
})

test("steady 5% slide -> BUY with exhausted RSI", () => {
  const closes = [...Array.from({ length: 30 }, () => 3000), ...Array.from({ length: 18 }, (_, i) => 3000 - (i + 1) * 9)]
  const d = decide({ asset: "ETH", source: "t", asOf: 0, candles: mk(closes), whale: null })
  expect(d.signal).toBe("BUY")
  expect(d.metrics.rsi14).toBeLessThan(38)
})

test("whale drain -> AVOID even on a dip", () => {
  const closes = [...Array.from({ length: 30 }, () => 3000), ...Array.from({ length: 18 }, (_, i) => 3000 - (i + 1) * 9)]
  const d = decide({ asset: "ETH", source: "t", asOf: 0, candles: mk(closes), whale: { fromBlock: 1, toBlock: 2, stableInUsd: 1e6, stableOutUsd: 50e6, largest: [] } })
  expect(d.signal).toBe("AVOID")
})

test("whale log parsing", () => {
  const usdt = "0xdac17f958d2ee523a2206206994597c13d831ec7"
  const binance = "0x28c6c06298d514db089934071355e5743bf21d60"
  const user = "0x1111111111111111111111111111111111111111"
  const amt = (usd: number) => "0x" + (BigInt(usd) * 10n ** 6n).toString(16).padStart(64, "0")
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  const w = summarizeWhaleLogs([
    { address: usdt, topics: [T, addressTopic(user), addressTopic(binance)], data: amt(3_000_000), txHash: "0xa" },
    { address: usdt, topics: [T, addressTopic(binance), addressTopic(user)], data: amt(1_500_000), txHash: "0xb" },
    { address: usdt, topics: [T, addressTopic(binance), addressTopic(user)], data: amt(10_000), txHash: "0xc" },
    { address: usdt, topics: [T, addressTopic(binance), addressTopic(user)], data: amt(386_000_000), txHash: "0xd" },
  ], 1_000_000, 1, 2)
  expect(w.stableInUsd).toBe(3_000_000)
  expect(w.stableOutUsd).toBe(1_500_000)
  expect(w.largest[0].exchange).toBe("Binance 14")
  expect(w.ignoredUsd).toBe(386_000_000) // treasury-size move excluded from the flow
})

test("canonical json is key-order independent", () => {
  expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }))
})

test("engine: open on BUY, close at target, links exit to entry", () => {
  let closes = [...Array.from({ length: 30 }, () => 3000), ...Array.from({ length: 18 }, (_, i) => 3000 - (i + 1) * 9)]
  const st = newState()
  const ev = (cs: Candle[]) => ({ asset: "ETH", source: "t", asOf: cs[cs.length - 1].t + 3600, candles: cs.slice(-48), whale: null })
  let cs = mk(closes)
  const a = step(st, ev(cs), "E1", "replay", null)
  expect(a.action).toBe("OPEN")
  // strong rebound
  closes = [...closes, ...Array.from({ length: 10 }, (_, i) => 2838 + (i + 1) * 20)]
  cs = mk(closes)
  const b = step(st, ev(cs), "E2", "replay", null)
  expect(b.action).toBe("CLOSE")
  expect(b.linkedEntryId).toBe("E1")
  expect(b.trade!.pnlUsd).toBeGreaterThan(0)
  expect(stats(st).trades).toBe(1)
})
