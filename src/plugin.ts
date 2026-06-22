// Single opencode plugin entry: registers all ast-grep tools.
//   - ast_grep_search / ast_grep_replace / ast_grep_scan / ast_grep_validate (from ./ast-grep)
//   - ast_grep_map (from ./ast-grep-map)
//
// Loaded by opencode via the thin shim at .opencode/plugins/ast-grep.ts, which
// re-exports this module's default. The ast-grep plugin carries the
// session.created event hook (background sg-binary provisioning); ast_grep_map
// registers its tool AND a session.created hook (background REPORT.md
// generation). Hooks.event is a single function (not keyed by event name) so
// the two plugins' event handlers are composed here and dispatched by event.type
// inside each handler.

import type { Plugin } from "@opencode-ai/plugin"
import astGrepPlugin from "./ast-grep/impl.js"
import astGrepMapPlugin from "./ast-grep-map/impl.js"

const plugin: Plugin = async (ctx) => {
  const astGrepHooks = await astGrepPlugin(ctx)
  const mapHooks = await astGrepMapPlugin(ctx)
  const astGrepEvent = astGrepHooks.event
  const mapEvent = mapHooks.event
  return {
    ...astGrepHooks,
    ...mapHooks,
    event: async (input: { event: any }) => {
      // Run both handlers; each is responsible for filtering event types.
      // Errors are caught per-handler so one failure cannot break the other.
      if (astGrepEvent) {
        try {
          await astGrepEvent(input)
        } catch {
          /* handler is expected to log internally */
        }
      }
      if (mapEvent) {
        try {
          await mapEvent(input)
        } catch {
          /* handler is expected to log internally */
        }
      }
    },
    tool: { ...(astGrepHooks.tool ?? {}), ...(mapHooks.tool ?? {}) },
  }
}

export default plugin
