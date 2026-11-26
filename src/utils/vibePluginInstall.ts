/**
 * Installs a generated Vibe plugin into the Vibe plugins root.
 *
 * Vibe discovers plugins under `<VIBE_HOME>/plugins/` (`~/.vibe/plugins/` by
 * default), so a bridge only becomes visible to sessions once it is copied
 * there. This module mirrors the generated plugin directory into the plugins
 * root: unchanged files are left untouched, stale entries from earlier
 * generations are pruned, and nothing passes through a symlink.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { validateVibePluginName, VIBE_AGENT_PROFILE_MARKER } from "./vibeBridge.js"
import { BROWSER_TOKEN, detectBrowserExecutable, expandBrowserToken } from "./browserDetect.js"

export interface VibePluginInstallResult {
  /** Absolute path of the installed plugin directory. */
  path: string
  /** True when at least one file was written or pruned; false when already up to date. */
  changed: boolean
  /** Non-fatal notes about pruned stale entries. */
  warnings: string[]
}

/** Resolve the plugins root: `$VIBE_HOME/plugins`, falling back to `~/.vibe/plugins`. */
export function vibePluginsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.VIBE_HOME?.trim()
  return path.join(configured ? path.resolve(configured) : path.join(os.homedir(), ".vibe"), "plugins")
}

/**
 * Make `target` identical to `source`, mirroring content only: non-directory
 * entries are always copied as regular files. `overrides` rewrites (or, with
 * `null`, drops) individual files: the platform-gated mcp.json of this machine.
 * Returns true when anything was written or pruned.
 */
function mirrorPluginTree(source: string, target: string, warnings: string[], relative: string, overrides?: Map<string, Buffer | null>): boolean {
  let changed = false
  // A target that is itself a link or a plain file is never written through:
  // the real directory replaces it, so the install can never escape itself.
  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false })
  if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isDirectory())) {
    fs.rmSync(target, { recursive: true, force: true })
    changed = true
    warnings.push(`replaced the linked or non-directory '${relative || path.basename(target)}'`)
  }
  fs.mkdirSync(target, { recursive: true })
  const sourceEntries = new Map(fs.readdirSync(source, { withFileTypes: true }).map(entry => [entry.name, entry]))
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const wanted = sourceEntries.get(entry.name)
    const sameKind = wanted && !entry.isSymbolicLink() && wanted.isDirectory() === entry.isDirectory()
    if (sameKind) continue
    fs.rmSync(path.join(target, entry.name), { recursive: true, force: true })
    changed = true
    warnings.push(`pruned stale '${relative ? `${relative}/` : ""}${entry.name}'`)
  }
  for (const entry of sourceEntries.values()) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    const label = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) {
      throw new Error(`Vibe plugin source must not contain a symlink: ${from}`)
    }
    if (entry.isDirectory()) {
      if (mirrorPluginTree(from, to, warnings, label, overrides)) changed = true
      continue
    }
    const override = overrides?.get(label)
    if (override === null) {
      // The file is not for this machine: keep it out of the installed copy.
      if (fs.lstatSync(to, { throwIfNoEntry: false })) {
        fs.rmSync(to, { force: true })
        changed = true
        warnings.push(`pruned '${label}' (not applicable on this platform)`)
      }
      continue
    }
    if (override !== undefined) {
      let stat = fs.lstatSync(to, { throwIfNoEntry: false })
      if (stat?.isSymbolicLink()) {
        fs.rmSync(to, { force: true })
        changed = true
        warnings.push(`replaced the linked '${label}'`)
        stat = undefined
      }
      if (!stat || !fs.readFileSync(to).equals(override)) {
        fs.writeFileSync(to, override)
        changed = true
      }
      continue
    }
    if (!fs.existsSync(to) || (fs.statSync(to).mode & 0o111) !== (fs.statSync(from).mode & 0o111) ||
        !fs.readFileSync(to).equals(fs.readFileSync(from))) {
      fs.copyFileSync(from, to)
      changed = true
    }
  }
  return changed
}

/**
 * Per-file mirror overrides for machine-local MCP adaptation: the generated
 * mcp.json stays complete and machine-independent, `mcp-platforms.json` records
 * each server's platform gate, and the installed copy keeps only the servers
 * built for this machine (a plugin's mcp.json cannot express conditions).
 * `{browser}` placeholders in commands are resolved to this machine's browser
 * on the same pass; without one, the placeholder argument is dropped so the
 * server falls back to its own detection.
 */
