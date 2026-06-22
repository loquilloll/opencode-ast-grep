// graph-store smoke tests — pure disk-cache behavior, no tree-sitter extraction.
// Run: tsx test/ast-grep-map/graph-store.ts
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildInitialCache,
  captureSourceManifest,
  manifestsEqual,
  readPersistedGraphCache,
  resolveMapDir,
  serializePersistedCache,
  validatePersistedCache,
  writePersistedGraphCache,
  type PersistedCache,
  type SourceManifestEntry,
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

function makeCache(worktree: string): PersistedCache {
  const graph = buildGraph({
    defines: new Map([["foo", new Set(["src/a.ts"] as string[]), ]]),
    references: new Map([["foo", ["src/b.ts"]]]),
    mentionedIdents: new Set(),
    chatFiles: new Set(),
    allFiles: ["src/a.ts", "src/b.ts"],
  })
  const scores = pageRank(graph, new Map([["src/a.ts", 1], ["src/b.ts", 1]]), {
    alpha: 0.85,
    max_iter: 100,
    tol: 1e-6,
  })
  return buildInitialCache(
    worktree,
    { nodes: graph.nodes, edges: graph.edges },
    scores,
    [{ tag: { rel_fname: "src/a.ts", fname: "src/a.ts", line: 0, endLine: 0, name: "foo", kind: "def", decl: "function foo()" }, rank: 0.5 }],
    [
      { file: "src/a.ts", mtimeMs: 1_700_000_000_000, size: 100 },
      { file: "src/b.ts", mtimeMs: 1_700_000_000_000, size: 200 },
    ],
    [],
  )
}

// --- Test 1: roundtrip write → read ---
function testRoundtrip(): void {
  console.log("[1] cache roundtrip write→read")
  const worktree = mkdtempSync(join(tmpdir(), "agmap-store-"))
  process.env.OP_AST_GREP_MAP_DIR = worktree
  const original = makeCache(worktree)
  const ok = writePersistedGraphCache(worktree, original)
  assert(ok, "writePersistedGraphCache returns true")
  const readBack = readPersistedGraphCache(worktree)
  assert(readBack !== null, "readPersistedGraphCache returns non-null")
  assert(readBack?.version === 2, "version == 2 after roundtrip")
  assert(readBack?.worktreeGraph.graph.nodes.length === 2, "two graph nodes after roundtrip")
  assert(readBack?.worktreeGraph.sourceManifest.length === 2, "two manifest entries after roundtrip")
  assert(readBack?.worktreeGraph.rankedSymbols.length === 1, "one ranked symbol after roundtrip")
  assert(readBack?.scopes.length === 0, "zero scopes after roundtrip")
  rmSync(worktree, { recursive: true, force: true })
  delete process.env.OP_AST_GREP_MAP_DIR
}

// --- Test 2: manifest mismatch (size change) → manifestsEqual false ---
function testManifestMismatch(): void {
  console.log("[2] manifest equality (mtime + size)")
  const a: SourceManifestEntry[] = [
    { file: "src/a.ts", mtimeMs: 1, size: 100 },
    { file: "src/b.ts", mtimeMs: 2, size: 200 },
  ]
  const sameA: SourceManifestEntry[] = [
    { file: "src/a.ts", mtimeMs: 1, size: 100 },
    { file: "src/b.ts", mtimeMs: 2, size: 200 },
  ]
  assert(manifestsEqual(a, sameA), "identical manifests compare equal")
  const sizeChanged: SourceManifestEntry[] = [
    { file: "src/a.ts", mtimeMs: 1, size: 999 },
    { file: "src/b.ts", mtimeMs: 2, size: 200 },
  ]
  assert(!manifestsEqual(a, sizeChanged), "size change detected")
  const mtimeChanged: SourceManifestEntry[] = [
    { file: "src/a.ts", mtimeMs: 1, size: 100 },
    { file: "src/b.ts", mtimeMs: 3, size: 200 },
  ]
  assert(!manifestsEqual(a, mtimeChanged), "mtime change detected")
  const reordered: SourceManifestEntry[] = [
    { file: "src/b.ts", mtimeMs: 2, size: 200 },
    { file: "src/a.ts", mtimeMs: 1, size: 100 },
  ]
  assert(!manifestsEqual(a, reordered), "reordering detected (manifests are order-sensitive)")
  assert(!manifestsEqual(a, []), "length mismatch detected")
}

