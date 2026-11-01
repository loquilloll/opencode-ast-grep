// Single opencode plugin entry: registers all ast-grep tools.
//   - ast_grep_search / ast_grep_replace / ast_grep_scan / ast_grep_validate (from ./ast-grep)
//   - ast_grep_map (from ./ast-grep-map)
//
// Loaded by opencode via the thin shim at .opencode/plugins/ast-grep.ts, which
// re-exports this module's default. The ast-grep plugin carries the
// session.created event hook (background sg-binary provisioning); ast_grep_map
// registers its tool AND a session.created hook (background REPORT.md
// generation) PLUS event/`tool.execute.after` hooks for graph invalidation
// (improvement #1). Since `Hooks` keys are single functions (not arrays), the
// two plugins' hook handlers are composed here and dispatched by event.type /
// tool name inside each handler.

import { tool } from "@opencode-ai/plugin"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import astGrepPlugin from "./ast-grep/impl.js"
import astGrepMapPlugin from "./ast-grep-map/impl.js"

// Compose two plugin hook maps. Every `Hooks` key is a single async function;
// we wrap them so both plugins observe every event / tool call. Each handler
// is wrapped in try/catch with a debug log so one plugin's failure cannot
// break the other AND is observable when diagnosing silent drops. Exported for
// direct unit testing.
export function composeHooks(a: Hooks, b: Hooks): Hooks {
  const out: Hooks = { ...a, ...b }
  // Compose every key BOTH plugins define; last-wins is fine for keys only one
  // defines (already handled by the spread above).
  const eventKeys = new Set<keyof Hooks>([
    ...Object.keys(a) as (keyof Hooks)[],
    ...Object.keys(b) as (keyof Hooks)[],
  ])
  // Only chain async-function-valued hook keys (skip `tool` which is an object
  // map, not a function, and `dispose` which we leave per-plugin).
  const CHAINABLE: ReadonlySet<keyof Hooks> = new Set([
    "event",
    "config",
    "chat.message",
    "chat.params",
    "chat.headers",
    "permission.ask",
    "command.execute.before",
    "tool.execute.before",
    "tool.execute.after",
    "shell.env",
    "experimental.chat.messages.transform",
    "experimental.chat.system.transform",
    "experimental.provider.small_model",
    "experimental.session.compacting",
    "experimental.compaction.autocontinue",
    "experimental.text.complete",
    "tool.definition",
  ])
  for (const key of eventKeys) {
    if (!CHAINABLE.has(key)) continue
    const ah = a[key] as ((...args: any[]) => Promise<void>) | undefined
    const bh = b[key] as ((...args: any[]) => Promise<void>) | undefined
    if (!ah || !bh) continue
    out[key] = (async (...args: any[]) => {
      try {
        await ah(...args)
      } catch (e) {
        // Per-handler isolation: log to stderr so failures are observable
        // without breaking the sibling plugin's hook.
        try {
          console.error(`[opencode-ast-grep] plugin hook ${String(key)} (a) failed:`, e)
        } catch {
          /* console.error itself can throw in rare runtimes; ignore */
        }
      }
      try {
        await bh(...args)
      } catch (e) {
        try {
          console.error(`[opencode-ast-grep] plugin hook ${String(key)} (b) failed:`, e)
        } catch {
          /* ignore */
        }
      }
    }) as any
  }
  return out
}

const plugin: Plugin = async (ctx) => {
  const astGrepHooks = await astGrepPlugin(ctx)
  const mapHooks = await astGrepMapPlugin(ctx)
  return {
    ...composeHooks(astGrepHooks, mapHooks),
    tool: { ...(astGrepHooks.tool ?? {}), ...(mapHooks.tool ?? {}) },
  }
}

export default plugin

// ---------------------------------------------------------------------------
// opencode 2.x promise-plugin setup
//
// opencode 2.x only loads a scanned file whose default export decodes as
// `{ id, effect | setup }`; opencode 1.x accepts `{ id, server }` (its
// PluginModule shape) or a bare function. The shims (repo-local
// `.opencode/plugins/ast-grep.ts` and the global
// `~/.config/opencode/plugins/ast-grep.ts`) therefore default-export
// `{ id: "ast-grep", server: plugin, setup: v2Setup }` — 1.x calls `server`
// with its PluginInput, 2.x calls `setup` with its plugin Context and ignores
// the extra `server` key.
//
// This setup re-registers the same v1 tool definitions through v2's tool
// editor: the JSON Schema input is generated from each tool's zod `args`
// shape (zod 4 native toJSONSchema), the execute context is bridged (v2 has
// no per-tool directory, so the plugin location stands in for both
// `directory` and `worktree`), and string results are wrapped as v2
// `content`. The v1 event hooks (session.created sg provisioning + REPORT.md
// build, file-edit scope invalidation) have no v2 wiring here; map freshness
// falls back to its mtime+size manifest and `refresh: "always"`.

// Runtime shape of a v1 `tool({...})` definition. `tool()` is the identity
// function, so this is exactly what the impl modules export.
interface V1ToolDefinition {
  readonly description: string
  readonly args: Parameters<typeof tool.schema.object>[0]
  execute: (args: any, ctx: { directory?: string; worktree?: string; abort?: AbortSignal }) => Promise<unknown>
}

// Structural subset of opencode 2.x's promise-plugin Context
// (@opencode/plugin/promise/plugin.ts) and ToolEditor — enough to register
// tools without depending on the v2 package.
interface V2PluginContext {
  readonly location: { readonly directory: string }
  readonly tool: {
    readonly transform: (callback: (editor: V2ToolEditor) => void) => Promise<unknown>
  }
}

interface V2ToolEditor {
  add(definition: {
    name: string
    description: string
    input: unknown
    options: { codemode: false }
    execute: (input: any, context: { signal: AbortSignal }) => Promise<{ content: unknown; metadata?: unknown }>
  }): void
}

// v1 tool results are strings in every path these tools take; keep the object
// branch for the `{ title, output, metadata }` shape v1 allows.
function toV2Result(result: unknown): { content: unknown; metadata?: unknown } {
  if (typeof result === "string") return { content: result }
  if (result && typeof result === "object" && "output" in result) {
    const record = result as { output?: unknown; metadata?: unknown }
    return { content: record.output, metadata: record.metadata }
  }
  return { content: result }
}

export const v2Setup = async (ctx: V2PluginContext) => {
  const directory = ctx.location.directory
  const hooks = await plugin({ directory, worktree: directory } as Parameters<Plugin>[0])
  await ctx.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(hooks.tool ?? {}) as [string, V1ToolDefinition][]) {
      editor.add({
        name,
        description: definition.description,
        input: tool.schema.toJSONSchema(tool.schema.object(definition.args)),
        options: { codemode: false },
        execute: async (input, context) =>
          toV2Result(await definition.execute(input, { directory, worktree: directory, abort: context.signal })),
      })
    }
  })
}
