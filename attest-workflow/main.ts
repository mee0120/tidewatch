// Tidewatch attestation workflow (Chainlink CRE)
//
// Every run (cron):
//   1. HTTP capability  -> hourly ETH-USD candles from Coinbase (each DON node fetches, consensus on identical result)
//   2. EVM read (mainnet) -> large USDT/USDC Transfer logs into / out of exchange hot wallets ("whale flows")
//   3. Same pure strategy code the agent uses -> BUY / WAIT / AVOID + reasoning checks
//   4. EVM write (Sepolia) -> signed report {asOf, signal, confidence, price, rsi, dip, netFlow, reasonCode, evidenceHash}
//      into the PracticeLedger contract, so every practice decision has a tamper-evident public record.
import {
  bytesToHex,
  consensusIdenticalAggregation,
  CronCapability,
  EVMClient,
  getNetwork,
  handler,
  hexToBase64,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  bigintToProtoBigInt,
  protoBigIntToBigint,
  Runner,
  type NodeRuntime,
  type Runtime,
} from "@chainlink/cre-sdk"
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem"
import {
  canonicalJson,
  decide,
  DEFAULT_PARAMS,
  parseCoinbaseCandles,
  SIGNAL_CODE,
  type Candle,
  type Evidence,
  type WhaleEvidence,
} from "../shared/strategy"
import { addressTopic, EXCHANGES, STABLES, summarizeWhaleLogs, TRANSFER_TOPIC, type RawLog } from "../shared/whales"

type Config = {
  schedule: string
  asset: string
  candlesUrl: string
  mainnetChain: string // e.g. ethereum-mainnet
  whaleWindowBlocks: number // how many finalized blocks to scan (300 = ~1h)
  whaleMinUsd: number
  ledgerChain: string // e.g. ethereum-testnet-sepolia
  ledgerAddress: string
  gasLimit: string
  writeReport: boolean
}

const b64ToHex = (b64: string) => {
  const bin = atob(b64)
  let h = "0x"
  for (let i = 0; i < bin.length; i++) h += bin.charCodeAt(i).toString(16).padStart(2, "0")
  return h
}
const anyToHex = (v: unknown): string => {
  if (v instanceof Uint8Array) return bytesToHex(v)
  if (typeof v === "string") return v.startsWith("0x") ? v : b64ToHex(v)
  return "0x"
}

// ---- 1. off-chain data: candles (node mode + consensus) ----
const fetchCandles = (nodeRuntime: NodeRuntime<Config>, nowSec: number): string => {
  const http = new HTTPClient()
  const resp = http
    .sendRequest(nodeRuntime, {
      url: nodeRuntime.config.candlesUrl,
      method: "GET" as const,
      headers: { "User-Agent": "tidewatch-cre/1.0", Accept: "application/json" },
    })
    .result()
  if (resp.statusCode !== 200) throw new Error(`candles HTTP ${resp.statusCode}`)
  const candles = parseCoinbaseCandles(new TextDecoder().decode(resp.body), nowSec)
  // return a compact string so every node's answer can be compared byte-for-byte
  return JSON.stringify(candles.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]))
}

// ---- 2. on-chain data: whale stablecoin flows on Ethereum mainnet ----
const readWhaleFlows = (runtime: Runtime<Config>): WhaleEvidence => {
  const cfg = runtime.config
  const net = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.mainnetChain })
  if (!net) throw new Error(`unknown chain ${cfg.mainnetChain}`)
  const evm = new EVMClient(net.chainSelector.selector)

  const head = evm.headerByNumber(runtime, { blockNumber: LAST_FINALIZED_BLOCK_NUMBER }).result()
  const toBlock = head.header?.blockNumber ? protoBigIntToBigint(head.header.blockNumber) : 0n
  const fromBlock = toBlock - BigInt(cfg.whaleWindowBlocks) + 1n

  const exTopics = Object.keys(EXCHANGES).map((a) => hexToBase64(addressTopic(a)))
  const tokens = Object.keys(STABLES).map((a) => hexToBase64(a))
  const query = (side: 1 | 2) =>
    evm
      .filterLogs(runtime, {
        filterQuery: {
          fromBlock: bigintToProtoBigInt(fromBlock),
          toBlock: bigintToProtoBigInt(toBlock),
          addresses: tokens,
          // topic0 = Transfer, topic1 = from, topic2 = to
          topics:
            side === 1
              ? [{ topic: [hexToBase64(TRANSFER_TOPIC)] }, { topic: exTopics }]
              : [{ topic: [hexToBase64(TRANSFER_TOPIC)] }, { topic: [] }, { topic: exTopics }],
        },
      })
      .result()

  const raw: RawLog[] = []
  for (const side of [1, 2] as const) {
    for (const l of query(side).logs ?? []) {
      raw.push({
        address: anyToHex(l.address),
        topics: (l.topics ?? []).map(anyToHex),
        data: anyToHex(l.data),
        txHash: anyToHex(l.txHash),
      })
    }
  }
  return summarizeWhaleLogs(raw, cfg.whaleMinUsd, Number(fromBlock), Number(toBlock))
}

