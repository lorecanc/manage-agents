import fs from "node:fs"
import path from "node:path"
import { atomicWriteRestrictedFile, discoverAgentResources, parseAgentFile, type AgentInfo } from "./agents.js"
import { packDir, readManifest } from "./catalog.js"
import { hasErrors, MANIFEST_FILE, validatePack } from "./packs.js"
import {
  isDelegationEffect,
  isFlowTrigger,
  isModelRef,
  isPolicyEffect,
  isResourceKey,
  isTrigger,
  own,
  setOwn,
  WILDCARD_TRIGGER,
  type ConditionalRule,
  type DelegationEffect,
  type PolicyEffect,
} from "./values.js"
import { scanLooseAgentFiles } from "./virtualPacks.js"

// Model routing and conditional IF/OR flows of packs.
//
// Legacy `describeArchetype` / `setArchetypeConfig` operate on packs that already declare `archetype` in
// `opencode-pack.json`. `describePackFlows` and `exportFlowsToPackManifest` generalize this to ANY pack (including
// packs without `archetype`, such as `slides`, and virtual `.md` folders without `opencode-pack.json`).

export const INHERIT = "inherit"

/** role -> "provider/model#variant" | "inherit" */
export type RoleModels = Record<string, string>
export interface ArchetypeAgent {
  role: string
  name: string
  subagent: boolean
  model?: string
}
export interface ArchetypeView {
  id: string
  reference: ArchetypeAgent
  /** Primaries whose model picks the configuration: the reference first. */
  callers: ArchetypeAgent[]
  /** Subagents a configuration can set: subagents without a fixed model. */
  related: ArchetypeAgent[]
  /** Subagents with a fixed model: configurations skip them. */
  pinned: ArchetypeAgent[]
  configs: Record<string, RoleModels>
}

export interface UnifiedFlowItem {
  /** Stable identifier inside the modal ("route:<trigger>", "pack-rule:<i>", "global-rule:<i>", or "user-rule:<i>"). */
  key: string
  origin: "pack" | "global" | "user"
  kind: "route" | "rule"
  ruleIndex?: number
  callers?: string[]
  triggers: string[]
  roles: RoleModels
  tools: Record<string, PolicyEffect>
  permissions: Record<string, PolicyEffect>
  delegations: Record<string, DelegationEffect>
}

export interface FlowResourceOption {
  key: string
  label: string
  group: "builtin" | "tool-family" | "tool" | "mcp"
  staticallyDeniedByCaller: boolean
}

export interface PackFlowsView {
  id: string
  dir: string
  hasManifest: boolean
  callerSource: "user" | "manifest" | "inferred"
  allAgents: ArchetypeAgent[]
  callerCandidates: ArchetypeAgent[]
  callers: ArchetypeAgent[]
  reference: ArchetypeAgent | null
  related: ArchetypeAgent[]
  pinned: ArchetypeAgent[]
  subagents: ArchetypeAgent[]
  availableTools: FlowResourceOption[]
  staticDeniedTools: Set<string>
  staticDeniedDelegations: Set<string>
  flows: UnifiedFlowItem[]
}

export function isRoutableArchetype(workspaceRoot: string, id: string | undefined | null): id is string {
  if (typeof id !== "string") return false
  const dir = packDir(workspaceRoot, id)
  if (!dir || !fs.existsSync(path.join(dir, MANIFEST_FILE))) return false
  try {
    return Boolean(readManifest(dir).archetype)
  } catch {
    return false
  }
}

/** True for any pack or virtual `.md` folder in the workspace that has at least one discovered agent. */
export function isConfigurablePack(workspaceRoot: string, id: string | undefined | null): id is string {
  if (typeof id !== "string") return false
  const dir = packDir(workspaceRoot, id)
  if (!dir) return false
  return discoverPackAgentEntries(workspaceRoot, id, dir, []).length > 0
}

export const roleOfPackAgent = (pack: string, agent: string) => (agent.startsWith(`${pack}-`) ? agent.slice(pack.length + 1) : agent)

interface ParsedPackAgentEntry {
  info: AgentInfo
  mode?: string
  item: ArchetypeAgent
}

