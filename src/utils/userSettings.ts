import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import {
  isFlowTrigger,
  isModelRef,
  own,
  ownChild,
  setOwn,
  validateConditionalRule,
  type ConditionalPolicy,
  type ConditionalRule,
} from "./values.js"
import { atomicWriteRestrictedFile, extractFrontmatter } from "./agents.js"
import { CONTROL_CHAR_RE, PACK_NAME_RE, type PackManifest } from "./packs.js"
import { engineConfigDir } from "./sources.js"

// User settings applied at reconcile, never written into packs:
//   routing.json    pack -> trigger -> subagent ID -> "provider/model#variant" | "inherit",
//                   plus optional $callers, $reference and $rules (IF/OR over models, tools, permissions, delegations)
//   overrides.json  pack -> agents|commands -> ID -> frontmatter field -> value (null removes the field)
//                   pack -> config -> section -> key -> patch (null removes the entry; a null field removes the field)
// Both have a "default" scope and per-target scopes ("targets.<absolute target path>"); the target scope wins.

export const INHERIT = "inherit"
export type Routes = Record<string, Record<string, string>>
export interface PackFlowEntry {
  $callers?: string[]
  $reference?: string
  $rules?: ConditionalRule[]
  [trigger: string]: unknown
}
export type FieldPatch = Record<string, unknown>
/** Object sections of opencode.json a config override may patch ("agents"/"commands" stay frontmatter overrides). */
export const CONFIG_SECTIONS = ["mcp.servers", "lsp", "formatter", "experimental"] as const
export type ConfigSection = (typeof CONFIG_SECTIONS)[number]
/**
 * Patch of one config entry: nested objects merge recursively, `null` removes a field, arrays and scalars replace.
 * At the entry level `null` means the pack contributes no such entry at all.
 */
export type ConfigPatch = Record<string, unknown>
export interface PackOverrides {
  agents?: Record<string, FieldPatch>
  commands?: Record<string, FieldPatch>
  config?: Record<string, Record<string, ConfigPatch | null>>
}

interface Scoped<T> { version: 1; default: Record<string, T>; targets: Record<string, Record<string, T>> }
export type RoutingSettings = Scoped<PackFlowEntry>
export type OverrideSettings = Scoped<PackOverrides>

export const AGENT_FIELDS = new Set(["description", "mode", "model", "permissions", "hidden", "color", "steps", "disabled", "request", "temperature", "top_p"])
export const COMMAND_FIELDS = new Set(["description", "agent", "model", "subagent"])
const RESERVED_FLOW_KEYS = new Set(["$callers", "$reference", "$rules"])
const isObject = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value)

const settingsPath = (name: string, env: NodeJS.ProcessEnv) => path.join(engineConfigDir(env), name)

function loadScoped<T>(name: string, env: NodeJS.ProcessEnv, check: (value: unknown, where: string) => string | null, acceptedVersions = [1, 2]): Scoped<T> {
  const file = settingsPath(name, env)
  if (!fs.existsSync(file)) return { version: 1, default: {}, targets: {} }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!acceptedVersions.includes(raw?.version) || !isObject(raw.default ?? {}) || !isObject(raw.targets ?? {})) throw new Error(`${file}: unsupported settings file`)
  const scopes: Array<[string, unknown]> = [["default", raw.default ?? {}], ...Object.entries(raw.targets ?? {}).map(([target, value]) => [`targets.${target}`, value] as [string, unknown])]
  for (const [scope, value] of scopes) {
    if (!isObject(value)) throw new Error(`${file}: ${scope} must be an object`)
    for (const [pack, entry] of Object.entries(value)) {
      const problem = PACK_NAME_RE.test(pack) ? check(entry, `${scope}.${pack}`) : `invalid pack name "${pack}"`
      if (problem) throw new Error(`${file}: ${problem}`)
    }
  }
  for (const target of Object.keys(raw.targets ?? {})) if (!path.isAbsolute(target)) throw new Error(`${file}: target "${target}" must be an absolute path`)
  return { version: 1, default: raw.default ?? {}, targets: raw.targets ?? {} }
}

