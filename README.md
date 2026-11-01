# opencode-ast-grep

Five AST tools for [opencode](https://opencode.ai), plus the `ast-grep` agent skill — **and the same five tools exposed as a standalone [MCP](https://modelcontextprotocol.io) server** (`ast-grep-mcp`) that works in any MCP client: Claude Code, Codex CLI, GitHub Copilot, Cursor, Cline, opencode, and more.

| Tool | What it does |
|---|---|
| `ast_grep_search` | AST-aware code search via the `sg` binary (byte-capped at 1 MB / 500 JSON matches). |
| `ast_grep_replace` | Two-pass structural rewrite (dry-run, then apply). |
| `ast_grep_scan` | YAML-rule-based scan (`sg scan`). |
| `ast_grep_validate` | Offline pattern hint check (no binary call). |
| `ast_grep_map` | Aider-style repo map ranked by **PageRank** (tree-sitter; no `sg`). |

`ast_grep_search` / `_replace` / `_scan` / `_validate` wrap the [`ast-grep`](https://ast-grep.github.io/) (`sg`) CLI with offline pattern validation, the two-pass write trick, byte-capped subprocess output (1 MB cap with UTF-8-safe truncation + JSON bracket-repair), and automatic binary provisioning. `ast_grep_map` is a separate tree-sitter-based tool that produces a compact symbol outline (`L<start>-L<end>` ranges, path shown once per file) ranked by a PageRank graph built from the whole worktree, with scope-keyed Personalized PageRank snapshots layered on top when `paths`/`globs`/`mentioned_idents` are given. The cache lives at `.ast-grep/graph.json` and auto-invalidates on file edits.

Supported languages: `ast_grep_*` → 25 (via `sg`); `ast_grep_map` → ts, tsx, js, py, go, rs, cpp.

## Quickstart

From the repo root:

```bash
npm install --legacy-peer-deps   # tree-sitter grammars need --legacy-peer-deps
opencode                          # plugin + skill are auto-discovered from .opencode/
```

No `opencode.json` change is needed — the plugin loads from `.opencode/plugins/ast-grep.ts` (a shim into `src/`) and the skill from `.opencode/skills/ast-grep`.

Then in the opencode session, prompt the agent naturally — it will call the tools:

```
> give me a map of src/ ranked by importance        # → ast_grep_map
> find every console.log($X) in src/                # → ast_grep_search
> rewrite those to logger.info($X)                  # → ast_grep_replace (dry-run, then apply)
```

Example `ast_grep_map` output:

```
src/ast-grep-map/impl.ts:
   L217-L259  function buildGraph(input: BuildInput): Graph {
   L269-L336  function pageRank(
       L410  function renderTree(rankedTags: RankedTag[]): string {
```

First use of the four `sg` tools auto-downloads the `ast-grep` binary (`0.45.2`) to `.opencode/runtime/`; `ast_grep_map` needs no binary (it uses the tree-sitter deps installed above).

## MCP server (Claude Code, Codex CLI, Copilot, …)

The same five tools also run as a **standalone stdio MCP server** — no opencode required. The server reuses the tool definitions verbatim and synthesizes a tool context from the resolved project root + per-request abort signal; `sg` binary provisioning and the tree-sitter extraction run as self-contained Node subprocesses.

### Run it

```bash
npm run build
npm run mcp                                  # uses process.cwd() as the root
node dist/mcp/stdio.js --directory /path/to/project
node dist/mcp/stdio.js --help                # prints to stderr (never stdout)
```

Project-root resolution: `--directory` / `-d` CLI arg → `OP_AST_GREP_MCP_DIRECTORY` env var → `process.cwd()`. The server also honors the tuning knobs in the env table below (`OMO_AST_GREP_SG_PATH`, `OP_AST_GREP_MAP_DIR`, …). stdio is reserved for the JSON-RPC protocol — all diagnostics go to stderr.

> **Destructive tools:** over MCP there is no host permission layer. `ast_grep_replace{apply:true}` and `ast_grep_scan{apply:true}` modify files on disk directly; their descriptions carry an explicit warning so the model confirms first. The other three tools are read-only.

### Setup by client

Pick your client. Each assumes you've run `npm run build` and uses `<REPO>` for this repo's absolute path (run `pwd` / `echo %CD%` in the repo to copy it; on Windows use the full `C:\...\dist\mcp\stdio.js` path, double-backslashed in JSON). Append `--directory <project>` to any launch command to pin the project root explicitly.

#### opencode
opencode reads MCP servers from `opencode.json` (project root) or `~/.config/opencode/opencode.json` (global):
```json
{
  "mcp": {
    "ast-grep": {
      "type": "local",
      "command": ["node", "<REPO>/dist/mcp/stdio.js", "--directory", "<your-project>"],
      "enabled": true
    }
  }
}
```
Or via the CLI (writes the same config):
```bash
opencode mcp add ast-grep -- node <REPO>/dist/mcp/stdio.js --directory <your-project>
```
**Verify:** launch `opencode` in the project and run `/mcp` → `ast-grep connected ✓`. *(Verified against opencode v1.18.5.)*

#### GitHub Copilot (VS Code)
VS Code / Copilot Chat reads MCP servers from `.vscode/mcp.json` in the workspace (commit it to share with your team):
```json
{
  "servers": {
    "ast-grep": {
      "command": "node",
      "args": ["<REPO>/dist/mcp/stdio.js", "--directory", "${workspaceFolder}"]
    }
  }
}
```
`${workspaceFolder}` is a VS Code variable resolved at launch to the open workspace. Reload the window after saving; the first start prompts you to **trust** the server.
**Verify:** open Chat → **Configure Tools** → the five `ast_grep_*` tools are listed. *(Copilot CLI / the Agent Host instead read `~/.copilot/mcp-config.json` or a workspace `.mcp.json` with the same `servers` shape.)*

#### Claude Code
Use the CLI — options come **before** the name; `--` separates Claude's config from the launch command:
```bash
# project-scoped (shared via .mcp.json) — recommended; server inherits the project as cwd:
claude mcp add --scope project ast-grep -- node <REPO>/dist/mcp/stdio.js
# user-scoped (all your projects) — pin an explicit root:
claude mcp add --scope user ast-grep -- node <REPO>/dist/mcp/stdio.js --directory /path/to/project
```
**Verify:** `claude mcp list` shows `ast-grep ✓ connected`; in a session the tools appear as `mcp__ast-grep__ast_grep_*`.

#### Codex CLI
Codex reads MCP servers from `~/.codex/config.toml`:
```toml
[mcp_servers.ast-grep]
command = "node"
args = ["<REPO>/dist/mcp/stdio.js", "--directory", "/path/to/project"]
```
Or via the CLI (everything after `--` is the launch command):
```bash
codex mcp add ast-grep -- node <REPO>/dist/mcp/stdio.js --directory /path/to/project
```
**Verify:** `codex mcp list` shows the server; the tools are available in the next session.

---

**Cursor, Cline, Claude Desktop** use the same shape — `command: "node"`, `args: ["<REPO>/dist/mcp/stdio.js"]` — in their respective MCP config files. The Node 24 tree-sitter caveat in Development below still applies to `ast_grep_map`.

## Project structure

```
src/                         all TypeScript source
  plugin.ts                  composed opencode plugin entry (chains both plugins' hooks)
  index.ts                   package entry (re-exports plugin)
  ast-grep/impl.ts           search/replace/scan/validate + sg binary provisioning
  ast-grep-map/impl.ts       map tool: extraction subprocess + rendering + REPORT.md
  ast-grep-map/graph.ts      pure types + PageRank + PPR + scope/symlink helpers
  ast-grep-map/graph-store.ts   versioned disk cache (v2 schema, mtime+size manifest)
  ast-grep-map/graph-service.ts in-memory lifecycle + invalidation API + scope snapshots
  ast-grep-map/graph-plugin.ts  re-export seam for runtime/build consumers
  ast-grep-map/extract.mjs   tree-sitter tag extractor (runs as a node subprocess)
  ast-grep-map/queries/      vendored aider -tags.scm query files
  mcp/server.ts              transport-agnostic MCP server factory (bridges the 5 tools)
  mcp/stdio.ts               CLI entry (bin: ast-grep-mcp); shebang; stdio transport
  skills/ast-grep/           the skill (SKILL.md + references + helper script)
test/                        14 test suites (run with tsx)
  ast-grep/                  smoke + truncation suites
  ast-grep-map/              smoke + report + graph-store + graph-lifecycle + ppr + ppr-wiring
                             + cache-hit-scoped + compose-hooks + symlink + home-guard
  mcp/                       registry + hermetic runTool + InMemoryTransport round-trip + stdio
scripts/copy-assets.mjs      copies extract.mjs + queries into dist/ on build
.opencode/plugins/ast-grep.ts   thin shim opencode scans; re-exports src/plugin
.opencode/skills/ast-grep       symlink -> src/skills/ast-grep (opencode scans here)
tsconfig.json                typecheck config (src + test + shim, noEmit)
tsconfig.build.json          emit config (src -> dist/)
```

## How it works

- The four `sg` tools shell out to a provisioned `ast-grep` binary (auto-downloaded to `.opencode/runtime/` on first use, pinned `0.45.2`). Subprocess output is byte-capped at 1 MB: when the cap is hit the child is SIGTERM'd, partial JSON is salvaged via bracket-repair, and the formatted output is prefixed with `[TRUNCATED]` explaining the reason.
- `ast_grep_map` delegates all tree-sitter work to a standalone `node` subprocess (`src/ast-grep-map/extract.mjs`), because tree-sitter's native N-API addons do not load inside opencode's bundled runtime. The plugin itself builds the reference graph, runs PageRank (networkx defaults: damping 0.85, 100 iterations, tol 1e-6), and renders a token-budgeted outline.
- When `ast_grep_map` is called with `paths`/`globs`/`mentioned_idents`, a Personalized PageRank runs on the same worktree graph biased toward the scoped files. The resulting rank snapshot is cached per-scope in `graph.json`'s `scopes[]` array (keyed by `{paths, globs}` + seed fingerprint) so subsequent calls with the same scope reuse it. File edits invalidate the matching scope snapshot automatically via the `file.edited` / `tool.execute.after` hooks.

## Development

### Prerequisites

- **Node.js ≥ 22.6** (developed on Node 22; verified on Node 24.15 with a tree-sitter binding patch — see AGENTS.md).
- `npm`. (opencode itself auto-manages a small `.opencode/node_modules` at startup; the full dep set lives at the repo root.)

### Setup

```bash
npm install --legacy-peer-deps
```

`--legacy-peer-deps` is required because the `tree-sitter-*` grammar packages declare an older optional peer on `tree-sitter`. A plain `npm install` will fail with `ERESOLVE`.

### Node 24 + tree-sitter native binding

Node 24's V8 requires C++20 but tree-sitter's `binding.gyp` ships pinned to C++17. If `require('tree-sitter')` throws `No native build was found`, patch and rebuild — see AGENTS.md → "Tree-sitter native binding (Node 24)" for the one-liner.

### npm scripts

| Script | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src/` + `test/` + the `.opencode` shim. |
| `npm test` | Runs all 14 test suites via `tsx` (hermetic; some need network for sg provisioning). |
| `npm run test:ast-grep` | Just the ast-grep smoke suite. |
| `npm run test:ast-grep-truncation` | Just the byte-cap + JSON-repair suite. |
| `npm run test:ast-grep-map` | Just the ast-grep-map smoke suite. |
| `npm run test:ast-grep-map-report` | Just the REPORT.md generator suite. |
| `npm run test:ast-grep-map-store` | Disk cache roundtrip + validation suite. |
| `npm run test:ast-grep-map-lifecycle` | Invalidation + hydration suite. |
| `npm run test:ast-grep-map-ppr` | Personalized PageRank + scope helpers suite. |
| `npm run test:ast-grep-map-ppr-wiring` | Scope-overlay regression suite (cache-hit + PPR end-to-end). |
| `npm run test:ast-grep-map-cache-hit-scoped` | Cache-hit + PPR overlay regression (defTags reconstruction). |
| `npm run test:ast-grep-map-compose-hooks` | Plugin hook composition suite. |
| `npm run test:ast-grep-map-symlink` | Symlink rejection suite (Windows skips when Developer Mode is off). |
| `npm run test:ast-grep-map-home-guard` | Home-dir guard + extraction-timeout-hint suite. |
| `npm run test:mcp` | MCP bridge smoke: registry + hermetic runTool + InMemoryTransport round-trip + stdio discipline. |
| `npm run build` | `tsc` `src/` -> `dist/` + copies `extract.mjs` and `queries/`. |
| `npm run mcp` | Run the standalone MCP server over stdio (`node dist/mcp/stdio.js`). |

### How opencode loads the code

opencode discovers local plugins from `.opencode/plugins/*.ts` and skills from `.opencode/skills/<name>/SKILL.md`. This repo keeps the **source in `src/`** and bridges discovery with:

- `.opencode/plugins/ast-grep.ts` — a one-line shim that re-exports `src/plugin.ts`.
- `.opencode/skills/ast-grep` — a symlink to `src/skills/ast-grep`.

opencode transpiles `.ts` on load, so **no build is needed for local development** — edits in `src/` are picked up on the next opencode session. `dist/` (from `npm run build`) is only the shippable artifact.

> **Plugin caching:** opencode loads plugins once at session start. After editing `src/`, restart the opencode session (or run a throwaway `opencode run` in tmux) to exercise the change live.

### Constraints (don't break)

1. **`src/plugin.ts` and all `src/ast-grep-map/*.ts` modules use NodeNext `.js` imports** (`./graph.js`, `./ast-grep/impl.js`) so `tsc` can emit `dist/`. Everywhere else (tests, the shim) uses `.ts` extensions for the `tsx` runner / opencode's loader. Don't introduce `.ts`-extension imports inside `src/`.
2. **The extractor is a subprocess.** `ast_grep_map` spawns `node src/ast-grep-map/extract.mjs` (tree-sitter won't load in opencode's runtime). If you move it, update `resolveExtractScript` in `src/ast-grep-map/impl.ts`.
3. **`sg run` exit 1 = "no matches", not an error** (only exit ≥ 2 fails). Two-pass replace never combines `--json` with `--update-all`.
4. **Scope snapshot persistence ordering.** In `ast_grep_map.execute()`, the worktree graph MUST be persisted before the scope snapshot. Reversing this order silently clobbers the scope. The regression test at `test/ast-grep-map/cache-hit-scoped.ts` covers this.

See [`AGENTS.md`](./AGENTS.md) for the full list.

## Testing

```bash
npm test          # all 13 suites (hermetic, except sg-binary provisioning on first run)
```

Tests run on `.ts` source via the `tsx` runner (no compile step). The default `npm test` runs thirteen suites:

**`test/ast-grep/smoke.ts`** — end-to-end in a temp dir: search finds a match; replace dry-runs then applies; scan finds/no-matches/rejects bad config; validate flags regex misuse. *Requires the `sg` binary*, which auto-provisions from GitHub on first use (network).

**`test/ast-grep/truncation.ts`** — byte-precise truncation + JSON bracket-repair: `appendWithCap` UTF-8-safe binary search, simple + conservative bracket-repair strategies, max-matches cap, `[TRUNCATED]` formatting.

**`test/ast-grep-map/smoke.ts`** — `extractAllTags` captures class/function/method defs; `pageRank` converges and sums to 1; `renderTree` produces compact outline; end-to-end `ast_grep_map.execute` writes v2 graph.json with `worktreeGraph` + `sourceManifest`; `json:true` returns the v2 nested cache shape.

**`test/ast-grep-map/report.ts`** — pure-function REPORT.md generator: topHubs, surprisingConnections, moduleDependencyGraph, orphanDefs, multiDefiners.

**`test/ast-grep-map/graph-store.ts`** — disk cache roundtrip; manifest mismatch (mtime OR size); tampered/unknown-version rejection; out-of-workspace path rejection; byte-stable serialization; scope-snapshot roundtrip.

**`test/ast-grep-map/graph-lifecycle.ts`** — `initializeGraphPlugin` hydration; `markStaleForPath` scope-aware invalidation; `markWorkspaceStale`; out-of-workspace fallback; seed-change rejection.

**`test/ast-grep-map/ppr.ts`** — `buildPersonalizationVector`; `runPersonalizedPageRank` convergence + bias; uniform fallback; `deriveScopedFileScores`; `isFileInScope` / `matchesScopeGlobs`; `normalizeSeedEntries` dedupe + sort.

**`test/ast-grep-map/ppr-wiring.ts`** — scope snapshot survives `setWorktreeGraphCache`; `buildScopeSeeds` for paths/mentioned_idents; invalidation clears matching scope; cache-hit branch data coherence.

**`test/ast-grep-map/cache-hit-scoped.ts`** — regression: cache-hit branch reconstructs defTags before PPR overlay so warm-cache scoped calls don't return empty.

**`test/ast-grep-map/compose-hooks.ts`** — `composeHooks` chains both-present handlers, asymmetric passthrough, per-handler error isolation, every chainable Hooks key.

**`test/ast-grep-map/symlink.ts`** — `isSeedPathSymlink` on regular file; `discoverCodeFiles` skips symlinked files + dirs; `normalizeSeedEntries` rejects symlinked seeds. Windows self-skips when Developer Mode is off.

**`test/ast-grep-map/home-guard.ts`** — `isHomeDir` (case-insensitive on Windows); `discoverCodeFiles` refuses to walk the user's home directory; `resolveRoot` falls back past home; `maybeRefreshReport` skips home.

**`test/mcp/smoke.ts`** — MCP bridge: registry shape (5 tools, descriptions, args); hermetic `runTool` on `ast_grep_validate`; end-to-end `tools/list` + `tools/call` over `InMemoryTransport` (required-field + mutation-warning conversion); `normalizeToolResult` (`{error}` → `isError`); `--help` writes 0 bytes to stdout.

### Convergence / determinism

`ast_grep_map` PageRank is deterministic across runs and its scores sum to 1.0 (asserted in the smoke suite). The persisted cache (`<worktree>/.ast-grep/graph.json`, gitignored, schema v2) is rebuilt automatically by `refresh:"auto"` whenever the source manifest (mtime+size) changes, and scope snapshots are invalidated incrementally on `file.edited` / `tool.execute.after` edit-write hooks.

## Build

```bash
npm run build        # tsc src -> dist (+ copies extract.mjs + queries/)
```

`dist/` is gitignored. The build also emits `dist/mcp/stdio.js` (the `ast-grep-mcp` bin entry; shebang preserved on line 1, so it's directly executable). For a published package, point consumers at `dist/` (e.g. add it to a consumer's `opencode.json` `"plugin"` array, register `dist/mcp/stdio.js` as an MCP server per the snippets above, or ship as an npm package consumed by name).

## Environment variables

| Variable | Purpose |
|---|---|
| `OMO_AST_GREP_SG_PATH` | Override the resolved `sg` binary path (skip provisioning). |
| `OP_AST_GREP_RUNTIME_DIR` | Override where the provisioned `sg` binary lives. |
| `OP_AST_GREP_MAP_DIR` | Override where `graph.json` + `REPORT.md` live (default `<worktree>/.ast-grep/`). |
| `OP_AST_GREP_MAP_SCRIPT` | Override the extract.mjs path (used by tests). |
| `OP_AST_GREP_MAP_NODE` | Override the `node` binary used to spawn the extractor. |
| `OP_AST_GREP_MAP_SEED_PATHS` | Debug seeds for PPR — `;`,`,` or newline-separated workspace-relative paths. |
| `OP_AST_GREP_MCP_DIRECTORY` | MCP server: project root when `--directory` is not given (default `process.cwd()`). |
