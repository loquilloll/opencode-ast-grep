---
name: ast-grep
description: "Use ast-grep (sg) for AST-aware code search and rewrite across 25 languages. Trigger for structural code matching or deterministic codemods: find every function/call/class/import shaped like X, rewrite console.log to logger.info, strip `as any`, migrate require() to import, find empty catch blocks or missing await, and scan/apply YAML rules. Prefer this over rg/grep when the target is syntax shape rather than text; use rg for string contents, comments, filenames, or regex-style byte searches. Also provides ast_grep_map, an aider-style repo map ranked by PageRank for orienting in or prioritizing work across an unfamiliar codebase."
---

# ast-grep

`sg` (also installed as `ast-grep`) is an **AST-aware search and rewrite tool** across 25 languages. It treats your pattern as code, parses it the same way it parses your project, and matches structurally. It is the right tool whenever your question depends on **code shape** rather than text bytes.

This skill ships a Python wrapper at `scripts/ast_grep_helper.py` and platform install scripts at `install.sh` (POSIX) and `install.ps1` (Windows). The helper adds offline pattern validation, the two-pass write trick, and binary auto-resolution. Use it as your default entry point.

> **In opencode**, the native `ast_grep_search` / `ast_grep_replace` / `ast_grep_scan` / `ast_grep_validate` / `ast_grep_map` tools wrap the helper and `sg` directly and are preferred over shelling out when available. `ast_grep_map` exists **only** as a native tool (it has no `sg` command or helper subcommand) — see [§ ast_grep_map](#ast_grep_map--repo-map-with-pagerank) below.

---

## When to use this skill

Use it whenever the user's question is about **code structure**, not bytes:

- "Find every function that takes a `Request` parameter."
- "Rewrite every `console.log(x)` to `logger.info(x)`."
- "Strip every `as any` cast."
- "Replace `require(...)` with `import` across the repo."
- "Find empty catch blocks."
- "Migrate `Optional[X]` to `X | None`."
- "Apply this codemod across these 200 files."
- "Run our YAML lint rules and surface violations."

Switch to plain `grep` / `rg` when the question is text-shaped (string literal contents, comments, license headers, file names, cross-language regex). When in doubt, ask: "does the answer depend on the language's syntax tree, or just on the file's bytes?" If the former, ast-grep. If the latter, grep.

---

## Three things the agent must internalize

### 1. ast-grep is NOT regex

The wildcards are `$VAR` (one AST node) and `$$$` (zero or more nodes). Regex syntax fails silently:

| You wrote | What ast-grep saw | What you wanted |
|---|---|---|
| `foo\|bar` | bitwise-or of `foo` and `bar` | run two separate searches |
| `.*foo` | not parseable | `$$$ foo` (if `$$$` is a list of nodes) or use `rg` |
| `\w+` | not parseable | `$VAR` to capture any identifier |
| `[a-z]` | character class, not parseable | switch to `rg` |

The full anti-pattern table is in `references/pitfalls.md` §1. The helper's `validate` subcommand catches these mechanically — call it before debugging "no matches" by hand.

### 2. Patterns must be valid code

The pattern itself must parse. `def $FN($$$):` fails because the trailing `:` makes it incomplete; use `def $FN($$$)`. `function $NAME` without params/body fails; use `function $NAME($$$) { $$$ }`. Full table per language in `references/pitfalls.md` §2.

### 3. `--update-all` and `--json` are mutually exclusive (silently)

This is the single biggest gotcha when scripting. `sg run -p P -r R --json --update-all` returns the JSON but **does not mutate files**. To both preview AND apply, run **two passes**:

```bash
sg run -p P -r R --json=compact .   # pass 1: see what would change
sg run -p P -r R --update-all .     # pass 2: actually apply
```

The helper does this automatically when you call `replace --apply`. Read `references/pitfalls.md` §9.

---

## The helper script — `scripts/ast_grep_helper.py`

A single-file Python 3 stdlib wrapper. Same on every OS. The agent's default entry point.

### `search` — find all matches of a pattern

```bash
python3 scripts/ast_grep_helper.py search 'console.log($MSG)' --lang ts src/
```

Validates the pattern offline first. If the pattern looks like regex (`\w`, `.*`, `|`, etc.) the helper exits with a hint and never calls `sg` — saves a round-trip. Pass `--force` to skip validation.

Flags:
- `--lang ts` (or any of the 25 languages; aliases like `js`, `py`, `rs`, `kt` accepted)
- `--globs '!**/*.test.ts'` (repeatable; prefix `!` to exclude)
- `-C 3` (context lines)
- `--json-out` (raw JSON instead of human format)

### `replace` — rewrite by pattern, dry-run by default

```bash
# Dry-run preview (default — no files mutated)
python3 scripts/ast_grep_helper.py replace 'console.log($MSG)' 'logger.info($MSG)' --lang ts src/

# Actually apply
python3 scripts/ast_grep_helper.py replace 'console.log($MSG)' 'logger.info($MSG)' --lang ts src/ --apply
```

The helper:
1. Validates both `pattern` and `rewrite` for hint-detectable mistakes.
2. Runs pass 1 with `--json=compact` to collect matches and show a preview.
3. If `--apply` is set, runs pass 2 with `--update-all` to mutate files.

### `scan` — run YAML rules

```bash
# Discover sgconfig.yml from cwd and run all rules
python3 scripts/ast_grep_helper.py scan src/

# Run a single rule file
python3 scripts/ast_grep_helper.py scan -r rules/no-console.yml src/

# Apply auto-fixes
python3 scripts/ast_grep_helper.py scan -U src/

# CI-friendly GitHub annotations
python3 scripts/ast_grep_helper.py scan --report-style short src/
```

### `validate` — offline pattern check (no `sg` call)

Useful for CI lints, pre-commit hooks, and quick sanity checks:

```bash
python3 scripts/ast_grep_helper.py validate '\w+' --lang ts
# → exit 2: regex \w not supported. Use $VAR for identifiers.

python3 scripts/ast_grep_helper.py validate 'console.log($MSG)' --lang ts
# → exit 0: pattern looks plausible for ast-grep.
```

### `langs` / `doctor` / `install`

```bash
python3 scripts/ast_grep_helper.py langs       # list 25 supported languages and aliases
python3 scripts/ast_grep_helper.py doctor      # check ast-grep binary availability
python3 scripts/ast_grep_helper.py install     # delegate to install.sh / install.ps1
```

`new` and `test` subcommands proxy directly to `sg new` and `sg test`.

---

## Direct `sg` use (when the helper isn't enough)

The helper is opinionated. For full control, drop to `sg`. The skill ships a CLI cheat sheet in `references/cli.md`. The minimal idioms:

```bash
# Search
sg run -p 'console.log($MSG)' --lang ts src/

# Search with JSON for scripting
sg run -p 'console.log($MSG)' --lang ts --json=compact src/ | jq '.[] | .file'

# Rewrite, dry-run
sg run -p 'console.log($MSG)' -r 'logger.info($MSG)' --lang ts --json=compact src/

# Rewrite, apply
sg run -p 'console.log($MSG)' -r 'logger.info($MSG)' --lang ts --update-all src/

# Pattern from stdin (great for ad-hoc experiments)
echo 'console.log("hi")' | sg run -p 'console.log($MSG)' --lang js --stdin

# Debug a pattern that returns 0 matches
sg run -p '<your pattern>' --lang <lang> --debug-query=ast --stdin <<< '<sample-code>'

# Run YAML rules
sg scan src/

# Inline YAML rule (one-off)
sg scan --inline-rules '
id: no-todo
language: TypeScript
severity: warning
rule: { pattern: TODO }' src/
```

When using `sg` directly in a shell, **always single-quote patterns** so `$VAR` is not expanded by the shell.

---

## ast_grep_map — repo map with PageRank

A **native opencode tool** (no `sg` command, no helper subcommand). It produces an **aider-style repo map**: a compact outline of symbol declarations, each annotated with a GitHub-style line range (`L<n>` for one-liners, `L<start>-L<end>` for spans), ranked by **PageRank** so the most-referenced symbols surface first. The PageRank graph (files as nodes, reference→definition edges) is built from the whole worktree and **persisted to `<worktree>/.ast-grep/graph.json`** (schema v2: primary worktree graph + scope-keyed PPR snapshot overlays).

On session startup the plugin also writes **`.ast-grep/REPORT.md`** — a markdown briefing derived from the same graph (god-node hubs, surprising cross-module edges, module dependency graph, orphaned defs, multi-definer ambiguity). Read it first when orienting in an unfamiliar repo. See [references/repo-briefing.md](references/repo-briefing.md) for what each section means and when to trust it.

Use it to **orient in or prioritize work across a codebase** — "what's in this repo, what matters most, where does X live" — without reading every file. It is the structural analogue of `rg` for *understanding* a codebase rather than *finding text in* one.

Symbol extraction uses tree-sitter with aider's verbatim `-tags.scm` queries. Supported languages: **ts, tsx, js, py, go, rs, cpp** (a subset of the 25 `sg` languages — map needs per-language tree-sitter grammars).

### When to reach for it

- "Give me an overview of this codebase / this directory."
- "What are the most important files/symbols here?"
- "Where is `buildGraph` defined and how big is it?" (the range tells you the extent)
- Picking where to start a refactor: the highest-ranked symbols are the load-bearing ones.
- Replacing a dozen `ast_grep_search`/`rg` calls to locate definitions across files.

Don't use it for: text search (use `rg`), a single structural match (use `ast_grep_search`), or cross-repo navigation.

### Args

| Arg | Default | Purpose |
|---|---|---|
| `paths` | whole worktree | Files/dirs to include in the **output** map AND to seed Personalized PageRank toward. The worktree graph is always built from all code files; `paths` biases the ranking. |
| `globs` | — | Include/exclude globs for the output map (`!` prefix to exclude). Also contributes to PPR seed construction. |
| `lang` | — | Restrict to one language (`ts`, `tsx`, `js`, `py`, `go`, `rs`, `cpp`). |
| `max_tokens` | 1024 | Token budget for the rendered map (×8 when no `paths`/`globs` given). |
| `mentioned_idents` | — | Symbol names to boost in ranking. Each ident seeds files whose path components include the ident (aider "mentioned_idents" heuristic). |
| `refresh` | `auto` | `auto` = reuse the cached worktree graph if the source manifest (mtime+size) is unchanged AND the scope snapshot is fresh; `always` = rebuild. |
| `json` | false | Return the persisted v2 cache payload (version, worktreeGraph, scopes[], nextEpoch) as JSON instead of the rendered map. |

### Output format

Path is shown once per file; each symbol is its declaration + a right-aligned range:

```
src/ast-grep-map/impl.ts:
   L217-L259  function buildGraph(input: BuildInput): Graph {
   L269-L336  function pageRank(
       L410  function renderTree(rankedTags: RankedTag[]): string {
```

Distinct symbols that share a source line (e.g. an object literal's shorthand methods, or a type with an inline method) render distinctly using each symbol's own text.

### Scope-overlay + Personalized PageRank

When `paths`, `globs`, or `mentioned_idents` are given, the worktree PageRank graph is reused but the personalization vector is rebuilt from those files (each matching file becomes a weight-1 seed). This is **Personalized PageRank** — symbols in or near the scoped files surface higher than they would under uniform personalization. The resulting rank snapshot is cached per-scope in `graph.json`'s `scopes[]` array, keyed by `{paths, globs}` + the seed fingerprint, so the next call with the same scope reuses it without re-running PPR.

Unscoped calls (`paths`/`globs`/`mentioned_idents` all empty) skip PPR entirely and use the uniform-personalization scores stored in the worktree graph cache — byte-identical to the pre-PPR-output behavior.

For debug/exploration, the `OP_AST_GREP_MAP_SEED_PATHS` env var (`;`,`,` or newline-separated workspace-relative paths) injects additional weight-1 seeds tagged `source: "debug-seed-path"` into every scope's PPR.

### Notes

- The graph is cached at `<worktree>/.ast-grep/graph.json` (gitignored, schema v2). `refresh:"auto"` skips rebuilding when the source manifest (mtime+size) is unchanged — cheap to re-run.
- **Auto-invalidation on edits.** The plugin subscribes to `file.edited`, `file.watcher.updated`, and `tool.execute.after` (for `edit`/`write` tools). Each edit flips the matching scope snapshot's `refreshState.stale` flag (cheap; no rebuild). The next `ast_grep_map` call detects stale state and rebuilds only what's needed. The worktree graph itself is manifest-gated (mtime+size) so edits outside any cached scope trigger a manifest mismatch on the next call and rebuild the worktree graph.
- PageRank reproduces networkx defaults (damping 0.85, 100 iterations, tol 1e-6); PPR overlays use the same defaults.
- Token counting uses a `length/4` proxy (no model tokenizer in the plugin).
- The cache schema is v2 (older v1 caches are rejected on read with a one-time stderr hint; the first call after upgrade rebuilds from scratch).

---

## Decision tree — what to use, when

```
USER asks for "find/rewrite/codemod"
│
├─ structural pattern (function shape, call, class, import, control flow)
│  └→ ast-grep (this skill): ast_grep_search / ast_grep_replace
│
├─ overview / orient / prioritize ("what's in this repo", "what matters most", "where does X live")
│  └→ ast_grep_map (PageRank-ranked symbol outline)
│
├─ text pattern (regex, alternation, character classes, file names)
│  └→ rg / grep
│
├─ semantic question (what variable does this refer to? does this throw?)
│  └→ LSP tools, TypeScript compiler, Pyright, Semgrep with type inference
│
└─ multiple repos / federated search
   └→ a search engine + then ast-grep / rg / LSP per-repo
```

If the user says "find all" or "every", default to ast-grep when the target is shaped (function, class, call, import, statement). Default to rg when the target is text (string content, comment, license header, file name, identifier substring).

---

## Always run dry-run first when rewriting

A bad pattern silently rewrites the wrong thing. The helper's `replace` defaults to dry-run for this reason. The flow is:

1. Search to confirm matches: `helper search '<pattern>' --lang X .`
2. Dry-run rewrite: `helper replace '<pattern>' '<rewrite>' --lang X .` (no `--apply`)
3. Inspect the dry-run summary: number of matches, files affected, the per-location preview.
4. If wrong: refine pattern, go back to step 1.
5. If right: `helper replace '<pattern>' '<rewrite>' --lang X . --apply`.

Never apply a rewrite that you have not first dry-run.

---

## When `sg` returns 0 matches but you know the code is there

In priority order:

1. **Run `helper validate '<pattern>' --lang <lang>`** — catches regex misuse, missing function bodies, Python trailing colons.
2. **Check `--lang`** — `sg` infers from extension; if you pass a `.tsx` file with `--lang ts` (not `tsx`), JSX won't parse.
3. **Inspect the parsed pattern**: `sg run -p '<pattern>' --lang <lang> --debug-query=ast --stdin <<< '<sample>'`. If it shows `ERROR` nodes, the pattern is malformed.
4. **Check the AST of the target file**: `sg run -p '$_' --lang <lang> --debug-query=cst path/to/file | head -40` — find the `kind` you're trying to match.
5. **Try the playground**: <https://ast-grep.github.io/playground.html> — paste code + pattern, see what's happening.

Do not blindly retry with variations. Each failure has a reason; surface it.

---

## When to use YAML rules vs inline `-p` patterns

**Use inline `-p`** when:
- One-off ad-hoc query.
- The pattern is simple (no constraints, no fix template).
- You're exploring.

**Use YAML rules** (file under `rules/`, run via `sg scan`) when:
- The pattern is reused (lint rule, codemod that runs in CI).
- You need `constraints`, `transform`, complex `inside`/`has`, or composite logic.
- You want auto-fix (`fix:` field).
- You want to test the rule (snapshot tests via `sg test`).

The full YAML rule schema is in `references/yaml-rules.md`. Project setup (`sgconfig.yml`, `ruleDirs`, `utilDirs`) is in `references/sgconfig.md`.

---

## Output discipline

- `sg run --json=compact` produces an array of match objects: `{ file, range: {start, end}, text, replacement?, lines, language, ... }`. Pipe through `jq` for further processing.
- Without `--json`, `sg` produces human-readable colored output suitable for terminals.
- The helper's default output is human-readable (file:line:column + match preview). Pass `--json-out` for raw JSON.
- The helper's `replace` always summarizes: number of matches, number of files, per-location preview.

When summarizing for the user, **always include the count of files affected**, not just the count of matches. Users care about blast radius.

---

## Required reading (in order of priority)

1. `references/patterns.md` — meta-variables, naming rules, strictness levels. Read when you're unsure why a pattern doesn't match.
2. `references/pitfalls.md` — the failure-mode field guide. Read when 0 matches surprises you.
3. `references/recipes.md` — copy-paste patterns by language. Read first when you start a new task.
4. `references/cli.md` — `sg run`, `sg scan`, `sg test`, `sg new`, `sg lsp`. Read when the helper isn't enough.
5. `references/yaml-rules.md` — YAML rule schema. Read when you outgrow inline patterns.
6. `references/sgconfig.md` — project-level configuration. Read when you set up `sg scan` for a real project.
7. `references/install.md` — per-OS install methods. Read only if `install.sh` / `install.ps1` fail.

---

## Invariants (do not break)

- **Validate before searching.** When emitting a pattern programmatically, call `helper validate` first. It catches the regex-misuse class of mistakes that account for ~70% of "0 matches" debug sessions.
- **Dry-run before applying.** Never run `sg run -r ... --update-all` without first inspecting the matches. The helper's `replace` enforces this by default.
- **Two-pass writes.** When using `sg` directly to both preview and apply, run two invocations — `--json` ignores `--update-all`.
- **Single-quote patterns in shell.** `'$VAR'` not `"$VAR"`. The shell expands `$VAR` to the empty string in double quotes, breaking the pattern.
- **Pattern is code, not regex.** When the pattern would need `|`, `.*`, `\w`, or `[a-z]`, switch to `rg` instead. Don't try to force ast-grep into a regex shape.
- **`--lang` is required for stdin.** When piping with `--stdin`, set `--lang` explicitly; `sg` cannot infer from extension.
- **Linux: prefer `ast-grep` over `sg`** because `sg` collides with `setgroups`. The helper handles this; if you call `sg` directly, alias it: `alias sg=ast-grep`.