function discoverPackAgentEntries(
  workspaceRoot: string,
  id: string,
  dir: string,
  callers: string[],
  contentTransform?: (filePath: string, rawContent: string) => string,
): ParsedPackAgentEntry[] {
  const entries: Array<{ fullPath: string; agentId: string; defaultPrimary?: boolean }> = []
  const agentsDir = path.join(dir, "agents")
  if (fs.existsSync(agentsDir) && !fs.lstatSync(agentsDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    for (const file of (fs.readdirSync(agentsDir, { recursive: true }) as string[]).map(f => f.split(path.sep).join("/")).filter(f => f.endsWith(".md") && !/\.test\.[^/]+$/i.test(f)).sort()) {
      const fullPath = path.join(agentsDir, file)
      if (fs.lstatSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
        entries.push({ fullPath, agentId: file.slice(0, -3) })
      }
    }
  }
  if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) {
    const seen = new Set(entries.map(item => path.resolve(item.fullPath)))
    for (const loose of scanLooseAgentFiles(dir).agents) {
      const fullPath = path.join(dir, ...loose.sourceRel.split("/"))
      if (seen.has(path.resolve(fullPath))) continue
      entries.push({
        fullPath,
        agentId: loose.id,
        defaultPrimary: loose.containerKind === "mode" || loose.containerKind === "modes",
      })
      seen.add(path.resolve(fullPath))
    }
  }

  return entries.sort((a, b) => a.agentId.localeCompare(b.agentId)).flatMap(({ fullPath, agentId, defaultPrimary }) => {
    const raw = contentTransform ? contentTransform(fullPath, fs.readFileSync(fullPath, "utf8")) : undefined
    const parsed = parseAgentFile(fullPath, workspaceRoot, raw)
    if (!parsed) return []
    if (defaultPrimary && !parsed.frontmatter.mode) parsed.frontmatter.mode = "primary"
    const mode = typeof parsed.frontmatter.mode === "string" ? parsed.frontmatter.mode : undefined
    const model = typeof parsed.frontmatter.model === "string" && parsed.frontmatter.model ? parsed.frontmatter.model : undefined
    return [{
      info: parsed,
      ...(mode ? { mode } : {}),
      item: {
        role: roleOfPackAgent(id, agentId),
        name: agentId,
        subagent: !callers.includes(agentId) && mode !== "primary",
        ...(model ? { model } : {}),
      },
    }]
  })
}

function archetypeAgents(
  workspaceRoot: string,
  id: string,
  dir: string,
  callers: string[],
  contentTransform?: (filePath: string, rawContent: string) => string,
): ArchetypeAgent[] {
  return discoverPackAgentEntries(workspaceRoot, id, dir, callers, contentTransform).map(entry => entry.item)
}

export interface DescribeArchetypeOptions {
  contentTransform?: (filePath: string, rawContent: string) => string
  routeLayers?: Array<Record<string, Record<string, string>> | undefined>
}

/** Everything the TUI shows for an archetype pack; null when the pack declares no archetype. */
export function describeArchetype(workspaceRoot: string, id: string, options: DescribeArchetypeOptions = {}): ArchetypeView | null {
  const dir = packDir(workspaceRoot, id)
  if (!dir || !fs.existsSync(path.join(dir, MANIFEST_FILE))) return null
  const manifest = readManifest(dir)
  if (!manifest.archetype) return null
  const callerIds: string[] = manifest.archetype.callers ?? []
  const agents = archetypeAgents(workspaceRoot, id, dir, callerIds, options.contentTransform)
  const reference = agents.find(agent => agent.name === manifest.archetype.reference)
  if (!reference) return null
  const subagents = agents.filter(agent => agent.subagent)
  const routableNames = new Set(subagents.filter(agent => !agent.model).map(agent => agent.name))
  const configs: Record<string, RoleModels> = {}
  const layers = [manifest.routingDefaults as Record<string, Record<string, string>> | undefined, ...(options.routeLayers ?? [])]
  for (const layer of layers) {
    for (const [trigger, routed] of Object.entries<Record<string, string>>(layer ?? {})) {
      const roles: RoleModels = { ...(configs[trigger] ?? {}) }
      for (const [agent, model] of Object.entries(routed)) {
        if (!options.routeLayers || routableNames.has(agent)) setOwn(roles, roleOfPackAgent(id, agent), model)
      }
      setOwn(configs, trigger, roles)
    }
  }
  return {
    id,
    reference,
    callers: [reference, ...agents.filter(agent => callerIds.includes(agent.name) && agent !== reference)],
    related: subagents.filter(agent => !agent.model),
    pinned: subagents.filter(agent => agent.model),
    configs,
  }
}

