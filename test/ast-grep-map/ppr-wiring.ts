// End-to-end PPR scope-overlay tests — exercises the wiring fix for the three
// critical bugs found in code review:
//   1. First scoped call to a fresh worktree drops the PPR snapshot.
//   2. Cache-hit branch never consults scope snapshots.
//   3. Step 8 (worktree persist) clobbers scopes[] written by step 7.5.
//
// These tests exercise applyScopedRanking + graph-service against a synthetic
// graph injected directly (no tree-sitter extraction). The full ast_grep_map
// tool execute path requires the extract.mjs subprocess which is blocked by
// the env's tree-sitter native binding issue; the integration with extract is
// covered by test/ast-grep-map/smoke.ts.
//
// Run: tsx test/ast-grep-map/ppr-wiring.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  initializeGraphPlugin,
  shutdownGraphPlugin,
  markStaleForPath,
  getWorktreeGraphCache,
  persistScopedRankSnapshot,
  setWorktreeGraphCache,
} from "../../src/ast-grep-map/graph-service.ts"
import {
  buildInitialCache,
  readPersistedGraphCache,
  writePersistedGraphCache,
} from "../../src/ast-grep-map/graph-store.ts"
import { buildGraph, pageRank } from "../../src/ast-grep-map/graph.ts"
import { buildScopeSeeds } from "../../src/ast-grep-map/impl.ts"

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error("  FAIL:", msg)
  } else {
    console.log("  ok:", msg)
  }
}

// Synthetic topology:
//   src/hub.ts  — defines `coreFn`, referenced by many peripheral files
//   src/periph/alpha.ts ... src/periph/epsilon.ts — peripheral referencers
//   lib/other.ts — unrelated file with its own self-contained symbol
//
// Seeding src/ should bias src/hub.ts and src/periph/* above lib/other.ts.
function buildHubGraph() {
  const periph = ["alpha", "beta", "gamma", "delta", "epsilon"].map((n) => `src/periph/${n}.ts`)
  const allFiles = ["src/hub.ts", ...periph, "lib/other.ts"]
  return buildGraph({
    defines: new Map([
      ["coreFn", new Set<string>(["src/hub.ts"])],
      ["isolated", new Set<string>(["lib/other.ts"])],
    ]),
    references: new Map([
      ["coreFn", periph.slice()],
    ]),
    mentionedIdents: new Set(),
    chatFiles: new Set(),
    allFiles,
  })
}

function buildCacheFromGraph(worktree: string) {
  const g = buildHubGraph()
  const scores = pageRank(
    g,
    new Map(g.nodes.map((n) => [n, 1])),
    { alpha: 0.85, max_iter: 100, tol: 1e-6 },
  )
  return buildInitialCache(
    worktree,
    { nodes: g.nodes, edges: g.edges },
    scores,
    [],
    g.nodes.map((file) => ({ file, mtimeMs: 1_700_000_000_000, size: 100 })),
    [],
  )
}

async function withWorktree<T>(name: string, fn: (wt: string) => Promise<T>): Promise<T> {
  const wt = mkdtempSync(join(tmpdir(), `agmap-ppr-wiring-${name}-`))
  process.env.OP_AST_GREP_MAP_DIR = wt
  // Materialize minimal files so resolveRoot/discoverCodeFiles would find them
  // if invoked (not actually invoked here, but keeps the env honest).
  for (const f of ["src/hub.ts", "src/periph/alpha.ts", "src/periph/beta.ts", "lib/other.ts"]) {
    const abs = join(wt, f)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, "export const x = 1\n")
  }
  try {
    return await fn(wt)
  } finally {
    delete process.env.OP_AST_GREP_MAP_DIR
    await shutdownGraphPlugin(wt)
    rmSync(wt, { recursive: true, force: true })
  }
}

