#!/usr/bin/env node
// stdio entry point for the ast-grep MCP server.
//
// Spawned by any MCP client (Claude Code, Codex CLI, GitHub Copilot, Cursor,
// Cline, opencode, ...). Reads JSON-RPC from stdin, writes JSON-RPC to stdout
// (handled entirely by StdioServerTransport — nothing else may touch stdout).
//
// Project-root resolution (used as both ToolContext.directory and .worktree):
//   1. --directory <path> / -d <path>  (CLI arg, highest priority)
//   2. OP_AST_GREP_MCP_DIRECTORY        (env var)
//   3. process.cwd()                    (default; what most clients set)
//
// All diagnostics (help, warnings, fatal errors) go to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createMcpServer, describeError } from "./server.js"

const ENV_ROOT_KEY = "OP_AST_GREP_MCP_DIRECTORY"

interface ParsedArgs {
  directory?: string
  help: boolean
  trace: boolean
}

function printHelp(): void {
  process.stderr.write(
    [
      "ast-grep-mcp - MCP server exposing the ast-grep tools over stdio.",
      "",
      "Tools: ast_grep_search, ast_grep_replace, ast_grep_scan,",
      "       ast_grep_validate, ast_grep_map.",
      "",
      "Usage:",
      "  ast-grep-mcp [--directory <path>]",
      "",
      "Options:",
      "  -d, --directory <path>  Project root to search/map.",
      "                          Default: $" + ENV_ROOT_KEY + " or process.cwd().",
      "  --trace                 Emit a one-line stderr trace per tool call.",
      "  -h, --help              Show this help.",
      "",
      "Environment:",
      "  " + ENV_ROOT_KEY + "  Fallback project root if --directory is absent.",
      "",
      "Inherits the repo's other tuning knobs (OMO_AST_GREP_SG_PATH,",
      "OP_AST_GREP_MAP_DIR, ...).",
      "",
    ].join("\n"),
  )
}

function parseArgs(argv: string[]): ParsedArgs {
  let directory: string | undefined
  let help = false
  let trace = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      help = true
    } else if (a === "--trace") {
      trace = true
    } else if (a === "-d" || a === "--directory") {
      directory = argv[++i]
    } else if (a.startsWith("--directory=")) {
      directory = a.slice("--directory=".length)
    } else if (a.startsWith("-d=")) {
      directory = a.slice("-d=".length)
    }
  }
  return { directory, help, trace }
}

async function main(): Promise<void> {
  const { directory: argDir, help, trace } = parseArgs(process.argv.slice(2))
  if (help) {
    printHelp()
    process.exit(0)
  }

  const directory = argDir ?? process.env[ENV_ROOT_KEY] ?? process.cwd()

  const server = createMcpServer({ directory, trace })
  const transport = new StdioServerTransport()
  // server.connect() calls transport.start() internally — do NOT pre-start.
  await server.connect(transport)

  // Graceful shutdown so the client observes a clean transport close. A hard
  // 2s fallback guarantees the process exits even if server.close()/transport
  // .close() stall (e.g. a long tool call that didn't honor the abort signal),
  // and the second-Signal early-return below still lets a repeat Ctrl-C force
  // an immediate exit rather than deadlocking on `closing`.
  let closing = false
  const shutdown = (exitCode: number): void => {
    if (closing) {
      // Second signal during shutdown — force exit now.
      process.exit(exitCode)
    }
    closing = true
    // Hard fallback so a stalled close cannot hang the server.
    const force = setTimeout(() => process.exit(exitCode), 2000)
    force.unref()
    void (async () => {
      try {
        await server.close()
      } catch {
        /* ignore — best effort */
      }
      try {
        await transport.close()
      } catch {
        /* ignore */
      }
      clearTimeout(force)
      process.exit(exitCode)
    })()
  }
  // 130 = conventional "terminated by SIGINT" shell exit code.
  process.on("SIGINT", () => shutdown(130))
  process.on("SIGTERM", () => shutdown(143))
}

main().catch((e: unknown) => {
  process.stderr.write(`ast-grep-mcp failed to start: ${describeError(e)}\n`)
  process.exit(1)
})
