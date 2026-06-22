// Tests for the report generator + background refresh path.
// Run: node --experimental-strip-types test/ast-grep-map/report.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  generateReport,
  topHubs,
  surprisingConnections,
  moduleDependencyGraph,
  orphanDefs,
  multiDefiners,
  topDir,
  maybeRefreshReport,
  type PersistedGraph,
} from "../../src/ast-grep-map/impl.ts"

// Pin the extractor script so temp fixtures resolve regardless of cwd.
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

// --- Synthetic graph fixture ---
// 4 files across 2 top-level dirs:
//   src/a.ts  — defines helper, used by cmd/c.ts (cross-module)
//   src/b.ts  — defines logger, used by src/a.ts (intra-module)
//   cmd/c.ts  — defines mainFn, references helper
//   cmd/d.ts  — defines unusedFn (orphan: only self-edge)
// Ident `sharedSym` is defined in BOTH src/a.ts and src/b.ts (multi-definer).
function syntheticGraph(): PersistedGraph {
  return {
    version: 1,
    worktree: "/repo",
    generatedAt: new Date().toISOString(),
    damping: 0.85,
    maxIter: 100,
    tol: 1e-6,
    nodeCount: 4,
    edgeCount: 5,
    nodes: ["src/a.ts", "src/b.ts", "cmd/c.ts", "cmd/d.ts"],
    edges: [
      // cmd/c.ts -> src/a.ts via helper (cross-module, surprising)
      { src: "cmd/c.ts", dst: "src/a.ts", weight: 5.0, ident: "helper" },
      // src/a.ts -> src/b.ts via logger (intra-module, not surprising)
      { src: "src/a.ts", dst: "src/b.ts", weight: 3.0, ident: "logger" },
      // cmd/c.ts -> src/a.ts via sharedSym (cross-module, multi-definer)
      { src: "cmd/c.ts", dst: "src/a.ts", weight: 2.0, ident: "sharedSym" },
      // src/b.ts -> src/a.ts via sharedSym (intra-module, multi-definer)
      { src: "src/b.ts", dst: "src/a.ts", weight: 1.0, ident: "sharedSym" },
      // cmd/d.ts -> cmd/d.ts self-edge weight 0.1 (orphan: zero referencers)
      { src: "cmd/d.ts", dst: "cmd/d.ts", weight: 0.1, ident: "unusedFn" },
    ],
    scores: {
      "src/a.ts": 0.45,
      "src/b.ts": 0.20,
      "cmd/c.ts": 0.30,
      "cmd/d.ts": 0.05,
    },
    rankedSymbols: [
      { file: "src/a.ts", ident: "helper", rank: 0.05, line: 10, endLine: 10, decl: "function helper()" },
      { file: "src/b.ts", ident: "logger", rank: 0.03, line: 5, endLine: 5, decl: "const logger" },
      { file: "src/a.ts", ident: "sharedSym", rank: 0.02, line: 20, endLine: 20, decl: "class sharedSym" },
      { file: "src/b.ts", ident: "sharedSym", rank: 0.015, line: 15, endLine: 15, decl: "class sharedSym" },
      { file: "cmd/c.ts", ident: "mainFn", rank: 0.04, line: 1, endLine: 1, decl: "function mainFn()" },
      { file: "cmd/d.ts", ident: "unusedFn", rank: 0.005, line: 1, endLine: 1, decl: "function unusedFn()" },
    ],
    mentionedIdents: [],
    sourceMtimes: {},
  }
}

// --- Test 1: topDir ---
function testTopDir(): void {
  console.log("[1] topDir")
  assert(topDir("src/a.ts") === "src", "topDir('src/a.ts') === 'src'")
  assert(topDir("cmd/c.ts") === "cmd", "topDir('cmd/c.ts') === 'cmd'")
  assert(topDir("standalone.ts") === "standalone.ts", "topDir('standalone.ts') returns full path")
  assert(topDir("src\\a.ts") === "src", "topDir normalizes backslashes (windows)")
}

// --- Test 2: topHubs ---
function testTopHubs(): void {
  console.log("[2] topHubs")
  const hubs = topHubs(syntheticGraph(), 10)
  assert(hubs.length === 4, "all 4 files returned")
  assert(hubs[0].file === "src/a.ts", "highest-PageRank file ranks first")
  assert(hubs[0].pagerank === 0.45, "pagerank value passed through")
  assert(hubs[0].distinctReferencers === 2, "src/a.ts has 2 distinct referencers (cmd/c.ts, src/b.ts)")
  assert(hubs[0].topSymbols.length > 0, "topSymbols populated")
  assert(hubs[0].topSymbols[0].ident === "helper", "highest-ranked symbol is helper")
}

