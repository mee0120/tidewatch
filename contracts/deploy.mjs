// Deploys PracticeLedger to Sepolia.
//   node deploy.mjs <forwarderAddress>
// forwarder = the Sepolia (mock) forwarder shown by `cre workflow supported-chains`
import { readFileSync } from "fs"
import { createPublicClient, createWalletClient, http, formatEther, isAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"

const forwarder = process.argv[2]
if (!isAddress(forwarder ?? "")) throw new Error("usage: node deploy.mjs <forwarderAddress>")
const env = readFileSync(new URL("../.env", import.meta.url), "utf8")
const pk = env.match(/^CRE_ETH_PRIVATE_KEY=(?:0x)?([0-9a-fA-F]{64})$/m)?.[1]
if (!pk) throw new Error("CRE_ETH_PRIVATE_KEY missing in ../.env - run node keygen.mjs")
const account = privateKeyToAccount("0x" + pk)
const rpc = http(process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com")
const pub = createPublicClient({ chain: sepolia, transport: rpc })
const wallet = createWalletClient({ chain: sepolia, transport: rpc, account })

const bal = await pub.getBalance({ address: account.address })
console.log(`deployer ${account.address}  balance ${formatEther(bal)} SepoliaETH`)
if (bal === 0n) throw new Error("no Sepolia ETH yet - use a faucet first")

const { abi, bytecode } = JSON.parse(readFileSync(new URL("./out/PracticeLedger.json", import.meta.url), "utf8"))
const hash = await wallet.deployContract({ abi, bytecode, args: [forwarder] })
console.log("deploy tx:", `https://sepolia.etherscan.io/tx/${hash}`)
const rc = await pub.waitForTransactionReceipt({ hash })
console.log(`status=${rc.status}`)
console.log("PracticeLedger:", rc.contractAddress)
console.log(`https://sepolia.etherscan.io/address/${rc.contractAddress}`)
