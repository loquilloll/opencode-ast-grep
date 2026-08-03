// MCP server: exposes the 5 ast-grep tools to any MCP client
// (Claude Code, Codex CLI, GitHub Copilot, Cursor, Cline, opencode, ...).
//
// This module is transport-agnostic. `createMcpServer()` builds and returns an
// unconnected `McpServer`; the caller wires a transport (stdio, in-memory for
// tests, ...). See `./stdio.ts` for the CLI entry.
//
// Reuse strategy — zero edits to the existing tool logic:
//   `tool()` from @opencode-ai/plugin is an identity fn
//   (node_modules/@opencode-ai/plugin/dist/tool.js: `return input`), so every
//   ToolDefinition already exposes `.description`, `.args` (a Zod raw shape),
//   and `.execute`. We import the existing `tools` maps from both impl modules
//   and bridge each to MCP via `McpServer.registerTool`. The SDK accepts a Zod
//   raw shape as `inputSchema` and performs the zod→JSON-schema conversion
//   itself; the SDK supports zod v3 + v4 (this tree is zod 4.1.8).
//
// stdio discipline: nothing here writes to stdout — MCP owns stdout for the
// JSON-RPC protocol. All diagnostics go to stderr via the injected `log` fn.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin"
import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { tools as astGrepTools } from "../ast-grep/impl.js"
import { tools as mapTools } from "../ast-grep-map/impl.js"

// ---------------------------------------------------------------------------
// Server identity
// ---------------------------------------------------------------------------

export const SERVER_NAME = "ast-grep-mcp"
// The repo package.json has no "version" field (it is "private": true); this
// is the MCP server's own version, independent of any bundle/deploy layout.
export const SERVER_VERSION = "1.0.0"

export const SERVER_INSTRUCTIONS = [
  "ast-grep tools: structural code search, rewrite, YAML-rule scan, pattern",
  "validation, and an aider-style PageRank-ranked repo map. Patterns are",
  "AST shapes ($VAR matches one node, $$$ matches many) — NOT regex. Searches",
  "default to the configured project root (--directory or process.cwd()).",
].join(" ")

// ---------------------------------------------------------------------------
// Tool registry (merge of both impl modules' exported maps)
// ---------------------------------------------------------------------------

// Spread merge of the two impl maps; a future name collision would silently
// shadow, so guard it once at module load (cheap, dev-visible).
export const MCP_TOOLS: Record<string, ToolDefinition> = {
  ...astGrepTools,
  ...mapTools,
}
for (const k of Object.keys(astGrepTools)) {
  if (k in mapTools) throw new Error(`[ast-grep-mcp] tool name collision: ${k}`)
}

export const MCP_TOOL_NAMES: string[] = Object.keys(MCP_TOOLS)

// Tools that can modify files on disk when invoked with mutating args. Over MCP
// there is no host permission layer (unlike opencode's outer gate), so we append
// an explicit warning to each such tool's description — this is how the calling
// LM learns to confirm with the user before a destructive call (the standard
// MCP convention for side-effecting tools).
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "ast_grep_replace", // apply=true -> sg --update-all rewrites files
  "ast_grep_scan", // apply=true -> sg scan -U applies rule fixes
])

const MUTATING_WARNING =
  " NOTE: over MCP there is no host permission layer; invoking with apply=true WILL modify files on disk — confirm with the user first."

