import pluginDefault, { tools } from "../../src/ast-grep/impl.ts"

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${cond || !detail ? "" : ` :: ${detail}`}`)
  if (!cond) failures += 1
}

check("default export is a function", typeof pluginDefault === "function")

const hooks = await pluginDefault({} as never, {})
check("plugin() resolves Hooks object", typeof hooks === "object" && hooks !== null)
check("event hook is a function", typeof hooks.event === "function")
check("tool registry is an object", typeof hooks.tool === "object" && hooks.tool !== null)

const expected = ["ast_grep_search", "ast_grep_replace", "ast_grep_scan", "ast_grep_validate"]
for (const name of expected) {
  const def = (hooks.tool as Record<string, unknown>)[name]
  const ok = typeof def === "object" && def !== null &&
    typeof (def as { description?: unknown }).description === "string" &&
    typeof (def as { args?: unknown }).args === "object" &&
    typeof (def as { execute?: unknown }).execute === "function"
  check(`tool registered: ${name}`, ok)
}

// Verify exported tools map matches the registry keys.
check("exported tools keys match registry", JSON.stringify(Object.keys(tools).sort()) === JSON.stringify(expected.sort()))

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log("\n[load] PASS")
