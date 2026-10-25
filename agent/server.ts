// Dashboard: bun agent/server.ts  ->  http://localhost:8787   (demo mode: http://localhost:8787/?demo)
// Binds to localhost only; view it from your PC through an SSH tunnel:
//   ssh -L 8787:localhost:8787 root@<vps>
import { existsSync, readFileSync } from "fs"
import path from "path"
import { createPublicClient, http } from "viem"
import { sepolia } from "viem/chains"
import { stats } from "./engine"
import { DATA, loadEvidence, loadState, readTrail } from "./store"

const PORT = Number(process.env.PORT || 8787)
const ROOT = path.join(import.meta.dir, "..")
const json = (x: unknown) =>
  new Response(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)), { headers: { "content-type": "application/json" } })

const LEDGER_ABI = [
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "asOf", type: "uint64" }, { name: "signal", type: "uint8" }, { name: "confidence", type: "uint8" },
        { name: "priceCents", type: "uint64" }, { name: "rsiX10", type: "uint16" }, { name: "dipBps", type: "uint16" },
        { name: "netFlowUsd", type: "int64" }, { name: "evidenceHash", type: "bytes32" }, { name: "reasonCode", type: "string" },
        { name: "recordedAt", type: "uint64" },
      ],
    }],
  },
] as const

function ledgerAddress(): `0x${string}` | null {
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, "attest-workflow", "config.staging.json"), "utf8"))
    return /^0x[0-9a-fA-F]{40}$/.test(cfg.ledgerAddress) && !/^0x0+$/.test(cfg.ledgerAddress) ? cfg.ledgerAddress : null
  } catch { return null }
}
const sep = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com") })
let ledgerCache: { at: number; data: unknown } | null = null
async function readLedger() {
  if (ledgerCache && Date.now() - ledgerCache.at < 60_000) return ledgerCache.data
  const address = ledgerAddress()
  if (!address) return { address: null, entries: [] }
  const n = await sep.readContract({ address, abi: LEDGER_ABI, functionName: "count" })
  const entries = []
  for (let i = 0n; i < n; i++) entries.push({ id: Number(i), ...(await sep.readContract({ address, abi: LEDGER_ABI, functionName: "get", args: [i] })) })
  const data = { address, entries }
  ledgerCache = { at: Date.now(), data }
  return data
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url)
    const mode = u.searchParams.get("mode") === "replay" ? "replay" : "live"
    if (u.pathname === "/") return new Response(Bun.file(path.join(import.meta.dir, "dashboard.html")), { headers: { "content-type": "text/html; charset=utf-8" } })
    if (u.pathname === "/api/summary") {
      const st = loadState(mode)
      return json({ mode, stats: stats(st), position: st.position, trades: st.trades })
    }
    if (u.pathname === "/api/trail") return json(readTrail(mode))
    if (u.pathname === "/api/ledger") {
      try { return json(await readLedger()) } catch (e) { return json({ error: (e as Error).message, entries: [] }) }
    }
    if (u.pathname === "/api/cre-log") {
      const f = path.join(DATA, "cre-sim.log")
      if (!existsSync(f)) return json({ lines: [] })
      // strip terminal colors, keep the interesting part
      const lines = readFileSync(f, "utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n")
        .filter((l) => /USER LOG|SIMULATION\]|Workflow compiled|report written|DECISION|\[x\]|\[ \]/.test(l))
      return json({ lines: lines.slice(-40) })
    }
    if (u.pathname.startsWith("/api/evidence/")) {
      try { return json(loadEvidence(u.pathname.split("/").pop()!)) } catch { return new Response("not found", { status: 404 }) }
    }
    return new Response("not found", { status: 404 })
  },
})
console.log(`Tidewatch dashboard on http://127.0.0.1:${PORT}  (demo: /?demo)`)
