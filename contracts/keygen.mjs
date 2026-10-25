// Creates a throwaway key for Sepolia testing and stores it in ../.env (chmod 600).
// Prints only the address. Never reuse this key for real funds.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
const f = new URL("../.env", import.meta.url)
const cur = existsSync(f) ? readFileSync(f, "utf8") : ""
const m = cur.match(/^CRE_ETH_PRIVATE_KEY=(?:0x)?([0-9a-fA-F]{64})$/m)
if (m && !/^0*1$/.test(m[1])) {
  console.log("key already exists, address:", privateKeyToAccount("0x" + m[1]).address)
  process.exit(0)
}
const pk = generatePrivateKey()
const rest = cur.split("\n").filter((l) => l && !l.startsWith("CRE_ETH_PRIVATE_KEY=")).join("\n")
writeFileSync(f, (rest ? rest + "\n" : "") + `CRE_ETH_PRIVATE_KEY=${pk.slice(2)}\n`)
chmodSync(f, 0o600)
console.log("new throwaway key saved to .env, address:", privateKeyToAccount(pk).address)
