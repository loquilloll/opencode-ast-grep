// Smoke tests for the MCP server bridge.
// Run: npm run test:mcp  (or: tsx test/mcp/smoke.ts)
//
// Groups:
//   1. Registry shape        - 5 tools, each with description + args.
//   2. runTool (hermetic)    - ast_grep_validate with no binary/FS access.
//   3. End-to-end round-trip - InMemoryTransport client<->server (tools/list +
//                              tools/call), required-field + mutation-warning
//                              conversion.
//   4. normalizeToolResult   - string / {output} / {error}-throws / object.
//   5. Bridge error surfacing- execute throws & {error} return -> isError, via
//                              temporary fake tools registered on a throwaway
//                              server (covers the bridge try/catch).
//   6. stdio discipline      - --help writes 0 bytes to stdout (stderr only).
//
// Note: ast_grep_map is not re-exercised here - the existing test/ast-grep-map/*
// suites already cover its execute path with a synthesized ctx (the same code
// path this bridge uses). This file validates the registration/wiring layer.

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  MCP_TOOLS,
  MCP_TOOL_NAMES,
  SERVER_NAME,
  SERVER_VERSION,
  buildToolContext,
  createMcpServer,
  normalizeToolResult,
  runTool,
} from "../../src/mcp/server.ts"

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error("  FAIL:", msg)
  } else {
    console.log("  ok:", msg)
  }
}

// --- Group 1: registry shape ---
function testRegistry(): void {
  console.log("registry shape")
  const expected = ["ast_grep_search", "ast_grep_replace", "ast_grep_scan", "ast_grep_validate", "ast_grep_map"]
  assert(MCP_TOOL_NAMES.length === 5, `expected 5 tools, got ${MCP_TOOL_NAMES.length}`)
  for (const name of expected) {
    assert(MCP_TOOL_NAMES.includes(name), `registry includes ${name}`)
    const def = MCP_TOOLS[name]
    assert(!!def, `${name} has a definition`)
    assert(typeof def!.description === "string" && def!.description.length > 0, `${name} has a description`)
    assert(!!def!.args && typeof def!.args === "object", `${name} has an args shape`)
  }
  assert(SERVER_NAME === "ast-grep-mcp", `server name is ${SERVER_NAME}`)
  assert(typeof SERVER_VERSION === "string" && SERVER_VERSION.length > 0, "server version set")
}

// --- Group 2: runTool (hermetic - no sg binary, no FS) ---
async function testRunTool(): Promise<void> {
  console.log("runTool (validate, hermetic)")
  const ac = new AbortController()
  const ctx = buildToolContext(process.cwd(), ac.signal, "t")
  const out = await runTool("ast_grep_validate", { pattern: "console.log($MSG)", lang: "ts" }, ctx)
  assert(/plausible/i.test(out), `validate plausible output (got: ${out.slice(0, 80)})`)

  // Unknown tool throws (caller surfaces via isError in the bridge).
  let threw = false
  try {
    await runTool("does_not_exist", {}, ctx)
  } catch {
    threw = true
  }
  assert(threw, "runTool throws on unknown tool")
}

