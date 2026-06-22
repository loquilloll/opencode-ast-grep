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
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"

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

const MAP_DIR_ENV = "OP_AST_GREP_MAP_DIR"
const GRAPH_FILE = "graph.json"

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

interface Tag {
  rel_fname: string
  fname: string
  line: number // 0-based start line of the definition
  endLine: number // 0-based end line of the definition (== line for one-liners)
  name: string
  kind: "def" | "ref"
  decl: string // first source line of the definition (signature), truncated
}

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

interface GraphEdge { src: string; dst: string; weight: number; ident: string }
interface Graph {
  nodes: string[]
  edges: GraphEdge[]
  outWeight: Map<string, number>
}

function isMeaningfulName(s: string): boolean {
  const isSnake = s.includes("_") && /[a-z]/i.test(s)
  const isKebab = s.includes("-") && /[a-z]/i.test(s)
  const isCamel = /[a-z]/.test(s) && /[A-Z]/.test(s)
  return (isSnake || isKebab || isCamel) && s.length >= 8
}

interface BuildInput {
  defines: Map<string, Set<string>> // ident -> set of rel fnames that define it
  references: Map<string, string[]> // ident -> list of rel fnames that reference it
  mentionedIdents: Set<string>
  chatFiles: Set<string>
  allFiles: string[]
}

function buildGraph(input: BuildInput): Graph {
  const { defines, references, mentionedIdents, chatFiles, allFiles } = input
  const edges: GraphEdge[] = []
  const outWeight = new Map<string, number>()
  const add = (src: string, dst: string, weight: number, ident: string) => {
    edges.push({ src, dst, weight, ident })
    outWeight.set(src, (outWeight.get(src) ?? 0) + weight)
  }

  // If repo has no references at all, substitute defines as references
  // (aider: `if not references: references = defines`).
  let refs = references
  if (references.size === 0) refs = new Map(Array.from(defines.entries()).map(([k, v]) => [k, Array.from(v)]))

  for (const [ident, definers] of defines) {
    if (definers.size === 0) continue
    let mul = 1.0
    if (mentionedIdents.has(ident)) mul *= 10
    if (isMeaningfulName(ident)) mul *= 10
    if (ident.startsWith("_")) mul *= 0.1
    if (definers.size > 5) mul *= 0.1

    const refList = refs.get(ident) ?? []
    if (refList.length === 0) {
      // definer with no references -> self-edge weight 0.1 (keeps isolated nodes ranked)
      for (const d of definers) add(d, d, 0.1, ident)
      continue
    }
    // Counter(references[ident]) -> num_refs per referencer
    const counts = new Map<string, number>()
    for (const r of refList) counts.set(r, (counts.get(r) ?? 0) + 1)
    for (const [referencer, numRefs] of counts) {
      const baseW = mul * Math.sqrt(numRefs)
      for (const definer of definers) {
        let w = baseW
        if (chatFiles.has(referencer)) w *= 50 // chat-file boost (aider edge-level)
        add(referencer, definer, w, ident)
      }
    }
  }

  return { nodes: allFiles.slice(), edges, outWeight }
}

// ---------------------------------------------------------------------------
// PageRank (networkx power-iteration semantics on a weighted multigraph)
// ---------------------------------------------------------------------------
// Update per node nbr:
//   x[nbr] = (1-a)*p[nbr] + danglesum*p[nbr] + a * Σ_{n: n->nbr} xlast[n]*w(n,nbr)/outW[n]
// where danglesum = a * Σ_{dangling n} xlast[n], convergence when L1 < N*tol.
// (Reference: networkx/algorithms/link_analysis/pagerank_alg.py `pagerank`.)

