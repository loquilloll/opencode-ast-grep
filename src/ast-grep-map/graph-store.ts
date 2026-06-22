// Disk cache for the ast-grep-map graph layer.
//
// Schema (v2, breaking bump from v1): one primary worktree graph (drives
// REPORT.md and unscoped map calls) plus a list of scope-keyed PPR rank
// snapshots layered on top. Source manifest (file+mtime+size) gates hydration;
// tampered/unknown-version payloads are rejected. Atomic writes via temp+rename.
//
// Adapted from a sibling implementation's graph-store.ts (versioned schema +
// atomic writes + manifest validation), extended with the worktree-plus-scope
// overlay model used by this workspace.

import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
  isSafeRelativePath,
  normalizeRelativePath,
  normalizeEffectiveScope,
  type EffectiveScope,
  type GraphEdge,
  type RankedTag,
  type SeedEntry,
  type Tag,
} from "./graph.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GRAPH_CACHE_VERSION = 2
const GRAPH_CACHE_DIRNAME = ".ast-grep"
const GRAPH_CACHE_FILENAME = "graph.json"
const MAP_DIR_ENV = "OP_AST_GREP_MAP_DIR"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceManifestEntry = {
  file: string
  mtimeMs: number
  size: number
}

export type RankedSymbol = {
  file: string
  ident: string
  rank: number
  line: number
  endLine: number
  decl: string
}

export type PersistedWorktreeGraph = {
  builtAt: string
  sourceManifest: SourceManifestEntry[]
  graph: { nodes: string[]; edges: GraphEdge[] }
  scores: Record<string, number>
  rankedSymbols: RankedSymbol[]
  mentionedIdents: string[]
}

export type RankSnapshot = {
  fileScores: Record<string, number>
  scoreSource: "ppr" | "heuristic"
  builtAt: string
}

export type PersistedScopeSnapshot = {
  scopeKey: string
  effectiveScope: EffectiveScope
  seedEntries: SeedEntry[]
  rankSnapshot: RankSnapshot
  refreshState: {
    stale: boolean
    lastInvalidatedAt?: string
    lastRefreshAt?: string
  }
}

export type PersistedCache = {
  version: typeof GRAPH_CACHE_VERSION
  updatedAt: string
  worktree: string
  worktreeGraph: PersistedWorktreeGraph
  scopes: PersistedScopeSnapshot[]
  nextEpoch: number
}

// Internal shape used by validators before normalization. Accepts partial
// inputs; bad data is filtered out rather than throwing.
type PersistedCacheV2Input = Partial<PersistedCache> & { version?: unknown }

// ---------------------------------------------------------------------------
// Map dir resolution (ported from impl.ts — env override + worktree + cache root)
// ---------------------------------------------------------------------------