function saveScoped(name: string, settings: Scoped<unknown>, env: NodeJS.ProcessEnv) {
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) return value
    if (!isObject(value)) return value
    const entries = Object.entries(value)
      .map(([key, item]) => [key, prune(item)] as const)
      .filter(([, item]) => !(isObject(item) && !Object.keys(item).length) && !(Array.isArray(item) && item.length === 0))
    const out: Record<string, unknown> = {}
    for (const [key, item] of entries.sort(([a], [b]) => a.localeCompare(b))) setOwn(out, key, item)
    return out
  }
  const pruned = prune({ default: settings.default, targets: settings.targets }) as Record<string, unknown>
  atomicWriteRestrictedFile(settingsPath(name, env), Buffer.from(`${JSON.stringify({ version: 1, default: pruned.default ?? {}, targets: pruned.targets ?? {} }, null, 2)}\n`), 0o644)
}

function checkFlowEntry(value: unknown, where: string): string | null {
  if (!isObject(value)) return `${where} must map triggers to {agent: model} (plus optional $callers, $reference, $rules)`
  if (value.$callers !== undefined) {
    if (!Array.isArray(value.$callers) || !value.$callers.length || !value.$callers.every((c: unknown) => typeof c === "string" && c.trim() === c && c.length > 0)) {
      return `${where}.$callers must be a non-empty list of agent IDs`
    }
    if (new Set(value.$callers).size !== value.$callers.length) return `${where}.$callers must not contain duplicates`
  }
  if (value.$reference !== undefined) {
    if (typeof value.$reference !== "string" || !value.$reference.trim()) return `${where}.$reference must be an agent ID`
    if (Array.isArray(value.$callers) && !value.$callers.includes(value.$reference)) return `${where}.$reference must be one of $callers`
  }
  if (value.$rules !== undefined) {
    if (!Array.isArray(value.$rules)) return `${where}.$rules must be an array`
    for (let index = 0; index < value.$rules.length; index++) {
      const { error } = validateConditionalRule(value.$rules[index], `${where}.$rules[${index}]`)
      if (error) return error
    }
  }
  for (const [key, agents] of Object.entries(value)) {
    if (RESERVED_FLOW_KEYS.has(key)) continue
    if (!isFlowTrigger(key)) return `${where}: invalid trigger "${key}"`
    if (!isObject(agents) || !Object.values(agents).every(model => model === INHERIT || isModelRef(model))) {
      return `${where}.${key}: values must be "provider/model[#variant]" or "inherit"`
    }
  }
  return null
}

const AGENT_MCP_FIELDS = new Set(["type", "command", "url", "disabled", "enabled"])

/** Shape check of one well-known mcp.servers field inside a config patch (a partial entry, so absent fields pass). */
function checkMcpPatchField(field: string, value: unknown, where: string): string | null {
  if (value === null) return null
  if (field === "type") return value === "local" || value === "remote" ? null : `${where}.${field} must be "local" or "remote"`
  if (field === "command") {
    const ok = typeof value === "string"
      ? value.length > 0 && !CONTROL_CHAR_RE.test(value)
      : Array.isArray(value) && value.length > 0 && value.every(part => typeof part === "string" && !CONTROL_CHAR_RE.test(part))
    return ok ? null : `${where}.${field} must be a non-empty string or list of strings`
  }
  if (field === "url") return typeof value === "string" ? null : `${where}.${field} must be a string`
  if (field === "disabled" || field === "enabled") return typeof value === "boolean" ? null : `${where}.${field} must be a boolean`
  return null
}

/** Walks a config patch: keys must be control-char free, string values too; mcp.servers fields get schema checks. */
function checkConfigPatch(section: string, patch: Record<string, unknown>, where: string): string | null {
  for (const [field, value] of Object.entries(patch)) {
    if (CONTROL_CHAR_RE.test(field)) return `${where}: keys must not contain control characters`
    if (section === "mcp.servers" && AGENT_MCP_FIELDS.has(field)) {
      const problem = checkMcpPatchField(field, value, where)
      if (problem) return problem
    }
    const problem = checkConfigValue(value, `${where}.${field}`)
    if (problem) return problem
  }
  return null
}

