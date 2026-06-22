// Lifecycle + invalidation tests for the ast-grep-map graph-service layer.
// Run: tsx test/ast-grep-map/graph-lifecycle.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  initializeGraphPlugin,
  markStaleForPath,
  markWorkspaceStale,
  getWorkspaceGraphState,
  getScopedRankSnapshot,
  getWorktreeGraphCache,
  persistScopedRankSnapshot,
  setWorktreeGraphCache,
  shutdownGraphPlugin,
} from "../../src/ast-grep-map/graph-service.ts"
import {
  buildInitialCache,
  writePersistedGraphCache,
  readPersistedGraphCache,
} from "../../src/ast-grep-map/graph-store.ts"
import { pageRank, buildGraph } from "../../src/ast-grep-map/graph.ts"

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error("  FAIL:", msg)
  } else {
    console.log("  ok:", msg)
  }
}

async function withWorktree<T>(name: string, fn: (wt: string) => Promise<T>): Promise<T> {
  const wt = mkdtempSync(join(tmpdir(), `agmap-life-${name}-`))
  process.env.OP_AST_GREP_MAP_DIR = wt
  try {
    return await fn(wt)
  } finally {
    delete process.env.OP_AST_GREP_MAP_DIR
    await shutdownGraphPlugin(wt)
    rmSync(wt, { recursive: true, force: true })
  }
}

function seedWorktreeGraph(worktree: string): void {
  // Seed a minimal cache so the lifecycle state has something to invalidate.
  const g = buildGraph({
    defines: new Map([["foo", new Set<string>(["src/a.ts"])]]),
    references: new Map([["foo", ["src/b.ts"]]]),
    mentionedIdents: new Set(),
    chatFiles: new Set(),
    allFiles: ["src/a.ts", "src/b.ts"],
  })
  const scores = pageRank(g, new Map([["src/a.ts", 1], ["src/b.ts", 1]]), {
    alpha: 0.85,
    max_iter: 100,
    tol: 1e-6,
  })
  const cache = buildInitialCache(
    worktree,
    { nodes: g.nodes, edges: g.edges },
    scores,
    [],
    [
      { file: "src/a.ts", mtimeMs: 1_700_000_000_000, size: 100 },
      { file: "src/b.ts", mtimeMs: 1_700_000_000_000, size: 200 },
    ],
    [],
  )
  writePersistedGraphCache(worktree, cache)
}

// --- Test 1: initializeGraphPlugin hydrates from disk ---
async function testInitialize(): Promise<void> {
  console.log("[1] initializeGraphPlugin hydrates")
  await withWorktree("init", async (wt) => {
    seedWorktreeGraph(wt)
    await initializeGraphPlugin(wt)
    const state = getWorkspaceGraphState(wt)
    assert(!!state, "workspace state exists after init")
    assert(state?.cache !== null, "cache hydrated")
    assert(state?.cache?.worktreeGraph.graph.nodes.length === 2, "two nodes hydrated")
    assert(state?.hydrationAttempted === true, "hydration attempted once")
  })
}

// --- Test 2: markStaleForPath marks matching scope stale ---
async function testScopeStale(): Promise<void> {
  console.log("[2] markStaleForPath invalidates scope snapshot")
  await withWorktree("scope", async (wt) => {
    seedWorktreeGraph(wt)
    await initializeGraphPlugin(wt)
    const scope = { paths: ["src"], globs: [] }
    // Persist a fresh scope snapshot to invalidate.
    await persistScopedRankSnapshot(wt, scope, [], {
      fileScores: { "src/a.ts": 0.6, "src/b.ts": 0.4 },
      scoreSource: "ppr",
    })
    let snap = await getScopedRankSnapshot(wt, scope, [])
    assert(snap !== null, "scope snapshot readable before invalidation")
    assert(snap?.refreshState.stale === false, "snapshot is fresh before invalidation")

    // Invalidate a file inside the scope.
    await markStaleForPath(wt, join(wt, "src", "a.ts"))
    snap = await getScopedRankSnapshot(wt, scope, [])
    assert(snap === null, "scope snapshot rejected after invalidation (treated as missing)")

    // The on-disk cache reflects the stale flag — survives a new process (re-init).
    await shutdownGraphPlugin(wt)
    await initializeGraphPlugin(wt)
    const fresh = getWorktreeGraphCache(wt)
    const persisted = fresh?.scopes.find((s) => s.scopeKey === JSON.stringify({ paths: ["src"], globs: [] }))
    assert(persisted?.refreshState.stale === true, "stale flag persisted across process restart")
  })
}

