# AGENTS.md

Guidance for AI agents working in this repo.

## What this is

An opencode plugin package providing five AST tools:

- `ast_grep_search` / `ast_grep_replace` / `ast_grep_scan` / `ast_grep_validate` — wrap the `sg` (ast-grep) binary.
- `ast_grep_map` — an aider-style repo map ranked by PageRank (tree-sitter based; no `sg`).

Also ships the `ast-grep` **skill** (agent docs) under `.opencode/skills/ast-grep/`.

## Layout

```
src/                       all TypeScript source
  plugin.ts                composed opencode plugin entry (chains both plugins' hooks)
  index.ts                 package entry (re-exports plugin)
  ast-grep/impl.ts         search/replace/scan/validate + sg binary provisioning
                           (byte-capped subprocess output + JSON bracket-repair)
  ast-grep-map/impl.ts     map tool: extraction subprocess + rendering + REPORT.md
  ast-grep-map/graph.ts    pure types + PageRank + PPR + scope/symlink helpers
  ast-grep-map/graph-store.ts   versioned disk cache (v2 schema, mtime+size manifest)
  ast-grep-map/graph-service.ts in-memory lifecycle + invalidation API + scope snapshots
  ast-grep-map/graph-plugin.ts  re-export seam for runtime/build consumers
  ast-grep-map/extract.mjs tree-sitter tag extractor (runs as a node subprocess)
  ast-grep-map/queries/    vendored aider -tags.scm query files
  skills/ast-grep/         the skill (SKILL.md + references + helper script)
test/                      test suites (run with tsx)
  ast-grep/                smoke + truncation suites
  ast-grep-map/            smoke + report + graph-store + graph-lifecycle + ppr
                           + ppr-wiring + cache-hit-scoped + compose-hooks + symlink
scripts/copy-assets.mjs    copies extract.mjs + queries into dist/ after tsc
.opencode/plugins/ast-grep.ts   thin shim opencode scans; re-exports src/plugin
.opencode/skills/ast-grep       symlink -> src/skills/ast-grep (opencode scans here)
```

## Develop

```bash
npm install --legacy-peer-deps   # --legacy-peer-deps required for tree-sitter grammars
npm run typecheck                # tsc, no emit (covers src + test + shim)
npm test                         # all 10 test suites (tsx runner; hermetic)
npm run build                    # tsc src -> dist + copy assets
```

Dependencies live in the **root** `package.json` (single `node_modules`). Both the plugin (loaded by opencode) and the `extract.mjs` subprocess (spawned by `node`) resolve from the root `node_modules`.

### Tree-sitter native binding (Node 24)

Node 24's V8 requires C++20. The tree-sitter npm package ships a `binding.gyp` pinned to C++17, so a fresh `npm install` on Node 24 produces a non-loadable `.node`. If `require('tree-sitter')` throws `No native build was found`, patch and rebuild:

```powershell
$n = "node_modules/tree-sitter/binding.gyp"
(Get-Content $n -Raw) `
  -replace '"-std=c\+\+17"', '"-std=c++20"' `
  -replace '"CLANG_CXX_LANGUAGE_STANDARD": "c\+\+17"', '"CLANG_CXX_LANGUAGE_STANDARD": "c++20"' `
  -replace '"/std:c\+\+17"', '"/std:c++20"' |
  Set-Content $n -NoNewline