function checkConfigValue(value: unknown, where: string): string | null {
  if (value === null || typeof value === "boolean" || typeof value === "number") return null
  if (typeof value === "string") return CONTROL_CHAR_RE.test(value) ? `${where} must not contain control characters` : null
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const problem = checkConfigValue(value[index], `${where}[${index}]`)
      if (problem) return problem
    }
    return null
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (CONTROL_CHAR_RE.test(key)) return `${where}: keys must not contain control characters`
      const problem = checkConfigValue(item, `${where}.${key}`)
      if (problem) return problem
    }
    return null
  }
  return `${where} must be a JSON value`
}

function checkOverrides(value: unknown, where: string): string | null {
  if (!isObject(value) || Object.keys(value).some(key => key !== "agents" && key !== "commands" && key !== "config")) {
    return `${where} accepts only "agents", "commands" and "config"`
  }
  for (const kind of ["agents", "commands"] as const) {
    const entries = value[kind]
    if (entries === undefined) continue
    if (!isObject(entries)) return `${where}.${kind} must be an object keyed by ID`
    const allowed = kind === "agents" ? AGENT_FIELDS : COMMAND_FIELDS
    for (const [id, patch] of Object.entries(entries)) {
      if (!isObject(patch)) return `${where}.${kind}.${id} must be an object`
      const unknown = Object.keys(patch).find(field => !allowed.has(field))
      if (unknown) return `${where}.${kind}.${id}: "${unknown}" cannot be overridden (allowed: ${[...allowed].join(", ")})`
      if (patch.model !== undefined && patch.model !== null && !isModelRef(patch.model)) return `${where}.${kind}.${id}.model must be "provider/model[#variant]" or null`
    }
  }
  const config = value.config
  if (config === undefined) return null
  if (!isObject(config)) return `${where}.config must be an object keyed by section`
  for (const [section, entries] of Object.entries(config)) {
    if (!(CONFIG_SECTIONS as readonly string[]).includes(section)) {
      return `${where}.config."${section}": unknown section (allowed: ${CONFIG_SECTIONS.join(", ")})`
    }
    if (!isObject(entries)) return `${where}.config.${section} must be an object keyed by ID`
    for (const [key, patch] of Object.entries(entries)) {
      if (CONTROL_CHAR_RE.test(key)) return `${where}.config.${section}: keys must not contain control characters`
      if (patch === null) continue
      if (!isObject(patch)) return `${where}.config.${section}.${key} must be an object or null (null removes the entry)`
      const problem = checkConfigPatch(section, patch, `${where}.config.${section}.${key}`)
      if (problem) return problem
    }
  }
  return null
}

export const loadRoutingSettings = (env: NodeJS.ProcessEnv = process.env) => loadScoped<PackFlowEntry>("routing.json", env, checkFlowEntry)
export const saveRoutingSettings = (settings: RoutingSettings, env: NodeJS.ProcessEnv = process.env) => saveScoped("routing.json", settings, env)
export const loadOverrideSettings = (env: NodeJS.ProcessEnv = process.env) => loadScoped<PackOverrides>("overrides.json", env, checkOverrides)
export const saveOverrideSettings = (settings: OverrideSettings, env: NodeJS.ProcessEnv = process.env) => saveScoped("overrides.json", settings, env)

/** Trigger -> {agent: model} entries of a pack flow object, excluding $callers/$reference/$rules metadata. */
export function routesOfEntry(entry: PackFlowEntry | undefined): Routes {
  const out: Routes = {}
  if (!entry) return out
  for (const key of Object.getOwnPropertyNames(entry)) {
    if (RESERVED_FLOW_KEYS.has(key)) continue
    const val = own(entry as Record<string, unknown>, key)
    if (isObject(val)) setOwn(out, key, val as Record<string, string>)
  }
  return out
}

