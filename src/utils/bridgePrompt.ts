import { agentId, type AgentInfo } from "./agents.js"
import { clampListScroll } from "./layout.js"
import { terminalSafeText } from "./terminalText.js"
import {
  buildInferenceIndex,
  DEFAULT_TRANSLATION_CONFIG,
  resolveModelTarget,
  validateClaudeModelName,
  type TranslationConfig,
  type TranslationTarget,
  type TranslationTier,
} from "./translationConfig.js"

export type BridgeField = "name" | "pack" | "tiers" | "effort" | "agents" | "model"

export const CLAUDE_TIER_MODEL_PRESETS = ["opus", "sonnet", "haiku", "inherit"] as const
export const CODEX_EFFORT_PRESETS = ["low", "medium", "high", "xhigh", "max"] as const
export const VIBE_TIER_MODEL_PRESETS = ["inherit", "mistral-large-4", "mistral-medium-3.5"] as const

export interface BridgePackOption {
  pack: string
  count: number
  assetSummary?: string
}

export interface BridgePackSelectionState {
  selectedPack: string
  query: string
  index: number
  scrollOffset: number
}

export interface BridgeAgentMappingItem {
  currentPath: string
  filename: string
  strippedName: string
  sourceModel: string
  role: string
  tier: string
  targetModel: string
  reasoningEffort?: string
  source: "override" | "model-map" | "role" | "inferred" | "default"
  inferredFrom?: string
}

export interface PackBridgePreview {
  items: BridgeAgentMappingItem[]
  tierCounts: Record<string, number>
}

export function comparePackCategories(a: string, b: string): number {
  if (a === "general") return 1
  if (b === "general") return -1
  return a.localeCompare(b)
}

