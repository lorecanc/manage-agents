import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import YAML from "yaml"
import {
  composeModelVariant,
  extractFrontmatter,
  findAgentFiles,
  packNameOf,
  renderAgentFile,
  type AgentInfo,
  type AgentList,
  type ModelRepairMapping,
  type saveAgentFile,
} from "./agents.js"
import {
  describeArchetype,
  describePackFlows,
  INHERIT,
  type ArchetypeView,
  type PackFlowsView,
  type RoleModels,
} from "./archetypes.js"
import { describeChangeResult } from "./changeReport.js"
import { packDir, readManifest } from "./catalog.js"
import { changeTarget, reconcileChange, type ChangeResult } from "./installer.js"
import { defaultTarget, readLock } from "./lock.js"
import { MANIFEST_FILE } from "./packs.js"
import { realpathThroughExistingAncestor } from "./pathValidation.js"
import { engineCacheDir, engineConfigDir, loadSources } from "./sources.js"
import {
  AGENT_FIELDS,
  effectiveOverrides,
  loadOverrideSettings,
  loadRoutingSettings,
  patchFrontmatter,
  routesOfEntry,
  saveOverrideSettings,
  saveRoutingSettings,
  scopeOf,
  setOverride,
  setPackCallers,
  setPackRules,
  setRoutes,
  unsetOverride,
  unsetRoutes,
  type FieldPatch,
} from "./userSettings.js"
import { detectFrontmatterVersion, translateFrontmatterV1ToV2 } from "./v2Compat.js"
import {
  isFlowTrigger,
  isModelRef,
  isTrigger,
  own,
  setOwn,
  WILDCARD_TRIGGER,
  type ConditionalRule,
  type DelegationEffect,
  type PolicyEffect,
} from "./values.js"
import { scanLooseAgentFiles } from "./virtualPacks.js"

export function resolvedDefaultTarget(env: NodeJS.ProcessEnv = process.env): string {
  return realpathThroughExistingAncestor(path.resolve(defaultTarget(env)))
}

export function agentPackIdentity(workspaceRoot: string, filePath: string): { pack: string; id: string } {
  const pack = packNameOf(filePath, workspaceRoot)
  const dir = pack ? packDir(workspaceRoot, pack) : null
  if (!pack || !dir) {
    throw new Error(`${path.basename(filePath)} does not belong to a pack manifest (opencode-pack.json)`)
  }
  const rel = path.relative(dir, path.resolve(filePath)).split(path.sep).join("/")
  if (rel.startsWith("agents/") && rel.endsWith(".md")) {
    return { pack, id: rel.slice("agents/".length, -3) }
  }
  if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) {
    const virtualMatch = scanLooseAgentFiles(dir).agents.find(item => item.sourceRel === rel)
    if (virtualMatch) return { pack, id: virtualMatch.id }
  }
  throw new Error(`overrides apply to pack agents under agents/*.md; got "${rel}"`)
}

function normalizeRawAgentToV2(rawContent: string): string {
  const { yamlText, body } = extractFrontmatter(rawContent)
  if (yamlText === null) return rawContent
  const parsed = YAML.parse(yamlText)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return rawContent
  return detectFrontmatterVersion(parsed as Record<string, any>) === "v1"
    ? renderAgentFile(parsed as Record<string, any>, body, "v1")
    : rawContent
}

function withSettingsLock<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const dir = engineConfigDir(env)
  fs.mkdirSync(dir, { recursive: true })
  const lockFile = path.join(dir, ".settings.lock")
  let fd: number | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fd = fs.openSync(lockFile, "wx", 0o600)
      fs.writeSync(fd, `${process.pid}\n`)
      break
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error
      try {
        const ownerPid = Number(fs.readFileSync(lockFile, "utf8").trim())
        if (!Number.isInteger(ownerPid) || ownerPid <= 0) fs.unlinkSync(lockFile)
        else {
          try { process.kill(ownerPid, 0) } catch (killErr: any) { if (killErr?.code === "ESRCH") fs.unlinkSync(lockFile) }
        }
      } catch {
        // Another writer may have already cleaned it up.
      }
      if (attempt === 1) throw new Error(`Another manage-agents process is updating settings (${lockFile})`)
    }
  }
  try {
    return fn()
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
      try { fs.unlinkSync(lockFile) } catch {}
    }
  }
}

