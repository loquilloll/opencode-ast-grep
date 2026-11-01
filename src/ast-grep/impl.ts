// ast-grep as native opencode tools.
//
// Single-file plugin: registers 4 tools (`ast_grep_search`, `ast_grep_replace`,
// `ast_grep_scan`, `ast_grep_validate`) and auto-provisions the `sg`/`ast-grep`
// binary (pinned 0.45.2). Behavior ported verbatim from oh-my-openagent's
// vendored ast-grep skill (packages/utils/src/ast-grep/* and the Python helper).
//
// Runtime deps: `node:` builtins + `globalThis.fetch` only. Resolves
// `@opencode-ai/plugin` from the nearest node_modules (project or global).

import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { accessSync, constants, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path"
import { inflateRawSync } from "node:zlib"
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------

const SG_PINNED_VERSION = "0.45.2"

const SG_RELEASE_ASSETS = {
  "darwin-arm64": {
    sha256: "1fc21214234bf6f5a3f841d5b2493a4fc4b6087f69b055c9ad5f94f77c0ab76e",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.45.2/app-aarch64-apple-darwin.zip",
  },
  "darwin-x64": {
    sha256: "037e5b4a9aed2ba03a2b4710e4fe3439d5d1154d1266d5e8f9f6df7452169181",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.45.2/app-x86_64-apple-darwin.zip",
  },
  "linux-arm64": {
    sha256: "e67ee2f5928b4d77a472114edf6e227d90fefe22fa47e7a78db187c55d206564",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.45.2/app-aarch64-unknown-linux-gnu.zip",
  },
  "linux-x64": {
    sha256: "67aff72dd2994bf152fcc3a8a09cf93b13193abe59f39393095167c729af2015",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.45.2/app-x86_64-unknown-linux-gnu.zip",
  },
  "win32-arm64": {
    sha256: "2081ee4f8842a03ebc745967bb1bf0ed70edd4cde7858dfafae30fda07372bf3",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.45.2/app-aarch64-pc-windows-msvc.zip",
  },
  "win32-x64": {
    sha256: "e14c3e33c6813111a41b8e4307e13462ebb2fea783d17ae22fc50d32a04ea77d",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.45.2/app-x86_64-pc-windows-msvc.zip",
  },
} as const satisfies Record<string, { readonly sha256: string; readonly url: string }>

// 25 CLI languages supported by ast-grep (mirrors official docs).
const LANGUAGES: Record<string, string[]> = {
  bash: [".bash", ".sh", ".zsh"],
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hxx"],
  csharp: [".cs"],
  css: [".css"],
  elixir: [".ex", ".exs"],
  go: [".go"],
  haskell: [".hs"],
  html: [".html", ".htm"],
  java: [".java"],
  javascript: [".js", ".jsx", ".cjs", ".mjs"],
  json: [".json"],
  kotlin: [".kt", ".kts"],
  lua: [".lua"],
  nix: [".nix"],
  php: [".php"],
  python: [".py", ".pyi"],
  ruby: [".rb"],
  rust: [".rs"],
  scala: [".scala"],
  solidity: [".sol"],
  swift: [".swift"],
  typescript: [".ts", ".cts", ".mts"],
  tsx: [".tsx"],
  yaml: [".yml", ".yaml"],
}

// Aliases the CLI accepts; we normalize to the canonical name.
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  py: "python",
  py3: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  ex: "elixir",
  hs: "haskell",
  sh: "bash",
  zsh: "bash",
  cc: "cpp",
  "c++": "cpp",
  cxx: "cpp",
  cs: "csharp",
  yml: "yaml",
  sol: "solidity",
  golang: "go",
}

const SG_PATH_ENV_KEY = "OMO_AST_GREP_SG_PATH"
const RUNTIME_DIR_ENV_KEY = "OP_AST_GREP_RUNTIME_DIR"
const SG_RUN_TIMEOUT_MS = 300_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000

const MAX_DISPLAY_MATCHES = 50
const MAX_JSON_MATCHES = 500
const MAX_PREVIEW_LEN = 200
// Improvement #5: byte-precise stdout/stderr cap. SIGTERM the child once the
// cap is exceeded so the opencode process is not stuck draining a runaway sg.
const DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024

// ---------------------------------------------------------------------------
// 3. Slug helpers
// ---------------------------------------------------------------------------

function normalizeRuntimePlatform(platform: NodeJS.Platform = process.platform): "darwin" | "linux" | "win32" {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform
  return "linux"
}

function normalizeRuntimeArch(arch: string = process.arch): "arm64" | "x64" {
  if (arch === "arm64" || arch === "aarch64") return "arm64"
  return "x64"
}

