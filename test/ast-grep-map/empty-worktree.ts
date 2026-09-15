// Regression tests for no-code worktrees (docs/config-only projects).
//
// Bug being pinned: booting opencode in a worktree with no supported code
// files made the ast-grep-map session.created hook throw per event (the
// graph build errors with "no supported code files"), spamming multi-KB
// stacks and stalling boot. Required behavior:
//   - maybeRefreshReport returns status "empty" quickly and writes a stub
//     REPORT.md (write-if-changed) — BEFORE any lock acquisition.
//   - ast_grep_map returns its sensible message without lock/mapDir side
//     effects.
//   - The hook stays quiet (one short line per worktree per process); a real
//     generation failure throws ONCE, then downgrades repeats to one-liners.
// Run: tsx test/ast-grep-map/empty-worktree.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { maybeRefreshReport, tools, default as astGrepMapPlugin } from "../../src/ast-grep-map/impl.ts"

// Pin the extractor script so temp fixtures resolve regardless of cwd.
const REAL_EXTRACT_SCRIPT = resolve("src/ast-grep-map/extract.mjs")
process.env.OP_AST_GREP_MAP_SCRIPT = REAL_EXTRACT_SCRIPT

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error("  FAIL:", msg)
  } else {
    console.log("  ok:", msg)
  }
}

function makeDocsOnlyDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(d, "readme.md"), "# docs only\n")
  mkdirSync(join(d, ".opencode"), { recursive: true })
  writeFileSync(join(d, ".opencode", "opencode.json"), '{}\n')
  return d
}

function toolCtx(worktree: string): any {
  return {
    worktree,
    directory: worktree,
    sessionID: "s",
    messageID: "m",
    agent: "a",
    abort: new AbortController().signal,
    metadata() {},
    ask() {},
  }
}

function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length
}

// --- [1] docs-only worktree: status "empty", stub REPORT.md, fast, no lock ---
async function testEmptyFastPath(): Promise<string> {
  console.log("[1] maybeRefreshReport on docs-only dir → empty + stub, fast")
  const workdir = makeDocsOnlyDir("agmap-nocode-")
  const tmpMap = mkdtempSync(join(tmpdir(), "agmap-nocode-map-"))
  process.env.OP_AST_GREP_MAP_DIR = tmpMap
  const t0 = Date.now()
  const r = await maybeRefreshReport(workdir)
  const elapsed = Date.now() - t0
  assert(r.status === "empty", `status=empty (got ${r.status})`)
  assert(elapsed < 5000, `resolves fast (<5s; got ${elapsed}ms)`)
  const reportPath = join(tmpMap, "REPORT.md")
  assert(existsSync(reportPath), "stub REPORT.md written")
  const md = readFileSync(reportPath, "utf8")
  assert(md.includes("No supported code files"), "stub contains the no-code marker")
  assert(!existsSync(join(tmpMap, "graph.json")), "no graph.json written")
  assert(!existsSync(join(tmpMap, ".report.lock")), "no .report.lock created (pre-lock fast path)")
  const log = readFileSync(join(tmpMap, "report.log"), "utf8")
  assert(countMatches(log, /EMPTY:/g) === 1, `exactly one EMPTY: log line (got ${countMatches(log, /EMPTY:/g)})`)
  // NOTE: caller cleans up dirs + env (state threaded into test [2]).
  return workdir + "\u0000" + tmpMap
}