// --- Test 3: surprisingConnections ---
function testSurprisingConnections(): void {
  console.log("[3] surprisingConnections")
  const edges = surprisingConnections(syntheticGraph(), 10)
  // Cross-module edges only: cmd/c.ts -> src/a.ts (helper, sharedSym)
  assert(edges.length === 2, `2 cross-module unique edges (got ${edges.length})`)
  assert(edges.every((e) => e.srcModule !== e.dstModule), "all edges are cross-module")
  assert(edges.every((e) => e.src !== e.dst), "no self-loops")
  // helper (weight 5.0) should outrank sharedSym (weight 2.0) even though both
  // belong to the same (cmd, src) module pair.
  assert(edges[0].ident === "helper", "highest-scoring edge is helper")
  assert(edges[0].srcModule === "cmd" && edges[0].dstModule === "src", "module labels correct")
}

// --- Test 4: moduleDependencyGraph ---
function testModuleDependencyGraph(): void {
  console.log("[4] moduleDependencyGraph")
  const md = moduleDependencyGraph(syntheticGraph())
  assert(md.startsWith("```mermaid"), "starts with mermaid fence")
  assert(md.endsWith("```"), "ends with mermaid fence")
  assert(md.includes('src["src"]'), "src module node declared")
  assert(md.includes('cmd["cmd"]'), "cmd module node declared")
  assert(md.includes('-->|w='), "edge with weight rendered")
  // cmd -> src has 2 edges (helper + sharedSym) summed weight = 7.0
  assert(md.includes("7.0"), "cmd->src summed weight 7.0 present")
}

// --- Test 5: orphanDefs ---
function testOrphanDefs(): void {
  console.log("[5] orphanDefs")
  const orphans = orphanDefs(syntheticGraph())
  assert(orphans.length === 1, `exactly 1 orphan (got ${orphans.length})`)
  assert(orphans[0].file === "cmd/d.ts", "orphan is cmd/d.ts")
  assert(orphans[0].defCount === 1, "cmd/d.ts defines 1 symbol")
  assert(orphans[0].sampleIdents.includes("unusedFn"), "unusedFn in sample idents")
}

// --- Test 6: multiDefiners ---
function testMultiDefiners(): void {
  console.log("[6] multiDefiners")
  const multi = multiDefiners(syntheticGraph(), 15)
  assert(multi.length === 1, `exactly 1 multi-definer ident (got ${multi.length})`)
  assert(multi[0].ident === "sharedSym", "multi-definer ident is sharedSym")
  assert(multi[0].definerCount === 2, "sharedSym defined in 2 files")
  assert(
    multi[0].files.includes("src/a.ts") && multi[0].files.includes("src/b.ts"),
    "both definer files listed",
  )
}

// --- Test 7: generateReport (full markdown) ---
function testGenerateReport(): void {
  console.log("[7] generateReport full markdown")
  const md = generateReport(syntheticGraph(), { worktree: "/repo" })
  assert(md.includes("ast-grep-map report"), "header comment present")
  assert(md.includes("all relationships EXTRACTED via AST"), "EXTRACTED confidence line present")
  assert(md.includes("## God nodes / hubs"), "god nodes section present")
  assert(md.includes("## Surprising cross-module connections"), "surprising connections section present")
  assert(md.includes("## Module dependency graph"), "module dependency graph section present")
  assert(md.includes("## Orphan / under-referenced definitions"), "orphan defs section present")
  assert(md.includes("## Multi-definer ambiguity"), "multi-definer section present")
  assert(md.includes("`src/a.ts`"), "src/a.ts appears somewhere in the report")
  assert(md.includes("`unusedFn`"), "orphan ident appears in orphan section")
  assert(md.includes("`sharedSym`"), "multi-definer ident appears in multi section")
  assert(md.includes("```mermaid"), "mermaid block present in module section")
  assert(md.includes("/repo"), "worktree label in title")
}

