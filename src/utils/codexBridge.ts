import fs from "node:fs"
import path from "node:path"
import type { AgentInfo } from "./agents.js"
import { buildInferenceIndex, DEFAULT_TRANSLATION_CONFIG, resolveModelTarget, authorName, unusedModelMapKeys } from "./translationConfig.js"
import type { TranslationConfig } from "./translationConfig.js"
import { assertInsideRealWorkspace, realpathThroughExistingAncestor } from "./pathValidation.js"
import { isKnownPermissionKey, translatePermissionsV2ToV1 } from "./v2Compat.js"
import { isServerDisabled, readMcpServers } from "./opencodeMcp.js"
import { parseJsonc, toolModuleName, toolModulePaths } from "./packs.js"
import { adaptToolReferences, legacyAgentAlias, collectBashAllowlist, isOpenCodeCustomToolKey, renderBashAllowlistSection, type BashAllowlist } from "./bridgeToolReferences.js"

/** A key containing an underscore that is not a built-in tool permission names an MCP server. */
function isMcpPermissionKey(key: string, customTools: ReadonlySet<string>): boolean {
  return key.includes("_") && !isKnownPermissionKey(key) && !isOpenCodeCustomToolKey(key, customTools)
}

function agentPermissions(agent: AgentInfo): Record<string, any> {
  return agent.frontmatter.permissions
    ? translatePermissionsV2ToV1(agent.frontmatter.permissions)
    : agent.frontmatter.permission || {}
}

function mcpServerForPermission(key: string, serverNames: string[]): string {
  return serverNames.find(name => key.startsWith(`${name}_`)) ?? key.replace(/_.*$/, "")
}

function agentMcpServers(agent: AgentInfo, customTools: ReadonlySet<string>, serverNames: string[]): string[] {
  const servers = new Set<string>()
  for (const [key, value] of Object.entries(agentPermissions(agent))) {
    if (!isMcpPermissionKey(key, customTools)) continue
    if (permissionAllows(value)) servers.add(mcpServerForPermission(key, serverNames))
  }
  return [...servers]
}

type ResolvedModelTarget = ReturnType<typeof resolveModelTarget>
type ResolvedTargets = Map<string, ResolvedModelTarget>

