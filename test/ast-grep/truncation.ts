// Phase 6 tests — byte-precise truncation + JSON bracket-repair (improvement #5).
// Run: tsx test/ast-grep/truncation.ts
//
// These tests exercise the pure parsing/formatting functions in src/ast-grep/impl.ts.
// They do NOT spawn the sg binary (which requires a working install); the
// integration with runProcess is covered indirectly by test/ast-grep/smoke.ts.
import {
  appendWithCap,
  parseCompactJsonWithStatus,
  formatSgResult,
  formatMatches,
} from "../../src/ast-grep/impl.ts"

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error("  FAIL:", msg)
  } else {
    console.log("  ok:", msg)
  }
}

// --- Test 1: appendWithCap byte-aware truncation ---
function testAppendWithCap(): void {
  console.log("[1] appendWithCap")
  // Small ASCII case
  const r1 = appendWithCap("hello", "world", 10)
  assert(!r1.exceeded, "fits → not exceeded")
  assert(r1.value === "helloworld", "concat exact")

  const r2 = appendWithCap("hello", "world", 8)
  assert(r2.exceeded, "exceeds byte cap → flagged")
  assert(Buffer.byteLength(r2.value) === 8, `value is exactly 8 bytes (got ${Buffer.byteLength(r2.value)})`)
  assert(r2.value === "hellowor", "hellowor (3-byte slice of 'world')")

  // Multi-byte UTF-8: '✓' is 3 bytes (E2 9C 93). Slicing mid-codepoint would
  // produce invalid UTF-8. appendWithCap must binary-search to a codepoint boundary.
  const r3 = appendWithCap("", "✓✓✓✓", 5) // 4 codepoints × 3 bytes = 12 bytes; cap 5 → fits 1 codepoint (3B)
  assert(r3.exceeded, "multi-byte cap exceeded flagged")
  assert(Buffer.byteLength(r3.value) <= 5, `multi-byte result <= 5B (got ${Buffer.byteLength(r3.value)})`)
  assert(r3.value === "✓", "exactly one ✓ fits (3B, leaves 2B which can't fit another ✓)")

  // Cap already exceeded — no further appending.
  const r4 = appendWithCap("a".repeat(20), "more", 10)
  assert(r4.exceeded && r4.value === "a".repeat(20), "current already past cap → unchanged")
}

// --- Test 2: parseCompactJsonWithStatus strict JSON ---
function testStrictParse(): void {
  console.log("[2] parseCompactJsonWithStatus strict JSON")
  const r = parseCompactJsonWithStatus(
    JSON.stringify([{ file: "a.ts", text: "x", range: { start: { line: 0, column: 0 } } }]),
    false,
  )
  assert(r.matches.length === 1, "one match parsed")
  assert(!r.truncated, "not truncated")
  assert(!r.repairUsed, "no repair needed")
  assert(r.totalMatches === 1, "totalMatches == 1")
}

// --- Test 3: parseCompactJsonWithStatus bracket-repair on external truncation ---
function testBracketRepair(): void {
  console.log("[3] bracket-repair on truncated JSON")
  // Two complete matches + partial third (truncated mid-object).
  const complete = [{ file: "a.ts", text: "x" }, { file: "b.ts", text: "y" }]
  const full = JSON.stringify([...complete, { file: "c.ts", text: "z" }])
  // Truncate mid-way through the third object.
  const cutAt = full.indexOf('"c.ts"') + 3
  const truncated = full.substring(0, cutAt)
  const r = parseCompactJsonWithStatus(truncated, true)
  assert(r.matches.length === 2, `two complete matches recovered (got ${r.matches.length})`)
  assert(r.matches[0]?.file === "a.ts", "first match preserved")
  assert(r.matches[1]?.file === "b.ts", "second match preserved")
  assert(r.truncated, "truncated flag set")
  assert(r.truncatedReason === "max_output_bytes", "reason: max_output_bytes")
  assert(r.repairUsed, "repair was used")
}