export function collectBridgeablePacks(
  agents: ReadonlyArray<{ category: string }>,
  isPackValid: (pack: string) => boolean,
  additionalPacks: readonly string[] = [],
): BridgePackOption[] {
  const counts = new Map<string, number>(additionalPacks.map(pack => [pack, 0]))
  for (const agent of agents) {
    if (!agent.category) continue
    counts.set(agent.category, (counts.get(agent.category) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([pack]) => isPackValid(pack))
    .sort(([a], [b]) => comparePackCategories(a, b))
    .map(([pack, count]) => ({ pack, count }))
}

export function filterBridgePacks(
  packs: ReadonlyArray<BridgePackOption>,
  query: string,
): BridgePackOption[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...packs]
  return packs.filter(({ pack }) => pack.toLowerCase().includes(normalized))
}

export function resolveInitialBridgePack(
  packs: ReadonlyArray<BridgePackOption>,
  focusedPack: string | undefined,
  viewportRows = 5,
): BridgePackSelectionState {
  if (packs.length === 0) {
    return { selectedPack: "", query: "", index: 0, scrollOffset: 0 }
  }
  const foundIndex = focusedPack ? packs.findIndex(item => item.pack === focusedPack) : -1
  const index = foundIndex >= 0 ? foundIndex : 0
  return {
    selectedPack: packs[index].pack,
    query: "",
    index,
    scrollOffset: clampListScroll(index, packs.length, 0, viewportRows),
  }
}

export function reconcileBridgePackQuery(
  packs: ReadonlyArray<BridgePackOption>,
  query: string,
  previousSelectedPack: string,
  viewportRows = 5,
): BridgePackSelectionState {
  const filtered = filterBridgePacks(packs, query)
  if (filtered.length === 0) {
    return { selectedPack: "", query, index: 0, scrollOffset: 0 }
  }
  const preservedIndex = previousSelectedPack
    ? filtered.findIndex(item => item.pack === previousSelectedPack)
    : -1
  const index = preservedIndex >= 0 ? preservedIndex : 0
  return {
    selectedPack: filtered[index].pack,
    query,
    index,
    scrollOffset: clampListScroll(index, filtered.length, 0, viewportRows),
  }
}

export function stepBridgePackSelection(
  filteredPacks: ReadonlyArray<BridgePackOption>,
  currentIndex: number,
  delta: 1 | -1,
  currentScrollOffset: number,
  viewportRows = 5,
): { selectedPack: string; index: number; scrollOffset: number } {
  if (filteredPacks.length === 0) {
    return { selectedPack: "", index: 0, scrollOffset: 0 }
  }
  const safeCurrent = Math.max(0, Math.min(filteredPacks.length - 1, currentIndex))
  const index = (safeCurrent + delta + filteredPacks.length) % filteredPacks.length
  return {
    selectedPack: filteredPacks[index].pack,
    index,
    scrollOffset: clampListScroll(index, filteredPacks.length, currentScrollOffset, viewportRows),
  }
}

export function stepBridgeField(
  current: BridgeField,
  reverse = false,
  target: TranslationTarget = "claude",
): BridgeField {
  const order: BridgeField[] = target === "codex"
    ? ["name", "pack", "tiers", "effort", "agents", "model"]
    : ["name", "pack", "tiers", "agents", "model"]
  const normalizedCurrent = target !== "codex" && current === "effort" ? "tiers" : current
  const idx = Math.max(0, order.indexOf(normalizedCurrent))
  const delta = reverse ? -1 : 1
  return order[(idx + delta + order.length) % order.length]
}

export function deriveBridgePrefix(pack: string): string {
  const trimmed = pack.trim()
  return trimmed ? `${trimmed}-` : ""
}

export function initialBridgeModelCatchAll(
  config: TranslationConfig | null | undefined,
  target: TranslationTarget,
): string {
  return config?.[target]?.modelMap?.["*"]?.trim() ?? ""
}

export function cloneBridgeTiers(tiers: Readonly<Record<string, TranslationTier>>): Record<string, TranslationTier> {
  const copy: Record<string, TranslationTier> = {}
  for (const [name, tier] of Object.entries(tiers)) {
    copy[name] = {
      ...(tier.description !== undefined ? { description: tier.description } : {}),
      claude: {
        model: terminalSafeText(tier.claude.model),
        ...(tier.claude.reasoningEffort !== undefined ? { reasoningEffort: terminalSafeText(tier.claude.reasoningEffort) } : {}),
      },
      codex: {
        model: terminalSafeText(tier.codex.model),
        ...(tier.codex.reasoningEffort !== undefined ? { reasoningEffort: terminalSafeText(tier.codex.reasoningEffort) } : {}),
      },
      vibe: {
        model: terminalSafeText(tier.vibe?.model ?? "inherit"),
      },
    }
  }
  return copy
}

export function sanitizeDraftBridgeTiers(tiers: Readonly<Record<string, TranslationTier>>): Record<string, TranslationTier> {
  const copy = cloneBridgeTiers(tiers)
  for (const tier of Object.values(copy)) {
    tier.claude.model = tier.claude.model.trim()
    tier.codex.model = tier.codex.model.trim()
    tier.vibe.model = tier.vibe.model.trim()
    if (tier.codex.reasoningEffort !== undefined) {
      const trimmedEffort = tier.codex.reasoningEffort.trim()
      if (trimmedEffort) tier.codex.reasoningEffort = trimmedEffort
      else delete tier.codex.reasoningEffort
    }
  }
  return copy
}

export function validateDraftBridgeTiers(
  tiers: Readonly<Record<string, TranslationTier>>,
  target: TranslationTarget,
): void {
  const entries = Object.entries(tiers)
  if (entries.length === 0) {
    throw new Error("Bridge tiers must not be empty.")
  }
  for (const [name, tier] of entries) {
    const claudeModel = tier.claude?.model?.trim() ?? ""
    const codexModel = tier.codex?.model?.trim() ?? ""
    const vibeModel = tier.vibe?.model?.trim() ?? ""
    if (!claudeModel) {
      throw new Error(`Tier "${name}" is missing a Claude model.`)
    }
    if (!codexModel) {
      throw new Error(`Tier "${name}" is missing a Codex model.`)
    }
    if (!vibeModel) {
      throw new Error(`Tier "${name}" is missing a Vibe model.`)
    }
    if (target === "claude") {
      validateClaudeModelName(claudeModel)
    }
  }
}

export function cyclePresetValue(presets: readonly string[], current: string, delta: 1 | -1): string {
  if (presets.length === 0) return current
  const idx = presets.indexOf(current)
  if (idx < 0) {
    return delta === 1 ? presets[0] : presets[presets.length - 1]
  }
  return presets[(idx + delta + presets.length) % presets.length]
}

export function cycleAgentRoleTier(
  roles: Readonly<Record<string, string>>,
  role: string,
  tierNames: readonly string[],
  currentTier: string,
  delta: 1 | -1,
): { nextTier: string; roles: Record<string, string> } {
  const nextTier = cyclePresetValue(tierNames, currentTier, delta)
  return {
    nextTier,
    roles: {
      ...roles,
      [role]: nextTier,
    },
  }
}

export function applyBridgeDraftToConfig(
  baseConfig: TranslationConfig,
  options: {
    target: TranslationTarget
    tiers: Readonly<Record<string, TranslationTier>>
    roles: Readonly<Record<string, string>>
    pack?: string
    pluginName?: string
    modelCatchAll?: string
  },
): TranslationConfig {
  const nextTiers = sanitizeDraftBridgeTiers(options.tiers)
  const nextRoles: Record<string, string> = { ...options.roles }
  const next: TranslationConfig = {
    ...baseConfig,
    tiers: nextTiers,
    roles: nextRoles,
    vibe: {
      ...baseConfig.vibe,
      overrides: { ...baseConfig.vibe.overrides },
      modelMap: { ...(baseConfig.vibe.modelMap || {}) },
    },
    claude: {
      ...baseConfig.claude,
      overrides: { ...baseConfig.claude.overrides },
      modelMap: { ...(baseConfig.claude.modelMap || {}) },
    },
    codex: {
      ...baseConfig.codex,
      overrides: { ...baseConfig.codex.overrides },
      modelMap: { ...(baseConfig.codex.modelMap || {}) },
    },
  }
  if (options.pluginName !== undefined) {
    next.pluginName = options.pluginName.trim()
  }
  if (options.pack !== undefined) {
    next.prefix = deriveBridgePrefix(options.pack)
  }
  if (options.modelCatchAll !== undefined) {
    const trimmedMap = options.modelCatchAll.trim()
    const targetMap = { ...(next[options.target].modelMap || {}) }
    if (trimmedMap) targetMap["*"] = trimmedMap
    else delete targetMap["*"]
    next[options.target].modelMap = targetMap
  }
  return next
}

export function buildPackBridgePreview(
  agents: ReadonlyArray<AgentInfo>,
  baseConfig: TranslationConfig | null,
  options: {
    target: TranslationTarget
    pack: string
    tiers: Readonly<Record<string, TranslationTier>>
    roles: Readonly<Record<string, string>>
    modelCatchAll: string
  },
): PackBridgePreview {
  const { target, pack, tiers, roles, modelCatchAll } = options
  if (!pack) return { items: [], tierCounts: {} }

  const packAgents = agents
    .filter(agent => agent.category === pack)
    .sort((a, b) => a.filename.localeCompare(b.filename))

  if (packAgents.length === 0) return { items: [], tierCounts: {} }

  const prefix = deriveBridgePrefix(pack)
  const draftConfig = applyBridgeDraftToConfig(baseConfig ?? DEFAULT_TRANSLATION_CONFIG, {
    target,
    tiers,
    roles,
    pack,
    modelCatchAll,
  })
  const index = buildInferenceIndex(packAgents, draftConfig)
  const tierCounts: Record<string, number> = {}

  const items: BridgeAgentMappingItem[] = packAgents.map(agent => {
    const resolved = resolveModelTarget(agent, index, draftConfig, target)
    const stem = agentId(agent)
    const strippedName = prefix && stem.startsWith(prefix) ? stem.slice(prefix.length) : stem
    tierCounts[resolved.tier] = (tierCounts[resolved.tier] ?? 0) + 1
    return {
      currentPath: agent.currentPath,
      filename: agent.filename,
      strippedName: strippedName || stem,
      sourceModel: String(agent.frontmatter?.model || agent.model || "inherit"),
      role: resolved.role,
      tier: resolved.tier,
      targetModel: resolved.model.model,
      ...(target === "codex" && resolved.model.reasoningEffort ? { reasoningEffort: resolved.model.reasoningEffort } : {}),
      source: resolved.source,
      ...(resolved.inferredFrom ? { inferredFrom: resolved.inferredFrom } : {}),
    }
  })

  return { items, tierCounts }
}