const markdownCode = (value: string) => {
  const normalized = value.replace(/\r\n?|\n/g, " ")
  const runs = [...normalized.matchAll(/`+/g)].map(match => match[0].length)
  const fence = "`".repeat(Math.max(1, ...(runs.length ? runs : [0]).map(length => length + 1)))
  return `${fence}${normalized}${fence}`
}

function resolveTargets(agents: AgentInfo[], config: TranslationConfig): ResolvedTargets {
  const inferenceIndex = buildInferenceIndex(agents, config)
  return new Map(agents.map(agent => [agent.filename, resolveModelTarget(agent, inferenceIndex, config, "codex")]))
}

/** A Codex model and its reasoning budget. */
export interface CodexModelTarget {
  model: string
  reasoningEffort?: string
}

export interface CodexBridgeConfig {
  /** Also emit skills that carry each translated developer prompt. */
  emitSkills?: boolean
  /** Translate enabled OpenCode MCP servers for both the project and plugin. */
  emitMcp?: boolean
  /** Emit a README describing the generated layer and unresolved links. */
  emitReadme?: boolean
}

export interface CodexAgent {
  name: string
  filename: string
  description: string
  model: string
  modelReasoningEffort?: string
  developerInstructions: string
  allowedSubagents: string[]
  sandboxMode: "read-only" | "workspace-write"
}

export interface CodexPlugin {
  pluginName: string
  agents: CodexAgent[]
  skills: string[]
  orchestratorName: string | null
}

export interface CodexBridgeResult {
  pluginDir: string
  files: string[]
  warnings: string[]
  plugin: CodexPlugin
  preview: Array<{ agent: string; role: string; tier: string; model: string; source: "override" | "model-map" | "role" | "inferred" | "default"; inferredFrom?: string }>
}

function normalizeName(value: string): string {
  const withoutExtension = value.replace(/\.md$/i, "")
  const normalized = withoutExtension
    .replace(/[_\s.]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
  return normalized || "agent"
}

export function normalizeCodexAgentName(filename: string, prefix = ""): string {
  const stem = filename.replace(/\.md$/i, "")
  const stripped = prefix && stem.startsWith(prefix) ? stem.slice(prefix.length) : stem
  return normalizeName(stripped)
}

function pluginName(value: string): string {
  const normalized = normalizeName(value).slice(0, 64).replace(/-+$/g, "")
  return normalized || "translated-agents"
}

export function resolveCodexModel(agent: AgentInfo, agents: AgentInfo[] = [agent], config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG): CodexModelTarget {
  return resolveModelTarget(agent, buildInferenceIndex(agents, config), config, "codex").model
}

function permissionAllows(value: unknown): boolean {
  if (value === true || value === "allow") return true
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).some(entry => entry === true || entry === "allow")
}

function resolveSandboxMode(agent: AgentInfo): "read-only" | "workspace-write" {
  // Normalize permissions to V1 format for internal use
  const permissions = agent.frontmatter.permissions
    ? translatePermissionsV2ToV1(agent.frontmatter.permissions)
    : agent.frontmatter.permission || {}
  return permissionAllows(permissions.write) || permissionAllows(permissions.edit) ||
    permissionAllows(permissions.apply_patch) || permissionAllows(permissions.patch) || permissionAllows(permissions.multiedit) ||
    permissionAllows(permissions.bash) || permissionAllows(permissions.shell) || permissionAllows(permissions.execute)
    ? "workspace-write"
    : "read-only"
}

function stripPrefix(value: string, prefix: string): string {
  const stem = value.replace(/\.md$/i, "")
  return prefix && stem.startsWith(prefix) ? stem.slice(prefix.length) : stem
}

function sourceAliases(agent: AgentInfo, prefix: string): string[] {
  const filename = agent.filename.replace(/\.md$/i, "")
  const stripped = stripPrefix(filename, prefix)
  const aliases = [filename, stripped, normalizeName(filename), normalizeName(stripped)]
  return [...new Set(aliases.filter(Boolean))]
}

function buildAgentAliasMap(agents: AgentInfo[], prefix: string): Map<string, string> {
  const aliases = new Map<string, string>()
  const generated = new Set<string>()
  for (const agent of agents) {
    const name = normalizeCodexAgentName(agent.filename, prefix)
    if (generated.has(name)) throw new Error(`Multiple agents map to the Codex name '${name}'. Rename one before generating the bridge.`)
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
  prefix: string
): string {
  return body.replace(/@([a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9_-]+)*)/g, (match, reference: string) => {
    const target = aliases.get(reference) || aliases.get(reference.toLowerCase()) || legacyAgentAlias(normalizeCodexAgentName(reference, prefix), aliases)
    if (target) return `@${target}`
    // Ignore email addresses and ordinary handles that are not agent-like.
    const prefixed = Boolean(prefix && reference.toLowerCase().startsWith(prefix.toLowerCase()))
    if (prefixed || reference.includes("/") || reference.includes("_")) {
      warnings.push(`${sourceName}: unresolved agent reference @${reference}`)
    }
    return match
  })
}

function translateAllowedSubagents(
  agent: AgentInfo,
  aliases: Map<string, string>,
  warnings: string[],
  prefix: string
): string[] {
  const targets: string[] = []
  for (const source of agent.allowedSubagents || []) {
    const stripped = source.replace(/\.md$/i, "")
    const target = aliases.get(source) || aliases.get(stripped) || aliases.get(source.toLowerCase()) ||
      aliases.get(stripped.toLowerCase()) || legacyAgentAlias(normalizeCodexAgentName(stripped, prefix), aliases)
    if (!target) {
      warnings.push(`${agent.filename}: unresolved delegated agent '${source}'`)
      continue
    }
    if (!targets.includes(target)) targets.push(target)
  }
  return targets
}

function appendDelegationTargets(instructions: string, targets: string[]): string {
  if (targets.length === 0) return instructions
  const note = [
    "",
    "## Delegation targets",
    "",
    "Translated from the source pipeline. Use these Codex subagents when delegation is appropriate:",
    ...targets.map(target => `- @${target}`),
    ""
  ].join("\n")
  return `${instructions.trimEnd()}\n${note}`
}

export function convertCodexAgent(
  agent: AgentInfo,
  prefix: string,
  aliases: Map<string, string>,
  config: TranslationConfig,
  warnings: string[],
  agents: AgentInfo[] = [agent],
  resolvedTargets: ReadonlyMap<string, ResolvedModelTarget> = new Map(),
  customTools: ReadonlySet<string> = new Set(),
  serverNames: string[] = []
): CodexAgent {
  const name = normalizeCodexAgentName(agent.filename, prefix)
  const target = resolvedTargets.get(agent.filename)?.model ?? resolveCodexModel(agent, agents, config)
  const delegated = translateAllowedSubagents(agent, aliases, warnings, prefix)
  const referenced = rewriteReferences(agent.body.trim(), aliases, agent.filename, warnings, prefix)
  // Translate OpenCode tool names and flag OpenCode-only tools near the top.
  const rewritten = adaptToolReferences(referenced, "codex", agent.frontmatter, {
    customTools,
    mcpServers: agentMcpServers(agent, customTools, serverNames).filter(server => serverNames.includes(server) && referenced.includes(`${server}_`))
  }).body
  return {
    name,
    filename: `${name}.toml`,
    description: agent.description || `Translated agent ${name}`,
    model: target.model,
    modelReasoningEffort: target.reasoningEffort,
    developerInstructions: appendDelegationTargets(rewritten, delegated),
    allowedSubagents: delegated,
    sandboxMode: resolveSandboxMode(agent)
  }
}

/** Escape a TOML basic string, including DEL (which JSON leaves unescaped). */
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, "\\u007f")
}

