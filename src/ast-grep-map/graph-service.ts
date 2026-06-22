// Lifecycle service for the ast-grep-map graph layer.
//
// Owns the in-memory WorkspaceGraphState (one per worktree) and exposes the
// invalidation API consumed by the plugin hooks (file.edited, file.watcher,
// tool.execute.after edit/write). Hydrates from the disk cache once per
// process; persists explicit per-scope stale flags so a scope-keyed PPR
// snapshot stays cached across processes until invalidated.
//
// Worktree-graph freshness is manifest-driven (mtime+size comparison) — no
// explicit stale flag is needed at that layer. Scope snapshots have explicit
// refreshState.stale because they are derived data without their own manifest.
//
// Adapted from a sibling implementation's graph-service.ts, extended to fit
// this workspace's worktree-plus-scope-overlay cache model.

import { isAbsolute, resolve as pathResolve, relative as pathRelative } from "node:path"
import {
  getScopeKey,
  isFileInScope,
  matchesScopeGlobs,
  normalizeEffectiveScope,
  normalizeRelativePath,
  type EffectiveScope,
  type SeedEntry,
} from "./graph.js"
import {
  readPersistedGraphCache,
  writePersistedGraphCache,
  type PersistedCache,
  type PersistedScopeSnapshot,
} from "./graph-store.js"

// ---------------------------------------------------------------------------
// In-memory workspace state
// ---------------------------------------------------------------------------

type WorkspaceGraphState = {
  initializedAt: string
  hydrationAttempted: boolean
  lastInvalidatedAt?: string
  /** Workspace-relative paths invalidated since the last full rebuild. */
  invalidatedFiles: Set<string>
  /** Decoded cache payload (mutable; we mutate scope.refreshState.stale in place). */
  cache: PersistedCache | null
}

const workspaceGraphStore = new Map<string, WorkspaceGraphState>()

function getOrCreateWorkspaceGraphState(worktree: string): WorkspaceGraphState {
  let state = workspaceGraphStore.get(worktree)
  if (!state) {
    state = {
      initializedAt: new Date().toISOString(),
      hydrationAttempted: false,
      invalidatedFiles: new Set(),
      cache: null,
    }
    workspaceGraphStore.set(worktree, state)
  }
  if (!state.hydrationAttempted) {
    state.hydrationAttempted = true
    state.cache = readPersistedGraphCache(worktree)
  }
  return state
}

// ---------------------------------------------------------------------------
// Public lifecycle API
// ---------------------------------------------------------------------------

export async function initializeGraphPlugin(worktree: string): Promise<void> {
  getOrCreateWorkspaceGraphState(worktree)
}

export async function shutdownGraphPlugin(worktree?: string): Promise<void> {
  if (worktree) {
    workspaceGraphStore.delete(worktree)
    return
  }
  workspaceGraphStore.clear()
}

export function getWorkspaceGraphState(worktree: string): WorkspaceGraphState | undefined {
  return workspaceGraphStore.get(worktree)
}

export function getWorktreeGraphCache(worktree: string): PersistedCache | null {
  return getOrCreateWorkspaceGraphState(worktree).cache
}

// ---------------------------------------------------------------------------
// Invalidation — the core of improvement #1
// ---------------------------------------------------------------------------

