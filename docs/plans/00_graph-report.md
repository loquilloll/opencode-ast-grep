# Plan: Background `REPORT.md` from the PageRank graph

## Goal
On opencode startup, the plugin builds a markdown briefing from the existing
PageRank graph (already persisted by `ast_grep_map` to `.ast-grep/graph.json`)
and writes it to `.ast-grep/REPORT.md`. The ast-grep skill points the agent at
this file so it reads it first when orienting — the local-only analog of
graphify's `GRAPH_REPORT.md`.

Inspired by https://github.com/safishamsi/graphify. Scope intentionally
local-only: no LLM, no API calls, no inferred relationships (per `AGENTS.md`'s
"runtime deps: `node:` builtins only" philosophy).

## Locked decisions (from user)
1. **Surface** — generate in the **background on `session.created`** (mirror the
   sg-binary provisioning pattern in `src/ast-grep/impl.ts`). No new tool, no new
   flag. Fire-and-forget; cannot block session start.
2. **Output** — persist to `.ast-grep/REPORT.md` (graphify-style; lives next to
   `graph.json`, same gitignored dir).
3. **First-run cost** — build the graph from scratch if `graph.json` is absent.
   Acceptable one-time cost; subsequent starts are instant via the existing
   `sourceMtimes` cache.
4. **Sections** — God nodes / hubs · Surprising cross-module connections ·
   Module dependency graph · Orphan / under-referenced defs · Multi-definer
   ambiguity list.
5. **Module boundary** — first path segment under worktree (`src/`, `cmd/`,
   `pkg/`, …). Simple, matches most repo layouts.
6. **LLM features** — none. Everything is AST-extracted; header comment states
   this explicitly. "Suggested questions" / comment extraction are out of scope
   (would need an API backend, breaks local-only rule).
7. **Instructions for the agent** — a dedicated instructions file at
   `src/skills/ast-grep/references/repo-briefing.md`, plus a one-line pointer in
   `SKILL.md`.

## Deliverable (2 new src files + 1 new test + 1 new instructions file + 3 edits)

| Path | Action | Role |
|---|---|---|
| `src/ast-grep-map/report.ts` | **CREATE** | Pure functions: `PersistedGraph → markdown`. No I/O. |
| `src/ast-grep-map/background.ts` | **CREATE** | `maybeRefreshReport(worktree)`: mtime check → rebuild → write `REPORT.md`. Errors swallowed → `.ast-grep/report.log`. |
| `src/ast-grep-map/impl.ts` | EDIT | Wire the existing `astGrepMapPlugin` default export (currently unused by `plugin.ts`) to register a `session.created` hook calling `maybeRefreshReport` fire-and-forget. |
| `src/plugin.ts` | EDIT | Await `astGrepMapPlugin` too; compose its `session.created` handler with ast-grep's existing one. |
| `test/ast-grep-map/report.ts` | **CREATE** | Unit tests on a synthetic graph + smoke for `maybeRefreshReport` idempotency. Runs under `npm test`. |
| `src/skills/ast-grep/references/repo-briefing.md` | **CREATE** | Instructions file: "read `.ast-grep/REPORT.md` first when orienting" + section legend. |
| `src/skills/ast-grep/SKILL.md` | EDIT | One-line pointer to `references/repo-briefing.md`. |

## A. `report.ts` — section logic (reads only from `PersistedGraph`)

All helpers are pure `(graph, opts) → string`. No `fs`, no subprocess, no
side effects. Easy to unit-test.

```ts
// Public surface
export function generateReport(
  g: PersistedGraph,
  opts: { worktree: string; topN?: number },
): string

// Section helpers (exported for tests)
export function topHubs(g: PersistedGraph, n: number): Hub[]
export function surprisingConnections(g: PersistedGraph, n: number): Edge[]
export function moduleDependencyGraph(g: PersistedGraph): string  // mermaid block
export function orphanDefs(g: PersistedGraph): FileDef[]
export function multiDefiners(g: PersistedGraph, n: number): IdentDef[]
```

