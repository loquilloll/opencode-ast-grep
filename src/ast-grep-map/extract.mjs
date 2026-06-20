// ast_grep_map tag extractor (standalone Node subprocess).
//
// The opencode plugin (which runs inside opencode's bundled runtime, where
// tree-sitter's native N-API addons may not load) spawns THIS script under a
// real `node` process to do all tree-sitter work. It reads absolute file paths
// from stdin (one per line) and prints a JSON array of tags to stdout.
//
//   usage: node ast-grep-map-extract.mjs <worktreeAbs>
//   stdin: <absFilepath>\n ...
//   stdout: [{ rel_fname, fname, line, name, kind, contextLines }, ...]
//
// Queries are resolved relative to this script's own location (real Node, so
// import.meta.url is reliable). tree-sitter grammars resolve from the sibling
// node_modules.

import { readFileSync } from "node:fs"
import { dirname, resolve, relative, join } from "node:path"
import { fileURLToPath } from "node:url"

import Parser from "tree-sitter"
import TS from "tree-sitter-typescript"
import JS from "tree-sitter-javascript"
import PY from "tree-sitter-python"
import GO from "tree-sitter-go"
import RS from "tree-sitter-rust"
import CPP from "tree-sitter-cpp"

const here = dirname(fileURLToPath(import.meta.url))
const QUERIES_DIR = join(here, "queries")

// Canonical language -> { exts, descriptor (whole module for non-TS), scm }.
// tree-sitter@0.25.0's Query/setLanguage need the whole {language,nodeTypeInfo}
// descriptor — passing bare `.language` throws "reading 'N'".
const LANGS = {
  typescript: { exts: [".ts", ".cts", ".mts"], desc: TS.typescript, scm: "typescript-tags.scm" },
  tsx: { exts: [".tsx"], desc: TS.tsx, scm: "typescript-tags.scm" },
  javascript: { exts: [".js", ".jsx", ".cjs", ".mjs"], desc: JS, scm: "javascript-tags.scm" },
  python: { exts: [".py", ".pyi"], desc: PY, scm: "python-tags.scm" },
  go: { exts: [".go"], desc: GO, scm: "go-tags.scm" },
  rust: { exts: [".rs"], desc: RS, scm: "rust-tags.scm" },
  cpp: { exts: [".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".h"], desc: CPP, scm: "cpp-tags.scm" },
}

const IDENT_RE = /[A-Za-z_$][\w$]*/g

const _parser = new Map()
const _query = new Map()
function toolFor(lang) {
  if (_parser.has(lang)) return _parser.get(lang)
  const def = LANGS[lang]
  let result = null
  try {
    const p = new Parser()
    p.setLanguage(def.desc)
    const scm = readFileSync(join(QUERIES_DIR, def.scm), "utf8")
    const q = new Parser.Query(def.desc, scm)
    result = { parser: p, query: q }
  } catch (e) {
    process.stderr.write(`ast-grep-map: language "${lang}" unavailable: ${e.message}\n`)
  }
  _parser.set(lang, result)
  return result
}

function langFor(absPath) {
  for (const [lang, def] of Object.entries(LANGS)) {
    if (def.exts.some((e) => absPath.endsWith(e))) return lang
  }
  return null
}

function extractTags(fname, relFname) {
  const lang = langFor(fname)
  const tool = lang ? toolFor(lang) : null
  if (!tool) return []
  let code
  try {
    code = readFileSync(fname, "utf8")
  } catch {
    return []
  }
  const tags = []
  let sawDef = false
  let sawRef = false
  try {
    const tree = tool.parser.parse(code)
    const captures = tool.query.captures(tree.rootNode)

    // Index definition nodes and associate each with its name (the name node's
    // nearest @definition.* ancestor). Handles nested shapes like JS
    // lexical_declaration > variable_declarator > identifier.
    const defNodeSet = new Set()
    const defNodes = []
    for (const cap of captures) {
      if (cap.name.startsWith("definition.")) {
        if (!defNodeSet.has(cap.node)) {
          defNodeSet.add(cap.node)
          defNodes.push(cap.node)
        }
      }
    }
    const defToName = new Map()
    for (const cap of captures) {
      if (!cap.name.startsWith("name.definition.")) continue
      let p = cap.node.parent
      while (p && !defNodeSet.has(p)) p = p.parent
      if (p && !defToName.has(p)) defToName.set(p, String(cap.node.text || ""))
    }

    for (const defNode of defNodes) {
      const name = defToName.get(defNode)
      if (!name) continue
      const start = defNode.startPosition.row
      const end = defNode.endPosition.row
      // decl = the symbol's OWN first line (node text), not the file line — so
      // two symbols declared inline on the same source line (e.g. an object
      // literal's shorthand methods, or a type with an inline method) render
      // distinctly instead of duplicating the shared parent line.
      const decl = String(defNode.text || "").split(/\r?\n/)[0].slice(0, 120).trimEnd()
      tags.push({ rel_fname: relFname, fname, line: start, endLine: end, name, kind: "def", decl })
      sawDef = true
    }

    for (const cap of captures) {
      if (cap.name.startsWith("name.reference.")) {
        tags.push({ rel_fname: relFname, fname, line: cap.node.startPosition.row, name: String(cap.node.text || ""), kind: "ref", endLine: cap.node.startPosition.row, decl: "" })
        sawRef = true
      }
    }
  } catch {
    return []
  }
  // Reference backfill (aider uses Pygments; we tokenize identifiers). Only
  // when the query yielded defs but NO refs.
  if (sawDef && !sawRef) {
    IDENT_RE.lastIndex = 0
    let m
    while ((m = IDENT_RE.exec(code)) !== null) {
      tags.push({ rel_fname: relFname, fname, line: -1, endLine: -1, name: m[0], kind: "ref", decl: "" })
    }
  }
  return tags
}

function main() {
  const worktree = process.argv[2]
  const chunks = []
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (c) => chunks.push(c))
  process.stdin.on("end", () => {
    const input = chunks.join("")
    const files = input.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const all = []
    for (const f of files) {
      const rel = relative(worktree, f)
      const tags = extractTags(f, rel)
      for (const t of tags) all.push(t)
    }
    process.stdout.write(JSON.stringify(all))
  })
}

main()