// --- Group 3: end-to-end client<->server round-trip over InMemoryTransport ---
async function testEndToEnd(): Promise<void> {
  console.log("end-to-end (InMemoryTransport)")
  const directory = process.cwd()
  const server = createMcpServer({ directory })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "smoke-client", version: "1.0.0" })
  await client.connect(clientTransport)

  try {
    const list = await client.listTools()
    const tools = (list as { tools: Array<Record<string, unknown>> }).tools
    assert(Array.isArray(tools) && tools.length === 5, `listTools returned 5 tools (got ${tools?.length})`)

    const byName = new Map<string, Record<string, unknown>>()
    for (const t of tools) byName.set(String(t.name), t)

    // Every tool advertises a JSON-schema inputSchema of type "object".
    for (const name of ["ast_grep_search", "ast_grep_replace", "ast_grep_scan", "ast_grep_validate", "ast_grep_map"]) {
      const t = byName.get(name)
      assert(!!t, `listTools includes ${name}`)
      const schema = t!.inputSchema as { type?: string; properties?: Record<string, unknown> } | undefined
      assert(schema?.type === "object", `${name} inputSchema.type === "object"`)
      assert(!!schema?.properties && Object.keys(schema.properties).length > 0, `${name} has inputSchema.properties`)
    }

    // Required-field conversion: ast_grep_search.pattern is non-optional.
    const search = byName.get("ast_grep_search")!.inputSchema as { required?: string[]; properties?: Record<string, unknown> }
    assert(Array.isArray(search.required) && search.required!.includes("pattern"), "ast_grep_search marks pattern required")
    assert(!!search.properties?.pattern, "ast_grep_search inputSchema has pattern property")

    // Mutation warning: the two file-modifying tools get an MCP-specific warning
    // appended to their description (no host permission layer over MCP); the
    // read-only tools do not.
    const replaceDesc = String(byName.get("ast_grep_replace")!.description)
    const scanDesc = String(byName.get("ast_grep_scan")!.description)
    const validateDesc = String(byName.get("ast_grep_validate")!.description)
    assert(/modify files on disk/i.test(replaceDesc), "ast_grep_replace description warns about modifying files")
    assert(/modify files on disk/i.test(scanDesc), "ast_grep_scan description warns about modifying files")
    assert(!/modify files on disk/i.test(validateDesc), "ast_grep_validate (read-only) has no mutation warning")

    // Call a tool end-to-end (validate is hermetic).
    const call = (await client.callTool({
      name: "ast_grep_validate",
      arguments: { pattern: "console.log($MSG)", lang: "ts" },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    assert(!call.isError, "callTool validate did not error")
    const text = call.content?.[0]?.text ?? ""
    assert(/plausible/i.test(text), `callTool validate plausible output (got: ${text.slice(0, 80)})`)

    // Unknown tool surfaces as an MCP error result (not a thrown exception).
    const badCall = (await client.callTool({ name: "nope_not_real", arguments: {} })) as { isError?: boolean }
    assert(badCall.isError === true, "callTool unknown tool returns isError")
  } finally {
    await client.close()
    await server.close()
  }
}

// --- Group 4: normalizeToolResult (pure unit, hermetic) ---
function testNormalizeToolResult(): void {
  console.log("normalizeToolResult")
  assert(normalizeToolResult("hello") === "hello", "string passes through")

  const out = normalizeToolResult({ output: "body", title: "t" } as never)
  assert(out === "body", "{output} object -> its output string")

  let threw = false
  try {
    normalizeToolResult({ error: "extraction failed" } as never)
  } catch (e) {
    threw = true
    assert(/extraction failed/.test(String((e as Error).message)), "{error} object throws its message")
  }
  assert(threw, "{error} object throws (so the bridge surfaces isError)")

  // Anything else falls back to JSON (does not throw).
  const js = normalizeToolResult({ foo: 1 } as never)
  assert(/"foo"\s*:\s*1/.test(js), "plain object falls back to JSON.stringify")
}

// --- Group 5: bridge error surfacing (execute throws / {error} return) ---
// Registers temporary fake tools on a throwaway server so we exercise the
// bridge try/catch + normalizeToolResult through the real CallTool path.
async function testBridgeErrorSurfacing(): Promise<void> {
  console.log("bridge error surfacing")
  const THROW = "____mcp_smoke_throws"
  const ERROBJ = "____mcp_smoke_errorobj"
  const saved: Record<string, unknown> = { [THROW]: MCP_TOOLS[THROW], [ERROBJ]: MCP_TOOLS[ERROBJ] }
  // Cast through `any` because ToolDefinition's args must be a Zod raw shape; an
  // empty `{}` is a valid zero-arg shape for these synthetic tools.
  MCP_TOOLS[THROW] = {
    description: "test",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async () => {
      throw new Error("synthetic boom")
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  MCP_TOOLS[ERROBJ] = {
    description: "test",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async () => ({ error: "synthetic extraction failure" } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any

  const server = createMcpServer({ directory: process.cwd() })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "smoke-err", version: "1.0.0" })
  await client.connect(clientTransport)
  try {
    const throwCall = (await client.callTool({ name: THROW, arguments: {} })) as { isError?: boolean; content?: Array<{ text?: string }> }
    assert(throwCall.isError === true, "execute-throw surfaces as isError")
    assert(/synthetic boom/.test(String(throwCall.content?.[0]?.text ?? "")), "execute-throw message reaches the client")

    const errObjCall = (await client.callTool({ name: ERROBJ, arguments: {} })) as { isError?: boolean; content?: Array<{ text?: string }> }
    assert(errObjCall.isError === true, "{error}-return surfaces as isError (not masked as success)")
    assert(/synthetic extraction failure/.test(String(errObjCall.content?.[0]?.text ?? "")), "{error} message reaches the client")
  } finally {
    await client.close()
    await server.close()
    // Restore registry so the 5-tool invariant holds for any later assertions.
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete MCP_TOOLS[k]
      else MCP_TOOLS[k] = saved[k] as never
    }
  }
}

// --- Group 6: stdio discipline (--help writes nothing to stdout) ---
// Runs the real stdio.ts entry under tsx (no build dependency) the same way a
// client spawns node — proving stdout stays clean for JSON-RPC.
function testStdioDiscipline(): void {
  console.log("stdio discipline")
  const entry = fileURLToPath(new URL("../../src/mcp/stdio.ts", import.meta.url))
  const r = spawnSync(process.execPath, ["--import", "tsx", entry, "--help"], { encoding: "utf8" })
  assert(r.status === 0, `--help exits 0 (got status=${r.status}, signal=${r.signal})`)
  assert((r.stdout ?? "").length === 0, `--help writes 0 bytes to stdout (got ${(r.stdout ?? "").length})`)
  assert(/ast-grep-mcp/.test(r.stderr ?? ""), "--help writes help text to stderr")
}

// --- main ---
;(async () => {
  testRegistry()
  await testRunTool()
  await testEndToEnd()
  testNormalizeToolResult()
  await testBridgeErrorSurfacing()
  testStdioDiscipline()
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error("test harness crashed:", e)
  process.exit(1)
})