// --- Test 3b: regression — bracket-repair must recover all complete objects
//     when truncation lands RIGHT AFTER a `}` (not just at inter-object `,`).
//     This was the off-by-one bug found in code review. ---
function testBracketRepairTrailingClose(): void {
  console.log("[3b] bracket-repair off-by-one regression (truncation right after `}`)")
  // 3 complete objects, truncated exactly at the closing `}` of the third.
  const many = [{ file: "a.ts" }, { file: "b.ts" }, { file: "c.ts" }]
  const full = JSON.stringify(many)
  // Trim the trailing `]` so we simulate truncation right after the last `}`.
  const truncated = full.substring(0, full.length - 1)
  const r = parseCompactJsonWithStatus(truncated, true)
  assert(r.matches.length === 3, `three complete matches recovered (got ${r.matches.length}) — simple-repair strategy`)
  assert(r.matches[2]?.file === "c.ts", "last complete match preserved")
  assert(r.repairUsed, "repair was used")
}

// --- Test 3c: reason precedence — when both external-truncation AND cap apply,
//     max_output_bytes wins (root cause). ---
function testReasonPrecedence(): void {
  console.log("[3c] truncatedReason precedence (max_output_bytes wins)")
  const many = Array.from({ length: 100 }, (_, i) => ({ file: `${i}.ts` }))
  const full = JSON.stringify(many)
  const truncated = full.substring(0, full.length - 100) // external truncation
  const r = parseCompactJsonWithStatus(truncated, true, { maxMatches: 10 })
  assert(r.truncated, "truncated")
  assert(r.truncatedReason === "max_output_bytes", `reason should be max_output_bytes (got ${r.truncatedReason})`)
}

// --- Test 4: parseCompactJsonWithStatus max_matches cap ---
function testMaxMatchesCap(): void {
  console.log("[4] max_matches cap")
  const many = Array.from({ length: 100 }, (_, i) => ({ file: `${i}.ts`, text: "x" }))
  const r = parseCompactJsonWithStatus(JSON.stringify(many), false, { maxMatches: 10 })
  assert(r.matches.length === 10, "matches sliced to 10")
  assert(r.totalMatches === 100, "totalMatches reports 100")
  assert(r.truncated, "truncated flag set")
  assert(r.truncatedReason === "max_matches", "reason: max_matches")
}

// --- Test 5: formatSgResult prefixes [TRUNCATED] when truncated ---
function testFormatSgResult(): void {
  console.log("[5] formatSgResult [TRUNCATED] prefix")
  const matches = [
    { file: "a.ts", text: "let x = 1", range: { start: { line: 0, column: 0 }, end: { line: 0, column: 9 } } },
  ]
  const noTrunc = formatSgResult({ matches, totalMatches: 1, truncated: false, repairUsed: false }, false)
  assert(!noTrunc.startsWith("[TRUNCATED]"), "no prefix when not truncated")
  assert(noTrunc.includes("a.ts"), "match shown")

  const trunc = formatSgResult(
    { matches, totalMatches: 500, truncated: true, truncatedReason: "max_matches", repairUsed: false },
    false,
  )
  assert(trunc.startsWith("[TRUNCATED]"), "prefix when truncated")
  assert(trunc.includes("showing first 1 of 500"), "reason text included")
  assert(trunc.includes("a.ts"), "match still shown after prefix")

  const truncBytes = formatSgResult(
    { matches: [], totalMatches: 0, truncated: true, truncatedReason: "max_output_bytes", repairUsed: true },
    false,
  )
  assert(truncBytes.includes("output exceeded 1MB"), "byte-cap reason text")
  assert(truncBytes.includes("(no matches)"), "falls through to formatMatches empty state")
}

// --- Test 6: formatMatches unchanged for the no-truncation path (backward compat) ---
function testFormatMatchesUnchanged(): void {
  console.log("[6] formatMatches backward compatible")
  const out = formatMatches(
    [{ file: "x.ts", text: "abc", range: { start: { line: 4, column: 0 } } }],
    false,
  )
  assert(out.includes("x.ts"), "file header present")
  assert(out.includes("L5"), "1-based line shown (was line 4 0-based)")
}

// --- main ---
;(() => {
  testAppendWithCap()
  testStrictParse()
  testBracketRepair()
  testBracketRepairTrailingClose()
  testReasonPrecedence()
  testMaxMatchesCap()
  testFormatSgResult()
  testFormatMatchesUnchanged()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
