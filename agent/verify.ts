// Re-run the strategy on a stored evidence file and check the decision + hash.
//   bun agent/verify.ts L1793000000
import { canonicalJson, decide } from "../shared/strategy"
import { keccak256, stringToHex } from "viem"
import { loadEvidence, readTrail } from "./store"

const id = process.argv[2]
if (!id) throw new Error("usage: bun agent/verify.ts <decision id>")
const file = loadEvidence(id)
const hash = keccak256(stringToHex(canonicalJson(file)))
const d = decide(file.evidence, file.params)
const logged = readTrail("live").find((e) => e.id === id)
console.log(`evidence hash   ${hash}`)
console.log(`logged hash     ${logged?.evidenceHash}  ${logged?.evidenceHash === hash ? "MATCH" : "MISMATCH"}`)
console.log(`recomputed      ${d.signal}/${d.reasonCode} (confidence ${d.confidence})`)
console.log(`logged decision ${logged?.decision.signal}/${logged?.decision.reasonCode}  ${logged && logged.decision.signal === d.signal && logged.decision.reasonCode === d.reasonCode ? "MATCH" : "MISMATCH"}`)