1. **God nodes / hubs** (`topHubs`)
   - Top N files by `scores[file]` (PageRank).
   - Top N files by distinct referencer count = `new Set(edges.filter(e => e.dst === file).map(e => e.src)).size` (in-degree from unique srcs).
   - Render both lists with the file path, the metric, and the top 1–2 highest-ranked symbols defined there (from `rankedSymbols`).
   - Default N = 10.

2. **Surprising cross-module connections** (`surprisingConnections`)
   - `topDir(rel) = rel.split(sep)[0]` (first segment under worktree).
   - Filter `edges` to those where `topDir(src) !== topDir(dst)`.
   - For each `(srcModule, dstModule)` pair, count total edges between them.
   - Score each edge: `weight × ln(1 + totalEdgesBetweenThoseModules)`. High weight + rare pair surfaces.
   - Top N (=10) with src path, dst path, ident, weight.

3. **Module dependency graph** (`moduleDependencyGraph`)
   - Collapse edges to `(topDir(src) → topDir(dst))`; sum weights.
   - Render as a mermaid `graph LR` block (GitHub renders mermaid in `.md`).
   - Edge label = total weight (rounded). Skip self-edges within the same module.

4. **Orphan / under-referenced defs** (`orphanDefs`)
   - Files whose only edges are weight-0.1 self-loops (emitted by `buildGraph` for definers with zero referencers — see `impl.ts:240`).
   - Group by file; list with def count and a sample of defined idents (top 5).

5. **Multi-definer ambiguity** (`multiDefiners`)
   - Group `rankedSymbols` by `ident`; for each, collect distinct `file`s.
   - Filter to idents with >1 distinct definer; sort by definer count desc.
   - Cap at N (=15). Render as a table: ident · definer count · files.

6. **Header / footer**
   - Top: `<!-- ast-grep-map report · generated <ISO> · all relationships EXTRACTED via AST (no INFERRED mass; multi-definer list above is the only ambiguity signal). -->`
   - Sections in fixed order above with `##` headings.
   - Footer: regeneration hint ("delete `.ast-grep/graph.json` to force rebuild").

## B. `background.ts` — cache + write logic

```ts
export async function maybeRefreshReport(
  worktree: string,
  opts?: { force?: boolean },
): Promise<{ status: "fresh" | "rebuilt" | "skipped" | "failed"; error?: string }>
```

Reuses already-exported helpers from `impl.ts`:
`loadPersisted`, `discoverCodeFiles`, `extractAllTags`, `buildGraph`,
`pageRank`, `rankDefinitions`, `persistGraph`, `resolveMapDir`,
`resolveExtractScript`, `languageForFile`.