export function runtimeSlug(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${normalizeRuntimePlatform(platform)}-${normalizeRuntimeArch(arch)}`
}

function sgBinaryName(platform: NodeJS.Platform = process.platform): string {
  return normalizeRuntimePlatform(platform) === "win32" ? "sg.exe" : "sg"
}

// ---------------------------------------------------------------------------
// 4. Resolver
// ---------------------------------------------------------------------------

function nonEmptyValue(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed
}

function defaultFileExists(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  try {
    const stats = statSync(filePath)
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolvePathValue(): string | undefined {
  if (process.platform === "win32") return process.env["Path"] ?? process.env["PATH"]
  return process.env["PATH"]
}

function isUnsafeCommandName(commandName: string): boolean {
  if (commandName.includes("/") || commandName.includes("\\")) return true
  if (commandName === "." || commandName === ".." || commandName.includes("..")) return true
  if (/^[a-zA-Z]:/.test(commandName)) return true
  if (commandName.includes("\0")) return true
  return false
}

function getWindowsCandidates(commandName: string): string[] {
  if (process.platform !== "win32") return [commandName]
  if (/\.[^\\/]+$/.test(commandName)) return [commandName]
  return [commandName, `${commandName}.exe`, `${commandName}.cmd`, `${commandName}.bat`, `${commandName}.com`]
}

type BunWhichRuntime = { which?(commandName: string): string | null }
const bunRuntime = globalThis as typeof globalThis & { readonly Bun?: BunWhichRuntime }

export function which(commandName: string): string | null {
  if (!commandName) return null
  if (isUnsafeCommandName(commandName)) return null
  const candidateNames = getWindowsCandidates(commandName)
  for (const candidateName of candidateNames) {
    const resolved = bunRuntime.Bun?.which?.(candidateName) ?? null
    if (resolved) return resolved
  }
  const pathValue = resolvePathValue()
  if (!pathValue) return null
  const pathEntries = pathValue.split(delimiter).filter((entry) => entry.length > 0)
  if (pathEntries.length === 0) return null
  for (const pathEntry of pathEntries) {
    for (const candidateName of candidateNames) {
      const candidatePath = join(pathEntry, candidateName)
      if (isExecutable(candidatePath)) return candidatePath
    }
  }
  return null
}

function pathCommandCandidates(platform: NodeJS.Platform): readonly string[] {
  // Linux: prefer `ast-grep` over `sg` (sg collides with util-linux setgroups).
  return platform === "linux" ? ["ast-grep", "sg"] : ["sg", "ast-grep"]
}

function defaultVersionProbe(binaryPath: string): string {
  // spawnSync with stderr discarded: Bun's execFileSync leaks child stderr to
  // the console, which surfaces shadow-utils' "Usage: sg group ..." when probing
  // /usr/bin/sg. Ignoring stderr keeps the probe silent while still rejecting
  // non-ast-grep binaries via the thrown error below.
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`version probe exited with status ${result.status}`)
  return result.stdout ?? ""
}

function isAstGrepVersionOutput(output: string): boolean {
  return output.toLowerCase().includes("ast-grep")
}

function hasAstGrepVersion(binaryPath: string, probe: (path: string) => string): boolean {
  try {
    return isAstGrepVersionOutput(probe(binaryPath))
  } catch {
    return false
  }
}

export interface SgResolverOptions {
  readonly arch?: string
  readonly env?: NodeJS.ProcessEnv
  readonly fileExists?: (filePath: string) => boolean
  readonly platform?: NodeJS.Platform
  readonly runtimeDir?: string
  readonly runVersionProbeSync?: (binaryPath: string) => string
  readonly which?: (commandName: string) => string | null
}

export function findSgBinarySync(options: SgResolverOptions = {}): string | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const fileExists = options.fileExists ?? defaultFileExists
  const runVersionProbeSync = options.runVersionProbeSync ?? defaultVersionProbe
  const whichImpl = options.which ?? which
  try {
    const envOverride = nonEmptyValue(env[SG_PATH_ENV_KEY])
    if (envOverride !== null && fileExists(envOverride)) return envOverride

    if (options.runtimeDir !== undefined) {
      const runtimeCandidate = join(options.runtimeDir, sgBinaryName(platform))
      if (fileExists(runtimeCandidate)) return runtimeCandidate
    }

    for (const commandName of pathCommandCandidates(platform)) {
      const pathCandidate = whichImpl(commandName)
      if (pathCandidate === null || !fileExists(pathCandidate)) continue
      // Any `sg` hit must actually be ast-grep (defeats /usr/bin/sg shadow-utils).
      if (commandName !== "sg" || hasAstGrepVersion(pathCandidate, runVersionProbeSync)) return pathCandidate
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 5. Zip extractor + provisionSgBinary (verbatim port of sg-provisioner.ts)
// ---------------------------------------------------------------------------

export type SgProvisionErrorCode = "bad_checksum" | "download_failed" | "extract_failed" | "unsupported_platform" | "write_failed"

export class SgProvisionError extends Error {
  readonly code: SgProvisionErrorCode
  constructor(code: SgProvisionErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options)
    this.name = "SgProvisionError"
    this.code = code
  }
}

interface ZipCentralEntry {
  readonly compressedSize: number
  readonly localHeaderOffset: number
  readonly method: number
  readonly name: string
  readonly uncompressedSize: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_SENTINEL = 0xffffffff

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function timeoutSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

type SgFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>

async function downloadAsset(url: string, fetchImpl: SgFetch | undefined, signal: AbortSignal): Promise<Buffer> {
  const activeFetch = fetchImpl ?? globalThis.fetch
  let response: Response
  try {
    response = await activeFetch(url, { signal })
  } catch (error) {
    throw new SgProvisionError("download_failed", `failed to download ast-grep ${SG_PINNED_VERSION} from ${url}: ${describeFailure(error)}`, { cause: error })
  }
  if (!response.ok) {
    throw new SgProvisionError("download_failed", `failed to download ast-grep ${SG_PINNED_VERSION} from ${url}: HTTP ${response.status}`)
  }
  try {
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new SgProvisionError("download_failed", `failed to read ast-grep ${SG_PINNED_VERSION} download from ${url}: ${describeFailure(error)}`, { cause: error })
  }
}

function zipEntryBaseName(entryName: string): string {
  const segments = entryName.split("/")
  return segments[segments.length - 1] ?? entryName
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const lowestOffset = Math.max(0, zip.length - 22 - 65_535)
  for (let offset = zip.length - 22; offset >= lowestOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new SgProvisionError("extract_failed", "downloaded ast-grep asset is not a zip archive")
}

function listZipEntries(zip: Buffer): readonly ZipCentralEntry[] {
  const eocdOffset = findEndOfCentralDirectory(zip)
  const entryCount = zip.readUInt16LE(eocdOffset + 10)
  let cursor = zip.readUInt32LE(eocdOffset + 16)
  const entries: ZipCentralEntry[] = []
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new SgProvisionError("extract_failed", "downloaded ast-grep zip central directory is corrupt")
    }
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    entries.push({
      compressedSize: zip.readUInt32LE(cursor + 20),
      localHeaderOffset: zip.readUInt32LE(cursor + 42),
      method: zip.readUInt16LE(cursor + 10),
      name: zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"),
      uncompressedSize: zip.readUInt32LE(cursor + 24),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function decompressZipEntry(raw: Buffer, entry: ZipCentralEntry): Buffer {
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return inflateRawSync(raw)
  throw new SgProvisionError("extract_failed", `ast-grep zip entry ${entry.name} uses unsupported compression method ${entry.method}`)
}

function readZipEntryBytes(zip: Buffer, entry: ZipCentralEntry): Buffer {
  if (entry.compressedSize === ZIP64_SENTINEL || entry.uncompressedSize === ZIP64_SENTINEL || entry.localHeaderOffset === ZIP64_SENTINEL) {
    throw new SgProvisionError("extract_failed", `ast-grep zip entry ${entry.name} uses unsupported zip64 extensions`)
  }
  if (zip.readUInt32LE(entry.localHeaderOffset) !== LOCAL_SIGNATURE) {
    throw new SgProvisionError("extract_failed", `ast-grep zip entry ${entry.name} has a corrupt local header`)
  }
  const nameLength = zip.readUInt16LE(entry.localHeaderOffset + 26)
  const extraLength = zip.readUInt16LE(entry.localHeaderOffset + 28)
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength
  const bytes = decompressZipEntry(zip.subarray(dataStart, dataStart + entry.compressedSize), entry)
  if (bytes.length !== entry.uncompressedSize) {
    throw new SgProvisionError("extract_failed", `ast-grep zip entry ${entry.name} inflated to ${bytes.length} bytes, expected ${entry.uncompressedSize}`)
  }
  return bytes
}

function extractStandaloneSgBinary(zip: Buffer, platform: NodeJS.Platform): Buffer {
  const suffix = platform === "win32" ? ".exe" : ""
  const entries = listZipEntries(zip)
  const preferredNames = [`ast-grep${suffix}`, `sg${suffix}`]
  for (const preferred of preferredNames) {
    const entry = entries.find((candidate) => zipEntryBaseName(candidate.name) === preferred)
    if (entry !== undefined) return readZipEntryBytes(zip, entry)
  }
  throw new SgProvisionError("extract_failed", `ast-grep release zip has no standalone ${preferredNames.join(" or ")} binary`)
}

function assertInsideTarget(targetDir: string, filePath: string): void {
  const relativePath = relative(targetDir, filePath)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new SgProvisionError("write_failed", `refusing to write ast-grep binary outside targetDir: ${filePath}`)
  }
}

export interface SgProvisionOptions {
  readonly arch?: string
  readonly fetchImpl?: SgFetch
  readonly platform?: NodeJS.Platform
  readonly releaseAssets?: Partial<Record<string, { readonly sha256: string; readonly url: string }>>
  readonly signal?: AbortSignal
  readonly targetDir: string
}

export async function provisionSgBinary(options: SgProvisionOptions): Promise<string> {
  const platform = options.platform ?? process.platform
  const slug = runtimeSlug(platform, options.arch ?? process.arch)
  const asset = options.releaseAssets?.[slug] ?? SG_RELEASE_ASSETS[slug]
  if (asset === undefined) {
    throw new SgProvisionError("unsupported_platform", `ast-grep ${SG_PINNED_VERSION} has no asset for ${slug}`)
  }
  const targetDir = resolve(options.targetDir)
  const destination = join(targetDir, sgBinaryName(platform))
  const tempPath = join(targetDir, `.sg-${randomUUID().slice(0, 8)}.partial`)
  assertInsideTarget(targetDir, destination)
  assertInsideTarget(targetDir, tempPath)

  try {
    await mkdir(targetDir, { recursive: true })
    const archive = await downloadAsset(asset.url, options.fetchImpl, timeoutSignal(options.signal))
    const actualSha256 = sha256(archive)
    if (actualSha256 !== asset.sha256) {
      throw new SgProvisionError("bad_checksum", `checksum mismatch for ${basename(asset.url)}: expected ${asset.sha256}, got ${actualSha256}`)
    }
    await writeFile(tempPath, extractStandaloneSgBinary(archive, platform))
    await chmod(tempPath, 0o755)
    await rename(tempPath, destination)
    return destination
  } catch (error) {
    await rm(tempPath, { force: true })
    if (error instanceof SgProvisionError) throw error
    throw new SgProvisionError("write_failed", `failed to provision ast-grep ${SG_PINNED_VERSION} into ${targetDir}: ${describeFailure(error)}`, { cause: error })
  }
}

// ---------------------------------------------------------------------------
// 6. Provisioning trigger (in-flight Map keyed by target dir)
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<string>>()

function isDirUsable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.probe-${randomUUID().slice(0, 6)}`)
    writeFileSync(probe, "x")
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

