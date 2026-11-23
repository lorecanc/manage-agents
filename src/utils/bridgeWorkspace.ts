import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseAgentFile, type AgentInfo } from "./agents.js"
import { bridgeToClaudeCode, scanOpenCodeCompanions, type BridgeResult } from "./bridge.js"
import { packDir, packsDir, resolvePackClosure } from "./catalog.js"
import { bridgeToCodex, type CodexBridgeResult } from "./codexBridge.js"
import { discoverPackDirs, hasErrors, installableFiles, MANIFEST_FILE, MAX_SCANNED_BYTES, SCRIPT_RE, parseJsonc, validatePack } from "./packs.js"
import { validateVirtualPack } from "./virtualPacks.js"
import { defaultTarget } from "./lock.js"
import { isPathInsideWorkspace, realpathThroughExistingAncestor } from "./pathValidation.js"
import { describeExecutable, type ResolvedPack } from "./resolver.js"
import { loadSources, sourceRoot } from "./sources.js"
import { effectiveOverrides, loadOverrideSettings, patchedConfigSections } from "./userSettings.js"
import type { TranslationConfig } from "./translationConfig.js"

export type BridgeTarget = "claude" | "codex"

export interface BridgeWorkspace {
  /** Temp directory holding the merged layout of the pack and its requirements. */
  root: string
  /** Agents of the requested pack only, parsed from `root`. */
  agents: AgentInfo[]
  /** Executable content contributed by each pack in the resolved closure. */
  executable: Array<{ pack: string; items: string[] }>
  cleanup(): void
}

export interface BridgePackOptions {
  /** Catalog root containing `packs/<name>/`, or a single pack directory. */
  workspaceRoot: string
  pack: string
  target: BridgeTarget
  /** Absolute directory the generated plugin is mirrored into; may live outside the catalog. */
  outputDir: string
  config: TranslationConfig
  pluginName: string
  prefix: string
  trusted?: boolean
  allowUntrustedExecutable?: boolean
  /** Environment overrides.json is read from (config overrides apply to the merged workspace). */
  env?: NodeJS.ProcessEnv
}

const SKIPPED_SEGMENTS = new Set(["node_modules", "__pycache__"])
const CONFIG_FILES = ["opencode.json", "opencode.jsonc"]

const isPlainObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function requirePackDir(workspaceRoot: string, pack: string): string {
  const dir = packDir(workspaceRoot, pack)
  if (!dir) throw new Error(`no pack ${pack} in the catalog`)
  return dir
}

function readPackConfig(root: string): Record<string, any> {
  const file = CONFIG_FILES.map(name => path.join(root, name)).find(candidate => fs.existsSync(candidate))
  if (!file) return {}
  const contents = fs.readFileSync(file)
  if (contents.byteLength > MAX_SCANNED_BYTES) throw new Error(`${file}: larger than ${MAX_SCANNED_BYTES} bytes`)
  const parsed = parseJsonc(contents.toString("utf-8"))
  return isPlainObject(parsed) ? parsed : {}
}

/** The OpenCode target scope whose settings the CLI and TUI edit by default (`override config-set`, the TUI toggles). */
const bridgeSettingsTarget = (env: NodeJS.ProcessEnv) => realpathThroughExistingAncestor(path.resolve(defaultTarget(env)))

/** Copy the closure of `pack` into one temp tree, as the installer lays it out, with a merged `opencode.json`.
 *
 * Config overrides (overrides.json) apply too, so a pack bridged to Claude Code or Codex sees the same patched MCP/LSP
 * entries it contributes after a reconcile: the layers are the "default" scope plus the default OpenCode target's scope,
 * which is where `override config-set` and the TUI write by default.
 */
