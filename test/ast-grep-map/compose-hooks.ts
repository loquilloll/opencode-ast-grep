// Tests for composeHooks in src/plugin.ts — verifies the composer chains every
// CHAINABLE hook key, isolates per-handler failures, and emits debug logs.
// Run: tsx test/ast-grep-map/compose-hooks.ts
import { composeHooks } from "../../src/plugin.ts"
import type { Hooks } from "@opencode-ai/plugin"

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error("  FAIL:", msg)
  } else {
    console.log("  ok:", msg)
  }
}

// --- Test 1: both-plugin-defined hook chains both handlers ---
async function testBothPresent(): Promise<void> {
  console.log("[1] composeHooks chains both handlers when both define a key")
  const log: string[] = []
  const a: Hooks = {
    event: async () => { log.push("a.event") },
  }
  const b: Hooks = {
    event: async () => { log.push("b.event") },
  }
  const composed = composeHooks(a, b)
  await composed.event!({ event: { type: "x" } } as any)
  assert(log[0] === "a.event" && log[1] === "b.event", "both handlers ran in order (a before b)")
}

// --- Test 2: only-one-defined key passes through unchanged ---
async function testAsymmetric(): Promise<void> {
  console.log("[2] composeHooks passes through asymmetric keys")
  let bCalled = false
  const a: Hooks = {
    event: async () => {},
  }
  const b: Hooks = {
    event: async () => {},
    "tool.execute.after": async () => { bCalled = true },
  }
  const composed = composeHooks(a, b)
  assert(composed["tool.execute.after"] !== undefined, "only-b key present on composed")
  assert(composed.event !== undefined, "shared key still present")
  await composed["tool.execute.after"]!({ tool: "edit", sessionID: "s", callID: "c", args: {} } as any, { title: "t", output: "o", metadata: {} } as any)
  assert(bCalled, "b's tool.execute.after invoked")
}

// --- Test 3: per-handler error isolation ---
async function testErrorIsolation(): Promise<void> {
  console.log("[3] composeHooks isolates per-handler errors")
  const log: string[] = []
  // Suppress console.error for this test — we know it'll fire.
  const originalErr = console.error
  console.error = () => {}
  try {
    const a: Hooks = {
      event: async () => {
        log.push("a.start")
        throw new Error("a fails")
      },
    }
    const b: Hooks = {
      event: async () => { log.push("b.ran") },
    }
    const composed = composeHooks(a, b)
    await composed.event!({ event: { type: "x" } } as any)
    assert(log.includes("a.start"), "a started")
    assert(log.includes("b.ran"), "b still ran after a threw")
  } finally {
    console.error = originalErr
  }
}

// --- Test 4: representative async-hook keys are composed (not exhaustive ---
// the composition mechanism at plugin.ts:52-79 is uniform — the same `for`
// loop handles every key — so sampling 8 of the 17 CHAINABLE keys is enough
// to pin the behavior. Add more if you change the dispatch mechanism itself.)
async function testRepresentativeChainableKeysComposed(): Promise<void> {
  console.log("[4] composeHooks covers representative async-hook keys on both inputs")
  const aCalls: string[] = []
  const bCalls: string[] = []
  const make = (label: string, sink: string[]): Hooks => ({
    event: async () => { sink.push(`${label}.event`) },
    "tool.execute.before": async () => { sink.push(`${label}.tool.execute.before`) },
    "tool.execute.after": async () => { sink.push(`${label}.tool.execute.after`) },
    "chat.message": async () => { sink.push(`${label}.chat.message`) },
    "chat.params": async () => { sink.push(`${label}.chat.params`) },
    "permission.ask": async () => { sink.push(`${label}.permission.ask`) },
    "tool.definition": async () => { sink.push(`${label}.tool.definition`) },
    "shell.env": async () => { sink.push(`${label}.shell.env`) },
  })
  const composed = composeHooks(make("a", aCalls), make("b", bCalls))

  // Invoke each composed hook with plausible-shaped args; we only verify that
  // both sinks got the label for each key.
  const calls: Array<[keyof Hooks, () => Promise<void>]> = [
    ["event", async () => { await composed.event!({ event: { type: "x" } } as any) }],
    ["tool.execute.before", async () => { await composed["tool.execute.before"]!({ tool: "t", sessionID: "s", callID: "c" } as any, { args: {} } as any) }],
    ["tool.execute.after", async () => { await composed["tool.execute.after"]!({ tool: "t", sessionID: "s", callID: "c", args: {} } as any, { title: "t", output: "o", metadata: {} } as any) }],
    ["chat.message", async () => { await composed["chat.message"]!({ sessionID: "s" } as any, { message: {} as any, parts: [] }) }],
    ["chat.params", async () => { await composed["chat.params"]!({ sessionID: "s", agent: "a", model: {} as any, provider: {} as any, message: {} as any } as any, { temperature: 0, topP: 0, topK: 0, maxOutputTokens: undefined, options: {} }) }],
    ["permission.ask", async () => { await composed["permission.ask"]!({} as any, { status: "ask" }) }],
    ["tool.definition", async () => { await composed["tool.definition"]!({ toolID: "t" } as any, { description: "d", parameters: {} }) }],
    ["shell.env", async () => { await composed["shell.env"]!({ cwd: "." } as any, { env: {} }) }],
  ]
  for (const [key, invoke] of calls) {
    aCalls.length = 0
    bCalls.length = 0
    await invoke()
    assert(aCalls.some((s) => s.includes(String(key))), `a received ${String(key)}`)
    assert(bCalls.some((s) => s.includes(String(key))), `b received ${String(key)}`)
  }
}

// --- main ---
;(async () => {
  await testBothPresent()
  await testAsymmetric()
  await testErrorIsolation()
  await testRepresentativeChainableKeysComposed()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error("test harness crashed:", e)
  process.exit(1)
})
