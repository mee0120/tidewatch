// Publicly labeled exchange hot wallets on Ethereum mainnet (Etherscan labels).
// Large USDT/USDC transfers into these = fresh buying power arriving on exchanges;
// out of these = buying power leaving.
export const EXCHANGES: Record<string, string> = {
  "0x28c6c06298d514db089934071355e5743bf21d60": "Binance 14",
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "Binance 15",
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "Binance 16",
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "Coinbase 1",
  "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": "Coinbase 10",
  "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": "OKX 7",
  "0xda9dfa130df4de4673b89022ee50ff26f6ea73cf": "Kraken 13",
  "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "Bybit",
}

export const STABLES: Record<string, { symbol: string; decimals: number }> = {
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
}

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

export const addressTopic = (addr: string) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")
export const topicToAddress = (topic: string) => "0x" + topic.toLowerCase().slice(-40)

export type RawLog = { address: string; topics: string[]; data: string; txHash: string }

// Turns raw Transfer logs into the whale evidence used by the strategy.
// Transfers above maxUsd are almost always an exchange moving its own treasury between hot and
// cold wallets (e.g. a single $386M USDT move out of Binance 14), not customers moving buying
// power. They are reported separately and do not count toward the flow.
export function summarizeWhaleLogs(logs: RawLog[], minUsd: number, fromBlock: number, toBlock: number, maxUsd = 100_000_000) {
  let stableInUsd = 0
  let stableOutUsd = 0
  let ignoredUsd = 0
  const all: { token: string; dir: "in" | "out"; usd: number; exchange: string; tx: string }[] = []
  const seen = new Set<string>()
  for (const l of logs) {
    const tok = STABLES[l.address.toLowerCase()]
    if (!tok || l.topics.length < 3) continue
    const key = `${l.txHash}:${l.topics[1]}:${l.topics[2]}:${l.data}`
    if (seen.has(key)) continue
    seen.add(key)
    const from = topicToAddress(l.topics[1])
    const to = topicToAddress(l.topics[2])
    const exFrom = EXCHANGES[from]
    const exTo = EXCHANGES[to]
    if (exFrom && exTo) continue // exchange-internal shuffling, ignore
    const amount = Number(BigInt(l.data) / 10n ** BigInt(tok.decimals))
    if (amount < minUsd) continue
    if (amount > maxUsd) {
      ignoredUsd += amount
      continue
    }
    if (exTo) {
      stableInUsd += amount
      all.push({ token: tok.symbol, dir: "in", usd: amount, exchange: exTo, tx: l.txHash })
    } else if (exFrom) {
      stableOutUsd += amount
      all.push({ token: tok.symbol, dir: "out", usd: amount, exchange: exFrom, tx: l.txHash })
    }
  }
  all.sort((a, b) => b.usd - a.usd || (a.tx < b.tx ? -1 : 1))
  return { fromBlock, toBlock, stableInUsd, stableOutUsd, ignoredUsd, largest: all.slice(0, 5) }
}