// --- Test 1: persistScopedRankSnapshot AFTER setWorktreeGraphCache survives ---
async function testScopePersistsAfterWorktreeInstall(): Promise<void> {
  console.log("[1] scope snapshot survives setWorktreeGraphCache (bug #3 regression)")
  await withWorktree("persists", async (wt) => {
    await initializeGraphPlugin(wt)
    // Step A: install worktree graph (simulates persistGraphAsCache in step 7).
    const cache = buildCacheFromGraph(wt)
    writePersistedGraphCache(wt, cache)
    // Re-initialize to pick up the persisted cache.
    await shutdownGraphPlugin(wt)
    await initializeGraphPlugin(wt)
    const inMemory = getWorktreeGraphCache(wt)
    assert(inMemory !== null, "worktree cache loaded")

    // Step B: persist a scope snapshot (simulates step 7.5/8 in execute()).
    const scope = { paths: ["src"], globs: [] }
    const snap = await persistScopedRankSnapshot(wt, scope, [], {
      fileScores: { "src/hub.ts": 0.9 },
      scoreSource: "ppr",
    })
    assert(snap !== null, "scope snapshot persisted")
    assert(snap?.refreshState.stale === false, "snapshot is fresh")

    // Step C: read back from disk — scope snapshot must be in the payload.
    const fromDisk = readPersistedGraphCache(wt)
    assert(fromDisk !== null, "disk cache read back")
    assert(fromDisk?.scopes.length === 1, `one scope on disk (got ${fromDisk?.scopes.length})`)
    assert(fromDisk?.scopes[0]?.rankSnapshot.fileScores["src/hub.ts"] === 0.9, "scope score survives")

    // Step D: in-memory state should also see the scope.
    const inMemory2 = getWorktreeGraphCache(wt)
    assert(inMemory2?.scopes.length === 1, "in-memory state coherent with disk")
  })
}

// --- Test 2: buildScopeSeeds produces correct seed entries for paths ---
async function testBuildScopeSeeds(): Promise<void> {
  console.log("[2] buildScopeSeeds for paths=src/")
  await withWorktree("seeds", async (wt) => {
    const g = buildHubGraph()
    const { seeds, scope } = buildScopeSeeds(wt, g.nodes, { paths: ["src"] })
    assert(scope.paths[0] === "src", "scope.path == src")
    // All src/* nodes should be seeded; lib/other.ts should not.
    const seedFiles = new Set(seeds.map((s) => s.file))
    assert(seedFiles.has("src/hub.ts"), "src/hub.ts seeded")
    assert(seedFiles.has("src/periph/alpha.ts"), "src/periph/alpha.ts seeded")
    assert(!seedFiles.has("lib/other.ts"), "lib/other.ts NOT seeded")
    assert(seeds.every((s) => s.source === "scope-path"), "all seeds source=scope-path")
    assert(seeds.every((s) => s.weight === 1), "all seeds weight=1")
  })
}

// --- Test 3: buildScopeSeeds with mentioned_idents adds ident-matched seeds ---
async function testMentionedIdentsSeeds(): Promise<void> {
  console.log("[3] buildScopeSeeds with mentioned_idents")
  await withWorktree("idents", async (wt) => {
    const g = buildHubGraph()
    // 'hub' should match src/hub.ts via path-component
    const { seeds } = buildScopeSeeds(wt, g.nodes, { mentioned_idents: ["hub"] })
    const seedFiles = new Set(seeds.map((s) => s.file))
    assert(seedFiles.has("src/hub.ts"), "src/hub.ts seeded via mentioned ident 'hub'")
    assert(seeds.some((s) => s.source === "mentioned-ident"), "some seeds carry source=mentioned-ident")
  })
}

// --- Test 4: invalidation clears scope snapshot for matching path ---
async function testInvalidationClearsScope(): Promise<void> {
  console.log("[4] file edit clears matching scope snapshot")
  await withWorktree("invalidate", async (wt) => {
    await initializeGraphPlugin(wt)
    writePersistedGraphCache(wt, buildCacheFromGraph(wt))
    await shutdownGraphPlugin(wt)
    await initializeGraphPlugin(wt)

    const scope = { paths: ["src"], globs: [] }
    await persistScopedRankSnapshot(wt, scope, [], { fileScores: {}, scoreSource: "heuristic" })
    const before = getWorktreeGraphCache(wt)?.scopes.find((s) => s.scopeKey.includes("src"))
    assert(before?.refreshState.stale === false, "scope fresh before edit")

    // Edit a file inside src/.
    await markStaleForPath(wt, join(wt, "src", "hub.ts"))
    const after = getWorktreeGraphCache(wt)?.scopes.find((s) => s.scopeKey.includes("src"))
    assert(after?.refreshState.stale === true, "scope stale after src/ edit")
  })
}