// --- Test 8: maybeRefreshReport end-to-end on a real fixture ---
// Builds a tiny repo in a temp dir; verifies:
//   - First call writes both graph.json and REPORT.md
//   - Second call with no changes skips (REPORT.md mtime unchanged)
//   - Third call after touching a source file rebuilds
//
// NOTE: This test shells out to extract.mjs which loads tree-sitter native
// addons. On hosts where the prebuilt binary doesn't load (e.g. some Windows
// ABIs), the test is skipped rather than failed — same constraint as the
// existing smoke.ts extractAllTags test.
async function testMaybeRefreshReport(): Promise<void> {
  console.log("[8] maybeRefreshReport idempotency")
  const workdir = mkdtempSync(join(tmpdir(), "agmap-bg-"))
  const tmpMap = mkdtempSync(join(tmpdir(), "agmap-bg-map-"))
  process.env.OP_AST_GREP_MAP_DIR = tmpMap
  const srcDir = join(workdir, "src")
  const cmdDir = join(workdir, "cmd")
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(cmdDir, { recursive: true })
  writeFileSync(
    join(srcDir, "a.ts"),
    'export function helper(): string { return "h"; }\nexport const logger = (m: string) => console.log(m);\n',
  )
  writeFileSync(
    join(cmdDir, "c.ts"),
    'import { helper } from "../src/a";\nexport function mainFn(): void { helper(); }\n',
  )

  // First call: no graph.json → builds from scratch, writes REPORT.md.
  const r1 = await maybeRefreshReport(workdir)
  if (r1.status === "failed" && /tree-sitter|extractor exited/i.test(r1.error ?? "")) {
    console.log("  SKIP: tree-sitter native binary did not load on this host")
    delete process.env.OP_AST_GREP_MAP_DIR
    rmSync(workdir, { recursive: true, force: true })
    rmSync(tmpMap, { recursive: true, force: true })
    return
  }
  assert(r1.status === "fresh", `first call status=fresh (got ${r1.status}${r1.error ? `, error: ${r1.error}` : ""})`)
  const reportPath = join(tmpMap, "REPORT.md")
  const graphPath = join(tmpMap, "graph.json")
  assert(existsSync(reportPath), "REPORT.md written")
  assert(existsSync(graphPath), "graph.json written")
  const md = readFileSync(reportPath, "utf8")
  assert(md.includes("## God nodes / hubs"), "report contains god nodes section")
  assert(md.includes('"cmd"'), "report includes cmd module in mermaid")

  // Second call: mtimes unchanged → skipped (REPORT.md NOT rewritten).
  const mtimeBefore = statSync(reportPath).mtimeMs
  // Delay 50ms so an erroneous rewrite would be detectable by mtime.
  await new Promise((r) => setTimeout(r, 50))
  const r2 = await maybeRefreshReport(workdir)
  assert(r2.status === "skipped", `second call status=skipped (got ${r2.status})`)
  const mtimeAfter = statSync(reportPath).mtimeMs
  assert(mtimeAfter === mtimeBefore, "REPORT.md mtime unchanged on skip")

  // Third call: touch a source file → rebuild.
  const srcFile = join(srcDir, "a.ts")
  const origMtime = statSync(srcFile).mtimeMs
  // Force a real mtime change (>1s resolution on some filesystems).
  const future = new Date(origMtime + 60_000)
  await import("node:fs/promises").then(({ utimes }) => utimes(srcFile, future, future))
  const r3 = await maybeRefreshReport(workdir)
  assert(r3.status === "rebuilt", `third call status=rebuilt (got ${r3.status})`)
  const mtimeRebuilt = statSync(reportPath).mtimeMs
  assert(mtimeRebuilt > mtimeBefore, "REPORT.md mtime advanced after rebuild")

  // force=true should also rebuild even when mtimes are unchanged.
  const r4 = await maybeRefreshReport(workdir, { force: true })
  assert(r4.status === "rebuilt" || r4.status === "fresh", `force=true rebuilds (got ${r4.status})`)

  delete process.env.OP_AST_GREP_MAP_DIR
  rmSync(workdir, { recursive: true, force: true })
  rmSync(tmpMap, { recursive: true, force: true })
}

// --- main ---
;(async () => {
  testTopDir()
  testTopHubs()
  testSurprisingConnections()
  testModuleDependencyGraph()
  testOrphanDefs()
  testMultiDefiners()
  testGenerateReport()
  await testMaybeRefreshReport()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error("test harness crashed:", e)
  process.exit(1)
})
