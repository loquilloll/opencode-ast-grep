// PPR + scope-keyed snapshot tests (improvements #3 + #6).
// Run: tsx test/ast-grep-map/ppr.ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildPersonalizationVector,
  deriveScopedFileScores,
  isFileInScope,
  matchesScopeGlobs,
  normalizeEffectiveScope,
  normalizeSeedEntries,
  pageRank,
  runPersonalizedPageRank,
  buildGraph,
  type EffectiveScope,
  type Graph,
  type SeedEntry,
} from "../../src/ast-grep-map/graph.ts"

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error("  FAIL:", msg)
  } else {
    console.log("  ok:", msg)
  }
}

// Build a graph where A is a hub: many files reference ident defined in A.
function buildHubGraph(): Graph {
  // 5 files all reference `coreFn` defined in src/hub.ts → hub gets all inbound.
  return buildGraph({
    defines: new Map([["coreFn", new Set<string>(["src/hub.ts"])]]),
    references: new Map([
      [
        "coreFn",
        ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      ],
    ]),
    mentionedIdents: new Set(),
    chatFiles: new Set(),
    allFiles: ["src/hub.ts", "a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
  })
}

// --- Test 1: buildPersonalizationVector rejects non-graph files ---
function testPersonalizationVector(): void {
  console.log("[1] buildPersonalizationVector")
  const files = ["a.ts", "b.ts", "c.ts"]
  const seeds: SeedEntry[] = [
    { file: "a.ts", weight: 2, source: "test" },
    { file: "b.ts", weight: 1, source: "test" },
    { file: "outside.ts", weight: 5, source: "test" }, // not in `files`
  ]
  const v = buildPersonalizationVector(files, seeds)
  assert(v !== null, "vector built")
  assert(v !== null && Math.abs(v["a.ts"] - 2 / 3) < 1e-9, "a.ts weight 2/3")
  assert(v !== null && Math.abs(v["b.ts"] - 1 / 3) < 1e-9, "b.ts weight 1/3")
  assert(v !== null && v["c.ts"] === 0, "c.ts weight 0")
  assert(v !== null && v["outside.ts"] === undefined, "outside excluded")
  const empty = buildPersonalizationVector(files, [])
  assert(empty === null, "no seeds → null vector")
}

// --- Test 2: PPR converges with seeds + biases the seeded files ---
function testPPRConvergence(): void {
  console.log("[2] PPR convergence + bias")
  const g = buildHubGraph()
  const scores = runPersonalizedPageRank(g, [{ file: "src/hub.ts", weight: 1, source: "test" }])
  const sum = [...scores.values()].reduce((a, b) => a + b, 0)
  assert(Math.abs(sum - 1) < 1e-4, `PPR sums ~1 (got ${sum.toFixed(6)})`)
  // Seeding src/hub.ts should bias it above the others.
  const hub = scores.get("src/hub.ts") ?? 0
  const other = scores.get("a.ts") ?? 0
  assert(hub > other, `seeded hub (${hub.toFixed(4)}) > non-seeded a.ts (${other.toFixed(4)})`)
}

// --- Test 3: PPR with no seeds on graph → uniform fallback ---
function testPPRUniformFallback(): void {
  console.log("[3] PPR uniform fallback when seeds don't match")
  const g = buildHubGraph()
  // Seed points to a file not in the graph.
  const scores = runPersonalizedPageRank(g, [{ file: "nonexistent.ts", weight: 1, source: "test" }])
  const sum = [...scores.values()].reduce((a, b) => a + b, 0)
  assert(Math.abs(sum - 1) < 1e-4, `uniform-fallback PPR sums ~1 (got ${sum.toFixed(6)})`)
  // Uniform fallback: every node roughly equal.
  const first = scores.get("a.ts") ?? 0
  const second = scores.get("b.ts") ?? 0
  assert(Math.abs(first - second) < 1e-6, "uniform fallback → all nodes equal")
}

// --- Test 4: deriveScopedFileScores returns ppr vs heuristic appropriately ---
function testDerive(): void {
  console.log("[4] deriveScopedFileScores")
  const g = buildHubGraph()
  const ppr = deriveScopedFileScores(g, [{ file: "src/hub.ts", weight: 1, source: "test" }])
  assert(ppr.scoreSource === "ppr", "PPR path taken when seed lands")
  const heuristic = deriveScopedFileScores(g, [])
  assert(heuristic.scoreSource === "heuristic", "heuristic path when no seeds")
  // Heuristic: hub should have highest inbound×100 weight
  const h = heuristic.fileScores
  assert((h["src/hub.ts"] ?? 0) > (h["a.ts"] ?? 0), "hub > a.ts in heuristic (more inbound)")
}

// --- Test 5: isFileInScope / matchesScopeGlobs ---
function testScopeHelpers(): void {
  console.log("[5] isFileInScope + matchesScopeGlobs")
  const scope: EffectiveScope = normalizeEffectiveScope({
    paths: ["src"],
    globs: ["**/*.ts", "!**/*.test.ts"],
  })
  assert(isFileInScope("src/a.ts", scope), "src/a.ts in src/")
  assert(!isFileInScope("lib/b.ts", scope), "lib/b.ts NOT in src/")
  assert(isFileInScope("src/nested/deep/c.ts", scope), "deeply nested file still in scope")
  assert(matchesScopeGlobs("src/a.ts", scope), "src/a.ts matches *.ts include")
  assert(!matchesScopeGlobs("src/a.test.ts", scope), "src/a.test.ts excluded")
  assert(!matchesScopeGlobs("src/a.js", scope), "src/a.js excluded (no .ts match)")
  // Empty scope matches everything.
  const empty: EffectiveScope = { paths: [], globs: [] }
  assert(isFileInScope("anything.ts", empty) && matchesScopeGlobs("anything.ts", empty), "empty scope matches all")
}

// --- Test 6: normalizeSeedEntries dedupes + sorts deterministically ---
function testNormalizeSeeds(): void {
  console.log("[6] normalizeSeedEntries")
  const scope: EffectiveScope = { paths: [], globs: [] }
  const dup: SeedEntry[] = [
    { file: "b.ts", weight: 1, source: "z" },
    { file: "a.ts", weight: 1, source: "a" },
    { file: "b.ts", weight: 1, source: "a" },
    { file: "b.ts", weight: 2, source: "a" }, // higher weight, same source → wins on weight
  ]
  const out = normalizeSeedEntries(dup, scope)
  assert(out.length === 2, "two unique files after dedupe")
  assert(out[0].file === "a.ts", "sorted: a.ts first")
  assert(out[1].file === "b.ts", "sorted: b.ts second")
  assert(out[1].weight === 2, "b.ts keeps highest weight (2)")
}

// --- main ---
;(() => {
  testPersonalizationVector()
  testPPRConvergence()
  testPPRUniformFallback()
  testDerive()
  testScopeHelpers()
  testNormalizeSeeds()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