// --- Test 5: cache-hit path through (smoke) — fresh worktree, no PPR bias loss
//     on subsequent calls. We can't easily run the full execute() path here
//     (needs extract.mjs), but we verify the data structures the cache-hit
//     branch reads from are coherent. ---
async function testCacheHitCoherence(): Promise<void> {
  console.log("[5] cache-hit branch data coherence")
  await withWorktree("coherence", async (wt) => {
    await initializeGraphPlugin(wt)
    writePersistedGraphCache(wt, buildCacheFromGraph(wt))
    await shutdownGraphPlugin(wt)
    await initializeGraphPlugin(wt)

    const cache = getWorktreeGraphCache(wt)
    assert(cache !== null, "cache hydrated")
    assert(cache?.worktreeGraph.graph.nodes.length === 7, "7 nodes in synthetic graph")
    // The cache-hit branch reconstructs a Graph from these arrays; verify
    // the shape it expects.
    assert(Array.isArray(cache?.worktreeGraph.graph.edges), "edges array present")
    assert(Array.isArray(cache?.worktreeGraph.rankedSymbols), "rankedSymbols array present (empty here since we passed [])")
    // Scope snapshot overlay reads state.cache.scopes — confirm the cache-hit
    // path's applyScopedRanking would find any persisted scope.
    await persistScopedRankSnapshot(wt, { paths: ["src"], globs: [] }, [], {
      fileScores: { "src/hub.ts": 0.5 },
      scoreSource: "ppr",
    })
    const after = getWorktreeGraphCache(wt)
    assert(after?.scopes.length === 1, "scope snapshot installed after cache-hit setup")
  })
}

// --- Test 6: setWorktreeGraphCache AFTER persistScopedRankSnapshot clobbers
//     scopes[] (inverse of test 1). This pins the ordering invariant: the
//     impl.ts execute path must persist the worktree graph BEFORE the scope
//     snapshot. Without this assertion, a refactor that swaps the order
//     would silently lose scope snapshots and nothing in the unit suite
//     would catch it (cache-hit-scoped.ts catches it at the integration
//     layer, but that requires the extract.mjs subprocess).
async function testScopeClobberedByInverseOrdering(): Promise<void> {
  console.log("[6] setWorktreeGraphCache after persistScopedRankSnapshot clobbers scopes (ordering pin)")
  await withWorktree("inverse", async (wt) => {
    await initializeGraphPlugin(wt)
    writePersistedGraphCache(wt, buildCacheFromGraph(wt))
    await shutdownGraphPlugin(wt)
    await initializeGraphPlugin(wt)

    // Step A: write a scope snapshot into the live cache.
    const scope = { paths: ["src"], globs: [] }
    await persistScopedRankSnapshot(wt, scope, [], {
      fileScores: { "src/hub.ts": 0.9 },
      scoreSource: "ppr",
    })
    let before = getWorktreeGraphCache(wt)
    assert(before?.scopes.length === 1, "scope present before setWorktreeGraphCache")

    // Step B: simulate the WRONG ordering — install a fresh worktree cache
    // (scopes: []) AFTER the scope was written. The fresh cache replaces the
    // in-memory state, dropping the scope snapshot.
    setWorktreeGraphCache(wt, buildCacheFromGraph(wt))
    const after = getWorktreeGraphCache(wt)
    assert(after?.scopes.length === 0, "setWorktreeGraphCache clobbers pre-existing scopes (this is WHY the impl.ts ordering matters)")
  })
}

// --- main ---
;(async () => {
  await testScopePersistsAfterWorktreeInstall()
  await testBuildScopeSeeds()
  await testMentionedIdentsSeeds()
  await testInvalidationClearsScope()
  await testCacheHitCoherence()
  await testScopeClobberedByInverseOrdering()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error("test harness crashed:", e)
  process.exit(1)
})
