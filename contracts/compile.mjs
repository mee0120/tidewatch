// Compiles PracticeLedger with solc-js and writes out/PracticeLedger.json (abi + bytecode).
import solc from "solc"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import path from "path"
const src = (f) => readFileSync(path.join("src", f), "utf8")
const input = {
  language: "Solidity",
  sources: Object.fromEntries(["PracticeLedger.sol", "ReceiverTemplate.sol", "IReceiver.sol", "IERC165.sol"].map((f) => [f, { content: src(f) }])),
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
}
const findImports = (p) => {
  for (const base of ["node_modules", "src"]) {
    const f = path.join(base, p)
    if (existsSync(f)) return { contents: readFileSync(f, "utf8") }
  }
  return { error: "not found: " + p }
}
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }))
const errs = (out.errors || []).filter((e) => e.severity === "error")
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join("\n")); process.exit(1) }
const c = out.contracts["PracticeLedger.sol"].PracticeLedger
mkdirSync("out", { recursive: true })
writeFileSync("out/PracticeLedger.json", JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2))
console.log("compiled PracticeLedger, bytecode bytes:", c.evm.bytecode.object.length / 2)
