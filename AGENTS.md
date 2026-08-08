# AGENTS.md

Guidance for AI agents working in this repo.

> **Don't duplicate README content here.** This file is for agent/dev-specific guidance — build constraints, lifecycle hooks, invariants an editor must preserve, internal workflows (e.g. the global-install deploy), and orientation. User-facing material (setup, usage, per-client MCP config, the tool table, env-var reference) lives in [`README.md`](./README.md). When adding to AGENTS.md, link to README instead of restating it; when README gains a section, prune the overlap from here.

## What this is

An opencode plugin package providing five AST tools:

- `ast_grep_search` / `ast_grep_replace` / `ast_grep_scan` / `ast_grep_validate` — wrap the `sg` (ast-grep) binary.
- `ast_grep_map` — an aider-style repo map ranked by PageRank (tree-sitter based; no `sg`).

Also ships the `ast-grep` **skill** (agent docs) under `.opencode/skills/ast-grep/`.

The same five tools are also exposed as a **standalone MCP server** (`src/mcp/`) so any MCP client — Claude Code, Codex CLI, GitHub Copilot, Cursor, Cline, opencode — can use them without opencode installed.

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
  mcp/                     standalone MCP server (works in any MCP client)
    server.ts              transport-agnostic McpServer factory; bridges the 5
                           tools (reuses impl.ts tool defs verbatim via the
                           identity `tool()` fn; synthesizes a ToolContext)
    stdio.ts               CLI entry (bin: ast-grep-mcp); shebang; stdio transport
  skills/ast-grep/         the skill (SKILL.md + references + helper script)
test/                      test suites (run with tsx)
  ast-grep/                smoke + truncation suites
  ast-grep-map/            smoke + report + graph-store + graph-lifecycle + ppr
                           + ppr-wiring + cache-hit-scoped + compose-hooks + symlink
                           + home-guard
  mcp/                     registry + hermetic runTool + InMemoryTransport round-trip
scripts/copy-assets.mjs    copies extract.mjs + queries into dist/ after tsc
.opencode/plugins/ast-grep.ts   thin shim opencode scans; re-exports src/plugin
.opencode/skills/ast-grep       symlink -> src/skills/ast-grep (opencode scans here)
```

## Develop

```bash
npm install --legacy-peer-deps   # --legacy-peer-deps required for tree-sitter grammars
npm run typecheck                # tsc, no emit (covers src + test + shim)
npm test                         # all 13 test suites (tsx runner; hermetic)
npm run build                    # tsc src -> dist + copy assets
npm run mcp                      # run the MCP server over stdio (after build)
npm run test:mcp                 # MCP bridge smoke (registry + runTool + round-trip)
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

## MCP server

`src/mcp/` also exposes the same five tools as a **standalone stdio MCP server** (bin `ast-grep-mcp`) for any MCP client. **Run instructions, root-resolution order, and per-client setup/verification are in [README.md](./README.md) → "MCP server"** — don't restate them here. What's agent-relevant: the bridge reuses the impl modules' tool definitions verbatim (`tool()` is an identity fn) and synthesizes a `ToolContext`; no opencode hooks/lifecycle run, so `sg` provisioning and the `extract.mjs` subprocess are the same self-contained Node paths the plugin uses.

### Relationship to the global-install bundle

The opencode global-install workflow (robocopy `dist/` → `~/.config/opencode/ast-grep-bundle/`) also ships `dist/mcp/`, so the MCP server is available there too (e.g. `node ~/.config/opencode/ast-grep-bundle/mcp/stdio.js`). Standalone MCP use does **not** require the opencode bundle — `node <repo>/dist/mcp/stdio.js` after `npm run build` is sufficient, and the grammar deps resolve from this repo's root `node_modules`.

### Build / editing constraints

- `src/mcp/*.ts` uses **extensionless `.js` specifiers** (hard constraint #3) so `tsc -p tsconfig.build.json` emits `dist/mcp/`. tsc preserves the `#!/usr/bin/env node` shebang on line 1 of `dist/mcp/stdio.js`, so the bin is directly executable.
- **stdio is reserved for the JSON-RPC protocol** — the tool execute paths write nothing to stdout (grep-verified); all diagnostics (help, warnings, `--trace`, fatal errors) go to stderr via the injected `log`. Preserve this when editing.
- **Destructive tools warn via their description.** No host permission layer intercepts MCP tool calls, so `ast_grep_replace{apply:true}` / `ast_grep_scan{apply:true}` mutate files directly. The bridge appends a "modifies files on disk" warning to those tools' descriptions (`MUTATING_TOOLS` in `src/mcp/server.ts`); preserve/extend that set if a new tool gains a destructive mode. The other three tools are read-only.

## Update the global install

When the user says "update my global install" (or "update global", "deploy to global"), they mean: rebuild this repo and copy the built `dist/` over the globally-installed plugin bundle at `~/.config/opencode/ast-grep-bundle/` (Windows: `C:\Users\<user>\.config\opencode\ast-grep-bundle\`).

That bundle is the built `dist/` tree. It is loaded by the shim at `~/.config/opencode/plugins/ast-grep.ts`, which imports `../ast-grep-bundle/plugin.js`. tree-sitter grammar deps resolve from `~/.config/opencode/node_modules/` (declared in the top-level `package.json` there, not this repo's).

Procedure:

```bash
npm run build                    # tsc src -> dist + copy assets (extract.mjs + queries/)
```

Then mirror `dist/` over the bundle (PowerShell; robocopy exit code < 8 = success — 0 means nothing changed, 1 means files copied):

```powershell
robocopy dist "$env:USERPROFILE\.config\opencode\ast-grep-bundle" /E /NFL /NDL /NJH /NJS /NP
```

Verify the deployed code is current and syntax-valid:

```powershell
Select-String "$env:USERPROFILE\.config\opencode\ast-grep-bundle\ast-grep-map\impl.js" -Pattern "IGNORE_DIRS|extractionTimeoutHint"
node --check "$env:USERPROFILE\.config\opencode\ast-grep-bundle\plugin.js"
node --check "$env:USERPROFILE\.config\opencode\ast-grep-bundle\ast-grep-map\impl.js"
```

Do NOT touch when updating the plugin:

- `~/.config/opencode/plugins/ast-grep/` — a vendored copy of the **separate** upstream `code-yeongyu/ast-grep-skill` (see its `SOURCE` file). Holds the `sg` binary install scripts + SKILL.md references. Unrelated to this repo's plugin code.
- `~/.config/opencode/skill/ast-grep/` — the same upstream skill, copied here for opencode's skill loader to scan.

Already-running opencode sessions won't pick up the new bundle until restart; new sessions in other repos load it automatically. (Sessions launched from THIS repo load via the `.opencode/plugins/ast-grep.ts` shim which re-exports `src/plugin.ts` directly, so they're unaffected by a global deploy.)

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