Flow (mirrors the tool's `refresh:"auto"` path at `impl.ts:692-709`):

1. `mapDir = resolveMapDir(worktree)`.
2. `persisted = loadPersisted(mapDir)`.
3. Snapshot current `sourceMtimes` (one `statSync` per discovered file).
4. Decide:
   - **No `graph.json`** → full rebuild path (step 5).
   - **`graph.json` present, mtimes unchanged, `REPORT.md` exists, `!force`** → return `skipped`.
   - **mtimes changed OR `REPORT.md` missing** → use the persisted graph for the report (no re-extract needed; the graph is already current if mtimes match. If mtimes differ, run the rebuild path first).
5. **Rebuild path** (only when needed): discover files → `extractAllTags` → build `defines`/`references` → `buildGraph` → `pageRank` → `rankDefinitions` → `persistGraph`. Now we have a fresh `PersistedGraph`.
6. `markdown = generateReport(graph, { worktree })`.
7. Atomic write: `REPORT.md.tmp` → `renameSync` → `REPORT.md`.
8. Return `fresh` (first write) or `rebuilt`.

### Concurrency & robustness
- **Lockfile** `.ast-grep/.report.lock`: PID + ISO timestamp. If present and
  younger than 5 min, skip. Stale locks are overwritten.
- **All errors caught** — append a one-line entry to `.ast-grep/report.log`
  (timestamp + message). Never throw; the `session.created` hook must not crash
  the plugin load.
- **Abort**: opencode doesn't pass an `AbortSignal` to `session.created`. Rely
  on the extract subprocess timeout (`EXTRACT_TIMEOUT_MS = 120_000` in
  `impl.ts:92`).

## C. `session.created` hook wiring

`astGrepMapPlugin` already exists as the default export of `impl.ts:784-790` but
`plugin.ts` only imports `{ tools as mapTools }` from it. Wire it up:

### `src/ast-grep-map/impl.ts` edit
Change `astGrepMapPlugin` to return an `event` handler:
```ts
const astGrepMapPlugin: Plugin = async (ctx) => {
  return {
    tool: tools,
    event: {
      "session.created": async (event) => {
        // Fire-and-forget: do NOT await (session start must not block).
        const worktree = resolveRoot({ worktree: event.worktree, directory: event.directory } as ToolContext)
        void maybeRefreshReport(worktree).catch(() => { /* logged inside */ })
      },
    },
  }
}
```
Export `maybeRefreshReport` re-export from `background.ts` if needed, or keep
the import internal to `impl.ts`.

### `src/plugin.ts` edit
```ts
import astGrepPlugin from "./ast-grep/impl.js"
import astGrepMapPlugin, { tools as mapTools } from "./ast-grep-map/impl.js"

const plugin: Plugin = async (ctx) => {
  const astGrepHooks = await astGrepPlugin(ctx)
  const mapHooks = await astGrepMapPlugin(ctx)
  const sessionCreatedHandlers = [
    astGrepHooks.event?.["session.created"],
    mapHooks.event?.["session.created"],
  ].filter(Boolean) as Array<(e: any) => Promise<void> | void>
  return {
    ...astGrepHooks,
    ...mapHooks,
    event: {
      "session.created": async (e) => {
        for (const h of sessionCreatedHandlers) {
          try { await h(e) } catch { /* each handler swallows its own errors */ }
        }
      },
    },
    tool: { ...(astGrepHooks.tool ?? {}), ...(mapHooks.tool ?? {}) },
  }
}
```
**Verify** the exact `Plugin` event-handler type from `@opencode-ai/plugin`
before finalizing — if `event["session.created"]` already accepts an array, no
composer is needed.

## D. Instructions file — `src/skills/ast-grep/references/repo-briefing.md`

Short, agent-facing. Loaded by the ast-grep skill (already in
`.opencode/skills/ast-grep` → `src/skills/ast-grep` symlink; see `AGENTS.md`).

Content (approximately):
> ## Repo briefing (auto-generated)
> On startup the ast-grep plugin writes `.ast-grep/REPORT.md` — read it **first**
> when orienting in an unfamiliar repo, before grepping or running `ast_grep_map`.
> Sections:
> - **God nodes / hubs** — entry-point files by PageRank and distinct referencers.
> - **Surprising cross-module connections** — high-weight edges across top-level dirs.
> - **Module dependency graph** — mermaid rendering of dir→dir coupling.
> - **Orphan / under-referenced defs** — files with defined-but-unreferenced symbols.
> - **Multi-definer ambiguity** — idents with multiple definition sites (resolution risk).
>
> All relationships are AST-extracted; no inference. To force refresh, delete
> `.ast-grep/graph.json` and restart, or call `ast_grep_map` with `refresh:"always"`.

### `SKILL.md` edit
One line under the existing description: "On startup the plugin also writes
`.ast-grep/REPORT.md` — see [Repo briefing](references/repo-briefing.md)."

## E. Test plan — `test/ast-grep-map/report.ts`

Follows the existing smoke-test convention (run with
`node --experimental-strip-types`, see `AGENTS.md`).

1. **Synthetic graph fixture** — 4 files across 2 top-level dirs
   (`src/a.ts`, `src/b.ts`, `cmd/c.ts`, `cmd/d.ts`), one orphan
   (`cmd/d.ts` only self-edges), one multi-definer ident (`fooBar` defined in
   both `src/a.ts` and `src/b.ts`), one cross-module edge
   (`cmd/c.ts → src/a.ts` on ident `helper`).
2. **Section assertions** on `generateReport(graph)`:
   - `## God nodes / hubs` heading present; `src/a.ts` listed.
   - `## Surprising cross-module connections` lists the `cmd/c.ts → src/a.ts` edge.
   - `## Module dependency graph` contains a `mermaid` fenced block referencing both `src` and `cmd`.
   - `## Orphan / under-referenced defs` lists `cmd/d.ts`.
   - `## Multi-definer ambiguity` lists `fooBar` with definer count 2.
3. **`maybeRefreshReport` idempotency** in a temp dir:
   - First call writes `REPORT.md` and `graph.json` → returns `fresh` (or `rebuilt`).
   - Second call with no file changes → returns `skipped`, does not rewrite `REPORT.md` (assert mtime unchanged).
   - Touch one source file → third call returns `rebuilt`, `REPORT.md` mtime advances.

## F. Hard constraints (from `AGENTS.md`) respected

- **opencode discovery unchanged** — shim stays at `.opencode/plugins/ast-grep.ts`,
  skill stays at `.opencode/skills/ast-grep` (symlink). No new files in
  `.opencode/`.
- **Extract subprocess unchanged** — `extract.mjs` location and
  `resolveExtractScript` are untouched. Background path uses the same
  `extractAllTags` entry point.
- **`.ts`-extension imports** — `src/*.ts` files keep extensionless imports
  (for `tsc` emit). Tests and the shim keep `.ts` extensions.
- **`sg run` exit semantics** — not touched (no ast-grep binary involvement).
- **No new runtime deps** — pure TS, `node:` builtins only. Reuses tree-sitter
  indirectly via the existing `extractAllTags` subprocess.
- **`node_modules` / `dist` / `.ast-grep` / `.opencode/runtime`** stay gitignored.
  New `REPORT.md`, `report.log`, `.report.lock` all live under `.ast-grep/` and
  are therefore gitignored.

## G. Verification

1. `npm run typecheck` — `tsc --noEmit` must pass (covers `src` + `test` + shim).
2. `npm test` — both existing smoke suites + the new `report.ts` suite pass.
3. Manual end-to-end:
   - Delete `.ast-grep/` in this repo.
   - Restart opencode (or trigger `session.created`).
   - Confirm `.ast-grep/graph.json` and `.ast-grep/REPORT.md` both appear.
   - Open `REPORT.md` on GitHub — confirm all 5 sections render and mermaid
     block renders.
4. Idempotency: restart again with no source changes — confirm `REPORT.md`
   mtime is unchanged (skipped path).
5. Stale-cache invalidation: `touch src/plugin.ts`, restart — confirm
   `REPORT.md` is regenerated.

## H. Risk register

1. **Two concurrent sessions on the same repo** — both try to rebuild.
   Mitigation: PID lockfile with 5-min staleness. Worst case (race): both write
   the same content; last writer wins. Acceptable.
2. **Large-repo first-run latency** — extract + PageRank over many files.
   Mitigation: existing `EXTRACT_TIMEOUT_MS = 120_000`; subsequent runs are
   mtime-cached. If this becomes a real problem, revisit the "only refresh
   existing graphs" decision (currently: build from scratch on first run per
   user decision).
