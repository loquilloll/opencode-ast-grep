import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { provisionSgBinary, runtimeSlug, runtimeTargetDir, findSgBinarySync } from "../../src/ast-grep/impl.ts"

const slug = runtimeSlug()
const targetDir = runtimeTargetDir()
console.log(`[e2e] slug=${slug} targetDir=${targetDir}`)

const dest = await provisionSgBinary({ targetDir })
console.log(`[e2e] provisioned -> ${dest}`)

if (!existsSync(dest)) throw new Error(`binary not found at ${dest}`)

const version = execFileSync(dest, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim()
console.log(`[e2e] --version => ${version}`)
if (!version.toLowerCase().includes("ast-grep")) throw new Error(`--version lacks 'ast-grep': ${version}`)
if (!version.includes("0.45.2")) throw new Error(`--version lacks 0.45.2: ${version}`)

const resolved = findSgBinarySync({ runtimeDir: targetDir })
console.log(`[e2e] resolver => ${resolved}`)
if (resolved !== dest) throw new Error(`resolver mismatch: ${resolved} !== ${dest}`)

console.log("[e2e] PASS")