let cachedRuntimeBase: string | undefined

function pickRuntimeBase(): string {
  if (cachedRuntimeBase !== undefined) return cachedRuntimeBase
  const override = nonEmptyValue(process.env[RUNTIME_DIR_ENV_KEY])
  const candidates: string[] = []
  if (override) candidates.push(resolve(override))
  candidates.push(resolve(join(homedir(), ".config", "opencode", "runtime", "ast-grep")))
  candidates.push(resolve(join(homedir(), ".cache", "opencode", "runtime", "ast-grep")))
  candidates.push(resolve(join(process.cwd(), ".opencode", "runtime", "ast-grep")))
  for (const candidate of candidates) {
    if (isDirUsable(candidate)) {
      cachedRuntimeBase = candidate
      return candidate
    }
  }
  // Last resort: the (likely unwritable) global dir so the error is actionable.
  cachedRuntimeBase = override ? resolve(override) : candidates[1]
  return cachedRuntimeBase
}

export function runtimeTargetDir(slug: string = runtimeSlug()): string {
  return join(pickRuntimeBase(), slug)
}

export function ensureProvisioned(targetDir: string): Promise<string> {
  const existing = inFlight.get(targetDir)
  if (existing) return existing
  const attempt = provisionSgBinary({ targetDir }).finally(() => {
    inFlight.delete(targetDir)
  })
  inFlight.set(targetDir, attempt)
  return attempt
}

