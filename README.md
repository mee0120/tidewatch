# Tidewatch

**A practice-trading agent that buys dips only when the evidence says it is a dip — and checks what the whales are doing first.**
Every decision leaves a repeatable reasoning trail, and a Chainlink CRE workflow independently re-derives the decision from the same public data and commits it on-chain.

Built for **BLI Legal Tech Hackathon 2** — RYO-CHAN *Autonomous Agents* bounty and Chainlink *Best workflow with CRE* bounty.

---

## What it does

Every hour, Tidewatch:

1. **Collects evidence**
   - 168 closed 1h ETH-USD candles (Coinbase Exchange public API)
   - **Whale flows** on Ethereum mainnet: every USDT/USDC transfer ≥ $500k into or out of labeled exchange hot wallets (Binance, Coinbase, OKX, Kraken, Bybit) over the last ~300 finalized blocks
2. **Decides** with a fixed, explainable rule set (Buy-the-Dip + Whale check):

   | Check | Rule (default) | Why |
   |---|---|---|
   | Price is in a dip | ≥ 5% below 24h high | only act on real pullbacks |
   | Selling looks exhausted | RSI(14,1h) ≤ 38 | don't buy while sellers are still in control |
   | Not a falling knife | last red candle < 2.5 × ATR | wait for the crash candle to finish |
   | Not fighting a downtrend | price ≤ 3% below EMA100h | a dip in a downtrend is just the trend |
   | Whales not draining exchanges | net stablecoin flow > −$15M | if buying power is leaving exchanges, **AVOID** |

   Output: `BUY` / `WAIT` / `AVOID`, a reason code (`DIP_WHALE_SUPPORT`, `DIP_EXHAUSTION`, `DOWNTREND`, `FALLING_KNIFE`, `WHALE_DRAIN`, …), a confidence score and a one-line summary.
3. **Records the practice trade it would make** with explicit risk limits: 1% of equity at risk, stop 1.5 ATR, target 2R, max 25% of equity per position, 48h time stop, 6h cool-down after a loss. Exits: stop, target, time stop, RSI ≥ 70, or whales start draining (`AVOID` while in a position).
4. **Writes a reasoning trail** — every entry stores the evidence, every check with its value and rule, the action and why. **Every exit links back to the entry decision that caused it** (cause → effect), with P&L in USD and in R.
5. **Commits the evidence**: `evidenceHash = keccak256(canonicalJSON({evidence, params}))`. Anyone can re-run the open-source strategy on the stored evidence and get the same decision (`bun agent/verify.ts <id>`).

## Chainlink CRE workflow (`attest-workflow/`)

The same pure strategy code (`shared/strategy.ts`) runs inside a CRE workflow, so the decision does not depend on trusting the agent's server:

```
Cron trigger (hourly)
  ├─ HTTP capability (node mode)  → Coinbase 1h candles, identical-consensus across DON nodes
  ├─ EVM read: Ethereum mainnet   → headerByNumber(finalized) + filterLogs(USDT/USDC Transfer to/from exchange wallets)
  ├─ decide()                     → BUY / WAIT / AVOID + checks (deterministic, same code as the agent)
  └─ EVM write: Sepolia           → signed report → PracticeLedger.onReport()
                                     stores {asOf, signal, confidence, price, RSI, dip, netFlow, evidenceHash, reasonCode}
```

`contracts/src/PracticeLedger.sol` is an append-only, public ledger of attested decisions (built on Chainlink's `ReceiverTemplate`, so only the CRE Forwarder can write).

**Live on Sepolia:** PracticeLedger [`0xdf1006d23c541d2c3dfcb76a17f7be78530557d5`](https://sepolia.etherscan.io/address/0xdf1006d23c541d2c3dfcb76a17f7be78530557d5) — written by `cre workflow simulate --broadcast` through the Sepolia CRE forwarder. Read it with `node contracts/read.mjs 0xdf1006d23c541d2c3dfcb76a17f7be78530557d5`.

### Cause and effect, on-chain: the first attested decision

The very first decision the workflow committed to Sepolia was **`AVOID / WHALE_DRAIN`** — net stablecoin flow of **−$393M** out of exchanges. The evidence trail made the cause obvious: a single **$386M USDT transfer out of Binance 14** in one transaction. That is an exchange moving its own treasury between hot and cold wallets, not customers pulling buying power.

Because the evidence was recorded, the mistake was diagnosable in minutes, and the rule was fixed: single transfers above **$100M** are now excluded from the flow and reported separately as `ignored … of treasury-size moves`. The original record stays on-chain unchanged — that is the point of an append-only ledger.

### Deploy the ledger (Sepolia) and simulate

```bash
# prerequisites: CRE CLI (cre login), Bun
cd attest-workflow && bun install && cd ..
cre workflow simulate attest-workflow --target staging-settings            # dry run

# optional: real on-chain write
cd contracts && npm install && node compile.mjs
node keygen.mjs                                       # throwaway key -> ../.env, fund it with Sepolia ETH
node deploy.mjs 0x15fC6ae953E024d975e77382eEeC56A9101f9F88   # Sepolia CRE (mock) forwarder for simulation
# put the address in attest-workflow/config.staging.json ("ledgerAddress", "writeReport": true), then:
cd .. && cre workflow simulate attest-workflow --target staging-settings --broadcast
```

The simulation fetches live candles, reads real mainnet whale transfers, prints every check, and (with `"writeReport": true` and a deployed ledger) writes the signed report to Sepolia (`--broadcast`).

## Practice agent (`agent/`)

```bash
cd agent && bun install
bun live.ts        # one live step (run hourly from cron)
bun replay.ts 365  # replay the last 365 days hour-by-hour (price evidence only) to build a track record
bun server.ts      # dashboard on http://127.0.0.1:8787
bun verify.ts <id> # recompute a logged decision + evidence hash
bun test           # strategy / engine / whale-parsing tests
```

The dashboard shows equity, every practice trade (click a row to see the entry checks that caused it and the exit that closed it), the latest decision with its checklist, and the full reasoning trail.

## Honest notes

- This is **practice trading** — no real orders are placed anywhere.
- Replay over the last 12 months of ETH (8,750 hourly steps, ETH fell from ~$3,900 to ~$2,300): **33 practice trades, 42.4% win rate, profit factor 1.19, avg +0.13R, +1.5% on equity** with 1% risk per trade. Modest on purpose: the trend filter is what keeps a dip-buyer from bleeding in a downtrend. The point of the project is not a magic edge but **decisions that can be audited**: every trade can be traced to the exact evidence and rule that triggered it, and re-derived by anyone.
- Replay mode has no historical whale data (scanning a year of logs is expensive), and says so in every replayed decision ("no on-chain data").
- Exchange wallet list = public Etherscan labels; transfers between two listed exchange wallets are ignored, and single transfers above $100M are treated as treasury moves and excluded.

## Layout

```
shared/strategy.ts     pure decision logic + indicators + canonical JSON (used by agent AND CRE workflow)
shared/whales.ts       exchange wallets, stablecoins, Transfer-log → whale-evidence summarizer
attest-workflow/       Chainlink CRE workflow (TypeScript)
contracts/             PracticeLedger.sol (+ Chainlink ReceiverTemplate), solc-js compile script
agent/                 live agent, replay, dashboard, verifier, tests
```

License: MIT