function pageRank(
  graph: Graph,
  personalization: Map<string, number>,
  opts: { alpha: number; max_iter: number; tol: number },
): Map<string, number> {
  const { alpha, max_iter, tol } = opts
  const nodes = graph.nodes
  const N = nodes.length
  if (N === 0) return new Map()

  // Aggregate parallel edges: src -> (dst -> summed weight).
  const adj = new Map<string, Map<string, number>>()
  for (const e of graph.edges) {
    let inner = adj.get(e.src)
    if (!inner) {
      inner = new Map<string, number>()
      adj.set(e.src, inner)
    }
    inner.set(e.dst, (inner.get(e.dst) ?? 0) + e.weight)
  }
  const outW = graph.outWeight
  const dangling = nodes.filter((n) => !outW.has(n) || (outW.get(n) ?? 0) === 0)

  // Normalize personalization to sum 1 (networkx does this); uniform fallback.
  let pSum = 0
  for (const v of personalization.values()) pSum += v
  const p = new Map<string, number>()
  if (pSum > 0) {
    for (const [k, v] of personalization) p.set(k, v / pSum)
  } else {
    for (const n of nodes) p.set(n, 1 / N)
  }
  // Fill missing nodes with uniform share of remaining mass (best effort).
  for (const n of nodes) if (!p.has(n)) p.set(n, 0)

  let x = new Map<string, number>()
  for (const n of nodes) x.set(n, 1 / N)

  for (let iter = 0; iter < max_iter; iter++) {
    const xlast = x
    x = new Map<string, number>()
    for (const n of nodes) x.set(n, 0)

    let danglesum = 0
    for (const d of dangling) danglesum += xlast.get(d) ?? 0
    danglesum *= alpha

    for (const n of nodes) {
      const xn = xlast.get(n) ?? 0
      const out = adj.get(n)
      if (out) {
        const wsum = outW.get(n) ?? 0
        if (wsum > 0) {
          for (const [nbr, w] of out) {
            x.set(nbr, (x.get(nbr) ?? 0) + alpha * xn * (w / wsum))
          }
        }
      }
      const teleport = (1 - alpha) * (p.get(n) ?? 0) + danglesum * (p.get(n) ?? 0)
      x.set(n, (x.get(n) ?? 0) + teleport)
    }

    let err = 0
    for (const n of nodes) err += Math.abs((x.get(n) ?? 0) - (xlast.get(n) ?? 0))
    if (err < N * tol) break
  }
  return x
}

// ---------------------------------------------------------------------------
// Rank distribution: file PageRank -> (file, ident) buckets -> def tags
// ---------------------------------------------------------------------------

interface RankedTag { tag: Tag; rank: number }

