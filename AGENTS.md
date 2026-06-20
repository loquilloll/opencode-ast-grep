# AGENTS.md

Guidance for AI agents working in this repo.

## What this is

An opencode plugin package providing five AST tools:

- `ast_grep_search` / `ast_grep_replace` / `ast_grep_scan` / `ast_grep_validate` — wrap the `sg` (ast-grep) binary.
- `ast_grep_map` — an aider-style repo map ranked by PageRank (tree-sitter based; no `sg`).

Also ships the `ast-grep` **skill** (agent docs) under `.opencode/skills/ast-grep/`.

## Layout

```
src/                     all TypeScript source
  plugin.ts              single opencode plugin entry (registers all 5 tools)
  index.ts               package entry (re-exports plugin)
  ast-grep/impl.ts       search/replace/scan/validate + sg binary provisioning
  ast-grep-map/impl.ts   map tool: graph + PageRank + render + persistence
  ast-grep-map/extract.mjs  tree-sitter tag extractor (runs as a node subprocess)
  ast-grep-map/queries/  vendored aider -tags.scm query files
test/                    smoke tests (run with node --experimental-strip-types)
scripts/copy-assets.mjs  copies extract.mjs + queries into dist/ after tsc
.opencode/plugins/ast-grep.ts  thin shim opencode scans; re-exports src/plugin
src/skills/ast-grep/            the skill (SKILL.md + references + helper);
.opencode/skills/ast-grep       symlink -> src/skills/ast-grep (opencode scans here)
```

## Develop

```bash
npm install --legacy-peer-deps   # --legacy-peer-deps required for tree-sitter grammars
npm run typecheck                # tsc, no emit (covers src + test + shim)
npm test                         # both smoke suites
npm run build                    # tsc src -> dist + copy assets
```

Dependencies live in the **root** `package.json` (single `node_modules`). Both the plugin (loaded by opencode) and the `extract.mjs` subprocess (spawned by `node`) resolve from the root `node_modules`.

## Hard constraints (do not break)

1. **opencode discovery is fixed**: plugins load from `.opencode/plugins/*.ts`, skills from `.opencode/skills/`. The shim at `.opencode/plugins/ast-grep.ts` re-exports `src/plugin.ts` so source can live in a normal layout. Do not move the shim out of `.opencode/plugins/`.
2. **`ast_grep_map` extraction runs in a separate `node` process** (`src/ast-grep-map/extract.mjs`). tree-sitter's native N-API addons do NOT load inside opencode's bundled runtime, so the plugin spawns `node` to do all tree-sitter work. If you change the extractor's location, update `resolveExtractScript` in `src/ast-grep-map/impl.ts`.
3. **`.ts`-extension imports**: tests and the shim use `.ts` extensions (needed for `node --experimental-strip-types` and opencode's loader). `src/plugin.ts` and `src/index.ts` use **extensionless** imports so `tsc` can emit `dist/`. Don't add `.ts`-extension imports inside `src/`.
4. **`sg run` exit 1 = no matches, not error** (only exit ≥ 2 is failure). Two-pass replace: never combine `--json` with `--update-all`.

## Committing

`node_modules/`, `dist/`, `.ast-grep/` (graph cache), and `.opencode/runtime/` (sg binary) are gitignored. Commit `package.json`, `package-lock.json`, `src/`, `test/`, `.opencode/plugins/`, `.opencode/skills/`, and the root configs.
