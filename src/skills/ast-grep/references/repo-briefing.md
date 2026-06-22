# Repo briefing (`.ast-grep/REPORT.md`)

The ast-grep plugin writes `.ast-grep/REPORT.md` automatically on opencode
startup. It is a markdown briefing derived from the PageRank graph also stored
at `.ast-grep/graph.json`. Read it **first** when orienting in an unfamiliar
repo, before grepping or running `ast_grep_map`.

## When to read it

- The user asks a broad question ("how does X work", "what is the architecture",
  "where do I start to add Y") and you have not yet read any source.
- You are about to make a cross-cutting change and want a map of likely-affected
  modules.
- You want to confirm whether a symbol lives in more than one file (ambiguous
  resolution) before searching.

Skip it for narrow, file-scoped questions where the user already named the
file — the symbol map from `ast_grep_map` is more precise for those.

## What each section means

- **God nodes / hubs** — files with the highest PageRank and distinct-referencer
  counts. These are the central modules and likely entry points. Read these
  first when narrowing down.
- **Surprising cross-module connections** — high-weight edges between files in
  different top-level directories. Non-obvious coupling; the kind of thing that
  bites you during a refactor. Ranked by `weight × ln(1 + module-pair edge
  count)` so high-weight edges between rarely-connected modules surface.
- **Module dependency graph** — a mermaid block showing top-level directory
  coupling with summed edge weights. The macro architecture at a glance.
- **Orphan / under-referenced definitions** — files whose defined symbols have
  no incoming references (only the canonical weight-0.1 self-loop that
  `buildGraph` emits for definers with zero referencers). Candidates for dead
  code or entry-point-only modules.
- **Multi-definer ambiguity** — identifiers defined in more than one file.
  Symbol resolution is ambiguous without disambiguation. Search for these with
  `ast_grep_search` once you know which one you need.

## Provenance and confidence

Every relationship in the report is **EXTRACTED via AST** (tree-sitter def/ref
captures). There is no inference step, no LLM, no semantic guesswork. The
multi-definer list is the closest thing to an "ambiguity" signal.

The report reflects whatever was on disk when `session.created` fired. The
plugin subscribes to `file.edited`, `file.watcher.updated`, and
`tool.execute.after` (for `edit`/`write` tools); each edit flips the matching
scope snapshot's stale flag (cheap; no rebuild) so the next `ast_grep_map`
call rebuilds only what's needed. The worktree graph itself is manifest-gated
(mtime+size), so an edit that changes any tracked file triggers a rebuild on
the next call automatically. If you want to force a refresh of REPORT.md
without editing a file:

- Call `ast_grep_map` with `refresh: "always"` to force a rebuild, or
- Delete `.ast-grep/graph.json` and restart opencode.

Concurrent sessions are guarded by a PID lockfile at `.ast-grep/.report.lock`
(stale after 5 minutes). Failures are appended to `.ast-grep/report.log`.

## What the report does NOT do

- It does not call any LLM, so there are no "suggested questions" or
  `// NOTE:`/`// HACK:` comment extractions (unlike graphify's `GRAPH_REPORT.md`).
  Bring those to the model's attention yourself with `grep`/`rg` if relevant.
- It does not track inferred relationships across languages it doesn't parse.
  Supported: ts, tsx, js, py, go, rs, cpp.
- It does not replace `ast_grep_map` for scoped work — the map is finer-grained
  and respects `paths` / `globs` / `mentioned_idents` personalization.