// Mark a single file's scope-keyed rank snapshots stale. Cheap: in-memory flip
// + best-effort cache write. The next ast_grep_map call detects stale state
// and rebuilds. Falls back to markWorkspaceStale when the path can't be
// resolved within the workspace or no scope matches.
export async function markStaleForPath(worktree: string, filePath: string | null | undefined): Promise<void> {
  const state = getOrCreateWorkspaceGraphState(worktree)
  if (!filePath) {
    await markWorkspaceStale(worktree)
    return
  }

  let normalizedFile: string
  try {
    const abs = pathResolve(filePath)
    const rel = pathRelative(pathResolve(worktree), abs)
    if (rel === "") {
      normalizedFile = "."
    } else if (rel === ".." || rel.startsWith("..") || isAbsolute(rel)) {
      // Outside the workspace — invalidate everything as a conservative fallback.
      await markWorkspaceStale(worktree)
      return
    } else {
      normalizedFile = normalizeRelativePath(rel)
    }
  } catch {
    await markWorkspaceStale(worktree)
    return
  }

  state.invalidatedFiles.add(normalizedFile)
  state.lastInvalidatedAt = new Date().toISOString()

  // Walk scope snapshots and mark matching ones stale. The workspace graph
  // itself stays fresh-or-stale per the source-manifest check (no explicit
  // flag here).
  if (state.cache) {
    let touched = false
    for (const scope of state.cache.scopes) {
      if (scope.refreshState.stale) continue
      if (isFileInScope(normalizedFile, scope.effectiveScope) && matchesScopeGlobs(normalizedFile, scope.effectiveScope)) {
        scope.refreshState.stale = true
        scope.refreshState.lastInvalidatedAt = state.lastInvalidatedAt
        touched = true
      }
    }
    if (touched) {
      writePersistedGraphCache(worktree, state.cache)
    }
  }
}

export async function markWorkspaceStale(worktree: string): Promise<void> {
  const state = getOrCreateWorkspaceGraphState(worktree)
  const ts = new Date().toISOString()
  state.lastInvalidatedAt = ts
  // Workspace-graph staleness is implied by the manifest check, but we DO
  // invalidate every scope snapshot explicitly because they are derived data.
  if (state.cache) {
    let touched = false
    for (const scope of state.cache.scopes) {
      if (!scope.refreshState.stale) {
        scope.refreshState.stale = true
        scope.refreshState.lastInvalidatedAt = ts
        touched = true
      }
    }
    if (touched) writePersistedGraphCache(worktree, state.cache)
  }
}

// ---------------------------------------------------------------------------
// Scope snapshot management (consumed by Phase 4's PPR + scope-overlay layer)
// ---------------------------------------------------------------------------

export async function getScopedRankSnapshot(
  worktree: string,
  scope: EffectiveScope,
  seedEntries: SeedEntry[],
): Promise<PersistedScopeSnapshot | null> {
  const state = workspaceGraphStore.get(worktree)
  if (!state?.cache) return null
  const normalizedScope = normalizeEffectiveScope(scope)
  const scopeKey = getScopeKey(normalizedScope)
  const snapshot = state.cache.scopes.find((s) => s.scopeKey === scopeKey)
  if (!snapshot || snapshot.refreshState.stale) return null
  // Seed entries affect PPR output; if the seed set changed, the snapshot is stale.
  const snapshotSeedKey = JSON.stringify(snapshot.seedEntries)
  const incomingSeedKey = JSON.stringify(seedEntries)
  if (snapshotSeedKey !== incomingSeedKey) return null
  return snapshot
}

export async function persistScopedRankSnapshot(
  worktree: string,
  scope: EffectiveScope,
  seedEntries: SeedEntry[],
  rankSnapshot: { fileScores: Record<string, number>; scoreSource: "ppr" | "heuristic" },
): Promise<PersistedScopeSnapshot | null> {
  const state = getOrCreateWorkspaceGraphState(worktree)
  if (!state.cache) return null
  const normalizedScope = normalizeEffectiveScope(scope)
  const scopeKey = getScopeKey(normalizedScope)
  const builtAt = new Date().toISOString()
  const newSnapshot: PersistedScopeSnapshot = {
    scopeKey,
    effectiveScope: normalizedScope,
    seedEntries,
    rankSnapshot: { ...rankSnapshot, builtAt },
    refreshState: { stale: false, lastRefreshAt: builtAt },
  }
  const idx = state.cache.scopes.findIndex((s) => s.scopeKey === scopeKey)
  if (idx >= 0) state.cache.scopes[idx] = newSnapshot
  else state.cache.scopes.push(newSnapshot)
  writePersistedGraphCache(worktree, state.cache)
  return newSnapshot
}

// Allow impl.ts to swap in a freshly rebuilt cache (after a full rebuild).
export function setWorktreeGraphCache(worktree: string, cache: PersistedCache): void {
  const state = getOrCreateWorkspaceGraphState(worktree)
  state.cache = cache
  state.invalidatedFiles.clear()
}
