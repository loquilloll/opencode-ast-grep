// Copies non-TypeScript build assets into dist/ after tsc emits the .js.
//   - src/ast-grep-map/extract.mjs  -> dist/ast-grep-map/extract.mjs
//   - src/ast-grep-map/queries/*.scm -> dist/ast-grep-map/queries/
// The extractor is a plain JS subprocess (spawned by `node`) and the .scm
// queries are tree-sitter query files; tsc leaves both behind, so we ship them.
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const srcMap = join(root, "src", "ast-grep-map")
const distMap = join(root, "dist", "ast-grep-map")

function copy(srcRel, destRel) {
  const from = join(root, srcRel)
  const to = join(root, destRel)
  try {
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log(`  copied ${srcRel} -> ${destRel}`)
  } catch (e) {
    if (e.code !== "ENOENT") throw e
    console.log(`  skip ${srcRel} (not found)`)
  }
}

console.log("copying build assets...")
copy("src/ast-grep-map/extract.mjs", "dist/ast-grep-map/extract.mjs")
copy("src/ast-grep-map/queries", "dist/ast-grep-map/queries")
console.log("done.")