export function renderCodexAgentToml(agent: CodexAgent): string {
  return [
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(agent.description)}`,
    `developer_instructions = ${tomlString(agent.developerInstructions)}`,
    `model = ${tomlString(agent.model)}`,
    ...(agent.modelReasoningEffort ? [`model_reasoning_effort = ${tomlString(agent.modelReasoningEffort)}`] : []),
    `sandbox_mode = ${tomlString(agent.sandboxMode)}`,
    ""
  ].join("\n")
}

export function renderCodexSkill(agent: CodexAgent): string {
  return [
    "---",
    `name: ${agent.name}`,
    `description: ${JSON.stringify(agent.description)}`,
    "---",
    "",
    agent.developerInstructions.trim(),
    ""
  ].join("\n")
}

const PROJECT_SKILLS_DIR = ".agents/skills"
const marketplaceName = (pluginName: string) => `${pluginName}-local`

export function codexNextSteps(result: CodexBridgeResult): string[] {
  const quotedDir = "'" + result.pluginDir.replace(/'/g, "'\"'\"'") + "'"
  return [
    `  codex -C ${quotedDir}`,
    ...(result.plugin.orchestratorName
      ? [`  Ask Codex to delegate the task to the ${result.plugin.orchestratorName} subagent.`]
      : [])
  ]
}

function renderMarketplace(plugin: CodexPlugin): string {
  return `${JSON.stringify({
    name: marketplaceName(plugin.pluginName),
    plugins: [{
      name: plugin.pluginName,
      source: { source: "local", path: "./" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools"
    }]
  }, null, 2)}\n`
}

function renderManifest(plugin: CodexPlugin, emitSkills: boolean, emitMcp: boolean): string {
  const manifest: Record<string, unknown> = {
    name: plugin.pluginName,
    version: "1.0.0",
    description: "Codex workflows translated from an OpenCode pack.",
    author: { name: authorName() },
    interface: {
      displayName: plugin.pluginName,
      shortDescription: "Workflows translated from an OpenCode pack.",
      developerName: authorName(),
      category: "Developer Tools",
      capabilities: [...(emitSkills ? ["Skills"] : []), ...(emitMcp ? ["MCP"] : [])],
      ...(emitSkills ? { defaultPrompt: ["Use the translated skills for this task."] } : {})
    }
  }
  if (emitSkills) manifest.skills = `./${PROJECT_SKILLS_DIR}/`
  if (emitMcp) manifest.mcpServers = "./.mcp.json"
  return `${JSON.stringify(manifest, null, 2)}\n`
}

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

type CodexMcpServer = Record<string, string | string[] | Record<string, string> | number>
type CodexMcpConfig = { mcpServers: Record<string, CodexMcpServer> }

const envReference = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/

function translateMcpServer(name: string, server: Record<string, any>, warnings: string[]): CodexMcpServer | null {
  if (typeof server.url === "string" && server.url.trim()) {
    const translated: CodexMcpServer = { url: server.url }
    const headers: Array<[string, string]> = []
    const envHeaders: Array<[string, string]> = []
    for (const [header, value] of Object.entries(server.headers ?? {})) {
      if (typeof value !== "string") continue
      const ref = envReference.exec(value)
      if (!ref) headers.push([header, value])
      else if (value === ref[0]) envHeaders.push([header, ref[1]])
      else if (header.toLowerCase() === "authorization" && value === `Bearer ${ref[0]}`) {
        translated.bearer_token_env_var = ref[1]
      } else {
        warnings.push(`[mcp] '${name}' header '${header}' needs manual setup; Codex accepts literals or a single environment variable`)
      }
    }
    if (headers.length) translated.http_headers = Object.fromEntries(headers)
    if (envHeaders.length) translated.env_http_headers = Object.fromEntries(envHeaders)
    return translated
  }

  const commandParts = Array.isArray(server.command)
    ? server.command.map(String)
    : typeof server.command === "string" ? server.command.trim().split(/\s+/) : []
  const [command, ...args] = commandParts
  if (!command) return null
  const translated: CodexMcpServer = { command, ...(args.length ? { args } : {}) }
  const env: Array<[string, string]> = []
  const envVars: string[] = []
  for (const [key, value] of Object.entries(server.environment ?? {})) {
    const literal = String(value)
    const ref = envReference.exec(literal)
    if (!ref) env.push([key, literal])
    else {
      envVars.push(key)
      if (key !== ref[1] || literal !== ref[0]) {
        warnings.push(`[mcp] '${name}' requires '${key}' to be exported with the value configured in OpenCode before launching Codex`)
      }
    }
  }
  if (env.length) translated.env = Object.fromEntries(env)
  if (envVars.length) translated.env_vars = envVars
  return translated
}

function buildCodexMcpConfig(
  source: Record<string, Record<string, any>>,
  agents: AgentInfo[],
  customTools: ReadonlySet<string>,
  serverNames: string[],
  warnings: string[]
): CodexMcpConfig | null {
  const required = new Set(agents.flatMap(agent => agentMcpServers(agent, customTools, serverNames)))
  const denied = new Map<string, Set<string>>()
  for (const agent of agents) {
    for (const [key, value] of Object.entries(agentPermissions(agent))) {
      if (!isMcpPermissionKey(key, customTools) || (value !== "deny" && value !== false)) continue
      const server = mcpServerForPermission(key, serverNames)
      if (!Object.hasOwn(source, server)) continue
      const tools = denied.get(server) ?? new Set<string>()
      tools.add(key.slice(server.length + 1))
      denied.set(server, tools)
    }
  }

  const servers: Array<[string, CodexMcpServer]> = []
  for (const [name, server] of Object.entries(source)) {
    if (isServerDisabled(server) && !required.has(name)) continue
    const toolDenies = [...(denied.get(name) ?? [])].sort()
    // Codex matches exact tool names. A deny pattern needs a server-wide restriction.
    if (toolDenies.some(tool => /[*?\[]/.test(tool))) {
      if (required.has(name)) {
        throw new Error(`MCP server '${name}' is required by translated agents but has a deny pattern Codex cannot enforce; refusing to emit the server`)
      }
      warnings.push(`[mcp] omitted server '${name}' because Codex cannot enforce its deny pattern`)
      continue
    }
    const translated = translateMcpServer(name, server, warnings)
    if (!translated) {
      warnings.push(`[mcp] omitted server '${name}' with no URL or command`)
      continue
    }
    if (isServerDisabled(server)) warnings.push(`[mcp] disabled server '${name}' was emitted because translated agents require it`)
    if (toolDenies.length) {
      translated.disabled_tools = toolDenies
      warnings.push(`[mcp] tool denies for '${name}' apply to the entire Codex session`)
    }
    if (typeof server.timeout === "number" && Number.isFinite(server.timeout) && server.timeout > 0) {
      translated.tool_timeout_sec = server.timeout / 1000
    }
    servers.push([name, translated])
  }
  return servers.length ? { mcpServers: Object.fromEntries(servers) } : null
}

function renderProjectConfig(config: CodexMcpConfig | null, nestedDelegation: boolean): string {
  const sections = Object.entries(config?.mcpServers ?? {}).map(([name, server]) => [
    `[mcp_servers.${tomlString(name)}]`,
    ...Object.entries(server).map(([key, value]) => {
      const rendered = typeof value === "string" ? tomlString(value)
        : typeof value === "number" ? String(value)
        : Array.isArray(value) ? `[${value.map(tomlString).join(", ")}]`
        : `{ ${Object.entries(value).map(([entry, text]) => `${tomlString(entry)} = ${tomlString(text)}`).join(", ")} }`
      return `${key} = ${rendered}`
    }),
    ""
  ].join("\n"))
  // The primary agent runs at depth one and delegates to peers at depth two.
  if (nestedDelegation) sections.unshift("[agents]\nmax_depth = 2\n")
  return sections.join("\n")
}

function renderCodexMcpSetup(config: CodexMcpConfig | null): string[] {
  const servers = config?.mcpServers
  if (!servers || typeof servers !== "object") return []
  const lines = [
    "## MCP setup",
    "",
    "`npx` servers are fetched on first use. Binary servers must already be available on `PATH`.",
    ""
  ]
  for (const [name, value] of Object.entries(servers)) {
    const command = String(value.command || "")
    const args = Array.isArray(value.args) ? value.args.map(String) : []
    const remoteUrl = typeof value.url === "string" ? value.url.trim() : ""
    let setup = remoteUrl && !command
      ? `verify connectivity and authentication for ${markdownCode(remoteUrl)}`
      : command === "npx"
        ? `runs as ${markdownCode([command, ...args].join(" "))} (Node.js, npm, and network required)`
        : `make ${markdownCode(command)} available on \`PATH\``
    const envKeys = new Set([
      ...(Array.isArray(value.env_vars) ? value.env_vars : []),
      ...Object.values(value.env_http_headers ?? {}),
      ...(typeof value.bearer_token_env_var === "string" ? [value.bearer_token_env_var] : [])
    ])
    if (envKeys.size > 0) setup += `, with ${[...envKeys].map(markdownCode).join(", ")} exported before launch`
    lines.push(`- ${markdownCode(name)} needs this setup. ${setup[0].toUpperCase() + setup.slice(1)}.`)
  }
  lines.push("", "Verify the resulting connections from Codex before invoking MCP-dependent agents.", "")
  return lines
}

