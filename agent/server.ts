// Dashboard: bun agent/server.ts  ->  http://localhost:8787
// Binds to localhost only; view it from your PC through an SSH tunnel:
//   ssh -L 8787:localhost:8787 root@<vps>
import path from "path"
import { stats } from "./engine"
import { loadEvidence, loadState, readTrail } from "./store"

const PORT = Number(process.env.PORT || 8787)
const html = await Bun.file(path.join(import.meta.dir, "dashboard.html")).text()
const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json" } })

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url)
    const mode = u.searchParams.get("mode") === "replay" ? "replay" : "live"
    if (u.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    if (u.pathname === "/api/summary") {
      const st = loadState(mode)
      return json({ mode, stats: stats(st), position: st.position, trades: st.trades })
    }
    if (u.pathname === "/api/trail") return json(readTrail(mode))
    if (u.pathname.startsWith("/api/evidence/")) {
      try { return json(loadEvidence(u.pathname.split("/").pop()!)) } catch { return new Response("not found", { status: 404 }) }
    }
    return new Response("not found", { status: 404 })
  },
})
console.log(`Tidewatch dashboard on http://127.0.0.1:${PORT}`)