async function getBinaryOrError(): Promise<{ binary: string } | { error: string }> {
  const targetDir = runtimeTargetDir()
  const existing = findManagedSgBinary(targetDir)
  if (existing) return { binary: existing }
  try {
    // ensureProvisioned downloads the pinned version and renames it over any
    // stale binary, so its return value is the fresh destination path.
    return { binary: await ensureProvisioned(targetDir) }
  } catch (err) {
    return { error: missingBinaryMessage(err) }
  }
}

function scheduleBackgroundProvision(): void {
  const targetDir = runtimeTargetDir()
  if (findManagedSgBinary(targetDir)) return
  const handle = setTimeout(() => {
    void ensureProvisioned(targetDir).catch(() => {})
  }, 0)
  handle.unref()
}

function isPinnedSgVersion(binaryPath: string): boolean {
  try {
    return defaultVersionProbe(binaryPath).includes(SG_PINNED_VERSION)
  } catch {
    return false
  }
}

// The runtime dir is not version-keyed, so a previously provisioned binary can
// lag the pin. Only the binary we provisioned there is version-managed: env
// overrides and PATH hits are the user's explicit choice and are returned as-is.
function findManagedSgBinary(targetDir: string): string | null {
  const binary = findSgBinarySync({ runtimeDir: targetDir })
  if (binary === null) return null
  if (binary === join(targetDir, sgBinaryName()) && !isPinnedSgVersion(binary)) return null
  return binary
}

function missingBinaryMessage(err?: unknown): string {
  const targetDir = runtimeTargetDir()
  const detail = err instanceof Error ? err.message : err ? String(err) : ""
  return [
    "ast-grep binary not found and automatic provisioning did not succeed.",
    detail ? `Detail: ${detail}` : null,
    `Pinned version: ${SG_PINNED_VERSION}. Target dir: ${targetDir}`,
    "Set OMO_AST_GREP_SG_PATH to an existing ast-grep binary, or install ast-grep on PATH (e.g. npm i -g @ast-grep/cli).",
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
}

// ---------------------------------------------------------------------------
// 7. Validator (verbatim port of the Python helper's pattern hint logic)
// ---------------------------------------------------------------------------

interface RegexAntipattern {
  readonly regex: RegExp
  readonly message: string
}

const REGEX_ANTIPATTERNS: readonly RegexAntipattern[] = [
  {
    regex: /\\w|\\d|\\s|\\b/,
    message: "Backslash escapes (\\w, \\d, \\s, \\b) are regex syntax, not ast-grep. Use $VAR to capture any identifier, or switch to grep for text patterns.",
  },
  {
    regex: /(?<!\$)\.\*|(?<!\$)\.\+/,
    message: "'.*' and '.+' are regex wildcards, not ast-grep. Use $$$ between AST fragments to match many nodes, or $VAR for one node.",
  },
  {
    regex: /\[[a-zA-Z0-9-]+\]/,
    message: "Character classes like '[a-z]' are regex syntax. ast-grep has no AST equivalent - use grep for character-level patterns.",
  },
]

function findAlternation(pattern: string): boolean {
  const stripped = pattern.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "")
  return /\w\s*\|\s*\w/.test(stripped) && !stripped.includes("||")
}

function langSpecificHints(pattern: string, lang: string | undefined): string[] {
  if (!lang) return []
  const canonical = LANG_ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()
  const hints: string[] = []

  if (canonical === "python") {
    if (/^\s*(def|class)\s+\$?\w+[^:]*:\s*$/m.test(pattern)) {
      hints.push("Python pattern has trailing ':'. ast-grep parses pattern as a complete definition - drop the trailing colon. Try: 'def $FUNC($$$)' or 'class $C($$$)'.")
    }
  }
  if (canonical === "javascript" || canonical === "typescript" || canonical === "tsx") {
    if (/^\s*(async\s+)?function\s+\$?\w+\s*$/.test(pattern)) {
      hints.push("JS/TS function pattern is incomplete. Add params and body: 'function $NAME($$$) { $$$ }'.")
    }
  }
  if (canonical === "go") {
    if (/^\s*func\s+\$?\w+\s*$/.test(pattern)) {
      hints.push("Go function pattern is incomplete. Add params and body: 'func $NAME($$$) { $$$ }'.")
    }
  }
  if (canonical === "rust") {
    if (/^\s*fn\s+\$?\w+\s*$/.test(pattern)) {
      hints.push("Rust fn pattern is incomplete. Add params, return type, and body: 'fn $NAME($$$) -> $RET { $$$ }' (or '-> ()' if returning unit).")
    }
  }

  return hints
}

export function validatePattern(pattern: string, lang: string | undefined): string[] {
  const hints: string[] = []
  for (const { regex, message } of REGEX_ANTIPATTERNS) {
    if (regex.test(pattern)) hints.push(message)
  }
  if (findAlternation(pattern)) {
    hints.push("Literal '|' alternation is regex syntax, not ast-grep. Run two separate ast-grep calls (one per alternative), or switch to grep.")
  }
  hints.push(...langSpecificHints(pattern, lang))
  return hints
}

export function resolveLang(lang: string | undefined): { readonly canonical?: string } | { readonly error: string } {
  if (!lang) return {}
  const canonical = LANG_ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()
  if (!(canonical in LANGUAGES)) {
    return { error: `unknown language '${lang}'. Supported: ${Object.keys(LANGUAGES).sort().join(", ")} (aliases: ts, js, py, go, rs, ...).` }
  }
  return { canonical }
}

// ---------------------------------------------------------------------------
// 8. Subprocess helpers
// ---------------------------------------------------------------------------

