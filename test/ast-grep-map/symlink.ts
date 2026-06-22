// Symlink rejection tests (improvement #4).
// Run: tsx test/ast-grep-map/symlink.ts
//
// Symlink creation on Windows requires Developer Mode or admin privileges. The
// suite self-skips the symlink-specific tests when symlinks cannot be created
// (process.platform === "win32" without the privilege), but always runs the
// pure-helper assertions (isSeedPathSymlink on a regular file → false).
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverCodeFiles } from "../../src/ast-grep-map/impl.ts"
import { isSeedPathSymlink, normalizeSeedEntries, type EffectiveScope, type SeedEntry } from "../../src/ast-grep-map/graph.ts"

let failures = 0
let skips = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error("  FAIL:", msg)
  } else {
    console.log("  ok:", msg)
  }
}
function skip(msg: string): void {
  skips++
  console.log("  skip:", msg)
}

// Probe whether this process can create a symlink. Windows without Developer
// Mode or admin will throw EPERM on symlinkSync.
function canCreateSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "agmap-symlink-probe-"))
  const target = join(dir, "target.txt")
  const link = join(dir, "link.txt")
  writeFileSync(target, "x")
  try {
    symlinkSync(target, link)
    return existsSync(link) && lstatSync(link).isSymbolicLink()
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- Test 1: isSeedPathSymlink on a regular file returns false ---
function testRegularFileNotSymlink(): void {
  console.log("[1] isSeedPathSymlink: regular file → false")
  const dir = mkdtempSync(join(tmpdir(), "agmap-reg-"))
  const f = join(dir, "a.ts")
  writeFileSync(f, "export const x = 1\n")
  // Absolute path
  assert(!isSeedPathSymlink(f), "regular absolute path → not symlink")
  // Workspace-relative + worktree; the helper resolves against worktree.
  assert(!isSeedPathSymlink("a.ts", dir), "regular relative path + worktree → not symlink")
  rmSync(dir, { recursive: true, force: true })
}

// --- Test 2: discoverCodeFiles skips symlinks (file + directory) ---
function testDiscoverSkipsSymlinks(): void {
  console.log("[2] discoverCodeFiles skips symlinks")
  if (!canCreateSymlinks()) {
    skip("cannot create symlinks on this platform/user — skipping discoverCodeFiles symlink tests")
    return
  }
  const wt = mkdtempSync(join(tmpdir(), "agmap-disc-"))
  mkdirSync(join(wt, "src"), { recursive: true })
  writeFileSync(join(wt, "src", "real.ts"), "export const a = 1\n")
  // Symlinked file inside src/ — should NOT appear in results.
  symlinkSync(join(wt, "src", "real.ts"), join(wt, "src", "linked.ts"))
  // Symlinked directory — escape attempt: points to OS tmpdir root.
  symlinkSync(tmpdir(), join(wt, "escape"))
  // Drop a .ts file in tmpdir root before symlinking, so the symlink target
  // HAS a ts file to discover. discoverCodeFiles must still not descend into
  // the symlink.
  const decoyName = "agmap-decoy-should-not-appear.ts"
  writeFileSync(join(tmpdir(), decoyName), "export const leak = true\n")

  try {
    const found = discoverCodeFiles(wt, "ts").map((f) => f.replace(/\\/g, "/"))
    assert(found.some((f) => f.endsWith("src/real.ts")), "real.ts discovered")
    assert(!found.some((f) => f.endsWith("src/linked.ts")), "symlinked file linked.ts NOT discovered")
    assert(!found.some((f) => f.includes("/escape/")), "symlinked escape dir NOT descended into")
    assert(!found.some((f) => f.endsWith(decoyName)), "decoy file behind escape symlink NOT discovered")
  } finally {
    rmSync(join(tmpdir(), decoyName), { force: true })
    rmSync(wt, { recursive: true, force: true })
  }
}

// --- Test 3: normalizeSeedEntries rejects seed paths that go through a symlink ---
function testSeedNormalizationRejectsSymlinks(): void {
  console.log("[3] normalizeSeedEntries rejects symlinked seeds")
  if (!canCreateSymlinks()) {
    skip("cannot create symlinks on this platform/user — skipping normalizeSeedEntries symlink test")
    return
  }
  const wt = mkdtempSync(join(tmpdir(), "agmap-seeds-"))
  mkdirSync(join(wt, "src"), { recursive: true })
  writeFileSync(join(wt, "src", "real.ts"), "export const x = 1\n")
  // Create a symlink at the top of the worktree pointing into src/.
  // A seed path that traverses this symlink must be rejected.
  symlinkSync(join(wt, "src"), join(wt, "linked-src"))

  const scope: EffectiveScope = { paths: [], globs: [] }
  const seeds: SeedEntry[] = [
    { file: "src/real.ts", weight: 1, source: "test" }, // direct path — should pass
    { file: "linked-src/real.ts", weight: 1, source: "test" }, // via symlink — should be rejected
  ]
  try {
    const out = normalizeSeedEntries(seeds, scope, wt)
    assert(out.some((e) => e.file === "src/real.ts"), "direct seed accepted")
    assert(!out.some((e) => e.file === "linked-src/real.ts"), "symlinked seed rejected")
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
}

// --- main ---
;(() => {
  testRegularFileNotSymlink()
  testDiscoverSkipsSymlinks()
  testSeedNormalizationRejectsSymlinks()
  const verdict = failures === 0 ? (skips > 0 ? `\n${skips} TEST(S) SKIPPED, NONE FAILED` : "\nALL TESTS PASSED") : `\n${failures} TEST(S) FAILED`
  console.log(verdict)
  process.exit(failures === 0 ? 0 : 1)
})()
