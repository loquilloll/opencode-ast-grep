# Startup performance investigation: ast-grep-map init-time worktree scan

**Date:** 2026-07-10
**Status:** Diagnosed (root cause confirmed). Fix not yet applied.
**Reporter:** opencode session, working directory `C:\Users\alvins\.config\opencode`

## TL;DR

The `ast_grep_map` plugin spends **~24 s** at opencode startup by recursively
scanning the entire worktree root. The scan is misplaced: it runs in the
plugin's init function to obtain a worktree *path* for cheap cache hydration,
but the function it calls (`resolveRoot`) probes for code files via a recursive
`readdirSync` walk. When the worktree root is large (worst case: the user's
home directory, which is itself a git repo), the walk dominates startup.

- **Offending call:** `src/ast-grep-map/impl.ts:1424` — `resolveRoot(input)` inside `astGrepMapPlugin`.
- **Expensive primitive:** `resolveRoot` → `discoverCodeFiles` → `readdirSync` walk (`src/ast-grep-map/impl.ts:758`, `:396`, `:404`).
- **Intended init work is cheap:** `initializeGraphPlugin` is just a `readFileSync` of an usually-absent cache file (`src/ast-grep-map/graph-service.ts:71` → `:62`).
- **Cost scales with worktree size:** ~24 s for the user's home, ~9 s for a large project, <1 s for a small repo. It is pure local I/O — identical online and offline.

## Symptoms

- opencode cold startup takes 30 s+.
- Identical with network disabled (rules out npm registry resolution / provider model-list fetches).
- Perceived as "one of the plugins."

## Methodology

1. `opencode debug config` (loads all plugins, one-shot, no LLM) used as a
   startup proxy. Timed with `Measure-Command`.
2. `opencode debug config --pure` as the no-plugin baseline.
3. Plugin bisection: disable plugin groups, re-measure, restore.
4. Timestamp instrumentation added to the bundle's `plugin.js` (since restored)
   to localize the cost to `astGrepMapPlugin` vs `astGrepPlugin`.
5. Standalone `node`/`bun` import of the bundle to separate bundle code from
   opencode's loader.
6. `opencode` source (`packages/opencode/src/plugin/loader.ts`) read to confirm
   the loader only does `await import(entry)` in parallel — no install step at
   startup.

## Measurements

Run from `C:\Users\alvins\.config\opencode` unless noted. `debug config` includes
full plugin load; `--pure` skips all external plugins.

| Configuration | Elapsed |
|---|---|
| `--pure` (no plugins) | 2.0 s |
| All plugins | 26.9 s |
| npm plugins disabled (local only) | 25.0 s |
| `ast-grep.ts` + `zai.ts` disabled | 4.1 s |
| `ast-grep.ts` disabled only (zai stays) | 3.7 s |
| All plugins, from a normal project (`opencode-v1.17.9`) | 11.0 s |
| Standalone `node` import of the bundle | 0.34 s |
| Standalone `bun` import of the bundle | 0.26 s |

Instrumentation inside the plugin entry (`plugin.js`, later reverted):

| Phase | Elapsed |
|---|---|
| module-evaluated → plugin-fn-start | 139 ms |
| `astGrepPlugin` (search/replace/scan/validate) body | 0 ms |
| `astGrepMapPlugin` body | **24 254 ms** |

`astGrepMapPlugin`'s body contains exactly one awaited call before `return`:
`await initializeGraphPlugin(worktree)` at `src/ast-grep-map/impl.ts:1429`, fed
by `const worktree = resolveRoot(input)` at `:1424`. The cost is in
`resolveRoot`, not in `initializeGraphPlugin`.

## Root cause

### The call chain

```
astGrepMapPlugin(input)                      src/ast-grep-map/impl.ts:1423
  └─ worktree = resolveRoot(input)           src/ast-grep-map/impl.ts:1424   ← EXPENSIVE
       └─ for each candidate root:
            discoverCodeFiles(root)          src/ast-grep-map/impl.ts:758 → :396
              └─ readdirSync(dir)            src/ast-grep-map/impl.ts:404   ← recursive walk
  └─ await initializeGraphPlugin(worktree)   src/ast-grep-map/impl.ts:1429  ← CHEAP (readFileSync)
       └─ getOrCreateWorkspaceGraphState     src/ast-grep-map/graph-service.ts:49
            └─ readPersistedGraphCache        src/ast-grep-map/graph-service.ts:62
                 └─ readFileSync(.ast-grep/graph.json)   returns null if absent
```

### Why `resolveRoot` is expensive

`resolveRoot` (`src/ast-grep-map/impl.ts:758`) picks a root by probing
`discoverCodeFiles(root).length > 0` for each candidate until one contains
supported source files. `discoverCodeFiles` (`:396`) walks the tree with
`readdirSync` (`:404`). The exclude list (`:125`) skips only
`node_modules, .git, .hg, .svn, .ast-grep, .opencode, .sandcastle` — it does
**not** skip `AppData`, `Documents`, `Downloads`, `.cache`, etc.

### Why the worktree root is the user's home

`C:\Users\alvins` is itself a git repository, so:

```
git -C C:\Users\alvins\.config\opencode rev-parse --show-toplevel
# => C:/Users/alvins
```

opencode reports `ctx.worktree` as the git worktree root, so for sessions
launched from `~/.config/opencode` the worktree root is the entire home
directory. `resolveRoot` then scans `AppData`, `Documents`, `Downloads`,
`.cache`, … — ~24 s of `readdirSync` + `lstatSync`.

### Why `resolveRoot` does not belong at init

