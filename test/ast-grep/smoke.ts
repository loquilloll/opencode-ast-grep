import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tools } from "../../src/ast-grep/impl.ts"

const root = mkdtempSync(join(tmpdir(), "sg-smoke-"))
const ctx = { directory: root, worktree: root, abort: new AbortController().signal, sessionID: "s", messageID: "m", agent: "a", metadata() {}, ask: async () => {} }
let failures = 0
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${cond || !detail ? "" : ` :: ${detail}`}`)
  if (!cond) failures += 1
}
function contains(haystack: unknown, needle: string): boolean {
  return typeof haystack === "string" && haystack.includes(needle)
}

// --- Fixture A: search/replace round-trip ---
const fileA = join(root, "a.ts")
writeFileSync(fileA, "console.log(x)\n")

let r = await tools.ast_grep_search.execute({ pattern: "console.log($MSG)", lang: "ts" }, ctx)
check("search finds the match", contains(r, "console.log(x)"), String(r))
check("search shows L1 line marker", contains(r, "L1  console.log(x)"), String(r))

r = await tools.ast_grep_replace.execute({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", lang: "ts" }, ctx)
check("replace dry-run previews", contains(r, "DRY-RUN: would rewrite 1 match(es) across 1 file(s)"), String(r))
check("replace dry-run shows ->", contains(r, "-> logger.info(x)"), String(r))
check("dry-run did NOT mutate", readFileSync(fileA, "utf8").includes("console.log(x)"), readFileSync(fileA, "utf8"))

r = await tools.ast_grep_replace.execute({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", lang: "ts", apply: true }, ctx)
check("replace apply reports APPLIED", contains(r, "APPLIED: rewrote 1 match(es) across 1 file(s)"), String(r))
check("apply mutated file", readFileSync(fileA, "utf8").includes("logger.info(x)"), readFileSync(fileA, "utf8"))

r = await tools.ast_grep_search.execute({ pattern: "console.log($MSG)", lang: "ts" }, ctx)
check("re-search finds 0 matches", r === "(no matches)", String(r))

// --- Fixture B: scan smoke ---
const subB = join(root, "b")
mkdirSync(subB, { recursive: true })
writeFileSync(join(subB, "b.ts"), 'console.log("debug")\n')

const inlineRule = "id: no-console\nlanguage: TypeScript\nrule:\n  pattern: console.log($$$)\n"

r = await tools.ast_grep_scan.execute({ paths: [subB], inline_rules: inlineRule }, ctx)
check("scan finds console.log", contains(r, "no-console") || contains(r, "console.log") || contains(r, "debug"), String(r))

r = await tools.ast_grep_scan.execute({ paths: [subB], inline_rules: "id: none\nlanguage: TypeScript\nrule:\n  pattern: zzzNoSuch($$$)\n" }, ctx)
check("scan no-match is clean (exit 0, no finding id)", !contains(r, "zzzNoSuch") && !contains(r, "failed"), String(r))

// Mutually-exclusive validation (no sg call expected).
r = await tools.ast_grep_scan.execute({ config: "x.yml", rule: "y.yml" }, ctx)
check("scan rejects config+rule", contains(r, "mutually exclusive"), String(r))

// scan apply fix
r = await tools.ast_grep_scan.execute({ paths: [subB], inline_rules: inlineRule + "fix: 'logger.info($$$)'\n", apply: true }, ctx)
// After apply, re-scan should report nothing
r = await tools.ast_grep_scan.execute({ paths: [subB], inline_rules: inlineRule }, ctx)
check("scan-after-apply: file rewritten, no finding", !readFileSync(join(subB, "b.ts"), "utf8").includes("console.log") || !contains(r, "no-console"), `${readFileSync(join(subB, "b.ts"), "utf8")} ||| ${r}`)

// --- validation hint path (no binary needed) ---
r = await tools.ast_grep_validate.execute({ pattern: "\\w+", lang: "ts" }, ctx)
check("validate flags regex \\w", contains(r, "hint:"), String(r))

rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log("\n[smoke] PASS")