// --- Test 3: validatePersistedCache rejects malformed payloads ---
function testValidation(): void {
  console.log("[3] validatePersistedCache rejects bad payloads")
  assert(validatePersistedCache(null) === null, "null → null")
  assert(validatePersistedCache({}) === null, "empty object → null")
  assert(validatePersistedCache({ version: 1 }) === null, "v1 payload → null (only v2 supported)")
  assert(validatePersistedCache({ version: 2 }) === null, "v2 missing fields → null")
  // Tampered payload: bad relative path (Windows drive)
  const bad = makeCache("/repo")
  ;(bad.worktreeGraph.graph.nodes as string[]) = ["C:\\evil\\path.ts"]
  const validated = validatePersistedCache(JSON.parse(JSON.stringify(bad)))
  assert(validated === null || validated.worktreeGraph.graph.nodes.length === 0, "windows-drive paths dropped/rejected")
  // Tampered payload: out-of-tree edge
  const bad2 = makeCache("/repo")
  bad2.worktreeGraph.graph.edges.push({ src: "src/a.ts", dst: "../escape.ts", weight: 1, ident: "x" })
  const v2 = validatePersistedCache(JSON.parse(JSON.stringify(bad2)))
  assert(v2 === null || !v2.worktreeGraph.graph.edges.some((e) => e.dst === "../escape.ts"), "out-of-tree edge rejected")
}

// --- Test 4: captureSourceManifest stats real files ---
function testCaptureManifest(): void {
  console.log("[4] captureSourceManifest on real files")
  const dir = mkdtempSync(join(tmpdir(), "agmap-manifest-"))
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src", "a.ts"), "export const x = 1\n")
  writeFileSync(join(dir, "src", "b.ts"), "export const y = 2\n")
  const manifest = captureSourceManifest(dir, ["src/a.ts", "src/b.ts"])
  assert(manifest !== null, "manifest captured")
  assert(manifest?.length === 2, "two entries")
  assert(manifest?.every((e) => e.size > 0), "all sizes positive")
  assert(manifest?.every((e) => e.mtimeMs > 0), "all mtimes positive")
  // Symlink-rejection is exercised in Phase 5; here we only confirm regular files work.
  rmSync(dir, { recursive: true, force: true })
}

// --- Test 5: byte-stable serialization across calls ---
function testStableSerialization(): void {
  console.log("[5] stable serialization (byte-identical across calls)")
  const c1 = makeCache("/repo")
  const c2 = makeCache("/repo")
  // updatedAt is set inside buildInitialCache; force equal for byte-stability test
  c2.updatedAt = c1.updatedAt
  c2.worktreeGraph.builtAt = c1.worktreeGraph.builtAt
  const s1 = serializePersistedCache(c1)
  const s2 = serializePersistedCache(c2)
  assert(s1 === s2, "two equivalent caches serialize byte-identically (given equal timestamps)")
}

// --- Test 6: scope snapshot survives write → read cycle (regression: the v2
//     schema nests scopes[] under the top-level; verify nothing is dropped). ---
function testScopeRoundtrip(): void {
  console.log("[6] scope snapshot roundtrip")
  const worktree = mkdtempSync(join(tmpdir(), "agmap-store-scope-"))
  process.env.OP_AST_GREP_MAP_DIR = worktree
  const cache = makeCache(worktree)
  // Attach a fully-populated scope snapshot.
  cache.scopes.push({
    scopeKey: JSON.stringify({ paths: ["src"], globs: [] }),
    effectiveScope: { paths: ["src"], globs: [] },
    seedEntries: [{ file: "src/a.ts", weight: 1, source: "scope-path" }],
    rankSnapshot: {
      fileScores: { "src/a.ts": 0.6, "src/b.ts": 0.4 },
      scoreSource: "ppr",
      builtAt: "2026-06-22T00:00:00.000Z",
    },
    refreshState: { stale: false, lastRefreshAt: "2026-06-22T00:00:00.000Z" },
  })
  const ok = writePersistedGraphCache(worktree, cache)
  assert(ok, "write with scope snapshot succeeded")
  const readBack = readPersistedGraphCache(worktree)
  assert(readBack?.scopes.length === 1, "one scope survived roundtrip")
  const s = readBack?.scopes[0]
  assert(s?.scopeKey === JSON.stringify({ paths: ["src"], globs: [] }), "scopeKey preserved")
  assert(s?.rankSnapshot.scoreSource === "ppr", "scoreSource preserved")
  assert(s?.rankSnapshot.fileScores["src/a.ts"] === 0.6, "fileScores preserved")
  assert(s?.seedEntries.length === 1 && s?.seedEntries[0]?.source === "scope-path", "seedEntries preserved")
  assert(s?.refreshState.stale === false, "refreshState.stale preserved")

  // Unsafe-path-key rejection in scope fileScores (separate from ident-NUL
  // rejection — that's exercised by testNulIdentRejection below). The scopeKey
  // MUST match getScopeKey(effectiveScope); the new validator enforces this.
  const validScopeKey = JSON.stringify({ paths: [], globs: [] })
  const tampered = makeCache(worktree)
  tampered.scopes.push({
    scopeKey: validScopeKey,
    effectiveScope: { paths: [], globs: [] },
    seedEntries: [],
    rankSnapshot: {
      fileScores: { "C:\\evil.ts": 0.5, "src/a.ts": 0.5 },
      scoreSource: "ppr",
      builtAt: "2026-06-22T00:00:00.000Z",
    },
    refreshState: { stale: false },
  })
  writePersistedGraphCache(worktree, tampered)
  const tamperedRead = readPersistedGraphCache(worktree)
  const evil = tamperedRead?.scopes.find((x) => x.scopeKey === validScopeKey)
  assert(evil !== undefined, "scope survived (valid scopeKey + safe shape)")
  assert(evil?.rankSnapshot.fileScores["C:\\evil.ts"] === undefined, "windows-drive key dropped from fileScores")
  assert(evil?.rankSnapshot.fileScores["src/a.ts"] === 0.5, "legitimate key preserved")

  // Scope with mismatched scopeKey (attacker-chosen key + different effectiveScope)
  // MUST be rejected by the new scopeKey consistency check.
  const mismatched = makeCache(worktree)
  mismatched.scopes.push({
    scopeKey: "attacker-chosen-key",
    effectiveScope: { paths: ["src"], globs: [] },
    seedEntries: [],
    rankSnapshot: {
      fileScores: {},
      scoreSource: "heuristic",
      builtAt: "2026-06-22T00:00:00.000Z",
    },
    refreshState: { stale: false },
  })
  writePersistedGraphCache(worktree, mismatched)
  const mismatchedRead = readPersistedGraphCache(worktree)
  assert(
    !mismatchedRead?.scopes.some((x) => x.scopeKey === "attacker-chosen-key"),
    "mismatched scopeKey rejected (consistency check)",
  )

  rmSync(worktree, { recursive: true, force: true })
  delete process.env.OP_AST_GREP_MAP_DIR
}

