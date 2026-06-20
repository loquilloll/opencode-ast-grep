// Smoke + convergence tests for ast_grep_map.
// Run: node --experimental-strip-types .opencode/ast-grep-map-tests/smoke.ts
import { existsSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  extractAllTags,
  buildGraph,
  pageRank,
  renderTree,
  discoverCodeFiles,
  tools,
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

// --- Test 1: extractAllTags on a synthetic TS file ---
async function testExtract(): Promise<void> {
  console.log("[1] extractAllTags (TypeScript)")
  const dir = mkdtempSync(join(tmpdir(), "agmap-"))
  const f = join(dir, "sample.ts")
  writeFileSync(
    f,
    'class Calculator {\n  add(a: number, b: number): number { return a + b; }\n  subtract(a, b) { return add(a, -b); }\n}\nexport function add(x: number, y: number): number { return x + y; }\nconst calc = new Calculator();\ncalc.add(1, 2);\n',
  )
  const tags = await extractAllTags(dir, [f], new AbortController().signal)
  const defs = tags.filter((t) => t.kind === "def")
  assert(defs.some((t) => t.name === "Calculator"), "captures class Calculator")
  assert(defs.some((t) => t.name === "add"), "captures function add")
  assert(defs.some((t) => t.name === "subtract"), "captures method subtract")
  assert(defs.every((t) => typeof t.endLine === "number" && typeof t.decl === "string"), "def tags carry endLine + decl")
  rmSync(dir, { recursive: true, force: true })
}

// --- Test 2: PageRank convergence + distribution sums to ~1 ---
function testPageRank(): void {
  console.log("[2] pageRank convergence + unit sum")
  const graph = {
    nodes: ["A", "B", "C"],
    edges: [
      { src: "A", dst: "B", weight: 2, ident: "x" },
      { src: "B", dst: "C", weight: 1, ident: "y" },
      { src: "C", dst: "A", weight: 1, ident: "z" },
    ],
    outWeight: new Map([
      ["A", 2],
      ["B", 1],
      ["C", 1],
    ]),
  }
  const pers = new Map<string, number>([["A", 1], ["B", 1], ["C", 1]])
  const scores = pageRank(graph, pers, { alpha: 0.85, max_iter: 100, tol: 1e-6 })
  const sum = (scores.get("A") ?? 0) + (scores.get("B") ?? 0) + (scores.get("C") ?? 0)
  assert(Math.abs(sum - 1) < 1e-4, `PageRank sums to ~1 (got ${sum.toFixed(6)})`)
  const scores2 = pageRank(graph, pers, { alpha: 0.85, max_iter: 100, tol: 1e-6 })
  assert(scores.get("A") === scores2.get("A"), "deterministic across runs")
  const empty = pageRank({ nodes: [], edges: [], outWeight: new Map() }, new Map(), { alpha: 0.85, max_iter: 100, tol: 1e-6 })
  assert(empty.size === 0, "empty graph -> empty scores")
}

// --- Test 3: renderTree format (compact outline: path once + L<n>/L<start>-L<end>) ---
async function testRenderTree(): Promise<void> {
  console.log("[3] renderTree format")
  const dir = mkdtempSync(join(tmpdir(), "agmap-r-"))
  const f = join(dir, "mod.ts")
  // class spans lines 1-6 (0-based 0-5); method is a one-liner at line 5 (0-based 4).
  writeFileSync(f, "class Foo {\n  // padding 1\n  // padding 2\n  // padding 3\n  method() { return 1; }\n}\n")
  const tags = await extractAllTags(dir, [f], new AbortController().signal)
  const def = tags.filter((t) => t.kind === "def")
  const ranked = def.map((t) => ({ tag: t, rank: 1 }))
  const out = renderTree(ranked)
  assert(out.startsWith("mod.ts:\n"), "starts with file header 'mod.ts:'")
  assert(out.includes("L1-L6"), "class shown with multi-line range L1-L6")
  assert(out.includes("L5"), "one-liner method shown as single L5")
  assert(out.includes("class Foo {"), "shows the declaration line text")
  assert(!out.includes("│") && !out.includes("⋮"), "no aider │/⋮ rendering")
  // path appears exactly once (header only, not repeated per symbol)
  assert(out.split("mod.ts").length - 1 === 1, "path shown exactly once")
  for (const line of out.split("\n")) assert(line.length <= 200, `lines reasonably truncated (len ${line.length})`)
  rmSync(dir, { recursive: true, force: true })
}

// --- Test 4: full tool execute on a real fixture (the impl itself) ---
async function testExecuteEndToEnd(): Promise<void> {
  console.log("[4] ast_grep_map end-to-end on src/ast-grep/impl.ts")
  const worktree = process.cwd()
  const tmpMap = mkdtempSync(join(tmpdir(), "agmap-graph-"))
  process.env.OP_AST_GREP_MAP_DIR = tmpMap
  const toolObj = tools.ast_grep_map as any
  const ctx = { worktree, directory: worktree, sessionID: "s", messageID: "m", agent: "a", abort: new AbortController().signal, metadata() {}, ask() {} }
  const result: string = await toolObj.execute({ paths: ["src/ast-grep/impl.ts"], refresh: "always" }, ctx)
  assert(typeof result === "string" && result.length > 0, "execute returns non-empty string")
  assert(/\n  *L\d/.test(result), "map output contains L<line> range markers")
  assert(!result.includes("│") && !result.includes("⋮"), "map output uses compact outline (no │/⋮)")
  assert(result.includes("src/ast-grep/impl.ts:"), "map output contains the scoped file header")
  const graphFile = join(tmpMap, "graph.json")
  assert(existsSync(graphFile), "graph.json written to disk")
  const persisted = JSON.parse(readFileSync(graphFile, "utf8"))
  assert(persisted.version === 1, "persisted graph version=1")
  assert(persisted.nodeCount > 0, "persisted nodeCount > 0")
  assert(persisted.edgeCount > 0, `persisted edgeCount > 0 (got ${persisted.edgeCount})`)
  assert(Array.isArray(persisted.rankedSymbols) && persisted.rankedSymbols.length > 0, "rankedSymbols populated")
  const scoreSum = Object.values<number>(persisted.scores).reduce((a, b) => a + b, 0)
  assert(Math.abs(scoreSum - 1) < 1e-3, `persisted scores sum ~1 (got ${scoreSum.toFixed(4)})`)

  // refresh:auto must reuse the cache (graph.json not rewritten) when sources unchanged.
  const mtimeBefore = statSync(graphFile).mtimeMs
  const cachedResult: string = await toolObj.execute({ paths: ["src/ast-grep/impl.ts"], refresh: "auto" }, ctx)
  const mtimeAfter = statSync(graphFile).mtimeMs
  assert(mtimeAfter === mtimeBefore, "refresh:auto reuses cached graph (graph.json mtime unchanged)")
  assert(typeof cachedResult === "string" && cachedResult.length > 0, "refresh:auto returns a valid map")

  delete process.env.OP_AST_GREP_MAP_DIR
  rmSync(tmpMap, { recursive: true, force: true })
}

// --- Test 5: json mode returns graph JSON ---
async function testJsonMode(): Promise<void> {
  console.log("[5] ast_grep_map json mode")
  const tmpMap = mkdtempSync(join(tmpdir(), "agmap-json-"))
  process.env.OP_AST_GREP_MAP_DIR = tmpMap
  const worktree = process.cwd()
  const toolObj = tools.ast_grep_map as any
  const ctx = { worktree, directory: worktree, sessionID: "s", messageID: "m", agent: "a", abort: new AbortController().signal, metadata() {}, ask() {} }
  const result: string = await toolObj.execute({ paths: ["src/ast-grep/impl.ts"], json: true, refresh: "always" }, ctx)
  let parsed: any = null
  try {
    parsed = JSON.parse(result)
  } catch {
    /* fail below */
  }
  assert(parsed !== null && parsed.nodes && parsed.edges, "json mode returns parseable graph with nodes+edges")
  delete process.env.OP_AST_GREP_MAP_DIR
  rmSync(tmpMap, { recursive: true, force: true })
}

// --- main ---
;(async () => {
  await testExtract()
  testPageRank()
  await testRenderTree()
  await testExecuteEndToEnd()
  await testJsonMode()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error("test harness crashed:", e)
  process.exit(1)
})
