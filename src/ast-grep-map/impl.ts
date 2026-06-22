// ast_grep_map — aider-style repo map with PageRank (tree-sitter based).
//
// Produces an aider-style code map (real source lines under │/⋮ box-drawing,
// ranked by PageRank) and persists the PageRank graph to disk as JSON.
// Algorithm ported from Aider-AI/aider repomap.py + Aider-AI/grep-ast.
//
// Symbol extraction uses tree-sitter + aider's verbatim -tags.scm queries
// (vendored under .opencode/queries/). PageRank is a pure-TS power iteration
// reproducing networkx defaults (alpha=0.85, max_iter=100, tol=1e-6).
//
// Runtime deps: `node:` builtins only (no native modules). The opencode plugin
// runs inside opencode's bundled runtime where tree-sitter's N-API addons may
// not load, so ALL tree-sitter work is delegated to a standalone `node`
// subprocess (.opencode/ast-grep-map-extract.mjs) — same pattern the sibling
// ast-grep plugin uses (it shells out to the `sg` binary). This module only
// spawns that subprocess + builds the graph + PageRank + renders.

import { spawn } from "node:child_process"
import { readFileSync, readdirSync, lstatSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import {
  buildGraph as buildGraphImpl,
  pageRank as pageRankImpl,
  rankDefinitions as rankDefinitionsImpl,
  isMeaningfulName,
  deriveScopedFileScores,
  isFileInScope,
  isSeedPathSymlink,
  matchesScopeGlobs,
  normalizeEffectiveScope,
  normalizeRelativePath,
  normalizeSeedEntries,
  type EffectiveScope,
  type Graph as GraphT,
  type GraphEdge as GraphEdgeT,
  type BuildInput,
  type RankedTag as RankedTagT,
  type SeedEntry,
  type Tag,
} from "./graph.js"
import {
  buildInitialCache,
  captureSourceManifest,
  manifestsEqual,
  readPersistedGraphCache,
  rankedSymbolToTag,
  resolveMapDir,
  writePersistedGraphCache,
  type PersistedCache,
  type PersistedWorktreeGraph,
  type SourceManifestEntry,
} from "./graph-store.js"
import {
  getScopedRankSnapshot,
  getWorktreeGraphCache,
  initializeGraphPlugin,
  markStaleForPath,
  persistScopedRankSnapshot,
  setWorktreeGraphCache,
} from "./graph-service.js"

// Re-export cache-layer symbols used by callers/tests.
export {
  resolveMapDir,
  readPersistedGraphCache,
  writePersistedGraphCache,
  buildInitialCache,
  initializeGraphPlugin,
  markStaleForPath,
  setWorktreeGraphCache,
  getWorktreeGraphCache,
  type PersistedCache,
  type PersistedWorktreeGraph,
  type SourceManifestEntry,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Extension -> canonical language (for discovery + the `lang` filter). The
// actual tree-sitter work happens in the extract subprocess.
const LANGS: Record<string, string[]> = {
  typescript: [".ts", ".cts", ".mts"],
  tsx: [".tsx"],
  javascript: [".js", ".jsx", ".cjs", ".mjs"],
  python: [".py", ".pyi"],
  go: [".go"],
  rust: [".rs"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".h"],
}

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  py: "python",
  python: "python",
  go: "go",
  rs: "rust",
  rust: "rust",
  cpp: "cpp",
  cplusplus: "cpp",
}

// PageRank / map defaults (networkx + aider defaults).
const DAMPING = 0.85
const MAX_ITER = 100
const TOL = 1e-6
const DEFAULT_MAX_TOKENS = 1024
const MAP_MUL_NO_FILES = 8 // expand budget when no paths/globs focus given
const LINE_TRUNC = 100
const CHARS_PER_TOKEN = 4 // token proxy (no model tokenizer available)
const OK_ERR = 0.15 // early-stop tolerance in binary search

// `MAP_DIR_ENV` ("OP_AST_GREP_MAP_DIR") and `GRAPH_FILE` ("graph.json") moved
// to ./graph-store.ts. The cache-layer module owns all cache I/O.

// Directory names never descended into during file discovery.
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".ast-grep", ".opencode", ".sandcastle",
  "dist", "build", "target", ".next", ".cache", "out", "vendor", ".venv", "venv",
  "__pycache__", ".mypy_cache", ".pytest_cache", "coverage",
])

// ---------------------------------------------------------------------------
// Language resolution (extension -> canonical language)
// ---------------------------------------------------------------------------

function languageForFile(absPath: string): string | null {
  for (const [lang, exts] of Object.entries(LANGS)) {
    if (exts.some((e) => absPath.endsWith(e))) return lang
  }
  return null
}

function normalizeLangFilter(langFilter?: string): string | undefined {
  if (!langFilter) return undefined
  return LANG_ALIASES[langFilter.toLowerCase()] ?? langFilter.toLowerCase()
}

// ---------------------------------------------------------------------------
// Tag extraction via the standalone Node subprocess
// ---------------------------------------------------------------------------
// All tree-sitter work runs in .opencode/ast-grep-map-extract.mjs under a real
// `node` process (the plugin's own runtime may be bundled and unable to load
// tree-sitter's native N-API addons). We feed it absolute file paths via stdin
// and read back a JSON array of tags from stdout.

// `Tag` (the extract.mjs output shape) + `Graph`/`GraphEdge`/`RankedTag`/
// `BuildInput` live in ./graph.ts. impl.ts re-exports them at the bottom for
// the test harness; callers here use the local aliases imported above.

const EXTRACT_SCRIPT_NAME = "extract.mjs"
const EXTRACT_SCRIPT_INSTALLED_NAME = "ast-grep-map-extract.mjs"
const EXTRACT_SCRIPT_REL = join("src", "ast-grep-map", EXTRACT_SCRIPT_NAME)
const NODE_ENV_KEY = "OP_AST_GREP_MAP_NODE"
const SCRIPT_ENV_KEY = "OP_AST_GREP_MAP_SCRIPT"
const EXTRACT_TIMEOUT_MS = 120_000