function vibeMcpMachineOverrides(source: string, platform: string, warnings: string[], browserExecutable?: string | null): Map<string, Buffer | null> | null {
  const mcpPath = path.join(source, "mcp.json")
  const sidecarPath = path.join(source, "mcp-platforms.json")
  if (!fs.existsSync(mcpPath)) return null
  let document: any
  let sidecar: any = {}
  try {
    document = JSON.parse(fs.readFileSync(mcpPath, "utf8"))
    if (fs.existsSync(sidecarPath)) sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"))
  } catch {
    return null
  }
  if (!document || typeof document !== "object" || !document.mcpServers || typeof document.mcpServers !== "object" ||
      !sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) return null
  const gates = new Map<string, string[]>()
  for (const [name, value] of Object.entries(sidecar as Record<string, unknown>)) {
    if (typeof value !== "string") continue
    const platforms = value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean)
    if (platforms.length > 0) gates.set(name, platforms)
  }
  const hasToken = Object.values(document.mcpServers as Record<string, unknown>).some(server => {
    if (!server || typeof server !== "object") return false
    const entry = server as Record<string, unknown>
    if (typeof entry.command === "string" && entry.command.includes(BROWSER_TOKEN)) return true
    return Array.isArray(entry.args) && entry.args.some(arg => typeof arg === "string" && arg.includes(BROWSER_TOKEN))
  })
  if (gates.size === 0 && !hasToken) return null
  const kept: Record<string, unknown> = {}
  let changed = false
  for (const [name, server] of Object.entries(document.mcpServers as Record<string, unknown>)) {
    const gate = gates.get(name)
    if (gate && !gate.includes(platform.toLowerCase())) {
      warnings.push(`skipped MCP server '${name}' (${gate.join(", ")} only) on this machine`)
      changed = true
      continue
    }
    if (hasToken && server && typeof server === "object") {
      const entry = { ...(server as Record<string, unknown>) }
      const commandHasToken = typeof entry.command === "string" && entry.command.includes(BROWSER_TOKEN)
      const argsHaveToken = Array.isArray(entry.args) && entry.args.some(arg => typeof arg === "string" && arg.includes(BROWSER_TOKEN))
      if (commandHasToken || argsHaveToken) {
        const executable = browserExecutable !== undefined ? browserExecutable : detectBrowserExecutable({ platform })
        if (commandHasToken) {
          const expanded = expandBrowserToken([entry.command as string], executable)
          entry.command = expanded.elements[0] ?? ""
          if (expanded.unresolved) {
            warnings.push(`MCP server '${name}' uses the {browser} placeholder but no browser was detected on this machine; the command was dropped`)
          }
        }
        if (argsHaveToken) {
          const expanded = expandBrowserToken((entry.args as unknown[]).map(String), executable)
          entry.args = expanded.elements
          if (expanded.unresolved) {
            warnings.push(`MCP server '${name}' uses the {browser} placeholder but no browser was detected on this machine; the argument was dropped`)
          }
        }
        changed = true
      }
      kept[name] = entry
      continue
    }
    kept[name] = server
  }
  if (!changed) return null
  const overrides = new Map<string, Buffer | null>()
  if (Object.keys(kept).length > 0) {
    overrides.set("mcp.json", Buffer.from(`${JSON.stringify({ ...document, mcpServers: kept }, null, 2)}\n`, "utf8"))
  } else {
    overrides.set("mcp.json", null)
  }
  return overrides
}

/**
 * Mirror the generated plugin from `sourceDir` into the Vibe plugins root.
 *
 * The source must be a real directory with a `plugin.json` manifest whose
 * `name` matches `pluginName`; the install then always ends up as
 * `<pluginsRoot>/<pluginName>/`. Platform-gated MCP servers are kept only
 * when they match `platform` (this machine by default).
 */