/** Infers default caller agents when a pack manifest has no `archetype`: explicit primaries first, else non-subagents. */
export function inferPackCallers(
  agents: Record<string, { mode?: string; model?: string }>,
  options: { allowSingleCallerWithoutSubagents?: boolean } = {},
): string[] {
  const ids = Object.keys(agents).sort((a, b) => a.localeCompare(b))
  if (!ids.length) return []
  const primaries = ids.filter(id => agents[id].mode === "primary")
  const nonSubagents = ids.filter(id => agents[id].mode !== "subagent")
  const candidates = primaries.length ? primaries : nonSubagents.length ? nonSubagents : options.allowSingleCallerWithoutSubagents ? [ids[0]] : []
  if (!candidates.length) return []
  const subagents = ids.filter(id => !candidates.includes(id) && agents[id].mode !== "primary")
  if (!subagents.length && !options.allowSingleCallerWithoutSubagents) return []
  return candidates
}

/** The settings scope to edit: one target, or the default for every target. */
export function scopeOf<T>(settings: Scoped<T>, target: string | null): Record<string, T> {
  if (target === null) return settings.default
  return ownChild(settings.targets, target)
}

/**
 * Merges a config patch into a target in place: nested objects merge, a null field is removed, arrays and scalars
 * replace. When a nested merge only deletes keys and empties a plain object, that object goes too (an empty `environment`
 * left by `environment.OLD=null` never reaches opencode.json; pack-authored empty objects are preserved).
 */
function applyConfigPatch(target: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  let deleted = false
  for (const [field, value] of Object.entries(patch)) {
    const current = own(target, field)
    if (value === null) {
      if (current !== undefined) {
        delete target[field]
        deleted = true
      }
    } else if (isObject(value) && isObject(current)) {
      const childDeleted = applyConfigPatch(current, value)
      if (childDeleted && !Object.keys(current).length) {
        delete target[field]
        deleted = true
      }
    } else setOwn(target, field, structuredClone(value))
  }
  return deleted
}

/**
 * Layers patches the way agents/commands fields layer: target fields win, nested objects merge, `null` is kept (it
 * means "remove the field from the pack entry", exactly like a null frontmatter override).
 */
function layerConfigPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(patch)) {
    const current = own(target, field)
    if (isObject(value) && isObject(current)) layerConfigPatch(current, value)
    else setOwn(target, field, structuredClone(value))
  }
}

/** One pack entry with a patch applied: `base` is cloned, a null patch field removes the field. */
export function deepPatchEntry(base: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const source = base ?? {}
  for (const key of Object.getOwnPropertyNames(source)) setOwn(out, key, structuredClone(own(source, key)))
  applyConfigPatch(out, patch)
  return out
}

/** Minimal mcp.servers entry schema (as pack validation): what remains after a patch must still be a usable server. */
function checkMergedMcpServer(name: string, server: unknown, where: string): string | null {
  if (!isObject(server)) return `${where}: mcp.servers.${name} must be an object`
  if (server.type !== "local" && server.type !== "remote") return `${where}: mcp.servers.${name} needs "type": "local" or "remote" after the override`
  if (server.type === "local") {
    const command = server.command
    const ok = typeof command === "string"
      ? command.length > 0 && !CONTROL_CHAR_RE.test(command)
      : Array.isArray(command) && command.length > 0 && command.every(part => typeof part === "string" && !CONTROL_CHAR_RE.test(part))
    if (!ok) return `${where}: mcp.servers.${name} needs "command" (a non-empty string or list of strings) after the override`
  }
  if (server.url !== undefined && typeof server.url !== "string") return `${where}: mcp.servers.${name}.url must be a string`
  return null
}

const getConfigPath = (config: Record<string, any>, section: string): unknown =>
  section.split(".").reduce<any>((value, key) => isObject(value) ? value[key] : undefined, config)

/**
 * One pack's config object sections with its config overrides applied: entries deep-merge, a key of `null` means the
 * pack contributes no such entry, a patch on a key the pack does not have creates the entry. The result of every
 * patched mcp.servers entry must still satisfy the minimal server schema. Base entries are cloned, never shared.
 */