export interface SgResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly truncated: boolean
  readonly truncatedReason?: "max_output_bytes"
}

// Append `chunk` to `current` while keeping the total under `maxBytes`. Uses
// binary search on UTF-8 byte length so we never split a multi-byte codepoint.
// Returns { value, exceeded } where `exceeded` flags that the chunk had to be
// truncated. Ported from the sibling impl's `appendWithCap`.
export function appendWithCap(current: string, chunk: string, maxBytes: number): { value: string; exceeded: boolean } {
  const currentBytes = Buffer.byteLength(current)
  if (currentBytes >= maxBytes) {
    return { value: current, exceeded: true }
  }
  const remainingBytes = maxBytes - currentBytes
  const chunkBytes = Buffer.byteLength(chunk)
  if (chunkBytes <= remainingBytes) {
    return { value: current + chunk, exceeded: false }
  }
  // Find the largest UTF-8-safe slice of `chunk` that fits in `remainingBytes`.
  let low = 0
  let high = chunk.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const slice = chunk.slice(0, mid)
    if (Buffer.byteLength(slice) <= remainingBytes) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return { value: current + chunk.slice(0, low), exceeded: true }
}

export function runProcess(
  binary: string,
  args: readonly string[],
  opts: {
    readonly cwd: string
    readonly timeoutMs: number
    readonly signal?: AbortSignal
    readonly maxOutputBytes?: number
  },
): Promise<SgResult> {
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  return new Promise((resolveFn) => {
    const child = spawn(binary, args as string[], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let killedForOutputCap = false

    const onStdout = (chunk: string) => {
      const next = appendWithCap(stdout, chunk, maxBytes)
      stdout = next.value
      if (next.exceeded && !killedForOutputCap) {
        killedForOutputCap = true
        try {
          child.kill("SIGTERM")
        } catch {
          /* ignore */
        }
      }
    }
    const onStderr = (chunk: string) => {
      const next = appendWithCap(stderr, chunk, maxBytes)
      stderr = next.value
      if (next.exceeded && !killedForOutputCap) {
        killedForOutputCap = true
        try {
          child.kill("SIGTERM")
        } catch {
          /* ignore */
        }
      }
    }
    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", onStderr)

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs)

    const onAbort = () => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }
    const signal = opts.signal
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }

    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
      resolveFn({
        code,
        stdout,
        stderr,
        timedOut,
        truncated: killedForOutputCap,
        truncatedReason: killedForOutputCap ? "max_output_bytes" : undefined,
      })
    }

    child.on("error", (err: Error) => {
      stderr += `\nspawn error: ${err.message}`
      finish(-1)
    })
    child.on("close", (code: number | null) => finish(code === null ? -1 : code))
  })
}

export async function runSgRun(
  binary: string,
  args: string[],
  opts: { readonly cwd: string; readonly signal: AbortSignal },
): Promise<SgResult & { readonly ok: boolean }> {
  const res = await runProcess(binary, args, { cwd: opts.cwd, timeoutMs: SG_RUN_TIMEOUT_MS, signal: opts.signal })
  // sg run: exit 0 = match, 1 = no match — both fine. >=2 = failure.
  const ok = !res.timedOut && (res.code === 0 || res.code === 1)
  return { ...res, ok }
}

function sgRunError(res: SgResult & { readonly ok: boolean }): string {
  if (res.timedOut) return `ast-grep call timed out after ${Math.round(SG_RUN_TIMEOUT_MS / 1000)}s.`
  const stderr = res.stderr.trim()
  return `ast-grep failed (exit ${res.code}).${stderr ? `\n${stderr}` : ""}`
}

// ---------------------------------------------------------------------------
// Output formatting (parses `--json=compact`, salvages truncated output)
// ---------------------------------------------------------------------------

interface SgMatch {
  readonly file?: string
  readonly text?: string
  readonly replacement?: string
  readonly range?: {
    readonly start?: { readonly line?: number; readonly column?: number }
    readonly end?: { readonly line?: number; readonly column?: number }
  }
}

export function parseCompactJson(text: string): SgMatch[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const data = JSON.parse(trimmed)
    if (Array.isArray(data)) return data as SgMatch[]
    return []
  } catch {
    // Line-by-line salvage for truncated output.
    const results: SgMatch[] = []
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/,+$/, "")
      if (!line.startsWith("{")) continue
      try {
        const obj = JSON.parse(line)
        if (obj && typeof obj === "object" && !Array.isArray(obj)) results.push(obj as SgMatch)
      } catch {
        /* skip */
      }
    }
    return results
  }
}

// Improvement #5: structured parse with truncation status + JSON bracket-repair.
// When the output was externally truncated (SIGTERM-on-cap), the trailing JSON
// is likely partial. We first try a strict JSON.parse; on failure we attempt a
// `lastIndexOf("},")` repair to recover the matches that completed before the
// truncation point.
export type SgParseResult = {
  matches: SgMatch[]
  totalMatches: number
  truncated: boolean
  truncatedReason?: "max_matches" | "max_output_bytes"
  repairUsed: boolean
}

