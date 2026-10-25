// Prints the entries recorded in PracticeLedger.  node read.mjs <ledgerAddress>
import { readFileSync } from "fs"
import { createPublicClient, http } from "viem"
import { sepolia } from "viem/chains"
const addr = process.argv[2]
const { abi } = JSON.parse(readFileSync(new URL("./out/PracticeLedger.json", import.meta.url), "utf8"))
const pub = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com") })
const n = await pub.readContract({ address: addr, abi, functionName: "count" })
console.log(`${n} decisions recorded`)
const SIG = ["WAIT", "BUY", "AVOID"]
for (let i = 0n; i < n; i++) {
  const e = await pub.readContract({ address: addr, abi, functionName: "get", args: [i] })
  console.log(`#${i} asOf ${new Date(Number(e.asOf) * 1000).toISOString()} ${SIG[e.signal]} ${e.reasonCode} conf ${e.confidence} price $${Number(e.priceCents) / 100} rsi ${e.rsiX10 / 10} dip ${e.dipBps / 100}% netFlow $${e.netFlowUsd} evidence ${e.evidenceHash}`)
}
