// Integration test for the cache-hit + PPR overlay path. Catches the regression
// where the cache-hit branch passed empty defTags to applyScopedRanking and
// scoped warm-cache calls returned "(no ranked symbols to display)".
//
// Run: tsx test/ast-grep-map/cache-hit-scoped.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { tools } from "../../src/ast-grep-map/impl.ts"
import { initializeGraphPlugin, shutdownGraphPlugin } from "../../src/ast-grep-map/graph-service.ts"

process.env.OP_AST_GREP_MAP_SCRIPT = resolve("src/ast-grep-map/extract.mjs")

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error("  FAIL:", msg)
  } else {
    console.log("  ok:", msg)
  }
}

// Build a tiny but realistic TS workspace under temp dir. Three files with
// cross-references so PageRank produces non-uniform scores.
async function withWorktree<T>(name: string, fn: (wt: string) => Promise<T>): Promise<T> {
  const wt = mkdtempSync(join(tmpdir(), `agmap-cachehit-${name}-`))
  process.env.OP_AST_GREP_MAP_DIR = wt
  mkdirSync(join(wt, "src"), { recursive: true })
  writeFileSync(
    join(wt, "src", "hub.ts"),
    [
      "import { helper } from './a'",
      "import { logger } from './b'",
      "export function core() { helper(); logger(); }",
      "export function utility() { return 42; }",
      "",
    ].join("\n"),
  )
  writeFileSync(join(wt, "src", "a.ts"), "export function helper() { return 1 };\nexport const alpha = 1;\n")
  writeFileSync(join(wt, "src", "b.ts"), "export function logger() { return 2 };\nexport const beta = 2;\n")
  try {
    return await fn(wt)
  } finally {
    delete process.env.OP_AST_GREP_MAP_DIR
    // Match the cleanup hygiene of ppr-wiring.ts / graph-lifecycle.ts so this
    // suite doesn't leak entries in the module-level workspaceGraphStore Map.
    try {
      await shutdownGraphPlugin(wt)
    } catch {
      /* best-effort */
    }
    rmSync(wt, { recursive: true, force: true })
  }
}

function makeCtx(wt: string) {
  return {
    worktree: wt,
    directory: wt,
    sessionID: "s",
    messageID: "m",
    agent: "a",
    abort: new AbortController().signal,
    metadata() {},
    ask() {},
  } as any
}

;(async () => {
  await withWorktree("warm", async (wt) => {
    const tool = tools.ast_grep_map as any
    console.log("[1] Cold call (cache miss) with paths=src/")
    const cold: string = await tool.execute({ paths: ["src"], refresh: "always" }, makeCtx(wt))
    assert(typeof cold === "string" && cold.length > 0, "cold call returned non-empty")
    assert(!cold.includes("(no ranked symbols"), `cold call rendered symbols (got: ${cold.split("\n")[0]})`)

    console.log("[2] Warm call (cache hit) with paths=src/ — same scope, should reuse")
    console.log("    (primary regression catcher for the defTags reconstruction bug: a warm")
    console.log("    cache + PPR overlay would return '(no ranked symbols to display)' without it)")
    const warm: string = await tool.execute({ paths: ["src"], refresh: "auto" }, makeCtx(wt))
    assert(typeof warm === "string" && warm.length > 0, "warm call returned non-empty")
    assert(!warm.includes("(no ranked symbols"), `warm call rendered symbols (got: ${warm.split("\n")[0]})`)
    assert(warm === cold, "warm call output matches cold (same scope, no seed change)")

    console.log("[3] Warm call with mentioned_idents — additional coverage of the PPR")
    console.log("    overlay seed-construction path (test [2] already catches the main bug)")
    const biased: string = await tool.execute(
      { paths: ["src"], mentioned_idents: ["helper"], refresh: "auto" },
      makeCtx(wt),
    )
    assert(typeof biased === "string" && biased.length > 0, "biased call returned non-empty")
    assert(
      !biased.includes("(no ranked symbols"),
      `biased warm-cache call rendered symbols (got: ${biased.split("\n")[0]})`,
    )

    console.log("[4] Cache payload has a scope snapshot for src/")
    const graphJson = JSON.parse(readFileSync(join(wt, "graph.json"), "utf8"))
    assert(Array.isArray(graphJson.scopes), "scopes[] exists")
    assert(graphJson.scopes.length >= 1, `at least one scope snapshot persisted (got ${graphJson.scopes.length})`)
    const srcScope = graphJson.scopes.find((s: any) => s.scopeKey.includes("src"))
    assert(!!srcScope, "scope for src/ present")
    assert(srcScope?.rankSnapshot?.scoreSource === "ppr" || srcScope?.rankSnapshot?.scoreSource === "heuristic",
      `scoreSource is ppr or heuristic (got ${srcScope?.rankSnapshot?.scoreSource})`)

    console.log("[5] Unscoped warm call still works (backward compat — no PPR)")
    const unscoped: string = await tool.execute({ refresh: "auto" }, makeCtx(wt))
    assert(typeof unscoped === "string" && unscoped.length > 0, "unscoped returned non-empty")
    assert(!unscoped.includes("(no ranked symbols"), "unscoped rendered symbols")
  })

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error("test harness crashed:", e)
  process.exit(1)
})