export function buildSourceContentTransform(
  workspaceRoot: string,
  target: string = resolvedDefaultTarget(),
  env: NodeJS.ProcessEnv = process.env,
): (filePath: string, rawContent: string) => string {
  const settings = loadOverrideSettings(env)
  const byPack = new Map<string, ReturnType<typeof effectiveOverrides>>()
  return (filePath: string, rawContent: string) => {
    let identity: { pack: string; id: string }
    try {
      identity = agentPackIdentity(workspaceRoot, filePath)
    } catch {
      return rawContent
    }
    let packOverrides = byPack.get(identity.pack)
    if (!packOverrides) {
      packOverrides = effectiveOverrides(settings, target, identity.pack)
      byPack.set(identity.pack, packOverrides)
    }
    const patch = own(packOverrides.agents, identity.id)
    if (!patch || !Object.keys(patch).length) return rawContent
    try {
      return patchFrontmatter(normalizeRawAgentToV2(rawContent), patch)
    } catch {
      return rawContent
    }
  }
}

export function loadSourceAgents(
  workspaceRoot: string,
  options: { target?: string; env?: NodeJS.ProcessEnv } = {},
): AgentList {
  const target = options.target ?? resolvedDefaultTarget(options.env)
  return findAgentFiles(workspaceRoot, undefined, {
    contentTransform: buildSourceContentTransform(workspaceRoot, target, options.env),
  })
}

export function describeSourceArchetype(
  workspaceRoot: string,
  id: string,
  options: { target?: string; env?: NodeJS.ProcessEnv } = {},
): ArchetypeView | null {
  const env = options.env ?? process.env
  const target = options.target ?? resolvedDefaultTarget(env)
  const routingSettings = loadRoutingSettings(env)
  return describeArchetype(workspaceRoot, id, {
    contentTransform: buildSourceContentTransform(workspaceRoot, target, env),
    routeLayers: [routesOfEntry(own(routingSettings.default, id)), routesOfEntry(own(own(routingSettings.targets, target), id))],
  })
}

export function describeConfiguredPackFlows(
  workspaceRoot: string,
  id: string,
  options: { target?: string; env?: NodeJS.ProcessEnv; applySourceOverrides?: boolean } = {},
): PackFlowsView | null {
  const env = options.env ?? process.env
  const target = options.target ?? resolvedDefaultTarget(env)
  const routingSettings = loadRoutingSettings(env)
  const defaultEntry = own(routingSettings.default, id)
  const targetEntry = own(own(routingSettings.targets, target), id)
  return describePackFlows(workspaceRoot, id, {
    ...(options.applySourceOverrides ? { contentTransform: buildSourceContentTransform(workspaceRoot, target, env) } : {}),
    userCallers: targetEntry?.$callers ?? defaultEntry?.$callers,
    userReference: targetEntry?.$reference ?? defaultEntry?.$reference,
    routeLayers: [routesOfEntry(defaultEntry), routesOfEntry(targetEntry)],
    globalRules: defaultEntry?.$rules ?? [],
    userRules: targetEntry?.$rules ?? [],
    env,
  })
}

function readBaseV2Frontmatter(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, "utf8")
  const { yamlText } = extractFrontmatter(raw)
  if (yamlText === null) return {}
  const parsed = YAML.parse(yamlText)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const detected = detectFrontmatterVersion(parsed as Record<string, any>)
  const version = detected === "unknown" && typeof (parsed as any).model === "string" && (parsed as any).model.includes("#")
    ? "v2"
    : detected
  return version === "v1"
    ? (translateFrontmatterV1ToV2(parsed as Record<string, any>) as Record<string, unknown>)
    : (parsed as Record<string, unknown>)
}

function applyPatchToFrontmatterObject(base: Record<string, unknown>, patch?: FieldPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [field, value] of Object.entries(patch ?? {})) {
    if (value === null) delete out[field]
    else setOwn(out, field, value)
  }
  return out
}