// --- [1b] stale-lock never delays the empty fast path ---
async function testStaleLockFastPath(): Promise<void> {
  console.log("[1b] fresh-looking .report.lock does not delay the empty path")
  const workdir = makeDocsOnlyDir("agmap-nocode-lock-")
  const tmpMap = mkdtempSync(join(tmpdir(), "agmap-nocode-lock-map-"))
  process.env.OP_AST_GREP_MAP_DIR = tmpMap
  try {
    // Live owner (our pid), recent timestamp — acquireReportLock would refuse
    // to break it, so a post-lock empty check would wait out the 5-min
    // deadline. The pre-lock fast path must never reach the lock at all.
    const lockPath = join(tmpMap, ".report.lock")
    const lockContent = `${process.pid}\u0000${Date.now()}`
    writeFileSync(lockPath, lockContent)
    const t0 = Date.now()
    const r = await maybeRefreshReport(workdir)
    const elapsed = Date.now() - t0
    assert(r.status === "empty", `status=empty (got ${r.status})`)
    assert(elapsed < 5000, `resolves fast despite held lock (<5s; got ${elapsed}ms)`)
    assert(existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === lockContent, "pre-existing lock untouched")
  } finally {
    delete process.env.OP_AST_GREP_MAP_DIR
    rmSync(workdir, { recursive: true, force: true })
    rmSync(tmpMap, { recursive: true, force: true })
  }
}

// --- [2] repeat call: empty, zero churn (write-if-changed) ---
async function testRepeatEmptyNoChurn(state: string): Promise<string> {
  console.log("[2] repeat call → empty, REPORT.md mtime unchanged, still one EMPTY line")
  const [workdir, tmpMap] = state.split("\u0000")
  process.env.OP_AST_GREP_MAP_DIR = tmpMap
  const reportPath = join(tmpMap, "REPORT.md")
  const mtimeBefore = statSync(reportPath).mtimeMs
  await new Promise((r) => setTimeout(r, 50)) // an erroneous rewrite would move mtime
  const r2 = await maybeRefreshReport(workdir)
  assert(r2.status === "empty", `repeat status=empty (got ${r2.status})`)
  assert(statSync(reportPath).mtimeMs === mtimeBefore, "REPORT.md mtime unchanged (write-if-changed)")
  const log = readFileSync(join(tmpMap, "report.log"), "utf8")
  assert(countMatches(log, /EMPTY:/g) === 1, `still exactly one EMPTY: log line (got ${countMatches(log, /EMPTY:/g)})`)
  assert(!existsSync(join(tmpMap, ".report.lock")), "still no .report.lock")
  // NOTE: caller cleans up dirs + env (state threaded into test [4]).
  return state
}

// --- [3] ast_grep_map tool on a docs-only dir: message, no side effects ---
async function testToolOnEmptyWorktree(): Promise<void> {
  console.log("[3] ast_grep_map on docs-only dir → message, no lock/mapDir side effects")
  delete process.env.OP_AST_GREP_MAP_DIR // use the default resolution — must stay side-effect-free
  const d = makeDocsOnlyDir("agmap-nocode-tool-")
  // resolveRoot falls back to the "." candidate when the given roots have no
  // code files; in production cwd == worktree so that resolves to the same
  // no-code dir. chdir into the fixture to reproduce that here (running from
  // the repo root would otherwise graph THIS repo).
  const prevCwd = process.cwd()
  process.chdir(d)
  try {
    // Call tools.ast_grep_map.execute DIRECTLY (not via the plugin factory —
    // the factory's initializeGraphPlugin → resolveMapDir creates .ast-grep,
    // which would break the no-side-effect assertion).
    const toolObj = tools.ast_grep_map as any
    const out = await toolObj.execute({}, toolCtx(d))
    assert(typeof out === "string" && out.includes("No supported code files found"), "returns the no-code message")
    assert(!existsSync(join(d, ".ast-grep")), "no .ast-grep created inside the worktree")
  } finally {
    process.chdir(prevCwd)
    rmSync(d, { recursive: true, force: true })
  }
}

