// Re-export seam for the runtime / build plugins.
//
// The runtime imports graph lifecycle helpers from here; future plugin-facing
// utilities (debug introspection, manual refresh hooks) would also live behind
// this module so the public surface stays stable across refactors.

export {
  initializeGraphPlugin,
  shutdownGraphPlugin,
  getWorkspaceGraphState,
  getWorktreeGraphCache,
  markStaleForPath,
  markWorkspaceStale,
  getScopedRankSnapshot,
  persistScopedRankSnapshot,
  setWorktreeGraphCache,
} from "./graph-service.js"

export {
  buildInitialCache,
  captureSourceManifest,
  manifestsEqual,
  readPersistedGraphCache,
  resolveMapDir,
  resolveGraphCachePath,
  serializePersistedCache,
  writePersistedGraphCache,
  rankedSymbolToTag,
  GRAPH_CACHE_VERSION,
  type PersistedCache,
  type PersistedWorktreeGraph,
  type PersistedScopeSnapshot,
  type RankSnapshot,
  type RankedSymbol,
  type SourceManifestEntry,
} from "./graph-store.js"

export {
  buildGraph,
  buildPersonalizationVector,
  getScopeKey,
  isFileInScope,
  isMeaningfulName,
  isSeedPathSymlink,
  isSafeRelativePath,
  matchesScopeGlobs,
  normalizeEffectiveScope,
  normalizeRelativePath,
  normalizeSeedEntries,
  pageRank,
  rankDefinitions,
  type BuildInput,
  type EffectiveScope,
  type Graph,
  type GraphEdge,
  type RankedTag,
  type SeedEntry,
  type Tag,
} from "./graph.js"
