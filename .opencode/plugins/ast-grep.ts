// opencode scans .opencode/plugins/*.ts and loads each default export as a
// plugin. This shim just re-exports the real entry from src/, so the source
// lives in a normal project layout (src/) while opencode's discovery path is
// satisfied. For a published build, consume dist/ instead.

import plugin from "../../src/plugin.ts"

export default plugin