export function patchedConfigSections(
  config: Record<string, any>,
  overrides: Record<string, Record<string, ConfigPatch | null>>,
  where: string,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const section of CONFIG_SECTIONS) {
    const base = getConfigPath(config, section)
    const entries: Record<string, unknown> = {}
    if (isObject(base)) for (const key of Object.getOwnPropertyNames(base)) setOwn(entries, key, structuredClone(own(base, key)))
    for (const [key, patch] of Object.entries(own(overrides, section) ?? {})) {
      if (patch === null) {
        if (Object.hasOwn(entries, key)) delete entries[key]
        continue
      }
      if (!isObject(patch)) continue
      const merged = deepPatchEntry(isObject(own(entries, key)) ? own(entries, key) as Record<string, unknown> : undefined, patch)
      const problem = section === "mcp.servers" ? checkMergedMcpServer(key, merged, where) : null
      if (problem) throw new Error(problem)
      setOwn(entries, key, merged)
    }
    if (Object.keys(entries).length) setOwn(out, section, entries)
  }
  return out
}

/**
 * Overrides of one pack: the target scope patches the default field by field (config patches layer the same way they
 * apply). `target` null uses only the default scope.
 */
export function effectiveOverrides(settings: OverrideSettings, target: string | null, pack: string): Required<PackOverrides> {
  const out: Required<PackOverrides> = { agents: {}, commands: {}, config: {} }
  const scopes = [own(settings.default, pack), ...(target === null ? [] : [own(own(settings.targets, target), pack)])]
  for (const scope of scopes) {
    for (const kind of ["agents", "commands"] as const) {
      for (const [id, patch] of Object.entries(scope?.[kind] ?? {})) for (const [field, value] of Object.entries(patch)) setOwn(ownChild(out[kind], id), field, value)
    }
    for (const [section, entries] of Object.entries(scope?.config ?? {})) {
      for (const [key, patch] of Object.entries(entries)) {
        const sectionOut = ownChild(out.config, section)
        if (patch === null) { setOwn(sectionOut, key, null); continue }
        const current = own(sectionOut, key)
        const layered = deepPatchEntry(isObject(current) ? current as Record<string, unknown> : undefined, {})
        layerConfigPatch(layered, patch)
        setOwn(sectionOut, key, layered)
      }
    }
  }
  return out
}

/** Rewrites a Markdown file's frontmatter with the patch applied (null removes a field); the body is kept byte for byte. */
export function patchFrontmatter(text: string, patch: FieldPatch): string {
  const { yamlText, body } = extractFrontmatter(text)
  const parsed = yamlText === null ? {} : YAML.parse(yamlText) ?? {}
  if (!isObject(parsed)) throw new Error("frontmatter is not a mapping")
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete parsed[field]
    else setOwn(parsed, field, value)
  }
  return Object.keys(parsed).length ? `---\n${YAML.stringify(parsed).trimEnd()}\n---\n${body}` : body
}

/** Sets `agent=model|inherit` pairs for one pack and trigger (or comma-separated triggers) in a scope. */
export function setRoutes(scope: Record<string, PackFlowEntry>, pack: string, trigger: string, assignments: Record<string, string>): void {
  if (!PACK_NAME_RE.test(pack)) throw new Error(`invalid pack name "${pack}"`)
  const triggers = trigger.includes(",") ? trigger.split(",").map(item => item.trim()).filter(Boolean) : [trigger]
  if (!triggers.length || !triggers.every(isFlowTrigger)) {
    throw new Error(`invalid trigger "${trigger}": use "*", a provider ("mistral"), or provider/model`)
  }
  if (!Object.keys(assignments).length) throw new Error("give at least one <agent>=<provider/model[#variant]|inherit>")
  for (const currentTrigger of triggers) {
    for (const [agent, model] of Object.entries(assignments)) {
      if (model !== INHERIT && !isModelRef(model)) throw new Error(`${agent}: "${model}" is not "inherit" or provider/model[#variant]`)
      setOwn(ownChild(ownChild(scope, pack) as Record<string, Record<string, string>>, currentTrigger), agent, model)
    }
  }
}

/** Removes some agents of a trigger, or the whole trigger when none is named. Returns false when nothing was set. */
export function unsetRoutes(scope: Record<string, PackFlowEntry>, pack: string, trigger: string, agents: string[]): boolean {
  const triggers = trigger.includes(",") ? trigger.split(",").map(item => item.trim()).filter(Boolean) : [trigger]
  let changed = false
  for (const currentTrigger of triggers) {
    if (RESERVED_FLOW_KEYS.has(currentTrigger)) continue
    const routes = own(own(scope, pack) as Record<string, Record<string, string>> | undefined, currentTrigger)
    if (!routes || !isObject(routes)) continue
    changed = true
    if (!agents.length) delete (scope[pack] as Record<string, unknown>)[currentTrigger]
    else for (const agent of agents) delete routes[agent]
  }
  return changed
}