// --- Test 7: NUL-in-ident rejection (security regression test) ---
// rankDefinitions (graph.ts:197) uses `\u0000` as the (dst, ident) separator
// when bucketing definitions for ranking. A crafted cache that smuggles a NUL
// byte into an edge.ident or rankedSymbol.ident could collide keys with a
// legitimate entry and skew ranking. The validators at graph-store.ts:163
// (normalizeFileEdge) and :194 (normalizeRankedSymbol) reject idents containing
// NUL — this test pins that guard so a future refactor cannot silently drop it.
function testNulIdentRejection(): void {
  console.log("[7] NUL-in-ident rejection (edge + rankedSymbol)")
  // Edge with NUL in ident → dropped
  const evilEdge = validatePersistedCache({
    version: 2,
    updatedAt: "2026-06-22T00:00:00.000Z",
    worktree: "/repo",
    worktreeGraph: {
      builtAt: "2026-06-22T00:00:00.000Z",
      sourceManifest: [],
      graph: {
        nodes: ["src/a.ts", "src/b.ts"],
        edges: [
          { src: "src/a.ts", dst: "src/b.ts", weight: 1, ident: "evil\u0000src/b.ts" },
          { src: "src/a.ts", dst: "src/b.ts", weight: 1, ident: "legit" },
        ],
      },
      scores: {},
      rankedSymbols: [],
      mentionedIdents: [],
    },
    scopes: [],
    nextEpoch: 0,
  })
  assert(evilEdge !== null, "cache payload accepted (only the bad edge is dropped)")
  const dropped = evilEdge?.worktreeGraph.graph.edges.filter((e) => e.ident.includes("\0"))
  assert((dropped ?? []).length === 0, "edge with NUL in ident dropped")
  assert(evilEdge?.worktreeGraph.graph.edges.length === 1, "only the legit edge survived")

  // rankedSymbol with NUL in ident → dropped
  const evilRanked = validatePersistedCache({
    version: 2,
    updatedAt: "2026-06-22T00:00:00.000Z",
    worktree: "/repo",
    worktreeGraph: {
      builtAt: "2026-06-22T00:00:00.000Z",
      sourceManifest: [],
      graph: { nodes: ["src/a.ts"], edges: [] },
      scores: {},
      rankedSymbols: [
        { file: "src/a.ts", ident: "evil\u0000collision", rank: 0.5, line: 1, endLine: 1, decl: "x" },
        { file: "src/a.ts", ident: "legit", rank: 0.5, line: 2, endLine: 2, decl: "y" },
      ],
      mentionedIdents: [],
    },
    scopes: [],
    nextEpoch: 0,
  })
  assert(evilRanked !== null, "cache payload accepted (only the bad rankedSymbol is dropped)")
  assert(evilRanked?.worktreeGraph.rankedSymbols.length === 1, "only the legit rankedSymbol survived")
  assert(evilRanked?.worktreeGraph.rankedSymbols[0]?.ident === "legit", "legit rankedSymbol preserved")
}

// --- main ---
;(() => {
  testRoundtrip()
  testManifestMismatch()
  testValidation()
  testCaptureManifest()
  testStableSerialization()
  testScopeRoundtrip()
  testNulIdentRejection()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
