import { execFileSync } from "node:child_process"
import { validatePattern, resolveLang } from "../../src/ast-grep/impl.ts"

const helper = "/home/agent/omo-clone/packages/shared-skills/skills/ast-grep/scripts/ast_grep_helper.py"

// Pattern table from the plan (pattern string, language alias).
const table: Array<{ pattern: string; lang: string }> = [
  { pattern: "\\w+", lang: "ts" },
  { pattern: ".*foo", lang: "ts" },
  { pattern: "[a-z]", lang: "ts" },
  { pattern: "a|b", lang: "ts" },
  { pattern: "def $F():", lang: "py" },
  { pattern: "function $N", lang: "ts" },
  { pattern: "func $N", lang: "go" },
  { pattern: "fn $N", lang: "rs" },
  { pattern: "console.log($MSG)", lang: "ts" }, // plausible -> no hints
]

let failures = 0
for (const { pattern, lang } of table) {
  // Oracle: Python helper `validate` (exits 2 when hints are present, so read
  // stdout from the thrown error).
  let pyOut = ""
  try {
    pyOut = execFileSync("python3", [helper, "validate", pattern, "--lang", lang], {
      encoding: "utf8",
      timeout: 10_000,
    })
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout
    if (typeof stdout !== "string") throw err
    pyOut = stdout
  }
  pyOut = pyOut.trim()

  // Port: TS validatePattern with the same normalized canonical lang.
  const resolved = resolveLang(lang)
  if ("error" in resolved) continue
  const canonical = resolved.canonical
  const hints = validatePattern(pattern, canonical)
  const tsOut = hints.length > 0 ? hints.map((h) => `hint: ${h}`).join("\n") : "pattern looks plausible for ast-grep."

  const ok = tsOut === pyOut
  console.log(`${ok ? "OK  " : "FAIL"} pattern=${JSON.stringify(pattern)} lang=${lang}`)
  if (!ok) {
    failures += 1
    console.log(`  python: ${JSON.stringify(pyOut)}`)
    console.log(`  ts    : ${JSON.stringify(tsOut)}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} PARITY CHECK(S) FAILED`)
  process.exit(1)
}
console.log("\n[parity] PASS")
