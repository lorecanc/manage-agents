/**
 * Mistral Vibe bridge.
 *
 * Translates the OpenCode pack canon (agents, commands, skills, MCP servers)
 * into a native **Vibe plugin package** (Agent Plugins 1.0 plus the
 * `ai.mistral.vibe` extension), ready to be dropped into a plugins directory:
 *
 *   <output>/plugin.json                        manifest (Agent Plugins 1.0 + ai.mistral.vibe extension)
 *   <output>/skills/<name>/SKILL.md             pack skills + translated commands (user-invocable)
 *   <output>/ai.mistral.vibe/agents/<name>.toml translated subagents (agent_type = "subagent")
 *   <output>/agent-profiles/<plugin>-<name>.toml main agent profiles for primary agents (install into ~/.vibe/agents/)
 *   <output>/ai.mistral.vibe/hooks.toml         agents_spawn guard (only with vibe.emitHooks)
 *   <output>/mcp.json                           MCP servers translated from opencode.json
 *   <output>/README.md                          generated inventory and setup guide
 *
 * The output directory is the plugin root: copying it to `~/.vibe/plugins/`
 * makes the pack available in every session, while `.vibe/plugins/` scopes it
 * to one project. Agent names are namespaced as `<plugin>:<agent>` and skills
 * as `<plugin>:<skill>`, so packs never collide with each other or with the
 * user's own agents. OpenCode plugins and custom tool modules have no Vibe
 * equivalent (Vibe loads skills, agents, hooks and MCP servers only): they
 * are reported as untranspiled and documented in the README.
 */

import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { extractFrontmatter, normalizeAgentBody, type AgentInfo } from "./agents.js"
import { buildInferenceIndex, DEFAULT_TRANSLATION_CONFIG, resolveModelTarget, authorName, unusedModelMapKeys } from "./translationConfig.js"
import type { TranslationConfig } from "./translationConfig.js"
import { scanOpenCodeCompanions, type OpenCodeCompanions } from "./bridge.js"
import { assertInsideRealWorkspace, realpathThroughExistingAncestor } from "./pathValidation.js"
import { isKnownPermissionKey, translatePermissionsV2ToV1 } from "./v2Compat.js"
import { isServerDisabled, readMcpServers, serverPlatform } from "./opencodeMcp.js"
import { parseJsonc, toolModuleName } from "./packs.js"
import { adaptToolReferences, collectBashAllowlist, isOpenCodeCustomToolKey, legacyAgentAlias, renderBashAllowlistSection, type BashAllowlist } from "./bridgeToolReferences.js"

type ResolvedModelTarget = ReturnType<typeof resolveModelTarget>
type ResolvedTargets = Map<string, ResolvedModelTarget>

/** OpenCode permission keys with no Vibe tool equivalent; dropped. */
const DROPPED_PERMISSION_KEYS = [
  "external_directory", "doom_loop", "artifact", "file-diff", "mcp-resource",
  "webfetch", "todowrite", "skill", "question", "lsp",
  "opencode_session_rename", "opencode_session_move", "opencode_read_mcp_resource", "opencode_list_mcp_resources",
  "opencode_worktree_create", "opencode_worktree_list", "opencode_worktree_remove"
]

/** Vibe builtin tools an OpenCode permission group narrows. */
const VIBE_TOOL_GROUPS: Array<{ tool: string; keys: string[] }> = [
  { tool: "bash", keys: ["bash", "shell"] },
  { tool: "write_file", keys: ["edit", "write"] },
  { tool: "edit", keys: ["apply_patch", "patch", "multiedit"] },
  { tool: "read_file", keys: ["read"] }
]

/** Vibe refuses a plugin agent whose instructions exceed this length. */
const VIBE_AGENT_FILE_LIMIT = 64 * 1024
/** Vibe refuses a plugin agent description outside 1..300 characters. */
const VIBE_AGENT_DESCRIPTION_LIMIT = 300

/** A key containing an underscore that is not a built-in tool permission names an MCP server. */
function isMcpPermissionKey(key: string, customTools: ReadonlySet<string>): boolean {
  return key.includes("_") && !isKnownPermissionKey(key) && !isOpenCodeCustomToolKey(key, customTools)
}

function agentPermissions(agent: AgentInfo): Record<string, any> {
  return agent.frontmatter.permissions
    ? translatePermissionsV2ToV1(agent.frontmatter.permissions)
    : agent.frontmatter.permission && typeof agent.frontmatter.permission === "object" && !Array.isArray(agent.frontmatter.permission)
      ? agent.frontmatter.permission
      : {}
}

function valueAllows(value: unknown): boolean {
  if (value === true || value === "allow" || value === "ask") return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).some(entry => entry === true || entry === "allow" || entry === "ask")
}

/** MCP servers an agent's permissions explicitly allow. */
function permissionMcpServers(agent: AgentInfo, customTools: ReadonlySet<string>): string[] {
  const servers = new Set<string>()
  for (const [key, value] of Object.entries(agentPermissions(agent))) {
    if (!isMcpPermissionKey(key, customTools) || !valueAllows(value)) continue
    servers.add(key.replace(/_.*$/, ""))
  }
  return [...servers]
}

function isGlobalPermissionDeny(perms: Record<string, any>): boolean {
  return Object.hasOwn(perms, "*") && (perms["*"] === "deny" || perms["*"] === false)
}

export interface VibeAgent {
  name: string
  filename: string
  description: string
  displayName: string
  /** OpenCode mode of the source agent; every plugin agent is a spawnable subagent. */
  mode: "primary" | "subagent"
  /** `safe` when the agent cannot write or execute, `neutral` otherwise. */
  safety: "safe" | "neutral"
  /** Resolved model alias; null means `inherit` (omitted -> session model). */
  model: string | null
  instructions: string
  /** Vibe tools the agent must not use (`permission = "never"`), from OpenCode denies. */
  deniedTools: string[]
  /** Vibe tools the agent may only use after asking (`permission = "ask"`). */
  askTools: string[]
  allowedSubagents: string[]
}

/**
 * A selectable main agent profile generated for an OpenCode primary agent.
 * Vibe plugins ship spawnable subagents only, so primary agents additionally
 * become user agent files installed into `~/.vibe/agents/`.
 */
export interface VibeAgentProfile {
  /** Profile file name inside agent-profiles/, e.g. `pipeline-orchestrator.toml`. */
  fileName: string
  agent: VibeAgent
}

export interface VibePlugin {
  pluginName: string
  agents: VibeAgent[]
  /** Names exported under skills/ (commands translated plus pack skills). */
  skills: string[]
  orchestratorName: string | null
  /** Main agent profiles generated for the pack's primary agents. */
  profiles: VibeAgentProfile[]
}

export interface VibeBridgeResult {
  pluginDir: string
  files: string[]
  warnings: string[]
  plugin: VibePlugin
  preview: Array<{ agent: string; role: string; tier: string; model: string; source: "override" | "model-map" | "role" | "inferred" | "default"; inferredFrom?: string }>
}

