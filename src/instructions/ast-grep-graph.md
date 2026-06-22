## ast-grep-graph

This repo has an ast-grep PageRank graph at `.ast-grep/` (`graph.json` + an auto-generated `REPORT.md` written by the ast-grep plugin on session start).

Rules:
- Before answering architecture or codebase questions, read `.ast-grep/REPORT.md` for god-node hubs, surprising cross-module edges, the module dependency graph, orphaned defs, and multi-definer ambiguity.
- For narrow file-scoped work the user already named a file for, skip the report — use `ast_grep_map` / `ast_grep_search` / `rg` directly. The report is for orientation, not lookup.
- If `.ast-grep/REPORT.md` is missing or stale after non-trivial code changes, regenerate by calling `ast_grep_map` with `refresh:"always"`, or delete `.ast-grep/graph.json` and restart opencode.
- All relationships are AST-extracted (no inference). The multi-definer ambiguity section is the only "fuzzy" signal — disambiguate with `ast_grep_search` before assuming which definition is in play.
- Section legend, provenance, and confidence notes: see the ast-grep skill's `references/repo-briefing.md`.
