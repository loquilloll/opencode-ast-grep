// Pure types + functions for the ast-grep-map graph layer.
//
// No I/O, no side effects, no node: imports beyond path utilities. This module
// is the seam between extraction (extract.mjs → Tag[]) / ranking (PageRank) /
// rendering (impl.ts). The lifecycle layer (graph-service.ts) and disk cache
// (graph-store.ts) consume these pure functions.
//
// Adapted from a sibling implementation's graph.ts (Personalized PageRank +
// seed/scope/symlink helpers), ported to this workspace's multi-language
// tree-sitter pipeline.

import { lstatSync } from "node:fs"
import { resolve as pathResolve, sep as pathSep } from "node:path"

// ---------------------------------------------------------------------------
// Tag (extraction output shape — produced by extract.mjs, consumed by graph)
// ---------------------------------------------------------------------------

export interface Tag {
  rel_fname: string
  fname: string
  line: number // 0-based start line of the definition
  endLine: number // 0-based end line of the definition (== line for one-liners)
  name: string
  kind: "def" | "ref"
  decl: string // first source line of the definition (signature), truncated
}

// ---------------------------------------------------------------------------
// Graph (aider MultiDiGraph: nodes=files, edges=referencer->definer per ident)
// ---------------------------------------------------------------------------

export interface GraphEdge {
  src: string
  dst: string
  weight: number
  ident: string
}

export interface Graph {
  nodes: string[]
  edges: GraphEdge[]
  outWeight: Map<string, number>
}

export interface BuildInput {
  defines: Map<string, Set<string>> // ident -> set of rel fnames that define it
  references: Map<string, string[]> // ident -> list of rel fnames that reference it
  mentionedIdents: Set<string>
  chatFiles: Set<string>
  allFiles: string[]
}

export function isMeaningfulName(s: string): boolean {
  const isSnake = s.includes("_") && /[a-z]/i.test(s)
  const isKebab = s.includes("-") && /[a-z]/i.test(s)
  const isCamel = /[a-z]/.test(s) && /[A-Z]/.test(s)
  return (isSnake || isKebab || isCamel) && s.length >= 8
}