const markdownCode = (value: string) => {
  const normalized = value.replace(/\r\n?|\n/g, " ")
  const runs = [...normalized.matchAll(/`+/g)].map(match => match[0].length)
  const fence = "`".repeat(Math.max(1, ...(runs.length ? runs : [0]).map(length => length + 1)))
  return `${fence}${normalized}${fence}`
}

export function normalizeVibeAgentName(filename: string, prefix = ""): string {
  const stem = filename.replace(/\.md$/i, "")
  const stripped = prefix && stem.startsWith(prefix) ? stem.slice(prefix.length) : stem
  const normalized = stripped
    .replace(/[_\s.]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
  return normalized || "agent"
}

/** Agent Plugins 1.0 name rule: lowercase letters, digits, dots and hyphens; no `--` or `..`. */
const VIBE_PLUGIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

export function vibePluginNameValue(value: string): string {
  const normalized = normalizeVibeAgentName(value).slice(0, 64).replace(/-+$/g, "")
  return normalized || "translated-agents"
}

export function validateVibePluginName(name: string): void {
  // The packaged regex alone still admits '--' and '..' runs: rule them out.
  if (!VIBE_PLUGIN_NAME_PATTERN.test(name) || name.includes("--") || name.includes("..")) {
    throw new Error(`Invalid Vibe plugin name "${name}". Use lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit, without '--' or '..' runs.`)
  }
}

function displayNameOf(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/** Humanized fallback when the source agent has no description (Vibe requires one). */
function vibeDescription(agent: AgentInfo, name: string): string {
  const description = String(agent.description || "").trim()
  return description || `Translated agent ${name}`
}

/**
 * Fit a description into the Vibe plugin agent profile (max 300 characters),
 * cutting at a word boundary. Returns the fitted text plus the applied limit.
 */
function fitVibeDescription(description: string, limit: number): string {
  if (description.length <= limit) return description
  const cut = description.slice(0, limit).replace(/\s+\S*$/, "")
  return cut || description.slice(0, limit)
}

export function resolveVibeModel(agent: AgentInfo, agents: AgentInfo[] = [agent], config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG): { model: string | null } {
  const target = resolveModelTarget(agent, buildInferenceIndex(agents, config), config, "vibe")
  return { model: target.model.model === "inherit" ? null : target.model.model }
}

function resolveTargets(agents: AgentInfo[], config: TranslationConfig): ResolvedTargets {
  const inferenceIndex = buildInferenceIndex(agents, config)
  return new Map(agents.map(agent => [agent.filename, resolveModelTarget(agent, inferenceIndex, config, "vibe")]))
}

/**
 * Determine the Vibe per-tool narrowing from OpenCode permissions. A rule is
 * emitted only when the source denies (or only prompts for) the whole group,
 * so the translation never grants more than OpenCode did.
 */
function resolveToolNarrowing(agent: AgentInfo): { denied: string[]; ask: string[]; warnings: string[] } {
  const perms = agentPermissions(agent)
  if (Object.keys(perms).length === 0) return { denied: [], ask: [], warnings: [] }
  const catchAllDeny = isGlobalPermissionDeny(perms)
  const denied: string[] = []
  const ask: string[] = []
  const warnings: string[] = []
  for (const group of VIBE_TOOL_GROUPS) {
    let present = false
    let allows = false
    let denies = false
    let asks = false
    for (const key of group.keys) {
      if (!Object.hasOwn(perms, key)) continue
      present = true
      if (valueAllows(perms[key])) allows = true
      if (perms[key] === false || perms[key] === "deny") denies = true
      if (perms[key] === "ask") asks = true
    }
    if (allows) continue
    if (present && denies && !asks) denied.push(group.tool)
    else if (catchAllDeny) denied.push(group.tool)
    else if (present && asks) ask.push(group.tool)
  }
  for (const [key, value] of Object.entries(perms)) {
    if (key === "*") continue
    if (DROPPED_PERMISSION_KEYS.includes(key) && valueAllows(value)) {
      warnings.push(`permission '${key}' has no per-agent Vibe equivalent; dropped`)
    }
  }
  return { denied, ask, warnings }
}

function stripPrefix(value: string, prefix: string): string {
  const stem = value.replace(/\.md$/i, "")
  return prefix && stem.startsWith(prefix) ? stem.slice(prefix.length) : stem
}

function sourceAliases(agent: AgentInfo, prefix: string): string[] {
  const filename = agent.filename.replace(/\.md$/i, "")
  const stripped = stripPrefix(filename, prefix)
  const aliases = [filename, stripped, normalizeVibeAgentName(filename, ""), normalizeVibeAgentName(stripped, "")]
  return [...new Set(aliases.filter(Boolean))]
}

function buildAgentAliasMap(agents: AgentInfo[], prefix: string): Map<string, string> {
  const aliases = new Map<string, string>()
  const generated = new Set<string>()
  for (const agent of agents) {
    const name = normalizeVibeAgentName(agent.filename, prefix)
    if (generated.has(name)) throw new Error(`Multiple agents map to the Vibe name '${name}'. Rename one before generating the bridge.`)
    generated.add(name)
    for (const alias of sourceAliases(agent, prefix)) {
      aliases.set(alias, name)
      aliases.set(alias.toLowerCase(), name)
    }
  }
  return aliases
}

function rewriteReferences(
  body: string,
  aliases: Map<string, string>,
  sourceName: string,
  warnings: string[],
  prefix: string,
  pluginName: string
): string {
  return body.replace(/@([a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9_-]+)*)(?::[a-zA-Z0-9][a-zA-Z0-9_-]*)?/g, (whole, reference: string) => {
    // Plugin-scoped references are already canonical and must remain idempotent.
    if (whole.includes(":")) return whole
    const target = aliases.get(reference) || aliases.get(reference.toLowerCase()) || legacyAgentAlias(normalizeVibeAgentName(reference, prefix), aliases)
    if (target) return `@${pluginName}:${target}`
    // Ignore email addresses and ordinary handles that are not agent-like.
    const prefixed = Boolean(prefix && reference.toLowerCase().startsWith(prefix.toLowerCase()))
    if (prefixed || reference.includes("/") || reference.includes("_")) {
      warnings.push(`${sourceName}: unresolved agent reference @${reference}`)
    }
    return whole
  })
}

function translateAllowedSubagents(
  agent: AgentInfo,
  aliases: Map<string, string>,
  warnings: string[],
  prefix: string,
  pluginName: string
): string[] {
  const targets: string[] = []
  for (const source of agent.allowedSubagents || []) {
    const stripped = source.replace(/\.md$/i, "")
    const target = aliases.get(source) || aliases.get(stripped) || aliases.get(source.toLowerCase()) ||
      aliases.get(stripped.toLowerCase()) || legacyAgentAlias(normalizeVibeAgentName(stripped, prefix), aliases)
    if (!target) {
      warnings.push(`${agent.filename}: unresolved delegated agent '${source}'`)
      continue
    }
    const scoped = `${pluginName}:${target}`
    if (!targets.includes(scoped)) targets.push(scoped)
  }
  return targets
}

function appendDelegationTargets(instructions: string, targets: string[]): string {
  if (targets.length === 0) return instructions
  const note = [
    "",
    "## Delegation targets",
    "",
    "Translated from the source pipeline. Registered specialists, exact `config_name` values for the native `agents.spawn` tool:",
    "",
    ...targets.map(target => `- \`${target}\``),
    "",
    "## Native Vibe delegation protocol",
    "",
    "- Spawn a specialist by setting `config_name` to one of the exact values above; the `name` argument only labels the child instance. A child spawned without `config_name` runs as a generic agent with your configuration, never the specialist's.",
    "- `agents.spawn` returns immediately: call `wait` for the result (or end the turn; the result arrives as a new message) before advancing to dependent work.",
    "- Independent specialists run concurrently: issue multiple `agents.spawn` calls in the same turn.",
    "- Reuse a specialist you already spawned with `agents.send_message` (it keeps its context) instead of spawning a duplicate; `agents.interrupt` stops its current turn.",
    "- Never spawn a generic agent as a substitute for a registered specialist, and never do a specialist's work yourself when the workflow requires delegation. If a spawn fails (for example `subagent_type_rejected`), report the failure.",
    "- If you are running as a spawned subagent yourself and have no `agents` tool, say so in your report: you cannot delegate here.",
    "- Capability contract of spawned specialists in the current Vibe runtime: they can read workspace files and manage their own session, but have no MCP or connector tools, no skill loading, no user-question tool and no nested delegation. Gather MCP-, skill- or web-derived facts yourself and pass them in the delegation `message`; a specialist can rely only on what you pass and what it can read.",
    ""
  ].join("\n")
  return `${instructions.trimEnd()}\n${note}`
}

export function convertVibeAgent(
  agent: AgentInfo,
  prefix: string,
  aliases: Map<string, string>,
  config: TranslationConfig,
  warnings: string[],
  agents: AgentInfo[] = [agent],
  resolvedTargets: ReadonlyMap<string, ResolvedModelTarget> = new Map(),
  customTools: ReadonlySet<string> = new Set(),
  serverNames: string[] = [],
  pluginName = "translated-agents"
): VibeAgent {
  const name = aliases.get(agent.filename.replace(/\.md$/i, "")) ?? normalizeVibeAgentName(agent.filename, prefix)
  const resolved = resolvedTargets.get(agent.filename)
  const model = resolved ? (resolved.model.model === "inherit" ? null : resolved.model.model) : resolveVibeModel(agent, agents, config).model
  const delegated = translateAllowedSubagents(agent, aliases, warnings, prefix, pluginName)
  const referenced = rewriteReferences(agent.body.trim(), aliases, agent.filename, warnings, prefix, pluginName)
  const narrowing = resolveToolNarrowing(agent)
  warnings.push(...narrowing.warnings.map(message => `${agent.filename}: ${message}`))
  const rawDescription = vibeDescription(agent, name)
  if (rawDescription.length > VIBE_AGENT_DESCRIPTION_LIMIT) {
    warnings.push(`${agent.filename}: description is ${rawDescription.length} characters; truncated to fit the Vibe agent profile (max ${VIBE_AGENT_DESCRIPTION_LIMIT})`)
  }
  const description = fitVibeDescription(rawDescription, VIBE_AGENT_DESCRIPTION_LIMIT)
  const mcpServers = permissionMcpServers(agent, customTools)
    .filter(server => serverNames.includes(server) && referenced.includes(`${server}_`))
  if (mcpServers.length > 0) {
    warnings.push(`${agent.filename}: references MCP server(s) ${mcpServers.join(", ")}; spawned Vibe subagents have no MCP or connector tools, so the main agent must gather those facts and pass them in the delegation message`)
  }
  const rewritten = adaptToolReferences(referenced, "vibe", agent.frontmatter, {
    customTools,
    mcpServers
  }).body
  const instructions = appendDelegationTargets(rewritten, delegated)
  if (agent.frontmatter.mode === "all") {
    warnings.push(`${agent.filename}: OpenCode mode 'all' has no Vibe equivalent; emitted as a subagent`)
  }
  if (agent.frontmatter.mode === "primary") {
    warnings.push(config.vibe.emitAgentProfiles === false
      ? `${agent.filename}: OpenCode mode 'primary' has no selectable Vibe plugin equivalent; emitted as subagent '${pluginName}:${name}' (spawn it to run it; a spawned subagent cannot delegate further)`
      : `${agent.filename}: OpenCode mode 'primary' emitted as spawnable subagent '${pluginName}:${name}' and as main agent profile '${pluginName}-${name}' (run it with 'vibe --agent ${pluginName}-${name}'; a spawned subagent cannot delegate further)`)
  }
  if ((agent.frontmatter.steps ?? agent.frontmatter.max_steps) !== undefined) {
    warnings.push(`${agent.filename}: 'steps' has no per-agent Vibe equivalent; ignored`)
  }
  if (agent.frontmatter.temperature !== undefined) {
    warnings.push(`${agent.filename}: 'temperature' has no Vibe agent equivalent; ignored`)
  }
  if (agent.frontmatter.hidden === true) {
    warnings.push(`${agent.filename}: 'hidden: true' has no Vibe equivalent; ignored`)
  }
  if (instructions.length > 65536) {
    warnings.push(`${agent.filename}: instructions are ${instructions.length} characters; Vibe refuses plugin agent instructions larger than ${VIBE_AGENT_FILE_LIMIT} characters`)
  }
  return {
    name,
    filename: `${name}.toml`,
    description,
    displayName: displayNameOf(name),
    mode: agent.frontmatter.mode === "primary" ? "primary" : "subagent",
    safety: narrowing.denied.includes("bash") && narrowing.denied.includes("write_file") && narrowing.denied.includes("edit")
      ? "safe"
      : "neutral",
    model,
    instructions,
    deniedTools: narrowing.denied,
    askTools: narrowing.ask,
    allowedSubagents: delegated
  }
}

/** Escape a TOML basic string, including DEL (which JSON leaves unescaped). */
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, "\\u007f")
}

/** Render one `ai.mistral.vibe/agents/<name>.toml` profile (Vibe plugin agent schema). */
export function renderVibeAgentToml(agent: VibeAgent, pluginName: string): string {
  // The Vibe runtime validates underscore-spelled keys only (no camelCase
  // aliases here, unlike the manifest) and refuses descriptions over 300 chars.
  const lines = [
    `# Generated by manage-agents — OpenCode to Mistral Vibe plugin bridge (${pluginName}). Do not edit.`,
    `schema_version = 1`,
    `agent_type = "subagent"`,
    `display_name = ${tomlString(agent.displayName)}`,
    `description = ${tomlString(agent.description)}`,
    `safety = ${tomlString(agent.safety)}`,
  ]
  if (agent.model !== null) lines.push(`active_model = ${tomlString(agent.model)}`)
  lines.push(`instructions = ${tomlString(agent.instructions)}`)
  const rules: Array<[string, string[]]> = [
    ["never", agent.deniedTools],
    ["ask", agent.askTools]
  ]
  for (const [permission, tools] of rules) {
    for (const tool of tools) {
      lines.push("", `[tools.${tool}]`, `permission = ${tomlString(permission)}`)
    }
  }
  return `${lines.join("\n")}\n`
}

/** Marker heading of generated main agent profiles; the installer prunes only files carrying it. */
export const VIBE_AGENT_PROFILE_MARKER = "Generated by manage-agents — OpenCode to Mistral Vibe agent profile bridge"

/**
 * Render one selectable main agent profile (`agent-profiles/<plugin>-<name>.toml`,
 * installed into `~/.vibe/agents/`). The plugin format ships spawnable subagents
 * only, so primary agents become user agent files: no `agent_type` (a main agent
 * is not a subagent) and no `safety` (ignored there and reported as a config issue).
 */
export function renderVibeAgentProfileToml(profile: VibeAgentProfile, pluginName: string): string {
  const lines = [
    `# ${VIBE_AGENT_PROFILE_MARKER} (${pluginName}). Do not edit.`,
    `display_name = ${tomlString(profile.agent.displayName)}`,
    `description = ${tomlString(profile.agent.description)}`
  ]
  if (profile.agent.model !== null) lines.push(`active_model = ${tomlString(profile.agent.model)}`)
  lines.push(`instructions = ${tomlString(profile.agent.instructions)}`)
  const rules: Array<[string, string[]]> = [
    ["never", profile.agent.deniedTools],
    ["ask", profile.agent.askTools]
  ]
  for (const [permission, tools] of rules) {
    for (const tool of tools) {
      lines.push("", `[tools.${tool}]`, `permission = ${tomlString(permission)}`)
    }
  }
  return `${lines.join("\n")}\n`
}

// --- Spawn guard hooks (optional, vibe.emitHooks) ---

/** Render `ai.mistral.vibe/hooks.toml`: a fail-open pre_tool guard on agents_spawn. */
function renderVibeHooksToml(plugin: VibePlugin): string {
  return [
    `# Generated by manage-agents — OpenCode to Mistral Vibe plugin bridge (${plugin.pluginName}). Do not edit.`,
    "# Guards the native subagent delegation: refuses spawns of unregistered or",
    "# identically repeated specialists of this plugin. Fail-open: any script",
    "# error lets the spawn through.",
    "",
    "[[hooks]]",
    'name = "guard-spawn"',
    'type = "pre_tool"',
    'match = "agents_spawn"',
    'command = "node ai.mistral.vibe/guard-spawn.js"',
    `description = "Deny unregistered or identically repeated ${plugin.pluginName} specialist spawns"`,
    ""
  ].join("\n")
}

/** Render the guard script: registered-config check plus the doom-loop equivalent. */
function renderVibeGuardSpawnScript(plugin: VibePlugin): string {
  const registered = plugin.agents.map(agent => `${plugin.pluginName}:${agent.name}`)
  return [
    "// Generated by manage-agents — OpenCode to Mistral Vibe plugin bridge. Do not edit.",
    "// Pre-tool guard for agents.spawn: denies config names that claim this plugin's",
    "// namespace but are not registered, and identical repeated delegations to the",
    "// same specialist (the doom_loop guard's equivalent). Fail-open on any error.",
    '"use strict"',
    `const PLUGIN = ${JSON.stringify(plugin.pluginName)}`,
    `const REGISTERED = new Set(${JSON.stringify(registered)})`,
    'function deny(reason) { process.stdout.write(JSON.stringify({ decision: "deny", reason })); process.exit(0) }',
    "async function main() {",
    "  const chunks = []",
    '  for await (const chunk of process.stdin) chunks.push(chunk)',
    '  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"))',
    "  const input = payload.tool_input || {}",
    '  const configName = typeof input.config_name === "string" ? input.config_name : null',
    '  if (!configName || !configName.startsWith(PLUGIN + ":")) process.exit(0)',
    "  if (!REGISTERED.has(configName)) {",
    '    deny("Unknown " + PLUGIN + " specialist configuration \'" + configName + "\'. Registered: " + [...REGISTERED].sort().join(", "))',
    "  }",
    "  const dataDir = process.env.PLUGIN_DATA",
    '  const signature = configName + "\\n" + String(input.message == null ? "" : input.message)',
    "  if (dataDir) {",
    '    const stateFile = require("path").join(dataDir, "manage-agents-guard-spawn.json")',
    "    let state = {}",
    '    try { state = JSON.parse(require("fs").readFileSync(stateFile, "utf8")) } catch {}',
    '    const session = payload.session_id || "session"',
    "    state[session] = state[session] || {}",
    "    if (state[session][configName] === signature) {",
    '      deny("Identical repeated delegation to \'" + configName + "\' (doom-loop guard). Change the task, follow up the existing specialist with send_message, or stop.")',
    "    }",
    "    state[session][configName] = signature",
    '    try { require("fs").mkdirSync(dataDir, { recursive: true }); require("fs").writeFileSync(stateFile, JSON.stringify(state)) } catch {}',
    "  }",
    "  process.exit(0)",
    "}",
    "main().catch(() => process.exit(0))",
    ""
  ].join("\n")
}

// --- MCP translation ---

interface VibePluginMcpServer {
  type: "stdio" | "streamable-http"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

interface VibeMcpConfig {
  servers: Array<[name: string, server: VibePluginMcpServer]>
}

const ENV_REFERENCE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/

/** Env keys the plugin runtime reserves (setting them is rejected). */
const RESERVED_PLUGIN_ENV_KEYS = ["PLUGIN_ROOT", "PLUGIN_DATA"]

function readBridgeMcpServers(workspaceRoot: string, warnings: string[]): Record<string, Record<string, any>> {
  const sourcePath = ["opencode.json", "opencode.jsonc"]
    .map(file => path.join(workspaceRoot, file)).find(file => fs.existsSync(file))
  if (!sourcePath) return {}
  try {
    const config = parseJsonc(fs.readFileSync(sourcePath, "utf-8")) as Record<string, any>
    return Object.fromEntries(Object.entries(readMcpServers(config))
      .filter(([, server]) => server && typeof server === "object" && !Array.isArray(server)))
  } catch {
    warnings.push(`[mcp] unable to read ${path.basename(sourcePath)}`)
    return {}
  }
}

function translateMcpServer(name: string, server: Record<string, any>, warnings: string[]): VibePluginMcpServer | null {
  if (typeof server.url === "string" && server.url.trim()) {
    const translated: VibePluginMcpServer = { type: "streamable-http", url: server.url.trim() }
    const headers: Record<string, string> = {}
    for (const [header, value] of Object.entries(server.headers ?? {})) {
      if (typeof value !== "string") continue
      if (ENV_REFERENCE.test(value)) {
        warnings.push(`[mcp] '${name}' header '${header}' references an environment variable; plugin mcp.json supports static headers only — install authenticated access in the user Vibe config or use OAuth there`)
        continue
      }
      headers[header] = value
    }
    if (Object.keys(headers).length > 0) translated.headers = headers
    return translated
  }
  const commandParts = Array.isArray(server.command)
    ? server.command.map(String)
    : typeof server.command === "string" ? server.command.trim().split(/\s+/) : []
  const [command, ...args] = commandParts
  if (!command) return null
  const translated: VibePluginMcpServer = { type: "stdio", command }
  if (args.length > 0) translated.args = args
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(server.environment ?? {})) {
    if (RESERVED_PLUGIN_ENV_KEYS.includes(key)) {
      warnings.push(`[mcp] '${name}' environment key '${key}' is reserved by the Vibe plugin runtime; dropped`)
      continue
    }
    const literal = String(value)
    const match = ENV_REFERENCE.exec(literal)
    if (match && literal === match[0]) {
      warnings.push(`[mcp] '${name}' expects the launching environment to provide '${key}'; review the generated mcp.json`)
      env[key] = `$\{${match[1]}}`
    } else if (match) {
      warnings.push(`[mcp] '${name}' environment '${key}' mixes an {env:} reference with literal text; review the generated mcp.json`)
      env[key] = literal
    } else {
      env[key] = literal
    }
  }
  if (Object.keys(env).length > 0) translated.env = env
  return translated
}

function buildVibeMcpConfig(
  source: Record<string, Record<string, any>>,
  requiredServers: ReadonlySet<string>,
  warnings: string[]
): VibeMcpConfig | null {
  const servers: Array<[string, VibePluginMcpServer]> = []
  for (const [name, server] of Object.entries(source)) {
    const required = requiredServers.has(name)
    if (isServerDisabled(server) && !required) {
      warnings.push(`[mcp] omitted disabled server '${name}'; add it to mcp.json if the translated agents need it`)
      continue
    }
    if (isServerDisabled(server)) {
      warnings.push(`[mcp] disabled server '${name}' was emitted because translated agents require it`)
    }
    const translated = translateMcpServer(name, server, warnings)
    if (!translated) {
      warnings.push(`[mcp] omitted server '${name}' with no URL or command`)
      continue
    }
    if (typeof server.timeout === "number" && Number.isFinite(server.timeout) && server.timeout > 0) {
      warnings.push(`[mcp] '${name}' timeout has no mcp.json equivalent; set it with 'vibe mcp add --tool-timeout-sec' when installing the server into the user config`)
    }
    servers.push([name, translated])
  }
  return servers.length > 0 ? { servers } : null
}

const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

function renderVibeMcpJson(config: VibeMcpConfig | null): string | null {
  if (!config) return null
  const mcpServers: Record<string, VibePluginMcpServer> = {}
  for (const [name, server] of config.servers) mcpServers[name] = server
  return `${JSON.stringify({ $schema: MCP_SCHEMA, mcpServers }, null, 2)}\n`
}

// --- plugin.json ---

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"

export function renderVibePluginManifest(plugin: VibePlugin): string {
  validateVibePluginName(plugin.pluginName)
  const manifest = {
    $schema: PLUGIN_SCHEMA,
    name: plugin.pluginName,
    version: "1.0.0",
    description: `OpenCode pack translated by manage-agents (${plugin.pluginName}): ${plugin.agents.length} agent${plugin.agents.length === 1 ? "" : "s"}, ${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}.`,
    author: { name: authorName() },
    extensions: {
      "ai.mistral.vibe": {
        schemaVersion: 1,
        displayName: displayNameOf(plugin.pluginName)
      }
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

// --- Skills ---

const VIBE_SKILL_DIR = "skills"
/** Vibe refuses to load a skill whose frontmatter description exceeds this length. */
const VIBE_SKILL_DESCRIPTION_LIMIT = 1024

/** A companion file must be a real file inside the bridged workspace. */
function resolveCompanionSourcePath(workspaceRoot: string, relative: string): string | null {
  const candidate = path.join(workspaceRoot, relative)
  if (!fs.existsSync(candidate)) return null
  if (fs.lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`Companion source must not be a symlink: ${candidate}`)
  }
  assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(candidate), candidate)
  return candidate
}

/** Read a command's `description` line directly: command frontmatter values may contain `: `. */
function commandDescription(yamlText: string | null): string {
  if (!yamlText) return ""
  for (const line of yamlText.split(/\r?\n/)) {
    const match = line.match(/^description:\s*(.*)$/)
    if (!match) continue
    const value = match[1].trim()
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1)
    }
    return value
  }
  return ""
}

