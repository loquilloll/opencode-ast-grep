# opencode-ast-grep

Five AST tools for [opencode](https://opencode.ai), plus the `ast-grep` agent skill.

| Tool | What it does |
|---|---|
| `ast_grep_search` | AST-aware code search via the `sg` binary. |
| `ast_grep_replace` | Two-pass structural rewrite (dry-run, then apply). |
| `ast_grep_scan` | YAML-rule-based scan (`sg scan`). |
| `ast_grep_validate` | Offline pattern hint check (no binary call). |
| `ast_grep_map` | Aider-style repo map ranked by **PageRank** (tree-sitter; no `sg`). |

`ast_grep_search` / `_replace` / `_scan` / `_validate` wrap the [`ast-grep`](https://ast-grep.github.io/) (`sg`) CLI with offline pattern validation, the two-pass write trick, and automatic binary provisioning. `ast_grep_map` is a separate tree-sitter-based tool that produces a compact symbol outline (`L<start>-L<end>` ranges, path shown once per file) ranked by a PageRank graph built from the whole worktree, and persists that graph to `.ast-grep/graph.json`.

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

First use of the four `sg` tools auto-downloads the `ast-grep` binary (`0.43.0`) to `.opencode/runtime/`; `ast_grep_map` needs no binary (it uses the tree-sitter deps installed above).

## Project structure

```
src/                         all TypeScript source
  plugin.ts                  single opencode plugin entry (registers all 5 tools)
  index.ts                   package entry (re-exports plugin)
  ast-grep/impl.ts           search/replace/scan/validate + sg binary provisioning
  ast-grep-map/impl.ts       map tool: graph + PageRank + render + persistence
  ast-grep-map/extract.mjs   tree-sitter tag extractor (runs as a node subprocess)
  ast-grep-map/queries/      vendored aider -tags.scm query files
  skills/ast-grep/           the skill (SKILL.md + references + helper script)
test/                        smoke + helper tests
scripts/copy-assets.mjs      copies extract.mjs + queries into dist/ on build
.opencode/plugins/ast-grep.ts   thin shim opencode scans; re-exports src/plugin
.opencode/skills/ast-grep       symlink -> src/skills/ast-grep (opencode scans here)
tsconfig.json                typecheck config (src + test + shim, noEmit)
tsconfig.build.json          emit config (src -> dist/)
```

## How it works

- The four `sg` tools shell out to a provisioned `ast-grep` binary (auto-downloaded to `.opencode/runtime/` on first use, pinned `0.43.0`).
- `ast_grep_map` delegates all tree-sitter work to a standalone `node` subprocess (`src/ast-grep-map/extract.mjs`), because tree-sitter's native N-API addons do not load inside opencode's bundled runtime. The plugin itself builds the reference graph, runs PageRank (networkx defaults: damping 0.85, 100 iterations, tol 1e-6), and renders a token-budgeted outline.

## Development

### Prerequisites

- **Node.js ≥ 22.6** (tests use `--experimental-strip-types`; the repo is developed on Node 22).
- `npm`. (opencode itself auto-manages a small `.opencode/node_modules` at startup; the full dep set lives at the repo root.)

### Setup

```bash
npm install --legacy-peer-deps
```

`--legacy-peer-deps` is required because the `tree-sitter-*` grammar packages declare an older optional peer on `tree-sitter`. A plain `npm install` will fail with `ERESOLVE`.

### npm scripts

| Script | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src/` + `test/` + the `.opencode` shim. |
| `npm test` | Runs both smoke suites (see [Testing](#testing)). |
| `npm run test:ast-grep` | Just the ast-grep smoke suite. |
| `npm run test:ast-grep-map` | Just the ast-grep-map smoke suite. |
| `npm run build` | `tsc` `src/` -> `dist/` + copies `extract.mjs` and `queries/`. |

### How opencode loads the code

opencode discovers local plugins from `.opencode/plugins/*.ts` and skills from `.opencode/skills/<name>/SKILL.md`. This repo keeps the **source in `src/`** and bridges discovery with:

- `.opencode/plugins/ast-grep.ts` — a one-line shim that re-exports `src/plugin.ts`.
- `.opencode/skills/ast-grep` — a symlink to `src/skills/ast-grep`.

opencode transpiles `.ts` on load, so **no build is needed for local development** — edits in `src/` are picked up on the next opencode session. `dist/` (from `npm run build`) is only the shippable artifact.

> **Plugin caching:** opencode loads plugins once at session start. After editing `src/`, restart the opencode session (or run a throwaway `opencode run` in tmux) to exercise the change live.

### Constraints (don't break)

1. **`src/plugin.ts` and `src/index.ts` use NodeNext `.js` imports** (`./ast-grep/impl.js`) so `tsc` can emit `dist/`. Everywhere else (tests, the shim) uses `.ts` extensions for `node --experimental-strip-types` / opencode's loader. Don't introduce `.ts`-extension imports inside `src/`.
2. **The extractor is a subprocess.** `ast_grep_map` spawns `node src/ast-grep-map/extract.mjs` (tree-sitter won't load in opencode's runtime). If you move it, update `resolveExtractScript` in `src/ast-grep-map/impl.ts`.
3. **`sg run` exit 1 = "no matches", not an error** (only exit ≥ 2 fails). Two-pass replace never combines `--json` with `--update-all`.

See [`AGENTS.md`](./AGENTS.md) for the full list.

## Testing

```bash
npm test          # both smoke suites (hermetic, no network needed except sg provisioning)
```

Tests run directly on `.ts` via `node --experimental-strip-types` (no compile step). The default `npm test` runs the two **smoke** suites:

**`test/ast-grep/smoke.ts`** — end-to-end in a temp dir:
- `search` finds a match; `replace` dry-runs (no mutation) then applies (mutates); re-`search` finds 0.
- `scan` finds/no-matches/rejects bad config combos.
- `validate` flags regex misuse.
- *Requires the `sg` binary*, which auto-provisions from GitHub on first use (network).

**`test/ast-grep-map/smoke.ts`** — five groups:
1. `extractAllTags` (TypeScript) captures class/function/method defs with `endLine` + `decl`.
2. `pageRank` converges (scores sum to 1.0), is deterministic, and handles the empty graph.
3. `renderTree` produces the compact outline (`L<n>` / `L<start>-L<end>`, path shown once, no `│`/`⋮`).
4. End-to-end `ast_grep_map.execute` on `src/ast-grep/impl.ts`: writes `graph.json`, populated `rankedSymbols`, scores sum to 1, and `refresh:"auto"` reuses the cache (mtime unchanged).
5. `json:true` returns a parseable graph.

### Additional (non-default) test files

These aren't run by `npm test` — invoke directly when relevant:

| File | What / when |
|---|---|
| `test/ast-grep/load.ts` | Asserts the plugin loads and registers the expected tool names. |
| `test/ast-grep/e2e.ts` | Provisions the `sg` binary end-to-end and checks `--version` (network). |
| `test/ast-grep/parity.ts` | Checks `validatePattern` output matches the upstream Python helper — **needs the omo clone** at `/home/agent/omo-clone/...`, which isn't vendored here. |

Run individually, e.g.:
```bash
node --experimental-strip-types test/ast-grep/load.ts
```

### Verifying in live opencode

Because plugins cache at session start, exercise source changes through a throwaway session rather than editing mid-session:

```bash
tmux new-session -d -s t 'opencode run "call ast_grep_map with paths [\"src\"]" > /tmp/t.log 2>&1'
# … poll /tmp/t.log, then: tmux kill-server
```

### Convergence / determinism

`ast_grep_map` PageRank is deterministic across runs and its scores sum to 1.0 (asserted in the smoke suite). The persisted graph (`<worktree>/.ast-grep/graph.json`, gitignored) is rebuilt automatically by `refresh:"auto"` whenever any source file's mtime changes.

## Build

```bash
npm run build        # tsc src -> dist (+ copies extract.mjs + queries/)
```

`dist/` is gitignored. For a published package, point consumers at `dist/` (e.g. add it to a consumer's `opencode.json` `"plugin"` array, or ship as an npm package consumed by name).