// --- [4]+[5] empty→real→empty transitions (skip when tree-sitter unavailable) ---
async function testTransitions(state: string): Promise<void> {
  console.log("[4] empty→real: stub replaced by a real report")
  const [workdir, tmpMap] = state.split("\u0000")
  process.env.OP_AST_GREP_MAP_DIR = tmpMap
  try {
    mkdirSync(join(workdir, "src"), { recursive: true })
    writeFileSync(join(workdir, "src", "index.ts"), "export function ok(): boolean { return true }\n")
    const r = await maybeRefreshReport(workdir)
    if (r.status === "failed" && /tree-sitter|extractor exited/i.test(r.error ?? "")) {
      console.log("  SKIP: tree-sitter native binary did not load on this host")
      return
    }
    assert(r.status === "fresh", `status=fresh after gaining code files (got ${r.status})`)
    const md = readFileSync(join(tmpMap, "REPORT.md"), "utf8")
    assert(md.includes("## God nodes / hubs"), "real report replaces the stub")

    console.log("[5] real→empty: stub written back")
    rmSync(join(workdir, "src"), { recursive: true, force: true })
    const r2 = await maybeRefreshReport(workdir)
    assert(r2.status === "empty", `status=empty after losing code files (got ${r2.status})`)
    const md2 = readFileSync(join(tmpMap, "REPORT.md"), "utf8")
    assert(md2.includes("No supported code files"), "stub content is back")
  } finally {
    delete process.env.OP_AST_GREP_MAP_DIR
    rmSync(workdir, { recursive: true, force: true })
    rmSync(tmpMap, { recursive: true, force: true })
  }
}

// --- [6] session.created hook: quiet on empty worktrees (one line ever) ---
async function testHookQuietOnEmpty(): Promise<void> {
  console.log("[6] hook on docs-only worktree: resolves, one short line, then silent")
  const d = makeDocsOnlyDir("agmap-nocode-hook-")
  // Same resolveRoot "."-fallback consideration as test [3]: chdir so the
  // plugin resolves the no-code fixture, not the repo we run tests from.
  const prevCwd = process.cwd()
  process.chdir(d)
  try {
    const hooks: any = await astGrepMapPlugin({ directory: d, worktree: d } as any)
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "))
    }
    try {
      await hooks.event({ event: { type: "session.created" } } as any) // must resolve
      await hooks.event({ event: { type: "session.created" } } as any) // must resolve
    } finally {
      console.error = orig
    }
    const emptyLines = errs.filter((s) => s.includes("no supported code files"))
    assert(emptyLines.length === 1, `exactly ONE empty-worktree line across events (got ${emptyLines.length})`)
    assert(existsSync(join(d, ".ast-grep", "REPORT.md")), "stub REPORT.md written to default mapDir")
  } finally {
    process.chdir(prevCwd)
    rmSync(d, { recursive: true, force: true })
  }
}

// --- [7] hook failure dedupe: first throw, repeats are stack-free one-liners ---
async function testHookFailureDedupe(): Promise<void> {
  console.log("[7] hook on a FAILING worktree: throws once, then one-liner repeats")
  const d = mkdtempSync(join(tmpdir(), "agmap-fail-hook-"))
  writeFileSync(join(d, "mod.ts"), "export function x(): void {}\n")
  // Failure injection: an EXISTING extractor script that crashes. The env
  // override is only honored when the path exists (resolveExtractScript
  // falls back to the module sibling otherwise).
  const crashScript = join(d, "crash-extract.mjs")
  writeFileSync(crashScript, "process.exit(3)\n")
  process.env.OP_AST_GREP_MAP_SCRIPT = crashScript
  try {
    const hooks: any = await astGrepMapPlugin({ directory: d, worktree: d } as any)
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "))
    }
    try {
      let threw = false
      try {
        await hooks.event({ event: { type: "session.created" } } as any)
      } catch {
        threw = true
      }
      assert(threw, "first session.created rejects (loud failure)")
      await hooks.event({ event: { type: "session.created" } } as any) // resolves
      await hooks.event({ event: { type: "session.created" } } as any) // resolves
      const repeats = errs.filter((s) => s.includes("still failing"))
      assert(repeats.length === 2, `exactly two repeat one-liners (got ${repeats.length})`)
      assert(
        errs.every((s) => !s.includes("\n") && !s.includes("    at ")),
        "no logged line contains a stack frame",
      )
    } finally {
      console.error = orig
    }
  } finally {
    process.env.OP_AST_GREP_MAP_SCRIPT = REAL_EXTRACT_SCRIPT
    rmSync(d, { recursive: true, force: true })
  }
}