/** Rewrite OpenCode command placeholders and `!` substitutions into skill instructions. */
function rewriteCommandBody(body: string, orchestrator: string | null, profileName: string | null): { body: string; substitutions: number } {
  const delegation = profileName
    ? `This command runs under the ${profileName} Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with \`vibe --agent ${profileName}\` (or switch a live session with \`/agent ${profileName}\`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native \`agents.spawn\` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.`
    : orchestrator
      ? `Delegate this task to the ${orchestrator} subagent (the translated primary agent), passing the brief below unchanged. The $request placeholder below is the text the user typed after the /skill invocation.`
      : `Complete this task with the translated Vibe subagents, passing the brief below unchanged. The $request placeholder below is the text the user typed after the /skill invocation.`
  let substitutions = 0
  const rewritten = body
    .replace(/!`([^`\n]+)`/g, (_match, command: string) => {
      substitutions += 1
      return `\n\n\`\`\`bash\n${command.trim()}\n\`\`\`\n\n`
    })
    .replace(/\$ARGUMENTS/g, () => "$request")
  return { body: `${delegation}\n\n${normalizeAgentBody(rewritten).trimEnd()}\n`, substitutions }
}

/** Translate one OpenCode command file into a user-invocable Vibe skill. */
function renderCommandSkill(sourcePath: string, orchestrator: string | null, profileName: string | null): { name: string; content: string; warning: string } {
  const name = path.basename(sourcePath).replace(/\.md$/i, "")
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new Error(`Invalid command skill name: ${JSON.stringify(name)}`)
  }
  const raw = fs.readFileSync(sourcePath, "utf-8")
  const { yamlText, body } = extractFrontmatter(raw)
  const description = commandDescription(yamlText)
  const rewritten = rewriteCommandBody(body, orchestrator, profileName)
  const frontmatter = YAML.stringify({
    name,
    description: description || `Run the ${name} pipeline command.`,
    "user-invocable": true,
    "disable-model-invocation": true
  }).trim()
  const content = `---\n${frontmatter}\n---\n\n${rewritten.body}`
  return { name, content, warning: `converted ${rewritten.substitutions} !-substitution(s) to inline instructions` }
}