// ---- 3 + 4. decide and attest ----
const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config
  const nowSec = Math.floor(runtime.now().getTime() / 1000)

  const candleJson = runtime
    .runInNodeMode((nr: NodeRuntime<Config>) => fetchCandles(nr, nowSec), consensusIdenticalAggregation<string>())()
    .result()
  const candles: Candle[] = (JSON.parse(candleJson) as number[][]).map((r) => ({
    t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5],
  }))
  runtime.log(`candles: ${candles.length} closed 1h candles, last close ${candles[candles.length - 1]?.c}`)

  let whale: WhaleEvidence | null = null
  try {
    whale = readWhaleFlows(runtime)
    runtime.log(
      `whales: blocks ${whale.fromBlock}-${whale.toBlock} in=$${whale.stableInUsd} out=$${whale.stableOutUsd} (${whale.largest.length} large transfers)`,
    )
  } catch (e) {
    runtime.log(`whales: unavailable (${(e as Error).message}) - deciding on price evidence only`)
  }

  const evidence: Evidence = {
    asset: cfg.asset,
    source: "coinbase-1h+eth-mainnet-transfers",
    asOf: candles[candles.length - 1].t + 3600,
    candles,
    whale,
  }
  const d = decide(evidence, DEFAULT_PARAMS)
  const evidenceHash = keccak256(stringToHex(canonicalJson({ evidence, params: DEFAULT_PARAMS })))

  runtime.log(`DECISION ${d.signal} (${d.reasonCode}, confidence ${d.confidence}) - ${d.summary}`)
  for (const c of d.checks) runtime.log(`  [${c.pass ? "x" : " "}] ${c.label}: ${c.value} (rule ${c.rule})`)
  runtime.log(`evidenceHash ${evidenceHash}`)

  if (!cfg.writeReport) return JSON.stringify({ ...d, evidenceHash })

  const net = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.ledgerChain })
  if (!net) throw new Error(`unknown chain ${cfg.ledgerChain}`)
  const evm = new EVMClient(net.chainSelector.selector)
  const payload = encodeAbiParameters(
    parseAbiParameters(
      "uint64 asOf, uint8 signal, uint8 confidence, uint64 priceCents, uint16 rsiX10, uint16 dipBps, int64 netFlowUsd, bytes32 evidenceHash, string reasonCode",
    ),
    [
      BigInt(d.asOf),
      SIGNAL_CODE[d.signal],
      d.confidence,
      BigInt(Math.round(d.metrics.price * 100)),
      Math.round(d.metrics.rsi14 * 10),
      Math.round(d.metrics.dipPct * 100),
      BigInt(d.metrics.netStableFlowUsd ?? 0),
      evidenceHash,
      d.reasonCode,
    ],
  )
  const report = runtime
    .report({ encodedPayload: hexToBase64(payload), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
    .result()
  const res = evm
    .writeReport(runtime, { receiver: cfg.ledgerAddress, report, gasConfig: { gasLimit: cfg.gasLimit } })
    .result()
  const txHash = bytesToHex(res.txHash || new Uint8Array(32))
  runtime.log(`report written to PracticeLedger ${cfg.ledgerAddress}: tx ${txHash}`)
  return JSON.stringify({ signal: d.signal, reasonCode: d.reasonCode, evidenceHash, txHash })
}

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()
  return [handler(cron.trigger({ schedule: config.schedule }), onCron)]
}

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}

main()