`resolveRoot` (with its code-file probe) is correct in the `ast_grep_map`
tool's `execute` (`src/ast-grep-map/impl.ts:793`), where it must find the real
graphing root on each invocation. At init, the plugin only needs a worktree
*path* to locate the cache file for `readPersistedGraphCache` — and that
hydration is a single `readFileSync` that returns `null` when no cache exists
(the common case). The probe is misplaced.

The init block's own comment (`src/ast-grep-map/impl.ts:1425`-ish) concedes it
is only a first-call optimization ("so the very first ast_grep_map call does
not pay the hydration cost"). The hydration it protects is negligible; the
`resolveRoot` scan it triggers is not.

### Why `debug startup` underreported

`opencode debug startup` printed ~701 ms while `opencode debug config` printed
~27 s. They measure different phases: `debug startup` reports a sub-phase of
the bootstrap, while `debug config` (and the real TUI) fully load and
initialize plugins, which is where the scan occurs. `debug config` is the
representative proxy for TUI startup.

## Why it matches the reported symptoms

- **30 s+:** ~24 s scan + ~2 s baseline ≈ 26–27 s, matching the perceived 30 s+.
- **Same offline:** the scan is pure local filesystem I/O; no network involved.
- **"One of the plugins":** confirmed — the ast-grep plugin. Specifically the
  *map* half, not the search/replace/scan/validate half.

## Fix options

### A. Cheap worktree at init (recommended)

Resolve the worktree cheaply at init without the `discoverCodeFiles` probe, and
defer the real `resolveRoot` to tool execution (where it already runs at
`src/ast-grep-map/impl.ts:793`).

```ts
// src/ast-grep-map/impl.ts:1424 — replace
const worktree = resolveRoot(input)
// with a cheap resolution, e.g.
const worktree = input.worktree || input.directory || "."
```

- **Pro:** startup drops to ~2 s; cache pre-hydration preserved; no functional
  change (the map tool calls `resolveRoot` fresh on each invocation).
- **Con:** the `event`/`tool.execute.after` hooks close over the init-resolved
  `worktree`. For `markStaleForPath` this is fine (it only needs a directory to
  locate the cache). For the background `maybeRefreshReport` (session.created),
  the report would build over the cheaply-resolved root rather than the probed
  git root — verify this is acceptable, or resolve lazily inside that hook.

### B. Drop init hydration entirely

Remove the init `resolveRoot` + `initializeGraphPlugin` block
(`src/ast-grep-map/impl.ts:1424`-`:1432`). The first `ast_grep_map` call
hydrates the cache lazily via its existing `initializeGraphPlugin` call at
`:815`.

- **Pro:** smallest diff; eliminates the scan outright.
- **Con:** the hooks (`event`, `tool.execute.after`) still reference `worktree`
  resolved at init — they would need a cheap worktree resolution too, so this
  collapses into option A in practice.

### C. Widen excludes / respect gitignore in `discoverCodeFiles`

Add `AppData`, `Documents`, `.cache`, etc. to the exclude list, or honor
`.gitignore`.

- **Con:** band-aid. The init scan still runs (just faster), the misplaced
  probe remains, and the home-as-git-repo case still walks un-ignored trees.
  Not recommended as a standalone fix.

### D. Stop tracking home as a git repo

A user-side workaround, not a code fix. The plugin should not scan the worktree
at init regardless of how the user organizes git repos.

### Recommendation

**Option A.** It removes the misplaced scan at init while preserving the
(cache-hydration) intent and leaving tool-time behavior untouched. Apply the
edit in `src/ast-grep-map/impl.ts`, rebuild the bundle, and re-run the
`debug config` timing to confirm startup drops to ~2 s.

## Reproduction

```powershell
# Baseline (all plugins) — slow
Measure-Command { opencode debug config --print-logs --log-level DEBUG *> $null }

# No plugins — fast
Measure-Command { opencode debug config --pure *> $null }

# Confirm worktree root
git -C C:\Users\alvins\.config\opencode rev-parse --show-toplevel
# => C:/Users/alvins   (the entire home dir)

# Confirm the scan is local-only (network-independent)
# Disconnect network, re-run the baseline — time is unchanged.
```

To localize further (temporary, revert after):

```text
# In ast-grep-bundle/plugin.js, add around the plugin entry:
console.error("[AG-T] plugin-fn-start ts=" + Date.now())
const astGrepHooks = await astGrepPlugin(ctx)
console.error("[AG-T] after-astGrepPlugin ts=" + Date.now())
const astGrepMapHooks = await astGrepMapPlugin(ctx)
console.error("[AG-T] after-astGrepMapPlugin ts=" + Date.now())
# The gap between after-astGrepPlugin and after-astGrepMapPlugin is the scan.
```

## Notes

- The `sg` binary provisioning (ast-grep/impl.ts) is **not** involved: the
  binary is present at `runtime/ast-grep/win32-x64/sg.exe`, `findSgBinarySync`
  finds it, and `scheduleBackgroundProvision` returns immediately. The
  search/replace/scan/validate plugin (`astGrepPlugin`) init cost was measured
  at 0 ms.
- The graph build itself (`buildGraph` / `rebuildGraphForReport`) is correctly
  backgrounded via `session.created` + `setTimeout(...).unref()`
  (`src/ast-grep-map/impl.ts` event hook). It is not the startup blocker; the
  `resolveRoot` probe that precedes hydration is.
- The npm plugins (`opencode-websearch`, `@prevalentware/opencode-goal-plugin`,
  `@mohak34/opencode-notifier@latest`) add only ~2 s combined and were
  exonerated by bisection.