/** Fail closed on any link in a source tree: cpSync preserves links and rewrites would follow them. */
function assertNoSymlinksInTree(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Companion source must not be a symlink: ${entryPath}`)
    if (entry.isDirectory()) assertNoSymlinksInTree(entryPath)
  }
}

/** Copy a companion skill directory, pinning the frontmatter `name` and guaranteeing a description. */
function copyCompanionSkill(
  sourceDir: string,
  skillsRoot: string,
  warnings: string[]
): { name: string; files: Array<{ target: string; source?: string }> } {
  if (!fs.statSync(sourceDir).isDirectory()) return { name: "", files: [] }
  const name = path.basename(sourceDir)
  const targetDir = path.join(skillsRoot, name)
  assertNoSymlinksInTree(sourceDir)
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.cpSync(sourceDir, targetDir, { recursive: true })
  const files: Array<{ target: string; source?: string }> = []
  let skillMdPresent = false
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(targetDir, relative), { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel)
      else if (rel === "SKILL.md") skillMdPresent = true
      else files.push({ target: `${VIBE_SKILL_DIR}/${name}/${rel}`, source: path.join(sourceDir, rel) })
    }
  }
  walk("")
  if (fs.existsSync(path.join(targetDir, "SKILL.md"))) {
    const skillPath = path.join(targetDir, "SKILL.md")
    if (fs.lstatSync(skillPath).isSymbolicLink()) throw new Error(`Companion source must not be a symlink: ${skillPath}`)
    const { yamlText, body } = extractFrontmatter(fs.readFileSync(skillPath, "utf-8"))
    const meta: Record<string, any> = yamlText ? ((YAML.parse(yamlText) as Record<string, any>) ?? {}) : {}
    // Vibe requires the skill frontmatter name to match the directory name.
    meta.name = name
    if (!meta.description) {
      meta.description = name
      warnings.push(`Skill '${name}' has no description; the Vibe skill falls back to its name (add one so the model can discover it)`)
    }
    const description = String(meta.description)
    if (description.length > VIBE_SKILL_DESCRIPTION_LIMIT) {
      warnings.push(`Skill '${name}' description is ${description.length} characters; Vibe refuses to load skills over ${VIBE_SKILL_DESCRIPTION_LIMIT}`)
    }
    fs.writeFileSync(skillPath, `---\n${YAML.stringify(meta).trim()}\n---\n\n${normalizeAgentBody(body)}`, "utf-8")
  }
  if (skillMdPresent) files.unshift({ target: `${VIBE_SKILL_DIR}/${name}/SKILL.md` })
  return { name, files }
}

// --- README ---

function renderMcpSetup(config: VibeMcpConfig | null, platforms: Record<string, string> = {}): string[] {
  if (!config || config.servers.length === 0) return []
  const lines = [
    "## MCP setup",
    "",
    "`mcp.json` declares the translated servers. `npx` commands are fetched on first use; binaries must already be available on `PATH`.",
    ""
  ]
  for (const [name, server] of config.servers) {
    const setup = server.type === "stdio"
      ? `runs ${markdownCode([server.command, ...(server.args ?? [])].join(" "))} (Node.js, npm and network access required for npx).`
      : `remote endpoint ${markdownCode(server.url ?? "")}; check network and authentication access.`
    lines.push(`- ${markdownCode(name)} — ${setup}`)
  }
  lines.push(
    "",
    `The plugin carries these servers as-is. Authenticated remote servers (and \`{env:VAR}\` headers) cannot be expressed in a plugin's static mcp.json: install them at the Vibe config level instead, for example ${markdownCode("vibe mcp add <name> --url <url> --api-key-env <VAR>")}, or via OAuth.`,
    "",
    "Commands may carry the `{browser}` placeholder: the manager's installer resolves it to this machine's browser (Chromium preferred over Chrome) and drops the argument when none is installed.",
    ...(Object.keys(platforms).length > 0 ? [
      "",
      `Platform-gated servers (${Object.entries(platforms).map(([name, value]) => `\`${name}\`: ${value}`).join(", ")}) are recorded in \`mcp-platforms.json\`: the manager's installer keeps them only on matching machines, because a plugin's mcp.json cannot express conditions.`
    ] : []),
    "",
    "In a session, run `/mcp` (or `/mcp status`) to verify every server is connected.",
    ""
  )
  return lines
}