export function installVibePlugin(
  sourceDir: string,
  pluginName: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  browserExecutable?: string | null
): VibePluginInstallResult {
  const resolvedSource = path.resolve(sourceDir)
  const stat = fs.lstatSync(resolvedSource, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Vibe plugin source must be a real directory: ${sourceDir}`)
  }
  validateVibePluginName(pluginName)
  const manifestPath = path.join(resolvedSource, "plugin.json")
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false })
  if (!manifestStat || manifestStat.isSymbolicLink() || manifestStat.isDirectory()) {
    throw new Error(`Vibe plugin source must contain a plugin.json manifest: ${resolvedSource}`)
  }
  let manifestName: unknown
  try {
    manifestName = (JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>).name
  } catch (error) {
    throw new Error(`Unable to read the plugin.json manifest of ${resolvedSource}: ${(error as Error).message}`)
  }
  if (manifestName !== pluginName) {
    throw new Error(`plugin.json declares name "${String(manifestName)}" but the install name is "${pluginName}"; regenerate the bridge so they match`)
  }
  const warnings: string[] = []
  const overrides = vibeMcpMachineOverrides(resolvedSource, platform, warnings, browserExecutable)
  const target = path.join(vibePluginsRoot(env), pluginName)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const changed = mirrorPluginTree(resolvedSource, target, warnings, "", overrides)
  return { path: target, changed, warnings }
}

export interface VibeAgentProfileInstallResult {
  /** Absolute path of the Vibe agents root. */
  path: string
  /** True when at least one profile was written or pruned; false when already up to date. */
  changed: boolean
  /** Installed profile file names. */
  installed: string[]
  /** Non-fatal notes about pruned or replaced profiles. */
  warnings: string[]
}

/** Resolve the agents root: `$VIBE_HOME/agents`, falling back to `~/.vibe/agents`. */
export function vibeAgentsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.VIBE_HOME?.trim()
  return path.join(configured ? path.resolve(configured) : path.join(os.homedir(), ".vibe"), "agents")
}

/** True when the file is one of this generator's main agent profiles for the plugin. */
function isGeneratedProfile(filePath: string): boolean {
  try {
    const firstLine = fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0] ?? ""
    return firstLine.includes(VIBE_AGENT_PROFILE_MARKER)
  } catch {
    return false
  }
}

/**
 * Mirror the generated main agent profiles (`<pluginDir>/agent-profiles/*.toml`)
 * into the Vibe agents root, where Vibe offers them to `--agent` and `/agent`.
 * Profiles from earlier generations of the same plugin are pruned; files the
 * generator never wrote are left untouched, and nothing passes through a symlink.
 */
export function installVibeAgentProfiles(
  pluginDir: string,
  pluginName: string,
  env: NodeJS.ProcessEnv = process.env
): VibeAgentProfileInstallResult {
  validateVibePluginName(pluginName)
  const sourceDir = path.join(path.resolve(pluginDir), "agent-profiles")
  const dirStat = fs.lstatSync(sourceDir, { throwIfNoEntry: false })
  if (!dirStat) return { path: vibeAgentsRoot(env), changed: false, installed: [], warnings: [] }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`Vibe agent profiles source must be a real directory: ${sourceDir}`)
  }
  const incoming = new Set<string>()
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Vibe agent profile source must not be a symlink: ${from}`)
    if (!entry.isFile() || !entry.name.endsWith(".toml")) continue
    incoming.add(entry.name)
  }
  const agentsRoot = vibeAgentsRoot(env)
  fs.mkdirSync(agentsRoot, { recursive: true })
  const warnings: string[] = []
  let changed = false
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    const target = path.join(agentsRoot, entry.name)
    if (!entry.name.startsWith(`${pluginName}-`) || !entry.name.endsWith(".toml")) continue
    if (entry.isSymbolicLink()) {
      fs.rmSync(target, { force: true })
      changed = true
      warnings.push(`replaced the linked agent profile '${entry.name}'`)
      continue
    }
    if (!entry.isFile()) continue
    if (incoming.has(entry.name) || !isGeneratedProfile(target)) continue
    fs.rmSync(target, { force: true })
    changed = true
    warnings.push(`pruned stale agent profile '${entry.name}'`)
  }
  const installed: string[] = []
  for (const name of [...incoming].sort()) {
    const from = path.join(sourceDir, name)
    const to = path.join(agentsRoot, name)
    const targetStat = fs.lstatSync(to, { throwIfNoEntry: false })
    if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile())) {
      fs.rmSync(to, { recursive: true, force: true })
      changed = true
      warnings.push(`replaced the linked or non-file '${name}'`)
    }
    if (!fs.existsSync(to) || !fs.readFileSync(to).equals(fs.readFileSync(from))) {
      fs.copyFileSync(from, to)
      changed = true
    }
    installed.push(name)
  }
  return { path: agentsRoot, changed, installed, warnings }
}