npm rebuild tree-sitter
```

(Developed on Node 22 historically; Node 24.15 verified with the patch above.)

## Hard constraints (do not break)

1. **opencode discovery is fixed**: plugins load from `.opencode/plugins/*.ts`, skills from `.opencode/skills/`. The shim at `.opencode/plugins/ast-grep.ts` re-exports `src/plugin.ts` so source can live in a normal layout. Do not move the shim out of `.opencode/plugins/`.
2. **`ast_grep_map` extraction runs in a separate `node` process** (`src/ast-grep-map/extract.mjs`). tree-sitter's native N-API addons do NOT load inside opencode's bundled runtime, so the plugin spawns `node` to do all tree-sitter work. If you change the extractor's location, update `resolveExtractScript` in `src/ast-grep-map/impl.ts` and the `EXTRACT_SCRIPT_INSTALLED_NAME = "ast-grep-map-extract.mjs"` constant (the installed bundle ships extract.mjs under that name as a sibling of impl.js).
3. **`.ts`-extension imports**: tests and the `.opencode/plugins/` shim use `.ts` extensions (resolved by the `tsx` test runner and opencode's loader). `src/plugin.ts`, `src/index.ts`, and all `src/ast-grep-map/*.ts` modules use **extensionless `.js` specifiers** so `tsc -p tsconfig.build.json` can emit `dist/`. Don't add `.ts`-extension imports inside `src/`.
4. **`sg run` exit 1 = no matches, not error** (only exit ≥ 2 is failure). Two-pass replace: never combine `--json` with `--update-all`.
5. **Cache schema is v2** (`graph-store.ts:GRAPH_CACHE_VERSION = 2`). v1 caches are rejected on read with a one-time stderr hint. The schema nests a primary `worktreeGraph` (drives REPORT.md and unscoped map calls) plus a `scopes[]` array of PPR rank snapshots layered on top. Bumping the version invalidates all existing caches — fine because `.ast-grep/` is gitignored.
6. **Scope snapshot persistence ordering** (`src/ast-grep-map/impl.ts` execute path): the worktree graph MUST be persisted via `persistGraphAsCache` (which calls `setWorktreeGraphCache`) BEFORE `persistScopedRankSnapshot` is called. Reversing this order clobbers the scope snapshot because `buildInitialCache` resets `scopes: []` and `setWorktreeGraphCache` swaps the in-memory state. The regression test at `test/ast-grep-map/cache-hit-scoped.ts` covers this.

## Plugin lifecycle hooks

`src/plugin.ts` composes both plugins' hook maps via `composeHooks`. The composer chains every async hook key on the `Hooks` interface (`event`, `chat.*`, `tool.execute.before/after`, `tool.definition`, `shell.env`, etc.) with per-handler try/catch + stderr logging for isolation.

The ast-grep-map plugin subscribes to:

- `session.created` → background REPORT.md refresh (fire-and-forget, `unref`'d).
- `file.edited` / `file.watcher.updated` → `markStaleForPath(worktree, file)` — flips the matching scope snapshot's `refreshState.stale` flag and persists. Cheap; no rebuild. Falls back to `markWorkspaceStale` when the path is outside the worktree.
- `tool.execute.after` (only for `edit` / `write` tools) → same invalidation. Reads `metadata.filepath` (or `metadata.filediff.file` for older opencode shapes).

Worktree-graph freshness is manifest-driven (mtime+size); scope snapshots have explicit `refreshState.stale` because they are derived data without their own manifest.

## Environment variables

| Variable | Purpose |
|---|---|
| `OMO_AST_GREP_SG_PATH` | Override the resolved `sg` binary path (skip provisioning). |
| `OP_AST_GREP_RUNTIME_DIR` | Override where the provisioned `sg` binary lives. |
| `OP_AST_GREP_MAP_DIR` | Override where `graph.json` + `REPORT.md` live (default `<worktree>/.ast-grep/`). |
| `OP_AST_GREP_MAP_SCRIPT` | Override the extract.mjs path (used by tests). |
| `OP_AST_GREP_MAP_NODE` | Override the `node` binary used to spawn the extractor. |
| `OP_AST_GREP_MAP_SEED_PATHS` | Debug seeds for PPR — `;`,`,` or newline-separated workspace-relative paths; each becomes a weight-1 `SeedEntry` with `source: "debug-seed-path"`. |

## Committing

`node_modules/`, `dist/`, `.ast-grep/` (graph cache), and `.opencode/runtime/` (sg binary) are gitignored. Commit `package.json`, `package-lock.json`, `src/`, `test/`, `.opencode/plugins/`, `.opencode/skills/`, and the root configs.