/** "flow-build or flow-plan": the primaries a configuration's trigger refers to. */
export function callersLabel(view: { callers: ArchetypeAgent[] }): string {
  const names = view.callers.map(agent => agent.name)
  if (names.length === 0) return "(no caller selected)"
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]
}

function collectStaticDenials(agentInfos: AgentInfo[]): { tools: Set<string>; delegations: Set<string> } {
  const tools = new Set<string>()
  const delegations = new Set<string>()
  const isPlain = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)
  for (const agent of agentInfos) {
    const fm = agent.frontmatter ?? {}
    // V2 array permissions: [{ action, resource, effect: "deny" }]
    if (Array.isArray(fm.permissions)) {
      for (const rule of fm.permissions) {
        if (!isPlain(rule) || rule.effect !== "deny" || typeof rule.action !== "string") continue
        if (rule.action === "subagent" || rule.action === "task") {
          if (typeof rule.resource === "string") delegations.add(rule.resource)
        } else if (rule.resource === "*" || rule.resource === undefined) {
          tools.add(rule.action)
        }
      }
    } else if (isPlain(fm.permissions)) {
      for (const [key, val] of Object.entries(fm.permissions)) {
        if (val === "deny" || val === false) tools.add(key)
        else if ((key === "subagent" || key === "task") && isPlain(val)) {
          for (const [sub, subVal] of Object.entries(val)) if (subVal === "deny" || subVal === false) delegations.add(sub)
        }
      }
    }
    if (isPlain(fm.permission)) {
      for (const [key, val] of Object.entries(fm.permission)) {
        if (val === "deny" || val === false) {
          tools.add(key)
          if (key === "shell") tools.add("bash")
          if (key === "bash") tools.add("shell")
        }
        else if ((key === "subagent" || key === "task") && isPlain(val)) {
          for (const [sub, subVal] of Object.entries(val)) if (subVal === "deny" || subVal === false) delegations.add(sub)
        }
      }
    }
  }
  return { tools, delegations }
}

const BUILTIN_FLOW_TOOLS: Array<{ key: string; label: string }> = [
  { key: "bash", label: "bash (shell execution)" },
  { key: "edit", label: "edit (modify files)" },
  { key: "write", label: "write (create/overwrite files)" },
  { key: "webfetch", label: "webfetch (HTTP fetch)" },
  { key: "websearch", label: "websearch (web search)" },
]

export interface DescribePackFlowsOptions {
  contentTransform?: (filePath: string, rawContent: string) => string
  userCallers?: string[]
  userReference?: string
  routeLayers?: Array<Record<string, Record<string, string>> | undefined>
  globalRules?: ConditionalRule[]
  userRules?: ConditionalRule[]
  env?: NodeJS.ProcessEnv
}

/**
 * Pack-independent view of callers, subagents, tools/MCPs and conditional IF/OR flows for ANY pack or virtual `.md`
 * folder in the workspace, whether or not `opencode-pack.json` declares `archetype`.
 */
