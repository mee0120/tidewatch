// One live step: gather evidence -> decide -> practice trade -> reasoning trail.
// Run hourly from cron (a few minutes after the hour so the 1h candle is closed).
//   bun agent/live.ts
import { step } from "./engine"
import { fetchCandles, fetchWhales } from "./sources"
import { appendTrail, evidenceHash, loadState, saveEvidence, saveState } from "./store"
import type { Evidence } from "../shared/strategy"

const st = loadState("live")
const candles = await fetchCandles("ETH-USD")
const asOf = candles[candles.length - 1].t + 3600
if (st.lastCandleT === candles[candles.length - 1].t) {
  console.log("no new closed candle since last run - nothing to do")
  process.exit(0)
}
let whale = null
try {
  whale = await fetchWhales()
} catch (e) {
  console.error("whale data unavailable:", (e as Error).message)
}
const ev: Evidence = { asset: "ETH", source: "coinbase-1h+eth-mainnet-transfers", asOf, candles, whale }
const id = `L${asOf}`
const hash = evidenceHash(ev)
saveEvidence(id, ev)
const t = step(st, ev, id, "live", hash)
appendTrail("live", t)
saveState("live", st)
console.log(`[${new Date(asOf * 1000).toISOString()}] ${t.decision.signal}/${t.decision.reasonCode} -> ${t.action}: ${t.actionReason}`)
console.log(`evidence ${hash}`)
