// Evidence gathering for the live agent (same sources as the CRE workflow).
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { parseCoinbaseCandles, type Candle, type WhaleEvidence } from "../shared/strategy"
import { addressTopic, EXCHANGES, STABLES, summarizeWhaleLogs, TRANSFER_TOPIC, type RawLog } from "../shared/whales"

export const MAINNET_RPC = process.env.MAINNET_RPC || "https://ethereum-rpc.publicnode.com"
const UA = { "User-Agent": "tidewatch-agent/1.0", Accept: "application/json" }

export async function fetchCandles(product = "ETH-USD", nowSec = Math.floor(Date.now() / 1000)): Promise<Candle[]> {
  const r = await fetch(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600`, { headers: UA })
  if (!r.ok) throw new Error(`coinbase HTTP ${r.status}`)
  return parseCoinbaseCandles(await r.text(), nowSec)
}

// Historical hourly candles for replay (Coinbase returns max 300 per call).
export async function fetchHistory(product: string, days: number): Promise<Candle[]> {
  const out = new Map<number, Candle>()
  const end = Math.floor(Date.now() / 1000 / 3600) * 3600
  for (let to = end; to > end - days * 86400; to -= 300 * 3600) {
    const from = Math.max(to - 300 * 3600, end - days * 86400)
    const u = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(from * 1000).toISOString()}&end=${new Date(to * 1000).toISOString()}`
    const r = await fetch(u, { headers: UA })
    if (!r.ok) throw new Error(`coinbase HTTP ${r.status}`)
    for (const c of parseCoinbaseCandles(await r.text(), end, 1000)) out.set(c.t, c)
    await new Promise((res) => setTimeout(res, 400))
  }
  return [...out.values()].sort((a, b) => a.t - b.t)
}

export async function fetchWhales(windowBlocks = 300, minUsd = 500_000): Promise<WhaleEvidence> {
  const client = createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) })
  const fin = await client.getBlock({ blockTag: "finalized" })
  const toBlock = fin.number
  const fromBlock = toBlock - BigInt(windowBlocks) + 1n
  const ex = Object.keys(EXCHANGES).map(addressTopic) as `0x${string}`[]
  const tokens = Object.keys(STABLES) as `0x${string}`[]
  const raw: RawLog[] = []
  for (const topics of [
    [TRANSFER_TOPIC, ex],
    [TRANSFER_TOPIC, null, ex],
  ]) {
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [{ address: tokens, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, topics: topics as any }],
    })) as any[]
    for (const l of logs) raw.push({ address: l.address, topics: l.topics, data: l.data, txHash: l.transactionHash })
  }
  return summarizeWhaleLogs(raw, minUsd, Number(fromBlock), Number(toBlock))
}