function canWriteDir(dir: string): boolean {
  const probe = join(dir, `.write-test-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, "")
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

export function resolveMapDir(worktree: string): string {
  const override = process.env[MAP_DIR_ENV]?.trim()
  if (override) return resolve(override)
  const worktreeMapDir = resolve(join(worktree, GRAPH_CACHE_DIRNAME))
  if (canWriteDir(worktreeMapDir)) return worktreeMapDir
  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  const key = createHash("sha256").update(resolve(worktree)).digest("hex").slice(0, 16)
  return resolve(join(cacheRoot, "opencode", "ast-grep-map", key))
}

export function resolveGraphCachePath(worktree: string): string {
  return join(resolveMapDir(worktree), GRAPH_CACHE_FILENAME)
}

// ---------------------------------------------------------------------------
// Manifest capture + comparison
// ---------------------------------------------------------------------------

// Stat each workspace-relative file; skip symlinks (Phase 5 hardens this fully
// but lstatSync here already dodges symlink follow-through). Returns null on
// any stat failure so callers can fall back to a full rebuild.
export function captureSourceManifest(worktree: string, files: string[]): SourceManifestEntry[] | null {
  const manifest: SourceManifestEntry[] = []
  const sorted = [...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const file of sorted) {
    const abs = join(worktree, file)
    try {
      const st = lstatSync(abs)
      if (st.isSymbolicLink() || !st.isFile()) return null
      manifest.push({ file, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      return null
    }
  }
  return manifest
}

export function manifestsEqual(a: SourceManifestEntry[], b: SourceManifestEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, i) => entry.file === b[i]?.file && entry.mtimeMs === b[i]?.mtimeMs && entry.size === b[i]?.size)
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

function normalizeFileEdge(edge: unknown): GraphEdge | null {
  if (!edge || typeof edge !== "object") return null
  const e = edge as Partial<GraphEdge> & { src?: unknown; dst?: unknown; weight?: unknown; ident?: unknown }
  if (typeof e.src !== "string" || typeof e.dst !== "string" || typeof e.ident !== "string") return null
  // idents flow into a `\u0000`-joined key in rankDefinitions; reject NUL to
  // prevent key-collision attacks via a crafted cache.
  if (e.ident.includes("\0")) return null
  if (typeof e.weight !== "number" || !Number.isFinite(e.weight) || e.weight <= 0) return null
  const src = normalizeRelativePath(e.src)
  const dst = normalizeRelativePath(e.dst)
  if (!isSafeRelativePath(src) || !isSafeRelativePath(dst)) return null
  return { src, dst, weight: e.weight, ident: e.ident }
}

function normalizeSourceManifestEntry(entry: unknown): SourceManifestEntry | null {
  if (!entry || typeof entry !== "object") return null
  const e = entry as Partial<SourceManifestEntry>
  if (typeof e.file !== "string" || typeof e.mtimeMs !== "number" || typeof e.size !== "number") return null
  const file = normalizeRelativePath(e.file)
  if (!isSafeRelativePath(file) || e.mtimeMs < 0 || e.size < 0 || !Number.isFinite(e.mtimeMs) || !Number.isFinite(e.size)) return null
  return { file, mtimeMs: e.mtimeMs, size: e.size }
}

function normalizeRankedSymbol(input: unknown): RankedSymbol | null {
  if (!input || typeof input !== "object") return null
  const r = input as Partial<RankedSymbol>
  if (
    typeof r.file !== "string" ||
    typeof r.ident !== "string" ||
    typeof r.rank !== "number" ||
    typeof r.line !== "number" ||
    typeof r.endLine !== "number" ||
    typeof r.decl !== "string"
  ) {
    return null
  }
  // Reject NUL in ident (rankDefinitions uses \u0000 as a key separator).
  if (r.ident.includes("\0")) return null
  const file = normalizeRelativePath(r.file)
  if (!isSafeRelativePath(file) || !Number.isFinite(r.rank) || r.line < 0 || r.endLine < 0) return null
  return { file, ident: r.ident, rank: r.rank, line: r.line, endLine: r.endLine, decl: r.decl }
}

function normalizeSeedEntry(input: unknown): SeedEntry | null {
  if (!input || typeof input !== "object") return null
  const e = input as Partial<SeedEntry> & { file?: unknown; weight?: unknown; source?: unknown }
  if (typeof e.file !== "string" || typeof e.weight !== "number" || typeof e.source !== "string") return null
  const file = normalizeRelativePath(e.file)
  if (!isSafeRelativePath(file) || !Number.isFinite(e.weight) || e.weight <= 0) return null
  return { file, weight: e.weight, source: e.source }
}

function normalizeEffectiveScopeInput(input: unknown): EffectiveScope | null {
  if (!input || typeof input !== "object") return null
  const s = input as Partial<EffectiveScope> & { paths?: unknown; globs?: unknown }
  if (!Array.isArray(s.paths) || !Array.isArray(s.globs)) return null
  if (!s.paths.every((p) => typeof p === "string") || !s.globs.every((g) => typeof g === "string")) return null
  return normalizeEffectiveScope({ paths: s.paths, globs: s.globs })
}

function normalizeWorktreeGraph(input: unknown): PersistedWorktreeGraph | null {
  if (!input || typeof input !== "object") return null
  const g = input as Partial<PersistedWorktreeGraph>
  if (typeof g.builtAt !== "string" || g.builtAt === "") return null
  if (!Array.isArray(g.sourceManifest) || !Array.isArray(g.rankedSymbols) || !Array.isArray(g.mentionedIdents)) return null
  if (!g.graph || !Array.isArray(g.graph.nodes) || !Array.isArray(g.graph.edges)) return null
  if (!g.scores || typeof g.scores !== "object") return null

  const sourceManifest = g.sourceManifest.map(normalizeSourceManifestEntry).filter((x): x is SourceManifestEntry => x !== null)
  const rankedSymbols = g.rankedSymbols.map(normalizeRankedSymbol).filter((x): x is RankedSymbol => x !== null)
  const mentionedIdents = g.mentionedIdents.filter((x): x is string => typeof x === "string")
  const nodes = [...new Set(g.graph.nodes.map((n) => normalizeRelativePath(String(n))))].filter(isSafeRelativePath).sort()
  const nodeSet = new Set(nodes)
  const edges = g.graph.edges
    .map(normalizeFileEdge)
    .filter((x): x is GraphEdge => x !== null)
    .filter((e) => nodeSet.has(e.src) && nodeSet.has(e.dst))
  const scores: Record<string, number> = {}
  for (const [k, v] of Object.entries(g.scores)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue
    const normalized = normalizeRelativePath(k)
    if (!isSafeRelativePath(normalized)) continue
    scores[normalized] = v
  }

  return {
    builtAt: g.builtAt,
    sourceManifest,
    graph: { nodes, edges },
    scores,
    rankedSymbols,
    mentionedIdents,
  }
}

function normalizeScopeSnapshot(input: unknown): PersistedScopeSnapshot | null {
  if (!input || typeof input !== "object") return null
  const s = input as Partial<PersistedScopeSnapshot>
  if (typeof s.scopeKey !== "string" || s.scopeKey === "") return null
  const effectiveScope = normalizeEffectiveScopeInput(s.effectiveScope)
  if (!effectiveScope) return null
  if (!s.rankSnapshot || typeof s.rankSnapshot !== "object") return null
  const rs = s.rankSnapshot as Partial<RankSnapshot>
  if (
    typeof rs.builtAt !== "string" ||
    rs.builtAt === "" ||
    (rs.scoreSource !== "ppr" && rs.scoreSource !== "heuristic") ||
    !rs.fileScores ||
    typeof rs.fileScores !== "object"
  ) {
    return null
  }
  if (!s.refreshState || typeof s.refreshState !== "object") return null
  const rf = s.refreshState as Partial<PersistedScopeSnapshot["refreshState"]>
  if (typeof rf.stale !== "boolean") return null
  if (!Array.isArray(s.seedEntries)) return null
  const seedEntries = s.seedEntries.map(normalizeSeedEntry).filter((x): x is SeedEntry => x !== null)

  const fileScores: Record<string, number> = {}
  for (const [k, v] of Object.entries(rs.fileScores)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue
    const normalized = normalizeRelativePath(k)
    if (!isSafeRelativePath(normalized)) continue
    fileScores[normalized] = v
  }

  return {
    scopeKey: s.scopeKey,
    effectiveScope,
    seedEntries,
    rankSnapshot: { fileScores, scoreSource: rs.scoreSource, builtAt: rs.builtAt },
    refreshState: {
      stale: rf.stale,
      lastInvalidatedAt: typeof rf.lastInvalidatedAt === "string" ? rf.lastInvalidatedAt : undefined,
      lastRefreshAt: typeof rf.lastRefreshAt === "string" ? rf.lastRefreshAt : undefined,
    },
  }
}

export function validatePersistedCache(input: unknown): PersistedCache | null {
  if (!input || typeof input !== "object") return null
  const raw = input as PersistedCacheV2Input
  if (raw.version !== GRAPH_CACHE_VERSION) return null
  if (typeof raw.updatedAt !== "string" || typeof raw.worktree !== "string") return null
  if (!Number.isInteger(raw.nextEpoch) || (raw.nextEpoch ?? 0) < 0) return null
  if (!Array.isArray(raw.scopes)) return null
  const worktreeGraph = normalizeWorktreeGraph(raw.worktreeGraph)
  if (!worktreeGraph) return null
  const seenScopeKeys = new Set<string>()
  const scopes: PersistedScopeSnapshot[] = []
  for (const s of raw.scopes) {
    const normalized = normalizeScopeSnapshot(s)
    if (!normalized || seenScopeKeys.has(normalized.scopeKey)) continue
    seenScopeKeys.add(normalized.scopeKey)
    scopes.push(normalized)
  }
  return {
    version: GRAPH_CACHE_VERSION,
    updatedAt: raw.updatedAt,
    worktree: raw.worktree,
    worktreeGraph,
    scopes,
    nextEpoch: raw.nextEpoch ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Serialization + atomic write
// ---------------------------------------------------------------------------

export function serializePersistedCache(cache: PersistedCache): string {
  // Stable key ordering for byte-stable output across runs.
  const payload = {
    version: cache.version,
    updatedAt: cache.updatedAt,
    worktree: cache.worktree,
    worktreeGraph: cache.worktreeGraph,
    scopes: [...cache.scopes].sort((a, b) => (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0)),
    nextEpoch: cache.nextEpoch,
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

export function writePersistedGraphCache(worktree: string, cache: PersistedCache): boolean {
  const cacheDir = resolveMapDir(worktree)
  const cachePath = join(cacheDir, GRAPH_CACHE_FILENAME)
  const tempPath = join(
    cacheDir,
    `${GRAPH_CACHE_FILENAME}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  )
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(tempPath, serializePersistedCache(cache), "utf8")
    renameSync(tempPath, cachePath)
    return true
  } catch {
    try {
      unlinkSync(tempPath)
    } catch {
      /* best-effort cleanup */
    }
    return false
  }
}