/** README section documenting the OpenCode companions that were not translated. */
function renderVibeCompanionSection(companions: OpenCodeCompanions): string[] {
  if (companions.plugins.length === 0 && companions.tools.length === 0) return []
  return [
    "## OpenCode plugins and tools",
    "",
    "These OpenCode companions ship with the bridged packs but have no Vibe equivalent (Vibe loads skills, agents, hooks and MCP servers only). Replace custom tools with a skill when the agents need that behavior:",
    "",
    ...companions.plugins.map(plugin => `- Plugin: ${markdownCode(plugin)}`),
    ...companions.tools.map(tool => `- Tool: ${markdownCode(tool)}`),
    ""
  ]
}

function renderAgentList(plugin: VibePlugin): string[] {
  return [
    "",
    "## Agents",
    "",
    ...plugin.agents.map(agent => `- **${agent.name}** (spawn as \`${plugin.pluginName}:${agent.name}\`, safety \`${agent.safety}\`${agent.model ? `, model: ${agent.model}` : ", session model"}): ${agent.description}`)
  ]
}

/** README section for the generated main agent profiles (primary agents). */
function renderMainProfilesSection(plugin: VibePlugin): string[] {
  if (plugin.profiles.length === 0) return []
  return [
    "",
    "## Main agent profiles",
    "",
    "The plugin format ships spawnable subagents only, and a spawned subagent cannot delegate further. The translated primary agents therefore also ship as main agent profiles: install `agent-profiles/` into `~/.vibe/agents/` (the manager does this by default) and start Vibe with `vibe --agent <profile>` (or switch a live session with `/agent <profile>`).",
    "",
    ...plugin.profiles.map(profile => {
      const name = profile.fileName.replace(/\.toml$/, "")
      return `- **${name}** (\`vibe --agent ${name}\`${profile.agent.model ? `, model: ${profile.agent.model}` : ", session model"}): ${profile.agent.description}`
    }),
    "",
    "If your `config.toml` sets `enabled_agents`, add the profile names there or they stay hidden. Subagent profiles are rejected as `--agent`, so these main profiles are also the only way to run a specialist at the session level (for example from external tooling)."
  ]
}