/** Sets or clears custom OR callers for a pack in a scope, independent of opencode-pack.json. */
export function setPackCallers(scope: Record<string, PackFlowEntry>, pack: string, callers: string[] | null, reference?: string): boolean {
  if (!PACK_NAME_RE.test(pack)) throw new Error(`invalid pack name "${pack}"`)
  if (callers === null) {
    const entry = own(scope, pack)
    if (!entry || (!entry.$callers && !entry.$reference)) return false
    delete entry.$callers
    delete entry.$reference
    return true
  }
  const unique = [...new Set(callers.map(item => item.trim()).filter(Boolean))]
  if (!unique.length) throw new Error("specify at least one caller agent ID")
  const ref = reference ?? unique[0]
  if (!unique.includes(ref)) throw new Error(`reference caller "${ref}" must be included in callers`)
  const entry = ownChild(scope, pack)
  entry.$callers = unique
  entry.$reference = ref
  return true
}

/** Replaces or appends conditional IF/OR rules for a pack in a scope. */
export function setPackRules(scope: Record<string, PackFlowEntry>, pack: string, rules: ConditionalRule[] | null): void {
  if (!PACK_NAME_RE.test(pack)) throw new Error(`invalid pack name "${pack}"`)
  if (rules === null || rules.length === 0) {
    const entry = own(scope, pack)
    if (entry) delete entry.$rules
    return
  }
  const normalized: ConditionalRule[] = []
  rules.forEach((raw, index) => {
    const { rule, error } = validateConditionalRule(raw, `${pack}.$rules[${index}]`)
    if (error) throw new Error(error)
    if (rule) normalized.push(rule)
  })
  ownChild(scope, pack).$rules = normalized
}

/** Patches fields of an agent or command of a pack in a scope; `null` removes the field from the installed file. */
export function setOverride(scope: Record<string, PackOverrides>, pack: string, kind: "agents" | "commands", id: string, fields: FieldPatch): void {
  if (!PACK_NAME_RE.test(pack)) throw new Error(`invalid pack name "${pack}"`)
  const next = { ...(own(own(scope, pack)?.[kind], id) ?? {}) }
  for (const [field, value] of Object.entries(fields)) setOwn(next, field, value)
  const problem = checkOverrides({ [kind]: { [id]: next } }, `${pack}`)
  if (problem) throw new Error(problem)
  setOwn(ownChild(ownChild(scope, pack) as Record<string, any>, kind), id, next)
}

/** Drops some overridden fields, or the whole override when none is named. Returns false when nothing was set. */
export function unsetOverride(scope: Record<string, PackOverrides>, pack: string, kind: "agents" | "commands", id: string, fields: string[]): boolean {
  const patch = own(own(scope, pack)?.[kind], id)
  if (!patch) return false
  if (!fields.length) delete scope[pack]![kind]![id]
  else for (const field of fields) delete patch[field]
  return true
}

/** Deep-merges fields into the config override of one entry; null fields stay null (they remove the field from the pack entry). */
export function setConfigOverride(scope: Record<string, PackOverrides>, pack: string, section: ConfigSection, key: string, fields: ConfigPatch): void {
  if (!PACK_NAME_RE.test(pack)) throw new Error(`invalid pack name "${pack}"`)
  if (CONTROL_CHAR_RE.test(key)) throw new Error(`config key "${key}" must not contain control characters`)
  const existing = own(own(own(scope, pack)?.config, section), key)
  const next = deepPatchEntry(isObject(existing) ? existing as Record<string, unknown> : undefined, {})
  layerConfigPatch(next, fields)
  if (!Object.keys(next).length) throw new Error("give at least one <field>=<value> (null removes a field, config-remove drops the entry)")
  const problem = checkOverrides({ config: { [section]: { [key]: next } } }, `${pack}`)
  if (problem) throw new Error(problem)
  setOwn(ownChild(ownChild(ownChild(scope, pack) as Record<string, any>, "config"), section), key, next)
}