function renderReadme(plugin: CodexPlugin, warnings: string[], mcpConfig: CodexMcpConfig | null, bashAllowlists: BashAllowlist[] = []): string {
  const lines = [
    `# ${plugin.pluginName}`,
    "",
    "This directory is a generated translation layer from the canonical source agents. Source agents are unchanged.",
    "",
    "> **Generated output.** Do not edit this directory directly. Change the pack's agents or `bridges/translation-config.json`, then regenerate with the manager.",
    "",
    "## Source and configuration",
    "",
    `Agent prompts come from the bridged pack. Translation roles, tiers, model overrides, prefix, and output options come from ${markdownCode("bridges/translation-config.json")}; MCP declarations are merged from the ${markdownCode("opencode.json")} of the pack and the packs it requires.`,
    "",
    "## Run in Codex",
    "",
    "From this directory, run \`codex\` and trust the project to load its local configuration, or open this directory in the Codex app.",
    plugin.orchestratorName ? `Ask Codex to delegate the task to the ${markdownCode(plugin.orchestratorName)} subagent.` : "",
    "",
    "- `.codex/agents/` contains project-scoped subagent definitions.",
    mcpConfig ? "- `.codex/config.toml` configures MCP for the project. Run `codex mcp list` here to inspect it." : "",
    plugin.skills.length > 0 ? "- `.agents/skills/` contains translated agent prompts available as skills in this project." : "",
    ...(plugin.skills.length > 0 || mcpConfig ? [
      "",
      "## Install the plugin separately",
      "",
      "To use the plugin's packaged skills or MCP servers in other projects, run these commands from this directory:",
      "",
      "\`\`\`sh",
      "codex plugin marketplace add .",
      `codex plugin add ${plugin.pluginName}@${marketplaceName(plugin.pluginName)}`,
      "\`\`\`",
      "",
      "Custom subagents are project-scoped. To use them in another project, copy the relevant TOML files from `.codex/agents/` into that project's `.codex/agents/`.",
    ] : []),
    "",
    "OpenCode tool names in prompts are translated where Codex has an equivalent (`todowrite` → `update_plan`). Prompts that rely on custom tools shipped by the pack start with a runtime note saying they are unavailable here and that the documented fallbacks apply.",
    "",
    ...renderCodexMcpSetup(mcpConfig),
    ...renderBashAllowlistSection("codex", bashAllowlists),
    ""
  ]
  if (warnings.length > 0) {
    lines.push("## Translation warnings", "", ...warnings.map(warning => `- ${warning}`), "")
  }
  return lines.filter((line, index) => !(line === "" && lines[index - 1] === "")).join("\n")
}