export function describePackFlows(
  workspaceRoot: string,
  id: string,
  options: DescribePackFlowsOptions = {},
): PackFlowsView | null {
  const dir = packDir(workspaceRoot, id)
  if (!dir) return null
  const hasManifest = fs.existsSync(path.join(dir, MANIFEST_FILE))
  const manifest = readManifest(dir)
  const baseEntries = discoverPackAgentEntries(workspaceRoot, id, dir, [], options.contentTransform)
  if (!baseEntries.length) return null

  const byName = new Map(baseEntries.map(entry => [entry.item.name, entry]))
  const manifestCallers: string[] | undefined = Array.isArray(manifest.archetype?.callers) ? manifest.archetype.callers : undefined
  let callerSource: PackFlowsView["callerSource"] = "inferred"
  let chosenCallerIds: string[] = []
  if (options.userCallers?.length) {
    chosenCallerIds = options.userCallers.filter(name => byName.has(name) && byName.get(name)!.mode !== "subagent")
    callerSource = "user"
  } else if (manifestCallers?.length) {
    chosenCallerIds = manifestCallers.filter(name => byName.has(name) && byName.get(name)!.mode !== "subagent")
    callerSource = "manifest"
  }
  if (!chosenCallerIds.length) {
    callerSource = "inferred"
    const primaries = baseEntries.filter(e => e.mode === "primary").map(e => e.item.name)
    const nonSubagents = baseEntries.filter(e => e.mode !== "subagent").map(e => e.item.name)
    chosenCallerIds = primaries.length ? primaries : nonSubagents.length ? nonSubagents : [baseEntries[0].item.name]
  }

  const allEntries = discoverPackAgentEntries(workspaceRoot, id, dir, chosenCallerIds, options.contentTransform)
  const allAgents = allEntries.map(e => e.item)
  const modeOf = new Map(allEntries.map(e => [e.item.name, e.mode]))
  const callerCandidates = allAgents.filter(agent => modeOf.get(agent.name) !== "subagent")
  const effectiveCandidates = callerCandidates.length ? callerCandidates : allAgents
  const refId = options.userReference ?? manifest.archetype?.reference ?? chosenCallerIds[0]
  const reference = allAgents.find(a => a.name === refId && chosenCallerIds.includes(a.name))
    ?? allAgents.find(a => chosenCallerIds.includes(a.name))
    ?? null
  const callers = [
    ...(reference ? [reference] : []),
    ...allAgents.filter(a => chosenCallerIds.includes(a.name) && a !== reference),
  ]
  const subagents = allAgents.filter(a => !chosenCallerIds.includes(a.name) && modeOf.get(a.name) !== "primary")
  const related = subagents.filter(a => !a.model)
  const pinned = subagents.filter(a => Boolean(a.model))
  const routableNames = new Set(related.map(a => a.name))

  const callerInfos = allEntries.filter(e => chosenCallerIds.includes(e.item.name)).map(e => e.info)
  const { tools: staticDeniedTools, delegations: staticDeniedDelegations } = collectStaticDenials(callerInfos)

  const availableTools: FlowResourceOption[] = BUILTIN_FLOW_TOOLS.map(tool => ({
    key: tool.key,
    label: tool.label,
    group: "builtin",
    staticallyDeniedByCaller: staticDeniedTools.has(tool.key) || staticDeniedTools.has("*"),
  }))
  const seenKeys = new Set(availableTools.map(item => item.key))
  if (callerInfos[0]) {
    try {
      const resCatalog = discoverAgentResources(workspaceRoot, callerInfos[0], allEntries.map(e => e.info), options.env)
      for (const item of [...resCatalog.tools, ...resCatalog.mcpServers]) {
        if (seenKeys.has(item.permissionKey)) continue
        seenKeys.add(item.permissionKey)
        availableTools.push({
          key: item.permissionKey,
          label: item.kind === "mcp" ? `${item.permissionKey} (MCP server)` : item.name,
          group: item.kind === "mcp" ? "mcp" : item.kind === "tool-family" ? "tool-family" : "tool",
          staticallyDeniedByCaller: staticDeniedTools.has(item.permissionKey) || staticDeniedTools.has("*"),
        })
      }
    } catch {
      /* optional resource catalog */
    }
  }

  // Build unified flows: first merged routes, then pack flowDefaults, then user $rules
  const flows: UnifiedFlowItem[] = []
  const mergedRoutes: Record<string, RoleModels> = {}
  const routeOrigins = new Map<string, "pack" | "user">()
  const manifestRoutes = (manifest.routingDefaults ?? {}) as Record<string, Record<string, string>>
  for (const [trigger, routed] of Object.entries(manifestRoutes)) {
    const roles: RoleModels = {}
    for (const [agent, model] of Object.entries(routed)) {
      if (routableNames.has(agent)) setOwn(roles, roleOfPackAgent(id, agent), model)
    }
    if (Object.keys(roles).length) {
      setOwn(mergedRoutes, trigger, roles)
      routeOrigins.set(trigger, "pack")
    }
  }
  for (const layer of options.routeLayers ?? []) {
    for (const key of Object.getOwnPropertyNames(layer ?? {})) {
      const routed = own(layer, key)
      if (!routed) continue
      const roles: RoleModels = { ...(own(mergedRoutes, key) ?? {}) }
      for (const [agent, model] of Object.entries(routed)) {
        if (routableNames.has(agent)) setOwn(roles, roleOfPackAgent(id, agent), model)
      }
      setOwn(mergedRoutes, key, roles)
      routeOrigins.set(key, "user")
    }
  }
  for (const trigger of Object.keys(mergedRoutes).sort()) {
    flows.push({
      key: `route:${trigger}`,
      origin: routeOrigins.get(trigger) ?? "user",
      kind: "route",
      triggers: [trigger],
      roles: mergedRoutes[trigger],
      tools: {},
      permissions: {},
      delegations: {},
    })
  }

  const mapRuleToFlow = (rule: ConditionalRule, origin: "pack" | "global" | "user", index: number): UnifiedFlowItem => {
    const roles: RoleModels = {}
    for (const [agent, model] of Object.entries(rule.then.models ?? {})) {
      if (routableNames.has(agent)) setOwn(roles, roleOfPackAgent(id, agent), model)
    }
    return {
      key: `${origin}-rule:${index}`,
      origin,
      kind: "rule",
      ruleIndex: index,
      ...(rule.callers ? { callers: [...rule.callers] } : {}),
      triggers: [...rule.triggers],
      roles,
      tools: { ...(rule.then.tools ?? {}) },
      permissions: { ...(rule.then.permissions ?? {}) },
      delegations: { ...(rule.then.delegations ?? {}) },
    }
  }

  const packFlowDefaults: ConditionalRule[] = Array.isArray(manifest.flowDefaults) ? manifest.flowDefaults : []
  packFlowDefaults.forEach((rule, index) => flows.push(mapRuleToFlow(rule, "pack", index)))
  ;(options.globalRules ?? []).forEach((rule, index) => flows.push(mapRuleToFlow(rule, "global", index)))
  ;(options.userRules ?? []).forEach((rule, index) => flows.push(mapRuleToFlow(rule, "user", index)))

  return {
    id,
    dir,
    hasManifest,
    callerSource,
    allAgents,
    callerCandidates: effectiveCandidates,
    callers,
    reference,
    related,
    pinned,
    subagents,
    availableTools,
    staticDeniedTools,
    staticDeniedDelegations,
    flows,
  }
}