function renderReadme(
  plugin: VibePlugin,
  companions: OpenCodeCompanions,
  warnings: string[],
  mcpConfig: VibeMcpConfig | null,
  mcpPlatforms: Record<string, string>,
  bashAllowlists: BashAllowlist[],
  hasCommands: boolean,
  hasHooks: boolean
): string {
  const lines = [
    `# ${plugin.pluginName}`,
    "",
    "This directory is a generated **Vibe plugin** (Agent Plugins 1.0 with the `ai.mistral.vibe` extension) translated from the canonical OpenCode source agents. Source agents are unchanged.",
    "",
    "> **Generated output.** Do not edit this directory directly. Change the pack's agents or `bridges/translation-config.json`, then regenerate with the manager.",
    "",
    "## Install",
    "",
    "Copy this directory (or let the manager install it) into one of the plugin roots:",
    "",
    `- \`~/.vibe/plugins/${plugin.pluginName}/\` — user global: available in every session.`,
    `- \`<project>/.vibe/plugins/${plugin.pluginName}/\` — project scope: available when that trusted folder is open.`,
    "",
    "New sessions pick the plugin up automatically; a live session needs `/reload-plugins` (or `/reload`). `/plugins` lists it with its components.",
    "",
    "## Source and configuration",
    "",
    `Agent prompts come from the bridged pack. Translation roles, tiers, model overrides, prefix, and output options come from ${markdownCode("bridges/translation-config.json")}; MCP declarations are merged from the ${markdownCode("opencode.json")} of the pack and the packs it requires.`,
    "",
    "- `plugin.json` — Agent Plugins 1.0 manifest with the `ai.mistral.vibe` extension.",
    `- \`skills/\` — pack skills plus the translated commands; each is a standard \`SKILL.md\` named \`${plugin.pluginName}:<skill>\` at runtime. User-invocable command skills appear in the slash menu.`,
    "- `ai.mistral.vibe/agents/` — one TOML per translated subagent, named `<plugin>:<agent>` at runtime.",
    ...(plugin.profiles.length > 0 ? ["- `agent-profiles/` — one TOML per translated primary agent, to install into `~/.vibe/agents/` (the manager does this by default)."] : []),
    ...(hasHooks ? ["- `ai.mistral.vibe/hooks.toml` and `ai.mistral.vibe/guard-spawn.js` — a fail-open guard on `agents_spawn`."] : []),
    mcpConfig ? "- `mcp.json` — MCP servers declared by the plugin." : "",
    "",
    "All agents are also spawnable subagents, named `<plugin>:<agent>` at runtime: ask the model to delegate, or spawn them directly by name. Spawned subagents run with a reduced toolset — file access, session utilities and background processes; no MCP or connector tools, no skill loading, no user questions and no nested delegation — so the main agent gathers MCP- or skill-derived facts itself and passes them in the delegation message.",
    ...renderMainProfilesSection(plugin),
    ...(hasHooks ? [
      "",
      "## Spawn guard",
      "",
      "`ai.mistral.vibe/hooks.toml` ships a fail-open `pre_tool` guard on `agents_spawn`: it denies `config_name` values that claim this plugin's namespace but are not registered, and identical repeated delegations to the same specialist (the doom-loop guard's equivalent). Any script error lets the spawn through. Turn it off with `vibe.emitHooks: false` in the translation config."
    ] : []),
    "",
    "### Model connection",
    "",
    "Every agent follows the Vibe session's model by default: a tier model, a `modelMap` entry or an override pins `active_model` only when the translation config says so, and `inherit` restores the default. Vibe only accepts aliases defined in the `[[models]]` entries of its own configuration and refuses an agent file whose alias is unknown, so align any pinned tier model with the aliases of your Vibe installation. A `plugin.agent.invalid` diagnostic in the startup warnings names any refused agent file.",
    "",
    "OpenCode tool names in prompts are rewritten where Vibe has an equivalent (`todowrite` → `todo`, `question` → `ask_user_question`, Task tool → `agents.spawn`, `read` → `read_file`, `write` → `write_file`). Prompts that rely on custom tools shipped by the pack start with a runtime note saying they are unavailable here and that the documented fallbacks apply." + (hasCommands ? " Commands were translated into user-invocable skills: their `$ARGUMENTS` placeholder became `$request`, and `!`substitutions`` became inline bash blocks." : ""),
    "",
    ...renderMcpSetup(mcpConfig, mcpPlatforms),
    ...renderVibeCompanionSection(companions),
    ...renderBashAllowlistSection("vibe", bashAllowlists),
    ...renderAgentList(plugin)
  ]
  if (warnings.length > 0) {
    lines.push("", "## Translation warnings", "", ...warnings.map(warning => `- ${warning}`))
  }
  return `${lines.filter((line, index) => !(line === "" && (index === 0 || lines[index - 1] === ""))).join("\n")}\n`
}