/** Makes the pack contribute no such entry at all (`null` removes it from the contribution). */
export function removeConfigEntry(scope: Record<string, PackOverrides>, pack: string, section: ConfigSection, key: string): void {
  if (!PACK_NAME_RE.test(pack)) throw new Error(`invalid pack name "${pack}"`)
  const problem = checkOverrides({ config: { [section]: { [key]: null } } }, `${pack}`)
  if (problem) throw new Error(problem)
  setOwn(ownChild(ownChild(ownChild(scope, pack) as Record<string, any>, "config"), section), key, null)
}

/** Drops some overridden fields (dotted names address nested fields), or the whole entry override when none is named. */
export function unsetConfigOverride(scope: Record<string, PackOverrides>, pack: string, section: ConfigSection, key: string, fields: string[]): boolean {
  const entries = own(own(scope, pack)?.config, section)
  const entry = own(entries ?? {}, key)
  if (entries === undefined || entry === undefined) return false
  if (!fields.length) {
    delete entries[key]
    return true
  }
  let container: Record<string, unknown> = entry as Record<string, unknown>
  for (const field of fields) {
    const segments = field.split(".")
    for (let index = 0; index < segments.length - 1; index++) {
      const next = own(container, segments[index])
      if (!isObject(next)) return false
      container = next
    }
    const leaf = segments[segments.length - 1]
    if (!Object.hasOwn(container, leaf)) return false
    delete container[leaf]
  }
  return true
}

export interface CompiledRule extends ConditionalRule {
  layer: 0 | 1 | 2
}

export interface RoutingArchetype {
  callers: string[]
  pinned: string[]
  routes: Routes
  rules?: CompiledRule[]
}
export interface RuntimeRouting { version: 2; generatedBy: string; archetypes: Record<string, RoutingArchetype> }

/** Resolves effective callers of a pack for a target, combining manifest archetype, user settings, and primary-agent inference. */
export function resolveEffectiveCallers(
  manifest: PackManifest,
  agents: Record<string, { mode?: string; model?: string }>,
  defaultEntry?: PackFlowEntry,
  targetEntry?: PackFlowEntry,
): string[] {
  const explicit = targetEntry?.$callers ?? defaultEntry?.$callers ?? manifest.archetype?.callers
  if (explicit?.length) return explicit.filter(id => Object.hasOwn(agents, id) && agents[id].mode !== "subagent")
  const hasUserConfig = Boolean(
    Object.keys(routesOfEntry(defaultEntry)).length ||
    Object.keys(routesOfEntry(targetEntry)).length ||
    defaultEntry?.$rules?.length ||
    targetEntry?.$rules?.length ||
    manifest.flowDefaults?.length,
  )
  if (!hasUserConfig) return []
  const hasSessionLevelRules = [...(manifest.flowDefaults ?? []), ...(defaultEntry?.$rules ?? []), ...(targetEntry?.$rules ?? [])]
    .some(rule => Boolean(rule.then.tools || rule.then.permissions))
  return inferPackCallers(agents, { allowSingleCallerWithoutSubagents: hasSessionLevelRules })
}

/**
 * routing.json for the router plugin: per configured pack, its routingDefaults/flowDefaults patched by the default and
 * then the target settings. Works both for packs declaring `archetype` in opencode-pack.json and for any pack configured
 * by the user in routing.json (inferring primary agents as callers when $callers is omitted).
 */