// Resolve the extractor script: env override -> <worktree>/src/ast-grep-map/extract.mjs ->
// walk up from worktree (handles monorepo subdirs). The extractor runs in a real
// `node` subprocess because tree-sitter's N-API addons don't load in opencode's
// bundled runtime.
function resolveExtractScript(worktree: string): string | null {
  const envScript = process.env[SCRIPT_ENV_KEY]
  if (envScript && existsSync(envScript)) return envScript
  const candidates: string[] = []
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), EXTRACT_SCRIPT_INSTALLED_NAME))
  } catch {
    /* import.meta.url is always available in opencode, but keep resolution best-effort. */
  }
  let dir = worktree
  for (let i = 0; i < 12; i++) {
    candidates.push(join(dir, EXTRACT_SCRIPT_REL))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// Resolve the node binary: env override -> "node" on PATH.
function resolveNode(): string {
  return process.env[NODE_ENV_KEY] || "node"
}

async function extractAllTags(worktree: string, files: string[], signal: AbortSignal): Promise<Tag[]> {
  const script = resolveExtractScript(worktree)
  if (!script) {
    throw new Error(
      `ast-grep-map extractor script not found. Expected src/ast-grep-map/${EXTRACT_SCRIPT_NAME} under the worktree (or set ${SCRIPT_ENV_KEY}).`,
    )
  }
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(resolveNode(), [script, worktree], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (c: string) => {
      stdout += c
    })
    child.stderr?.on("data", (c: string) => {
      stderr += c
    })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }, EXTRACT_TIMEOUT_MS)
    const onAbort = () => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      if (err) return rejectFn(err)
      try {
        const data = JSON.parse(stdout)
        if (Array.isArray(data)) resolveFn(data as Tag[])
        else resolveFn([])
      } catch {
        rejectFn(new Error(`ast-grep-map extractor returned invalid JSON.${stderr ? `\n${stderr.trim()}` : ""}`))
      }
    }
    child.on("error", (e: Error) => {
      stderr += `\nspawn error: ${e.message}`
      finish(timedOut ? new Error(`ast-grep-map extraction timed out after ${EXTRACT_TIMEOUT_MS / 1000}s.`) : e)
    })
    child.on("close", (code: number | null) => {
      if (timedOut) return finish(new Error(`ast-grep-map extraction timed out after ${EXTRACT_TIMEOUT_MS / 1000}s.`))
      if (code !== 0 && code !== null) {
        return finish(new Error(`ast-grep-map extractor exited with code ${code}.${stderr.trim() ? `\n${stderr.trim()}` : ""}`))
      }
      finish()
    })
    // Feed the file list via stdin (unbounded; avoids argv length limits).
    child.stdin?.end(files.join("\n") + "\n")
  })
}

// ---------------------------------------------------------------------------
// Graph (aider MultiDiGraph: nodes=files, edges=referencer->definer per ident)
// ---------------------------------------------------------------------------
//
// Graph construction, PageRank, and rank distribution live in ./graph.ts.
// Local thin wrappers preserve the historical call sites while keeping the
// pure math out of this I/O-heavy module.

type Graph = GraphT
type GraphEdge = GraphEdgeT
type RankedTag = RankedTagT

function buildGraph(input: BuildInput): Graph {
  return buildGraphImpl(input)
}

function pageRank(
  graph: Graph,
  personalization: Map<string, number>,
  opts: { alpha: number; max_iter: number; tol: number },
): Map<string, number> {
  return pageRankImpl(graph, personalization, opts)
}

function rankDefinitions(graph: Graph, scores: Map<string, number>, defTags: Tag[]): RankedTag[] {
  return rankDefinitionsImpl(graph, scores, defTags)
}

// ---------------------------------------------------------------------------
// Rendering: compact outline. Path shown once per file; each ranked symbol is
// its declaration line + a GitHub-style line range (L<n> for one-liners,
// L<start>-L<end> for spans). No │/⋮ source rendering.
// ---------------------------------------------------------------------------

function tokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function truncateLine(line: string): string {
  return line.length > LINE_TRUNC ? line.slice(0, LINE_TRUNC) : line
}

// GitHub-style range token. 0-based in -> 1-based "L<n>" or "L<start>-L<end>".
function rangeToken(start: number, end: number): string {
  const s = start + 1
  const e = (end ?? start) + 1
  return s === e ? `L${s}` : `L${s}-L${e}`
}