/**
 * Add, replace (`roles`) or remove (`null`) one configuration in the pack's routingDefaults, then validate the pack.
 * `previousTrigger` renames a configuration whose trigger was changed in the editor. Returns the manifest path.
 */
export function setArchetypeConfig(workspaceRoot: string, id: string, trigger: string, roles: RoleModels | null, options: { previousTrigger?: string } = {}): string {
  const view = describeArchetype(workspaceRoot, id)
  const dir = packDir(workspaceRoot, id)
  if (!view || !dir) throw new Error(`'${id}' is not an archetype pack of this catalog`)
  if (!isTrigger(trigger)) throw new Error(`the trigger must be "provider" or "provider/model"; got '${trigger}'`)
  const configs = { ...view.configs }
  if (roles === null) {
    if (!Object.hasOwn(configs, trigger)) throw new Error(`No configuration '${trigger}' in ${id}`)
    delete configs[trigger]
  } else {
    if (options.previousTrigger && options.previousTrigger !== trigger) {
      if (Object.hasOwn(configs, trigger)) throw new Error(`${id} already has a configuration for '${trigger}'`)
      delete configs[options.previousTrigger]
    }
    for (const [role, model] of Object.entries(roles)) {
      if (model !== INHERIT && !isModelRef(model)) throw new Error(`${role}: '${model}' is not "inherit" or provider/model[#variant]`)
      if (!view.related.some(agent => agent.role === role)) throw new Error(`${role}: not a routable subagent of ${id}${view.pinned.some(agent => agent.role === role) ? " (it has a fixed model)" : ""}`)
    }
    setOwn(configs, trigger, roles)
  }
  const nameOf = (role: string) => view.related.find(agent => agent.role === role)?.name ?? role
  const routingDefaults: Record<string, Record<string, string>> = {}
  for (const currentTrigger of Object.keys(configs).sort()) {
    const entries = Object.entries(configs[currentTrigger]).map(([role, model]) => [nameOf(role), model] as const).sort(([a], [b]) => a.localeCompare(b))
    if (entries.length) setOwn(routingDefaults, currentTrigger, Object.fromEntries(entries))
  }
  const file = path.join(dir, MANIFEST_FILE)
  const before = fs.readFileSync(file, "utf8")
  const manifest = JSON.parse(before)
  if (Object.keys(routingDefaults).length) manifest.routingDefaults = routingDefaults
  else delete manifest.routingDefaults
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  const validation = validatePack(dir)
  if (hasErrors(validation)) {
    fs.writeFileSync(file, before)
    throw new Error(`Configuration rejected:\n${validation.issues.filter(issue => issue.level === "error").map(issue => `  - ${issue.message}`).join("\n")}`)
  }
  return file
}