/** Post-generation hints printed by the CLI and the TUI. `install` is set when the plugin was copied into the plugins root; `profilesInstall` when the main agent profiles were mirrored into the agents root. */
export function vibeNextSteps(result: VibeBridgeResult, install?: { path: string; changed: boolean } | null, profilesInstall?: { path: string; changed: boolean } | null): string[] {
  const lines = ["  vibe"]
  const profiles = result.plugin.profiles ?? []
  if (install) {
    lines.push(`  Installed in ${install.path}${install.changed ? "" : " (already up to date)"}.`)
  } else {
    const quotedDir = "'" + result.pluginDir.replace(/'/g, "'\"'\"'") + "'"
    lines.push(`  To install or refresh the plugin manually: cp -r ${quotedDir}/ "$HOME/.vibe/plugins/${result.plugin.pluginName}/"`)
    if (profiles.length > 0) {
      lines.push(`  To install the main agent profiles manually: cp ${quotedDir}/agent-profiles/*.toml "$HOME/.vibe/agents/"`)
    }
  }
  if (profilesInstall) {
    lines.push(`  Agent profiles installed in ${profilesInstall.path}${profilesInstall.changed ? "" : " (already up to date)"}.`)
  }
  lines.push("  /plugins (or /reload-plugins) in a live session to confirm it is loaded.")
  for (const profile of profiles) {
    const name = profile.fileName.replace(/\.toml$/, "")
    lines.push(`  Run the translated primary agent: vibe --agent ${name} (or /agent ${name} in a live session).`)
  }
  if (result.plugin.orchestratorName) {
    lines.push(`  The plugin also ships it as spawnable subagent ${result.plugin.pluginName}:${result.plugin.orchestratorName}; a spawned subagent cannot delegate further, so prefer the main profile.`)
  }
  return lines
}

/**
 * Write a Vibe plugin package without modifying source agents.
 *
 * Output layout:
 *   <output>/plugin.json
 *   <output>/skills/<name>/SKILL.md (commands and pack skills)
 *   <output>/ai.mistral.vibe/agents/<name>.toml (one subagent per file)
 *   <output>/agent-profiles/<plugin>-<name>.toml (one main profile per primary agent)
 *   <output>/ai.mistral.vibe/hooks.toml (only with vibe.emitHooks)
 *   <output>/mcp.json (MCP servers)
 *   <output>/README.md
 */