function renderTree(rankedTags: RankedTag[]): string {
  if (rankedTags.length === 0) return ""
  // Group by file.
  const byFile = new Map<string, RankedTag[]>()
  for (const rt of rankedTags) {
    const f = rt.tag.rel_fname
    let arr = byFile.get(f)
    if (!arr) {
      arr = []
      byFile.set(f, arr)
    }
    arr.push(rt)
  }

  const fileOrder = Array.from(byFile.keys())
  // files ordered by their best (max) rank, desc.
  fileOrder.sort((a, b) => {
    const ma = Math.max(...byFile.get(a)!.map((r) => r.rank))
    const mb = Math.max(...byFile.get(b)!.map((r) => r.rank))
    return mb - ma || (a < b ? -1 : 1)
  })

  const blocks: string[] = []
  for (const file of fileOrder) {
    // within a file: sort by start line (top-to-bottom), dedupe by (name,line)
    const rts = byFile
      .get(file)!
      .slice()
      .sort((x, y) => x.tag.line - y.tag.line)
    const seen = new Set<string>()
    const rows: { tok: string; decl: string }[] = []
    for (const rt of rts) {
      const key = `${rt.tag.line}\0${rt.tag.name}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ tok: rangeToken(rt.tag.line, rt.tag.endLine ?? rt.tag.line), decl: truncateLine(rt.tag.decl || rt.tag.name) })
    }
    const width = Math.max(...rows.map((r) => r.tok.length))
    const lines = rows.map((r) => `  ${r.tok.padStart(width)}  ${r.decl}`)
    blocks.push(`${file}:\n${lines.join("\n")}`)
  }
  return blocks.join("\n\n")
}

// ---------------------------------------------------------------------------
// Token-budget binary search (aider get_ranked_tags_map_uncached)
// ---------------------------------------------------------------------------

function binarySearchTokenBudget(rankedTags: RankedTag[], maxTokens: number): string {
  const numTags = rankedTags.length
  if (numTags === 0) return ""
  let lower = 0
  let upper = numTags
  let best = ""
  let bestTokens = 0
  let middle = Math.min(Math.floor(maxTokens / 25), numTags)
  let guard = 0
  while (lower <= upper && guard++ < 64) {
    const tree = renderTree(rankedTags.slice(0, middle))
    const tokens = tokenCount(tree)
    const pctErr = Math.abs(tokens - maxTokens) / maxTokens
    if ((tokens <= maxTokens && tokens > bestTokens) || pctErr < OK_ERR) {
      best = tree
      bestTokens = tokens
      if (pctErr < OK_ERR) break
    }
    if (tokens < maxTokens) lower = middle + 1
    else upper = middle - 1
    middle = Math.floor((lower + upper) / 2)
  }
  return best
}

// ---------------------------------------------------------------------------
// File discovery (walk worktree, apply ignores + ext filter)
// ---------------------------------------------------------------------------

function discoverCodeFiles(root: string, langFilter?: string): string[] {
  const out: string[] = []
  const stack: string[] = [root]
  const normalizedLang = normalizeLangFilter(langFilter)
  while (stack.length) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st: ReturnType<typeof lstatSync>
      try {
        // Improvement #4: lstatSync (not statSync) so symlinks are detected,
        // not followed. A symlinked directory could escape the worktree root
        // and pull arbitrary files into the graph; we refuse to descend.
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue
        stack.push(full)
      } else if (st.isFile()) {
        const lang = languageForFile(full)
        if (!lang) continue
        if (normalizedLang && lang !== normalizedLang) continue
        out.push(full)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Path/glob scope matching
// ---------------------------------------------------------------------------

function matchScope(allFiles: string[], worktree: string, paths?: string[], globs?: string[]): Set<string> {
  const scope = new Set<string>()
  const relAll = allFiles.map((f) => ({ abs: f, rel: relative(worktree, f) }))
  const pathSet = (paths && paths.length > 0) ? paths : []
  for (const { abs, rel } of relAll) {
    let include = pathSet.length === 0
    if (!include) {
      for (const p of pathSet) {
        const rp = resolve(worktree, p)
        if (abs === rp || abs.startsWith(rp + sep) || rel === p) {
          include = true
          break
        }
      }
    }
    if (include && globs && globs.length > 0) {
      for (const g of globs) {
        if (g.startsWith("!")) {
          if (globMatch(g.slice(1), rel)) include = false
        } else if (globMatch(g, rel)) {
          include = true
        }
      }
    }
    if (include) scope.add(abs)
  }
  return scope
}

// Minimal glob: *, **, ? (good enough for path filtering).
function globMatch(pattern: string, path: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "<<GLOBSTAR>>")
        .replace(/\*/g, "[^/]*")
        .replace(/<<GLOBSTAR>>/g, ".*")
        .replace(/\?/g, "[^/]") +
      "$",
  )
  return re.test(path)
}

// ---------------------------------------------------------------------------
// Persistence — delegated to ./graph-store.ts (versioned schema + atomic
// writes + source-manifest validation). The historical `PersistedGraph`
// shape was replaced by `PersistedCache` (v2) with a primary worktree graph
// and scope-keyed PPR snapshot overlays.
// ---------------------------------------------------------------------------

// `PersistedGraph` is retained as a local compatibility view over the v2
// `worktreeGraph` payload so the REPORT.md generator + report tests don't
// need to migrate in the same phase. New code should consume PersistedCache.
interface PersistedGraph {
  version: number
  worktree: string
  generatedAt: string
  nodeCount: number
  edgeCount: number
  nodes: string[]
  edges: GraphEdge[]
  scores: Record<string, number>
  rankedSymbols: Array<{ file: string; ident: string; rank: number; line: number; endLine: number; decl: string }>
  mentionedIdents: string[]
  sourceManifest: SourceManifestEntry[]
}

function cacheToGraphView(cache: PersistedCache): PersistedGraph {
  const g = cache.worktreeGraph
  return {
    version: cache.version,
    worktree: cache.worktree,
    generatedAt: g.builtAt,
    nodeCount: g.graph.nodes.length,
    edgeCount: g.graph.edges.length,
    nodes: g.graph.nodes,
    edges: g.graph.edges,
    scores: g.scores,
    rankedSymbols: g.rankedSymbols,
    mentionedIdents: g.mentionedIdents,
    sourceManifest: g.sourceManifest,
  }
}

function persistGraphAsCache(
  worktree: string,
  graph: Graph,
  scores: Map<string, number>,
  ranked: RankedTag[],
  sourceManifest: SourceManifestEntry[],
  mentionedIdents: string[],
): PersistedCache {
  const cache = buildInitialCache(
    worktree,
    { nodes: graph.nodes, edges: graph.edges },
    scores,
    ranked,
    sourceManifest,
    mentionedIdents,
  )
  writePersistedGraphCache(worktree, cache)
  // Keep the in-memory lifecycle state in sync so scope snapshots layered on
  // top (Phase 4) reference the freshly built worktree graph.
  setWorktreeGraphCache(worktree, cache)
  return cache
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

// Apply PPR bias to a baseline ranking, persisting a scope-keyed snapshot for
// reuse on subsequent calls with the same scope+seeds. Returns the baseline
// unchanged when no scope is given (preserves unscoped byte-identical output).
//
// Critical ordering: the caller MUST have already populated the worktree graph
// cache (via setWorktreeGraphCache / persistGraphAsCache) before invoking this,
// because persistScopedRankSnapshot writes into the in-memory cache payload.
async function applyScopedRanking(
  worktree: string,
  graph: Graph,
  defTags: Tag[],
  baseline: RankedTag[],
  args: { paths?: string[]; globs?: string[]; mentioned_idents?: string[] },
): Promise<RankedTag[]> {
  const scopeGiven =
    !!(args.paths && args.paths.length) ||
    !!(args.globs && args.globs.length) ||
    !!(args.mentioned_idents && args.mentioned_idents.length)
  if (!scopeGiven) return baseline

  const { seeds, scope } = buildScopeSeeds(worktree, graph.nodes, args)
  let snapshot = await getScopedRankSnapshot(worktree, scope, seeds)
  let fileScores: Record<string, number> | null = snapshot?.rankSnapshot.fileScores ?? null

  if (!snapshot) {
    // Derive locally first so we ALWAYS have scores to apply, even if the
    // persist step below cannot write (e.g., cache still null in a race).
    const derived = deriveScopedFileScores(graph, seeds, {
      damping: DAMPING,
      maxIterations: MAX_ITER,
      tolerance: TOL,
    })
    fileScores = derived.fileScores
    // Persist happens after the caller installs the worktree cache; here we
    // only attempt it best-effort (it will succeed on the cache-hit path where
    // the worktree cache is already in memory).
    snapshot = await persistScopedRankSnapshot(worktree, scope, seeds, derived)
    fileScores = snapshot?.rankSnapshot.fileScores ?? derived.fileScores
  }

  return applyScopeScores(graph, defTags, baseline, fileScores)
}

// Resolve the worktree graph from cache OR rebuild it from scratch.
// Returns the in-memory graph, the def tags, and a uniform-personalization
// ranked list (used for the worktree cache + REPORT.md + as the baseline for
// scope-aware re-ranking).
async function resolveWorktreeGraph(
  worktree: string,
  allFiles: string[],
  scopeFiles: Set<string>,
  mentionedIdents: Set<string>,
  signal: AbortSignal,
): Promise<{ graph: Graph; defTags: Tag[]; ranked: RankedTag[]; scores: Map<string, number> } | { error: string }> {
  const relFiles = allFiles.map((f) => relative(worktree, f))
  // No source manifest capture here — caller does that for cache keying.
  const defTags: Tag[] = []
  const defines = new Map<string, Set<string>>()
  const references = new Map<string, string[]>()
  let allTags: Tag[]
  try {
    allTags = await extractAllTags(worktree, allFiles, signal)
  } catch (e: any) {
    return { error: `ast-grep-map extraction failed: ${e.message || e}` }
  }
  const graphFiles = new Set<string>()
  for (const t of allTags) {
    graphFiles.add(t.rel_fname)
    if (t.kind === "def") {
      defTags.push(t)
      let s = defines.get(t.name)
      if (!s) {
        s = new Set()
        defines.set(t.name, s)
      }
      s.add(t.rel_fname)
    } else {
      let arr = references.get(t.name)
      if (!arr) {
        arr = []
        references.set(t.name, arr)
      }
      arr.push(t.rel_fname)
    }
  }

  const chatFiles = new Set(Array.from(scopeFiles).map((f) => relative(worktree, f)))
  const graph = buildGraph({ defines, references, mentionedIdents, chatFiles, allFiles: Array.from(graphFiles) })

  const personalization = new Map<string, number>()
  const base = 100 / Math.max(graph.nodes.length, 1)
  for (const n of graph.nodes) personalization.set(n, base)
  for (const c of chatFiles) if (personalization.has(c)) personalization.set(c, (personalization.get(c) ?? 0) + base)
  for (const ident of mentionedIdents) {
    for (const n of graph.nodes) {
      if (n.split(sep).includes(ident) || n.toLowerCase().includes(ident.toLowerCase())) {
        personalization.set(n, (personalization.get(n) ?? 0) + base)
      }
    }
  }

  const scores = pageRank(graph, personalization, { alpha: DAMPING, max_iter: MAX_ITER, tol: TOL })
  const ranked = rankDefinitions(graph, scores, defTags)
  return { graph, defTags, ranked, scores }
}

function usableRoot(root: string | undefined): string | null {
  if (!root || root === "/" || root === "\\" || root === sep) return null
  return root
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

// ---------------------------------------------------------------------------
// Seed construction for Personalized PageRank (improvement #3)
// ---------------------------------------------------------------------------
//
// Build a SeedEntry[] for a given scope. Seeds are workspace-relative POSIX
// paths that the PPR personalization vector will be biased toward. Aider does
// the same thing when you scope `paths`/`globs`: those files become the
// personalization focus. Falls back to uniform personalization when no seeds.

const SEED_PATHS_ENV_KEY = "OP_AST_GREP_MAP_SEED_PATHS"

function buildScopeSeeds(
  worktree: string,
  graphNodes: string[],
  args: { paths?: string[]; globs?: string[]; mentioned_idents?: string[] },
): { seeds: SeedEntry[]; scope: EffectiveScope } {
  // Compute the effective scope (POSIX-normalized paths/globs).
  const paths = (args.paths ?? []).map((p) => normalizeRelativePath(relative(worktree, resolve(worktree, p))))
  const globs = args.globs ?? []
  const scope = normalizeEffectiveScope({ paths, globs })

  const nodeSet = new Set(graphNodes)
  const pushIfNode = (file: string, weight: number, source: string) => {
    if (nodeSet.has(file)) seeds.push({ file, weight, source })
  }

  const seeds: SeedEntry[] = []

  // paths → files inside any of the given paths become seeds
  for (const node of graphNodes) {
    if (isFileInScope(node, scope) && matchesScopeGlobs(node, scope)) {
      pushIfNode(node, 1, "scope-path")
    }
  }

  // mentioned_idents → files whose path components include the ident become seeds
  for (const ident of args.mentioned_idents ?? []) {
    const lower = ident.toLowerCase()
    for (const node of graphNodes) {
      const parts = node.split("/")
      if (parts.includes(ident) || node.toLowerCase().includes(lower)) {
        pushIfNode(node, 1, "mentioned-ident")
      }
    }
  }

  // AST_GREP_MAP_SEED_PATHS env var (debug seeds — port from other repo)
  const envRaw = process.env[SEED_PATHS_ENV_KEY]?.trim()
  if (envRaw) {
    for (const candidate of envRaw.split(/[;,\r\n]+/).map((s) => s.trim()).filter(Boolean)) {
      try {
        const rel = normalizeRelativePath(relative(worktree, resolve(worktree, candidate)))
        pushIfNode(rel, 1, "debug-seed-path")
      } catch {
        /* ignore bad paths */
      }
    }
  }

  // Normalize (dedupe, scope/glob-filter, symlink-reject — Phase 5 adds the
  // symlink check; here we just thread workspaceRoot so the helper can use it).
  const normalized = normalizeSeedEntries(seeds, scope, worktree)
  return { seeds: normalized, scope }
}

// Re-rank def tags using a scope-derived PageRank score map. Falls back to the
// passed-in `ranked` if no scope snapshot is available.
function applyScopeScores(
  graph: Graph,
  defTags: Tag[],
  ranked: RankedTag[],
  scopeScores: Record<string, number> | null,
): RankedTag[] {
  if (!scopeScores) return ranked
  const scoreMap = new Map<string, number>()
  for (const [k, v] of Object.entries(scopeScores)) scoreMap.set(k, v)
  // Only re-rank when the scope scores actually cover graph nodes; otherwise
  // rankDefinitions would produce an empty output.
  const covers = graph.nodes.some((n) => scoreMap.has(n))
  if (!covers) return ranked
  return rankDefinitions(graph, scoreMap, defTags)
}

// Rebuild the outWeight index from an edge list. Used by the cache-hit branch
// where we reconstruct a Graph view from persisted data without going through
// buildGraph (which would re-compute it from scratch on a different shape).
function computeOutWeight(edges: GraphEdge[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of edges) out.set(e.src, (out.get(e.src) ?? 0) + e.weight)
  return out
}

function resolveRoot(ctx: Pick<ToolContext, "directory" | "worktree">, langFilter?: string): string {
  // Prefer the git worktree root (whole-repo graphing), but opencode can report
  // a placeholder worktree such as /home/agent/workspace while the active
  // session directory is the real project. Use the first candidate that actually
  // contains supported source files, then fall back to the historical ordering.
  const wt = usableRoot(ctx.worktree)
  const dir = usableRoot(ctx.directory)
  const roots = wt && dir && !isSameOrInside(resolve(dir), resolve(wt)) ? [dir, wt] : [wt, dir]
  const candidates = [...roots, "."].filter((r): r is string => Boolean(r))
  const seen = new Set<string>()
  const unique = candidates.filter((r) => {
    const abs = resolve(r)
    if (seen.has(abs)) return false
    seen.add(abs)
    return true
  })
  for (const root of unique) {
    if (discoverCodeFiles(root, langFilter).length > 0) return root
  }
  return unique[0] ?? "."
}

const ast_grep_map = tool({
  description:
    "Produce an aider-style code map (real source lines under │/⋮ box-drawing) ranked by PageRank, for the scoped files. Builds the PageRank graph from ALL code files in the worktree, personalizes toward the scoped files, and persists the graph to <worktree>/.ast-grep/graph.json. Uses tree-sitter + aider's -tags.scm queries (supports ts, tsx, js, py, go, rs, cpp).",
  args: {
    paths: tool.schema.array(tool.schema.string()).optional().describe("Files/dirs to include in the OUTPUT map (default: whole worktree)."),
    globs: tool.schema.array(tool.schema.string()).optional().describe("Include/exclude globs for OUTPUT map files (prefix '!' to exclude)."),
    lang: tool.schema.string().optional().describe("Restrict to one language (ts, tsx, js, py, go, rs, cpp)."),
    max_tokens: tool.schema.number().optional().describe("Token budget for the rendered map (default 1024; x8 when no paths/globs given)."),
    mentioned_idents: tool.schema.array(tool.schema.string()).optional().describe("Symbol names to boost in ranking."),
    refresh: tool.schema.enum(["auto", "always"]).optional().describe("auto=reuse cached graph if sources unchanged (default); always=rebuild."),
    json: tool.schema.boolean().optional().describe("Return the persisted graph JSON instead of the rendered map."),
  },
  execute: async (args, ctx) => {
    const worktree = resolveRoot(ctx, args.lang)
    const refresh = args.refresh ?? "auto"

    // 1. Discover all code files (graph set).
    const allFiles = discoverCodeFiles(worktree, args.lang)
    if (allFiles.length === 0) {
      return `No supported code files found under ${worktree}. (Supported: ts, tsx, js, py, go, rs, cpp)`
    }

    // 2. Scope (output map target / personalization focus).
    const scopeFiles = matchScope(allFiles, worktree, args.paths, args.globs)
    const mentionedIdents = new Set(args.mentioned_idents ?? [])
    const scopeGiven =
      !!(args.paths && args.paths.length) ||
      !!(args.globs && args.globs.length) ||
      !!(args.mentioned_idents && args.mentioned_idents.length)

    // 3. Capture source manifest (mtime+size) for cache validity.
    const relFiles = allFiles.map((f) => relative(worktree, f))
    const sourceManifest = captureSourceManifest(worktree, relFiles) ?? []

    // 4. Hydrate lifecycle state once per process.
    await initializeGraphPlugin(worktree)

    // 5. Try refresh:"auto" — reuse persisted worktree graph if manifest unchanged.
    const persisted = getWorktreeGraphCache(worktree)
    const cacheHit =
      refresh === "auto" &&
      !!persisted &&
      manifestsEqual(persisted.worktreeGraph.sourceManifest, sourceManifest)

    if (cacheHit && persisted) {
      // Reuse the cached worktree graph. The PPR scope overlay is layered on
      // top — when scope is given, look up (or derive+persist) the scope
      // snapshot and re-rank. Without this, scoped cache-hit calls would
      // silently return uniform-personalization output.
      const rankedUniform: RankedTag[] = persisted.worktreeGraph.rankedSymbols.map((r) => ({
        tag: rankedSymbolToTag(r),
        rank: r.rank,
      }))
      // Reconstruct defTags (the input to rankDefinitions) from the cache's
      // rankedSymbols. Without this, applyScopeScores would receive an empty
      // defTags array and return an empty re-ranking — the cache-hit scoped
      // path would render "(no ranked symbols to display)" even on a fully
      // populated cache. Each ranked symbol's tag IS a def tag (kind: "def").
      const cachedDefTags: Tag[] = rankedUniform.map((rt) => rt.tag)
      // Reconstruct a minimal Graph object sufficient for applyScopeScores
      // (which only needs .nodes and .edges + .outWeight). The cache stores
      // them; outWeight is recomputed from edges cheaply.
      const cachedGraph: Graph = {
        nodes: persisted.worktreeGraph.graph.nodes,
        edges: persisted.worktreeGraph.graph.edges,
        outWeight: computeOutWeight(persisted.worktreeGraph.graph.edges),
      }
      const ranked = await applyScopedRanking(worktree, cachedGraph, cachedDefTags, rankedUniform, args)
      const maxTokens = (args.max_tokens ?? DEFAULT_MAX_TOKENS) * (scopeGiven ? 1 : MAP_MUL_NO_FILES)
      if (args.json) return JSON.stringify(persisted, null, 2)
      const tree = binarySearchTokenBudget(ranked, maxTokens)
      return formatResult(tree)
    }

    // 6. Cache miss — extract tags and rebuild the worktree graph.
    const resolved = await resolveWorktreeGraph(worktree, allFiles, scopeFiles, mentionedIdents, ctx.abort)
    if ("error" in resolved) return resolved.error
    const { graph, defTags, ranked: rankedUniform, scores } = resolved

    // 7. Persist worktree graph FIRST so scope snapshots layered on top survive.
    //    This was the root cause of three critical bugs in the first review:
    //    persistGraphAsCache replaces state.cache with a fresh payload (scopes: []),
    //    so any scope snapshot written before this step gets clobbered.
    const cache = persistGraphAsCache(
      worktree,
      graph,
      scores,
      rankedUniform,
      sourceManifest,
      Array.from(mentionedIdents),
    )
    if (args.json) {
      return JSON.stringify(cache, null, 2)
    }

    // 8. Now layer the scope-aware PPR ranking on top of the freshly persisted
    //    worktree graph. persistScopedRankSnapshot writes into the same cache
    //    payload installed in step 7, so the snapshot survives.
    const ranked = await applyScopedRanking(worktree, graph, defTags, rankedUniform, args)

    // 9. Render to token budget.
    const maxTokens = (args.max_tokens ?? DEFAULT_MAX_TOKENS) * (scopeGiven ? 1 : MAP_MUL_NO_FILES)
    const tree = binarySearchTokenBudget(ranked, maxTokens)
    return formatResult(tree)
  },
})

function formatResult(tree: string): string {
  return tree || "(no ranked symbols to display)"
}

// ---------------------------------------------------------------------------
// Report generator — pure functions: PersistedGraph → markdown briefing.
// ---------------------------------------------------------------------------
// No I/O, no side effects. Sections mirror graphify's GRAPH_REPORT.md where
// local-only computation permits:
//   - God nodes / hubs (PageRank + distinct referencer count)
//   - Surprising cross-module connections (high-weight edges across top-level dirs)
//   - Module dependency graph (mermaid block, top-level dir coupling)
//   - Orphan / under-referenced definitions (definers with only self-edges)
//   - Multi-definer ambiguity (idents defined in >1 file)
//
// All relationships are EXTRACTED via AST; there is no inference step. The
// multi-definer list is the closest thing to an "ambiguity" signal.

const REPORT_TOP_N = 10
const REPORT_MULTI_DEFINER_N = 15
const REPORT_ORPHAN_SAMPLE_N = 5
const REPORT_ORPHAN_TABLE_CAP = 20
const REPORT_MAX_MODULE_EDGES = 30
const REPORT_LOCK_STALE_MS = 5 * 60 * 1000
const REPORT_FILE = "REPORT.md"
const REPORT_TMP = "REPORT.md.tmp"
const REPORT_LOCK_FILE = ".report.lock"
const REPORT_LOG_FILE = "report.log"

export interface Hub {
  file: string
  pagerank: number
  distinctReferencers: number
  topSymbols: Array<{ ident: string; rank: number }>
}

export interface SurprisingEdge {
  src: string
  dst: string
  ident: string
  weight: number
  score: number
  srcModule: string
  dstModule: string
}

export interface OrphanFile {
  file: string
  defCount: number
  sampleIdents: string[]
}

export interface MultiDefinerIdent {
  ident: string
  definerCount: number
  files: string[]
}

export interface ReportOptions {
  worktree?: string
  topN?: number
  multiDefinerN?: number
  generatedAt?: string
}

// First path segment under worktree. Rel paths in graph.json may use either
// POSIX or Windows separators depending on origin; normalize to POSIX before
// splitting so the module label is stable across platforms.
export function topDir(rel: string): string {
  const posixRel = rel.replace(/\\/g, "/")
  const idx = posixRel.indexOf("/")
  return idx === -1 ? posixRel : posixRel.slice(0, idx)
}

// In-degree from unique non-self src files.
function distinctReferencers(edges: GraphEdge[], file: string): number {
  const set = new Set<string>()
  for (const e of edges) {
    if (e.dst === file && e.src !== file) set.add(e.src)
  }
  return set.size
}

export function topHubs(g: PersistedGraph, n: number = REPORT_TOP_N): Hub[] {
  const symbolsByFile = new Map<string, Array<{ ident: string; rank: number }>>()
  for (const rs of g.rankedSymbols) {
    let arr = symbolsByFile.get(rs.file)
    if (!arr) {
      arr = []
      symbolsByFile.set(rs.file, arr)
    }
    arr.push({ ident: rs.ident, rank: rs.rank })
  }
  const files = Object.keys(g.scores)
  const hubs: Hub[] = files.map((file) => ({
    file,
    pagerank: g.scores[file] ?? 0,
    distinctReferencers: distinctReferencers(g.edges, file),
    topSymbols: (symbolsByFile.get(file) ?? [])
      .slice()
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 2),
  }))
  hubs.sort(
    (a, b) =>
      b.pagerank - a.pagerank ||
      b.distinctReferencers - a.distinctReferencers ||
      (a.file < b.file ? -1 : 1),
  )
  return hubs.slice(0, n)
}

export function surprisingConnections(g: PersistedGraph, n: number = REPORT_TOP_N): SurprisingEdge[] {
  const pairCounts = new Map<string, number>()
  const keyOf = (a: string, b: string) => `${a}\u0000${b}`
  for (const e of g.edges) {
    const ts = topDir(e.src)
    const td = topDir(e.dst)
    if (ts === td || e.src === e.dst) continue
    const k = keyOf(ts, td)
    pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1)
  }
  const candidates: SurprisingEdge[] = []
  for (const e of g.edges) {
    const ts = topDir(e.src)
    const td = topDir(e.dst)
    if (ts === td || e.src === e.dst) continue
    const total = pairCounts.get(keyOf(ts, td)) ?? 1
    const score = e.weight * Math.log(1 + total)
    candidates.push({
      src: e.src,
      dst: e.dst,
      ident: e.ident,
      weight: e.weight,
      score,
      srcModule: ts,
      dstModule: td,
    })
  }
  candidates.sort(
    (a, b) => b.score - a.score || b.weight - a.weight || (a.src < b.src ? -1 : 1),
  )
  // Dedupe by (src, dst, ident) — the graph is a multigraph and parallel edges
  // would otherwise dominate the top-N list.
  const seen = new Set<string>()
  const out: SurprisingEdge[] = []
  for (const c of candidates) {
    const k = `${c.src}\u0000${c.dst}\u0000${c.ident}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
    if (out.length >= n) break
  }
  return out
}

export function moduleDependencyGraph(g: PersistedGraph, maxEdges: number = REPORT_MAX_MODULE_EDGES): string {
  const weights = new Map<string, number>()
  const keyOf = (a: string, b: string) => `${a}\u0000${b}`
  for (const e of g.edges) {
    const ts = topDir(e.src)
    const td = topDir(e.dst)
    if (ts === td) continue
    const k = keyOf(ts, td)
    weights.set(k, (weights.get(k) ?? 0) + e.weight)
  }
  const modules = new Set<string>()
  for (const k of weights.keys()) {
    const [a, b] = k.split("\u0000")
    modules.add(a)
    modules.add(b)
  }
  // mermaid id sanitizer (dir names are usually safe but be defensive).
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_")
  const pairs = Array.from(weights.entries())
    .map(([k, w]) => {
      const [a, b] = k.split("\u0000")
      return { a, b, w }
    })
    .sort((x, y) => y.w - x.w)
    .slice(0, maxEdges)
  const lines = ["```mermaid", "graph LR"]
  for (const m of Array.from(modules).sort()) lines.push(`  ${sanitize(m)}["${m}"]`)
  for (const p of pairs) {
    lines.push(`  ${sanitize(p.a)} -->|w=${p.w.toFixed(1)}| ${sanitize(p.b)}`)
  }
  if (weights.size > pairs.length) {
    lines.push(`  %% ${weights.size - pairs.length} more edges truncated`)
  }
  lines.push("```")
  return lines.join("\n")
}

export function orphanDefs(g: PersistedGraph): OrphanFile[] {
  // A file is "orphan" IFF it has at least one canonical self-loop (weight <= 0.1,
  // src === dst — emitted by buildGraph for definers with zero referencers) AND
  // no non-canonical incoming edges. Files with no incoming edges at all are NOT
  // flagged — in real buildGraph output they would have received a self-loop,
  // so absence of both means the file isn't an orphan pattern.
  const defCounts = new Map<string, { count: number; idents: Set<string> }>()
  for (const rs of g.rankedSymbols) {
    let v = defCounts.get(rs.file)
    if (!v) {
      v = { count: 0, idents: new Set() }
      defCounts.set(rs.file, v)
    }
    v.count++
    v.idents.add(rs.ident)
  }
  const canonicalSelfLoop = new Set<string>()
  const disqualified = new Set<string>()
  for (const e of g.edges) {
    if (e.src === e.dst) {
      if (e.weight <= 0.1) canonicalSelfLoop.add(e.dst)
      else disqualified.add(e.dst) // heavy self-loop
      continue
    }
    disqualified.add(e.dst) // any real incoming edge
  }
  const out: OrphanFile[] = []
  for (const [file, { count, idents }] of defCounts) {
    if (disqualified.has(file)) continue
    if (!canonicalSelfLoop.has(file)) continue
    out.push({
      file,
      defCount: count,
      sampleIdents: Array.from(idents).sort().slice(0, REPORT_ORPHAN_SAMPLE_N),
    })
  }
  out.sort((a, b) => b.defCount - a.defCount || (a.file < b.file ? -1 : 1))
  return out
}

export function multiDefiners(g: PersistedGraph, n: number = REPORT_MULTI_DEFINER_N): MultiDefinerIdent[] {
  const byIdent = new Map<string, Set<string>>()
  for (const rs of g.rankedSymbols) {
    let s = byIdent.get(rs.ident)
    if (!s) {
      s = new Set()
      byIdent.set(rs.ident, s)
    }
    s.add(rs.file)
  }
  const out: MultiDefinerIdent[] = []
  for (const [ident, files] of byIdent) {
    if (files.size > 1) {
      out.push({ ident, definerCount: files.size, files: Array.from(files).sort() })
    }
  }
  out.sort((a, b) => b.definerCount - a.definerCount || (a.ident < b.ident ? -1 : 1))
  return out.slice(0, n)
}

export function generateReport(g: PersistedGraph, opts: ReportOptions = {}): string {
  const topN = opts.topN ?? REPORT_TOP_N
  const multiN = opts.multiDefinerN ?? REPORT_MULTI_DEFINER_N
  const iso = opts.generatedAt ?? new Date().toISOString()
  const worktreeLabel = g.worktree || opts.worktree || "(unknown worktree)"
  const lines: string[] = []

  lines.push(
    `<!-- ast-grep-map report · generated ${iso} · all relationships EXTRACTED via AST (no INFERRED mass; the multi-definer list below is the only ambiguity signal). -->`,
  )
  lines.push("")
  lines.push(`# Repo briefing — \`${worktreeLabel}\``)
  lines.push("")
  lines.push(
    `_Auto-generated from the PageRank graph at \`.ast-grep/graph.json\`. ${g.nodeCount} files, ${g.edgeCount} edges._`,
  )
  lines.push("")

  const hubs = topHubs(g, topN)
  lines.push("## God nodes / hubs")
  lines.push("")
  lines.push("Files with the highest PageRank (entry points and central modules).")
  lines.push("")
  if (hubs.length === 0) {
    lines.push("_No hubs found._")
  } else {
    lines.push("| File | PageRank | Distinct referencers | Top symbol |")
    lines.push("|---|---:|---:|---|")
    for (const h of hubs) {
      const top = h.topSymbols[0]
      const sym = top ? `\`${top.ident}\` (rank ${(top.rank * 1000).toFixed(2)}\u2030)` : "\u2014"
      lines.push(`| \`${h.file}\` | ${h.pagerank.toFixed(4)} | ${h.distinctReferencers} | ${sym} |`)
    }
  }
  lines.push("")

  const surprising = surprisingConnections(g, topN)
  lines.push("## Surprising cross-module connections")
  lines.push("")
  lines.push(
    "High-weight edges between files in different top-level directories — non-obvious coupling ranked by `weight × ln(1 + module-pair edge count)`.",
  )
  lines.push("")
  if (surprising.length === 0) {
    lines.push("_No cross-module edges found._")
  } else {
    lines.push("| Score | Src | \u2192 Dst | Ident | Weight |")
    lines.push("|---:|---|---|---|---:|")
    for (const s of surprising) {
      lines.push(
        `| ${s.score.toFixed(2)} | \`${s.src}\` | \`${s.dst}\` | \`${s.ident}\` | ${s.weight.toFixed(2)} |`,
      )
    }
  }
  lines.push("")

  lines.push("## Module dependency graph")
  lines.push("")
  lines.push("Top-level directory coupling, summed edge weights.")
  lines.push("")
  lines.push(moduleDependencyGraph(g))
  lines.push("")

  const orphans = orphanDefs(g)
  lines.push("## Orphan / under-referenced definitions")
  lines.push("")
  lines.push(
    "Files whose defined symbols have no incoming references (only canonical self-edges). Candidates for dead code or entry-point-only modules.",
  )
  lines.push("")
  if (orphans.length === 0) {
    lines.push("_No orphans found._")
  } else {
    lines.push("| File | Defs | Sample identifiers |")
    lines.push("|---|---:|---|")
    for (const o of orphans.slice(0, REPORT_ORPHAN_TABLE_CAP)) {
      const sample = o.sampleIdents.map((i) => `\`${i}\``).join(", ")
      lines.push(`| \`${o.file}\` | ${o.defCount} | ${sample} |`)
    }
    if (orphans.length > REPORT_ORPHAN_TABLE_CAP) {
      lines.push(`_...and ${orphans.length - REPORT_ORPHAN_TABLE_CAP} more._`)
    }
  }
  lines.push("")

  const multi = multiDefiners(g, multiN)
  lines.push("## Multi-definer ambiguity")
  lines.push("")
  lines.push(
    "Identifiers defined in more than one file — symbol resolution is ambiguous without disambiguation.",
  )
  lines.push("")
  if (multi.length === 0) {
    lines.push("_No ambiguous identifiers found._")
  } else {
    lines.push("| Ident | Definers | Files |")
    lines.push("|---|---:|---|")
    for (const m of multi) {
      const files = m.files.map((f) => `\`${f}\``).join(", ")
      lines.push(`| \`${m.ident}\` | ${m.definerCount} | ${files} |`)
    }
  }
  lines.push("")

  lines.push("---")
  lines.push("")
  lines.push(
    `_To force regeneration: delete \`.ast-grep/graph.json\` and restart opencode, or call \`ast_grep_map\` with \`refresh: "always"\`._`,
  )

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Background report refresh (session.created hook)
// ---------------------------------------------------------------------------
// Checks the persisted graph's mtime cache; rebuilds the graph if stale; writes
// .ast-grep/REPORT.md atomically. All errors are caught and logged to
// .ast-grep/report.log — the hook must never crash the plugin load.
// Concurrency: PID lockfile at .ast-grep/.report.lock. Stale after 5 minutes.

export type RefreshStatus = "fresh" | "rebuilt" | "skipped" | "failed"

export interface RefreshResult {
  status: RefreshStatus
  error?: string
  reportPath?: string
}

function reportLogLine(mapDir: string, msg: string): void {
  try {
    const line = `${new Date().toISOString()} ${msg}\n`
    writeFileSync(join(mapDir, REPORT_LOG_FILE), line, { flag: "a" })
  } catch {
    /* never throw from logger */
  }
}

function acquireReportLock(mapDir: string): boolean {
  const lockPath = join(mapDir, REPORT_LOCK_FILE)
  try {
    if (existsSync(lockPath)) {
      const raw = readFileSync(lockPath, "utf8").trim()
      const [pidStr, tsStr] = raw.split("\u0000")
      const ts = Number(tsStr)
      if (Number.isFinite(ts) && Date.now() - ts < REPORT_LOCK_STALE_MS) {
        return false // active lock held by another process
      }
    }
    mkdirSync(mapDir, { recursive: true })
    writeFileSync(lockPath, `${process.pid}\u0000${Date.now()}`)
    return true
  } catch {
    return false
  }
}

function releaseReportLock(mapDir: string): void {
  try {
    const lockPath = join(mapDir, REPORT_LOCK_FILE)
    if (existsSync(lockPath)) {
      const raw = readFileSync(lockPath, "utf8").trim()
      const [pidStr] = raw.split("\u0000")
      if (pidStr === String(process.pid)) writeFileSync(lockPath, "")
    }
  } catch {
    /* ignore */
  }
}

function writeReportAtomic(mapDir: string, markdown: string): string {
  const outPath = join(mapDir, REPORT_FILE)
  const tmpPath = join(mapDir, REPORT_TMP)
  mkdirSync(mapDir, { recursive: true })
  writeFileSync(tmpPath, markdown)
  try {
    renameSync(tmpPath, outPath)
  } catch {
    writeFileSync(outPath, markdown) // rename can fail across devices
  }
  return outPath
}

function currentSourceManifest(worktree: string): SourceManifestEntry[] {
  const files = discoverCodeFiles(worktree).map((f) => relative(worktree, f))
  return captureSourceManifest(worktree, files) ?? []
}

// Mirrors the ast_grep_map tool's execute path with no scope focus: whole-repo
// graph, uniform personalization, default ranking. Persists via graph-store.
async function rebuildGraphForReport(worktree: string, signal: AbortSignal): Promise<PersistedGraph> {
  const allFiles = discoverCodeFiles(worktree)
  if (allFiles.length === 0) throw new Error(`no supported code files under ${worktree}`)
  const sourceManifest = captureSourceManifest(worktree, allFiles.map((f) => relative(worktree, f)))
  if (!sourceManifest) throw new Error("failed to capture source manifest during report rebuild")
  const allTags: Tag[] = await extractAllTags(worktree, allFiles, signal)
  const defines = new Map<string, Set<string>>()
  const references = new Map<string, string[]>()
  const defTags: Tag[] = []
  const graphFiles = new Set<string>()
  for (const t of allTags) {
    graphFiles.add(t.rel_fname)
    if (t.kind === "def") {
      defTags.push(t)
      let s = defines.get(t.name)
      if (!s) {
        s = new Set()
        defines.set(t.name, s)
      }
      s.add(t.rel_fname)
    } else {
      let arr = references.get(t.name)
      if (!arr) {
        arr = []
        references.set(t.name, arr)
      }
      arr.push(t.rel_fname)
    }
  }
  const graph = buildGraph({
    defines,
    references,
    mentionedIdents: new Set(),
    chatFiles: new Set(),
    allFiles: Array.from(graphFiles),
  })
  const personalization = new Map<string, number>()
  const base = 100 / Math.max(graph.nodes.length, 1)
  for (const n of graph.nodes) personalization.set(n, base)
  const scores = pageRank(graph, personalization, { alpha: DAMPING, max_iter: MAX_ITER, tol: TOL })
  const ranked = rankDefinitions(graph, scores, defTags)
  const cache = persistGraphAsCache(worktree, graph, scores, ranked, sourceManifest, [])
  return cacheToGraphView(cache)
}

export async function maybeRefreshReport(
  worktree: string,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<RefreshResult> {
  const mapDir = resolveMapDir(worktree)
  try {
    mkdirSync(mapDir, { recursive: true })
  } catch {
    /* may already exist */
  }
  if (!acquireReportLock(mapDir)) {
    return { status: "skipped", reportPath: join(mapDir, REPORT_FILE) }
  }
  const signal = opts.signal ?? new AbortController().signal
  try {
    await initializeGraphPlugin(worktree)
    const persistedCache = getWorktreeGraphCache(worktree)
    const currentManifest = currentSourceManifest(worktree)
    const unchanged =
      !!persistedCache && manifestsEqual(persistedCache.worktreeGraph.sourceManifest, currentManifest)
    const reportExists = existsSync(join(mapDir, REPORT_FILE))

    if (!opts.force && unchanged && reportExists && persistedCache) {
      return { status: "skipped", reportPath: join(mapDir, REPORT_FILE) }
    }

    const graph =
      opts.force || !persistedCache || !unchanged
        ? await rebuildGraphForReport(worktree, signal)
        : cacheToGraphView(persistedCache)

    const markdown = generateReport(graph, { worktree })
    const reportPath = writeReportAtomic(mapDir, markdown)
    return {
      status: persistedCache && reportExists ? "rebuilt" : "fresh",
      reportPath,
    }
  } catch (e: any) {
    const msg = e?.message || String(e)
    reportLogLine(mapDir, `FAILED: ${msg}`)
    return { status: "failed", error: msg }
  } finally {
    releaseReportLock(mapDir)
  }
}

export const tools = { ast_grep_map }

const astGrepMapPlugin: Plugin = async (input) => {
  const worktree = resolveRoot(input)
  // Initialize the lifecycle state (lazy once-per-process hydration of the
  // disk cache) so the very first ast_grep_map call does not pay the hydration
  // cost and so scope-snapshot state is available to the invalidation hooks.
  try {
    await initializeGraphPlugin(worktree)
  } catch {
    /* hydration is best-effort; map calls fall back to a rebuild */
  }
  return {
    tool: tools,
    event: async ({ event }) => {
      if (event.type === "session.created") {
        // Fire-and-forget: do NOT await (session start must not block). Same
        // pattern as ast-grep's sg-binary provisioning.
        const handle = setTimeout(() => {
          maybeRefreshReport(worktree).catch(() => {
            /* errors are logged inside maybeRefreshReport */
          })
        }, 0)
        handle.unref()
        return
      }
      // Improvement #1: file edits invalidate scope-keyed rank snapshots so the
      // next ast_grep_map call rebuilds them. Worktree-graph freshness is
      // manifest-driven, so this hook only needs to touch the scope overlays.
      // The event shape is loose (opencode SDK Event typing is permissive) so
      // we narrow defensively.
      if (event.type === "file.edited" || event.type === "file.watcher.updated") {
        const f = (event as { properties?: { file?: unknown } }).properties?.file
        if (typeof f === "string") {
          try {
            await markStaleForPath(worktree, f)
          } catch {
            /* invalidation must never break the event loop */
          }
        }
      }
    },
    "tool.execute.after": async (toolInput, toolOutput) => {
      // Same invalidation trigger when the user edits/writes a file via opencode's
      // own edit/write tools. The metadata shape varies across opencode versions,
      // so we narrow defensively.
      if (toolInput.tool !== "edit" && toolInput.tool !== "write") return
      const meta = (toolOutput as { metadata?: Record<string, unknown> }).metadata ?? {}
      const direct = typeof meta.filepath === "string" ? meta.filepath : null
      const filediff = typeof meta.filediff === "object" && meta.filediff !== null
        ? (meta.filediff as { file?: unknown }).file
        : null
      const f = direct ?? (typeof filediff === "string" ? filediff : null)
      if (f) {
        try {
          await markStaleForPath(worktree, f)
        } catch {
          /* invalidation must never break the post-tool hook */
        }
      }
    },
  }
}

export default astGrepMapPlugin

// Named exports for the test harness.
export {
  extractAllTags,
  buildGraph,
  pageRank,
  rankDefinitions,
  renderTree,
  binarySearchTokenBudget,
  discoverCodeFiles,
  languageForFile,
  resolveExtractScript,
  resolveRoot,
  buildScopeSeeds,
  applyScopedRanking,
  applyScopeScores,
  computeOutWeight,
  DAMPING,
  MAX_ITER,
  TOL,
  type Tag,
  type Graph,
  type GraphEdge,
  type RankedTag,
  type PersistedGraph,
}