// --- [8] waitForLock: concurrent refreshes serialize without timeout ---
async function testWaitForLockConcurrency(): Promise<void> {
  console.log("[8] two concurrent waitForLock refreshes both resolve")
  const d = mkdtempSync(join(tmpdir(), "agmap-waitlock-"))
  const tmpMap = mkdtempSync(join(tmpdir(), "agmap-waitlock-map-"))
  process.env.OP_AST_GREP_MAP_DIR = tmpMap
  try {
    mkdirSync(join(d, "src"), { recursive: true })
    writeFileSync(join(d, "src", "a.ts"), 'import { b } from "./b"; export const a = b;\n')
    writeFileSync(join(d, "src", "b.ts"), "export const b = 1;\n")
    const [r1, r2] = await Promise.all([
      maybeRefreshReport(d, { waitForLock: true }),
      maybeRefreshReport(d, { waitForLock: true }),
    ])
    if (r1.status === "failed" && /tree-sitter|extractor exited/i.test(r1.error ?? "")) {
      console.log("  SKIP: tree-sitter native binary did not load on this host")
      return
    }
    for (const [label, r] of [["first", r1], ["second", r2]] as const) {
      assert(r.error !== "timed out waiting for report lock", `${label} did not hit the lock timeout`)
      assert(["fresh", "skipped", "rebuilt"].includes(r.status), `${label} resolves sanely (got ${r.status})`)
    }
    assert(!existsSync(join(tmpMap, ".report.lock")), "lock released after both complete")
  } finally {
    delete process.env.OP_AST_GREP_MAP_DIR
    rmSync(d, { recursive: true, force: true })
    rmSync(tmpMap, { recursive: true, force: true })
  }
}

// --- [9] refresh:"always" tool call pairs REPORT.md with graph.json ---
async function testRefreshAlwaysPairsReport(): Promise<void> {
  console.log("[9] refresh:always publishes REPORT.md and releases the lock")
  const d = mkdtempSync(join(tmpdir(), "agmap-always-"))
  const tmpMap = mkdtempSync(join(tmpdir(), "agmap-always-map-"))
  process.env.OP_AST_GREP_MAP_DIR = tmpMap
  try {
    mkdirSync(join(d, "src"), { recursive: true })
    writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n")
    const toolObj = tools.ast_grep_map as any
    const out = await toolObj.execute({ refresh: "always" }, toolCtx(d))
    if (typeof out === "string" && /tree-sitter|extractor exited/i.test(out)) {
      console.log("  SKIP: tree-sitter native binary did not load on this host")
      return
    }
    assert(typeof out === "string" && out.length > 0, "execute returns a map")
    assert(existsSync(join(tmpMap, "REPORT.md")), "REPORT.md written alongside graph.json")
    assert(readFileSync(join(tmpMap, "REPORT.md"), "utf8").includes("## God nodes / hubs"), "real report content")
    assert(!existsSync(join(tmpMap, ".report.lock")), "lock released after the call")
  } finally {
    delete process.env.OP_AST_GREP_MAP_DIR
    rmSync(d, { recursive: true, force: true })
    rmSync(tmpMap, { recursive: true, force: true })
  }
}

// --- main ---
;(async () => {
  const state1 = await testEmptyFastPath()
  await testStaleLockFastPath()
  const state2 = await testRepeatEmptyNoChurn(state1)
  await testToolOnEmptyWorktree()
  await testTransitions(state2)
  await testHookQuietOnEmpty()
  await testHookFailureDedupe()
  await testWaitForLockConcurrency()
  await testRefreshAlwaysPairsReport()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error("test harness crashed:", e)
  process.exit(1)
})