3. **`Plugin` event-handler signature mismatch** — if `event["session.created"]`
   doesn't accept the shape we assume, `plugin.ts` wiring fails at load time.
   Mitigation: check `@opencode-ai/plugin` types first; fall back to a single
   composed handler.
4. **Errors invisible to the user** — background failure won't surface in chat.
   Mitigation: `.ast-grep/report.log` + (optionally) a one-line warning comment
   at the top of `REPORT.md` when generated from a stale graph.
5. **Mermaid block too large on big repos** — module dependency graph could
   have dozens of nodes. Mitigation: cap displayed edges (top N by weight);
   note truncation in the section.

## Out of scope (explicit non-goals)

- **LLM-driven features** — no "suggested questions", no `// NOTE:` / `// HACK:`
  extraction, no semantic inferred edges. Local-only per `AGENTS.md`.
- **Writing to user `AGENTS.md`** — graphify-style always-on injection. The
  instructions file in the skill achieves the same effect less intrusively; can
  revisit if a stronger always-on mechanism is wanted.
- **HTML / interactive visualization** — graphify's `graph.html`. Out of scope;
  the persisted `graph.json` already supports future viz consumers.
- **New `ast_grep_report` tool / `report: true` flag** — not needed since
  generation happens automatically in the background. The existing
  `ast_grep_map` tool with `refresh:"always"` is the manual escape hatch.