function rankDefinitions(graph: Graph, scores: Map<string, number>, defTags: Tag[]): RankedTag[] {
  const rankedDefs = new Map<string, number>() // "dst\0ident" -> rank
  for (const e of graph.edges) {
    const srcRank = scores.get(e.src) ?? 0
    const total = graph.outWeight.get(e.src) ?? 0
    if (total <= 0) continue
    const key = `${e.dst}\0${e.ident}`
    rankedDefs.set(key, (rankedDefs.get(key) ?? 0) + (srcRank * e.weight) / total)
  }

  // Resolve (dst, ident) -> def tags; pick the entries sorted desc by rank.
  // Build a lookup of (rel_fname, ident) -> def tags.
  const byKey = new Map<string, Tag[]>()
  for (const tag of defTags) {
    const key = `${tag.rel_fname}\0${tag.name}`
    let arr = byKey.get(key)
    if (!arr) {
      arr = []
      byKey.set(key, arr)
    }
    arr.push(tag)
  }

  const entries = Array.from(rankedDefs.entries())
    .map(([key, rank]) => {
      const [dst, ident] = key.split("\u0000")
      return { dst, ident, rank }
    })
    .sort((a, b) => b.rank - a.rank || (a.dst < b.dst ? -1 : 1))

  const out: RankedTag[] = []
  for (const e of entries) {
    const tags = byKey.get(`${e.dst}\0${e.ident}`)
    if (tags) for (const t of tags) out.push({ tag: t, rank: e.rank })
  }
  return out
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
      let st: any
      try {
        st = statSync(full)
      } catch {
        continue
      }
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
// Persistence
// ---------------------------------------------------------------------------

function resolveMapDir(worktree: string): string {
  const override = process.env[MAP_DIR_ENV]
  if (override) return resolve(override)
  const worktreeMapDir = resolve(join(worktree, ".ast-grep"))
  if (canWriteDir(worktreeMapDir)) return worktreeMapDir
  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  const key = createHash("sha256").update(resolve(worktree)).digest("hex").slice(0, 16)
  return resolve(join(cacheRoot, "opencode", "ast-grep-map", key))
}

function canWriteDir(dir: string): boolean {
  const probe = join(dir, `.write-test-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, "")
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

interface PersistedGraph {
  version: number
  worktree: string
  generatedAt: string
  damping: number
  maxIter: number
  tol: number
  nodeCount: number
  edgeCount: number
  nodes: string[]
  edges: GraphEdge[]
  scores: Record<string, number>
  rankedSymbols: Array<{ file: string; ident: string; rank: number; line: number; endLine: number; decl: string }>
  mentionedIdents: string[]
  sourceMtimes: Record<string, number>
}

function persistGraph(
  graph: Graph,
  scores: Map<string, number>,
  ranked: RankedTag[],
  mapDir: string,
  meta: { worktree: string; mentionedIdents: string[]; sourceMtimes: Record<string, number> },
): string {
  try {
    mkdirSync(mapDir, { recursive: true })
  } catch {
    /* ignore */
  }
  const outFile = join(mapDir, GRAPH_FILE)
  const tmp = outFile + ".tmp"
  const payload: PersistedGraph = {
    version: 1,
    worktree: meta.worktree,
    generatedAt: new Date().toISOString(),
    damping: DAMPING,
    maxIter: MAX_ITER,
    tol: TOL,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    nodes: graph.nodes,
    edges: graph.edges,
    scores: Object.fromEntries(scores),
    rankedSymbols: ranked.map((r) => ({ file: r.tag.rel_fname, ident: r.tag.name, rank: r.rank, line: r.tag.line, endLine: r.tag.endLine ?? r.tag.line, decl: r.tag.decl || r.tag.name })),
    mentionedIdents: meta.mentionedIdents,
    sourceMtimes: meta.sourceMtimes,
  }
  writeFileSync(tmp, JSON.stringify(payload))
  try {
    renameSync(tmp, outFile)
  } catch {
    // rename can fail across devices; fall back to direct write.
    writeFileSync(outFile, JSON.stringify(payload))
  }
  return outFile
}

function loadPersisted(mapDir: string): PersistedGraph | null {
  try {
    const raw = readFileSync(join(mapDir, GRAPH_FILE), "utf8")
    return JSON.parse(raw) as PersistedGraph
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

function usableRoot(root: string | undefined): string | null {
  if (!root || root === "/" || root === "\\" || root === sep) return null
  return root
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
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
    const mapDir = resolveMapDir(worktree)

    // 1. Discover all code files (graph set).
    const allFiles = discoverCodeFiles(worktree, args.lang)
    if (allFiles.length === 0) {
      return `No supported code files found under ${worktree}. (Supported: ts, tsx, js, py, go, rs, cpp)`
    }

    // 2. Scope (output map target / personalization focus).
    const scopeFiles = matchScope(allFiles, worktree, args.paths, args.globs)
    const mentionedIdents = new Set(args.mentioned_idents ?? [])

    // 3. mtime snapshot for cache validity + persistence.
    const sourceMtimes: Record<string, number> = {}
    for (const f of allFiles) {
      try {
        sourceMtimes[relative(worktree, f)] = statSync(f).mtimeMs
      } catch {
        /* ignore */
      }
    }

    // 4. Try refresh:"auto" — reuse persisted ranked symbols if nothing changed.
    const persisted = loadPersisted(mapDir)
    if (
      refresh === "auto" &&
      persisted &&
      persisted.sourceMtimes &&
      Object.keys(persisted.sourceMtimes).length === Object.keys(sourceMtimes).length &&
      Object.entries(sourceMtimes).every(([k, v]) => persisted.sourceMtimes[k] === v)
    ) {
      const maxTokens = (args.max_tokens ?? DEFAULT_MAX_TOKENS) * (scopeFiles.size === 0 || (args.paths && args.paths.length) ? 1 : MAP_MUL_NO_FILES)
      const ranked: RankedTag[] = persisted.rankedSymbols.map((r) => ({
        tag: { rel_fname: r.file, fname: r.file, line: r.line, endLine: r.endLine ?? r.line, name: r.ident, kind: "def", decl: r.decl || r.ident },
        rank: r.rank,
      }))
      const tree = binarySearchTokenBudget(ranked, maxTokens)
      if (args.json) return JSON.stringify(persisted, null, 2)
      return formatResult(tree)
    }

    // 5. Extract tags for every file via the node subprocess (one spawn).
    const defTags: Tag[] = []
    const defines = new Map<string, Set<string>>()
    const references = new Map<string, string[]>()
    let allTags: Tag[]
    try {
      allTags = await extractAllTags(worktree, allFiles, ctx.abort)
    } catch (e: any) {
      return `ast-grep-map extraction failed: ${e.message || e}`
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

    // 6. Build graph + personalization.
    const chatFiles = new Set(Array.from(scopeFiles).map((f) => relative(worktree, f)))
    const graph = buildGraph({ defines, references, mentionedIdents, chatFiles, allFiles: Array.from(graphFiles) })

    const personalization = new Map<string, number>()
    const base = 100 / Math.max(graph.nodes.length, 1)
    for (const n of graph.nodes) personalization.set(n, base)
    for (const c of chatFiles) if (personalization.has(c)) personalization.set(c, (personalization.get(c) ?? 0) + base)
    for (const ident of mentionedIdents) {
      // path-component match heuristic: files whose path components include the ident
      for (const n of graph.nodes) {
        if (n.split(sep).includes(ident) || n.toLowerCase().includes(ident.toLowerCase())) {
          personalization.set(n, (personalization.get(n) ?? 0) + base)
        }
      }
    }

    // 7. PageRank + rank distribution.
    const scores = pageRank(graph, personalization, { alpha: DAMPING, max_iter: MAX_ITER, tol: TOL })
    const ranked = rankDefinitions(graph, scores, defTags)

    // 8. Persist.
    const outFile = persistGraph(graph, scores, ranked, mapDir, { worktree, mentionedIdents: Array.from(mentionedIdents), sourceMtimes })
    if (args.json) {
      const fresh = loadPersisted(mapDir)
      return fresh ? JSON.stringify(fresh, null, 2) : `(failed to read back ${outFile})`
    }

    // 9. Render to token budget.
    const scopeGiven = !!(args.paths && args.paths.length) || !!(args.globs && args.globs.length)
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

function currentSourceMtimes(worktree: string): Record<string, number> {
  const out: Record<string, number> = {}
  const files = discoverCodeFiles(worktree)
  for (const f of files) {
    try {
      out[relative(worktree, f)] = statSync(f).mtimeMs
    } catch {
      /* ignore */
    }
  }
  return out
}

function mtimesUnchanged(persisted: PersistedGraph | null, current: Record<string, number>): boolean {
  if (!persisted || !persisted.sourceMtimes) return false
  const p = persisted.sourceMtimes
  if (Object.keys(p).length !== Object.keys(current).length) return false
  for (const k of Object.keys(current)) if (p[k] !== current[k]) return false
  return true
}

// Mirrors the ast_grep_map tool's execute path with no scope focus: whole-repo
// graph, uniform personalization, default ranking.
async function rebuildGraphForReport(worktree: string, signal: AbortSignal): Promise<PersistedGraph> {
  const allFiles = discoverCodeFiles(worktree)
  if (allFiles.length === 0) throw new Error(`no supported code files under ${worktree}`)
  const sourceMtimes: Record<string, number> = {}
  for (const f of allFiles) {
    try {
      sourceMtimes[relative(worktree, f)] = statSync(f).mtimeMs
    } catch {
      /* ignore */
    }
  }
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
  const mapDir = resolveMapDir(worktree)
  persistGraph(graph, scores, ranked, mapDir, {
    worktree,
    mentionedIdents: [],
    sourceMtimes,
  })
  const fresh = loadPersisted(mapDir)
  if (!fresh) throw new Error("failed to read back persisted graph after rebuild")
  return fresh
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
    const persisted = loadPersisted(mapDir)
    const current = currentSourceMtimes(worktree)
    const unchanged = mtimesUnchanged(persisted, current)
    const reportExists = existsSync(join(mapDir, REPORT_FILE))

    if (!opts.force && unchanged && reportExists && persisted) {
      return { status: "skipped", reportPath: join(mapDir, REPORT_FILE) }
    }

    const graph = opts.force || !persisted || !unchanged
      ? await rebuildGraphForReport(worktree, signal)
      : persisted

    const markdown = generateReport(graph, { worktree })
    const reportPath = writeReportAtomic(mapDir, markdown)
    return {
      status: persisted && reportExists ? "rebuilt" : "fresh",
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
  return {
    tool: tools,
    event: async ({ event }) => {
      if (event.type !== "session.created") return
      // Fire-and-forget: do NOT await (session start must not block). Same
      // pattern as ast-grep's sg-binary provisioning.
      const worktree = resolveRoot(input)
      const handle = setTimeout(() => {
        maybeRefreshReport(worktree).catch(() => {
          /* errors are logged inside maybeRefreshReport */
        })
      }, 0)
      handle.unref()
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
  resolveMapDir,
  resolveRoot,
  loadPersisted,
  persistGraph,
  DAMPING,
  MAX_ITER,
  TOL,
  type Tag,
  type Graph,
  type GraphEdge,
  type RankedTag,
  type PersistedGraph,
}