/**
 * Write a Codex translation layer without modifying source agents.
 *
 * Output layout:
 *   <output>/.codex-plugin/plugin.json
 *   <output>/.codex/agents/*.toml
 *   <output>/.codex/config.toml (MCP and delegation settings)
 *   <output>/.agents/skills/<agent>/SKILL.md (optional)
 */
export function writeCodexPlugin(
  agents: AgentInfo[],
  pluginName: string,
  prefix: string,
  outputDir: string,
  workspaceRoot: string,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG,
  resolvedTargets?: ReadonlyMap<string, ResolvedModelTarget>
): CodexBridgeResult {
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error(`Cannot generate Codex bridge "${pluginName}": no agents provided.`)
  }
  if (typeof workspaceRoot !== "string" || !workspaceRoot) {
    throw new Error("writeCodexPlugin requires a workspaceRoot")
  }
  config = { ...config, prefix }
  const effectiveConfig = { ...config, prefix }
  const targets = resolvedTargets ?? resolveTargets(agents, effectiveConfig)
  const warnings: string[] = []
  for (const key of unusedModelMapKeys(agents, config, "codex")) {
    warnings.push(`[model-map] entry "${key}" matches no source agent model`)
  }
  const normalizedPluginName = pluginNameValue(pluginName)
  const customTools = new Set(toolModulePaths(workspaceRoot).map(toolModuleName))
  const mcpSource = config.codex.emitMcp === false ? {} : readBridgeMcpServers(workspaceRoot, warnings)
  const serverNames = Object.keys(mcpSource).sort((a, b) => b.length - a.length)
  const mcpConfig = buildCodexMcpConfig(mcpSource, agents, customTools, serverNames, warnings)
  const activeServers = serverNames.filter(name => Object.hasOwn(mcpConfig?.mcpServers ?? {}, name))
  const aliases = buildAgentAliasMap(agents, prefix)
  const translatedAgents = agents.map(agent => convertCodexAgent(agent, prefix, aliases, effectiveConfig, warnings, agents, targets, customTools, activeServers))
  const emitSkills = config.codex.emitSkills !== false
  const primary = agents.find(agent => agent.frontmatter.mode === "primary")
  const plugin: CodexPlugin = {
    pluginName: normalizedPluginName,
    agents: translatedAgents,
    skills: emitSkills ? translatedAgents.map(agent => agent.name) : [],
    orchestratorName: primary ? normalizeCodexAgentName(primary.filename, prefix) : translatedAgents.find(agent => agent.name === "orchestrator")?.name ?? null,
  }

  const preview = agents.map(agent => {
    const resolved = targets.get(agent.filename)!
    if (resolved.source === "inferred" || resolved.source === "default") warnings.push(`[${agent.filename}] model assignment source: ${resolved.source}`)
    return { agent: agent.filename, role: resolved.role, tier: resolved.tier, model: resolved.model.model, source: resolved.source, ...(resolved.inferredFrom ? { inferredFrom: resolved.inferredFrom } : {}) }
  })
  const pluginDir = realpathThroughExistingAncestor(path.resolve(outputDir))
  assertInsideRealWorkspace(workspaceRoot, pluginDir, outputDir)
  const artifacts = new Map<string, string>([
    [".codex-plugin/plugin.json", renderManifest(plugin, emitSkills, mcpConfig !== null)]
  ])
  if (emitSkills || mcpConfig) artifacts.set(".agents/plugins/marketplace.json", renderMarketplace(plugin))
  if (mcpConfig) artifacts.set(".mcp.json", `${JSON.stringify(mcpConfig, null, 2)}\n`)
  const projectConfig = renderProjectConfig(mcpConfig, plugin.orchestratorName !== null && translatedAgents.length > 1)
  if (projectConfig) artifacts.set(".codex/config.toml", projectConfig)
  for (const agent of translatedAgents) {
    artifacts.set(`.codex/agents/${agent.filename}`, renderCodexAgentToml(agent))
    if (emitSkills) artifacts.set(`${PROJECT_SKILLS_DIR}/${agent.name}/SKILL.md`, renderCodexSkill(agent))
  }

  if (config.codex.emitReadme !== false) {
    const bashAllowlists = agents
      .map((agent, index) => collectBashAllowlist(translatedAgents[index]?.name ?? agent.filename, agent.frontmatter))
      .filter((allowlist): allowlist is BashAllowlist => allowlist !== null)
    artifacts.set("README.md", renderReadme(plugin, warnings, mcpConfig, bashAllowlists))
  }

  const files: string[] = []
  for (const [relative, contents] of artifacts) {
    const file = path.join(pluginDir, relative)
    assertInsideRealWorkspace(workspaceRoot, realpathThroughExistingAncestor(file), file)
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Codex bridge file must not be a symlink: ${file}`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(path.dirname(file)), file)
    fs.writeFileSync(file, contents)
    files.push(file)
  }
  return { pluginDir, files, warnings, plugin, preview }
}

// Kept separate to make it easy for the configuration wizard to validate a
// name before any filesystem operation occurs.
export function pluginNameValue(value: string): string {
  return pluginName(value)
}

export function bridgeToCodex(
  agents: AgentInfo[],
  pluginNameInput: string,
  prefix: string,
  outputDir: string,
  workspaceRoot: string,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG
): CodexBridgeResult {
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error(`Cannot generate Codex bridge "${pluginNameInput}": no agents provided.`)
  }
  return writeCodexPlugin(agents, pluginNameInput, prefix, outputDir, workspaceRoot, config)
}