export function buildGraph(input: BuildInput): Graph {
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

export function pageRank(
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

export interface RankedTag {
  tag: Tag
  rank: number
}

export function rankDefinitions(graph: Graph, scores: Map<string, number>, defTags: Tag[]): RankedTag[] {
  const rankedDefs = new Map<string, number>() // "dst\0ident" -> rank
  for (const e of graph.edges) {
    const srcRank = scores.get(e.src) ?? 0
    const total = graph.outWeight.get(e.src) ?? 0
    if (total <= 0) continue
    const key = `${e.dst}\u0000${e.ident}`
    rankedDefs.set(key, (rankedDefs.get(key) ?? 0) + (srcRank * e.weight) / total)
  }

  // Resolve (dst, ident) -> def tags; pick the entries sorted desc by rank.
  // Build a lookup of (rel_fname, ident) -> def tags.
  const byKey = new Map<string, Tag[]>()
  for (const tag of defTags) {
    const key = `${tag.rel_fname}\u0000${tag.name}`
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
    const tags = byKey.get(`${e.dst}\u0000${e.ident}`)
    if (tags) for (const t of tags) out.push({ tag: t, rank: e.rank })
  }
  return out
}

// ---------------------------------------------------------------------------
// EffectiveScope (paths + globs) — scope-keyed snapshot identity
// ---------------------------------------------------------------------------

export interface EffectiveScope {
  paths: string[]
  globs: string[]
}

// Normalize to POSIX separators + sort components for stable scope keys.
// Scope paths/globs arrive workspace-relative from the runtime; we keep them
// POSIX-formatted on the wire so cache files are cross-platform.
export function normalizeRelativePath(file: string): string {
  const normalized = file.replace(/\\/g, "/")
  const parts: string[] = []
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join("/")
}

export function isSafeRelativePath(file: string): boolean {
  return (
    file !== "" &&
    !file.includes("\0") &&
    !file.includes("\\") &&
    !file.startsWith("//") &&
    !/^[A-Za-z]:/.test(file) &&
    normalizeRelativePath(file) === file
  )
}

export function normalizeEffectiveScope(scope: EffectiveScope): EffectiveScope {
  return {
    paths: [...scope.paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    globs: [...scope.globs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  }
}

export function getScopeKey(scope: EffectiveScope): string {
  const n = normalizeEffectiveScope(scope)
  return JSON.stringify({ paths: n.paths, globs: n.globs })
}

export function isFileInScope(file: string, scope: EffectiveScope): boolean {
  const normalized = normalizeRelativePath(file)
  if (scope.paths.length === 0) return true
  return scope.paths.some((scopePath) => {
    const sp = normalizeRelativePath(scopePath)
    if (sp === "" || sp === ".") return true
    return normalized === sp || normalized.startsWith(`${sp}/`)
  })
}

export function matchesScopeGlobs(file: string, scope: EffectiveScope): boolean {
  if (scope.globs.length === 0) return true
  const includeGlobs = scope.globs.filter((g) => !g.startsWith("!"))
  const excludeGlobs = scope.globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1))
  const normalizedFile = normalizeRelativePath(file)

  const wildcardToRegex = (glob: string): RegExp => {
    const normalizedGlob = glob.replace(/\\/g, "/")
    const escaped = normalizedGlob.replace(/[.*+^${}()|[\]\\]/g, "\\$&")
    const withDoubleStar = escaped.replace(/\\\*\\\*/g, "::DOUBLE_STAR::")
    const withSingleStar = withDoubleStar.replace(/\\\*/g, "[^/]*")
    const finalPattern = withSingleStar.replace(/::DOUBLE_STAR::/g, ".*")
    return new RegExp(`^${finalPattern}$`)
  }

  if (includeGlobs.length > 0 && !includeGlobs.some((g) => wildcardToRegex(g).test(normalizedFile))) {
    return false
  }
  if (excludeGlobs.some((g) => wildcardToRegex(g).test(normalizedFile))) {
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Seeds (for Personalized PageRank — Phase 4 wires these into the runtime)
// ---------------------------------------------------------------------------

export interface SeedEntry {
  file: string
  weight: number
  source: string
}

// Walk `file` segment-by-segment from the workspace root and return true if any
// segment is a symlink. `file` is workspace-relative; resolution is anchored at
// `workspaceRoot` (NOT cwd — this was a bug in the upstream port source that we
// fix here: a relative seed must be resolved against workspaceRoot, otherwise
// seeds evade symlink pruning when cwd !== workspaceRoot).
//
// Windows note: a leading drive-letter segment (e.g. "C:") would cause
// `lstatSync("C:")` to stat the current directory on drive C: rather than the
// drive root, producing a false positive if that cwd is a junction. We detect
// the drive-letter pattern and rejoin it with the next segment before stat'ing
// so the very first probe is the actual drive root.
export function isSeedPathSymlink(file: string, workspaceRoot?: string): boolean {
  const normalized = workspaceRoot
    ? pathResolve(workspaceRoot, file).replace(/\\/g, "/")
    : file.replace(/\\/g, "/")
  const parts = normalized.split("/").filter(Boolean)

  // Coalesce a leading drive-letter segment with the next segment so we never
  // stat a bare "C:" — that resolves to the cwd on the drive, not the root.
  const probed: string[] = []
  if (parts.length > 1 && /^[A-Za-z]:$/.test(parts[0])) {
    probed.push(`${parts[0]}/${parts[1]}`)
    for (let i = 2; i < parts.length; i++) probed.push(parts[i])
  } else {
    probed.push(...parts)
  }

  let currentPath = normalized.startsWith("/") ? "/" : ""
  for (const part of probed) {
    currentPath = currentPath === "/" ? `/${part}` : currentPath ? `${currentPath}/${part}` : part
    try {
      if (lstatSync(currentPath).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

export function normalizeSeedEntries(
  seedEntries: SeedEntry[],
  scope: EffectiveScope,
  workspaceRoot?: string,
): SeedEntry[] {
  const sorted = [...seedEntries].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
    if (a.weight !== b.weight) return b.weight - a.weight
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0
  })
  const accepted = new Map<string, SeedEntry>()
  for (const entry of sorted) {
    const f = normalizeRelativePath(entry.file)
    if (!isFileInScope(f, scope) || !matchesScopeGlobs(f, scope) || isSeedPathSymlink(f, workspaceRoot)) continue
    const prev = accepted.get(f)
    if (!prev || entry.weight > prev.weight || (entry.weight === prev.weight && entry.source < prev.source)) {
      accepted.set(f, { ...entry, file: f })
    }
  }
  return [...accepted.values()].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
    if (a.weight !== b.weight) return b.weight - a.weight
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0
  })
}

// Build a personalization vector (sums to 1) from seed entries over the given
// file set. Returns null if no valid seeds land on `files`.
export function buildPersonalizationVector(files: string[], seedEntries: SeedEntry[]): Record<string, number> | null {
  const canonical = [...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (canonical.length === 0) return null

  const validFiles = new Set(canonical)
  const seedWeights = new Map<string, number>()
  let totalWeight = 0
  for (const entry of seedEntries) {
    if (!validFiles.has(entry.file) || !Number.isFinite(entry.weight) || entry.weight <= 0) continue
    seedWeights.set(entry.file, (seedWeights.get(entry.file) ?? 0) + entry.weight)
    totalWeight += entry.weight
  }
  if (totalWeight <= 0) return null

  const vector: Record<string, number> = {}
  for (const f of canonical) vector[f] = (seedWeights.get(f) ?? 0) / totalWeight
  return vector
}

// ---------------------------------------------------------------------------
// Personalized PageRank (file-seeded)
// ---------------------------------------------------------------------------
//
// Equivalent math to `pageRank` above — same networkx power-iteration — but
// takes `SeedEntry[]` and resolves them to a personalization vector over the
// graph's nodes. Falls back to uniform personalization when seeds don't land
// on any node (preserves unscoped-query behavior).

export type PersonalizedPageRankOptions = {
  damping?: number
  maxIterations?: number
  tolerance?: number
}

const DEFAULT_PPR_DAMPING = 0.85
const DEFAULT_PPR_MAX_ITERATIONS = 100
const DEFAULT_PPR_TOLERANCE = 1e-6

function normalizePprOptions(opts: PersonalizedPageRankOptions | undefined): Required<PersonalizedPageRankOptions> {
  return {
    damping:
      typeof opts?.damping === "number" && opts.damping > 0 && opts.damping < 1
        ? opts.damping
        : DEFAULT_PPR_DAMPING,
    maxIterations:
      Number.isInteger(opts?.maxIterations) && (opts?.maxIterations ?? 0) > 0
        ? (opts?.maxIterations as number)
        : DEFAULT_PPR_MAX_ITERATIONS,
    tolerance:
      typeof opts?.tolerance === "number" && Number.isFinite(opts.tolerance) && opts.tolerance > 0
        ? opts.tolerance
        : DEFAULT_PPR_TOLERANCE,
  }
}

export function runPersonalizedPageRank(
  graph: Graph,
  seedEntries: SeedEntry[],
  opts?: PersonalizedPageRankOptions,
): Map<string, number> {
  const { damping: alpha, maxIterations: max_iter, tolerance: tol } = normalizePprOptions(opts)
  const nodes = graph.nodes
  const N = nodes.length
  if (N === 0) return new Map()

  const personalizationRecord = buildPersonalizationVector(nodes, seedEntries)
  const personalization = new Map<string, number>()
  if (personalizationRecord) {
    for (const [k, v] of Object.entries(personalizationRecord)) personalization.set(k, v)
  }
  // Delegates to the existing pageRank implementation, which already handles
  // uniform-fallback when personalization is empty and dangling-mass correctly.
  return pageRank(graph, personalization, { alpha, max_iter, tol })
}

// Derive a rank snapshot (fileScores) from a graph + seeds with a heuristic
// fallback ladder: PPR → uniform-personalization → empty. The heuristic is
// inbound×100 + outbound weights per file.
export function deriveScopedFileScores(
  graph: Graph,
  seedEntries: SeedEntry[],
  opts?: PersonalizedPageRankOptions,
): { fileScores: Record<string, number>; scoreSource: "ppr" | "heuristic" } {
  if (seedEntries.length > 0) {
    const pprScores = runPersonalizedPageRank(graph, seedEntries, opts)
    if (pprScores.size > 0) {
      // Verify seeds actually landed on nodes (PPR can return uniform if not).
      const seededNodes = new Set(seedEntries.map((s) => s.file))
      const anySeedHasScore = [...pprScores.keys()].some((k) => seededNodes.has(k))
      if (anySeedHasScore) {
        return { fileScores: Object.fromEntries(pprScores), scoreSource: "ppr" }
      }
    }
  }
  // Heuristic fallback: inbound×100 + outbound weight.
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const n of graph.nodes) {
    incoming.set(n, 0)
    outgoing.set(n, 0)
  }
  for (const e of graph.edges) {
    incoming.set(e.dst, (incoming.get(e.dst) ?? 0) + e.weight)
    outgoing.set(e.src, (outgoing.get(e.src) ?? 0) + e.weight)
  }
  const fileScores: Record<string, number> = {}
  for (const n of graph.nodes) fileScores[n] = (incoming.get(n) ?? 0) * 100 + (outgoing.get(n) ?? 0)
  return { fileScores, scoreSource: "heuristic" }
}

// Backwards-compat export so callers using OS-separator paths can opt in.
// Prefer normalizeRelativePath / isFileInScope / matchesScopeGlobs for new code.
export { pathSep as PATH_SEP }