export function parseCompactJsonWithStatus(
  text: string,
  externallyTruncated: boolean,
  opts: { maxMatches?: number } = {},
): SgParseResult {
  const trimmed = text.trim()
  const cap = opts.maxMatches ?? MAX_JSON_MATCHES
  if (!trimmed) {
    return { matches: [], totalMatches: 0, truncated: externallyTruncated, repairUsed: false }
  }

  let matches: SgMatch[] = []
  let repairUsed = false

  try {
    const data = JSON.parse(trimmed)
    if (Array.isArray(data)) {
      matches = data as SgMatch[]
    }
  } catch {
    // Bracket-repair: recover complete objects from truncated JSON.
    // Two strategies, simple-first then conservative:
    //   (a) Trim back to the last `}` and append `]`. This handles the common
    //       case where truncation lands right after a complete object's `}`.
    //   (b) Trim back to the last `},` (inter-object separator) and append `]`.
    //       This handles the mid-object truncation case where `}` belongs to a
    //       nested value (e.g. the `range` sub-object) and the outer object is
    //       incomplete. Strategy (a) would produce unbalanced braces here.
    // We try (a) first because it's the more common case AND recovers more
    // matches; (b) is the conservative fallback.
    if (externallyTruncated) {
      const lastClosed = trimmed.lastIndexOf("}")
      if (lastClosed > 0) {
        // Strategy (a): simple close+bracket. Recovers all complete objects.
        const simpleRepair = `${trimmed.substring(0, lastClosed + 1)}]`
        try {
          const data = JSON.parse(simpleRepair)
          if (Array.isArray(data)) {
            matches = data as SgMatch[]
            repairUsed = true
          }
        } catch {
          /* simple repair didn't parse — try conservative */
        }
        // Strategy (b): conservative trim-to-`,`.
        if (matches.length === 0) {
          const bracketIdx = trimmed.lastIndexOf("},", lastClosed)
          if (bracketIdx > 0) {
            const conservativeRepair = `${trimmed.substring(0, bracketIdx + 1)}]`
            try {
              const data = JSON.parse(conservativeRepair)
              if (Array.isArray(data)) {
                matches = data as SgMatch[]
                repairUsed = true
              }
            } catch {
              /* fall through to line salvage */
            }
          }
        }
      }
    }
    // Line-by-line salvage (catches unusual multi-line shapes). Gated on
    // externallyTruncated for safety: sg's --json=compact emits a single line,
    // so ungated salvage would be dead code today. If sg changes its output
    // shape, this remains a useful fallback.
    if (matches.length === 0 && externallyTruncated) {
      for (const rawLine of trimmed.split(/\r?\n/)) {
        const line = rawLine.trim().replace(/,+$/, "")
        if (!line.startsWith("{")) continue
        try {
          const obj = JSON.parse(line)
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            matches.push(obj as SgMatch)
            repairUsed = true
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  const totalMatches = matches.length
  const matchesTruncated = totalMatches > cap
  const finalMatches = matchesTruncated ? matches.slice(0, cap) : matches
  const truncated = externallyTruncated || matchesTruncated
  // Reason precedence: max_output_bytes is the root cause when set (it caused
  // the JSON parse failure that triggered salvage + may also have triggered the
  // secondary cap); surface it so the user knows to narrow the query.
  const truncatedReason = externallyTruncated
    ? "max_output_bytes"
    : matchesTruncated
      ? "max_matches"
      : undefined
  return {
    matches: finalMatches,
    totalMatches,
    truncated,
    truncatedReason,
    repairUsed,
  }
}

function firstLine(value: string): string {
  const idx = value.indexOf("\n")
  return idx === -1 ? value : value.slice(0, idx)
}

// GitHub-style range token: 0-based in -> 1-based "L<n>" or "L<start>-L<end>".
function lineRangeToken(startLine: number | undefined, endLine: number | undefined): string {
  const s = (startLine ?? 0) + 1
  const e = (endLine ?? startLine ?? 0) + 1
  return s === e ? `L${s}` : `L${s}-L${e}`
}

export function formatMatches(matches: readonly SgMatch[], showReplacement: boolean): string {
  if (matches.length === 0) return "(no matches)"
  const byFile = new Map<string, SgMatch[]>()
  for (const match of matches) {
    const file = match.file ?? "?"
    const items = byFile.get(file) ?? []
    items.push(match)
    byFile.set(file, items)
  }
  // Right-align the range tokens within the whole result so declarations line up.
  const allTokens = matches.map((m) => lineRangeToken(m.range?.start?.line, m.range?.end?.line))
  const width = Math.max(1, ...allTokens.map((t) => t.length))
  const lines: string[] = []
  for (const file of [...byFile.keys()].sort()) {
    const items = byFile.get(file)!
    const noun = items.length === 1 ? "match" : "matches"
    lines.push(`${file} (${items.length} ${noun})`)
    for (const match of items) {
      const tok = lineRangeToken(match.range?.start?.line, match.range?.end?.line).padStart(width)
      const preview = firstLine(match.text ?? "").slice(0, MAX_PREVIEW_LEN)
      lines.push(`  ${tok}  ${preview}`)
      if (showReplacement && match.replacement !== undefined) {
        const replacement = firstLine(match.replacement ?? "").slice(0, MAX_PREVIEW_LEN)
        lines.push(`  ${" ".repeat(width)}  -> ${replacement}`)
      }
    }
  }
  return lines.join("\n")
}

// Format a structured parse result with a leading `[TRUNCATED]` block when
// applicable. Improvement #5: surfaces the truncation reason to the caller.
export function formatSgResult(parsed: SgParseResult, showReplacement: boolean): string {
  const blocks: string[] = []
  if (parsed.truncated) {
    const reason =
      parsed.truncatedReason === "max_matches"
        ? `showing first ${parsed.matches.length} of ${parsed.totalMatches}`
        : parsed.truncatedReason === "max_output_bytes"
          ? "output exceeded 1MB limit"
          : "results truncated"
    blocks.push(`[TRUNCATED] Results truncated (${reason})`)
    blocks.push("")
  }
  blocks.push(formatMatches(parsed.matches, showReplacement))
  return blocks.join("\n")
}

function matchFileCount(matches: readonly SgMatch[]): number {
  return new Set(matches.map((match) => match.file ?? "?")).size
}

function buildPaths(paths: string[] | undefined): string[] {
  return paths && paths.length > 0 ? paths : ["."]
}

function resolveRoot(ctx: ToolContext): string {
  return ctx.directory || ctx.worktree
}

// ---------------------------------------------------------------------------
// 9. The 4 tool definitions
// ---------------------------------------------------------------------------

const stringArg = (description: string) => tool.schema.string().describe(description)

const ast_grep_search = tool({
  description:
    "Search code by ast-grep AST pattern. Returns matches as `file:line:col preview` plus a file-count summary. Use $VAR for a single node and $$$ to match many nodes (NOT regex). Output is byte-capped at 1 MB (child SIGTERM'd on cap; partial JSON salvaged via bracket-repair) and at 500 matches for JSON mode / 50 for human display.",
  args: {
    pattern: stringArg("ast-grep AST pattern, e.g. 'console.log($MSG)'. Use $VAR for one node, $$$ for many."),
    lang: tool.schema.string().optional().describe("Language alias (ts, js, py, go, rs, ...) or canonical name."),
    paths: tool.schema.array(tool.schema.string()).optional().describe("Paths to search (default: session directory)."),
    globs: tool.schema.array(tool.schema.string()).optional().describe("Include/exclude globs (prefix '!' to exclude)."),
    context: tool.schema.number().optional().describe("Lines of context around each match (sg -C)."),
    json: tool.schema.boolean().optional().describe("Return raw JSON instead of human-formatted matches."),
    force: tool.schema.boolean().optional().describe("Skip pattern-hint validation and call ast-grep anyway."),
  },
  execute: async (args, ctx) => {
    const langResult = resolveLang(args.lang)
    if ("error" in langResult) return langResult.error
    const lang = langResult.canonical

    const hints = validatePattern(args.pattern, lang)
    if (hints.length > 0 && !args.force) {
      return ["pattern looks invalid for ast-grep:", ...hints.map((hint) => `  - ${hint}`), "Pass force=true to call ast-grep anyway."].join("\n")
    }

    const got = await getBinaryOrError()
    if ("error" in got) return got.error

    const cwd = resolveRoot(ctx)
    const sgArgs = ["run", "-p", args.pattern, "--json=compact"]
    if (lang) sgArgs.push("--lang", lang)
    if (typeof args.context === "number") sgArgs.push("-C", String(args.context))
    for (const glob of args.globs ?? []) sgArgs.push("--globs", glob)
    sgArgs.push(...buildPaths(args.paths))

    const res = await runSgRun(got.binary, sgArgs, { cwd, signal: ctx.abort })
    if (!res.ok) return sgRunError(res)

    const parsed = parseCompactJsonWithStatus(res.stdout, res.truncated)

    if (args.json) {
      const shown = parsed.matches.slice(0, MAX_JSON_MATCHES)
      const note = parsed.totalMatches > MAX_JSON_MATCHES ? `\n... (${parsed.totalMatches} matches total, showing first ${MAX_JSON_MATCHES})` : ""
      return `${JSON.stringify(shown)}${note}`
    }

    if (parsed.matches.length === 0 && !parsed.truncated) return "(no matches)"
    // Apply the display cap on top of the JSON cap so even un-bounded searches
    // stay readable in the opencode UI. formatSgResult already prepends a
    // `[TRUNCATED] showing first N of M` block, so no separate suffix here.
    const displayMatches =
      parsed.matches.length > MAX_DISPLAY_MATCHES ? parsed.matches.slice(0, MAX_DISPLAY_MATCHES) : parsed.matches
    const displayTruncation = parsed.matches.length > MAX_DISPLAY_MATCHES
    const displayParsed: SgParseResult = displayTruncation
      ? {
          matches: displayMatches,
          totalMatches: parsed.totalMatches,
          truncated: true,
          truncatedReason: "max_matches",
          repairUsed: parsed.repairUsed,
        }
      : parsed
    return formatSgResult(displayParsed, false)
  },
})

const ast_grep_replace = tool({
  description:
    "Rewrite code by ast-grep AST pattern. Dry-run by default (shows what would change); pass apply=true to mutate files. Two-pass: JSON preview then --update-all (sg silently ignores --update-all when --json is set). Pass-1 output is byte-capped at 1 MB (child SIGTERM'd on cap; partial JSON salvaged) — when truncated, the apply step uses the recovered count which may be lower than the true total.",
  args: {
    pattern: stringArg("ast-grep AST pattern to match."),
    rewrite: stringArg("Replacement pattern; reuse $VAR captured in pattern."),
    lang: tool.schema.string().optional().describe("Language alias (ts, js, py, go, rs, ...) or canonical name."),
    paths: tool.schema.array(tool.schema.string()).optional().describe("Paths to search (default: session directory)."),
    globs: tool.schema.array(tool.schema.string()).optional().describe("Include/exclude globs (prefix '!' to exclude)."),
    apply: tool.schema.boolean().optional().describe("Mutate files in place. Default: dry-run preview."),
    force: tool.schema.boolean().optional().describe("Skip pattern-hint validation and call ast-grep anyway."),
  },
  execute: async (args, ctx) => {
    const langResult = resolveLang(args.lang)
    if ("error" in langResult) return langResult.error
    const lang = langResult.canonical

    const patternHints = validatePattern(args.pattern, lang)
    const rewriteHints = validatePattern(args.rewrite, lang)
    if ((patternHints.length > 0 || rewriteHints.length > 0) && !args.force) {
      const sections: string[] = ["input looks invalid for ast-grep:"]
      if (patternHints.length > 0) {
        sections.push("pattern issues:")
        for (const hint of patternHints) sections.push(`  - ${hint}`)
      }
      if (rewriteHints.length > 0) {
        sections.push("rewrite issues:")
        for (const hint of rewriteHints) sections.push(`  - ${hint}`)
      }
      sections.push("Pass force=true to call ast-grep anyway.")
      return sections.join("\n")
    }

    const got = await getBinaryOrError()
    if ("error" in got) return got.error

    const cwd = resolveRoot(ctx)
    const base = ["run", "-p", args.pattern, "-r", args.rewrite]
    if (lang) base.push("--lang", lang)
    for (const glob of args.globs ?? []) base.push("--globs", glob)
    const paths = buildPaths(args.paths)

    // Pass 1: dry-run via JSON to collect what would change.
    const pass1 = await runSgRun(got.binary, [...base, "--json=compact", ...paths], { cwd, signal: ctx.abort })
    if (!pass1.ok) return sgRunError(pass1)

    const parsed = parseCompactJsonWithStatus(pass1.stdout, pass1.truncated)
    if (parsed.matches.length === 0 && !parsed.truncated) return "(no matches; nothing to replace.)"
    const fileCount = matchFileCount(parsed.matches)
    if (!args.apply) {
      const shown = parsed.matches.slice(0, MAX_DISPLAY_MATCHES)
      const displayTruncation = parsed.matches.length > MAX_DISPLAY_MATCHES
      const truncatedHeader = parsed.truncated
        ? `[${
            parsed.truncatedReason === "max_output_bytes" ? "TRUNCATED output exceeded 1MB" : "TRUNCATED"
          }] Showing a partial preview of the would-be changes.\n\n`
        : ""
      const note = displayTruncation ? `\n(showing first ${MAX_DISPLAY_MATCHES} of ${parsed.totalMatches} matches)` : ""
      return `${truncatedHeader}DRY-RUN: would rewrite ${parsed.totalMatches} match(es) across ${fileCount} file(s):\n${formatMatches(shown, true)}${note}\n\nRe-run with apply=true to mutate files.`
    }

    // Pass 2: apply with --update-all (never combine with --json).
    const pass2 = await runSgRun(got.binary, [...base, "--update-all", ...paths], { cwd, signal: ctx.abort })
    if (!pass2.ok) return sgRunError(pass2)
    return `APPLIED: rewrote ${parsed.totalMatches} match(es) across ${fileCount} file(s).${
      parsed.truncated ? "\n\nNote: pass-1 output was truncated; this count may be lower than the true total. Re-run ast_grep_search after the apply to verify." : ""
    }`
  },
})

const ast_grep_scan = tool({
  description:
    "Run a YAML-rule-based ast-grep scan across files. Pass at most one of config (sgconfig.yml), rule (single rule file), or inline_rules (inline YAML). Captures stdout/stderr and preserves scan exit semantics.",
  args: {
    paths: tool.schema.array(tool.schema.string()).optional().describe("Paths to scan (default: none; sg scans per sgconfig)."),
    config: tool.schema.string().optional().describe("Path to sgconfig.yml (mutually exclusive with rule/inline_rules)."),
    rule: tool.schema.string().optional().describe("Single rule file (mutually exclusive with config/inline_rules)."),
    inline_rules: tool.schema.string().optional().describe("Inline YAML rule text (mutually exclusive with config/rule)."),
    report_style: tool.schema.enum(["rich", "medium", "short"]).optional().describe("Report style for findings."),
    apply: tool.schema.boolean().optional().describe("Apply fixes from rule `fix:` (-U). Default: report only."),
  },
  execute: async (args, ctx) => {
    const provided = [args.config, args.rule, args.inline_rules].filter((value) => value !== undefined && value !== "")
    if (provided.length > 1) {
      return "config, rule, and inline_rules are mutually exclusive. Pass at most one of them."
    }

    const got = await getBinaryOrError()
    if ("error" in got) return got.error

    const cwd = resolveRoot(ctx)
    const sgArgs = ["scan"]
    if (args.config) sgArgs.push("-c", args.config)
    if (args.rule) sgArgs.push("-r", args.rule)
    if (args.inline_rules) sgArgs.push("--inline-rules", args.inline_rules)
    if (args.report_style) sgArgs.push("--report-style", args.report_style)
    if (args.apply) sgArgs.push("-U")
    if (args.paths) sgArgs.push(...args.paths)

    // sg scan uses its own exit-code semantics — capture raw output, do not
    // treat exit 1 as "no matches" the way `sg run` does.
    const res = await runProcess(got.binary, sgArgs, { cwd, timeoutMs: SG_RUN_TIMEOUT_MS, signal: ctx.abort })
    if (res.timedOut) return `ast-grep scan timed out after ${Math.round(SG_RUN_TIMEOUT_MS / 1000)}s.`
    if (res.code === -1) return `ast-grep scan failed to run.${res.stderr.trim() ? `\n${res.stderr.trim()}` : ""}`

    const parts: string[] = []
    // Surface byte-cap truncation so the user knows scan output is partial.
    if (res.truncated) {
      parts.push("[TRUNCATED] Scan output exceeded 1MB limit — results may be incomplete.")
    }
    const stdout = res.stdout.trim()
    if (stdout) parts.push(stdout)
    if (res.stderr.trim()) parts.push(`stderr:\n${res.stderr.trim()}`)
    if (res.code !== 0) parts.push(`(exit code ${res.code})`)
    return parts.length > 0 ? parts.join("\n\n") : `(scan completed, exit code ${res.code})`
  },
})

const ast_grep_validate = tool({
  description: "Offline ast-grep pattern hint check (no binary call, no filesystem access). Reports likely regex misuse and language-specific mistakes.",
  args: {
    pattern: stringArg("ast-grep AST pattern to validate."),
    lang: tool.schema.string().optional().describe("Language for language-specific hints (ts, js, py, go, rs, ...)."),
  },
  execute: async (args) => {
    const langResult = resolveLang(args.lang)
    if ("error" in langResult) return langResult.error
    const lang = langResult.canonical
    const hints = validatePattern(args.pattern, lang)
    if (hints.length === 0) return "pattern looks plausible for ast-grep."
    return hints.map((hint) => `hint: ${hint}`).join("\n")
  },
})

export const tools = {
  ast_grep_search,
  ast_grep_replace,
  ast_grep_scan,
  ast_grep_validate,
}

// ---------------------------------------------------------------------------
// 10. Plugin export
// ---------------------------------------------------------------------------

const astGrepPlugin: Plugin = async () => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.created") return
      scheduleBackgroundProvision()
    },
    tool: tools,
  }
}

export default astGrepPlugin
