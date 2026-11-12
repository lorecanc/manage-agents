export const WILDCARD_TRIGGER = "*"
const MODEL_RE = /^[^\s/#]+\/[^\s#]+(?:#[^\s#]+)?$/
const TRIGGER_RE = /^(?!\$)[^\s/#]+(?:\/[^\s#]+)?$/
const RESOURCE_KEY_RE = /^[^\s]+$/

export type PolicyEffect = "allow" | "ask" | "deny"
export type DelegationEffect = "allow" | "deny"

/** "provider/model#variant" in OpenCode's V2 notation. */
export const isModelRef = (value: unknown): value is string => typeof value === "string" && MODEL_RE.test(value)
/** A routing trigger: a provider ("mistral") or an exact model ("mistral/zai-glm-5-3"). */
export const isTrigger = (value: unknown): value is string => typeof value === "string" && value !== WILDCARD_TRIGGER && TRIGGER_RE.test(value)
/** A conditional-flow trigger: "*" (any model), a provider, or an exact "provider/model". */
export const isFlowTrigger = (value: unknown): value is string => value === WILDCARD_TRIGGER || isTrigger(value)
export const isPolicyEffect = (value: unknown): value is PolicyEffect => value === "allow" || value === "ask" || value === "deny"
export const isDelegationEffect = (value: unknown): value is DelegationEffect => value === "allow" || value === "deny"
export const isResourceKey = (value: unknown): value is string => typeof value === "string" && RESOURCE_KEY_RE.test(value)

/** Parses one or more comma-separated triggers ("anthropic,openai/gpt-5.4" or "*"), preserving order without duplicates. */
export function parseTriggerList(raw: string): string[] {
  const items = raw.split(",").map(item => item.trim()).filter(Boolean)
  if (!items.length) throw new Error('at least one trigger is required ("*", "provider", or "provider/model")')
  const out: string[] = []
  for (const item of items) {
    if (!isFlowTrigger(item)) throw new Error(`invalid trigger "${item}": use "*", a provider ("mistral"), or "provider/model"`)
    if (!out.includes(item)) out.push(item)
  }
  return out
}

/** Plain assignment of a key such as "__proto__" would change the prototype instead of adding the entry. */
export const setOwn = (object: Record<string, unknown>, key: string, value: unknown) =>
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })

/** The own object at `key`, created when missing; never walks into the prototype ("__proto__", "constructor"). */
export function ownChild<T extends object>(object: Record<string, T>, key: string): T {
  if (!Object.hasOwn(object, key)) setOwn(object, key, {})
  return object[key]
}

/** Own property only, so a key such as "__proto__" never reaches Object.prototype. */
export const own = <T>(object: Record<string, T> | undefined, key: string): T | undefined => object && Object.hasOwn(object, key) ? object[key] : undefined

export interface ConditionalPolicy {
  models?: Record<string, string>
  tools?: Record<string, PolicyEffect>
  permissions?: Record<string, PolicyEffect>
  delegations?: Record<string, DelegationEffect>
}

export interface ConditionalRule {
  callers?: string[]
  triggers: string[]
  then: ConditionalPolicy
}

const POLICY_KEYS = new Set(["models", "tools", "permissions", "delegations"])
const RULE_KEYS = new Set(["callers", "triggers", "then"])
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Validates and normalizes one conditional IF/OR rule, returning a human-readable error string on invalid input. */
export function validateConditionalRule(raw: unknown, where: string): { rule: ConditionalRule | null; error: string | null } {
  const fail = (message: string) => ({ rule: null, error: `${where}: ${message}` })
  if (!isPlain(raw)) return fail("rule must be an object")
  const unknownRuleKey = Object.keys(raw).find(key => !RULE_KEYS.has(key))
  if (unknownRuleKey) return fail(`unknown rule key "${unknownRuleKey}"`)

  if (!Array.isArray(raw.triggers) || !raw.triggers.length) return fail('"triggers" must be a non-empty list of "*", provider, or provider/model')
  const triggers: string[] = []
  for (const trigger of raw.triggers) {
    if (!isFlowTrigger(trigger)) return fail(`invalid trigger "${String(trigger)}"`)
    if (triggers.includes(trigger)) return fail(`duplicate trigger "${trigger}"`)
    triggers.push(trigger)
  }

  let callers: string[] | undefined
  if (raw.callers !== undefined) {
    if (!Array.isArray(raw.callers) || !raw.callers.length || !raw.callers.every(item => typeof item === "string" && item.trim() === item && item.length > 0)) {
      return fail('"callers" must be a non-empty list of agent IDs')
    }
    if (new Set(raw.callers).size !== raw.callers.length) return fail('"callers" must not contain duplicates')
    callers = [...raw.callers]
  }

  if (!isPlain(raw.then)) return fail('"then" must be an object')
  const unknownPolicyKey = Object.keys(raw.then).find(key => !POLICY_KEYS.has(key))
  if (unknownPolicyKey) return fail(`unknown policy key "then.${unknownPolicyKey}"`)

  const then: ConditionalPolicy = {}
  const checkMap = <V>(field: keyof ConditionalPolicy, checkVal: (v: unknown) => v is V, desc: string): string | null => {
    const map = raw.then && isPlain(raw.then) ? raw.then[field] : undefined
    if (map === undefined) return null
    if (!isPlain(map)) return `"then.${field}" must be an object`
    const out: Record<string, V> = {}
    for (const [key, value] of Object.entries(map)) {
      if (!isResourceKey(key)) return `"then.${field}" has invalid key "${key}"`
      if (!checkVal(value)) return `"then.${field}.${key}" must be ${desc}`
      setOwn(out, key, value)
    }
    if (Object.keys(out).length) then[field] = out as any
    return null
  }

  const err =
    checkMap("models", (v): v is string => v === "inherit" || isModelRef(v), '"inherit" or "provider/model[#variant]"') ??
    checkMap("tools", isPolicyEffect, '"allow", "ask", or "deny"') ??
    checkMap("permissions", isPolicyEffect, '"allow", "ask", or "deny"') ??
    checkMap("delegations", isDelegationEffect, '"allow" or "deny"')
  if (err) return fail(err)
  if (!then.models && !then.tools && !then.permissions && !then.delegations) {
    return fail('"then" must specify at least one of models, tools, permissions, or delegations')
  }

  return { rule: { ...(callers ? { callers } : {}), triggers, then }, error: null }
}