/**
 * Collects frontmatter edits in memory and writes the minimal V2 `FieldPatch` into `overrides.json` for `target`,
 * leaving the cached git checkout untouched on disk.
 */
export function runWithOverrideWriter<T>(
  workspaceRoot: string,
  fn: (writer: typeof saveAgentFile) => T,
  options: { target?: string; env?: NodeJS.ProcessEnv } = {},
): T {
  const env = options.env ?? process.env
  const target = options.target ?? resolvedDefaultTarget(env)
  const pending: Array<{ filePath: string; frontmatter: Record<string, any> }> = []
  const writer: typeof saveAgentFile = (filePath, frontmatter) => {
    pending.push({ filePath, frontmatter: structuredClone(frontmatter) })
  }
  const result = fn(writer)
  if (!pending.length) return result

  withSettingsLock(env, () => {
    const settings = loadOverrideSettings(env)
    const scope = scopeOf(settings, target)
    for (const item of pending) {
      const { pack, id } = agentPackIdentity(workspaceRoot, item.filePath)
      const globalPatch = own(own(settings.default, pack)?.agents, id)
      const baseline = applyPatchToFrontmatterObject(readBaseV2Frontmatter(item.filePath), globalPatch)
      const desired = translateFrontmatterV1ToV2(composeModelVariant({ ...item.frontmatter })) as Record<string, unknown>
      const patch: FieldPatch = {}
      for (const field of AGENT_FIELDS) {
        const hasBase = Object.prototype.hasOwnProperty.call(baseline, field) && baseline[field] !== undefined
        const hasDesired = Object.prototype.hasOwnProperty.call(desired, field) && desired[field] !== undefined
        if (!hasDesired && hasBase) {
          patch[field] = null
        } else if (hasDesired && !isDeepStrictEqual(desired[field], baseline[field])) {
          patch[field] = desired[field]
        }
      }
      unsetOverride(scope, pack, "agents", id, [])
      if (Object.keys(patch).length > 0) {
        setOverride(scope, pack, "agents", id, patch)
      }
    }
    saveOverrideSettings(settings, env)
  })
  return result
}