export function buildRuntimeRouting(packs: Array<{ manifest: PackManifest; agents: Record<string, { mode?: string; model?: string }> }>, settings: RoutingSettings, target: string): RuntimeRouting | null {
  const archetypes: Record<string, RoutingArchetype> = {}
  for (const { manifest, agents } of [...packs].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))) {
    const defaultEntry = own(settings.default, manifest.name)
    const targetEntry = own(own(settings.targets, target), manifest.name)
    const callers = resolveEffectiveCallers(manifest, agents, defaultEntry, targetEntry)
    const rawRules: Array<{ layer: 0 | 1 | 2; rule: ConditionalRule }> = [
      ...(manifest.flowDefaults ?? []).map(rule => ({ layer: 0 as const, rule })),
      ...(defaultEntry?.$rules ?? []).map(rule => ({ layer: 1 as const, rule })),
      ...(targetEntry?.$rules ?? []).map(rule => ({ layer: 2 as const, rule })),
    ]
    const ruleCallers = new Set(rawRules.flatMap(({ rule }) => (rule.callers ?? []).filter(id => Object.hasOwn(agents, id) && agents[id].mode !== "subagent")))
    if (!callers.length && !ruleCallers.size) continue

    const subagents = new Set(Object.entries(agents).filter(([id, agent]) => !callers.includes(id) && agent.mode !== "primary").map(([id]) => id))
    const routes: Routes = {}
    for (const layer of [manifest.routingDefaults, routesOfEntry(defaultEntry), routesOfEntry(targetEntry)]) {
      for (const key of Object.getOwnPropertyNames(layer ?? {})) {
        const routed = own(layer as Record<string, Record<string, string>>, key)
        if (!routed) continue
        for (const [agent, model] of Object.entries(routed)) if (subagents.has(agent)) setOwn(ownChild(routes, key), agent, model)
      }
    }

    const compiledRules: CompiledRule[] = []
    for (const { layer, rule } of rawRules) {
      const effectiveRuleCallers = rule.callers ? rule.callers.filter(id => Object.hasOwn(agents, id) && agents[id].mode !== "subagent") : undefined
      if (rule.callers && !effectiveRuleCallers?.length) continue
      const rowSubagents = new Set(
        Object.entries(agents)
          .filter(([id, agent]) => !(effectiveRuleCallers ?? callers).includes(id) && agent.mode !== "primary")
          .map(([id]) => id),
      )
      const then: ConditionalPolicy = {}
      if (rule.then.models) {
        const models: Record<string, string> = {}
        for (const [id, model] of Object.entries(rule.then.models)) if (rowSubagents.has(id)) setOwn(models, id, model)
        if (Object.keys(models).length) then.models = models
      }
      if (rule.then.tools && Object.keys(rule.then.tools).length) then.tools = { ...rule.then.tools }
      if (rule.then.permissions && Object.keys(rule.then.permissions).length) then.permissions = { ...rule.then.permissions }
      if (rule.then.delegations) {
        const delegations: Record<string, "allow" | "deny"> = {}
        for (const [id, effect] of Object.entries(rule.then.delegations)) if (id === "*" || rowSubagents.has(id)) setOwn(delegations, id, effect)
        if (Object.keys(delegations).length) then.delegations = delegations
      }
      if (!then.models && !then.tools && !then.permissions && !then.delegations) continue
      compiledRules.push({
        ...(effectiveRuleCallers ? { callers: effectiveRuleCallers } : {}),
        triggers: [...rule.triggers],
        then,
        layer,
      })
    }

    if (!manifest.archetype && !Object.keys(routes).length && !compiledRules.length && !targetEntry?.$callers && !defaultEntry?.$callers) continue
    // When conditional rules carry model overrides, mirror layer-1 and layer-2 routes into compiledRules so higher-scope
    // user routes always override lower-scope flowDefaults.
    if (compiledRules.some(rule => Boolean(rule.then.models))) {
      for (const [layer, routeMap] of [[1, routesOfEntry(defaultEntry)], [2, routesOfEntry(targetEntry)]] as const) {
        for (const key of Object.getOwnPropertyNames(routeMap)) {
          const routed = own(routeMap, key)
          if (!routed) continue
          const models: Record<string, string> = {}
          for (const [agent, model] of Object.entries(routed)) if (subagents.has(agent)) setOwn(models, agent, model)
          if (Object.keys(models).length) {
            compiledRules.push({ triggers: [key], then: { models }, layer })
          }
        }
      }
    }
    const pinned = [...subagents].filter(id => typeof agents[id].model === "string").sort()
    archetypes[manifest.name] = {
      callers: [...callers],
      pinned,
      routes,
      ...(compiledRules.length ? { rules: compiledRules } : {}),
    }
  }
  return Object.keys(archetypes).length ? { version: 2, generatedBy: "manage-agents reconcile; edit with `manage-agents models`", archetypes } : null
}
