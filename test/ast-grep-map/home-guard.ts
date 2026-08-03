// Tests for the hard home-indexing guard.
// Verifies ast_grep_map never walks/indexes the user's home directory, and
// that maybeRefreshReport short-circuits before any filesystem side effect.
// Run: tsx test/ast-grep-map/home-guard.ts
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  isHomeDir,
  discoverCodeFiles,
  resolveRoot,
  maybeRefreshReport,
} from "../../src/ast-grep-map/impl.ts"

// Pin the extractor script so temp fixtures resolve regardless of cwd.
process.env.OP_AST_GREP_MAP_SCRIPT = resolve("src/ast-grep-map/extract.mjs")

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error("  FAIL:", msg)
  } else {
    console.log("  ok:", msg)
  }
}

// --- Test 1: isHomeDir exact-match semantics (pure, no I/O) ---
function testIsHomeDir(): void {
  console.log("[1] isHomeDir exact-match semantics")
  const home = homedir()
  assert(isHomeDir(home) === true, "home itself is detected")
  assert(isHomeDir(join(home, "subdir")) === false, "subdirectory of home is NOT home")
  assert(isHomeDir(join(home, "..")) === false, "parent of home is NOT home")
  const other = mkdtempSync(join(tmpdir(), "agmap-home-not-"))
  try {
    assert(isHomeDir(other) === false, "an unrelated temp dir is NOT home")
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
}

// --- Test 2: discoverCodeFiles refuses to walk home (short-circuits to []) ---
function testDiscoverRefusesHome(): void {
  console.log("[2] discoverCodeFiles refuses to walk home")
  const home = homedir()
  // The guard returns [] without any readdirSync, so this is fast even when
  // home contains a large tree of code files (would be ~24s without the guard).
  const files = discoverCodeFiles(home)
  assert(Array.isArray(files) && files.length === 0, "discoverCodeFiles(home) returns [] without walking")
}

// --- Test 3: discoverCodeFiles still walks a normal project (incl. subdirs of home) ---
function testDiscoverWalksProject(): void {
  console.log("[3] discoverCodeFiles still walks a normal project")
  const project = mkdtempSync(join(tmpdir(), "agmap-home-proj-"))
  try {
    mkdirSync(join(project, "src"), { recursive: true })
    writeFileSync(join(project, "src", "index.ts"), "export function ok(): boolean { return true }\n")
    const files = discoverCodeFiles(project, "ts")
    assert(files.length === 1 && files[0].endsWith("index.ts"), "walks a real project and finds the .ts file")
    // On Windows tmpdir() is under home; on POSIX it is not. Either way a
    // subdir of home must still be walked (only home itself is refused).
    assert(!isHomeDir(project), "temp project is not home itself (guard should not block it)")
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}

// --- Test 4: resolveRoot falls back past a guarded home to the directory ---
function testResolveRootFallbackPastHome(): void {
  console.log("[4] resolveRoot falls back past guarded home to directory")
  const home = homedir()
  const project = mkdtempSync(join(tmpdir(), "agmap-home-fb-"))
  try {
    mkdirSync(join(project, "src"), { recursive: true })
    writeFileSync(join(project, "src", "index.ts"), "export function ok(): boolean { return true }\n")
    const root = resolveRoot({ worktree: home, directory: project }, "ts")
    assert(root === project, "uses directory (not home) when worktree is home")
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}

// --- Test 5: maybeRefreshReport skips home before any side effect ---
async function testMaybeRefreshReportSkipsHome(): Promise<void> {
  console.log("[5] maybeRefreshReport skips home before side effects")
  const home = homedir()
  // Isolate mapDir: point the env override at a non-existent path. The
  // early-skip must return BEFORE resolveMapDir/mkdir, so this path must NOT
  // be created. (If the guard regressed, resolveMapDir + mkdirSync would
  // create it, failing the assertion and protecting the real home.)
  const tmpParent = mkdtempSync(join(tmpdir(), "agmap-home-skip-"))
  const mapDirCandidate = join(tmpParent, "should-not-exist")
  process.env.OP_AST_GREP_MAP_DIR = mapDirCandidate
  try {
    const r = await maybeRefreshReport(home)
    assert(r.status === "skipped", `maybeRefreshReport(home) status=skipped (got ${r.status})`)
    assert(!existsSync(mapDirCandidate), "early-skip precedes resolveMapDir (no mapDir created)")
  } finally {
    delete process.env.OP_AST_GREP_MAP_DIR
    rmSync(tmpParent, { recursive: true, force: true })
  }
}

// --- main ---
;(async () => {
  testIsHomeDir()
  testDiscoverRefusesHome()
  testDiscoverWalksProject()
  testResolveRootFallbackPastHome()
  await testMaybeRefreshReportSkipsHome()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error("test harness crashed:", e)
  process.exit(1)
})