export function prepareBridgeWorkspace(workspaceRoot: string, pack: string, env: NodeJS.ProcessEnv = process.env, targetFormat?: BridgeTarget,
  resolved?: readonly ResolvedPack[]): BridgeWorkspace {
  const closure = resolved?.map(item => ({ name: item.name, source: item.dir, validation: item.validation })) ??
    resolvePackClosure(workspaceRoot, pack).map(name => ({ name, source: requirePackDir(workspaceRoot, name), validation: undefined }))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manage-agents-bridge-"))
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true })
  try {
    const overrideSettings = loadOverrideSettings(env)
    const settingsTarget = bridgeSettingsTarget(env)
    const servers: Record<string, unknown> = {}
    const lsp: Record<string, unknown> = {}
    const owners = new Map<string, string>()
    const executable: Array<{ pack: string; items: string[] }> = []
    let agentFiles: string[] = []
    for (const { name, source, validation: selected } of closure) {
      const validation = selected ?? (fs.existsSync(path.join(source, MANIFEST_FILE)) ? validatePack(source) : validateVirtualPack(source, { name }))
      if (hasErrors(validation)) {
        const errors = validation.issues.filter(issue => issue.level === "error")
        throw new Error(`Pack '${name}' is invalid: ${errors.map(issue => `${issue.path ? `${issue.path}: ` : ""}${issue.message}`).join("; ")}`)
      }
      const executableItems = describeExecutable(validation)
      const files = installableFiles(validation)
        .filter(file => file.includes("/") && !file.split("/").some(segment => SKIPPED_SEGMENTS.has(segment)))
      for (const file of files) {
        const owner = owners.get(file)
        if (owner) throw new Error(`Packs '${owner}' and '${name}' both provide '${file}'`)
        owners.set(file, name)
        const target = path.join(root, file)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const virtual = validation.virtualFiles?.[file]
        if (virtual?.content) fs.writeFileSync(target, virtual.content)
        else fs.copyFileSync(path.join(source, virtual?.sourceRel ?? file), target)
        if (targetFormat === "codex" && file.startsWith("resources/") && (SCRIPT_RE.test(file) || (fs.statSync(target).mode & 0o111) !== 0)) {
          executableItems.push(`resource script ${file}`)
        }
      }
      if (executableItems.length > 0) executable.push({ pack: name, items: executableItems })
      const config = validation.virtualFiles ? {} : readPackConfig(source)
      const sections = patchedConfigSections(config, effectiveOverrides(overrideSettings, settingsTarget, name).config, name)
      const patchedServers = sections["mcp.servers"] ?? {}
      Object.assign(servers, patchedServers)
      Object.assign(lsp, sections.lsp ?? {})
      if (name === pack) agentFiles = files.filter(file => file.startsWith("agents/") && file.endsWith(".md"))
    }
    fs.writeFileSync(path.join(root, "opencode.json"), `${JSON.stringify({ mcp: { servers }, lsp }, null, 2)}\n`, "utf-8")
    const agents = agentFiles
      .map(file => {
        const agent = parseAgentFile(path.join(root, file), root)
        if (agent) {
          agent.filename = file.slice("agents/".length)
          agent.id = agent.filename.slice(0, -3)
          agent.category = pack
        }
        return agent
      })
      .filter((agent): agent is AgentInfo => agent !== null)
    return { root, agents, executable, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

export function inspectBridgeExecutableSurface(workspaceRoot: string, pack: string, env: NodeJS.ProcessEnv = process.env, target?: BridgeTarget): Array<{ pack: string; items: string[] }> {
  const workspace = prepareBridgeWorkspace(workspaceRoot, pack, env, target)
  try {
    return workspace.executable
  } finally {
    workspace.cleanup()
  }
}

export function bridgeConfirmationsNeeded(workspaceRoot: string, pack: string, trusted: boolean, sourceLabel?: string, env: NodeJS.ProcessEnv = process.env, target?: BridgeTarget): string[] {
  if (trusted) return []
  return inspectBridgeExecutableSurface(workspaceRoot, pack, env, target).map(entry =>
    `untrusted${sourceLabel ? ` source '${sourceLabel}'` : ""} pack '${entry.pack}' contains executable content (${entry.items.join(", ")})`
  )
}

function realPathOrResolved(dir: string): string {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function resolveBridgeWorkspaceTrust(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): { trusted: boolean; sourceName?: string } {
  const realWorkspace = realPathOrResolved(workspaceRoot)
  const sources = loadSources(env).sources
  const matches = sources
    .map(source => ({ source, root: realPathOrResolved(sourceRoot(source, env)) }))
    .filter(({ root }) => isSameOrInside(root, realWorkspace))
    .sort((a, b) => b.root.length - a.root.length)
  const matched = matches[0]?.source
  return matched ? { trusted: matched.trusted, sourceName: matched.name } : { trusted: false }
}

/**
 * Generate the bridge of `pack` in a temp workspace and hand the generated directory to `use`.
 * The plugin is generated where `outputDir` sits relative to the catalog (its basename when outside),
 * so the paths written into the README match the final location.
 */
export function withGeneratedPackBridge<T>(
  options: BridgePackOptions,
  use: (generatedDir: string, result: BridgeResult | CodexBridgeResult) => T
): T {
  const { pack, target, outputDir, config, pluginName, prefix, env } = options
  const workspaceRoot = path.resolve(options.workspaceRoot)
  const workspace = prepareBridgeWorkspace(workspaceRoot, pack, env, target)
  try {
    if (options.trusted === false && !options.allowUntrustedExecutable && workspace.executable.length > 0) {
      throw new Error(`Refusing to bridge untrusted pack '${pack}' with executable content without confirmation (--yes): ${workspace.executable.map(entry => `${entry.pack} (${entry.items.join(", ")})`).join("; ")}`)
    }
    if (target === "claude" && workspace.agents.length === 0) {
      // Skills-only packs still bridge to Claude Code when companion skills or commands exist.
      const companions = scanOpenCodeCompanions(workspace.root)
      const emitsSkills = config.claude.emitSkills !== false && companions.skills.length > 0
      const emitsCommands = config.claude.emitCommands !== false && companions.commands.length > 0
      if (!emitsSkills && !emitsCommands) throw new Error(`Pack '${pack}' has no agents to bridge`)
    }
    const resolvedOutput = path.resolve(outputDir)
    const relative = isPathInsideWorkspace(workspaceRoot, resolvedOutput) ? path.relative(workspaceRoot, resolvedOutput) : path.basename(resolvedOutput)
    const generatedDir = path.join(workspace.root, relative)
    if (!relative || fs.existsSync(generatedDir)) throw new Error(`Bridge output '${outputDir}' overlaps the content of the bridged packs`)
    const result = target === "codex"
      ? bridgeToCodex(workspace.agents, pluginName, prefix, generatedDir, workspace.root, config)
      : bridgeToClaudeCode(workspace.agents, pluginName, prefix, generatedDir, workspace.root, config)
    return use(result.pluginDir, result)
  } finally {
    workspace.cleanup()
  }
}

function assertSafeOutputDir(workspaceRoot: string, pack: string, outputDir: string): void {
  if (isPathInsideWorkspace(outputDir, workspaceRoot)) throw new Error(`Bridge output '${outputDir}' must not contain the catalog`)
  if (isPathInsideWorkspace(packsDir(workspaceRoot), outputDir) ||
      isPathInsideWorkspace(requirePackDir(workspaceRoot, pack), outputDir) ||
      [...discoverPackDirs(workspaceRoot)].some(dir => isPathInsideWorkspace(dir, outputDir) || isPathInsideWorkspace(outputDir, dir))) {
    throw new Error(`Bridge output '${outputDir}' must not live inside a pack`)
  }
  // Inside the catalog, no component below the catalog root may be a link: mirroring writes and prunes through it.
  if (isPathInsideWorkspace(workspaceRoot, outputDir)) {
    let current = workspaceRoot
    for (const part of path.relative(workspaceRoot, outputDir).split(path.sep)) {
      current = path.join(current, part)
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Bridge output '${outputDir}' goes through the symlink '${current}'`)
    }
  }
  if (!fs.existsSync(outputDir)) return
  const stat = fs.lstatSync(outputDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Bridge output '${outputDir}' must be a directory, not a file or symlink`)
}

/** Make `target` identical to `source`: changed files are rewritten, stale entries removed, unchanged files untouched. */
function mirrorTree(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true })
  const sourceEntries = new Map(fs.readdirSync(source, { withFileTypes: true }).map(entry => [entry.name, entry]))
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const wanted = sourceEntries.get(entry.name)
    const sameKind = wanted && !entry.isSymbolicLink() && wanted.isDirectory() === entry.isDirectory()
    if (!sameKind) fs.rmSync(path.join(target, entry.name), { recursive: true, force: true })
  }
  for (const entry of sourceEntries.values()) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) mirrorTree(from, to)
    else if (!fs.existsSync(to) || (fs.statSync(to).mode & 0o111) !== (fs.statSync(from).mode & 0o111) ||
             !fs.readFileSync(to).equals(fs.readFileSync(from))) fs.copyFileSync(from, to)
  }
}

/** Bridge `pack` (with its required packs) to Claude Code or Codex and mirror the plugin into `outputDir`. */
export function bridgePack(options: BridgePackOptions & { target: "claude" }): BridgeResult
export function bridgePack(options: BridgePackOptions & { target: "codex" }): CodexBridgeResult
export function bridgePack(options: BridgePackOptions): BridgeResult | CodexBridgeResult
export function bridgePack(options: BridgePackOptions): BridgeResult | CodexBridgeResult {
  const workspaceRoot = path.resolve(options.workspaceRoot)
  const outputDir = path.resolve(options.outputDir)
  assertSafeOutputDir(workspaceRoot, options.pack, outputDir)
  return withGeneratedPackBridge({ ...options, workspaceRoot, outputDir }, (generatedDir, result) => {
    mirrorTree(generatedDir, outputDir)
    if ("plugin" in result) {
      return { ...result, pluginDir: outputDir, files: result.files.map(file => path.join(outputDir, path.relative(generatedDir, file))) }
    }
    return { ...result, pluginDir: outputDir }
  })
}
