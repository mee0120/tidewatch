// Replay the strategy hour by hour over past data to build a track record for the demo.
// Whale flows are not replayed (historical log scans are expensive), so replay decisions
// use price evidence only and say so in their trail ("no on-chain data").
//   bun agent/replay.ts 90      (days)
import { rmSync } from "fs"
import path from "path"
import { newState, stats, step } from "./engine"
import { fetchHistory } from "./sources"
import { appendTrail, DATA, saveState } from "./store"

const days = Number(process.argv[2] || 365)
const hist = await fetchHistory("ETH-USD", days)
console.log(`replaying ${hist.length} hourly candles (${days} days)`)
rmSync(path.join(DATA, "replay-trail.jsonl"), { force: true })
const st = newState()
let n = 0
let prevReason = ""
// Keep the trail readable: every trade event, plus the first hour of each "rejected dip"
// (the agent saw a dip but a safety check said no). Plain HOLD / no-dip hours are not stored.
const REJECTED = new Set(["DOWNTREND", "FALLING_KNIFE", "WHALE_DRAIN", "RSI_NOT_LOW"])
for (let i = 168; i < hist.length; i++) {
  const window = hist.slice(i - 167, i + 1)
  const ev = { asset: "ETH", source: "coinbase-1h (replay)", asOf: window[167].t + 3600, candles: window, whale: null }
  const t = step(st, ev, `R${ev.asOf}`, "replay", null)
  const rc = t.decision.reasonCode
  const keep =
    t.action === "OPEN" || t.action === "CLOSE" || t.action === "SKIP" ||
    (t.action === "NONE" && REJECTED.has(rc) && rc !== prevReason && rc !== "RSI_NOT_LOW")
  if (keep) appendTrail("replay", t), n++
  prevReason = t.action === "NONE" ? rc : ""
}
saveState("replay", st)
console.log(`${n} trail entries written`)
console.log(stats(st))
