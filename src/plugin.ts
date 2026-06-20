// Single opencode plugin entry: registers all ast-grep tools.
//   - ast_grep_search / ast_grep_replace / ast_grep_scan / ast_grep_validate (from ./ast-grep)
//   - ast_grep_map (from ./ast-grep-map)
//
// Loaded by opencode via the thin shim at .opencode/plugins/ast-grep.ts, which
// re-exports this module's default. The ast-grep plugin carries the
// session.created event hook (background sg-binary provisioning); ast_grep_map
// only registers its tool.

import type { Plugin } from "@opencode-ai/plugin"
import astGrepPlugin from "./ast-grep/impl.js"
import { tools as mapTools } from "./ast-grep-map/impl.js"

const plugin: Plugin = async (ctx) => {
  const hooks = await astGrepPlugin(ctx)
  return {
    ...hooks,
    tool: { ...(hooks.tool ?? {}), ...mapTools },
  }
}

export default plugin