/**
 * Exports a pack's active callers, single-trigger model routes (`routingDefaults`) and conditional IF/OR rules
 * (`flowDefaults`, bumping contract to 1.1 when needed) into its local `opencode-pack.json`, then validates the pack.
 */
export function exportFlowsToPackManifest(workspaceRoot: string, view: PackFlowsView): string {
  const file = path.join(view.dir, MANIFEST_FILE)
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat) {
    throw new Error(`${view.id} has no ${MANIFEST_FILE} yet; initialize the pack manifest first (press [I] or run \`manage-agents pack init\`).`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing to write non-regular or symlinked manifest: ${file}`)
  }
  const validCandidateSet = new Set(view.callerCandidates.map(c => c.name))
  const primaryCallers = view.callers.filter(c => validCandidateSet.has(c.name)).map(c => c.name)
  if (!primaryCallers.length) {
    throw new Error(`Cannot export archetype to ${MANIFEST_FILE}: at least one non-subagent caller is required by the pack contract.`)
  }
  const nameOf = (role: string) => view.related.find(agent => agent.role === role)?.name ?? role
  const routingDefaults: Record<string, Record<string, string>> = {}
  const flowDefaults: ConditionalRule[] = []

  for (const flow of view.flows) {
    const hasExtraPolicies =
      Boolean(flow.callers?.length) ||
      Object.keys(flow.tools).length > 0 ||
      Object.keys(flow.permissions).length > 0 ||
      Object.keys(flow.delegations).length > 0
    const isSinglePlainTrigger = flow.triggers.length === 1 && flow.triggers[0] !== WILDCARD_TRIGGER && isTrigger(flow.triggers[0])
    const modelEntries = Object.entries(flow.roles)
      .filter(([role, model]) => view.related.some(a => a.role === role) && (model === INHERIT || isModelRef(model)))
      .map(([role, model]) => [nameOf(role), model] as const)
      .sort(([a], [b]) => a.localeCompare(b))

    if (isSinglePlainTrigger && !hasExtraPolicies) {
      if (modelEntries.length) setOwn(routingDefaults, flow.triggers[0], Object.fromEntries(modelEntries))
      continue
    }

    const then: ConditionalRule["then"] = {}
    if (modelEntries.length) then.models = Object.fromEntries(modelEntries)
    if (Object.keys(flow.tools).length) then.tools = { ...flow.tools }
    if (Object.keys(flow.permissions).length) then.permissions = { ...flow.permissions }
    if (Object.keys(flow.delegations).length) {
      const validDelegations = Object.entries(flow.delegations).filter(([k]) => k === "*" || view.subagents.some(s => s.name === k))
      if (validDelegations.length) then.delegations = Object.fromEntries(validDelegations)
    }
    if (!then.models && !then.tools && !then.permissions && !then.delegations) continue
    flowDefaults.push({
      ...(flow.callers?.length ? { callers: flow.callers.filter(c => view.callerCandidates.some(cand => cand.name === c)) } : {}),
      triggers: flow.triggers.filter(isFlowTrigger),
      then,
    })
  }

  const before = fs.readFileSync(file, "utf8")
  const manifest = JSON.parse(before)
  manifest.archetype = { callers: primaryCallers, reference: primaryCallers[0] }
  if (Object.keys(routingDefaults).length) manifest.routingDefaults = routingDefaults
  else delete manifest.routingDefaults
  if (flowDefaults.length) {
    manifest.flowDefaults = flowDefaults
    if (manifest.contract === "1.0") manifest.contract = "1.1"
  } else {
    delete manifest.flowDefaults
  }

  atomicWriteRestrictedFile(file, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), 0o644)
  const validation = validatePack(view.dir)
  if (hasErrors(validation)) {
    atomicWriteRestrictedFile(file, Buffer.from(before, "utf8"), 0o644)
    throw new Error(`Manifest export rejected:\n${validation.issues.filter(issue => issue.level === "error").map(issue => `  - ${issue.message}`).join("\n")}`)
  }
  return file
}

export { isDelegationEffect, isFlowTrigger, isPolicyEffect, isResourceKey }