// --- Test 3: markStaleForPath outside any scope is a no-op for that scope ---
async function testNonMatchingScope(): Promise<void> {
  console.log("[3] non-matching scope untouched on path invalidation")
  await withWorktree("nonmatch", async (wt) => {
    seedWorktreeGraph(wt)
    await initializeGraphPlugin(wt)
    const scopeA = { paths: ["src"], globs: [] }
    const scopeB = { paths: ["tests"], globs: [] }
    await persistScopedRankSnapshot(wt, scopeA, [], { fileScores: {}, scoreSource: "heuristic" })
    await persistScopedRankSnapshot(wt, scopeB, [], { fileScores: {}, scoreSource: "heuristic" })

    // Make tests/ real so markStaleForPath resolves it inside the worktree.
    mkdirSync(join(wt, "tests"), { recursive: true })
    writeFileSync(join(wt, "tests", "x.ts"), "")

    await markStaleForPath(wt, join(wt, "tests", "x.ts"))
    const a = await getScopedRankSnapshot(wt, scopeA, [])
    const b = await getScopedRankSnapshot(wt, scopeB, [])
    assert(a !== null, "scopeA (src) still fresh after tests/ edit")
    assert(b === null, "scopeB (tests) marked stale")
  })
}

// --- Test 4: markWorkspaceStale invalidates every scope ---
async function testWorkspaceStale(): Promise<void> {
  console.log("[4] markWorkspaceStale invalidates all scopes")
  await withWorktree("ws", async (wt) => {
    seedWorktreeGraph(wt)
    await initializeGraphPlugin(wt)
    await persistScopedRankSnapshot(wt, { paths: ["src"], globs: [] }, [], { fileScores: {}, scoreSource: "heuristic" })
    await persistScopedRankSnapshot(wt, { paths: ["lib"], globs: [] }, [], { fileScores: {}, scoreSource: "heuristic" })
    await markWorkspaceStale(wt)
    const a = await getScopedRankSnapshot(wt, { paths: ["src"], globs: [] }, [])
    const b = await getScopedRankSnapshot(wt, { paths: ["lib"], globs: [] }, [])
    assert(a === null, "src scope invalidated by workspace-stale")
    assert(b === null, "lib scope invalidated by workspace-stale")
  })
}

// --- Test 5: path outside workspace falls back to markWorkspaceStale ---
async function testOutsideWorkspace(): Promise<void> {
  console.log("[5] path outside workspace → markWorkspaceStale fallback")
  await withWorktree("outside", async (wt) => {
    seedWorktreeGraph(wt)
    await initializeGraphPlugin(wt)
    await persistScopedRankSnapshot(wt, { paths: ["src"], globs: [] }, [], { fileScores: {}, scoreSource: "heuristic" })
    await markStaleForPath(wt, "/tmp/completely/elsewhere.ts")
    const a = await getScopedRankSnapshot(wt, { paths: ["src"], globs: [] }, [])
    assert(a === null, "src scope invalidated by out-of-workspace fallback")
  })
}

// --- Test 6: different seed sets produce different snapshot identities ---
async function testSeedChange(): Promise<void> {
  console.log("[6] seed set change invalidates snapshot")
  await withWorktree("seed", async (wt) => {
    seedWorktreeGraph(wt)
    await initializeGraphPlugin(wt)
    const scope = { paths: ["src"], globs: [] }
    await persistScopedRankSnapshot(
      wt,
      scope,
      [{ file: "src/a.ts", weight: 1, source: "scope-path" }],
      { fileScores: { "src/a.ts": 1.0 }, scoreSource: "ppr" },
    )
    const sameSeed = await getScopedRankSnapshot(wt, scope, [{ file: "src/a.ts", weight: 1, source: "scope-path" }])
    const diffSeed = await getScopedRankSnapshot(wt, scope, [{ file: "src/b.ts", weight: 1, source: "scope-path" }])
    assert(sameSeed !== null, "same seed set reuses snapshot")
    assert(diffSeed === null, "different seed set rejects snapshot")
  })
}

// --- main ---
;(async () => {
  await testInitialize()
  await testScopeStale()
  await testNonMatchingScope()
  await testWorkspaceStale()
  await testOutsideWorkspace()
  await testSeedChange()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error("test harness crashed:", e)
  process.exit(1)
})
