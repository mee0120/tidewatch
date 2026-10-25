import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs"
import path from "path"
import { keccak256, stringToHex } from "viem"
import { canonicalJson, DEFAULT_PARAMS, type Evidence } from "../shared/strategy"
import { newState, type State, type TrailEntry } from "./engine"

export const DATA = path.join(import.meta.dir, "data")
mkdirSync(path.join(DATA, "evidence"), { recursive: true })

export const evidenceHash = (evidence: Evidence) => keccak256(stringToHex(canonicalJson({ evidence, params: DEFAULT_PARAMS })))

export function loadState(name: string): State {
  const f = path.join(DATA, `${name}-state.json`)
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : newState()
}
export const saveState = (name: string, s: State) => writeFileSync(path.join(DATA, `${name}-state.json`), JSON.stringify(s, null, 2))
export const appendTrail = (name: string, e: TrailEntry) => appendFileSync(path.join(DATA, `${name}-trail.jsonl`), JSON.stringify(e) + "\n")
export function readTrail(name: string): TrailEntry[] {
  const f = path.join(DATA, `${name}-trail.jsonl`)
  if (!existsSync(f)) return []
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
}
export const saveEvidence = (id: string, ev: Evidence) =>
  writeFileSync(path.join(DATA, "evidence", `${id}.json`), JSON.stringify({ evidence: ev, params: DEFAULT_PARAMS }, null, 2))
export const loadEvidence = (id: string) => JSON.parse(readFileSync(path.join(DATA, "evidence", `${id}.json`), "utf8"))