function descriptionFor(name: string, base: string): string {
  return MUTATING_TOOLS.has(name) ? base + MUTATING_WARNING : base
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const defaultLog = (msg: string): void => {
  process.stderr.write(`${msg}\n`)
}

/** Best-effort flat message from any thrown value. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message || String(e)
  try {
    return String(e)
  } catch {
    return "unknown error"
  }
}

// ---------------------------------------------------------------------------
// Context synthesis
// ---------------------------------------------------------------------------

/**
 * Build a opencode `ToolContext` from the resolved root + the MCP request's
 * abort signal. The tool execute handlers only read `directory`, `worktree`,
 * and `abort` (verified: no execute path touches `ask`/`metadata`/`sessionID`/
 * `messageID`/`agent`), so this is sufficient.
 *
 * `requestId` is not part of ToolContext; it is surfaced via an optional stderr
 * trace so per-call client issues are diagnosable.
 */
export function buildToolContext(
  root: string,
  signal: AbortSignal,
  requestId?: string | number,
): ToolContext {
  const reqStr = requestId != null ? String(requestId) : "mcp"
  return {
    sessionID: "mcp",
    messageID: reqStr,
    agent: "mcp",
    directory: root,
    worktree: root,
    abort: signal,
    metadata: () => {
      /* MCP has no progress-metadata channel the tools use */
    },
    ask: async () => {
      /* Permission flow is owned by the host MCP client, not this server */
    },
  }
}

// ---------------------------------------------------------------------------
// Result normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an opencode `ToolResult` to a string.
 *
 * `string` results pass through. The documented object form is
 * `{ title?, output, metadata?, attachments? }` — we prefer `.output`. Some tool
 * paths return a non-conforming `{ error: "..." }` object (e.g. extraction
 * failures); to preserve the MCP contract that failures surface as
 * `isError: true`, we THROW on that shape so the bridge's try/catch converts it
 * to an error result instead of masking it as success text.
 */
export function normalizeToolResult(result: ToolResult): string {
  if (typeof result === "string") return result
  if (result && typeof result === "object") {
    const r = result as { error?: unknown; output?: unknown }
    if (typeof r.error === "string" && r.error.length > 0) {
      throw new Error(r.error)
    }
    if (typeof r.output === "string") return r.output
  }
  return JSON.stringify(result)
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

/**
 * Run a registered tool by name and return its output as a string. Throws on
 * unknown tool, on a tool whose `execute` throws, or when the result carries an
 * `{error}` shape — the caller (the MCP bridge) catches and converts these to
 * `{ isError: true }`.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const def = MCP_TOOLS[name]
  if (!def) throw new Error(`Unknown tool: ${name}`)
  const result: ToolResult = await def.execute(args as any, ctx)
  return normalizeToolResult(result)
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] }
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the project root to use as both `ToolContext.directory` and
 * `.worktree`. Accepts directories only (a file path is rejected with a warning
 * — otherwise downstream file discovery would walk the wrong root). Falls back
 * to `process.cwd()` (with a stderr warning) when the requested path is missing
 * or not a directory — MCP clients sometimes spawn the server in odd cwds, and
 * a bad override should not hard-fatal the whole server.
 */
function resolveRoot(requested: string, log: (msg: string) => void): string {
  const abs = isAbsolute(requested) ? requested : resolve(requested)
  try {
    const st = statSync(abs)
    if (st.isDirectory()) return abs
    log(`[ast-grep-mcp] --directory is not a directory: ${abs}; falling back to process.cwd()`)
  } catch {
    log(`[ast-grep-mcp] requested directory does not exist: ${abs}; falling back to process.cwd()`)
  }
  return process.cwd()
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface McpServerOptions {
  /** Project root used as both ctx.directory and ctx.worktree. */
  directory: string
  /** stderr logger (defaults to process.stderr). */
  log?: (msg: string) => void
  /** Emit a one-line stderr trace per tool call (default: false). */
  trace?: boolean
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const log = options.log ?? defaultLog
  const root = resolveRoot(options.directory, log)
  const trace = options.trace ?? false

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  )

  for (const [name, def] of Object.entries(MCP_TOOLS)) {
    // `inputSchema` accepts a Zod raw shape; opencode's `def.args` is exactly
    // that. If a future SDK/tsc combo rejects the assignment, cast `def.args`
    // to `ZodRawShapeCompat` (from @modelcontextprotocol/sdk/server/zod-compat.js)
    // — a pure structural variance hint, no runtime effect.
    server.registerTool(
      name,
      { description: descriptionFor(name, def.description), inputSchema: def.args },
      async (parsedArgs, extra) => {
        const requestId = (extra as { requestId?: string | number }).requestId
        if (trace) log(`[ast-grep-mcp] tool=${name} req=${requestId ?? "mcp"}`)
        try {
          const ctx = buildToolContext(root, extra.signal, requestId)
          const text = await runTool(name, parsedArgs as Record<string, unknown>, ctx)
          return textResult(text)
        } catch (e) {
          // Catches: execute throws, the `{error}`-shape normalization
          // (normalizeToolResult), or provisioning failures. Note: unknown
          // *tool names* never reach here — the SDK pre-rejects those as
          // InvalidParams before dispatching to this callback.
          return errorResult(describeError(e))
        }
      },
    )
  }

  return server
}