export function readPersistedGraphCache(worktree: string): PersistedCache | null {
  let raw: string
  try {
    raw = readFileSync(resolveGraphCachePath(worktree), "utf8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  // One-time migration hint: a v1 cache is now unreadable (breaking schema
  // bump). The first call after upgrade will rebuild from scratch; emit a
  // stderr hint so the brief latency is not a mystery.
  if (parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 1) {
    try {
      console.error(
        `[opencode-ast-grep] .ast-grep/graph.json is v1; ignoring and rebuilding as v2. ` +
          `Delete the file or run ast_grep_map with refresh:"always" to silence this.`,
      )
    } catch {
      /* console.error itself can throw in rare runtimes; ignore */
    }
  }
  return validatePersistedCache(parsed)
}

// ---------------------------------------------------------------------------
// Helpers for constructing fresh caches from runtime data
// ---------------------------------------------------------------------------

export function buildInitialCache(
  worktree: string,
  graph: { nodes: string[]; edges: GraphEdge[] },
  scores: Map<string, number>,
  ranked: RankedTag[],
  sourceManifest: SourceManifestEntry[],
  mentionedIdents: string[],
  builtAt: string = new Date().toISOString(),
): PersistedCache {
  return {
    version: GRAPH_CACHE_VERSION,
    updatedAt: builtAt,
    worktree,
    worktreeGraph: {
      builtAt,
      sourceManifest,
      graph,
      scores: Object.fromEntries(scores),
      rankedSymbols: ranked.map((r) => ({
        file: r.tag.rel_fname,
        ident: r.tag.name,
        rank: r.rank,
        line: r.tag.line,
        endLine: r.tag.endLine ?? r.tag.line,
        decl: r.tag.decl || r.tag.name,
      })),
      mentionedIdents,
    },
    scopes: [],
    nextEpoch: 0,
  }
}

// Convert a rankedSymbols entry back to a Tag-shaped object for the renderer.
// Used by the auto-refresh path that reuses a cache hit without re-extracting.
export function rankedSymbolToTag(r: RankedSymbol): Tag {
  return {
    rel_fname: r.file,
    fname: r.file,
    line: r.line,
    endLine: r.endLine,
    name: r.ident,
    kind: "def",
    decl: r.decl || r.ident,
  }
}