export function overrideAgentsModel(
  workspaceRoot: string,
  agents: AgentInfo[],
  model: string,
  verifiedModels: string[] = [],
  options: { target?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  if (!verifiedModels.includes(model)) throw new Error(`Model is not present in refreshed catalog: ${model}`)
  runWithOverrideWriter(workspaceRoot, writer => {
    for (const agent of agents) {
      const updated = composeModelVariant({ ...agent.frontmatter, model })
      writer(agent.currentPath, updated, agent.body, agent.frontmatterVersion)
      agent.model = model
      agent.frontmatter = { ...agent.frontmatter, model }
    }
  }, options)
}

export function overrideRepairAgentModels(
  workspaceRoot: string,
  agents: AgentInfo[],
  mappings: ModelRepairMapping[],
  verifiedModels: string[],
  options: { target?: string; env?: NodeJS.ProcessEnv } = {},
): { groups: number; agentsChanged: number } {
  const catalog = new Set(verifiedModels)
  const seen = new Set<string>()
  const updates: Array<{ agent: AgentInfo; newModel: string }> = []
  for (const mapping of mappings) {
    if (!catalog.has(mapping.newModel)) throw new Error(`Replacement is not present in refreshed catalog: ${mapping.newModel}`)
    for (const agentPath of mapping.agentPaths) {
      if (seen.has(agentPath)) throw new Error(`Agent appears in more than one repair group: ${agentPath}`)
      seen.add(agentPath)
      const agent = agents.find(item => item.currentPath === agentPath)
      if (!agent) throw new Error(`Unknown agent path: ${agentPath}`)
      if (agent.frontmatter.model !== mapping.oldModel) {
        throw new Error(`Agent changed before repair: ${agent.filename}`)
      }
      updates.push({ agent, newModel: mapping.newModel })
    }
  }
  runWithOverrideWriter(workspaceRoot, writer => {
    for (const { agent, newModel } of updates) {
      const updated = composeModelVariant({ ...agent.frontmatter, model: newModel })
      writer(agent.currentPath, updated, agent.body, agent.frontmatterVersion)
      agent.model = newModel
      agent.frontmatter = { ...agent.frontmatter, model: newModel }
    }
  }, options)
  return { groups: mappings.length, agentsChanged: updates.length }
}

/** Saves or deletes an archetype routing configuration in `routing.json` without editing the pack manifest. */
export function saveSourceArchetypeRouting(
  workspaceRoot: string,
  id: string,
  trigger: string,
  roles: RoleModels | null,
  options: { previousTrigger?: string; target?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const env = options.env ?? process.env
  const target = options.target ?? resolvedDefaultTarget(env)
  const view = describeSourceArchetype(workspaceRoot, id, { target, env })
  if (!view) throw new Error(`'${id}' is not an archetype pack of this source`)
  if (!isTrigger(trigger)) throw new Error(`the trigger must be "provider" or "provider/model"; got '${trigger}'`)
  if (roles === null && !Object.hasOwn(view.configs, trigger)) throw new Error(`No configuration '${trigger}' in ${id}`)
  saveUserPackFlow(
    workspaceRoot,
    id,
    roles === null ? null : { triggers: [trigger], roles, tools: {}, permissions: {}, delegations: {} },
    {
      previousKey: roles === null ? `route:${trigger}` : options.previousTrigger ? `route:${options.previousTrigger}` : undefined,
      target,
      env,
      applySourceOverrides: true,
    },
  )
}

export interface FlowDraftInput {
  callers?: string[]
  triggers: string[]
  roles: RoleModels
  tools: Record<string, PolicyEffect>
  permissions: Record<string, PolicyEffect>
  delegations: Record<string, DelegationEffect>
}

/** Updates or clears user-configured OR callers for any pack in `routing.json`. */
export function saveUserPackCallers(
  workspaceRoot: string,
  id: string,
  callers: string[] | null,
  options: { target?: string; env?: NodeJS.ProcessEnv; applySourceOverrides?: boolean } = {},
): void {
  const env = options.env ?? process.env
  const target = options.target ?? resolvedDefaultTarget(env)
  const view = describeConfiguredPackFlows(workspaceRoot, id, options)
  if (!view) throw new Error(`'${id}' has no agents in this source`)
  if (callers !== null) {
    if (!callers.length) throw new Error("Select at least one caller agent.")
    for (const caller of callers) {
      if (!view.callerCandidates.some(candidate => candidate.name === caller)) {
        throw new Error(`'${caller}' cannot be a caller of ${id}`)
      }
    }
  }
  withSettingsLock(env, () => {
    const settings = loadRoutingSettings(env)
    setPackCallers(scopeOf(settings, target), id, callers, callers?.[0])
    saveRoutingSettings(settings, env)
  })
}

/**
 * Saves, replaces or deletes (`draft === null`) a conditional IF/OR flow in `routing.json` for ANY pack (with or
 * without `archetype` in `opencode-pack.json`, and including virtual `.md` folders).
 */
export function saveUserPackFlow(
  workspaceRoot: string,
  id: string,
  draft: FlowDraftInput | null,
  options: { previousKey?: string; target?: string; env?: NodeJS.ProcessEnv; applySourceOverrides?: boolean } = {},
): string | null {
  const env = options.env ?? process.env
  const target = options.target ?? resolvedDefaultTarget(env)
  const view = describeConfiguredPackFlows(workspaceRoot, id, options)
  const dir = packDir(workspaceRoot, id)
  if (!view || !dir) throw new Error(`'${id}' is not a valid pack in this source`)

  return withSettingsLock(env, () => {
    const manifestDefaults = (readManifest(dir).routingDefaults ?? {}) as Record<string, Record<string, string>>
    const settings = loadRoutingSettings(env)
    const scope = scopeOf(settings, target)
    const defaultEntry = own(settings.default, id)
    const targetEntry = own(scope, id)
    const globalPackRoutes = routesOfEntry(defaultEntry)

    const hasUnderlyingTrigger = (t: string) => Boolean(own(manifestDefaults, t) || own(globalPackRoutes, t))
    const neutralizeOrUnsetRoute = (t: string) => {
      unsetRoutes(scope, id, t, [])
      if (hasUnderlyingTrigger(t) && view.related.length > 0) {
        setRoutes(scope, id, t, Object.fromEntries(view.related.map(agent => [agent.name, INHERIT])))
      }
    }

    const currentTargetRules = [...(targetEntry?.$rules ?? [])]

    const removeByPreviousKey = (prevKey: string) => {
      if (prevKey.startsWith("route:")) {
        neutralizeOrUnsetRoute(prevKey.slice("route:".length))
      } else if (prevKey.startsWith("user-rule:")) {
        const targetIndex = Number(prevKey.slice("user-rule:".length))
        if (targetIndex >= 0 && targetIndex < currentTargetRules.length) {
          currentTargetRules.splice(targetIndex, 1)
        }
      }
    }

    if (draft === null) {
      if (!options.previousKey) throw new Error("Missing flow identifier to delete.")
      if (options.previousKey.startsWith("pack-rule:")) {
        throw new Error("This rule comes from opencode-pack.json; override it by adding a rule on the same trigger or edit the pack manifest.")
      }
      if (options.previousKey.startsWith("global-rule:")) {
        throw new Error("This rule comes from global (--global) settings; unset it with `manage-agents models rule-unset --global`.")
      }
      removeByPreviousKey(options.previousKey)
      setPackRules(scope, id, currentTargetRules)
      saveRoutingSettings(settings, env)
      return null
    }

    const triggers = [...new Set(draft.triggers.map(t => t.trim()).filter(Boolean))]
    if (!triggers.length || !triggers.every(isFlowTrigger)) {
      throw new Error('Choose at least one valid trigger ("*", a provider, or "provider/model").')
    }
    const normalizedRoles: RoleModels = {}
    for (const [roleOrName, model] of Object.entries(draft.roles)) {
      if (model !== INHERIT && !isModelRef(model)) throw new Error(`${roleOrName}: '${model}' is not "inherit" or provider/model[#variant]`)
      const matched = view.related.find(agent => agent.role === roleOrName || agent.name === roleOrName)
      if (!matched) {
        const isPinned = view.pinned.some(agent => agent.role === roleOrName || agent.name === roleOrName)
        throw new Error(`${roleOrName}: not a routable subagent of ${id}${isPinned ? " (it has a fixed model)" : ""}`)
      }
      setOwn(normalizedRoles, matched.role, model)
    }

    const hasExtraPolicies =
      Boolean(draft.callers?.length) ||
      Object.keys(draft.tools).length > 0 ||
      Object.keys(draft.permissions).length > 0 ||
      Object.keys(draft.delegations).length > 0
    const isSinglePlainRoute = triggers.length === 1 && triggers[0] !== WILDCARD_TRIGGER && isTrigger(triggers[0]) && !hasExtraPolicies && view.related.length > 0

    if (isSinglePlainRoute) {
      const singleTrigger = triggers[0]
      if (options.previousKey && options.previousKey !== `route:${singleTrigger}`) {
        if (view.flows.some(f => f.key === `route:${singleTrigger}`)) {
          throw new Error(`${id} already has a route configuration for '${singleTrigger}'`)
        }
        removeByPreviousKey(options.previousKey)
        setPackRules(scope, id, currentTargetRules)
      }
      unsetRoutes(scope, id, singleTrigger, [])
      const assignments: Record<string, string> = {}
      for (const agent of view.related) {
        const desired = normalizedRoles[agent.role] ?? INHERIT
        const underlying = own(globalPackRoutes, singleTrigger)?.[agent.name] ?? own(manifestDefaults, singleTrigger)?.[agent.name] ?? INHERIT
        if (desired !== underlying || Object.hasOwn(normalizedRoles, agent.role)) {
          assignments[agent.name] = desired
        }
      }
      if (!Object.keys(assignments).length && !hasUnderlyingTrigger(singleTrigger) && view.related.length > 0) {
        assignments[view.related[0].name] = INHERIT
      }
      if (Object.keys(assignments).length > 0) {
        setRoutes(scope, id, singleTrigger, assignments)
      }
      saveRoutingSettings(settings, env)
      return `route:${singleTrigger}`
    }

    // Rich conditional rule (multi-trigger OR, "*" trigger, tools, permissions, delegations, or single-agent pack)
    const nameOf = (role: string) => view.related.find(agent => agent.role === role)?.name ?? role
    const models: Record<string, string> = {}
    for (const [role, model] of Object.entries(normalizedRoles)) {
      setOwn(models, nameOf(role), model)
    }
    const then: ConditionalRule["then"] = {
      ...(Object.keys(models).length ? { models } : {}),
      ...(Object.keys(draft.tools).length ? { tools: { ...draft.tools } } : {}),
      ...(Object.keys(draft.permissions).length ? { permissions: { ...draft.permissions } } : {}),
      ...(Object.keys(draft.delegations).length ? { delegations: { ...draft.delegations } } : {}),
    }
    if (!then.models && !then.tools && !then.permissions && !then.delegations) {
      if (view.related.length > 0) {
        then.models = { [view.related[0].name]: INHERIT }
      } else {
        throw new Error("Configure at least one model, tool, permission, or delegation effect in this rule.")
      }
    }
    const nextRule: ConditionalRule = {
      ...(draft.callers?.length ? { callers: [...draft.callers] } : {}),
      triggers,
      then,
    }

    let savedIdx: number
    if (options.previousKey?.startsWith("user-rule:")) {
      const targetIndex = Number(options.previousKey.slice("user-rule:".length))
      if (targetIndex >= 0 && targetIndex < currentTargetRules.length) {
        currentTargetRules[targetIndex] = nextRule
        savedIdx = targetIndex
      } else {
        savedIdx = currentTargetRules.push(nextRule) - 1
      }
    } else {
      if (options.previousKey) removeByPreviousKey(options.previousKey)
      savedIdx = currentTargetRules.push(nextRule) - 1
    }
    setPackRules(scope, id, currentTargetRules)
    saveRoutingSettings(settings, env)
    return `user-rule:${savedIdx}`
  })
}

export interface ReconcileOutcome {
  installed: boolean
  target: string
  result?: ChangeResult
}

export async function reconcileTargetIfInstalled(
  command: "override" | "models" = "override",
  options: { target?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ReconcileOutcome> {
  const env = options.env ?? process.env
  const target = options.target ?? resolvedDefaultTarget(env)
  if (!readLock(target)) return { installed: false, target }
  const registry = loadSources(env)
  const result = await changeTarget(target, command, registry, reconcileChange, { env })
  return { installed: true, target, result }
}

export function formatReconcileLines(outcome: ReconcileOutcome): string[] {
  if (!outcome.installed) {
    return [
      `Saved in user settings for ${outcome.target}.`,
      `Nothing is installed in this target yet; press [E] on a pack to install it with these settings.`,
    ]
  }
  const result = outcome.result!
  if (result.status === "applied") {
    return [`Saved in user settings and reconciled ${outcome.target}.`]
  }
  if (result.status === "unchanged") {
    return [`Saved in user settings (${outcome.target} is already in sync).`]
  }
  return [
    `Saved in user settings, but reconciling ${outcome.target} did not complete:`,
    ...describeChangeResult(outcome.target, result),
  ]
}

export function sourceTranslationConfigLocation(
  sourceName: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { configRoot: string; configPath: string; readPath?: string } {
  const configRoot = path.join(engineConfigDir(env), "translations", sourceName)
  const configPath = path.join(configRoot, "translation.json")
  const repoDefault = path.join(workspaceRoot, ".agent-manager", "translation.json")
  const readPath = fs.existsSync(configPath) ? configPath : fs.existsSync(repoDefault) ? repoDefault : configPath
  return { configRoot, configPath, readPath }
}

export function sourceBridgeOutputDir(
  sourceName: string,
  bridgeTarget: "claude" | "codex",
  safePluginName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(engineCacheDir(env), "bridges", sourceName, bridgeTarget === "codex" ? "codex" : "claude-code", safePluginName)
}