export function writeVibePlugin(
  agents: AgentInfo[],
  pluginNameInput: string,
  prefix: string,
  outputDir: string,
  workspaceRoot: string,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG
): VibeBridgeResult {
  if (!Array.isArray(agents)) {
    throw new Error(`Cannot generate Vibe bridge "${pluginNameInput}": no agents provided.`)
  }
  if (typeof workspaceRoot !== "string" || !workspaceRoot) {
    throw new Error("writeVibePlugin requires a workspaceRoot")
  }
  config = { ...config, prefix }
  const warnings: string[] = []
  for (const key of unusedModelMapKeys(agents, config, "vibe")) {
    warnings.push(`[model-map] entry "${key}" matches no source agent model`)
  }
  const normalizedPluginName = vibePluginNameValue(pluginNameInput)
  validateVibePluginName(normalizedPluginName)
  const companions = scanOpenCodeCompanions(workspaceRoot)
  const customTools = new Set(companions.tools.map(toolModuleName))
  const requiredServers = new Set(agents.flatMap(agent => permissionMcpServers(agent, customTools)))
  const mcpSource = config.vibe.emitMcp === false ? {} : readBridgeMcpServers(workspaceRoot, warnings)
  const mcpConfig = buildVibeMcpConfig(mcpSource, requiredServers, warnings)
  const activeServerNames = (mcpConfig?.servers ?? []).map(([name]) => name)
  // Platform gates travel as a sidecar: mcp.json stays machine-independent
  // (committed bridges stay byte-identical everywhere) and the installer of
  // each machine drops the servers that are not built for it.
  const mcpPlatforms: Record<string, string> = {}
  for (const name of activeServerNames) {
    const platforms = serverPlatform(mcpSource[name] ?? {})
    if (platforms) mcpPlatforms[name] = platforms.join(",")
  }
  const aliases = buildAgentAliasMap(agents, prefix)
  const targets = resolveTargets(agents, config)
  const translatedAgents = agents.map(agent => convertVibeAgent(agent, prefix, aliases, config, warnings, agents, targets, customTools, activeServerNames, normalizedPluginName))
  for (const file of companions.plugins) {
    warnings.push(`OpenCode plugin '${file}' is not transpiled; see the README section 'OpenCode plugins and tools'`)
  }
  for (const file of companions.tools) {
    warnings.push(`OpenCode tool '${file}' is not transpiled; see the README section 'OpenCode plugins and tools'`)
  }

  const primary = agents.find(agent => agent.frontmatter.mode === "primary")
  const primaryName = primary ? translatedAgents[agents.indexOf(primary)].name : null
  const orchestratorScopedName = primaryName ? `${normalizedPluginName}:${primaryName}` : null
  const profiles = config.vibe.emitAgentProfiles === false ? [] : translatedAgents
    .filter(agent => agent.mode === "primary")
    .map(agent => ({ fileName: `${normalizedPluginName}-${agent.name}.toml`, agent }))
  const primaryProfileName = primaryName && profiles.some(profile => profile.agent.name === primaryName) ? `${normalizedPluginName}-${primaryName}` : null
  const emitHooks = config.vibe.emitHooks === true && translatedAgents.length > 0
  const emitSkills = config.vibe.emitSkills !== false
  // Resolve and gate the output before any companion skill is copied in place.
  const pluginDir = realpathThroughExistingAncestor(path.resolve(outputDir))
  assertInsideRealWorkspace(workspaceRoot, pluginDir, outputDir)
  const skillsRoot = path.join(pluginDir, VIBE_SKILL_DIR)
  assertInsideRealWorkspace(workspaceRoot, realpathThroughExistingAncestor(skillsRoot), skillsRoot)
  const artifacts = new Map<string, { source?: string } | string>()
  const skillNames = new Set<string>()
  const commandNames = new Set<string>()
  if (emitSkills) {
    for (const command of companions.commands) {
      const sourcePath = resolveCompanionSourcePath(workspaceRoot, command)
      if (!sourcePath) continue
      const skill = renderCommandSkill(sourcePath, orchestratorScopedName, primaryProfileName)
      if (skillNames.has(skill.name)) {
        warnings.push(`Command '${command}' collides with an already exported skill '${skill.name}'; skipped`)
        continue
      }
      skillNames.add(skill.name)
      commandNames.add(skill.name)
      artifacts.set(`${VIBE_SKILL_DIR}/${skill.name}/SKILL.md`, skill.content)
      warnings.push(`[commands] '${skill.name}': ${skill.warning}`)
    }
    for (const skill of companions.skills) {
      const sourceDir = resolveCompanionSourcePath(workspaceRoot, skill)
      if (!sourceDir || !fs.statSync(sourceDir).isDirectory()) continue
      if (skillNames.has(path.basename(sourceDir))) {
        warnings.push(`Skill '${skill}' collides with an already exported skill '${path.basename(sourceDir)}'; the command skill wins`)
        continue
      }
      const copied = copyCompanionSkill(sourceDir, skillsRoot, warnings)
      if (copied.name) skillNames.add(copied.name)
      // SKILL.md entries have no source: they are already written in place,
      // patched by copyCompanionSkill.
      for (const file of copied.files) artifacts.set(file.target, file.source === undefined ? {} : { source: file.source })
    }
  }
  if (!agents.length && skillNames.size === 0 && !mcpConfig) {
    throw new Error(`Cannot generate Vibe bridge "${pluginNameInput}": no agents, skills or MCP servers to export.`)
  }
  const plugin: VibePlugin = {
    pluginName: normalizedPluginName,
    agents: translatedAgents,
    skills: [...skillNames].sort(),
    orchestratorName: primaryName,
    profiles
  }

  artifacts.set("plugin.json", renderVibePluginManifest(plugin))
  for (const agent of translatedAgents) {
    artifacts.set(`ai.mistral.vibe/agents/${agent.filename}`, renderVibeAgentToml(agent, plugin.pluginName))
  }
  for (const profile of profiles) {
    artifacts.set(`agent-profiles/${profile.fileName}`, renderVibeAgentProfileToml(profile, plugin.pluginName))
  }
  if (emitHooks) {
    artifacts.set("ai.mistral.vibe/hooks.toml", renderVibeHooksToml(plugin))
    artifacts.set("ai.mistral.vibe/guard-spawn.js", renderVibeGuardSpawnScript(plugin))
  }
  const mcpJson = renderVibeMcpJson(mcpConfig)
  if (mcpJson) artifacts.set("mcp.json", mcpJson)
  if (Object.keys(mcpPlatforms).length > 0) artifacts.set("mcp-platforms.json", `${JSON.stringify(mcpPlatforms, null, 2)}\n`)
  if (config.vibe.emitReadme !== false) {
    const bashAllowlists = agents
      .map((agent, index) => collectBashAllowlist(translatedAgents[index]?.name ?? agent.filename, agent.frontmatter))
      .filter((allowlist): allowlist is BashAllowlist => allowlist !== null)
    artifacts.set("README.md", renderReadme(plugin, companions, warnings, mcpConfig, mcpPlatforms, bashAllowlists, commandNames.size > 0, emitHooks))
  }

  const files: string[] = []
  for (const [relative, contents] of artifacts) {
    const file = path.join(pluginDir, relative)
    if (typeof contents !== "string" && contents.source === undefined) {
      // Companion skill file already written in place (patched copy).
      files.push(file)
      continue
    }
    const resolvedFile = realpathThroughExistingAncestor(file)
    assertInsideRealWorkspace(workspaceRoot, resolvedFile, file)
    if (resolvedFile !== file || fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Vibe bridge file must not pass through a symlink: ${file}`)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(path.dirname(file)), file)
    if (typeof contents === "string") fs.writeFileSync(file, contents)
    else fs.copyFileSync(contents.source!, file)
    files.push(file)
  }
  const preview = agents.map(agent => {
    const resolved = targets.get(agent.filename)!
    if (resolved.source === "inferred" || resolved.source === "default") warnings.push(`[${agent.filename}] model assignment source: ${resolved.source}`)
    return { agent: agent.filename, role: resolved.role, tier: resolved.tier, model: resolved.model.model, source: resolved.source, ...(resolved.inferredFrom ? { inferredFrom: resolved.inferredFrom } : {}) }
  })
  return { pluginDir, files, warnings, plugin, preview }
}

export function bridgeToVibe(
  agents: AgentInfo[],
  pluginNameInput: string,
  prefix: string,
  outputDir: string,
  workspaceRoot: string,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG
): VibeBridgeResult {
  return writeVibePlugin(agents, pluginNameInput, prefix, outputDir, workspaceRoot, config)
}
