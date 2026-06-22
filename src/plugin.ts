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
