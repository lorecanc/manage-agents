import React, { useState, useEffect, useMemo } from "react"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { isDeepStrictEqual } from "node:util"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import {
  findAgentFiles,
  AgentInfo,
  updateAgentsModel,
  repairAgentModels,
  updateAgentsColor,
  analyzeAgentName,
  renameAgent,
  getAgentPermissionSummary,
  SAFETY_PRESETS,
  AGENT_EFFORT_VARIANTS,
  applySafetyPreset,
  updateAgentParams,
  updateAgentDelegations,
  discoverAgentResources,
  updateAgentResources,
  AgentResourceCatalog,
  AgentResourceChanges,
  AgentResourceItem,
  AgentMcpResourceItem,
  analyzePermissionOrder,
  fixPermissionOrder,
  type TuningField,
  inspectTuningTargets,
  buildTuningUpdateParams,
  sanitizeFilename,
  getCategoryPrefixes,
  type saveAgentFile,
} from "./utils/agents.js"
import { loadModelCatalog, suggestModels, collectInvalidModelGroups, modelDisplayValue, getModelVariants, type ModelCatalog } from "./utils/models.js"
import {
  callersLabel,
  exportFlowsToPackManifest,
  INHERIT,
  isConfigurablePack,
  type ArchetypeAgent,
  type RoleModels,
  type UnifiedFlowItem,
} from "./utils/archetypes.js"
import { packDir, readManifest } from "./utils/catalog.js"
import { changeTarget, installChange } from "./utils/installer.js"
import { addSource, deriveSourceName, engineConfigDir, findSource, loadSources, pullSource, removeSource, saveSources, sourceRevision, sourceRoot, type Source } from "./utils/sources.js"
import { inspectGhAuthAsync, listGhReposAsync, runGhWebLogin, type GhAuthStatus, type GhRepoSummary } from "./utils/github.js"
import {
  describeConfiguredPackFlows,
  formatReconcileLines,
  loadSourceAgents,
  overrideAgentsModel,
  overrideRepairAgentModels,
  reconcileTargetIfInstalled,
  runWithOverrideWriter,
  saveUserPackCallers,
  saveUserPackFlow,
  sourceBridgeOutputDir,
  sourceTranslationConfigLocation,
  type FlowDraftInput,
} from "./utils/sourceCustomization.js"
import { WILDCARD_TRIGGER, type DelegationEffect, type PolicyEffect } from "./utils/values.js"
import { derivePackSlug, initPackManifest, isVirtualPackRoot } from "./utils/virtualPacks.js"
import { bridgePack } from "./utils/bridgeWorkspace.js"
import { describeChangeResult } from "./utils/changeReport.js"
import { defaultTarget, serializeLock } from "./utils/lock.js"
import { buildInferenceIndex, loadTranslationConfig, resolveModelTarget, resolveRole, saveTranslationConfig, translationConfigPath, validateClaudeModelName, type TranslationConfig } from "./utils/translationConfig.js"
import { claudeNextSteps } from "./utils/claudeNextSteps.js"
import { registerPlugin, validatePlugin } from "./utils/claudePluginCli.js"
import { AUTO_COMMIT_MESSAGES, autoCommitEnabled, repositoryTransaction, type TransactionWarning } from "./utils/repositoryTransaction.js"
import { adjustListShare, calculateLayout, calculateListColumnBudget, calculatePanelWidths, resetListShare } from "./utils/layout.js"
import { loadUiConfig, saveUiConfig } from "./utils/uiConfig.js"
import { displayWidth, middleEllipsis, terminalSafeText } from "./utils/terminalText.js"

interface AppProps {
  workspaceRoot?: string
  initialSource?: Source
  startupNotice?: string
  listShare?: number
  uiConfigWarning?: string
  configReadOnly?: boolean
  uiConfigRevision?: string
}

type ActiveDataSource =
  | { kind: "workspace"; root: string }
  | { kind: "source"; source: Source; root: string }

type SourceModalRow =
  | { id: string; kind: "connect-input"; spec: string }
  | { id: string; kind: "registered"; source: Source; revision: string | null; isActive: boolean }
  | { id: string; kind: "gh-repo"; repo: GhRepoSummary }

type ViewMode =
  | "main"
  | "sources"
  | "model-selector"
  | "repair-selector"
  | "repair-confirm"
  | "tier-selector"
   | "action-result"
  | "bridge-prompt"
  | "install-confirm"
  | "color-selector"
  | "rename-prompt"
  | "permission-preset"
  | "delegation-manager"
  | "resource-manager"
  | "parameter-tuning"
  | "layout"
  | "routing-configs"
  | "routing-editor"
  | "routing-callers"
  | "routing-tools"
  | "routing-permissions"
  | "routing-delegations"
  | "pack-init"

interface ActiveItem {
  type: "file" | "folder"
  id: string // filePath for file, category name for folder
  label: string
  category: string
  agent?: AgentInfo
}

interface InstallPreview {
  pack: string
  target: string
  lines: string[]
  confirmations: string[]
  /** The dry run found problems: nothing can be applied. */
  blocked: boolean
  /** Lock the preview resolved to: applying installs exactly this, or nothing. */
  lockText: string
}

interface ResourceManagerRow {
  kind: AgentResourceItem["kind"]
  item: AgentResourceItem | AgentMcpResourceItem
}

const COLOR_PALETTE: { group: string; emoji: string; colors: { name: string; value: string; hex: string }[] }[] = [
  { group: "Theme Colors", emoji: "🎨", colors: [
    { name: "primary", value: "primary", hex: "#3498DB" },
    { name: "secondary", value: "secondary", hex: "#95A5A6" },
    { name: "accent", value: "accent", hex: "#9B59B6" },
    { name: "success", value: "success", hex: "#2ECC71" },
    { name: "warning", value: "warning", hex: "#F1C40F" },
    { name: "error", value: "error", hex: "#E74C3C" },
    { name: "info", value: "info", hex: "#00B8D4" },
  ]},
  { group: "Reds", emoji: "🔴", colors: [
    { name: "Coral", value: "#FF6B6B", hex: "#FF6B6B" },
    { name: "Alizarin", value: "#E74C3C", hex: "#E74C3C" },
    { name: "Pomegranate", value: "#C0392B", hex: "#C0392B" },
    { name: "Crimson", value: "#DC143C", hex: "#DC143C" },
  ]},
  { group: "Oranges", emoji: "🟠", colors: [
    { name: "Tangerine", value: "#FF8C42", hex: "#FF8C42" },
    { name: "Carrot", value: "#E67E22", hex: "#E67E22" },
    { name: "Pumpkin", value: "#D35400", hex: "#D35400" },
    { name: "Burnt Orange", value: "#FF6B35", hex: "#FF6B35" },
  ]},
  { group: "Yellows", emoji: "🟡", colors: [
    { name: "Sunflower", value: "#F1C40F", hex: "#F1C40F" },
    { name: "Saffron", value: "#FFC312", hex: "#FFC312" },
    { name: "Mustard", value: "#F9CA24", hex: "#F9CA24" },
    { name: "Gold", value: "#FFD700", hex: "#FFD700" },
  ]},
  { group: "Greens", emoji: "🟢", colors: [
    { name: "Emerald", value: "#2ECC71", hex: "#2ECC71" },
    { name: "Nephritis", value: "#27AE60", hex: "#27AE60" },
    { name: "Mint", value: "#00B894", hex: "#00B894" },
    { name: "Forest", value: "#1B9C5A", hex: "#1B9C5A" },
  ]},
  { group: "Blues", emoji: "🔵", colors: [
    { name: "Peter River", value: "#3498DB", hex: "#3498DB" },
    { name: "Belize", value: "#2980B9", hex: "#2980B9" },
    { name: "Electron", value: "#0984E3", hex: "#0984E3" },
    { name: "Navy", value: "#2C3E87", hex: "#2C3E87" },
  ]},
  { group: "Purples", emoji: "🟣", colors: [
    { name: "Amethyst", value: "#9B59B6", hex: "#9B59B6" },
    { name: "Wisteria", value: "#8E44AD", hex: "#8E44AD" },
    { name: "Purple Heart", value: "#6C5CE7", hex: "#6C5CE7" },
    { name: "Indigo", value: "#5352ED", hex: "#5352ED" },
  ]},
  { group: "Pinks", emoji: "🩷", colors: [
    { name: "Pink", value: "#E84393", hex: "#E84393" },
    { name: "Fuchsia", value: "#FD79A8", hex: "#FD79A8" },
    { name: "Rose", value: "#F78FB3", hex: "#F78FB3" },
    { name: "Hot Pink", value: "#FF1493", hex: "#FF1493" },
  ]},
  { group: "Neutrals", emoji: "⚪", colors: [
    { name: "Silver", value: "#BDC3C7", hex: "#BDC3C7" },
    { name: "Concrete", value: "#95A5A6", hex: "#95A5A6" },
    { name: "Asbestos", value: "#7F8C8D", hex: "#7F8C8D" },
    { name: "Slate", value: "#546E7A", hex: "#546E7A" },
  ]},
]

interface ColorTreeItem {
  type: "group" | "color"
  id: string
  label: string
  group: string
  hex: string
  value: string
}

export function App({ workspaceRoot: workspaceRootProp, initialSource, startupNotice, listShare = 2 / 3, uiConfigWarning, configReadOnly = false, uiConfigRevision = "missing" }: AppProps) {
  const renderer = useRenderer()
  const [activeDataSource, setActiveDataSource] = useState<ActiveDataSource | null>(() => {
    if (workspaceRootProp) return { kind: "workspace", root: workspaceRootProp }
    if (initialSource) return { kind: "source", source: initialSource, root: sourceRoot(initialSource) }
    return null
  })
  const workspaceRoot = activeDataSource?.root ?? ""
  const isReadOnlyGitSource = activeDataSource?.kind === "source" && activeDataSource.source.kind === "git"
  const [activeRevision, setActiveRevision] = useState<string | null>(() =>
    initialSource ? sourceRevision(initialSource) : null
  )

  const mutate = <T,>(paths: string[], operation: keyof typeof AUTO_COMMIT_MESSAGES, fn: () => T) =>
    repositoryTransaction(workspaceRoot, paths, AUTO_COMMIT_MESSAGES[operation], fn)
  // Data State
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [models, setModels] = useState<string[]>([])
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>({ status: "unavailable", models: [] })
  const [repairGroupKey, setRepairGroupKey] = useState<string | null>(null)
  const [repairMappings, setRepairMappings] = useState<Record<string, string>>({})
  const [selectedAgentPaths, setSelectedAgentPaths] = useState<Set<string>>(new Set())

  // View Settings
  // Every folder starts closed: the TUI opens on a compact list of categories.
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState("")
  const [isSearching, setIsSearching] = useState(false)

  // Navigation State
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)

  // Modal / Action State
  const [viewMode, setViewMode] = useState<ViewMode>(() => (workspaceRootProp || initialSource ? "main" : "sources"))
  const [registeredSources, setRegisteredSources] = useState<Source[]>([])
  const [sourceRevisions, setSourceRevisions] = useState<Record<string, string | null>>({})
  const [activeSourceName, setActiveSourceName] = useState<string | undefined>(initialSource?.name)
  const [ghAuth, setGhAuth] = useState<GhAuthStatus | null>(null)
  const [ghRepos, setGhRepos] = useState<GhRepoSummary[]>([])
  const [sourcesQuery, setSourcesQuery] = useState("")
  const [sourcesInputFocused, setSourcesInputFocused] = useState(false)
  const [sourcesFocusIndex, setSourcesFocusIndex] = useState(0)
  const [sourcesScrollOffset, setSourcesScrollOffset] = useState(0)
  const [sourcesStatus, setSourcesStatus] = useState(startupNotice ?? "")
  const [appliedShare, setAppliedShare] = useState(() => listShare)
  const [layoutDraft, setLayoutDraft] = useState(() => listShare)
  const [layoutSnapshot, setLayoutSnapshot] = useState(() => listShare)
  const [layoutError, setLayoutError] = useState("")
  const [layoutStatus, setLayoutStatus] = useState("")
  const [uiConfigRevisionState, setUiConfigRevision] = useState(uiConfigRevision)
  const [focusedModelIndex, setFocusedModelIndex] = useState(0)
  const [modelScrollOffset, setModelScrollOffset] = useState(0)
  const [focusedTierIndex, setFocusedTierIndex] = useState(0)
  const [tierScrollOffset, setTierScrollOffset] = useState(0)

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())
  // Typing in the model selector filters the catalog (every word must match "provider/model").
  const [modelFilter, setModelFilter] = useState("")
  // Conditional IF/OR flows of a pack (M on any pack folder): list -> editor -> callers/triggers/models/tools/delegations.
  const [routingArchetype, setRoutingArchetype] = useState<string | null>(null)
  const [routingFocus, setRoutingFocus] = useState(0)
  const [routingEditorFocus, setRoutingEditorFocus] = useState(0)
  type RoutingDraftState = FlowDraftInput & { previousKey?: string }
  const [routingDraft, setRoutingDraft] = useState<RoutingDraftState | null>(null)
  type RoutingPick = { kind: "trigger" } | { kind: "roles"; roles: string[] }
  const [routingPick, setRoutingPick] = useState<RoutingPick | null>(null)
  const [pendingTriggers, setPendingTriggers] = useState<Set<string>>(new Set())
  const [routingSelected, setRoutingSelected] = useState<Set<string>>(new Set())
  const [routingConfirmDelete, setRoutingConfirmDelete] = useState(false)
  const [routingStatus, setRoutingStatus] = useState("")
  const [routingRevision, setRoutingRevision] = useState(0)
  const [callerDraftSet, setCallerDraftSet] = useState<Set<string>>(new Set())
  const [callerFocus, setCallerFocus] = useState(0)
  const [flowSubFocus, setFlowSubFocus] = useState(0)
  const [flowSubScroll, setFlowSubScroll] = useState(0)

  // Guided opencode-pack.json initializer for virtual .md folders ([I] key)
  const [initPackName, setInitPackName] = useState("")
  const [initPackVersion, setInitPackVersion] = useState("0.1.0")
  const [initPackDesc, setInitPackDesc] = useState("")
  const [initPackOrganize, setInitPackOrganize] = useState(true)
  const [initPackField, setInitPackField] = useState<"name" | "version" | "desc" | "organize">("name")

  const [actionResultTitle, setRawActionResultTitle] = useState("")
  const [actionResultLines, setRawActionResultLines] = useState<string[]>([])
  // Action output may contain paths, command output, parser values, or errors.
  // Sanitize at the state boundary so every result view remains terminal-safe.
  const setActionResultTitle = (value: unknown) => setRawActionResultTitle(terminalSafeText(value))
  const setActionResultLines = (values: unknown[]) => {
    setRawActionResultLines(values.map(terminalSafeText))
  }
  const setMutationSuccess = (title: string, values: unknown[], warning?: TransactionWarning) => {
    const lines = values.map(terminalSafeText)
    setActionResultTitle(title)
    setActionResultLines(warning
      ? [`⚠ AUTO-COMMIT: ${warning.message}`, `  ${warning.recovery}`, "", ...lines]
      : lines)
  }
  const [actionResultScrollOffset, setActionResultScrollOffset] = useState(0)

  const [installPreview, setInstallPreview] = useState<InstallPreview | null>(null)

  // Bridge State
  const [bridgePluginName, setBridgePluginName] = useState("")
  const [bridgePipelinePrefix, setBridgePipelinePrefix] = useState("")
  const [bridgeTarget, setBridgeTarget] = useState<"claude" | "codex">("claude")
  const [bridgeModelTarget, setBridgeModelTarget] = useState("")
  const [bridgeFocusedField, setBridgeFocusedField] = useState<"name" | "prefix" | "model">("name")
  const loadTranslationFor = (ds: ActiveDataSource | null): TranslationConfig | null => {
    if (!ds) return null
    try {
      if (ds.kind === "source" && ds.source.kind === "git") {
        const loc = sourceTranslationConfigLocation(ds.source.name, ds.root)
        const baseRoot = fs.existsSync(loc.configPath) ? loc.configRoot : ds.root
        return loadTranslationConfig(baseRoot, loc.readPath, { persistMigration: false })
      }
      return loadTranslationConfig(ds.root, undefined, { persistMigration: false })
    } catch {
      return null
    }
  }
  const [translationConfig, setTranslationConfig] = useState<TranslationConfig | null>(() => loadTranslationFor(activeDataSource))

  // Color Selector State
  const [focusedColorIndex, setFocusedColorIndex] = useState(0)
  const [colorScrollOffset, setColorScrollOffset] = useState(0)
  const [expandedColorGroups, setExpandedColorGroups] = useState<Set<string>>(new Set())

  // Rename Assistant State
  const [renameTargetAgent, setRenameTargetAgent] = useState<AgentInfo | null>(null)
  const [renameFamily, setRenameFamily] = useState("")
  const [renameCategory, setRenameCategory] = useState("")
  const [renameRole, setRenameRole] = useState("")
  const [renameFocusedField, setRenameFocusedField] = useState<"family" | "category" | "role">("family")

  // Permission Preset State
  const [focusedPresetIndex, setFocusedPresetIndex] = useState(0)

  // Delegation Manager State
  const [delegationTargetAgent, setDelegationTargetAgent] = useState<AgentInfo | null>(null)
  const [selectedDelegations, setSelectedDelegations] = useState<Set<string>>(new Set())
  const [focusedDelegationIndex, setFocusedDelegationIndex] = useState(0)
  const [delegationScrollOffset, setDelegationScrollOffset] = useState(0)

  // Skills, tools, and MCP resource manager state
  const [resourceTargetAgent, setResourceTargetAgent] = useState<AgentInfo | null>(null)
  const [resourceCatalog, setResourceCatalog] = useState<AgentResourceCatalog | null>(null)
  const [resourceModalFocusIndex, setResourceModalFocusIndex] = useState(0)
  const [resourceModalScrollOffset, setResourceModalScrollOffset] = useState(0)
  const [draftSkillAll, setDraftSkillAll] = useState(false)
  const [draftAllowedSkills, setDraftAllowedSkills] = useState<Set<string>>(new Set())
  const [draftPermissions, setDraftPermissions] = useState<Record<string, boolean>>({})
  const [explicitResourcePermissions, setExplicitResourcePermissions] = useState<Set<string>>(new Set())

  // Parameter Tuning State
  const [tuningSteps, setTuningSteps] = useState("50")
  const [tuningTemp, setTuningTemp] = useState("0.2")
  const [tuningVariant, setTuningVariant] = useState("")
  const [tuningDirtyFields, setTuningDirtyFields] = useState<Set<TuningField>>(new Set())
  const [tuningMode, setTuningMode] = useState<"subagent" | "primary">("subagent")
  const [tuningHidden, setTuningHidden] = useState(false)
  const [tuningFocusedField, setTuningFocusedField] = useState<"steps" | "temp" | "variant" | "mode" | "hidden">("steps")
  const [tuningTargetPaths, setTuningTargetPaths] = useState<string[]>([])
  const markTuningDirty = (field: TuningField) => setTuningDirtyFields(prev => {
    if (prev.has(field)) return prev
    const next = new Set(prev)
    next.add(field)
    return next
  })

  // Inspector Tab State
  const [inspectorTab, setInspectorTab] = useState<"overview" | "naming" | "security" | "delegations" | "resources">("overview")
  const [graphScrollOffset, setGraphScrollOffset] = useState(0)
  const [resourceScrollIndex, setResourceScrollIndex] = useState(0)

  const allAgentFilenames = useMemo(() => agents.map(a => a.filename), [agents])
  const bridgePrefixSuggestions = useMemo(() => [
    { prefix: "", count: agents.length },
    ...getCategoryPrefixes(allAgentFilenames)
  ], [allAgentFilenames, agents.length])
  const filteredBridgePrefixSuggestions = useMemo(() => {
    const query = bridgePipelinePrefix.toLowerCase()
    return bridgePrefixSuggestions.filter(({ prefix }) => !query || prefix.toLowerCase().includes(query))
  }, [bridgePipelinePrefix, bridgePrefixSuggestions])
   const [bridgeSuggestionIndex, setBridgeSuggestionIndex] = useState(0)
   const [bridgeSuggestionScrollOffset, setBridgeSuggestionScrollOffset] = useState(0)
  useEffect(() => {
    setBridgeSuggestionIndex(index => Math.min(index, Math.max(0, filteredBridgePrefixSuggestions.length - 1)))
    setBridgeSuggestionScrollOffset(offset => Math.min(offset, Math.max(0, filteredBridgePrefixSuggestions.length - 5)))
  }, [filteredBridgePrefixSuggestions.length])

  const refreshSourcesView = (preserveStatus = false) => {
    try {
      const registry = loadSources()
      setRegisteredSources(registry.sources)
      setSourceRevisions(Object.fromEntries(registry.sources.map(source => [source.name, sourceRevision(source)])))
      setActiveSourceName(registry.active)
    } catch (error: any) {
      setRegisteredSources([])
      setSourceRevisions({})
      if (!preserveStatus) setSourcesStatus(terminalSafeText(error?.message || error))
    }
    void (async () => {
      try {
        const auth = await inspectGhAuthAsync()
        setGhAuth(auth)
        if (auth.authenticated) {
          try {
            setGhRepos(await listGhReposAsync({ limit: 100 }))
          } catch (error: any) {
            setGhRepos([])
            if (!preserveStatus) setSourcesStatus(terminalSafeText(error?.message || error))
          }
        } else {
          setGhRepos([])
        }
      } catch (error: any) {
        setGhAuth({ available: false, authenticated: false, host: "github.com", message: terminalSafeText(error?.message || error) })
        setGhRepos([])
      }
      renderer.requestRender()
    })()
  }

  // Load agents and models on startup
  useEffect(() => {
    if (activeDataSource) {
      try { refreshData(activeDataSource) } catch (e) {
        setActionResultTitle("Error Refreshing Agents")
        setActionResultLines([`An error occurred:`, `  ${(e as any)?.message || e}`])
        setViewMode("action-result")
      }
    } else {
      refreshSourcesView(Boolean(startupNotice))
    }
    try {
       const catalog = loadModelCatalog(true)
       setModelCatalog(catalog)
       setModels(catalog.status === "verified" ? catalog.models : [])
    } catch (e) {
      // Ignore
    }
    renderer.requestRender()
  }, [])

  const invalidModelGroups = useMemo(() => collectInvalidModelGroups(agents, modelCatalog), [agents, modelCatalog])

  // Terminal dimensions are also the source of truth for the main screen budget.
  const { width: termWidth = 80, height: termHeight = 24 } = useTerminalDimensions() || {}
  const statusMessages = [
    uiConfigWarning ? `⚠ ${terminalSafeText(uiConfigWarning)}` : "",
    modelCatalog.status === "unavailable" ? "⚠ Model catalog unavailable — press M, then Y to retry." : "",
    modelCatalog.status === "verified" && invalidModelGroups.length > 0 ? `⚠ ${invalidModelGroups.length} invalid model group(s) — [V] Repair; [M] Choose a model.` : "",
    layoutStatus
  ].filter(Boolean)
  const statusMessage = statusMessages.join(" | ")
  const layout = calculateLayout(termWidth, termHeight, statusMessages.length > 0)
  // Keep the table's integer cell widths independent from percentage rounding.
  const panelWidths = calculatePanelWidths(termWidth, layout.mode, appliedShare)
  const listPanelWidth = panelWidths.list
  const listContentWidth = Math.max(0, listPanelWidth - 4)
  const footerFirstWidth = Math.floor(listContentWidth / 2)
  const footerSecondWidth = Math.max(0, listContentWidth - footerFirstWidth)
  const listColumns = calculateListColumnBudget(listContentWidth, "compact")
  const columnWidth = (index: number) => listColumns.widths[index] || 0
  const gutter = (key: string) => <text key={key} width={listColumns.gutters[0] || 0}> </text>
  const headerTitle = "★ OPENCODE AGENT MANAGER"
  const formatDisplayPath = (p: string) =>
    p === os.homedir() || p.startsWith(`${os.homedir()}${path.sep}`) ? `~${p.slice(os.homedir().length)}` : p
  const fullCommitLabel = isReadOnlyGitSource ? "Mode: OVERRIDES" : `Commit: ${autoCommitEnabled() ? "ON" : "OFF"}`
  const compactCommitLabel = isReadOnlyGitSource ? "OVR" : `C:${autoCommitEnabled() ? "ON" : "OFF"}`
  const workspaceLabel = !activeDataSource
    ? "Source: none ([O] connect)"
    : activeDataSource.kind === "workspace"
      ? `Workspace: ${formatDisplayPath(activeDataSource.root)}`
      : activeDataSource.source.kind === "git"
        ? `GitHub: ${activeDataSource.source.url.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "")}${activeDataSource.source.ref ? `#${activeDataSource.source.ref}` : ""}${activeRevision ? `@${activeRevision.slice(0, 7)}` : ""}`
        : `Source: ${activeDataSource.source.name} (${formatDisplayPath(activeDataSource.source.path)})`
  const headerSeparator = " | "
  const statusMessageWidth = Math.max(1, termWidth - 2)
  const headerContentWidth = Math.max(0, termWidth - 2 - 2 - 4)
  const headerTitleWidth = Math.max(1, Math.min(displayWidth(headerTitle), headerContentWidth - (termWidth >= 40 ? displayWidth(compactCommitLabel) + 1 : 0)))
  const headerMetaWidth = Math.max(0, headerContentWidth - headerTitleWidth - 1)
  const commitLabel = headerMetaWidth >= displayWidth(fullCommitLabel) ? fullCommitLabel : compactCommitLabel
  const commitWidth = displayWidth(commitLabel)
  const separatorWidth = displayWidth(headerSeparator)
  const showCommit = termWidth >= 40 && headerMetaWidth >= commitWidth
  const workspaceWidth = showCommit ? Math.max(0, headerMetaWidth - commitWidth - separatorWidth) : 0
  const visibleWorkspaceWidth = Math.min(workspaceWidth, displayWidth(workspaceLabel))
  const visibleMetaWidth = showCommit ? commitWidth + (visibleWorkspaceWidth > 0 ? separatorWidth + visibleWorkspaceWidth : 0) : 0
  const headerGroupWidth = Math.min(headerContentWidth, headerTitleWidth + 1 + visibleMetaWidth)
  const maxVisibleItems = layout.listRows
  const maxVisibleModels = Math.max(0, Math.floor(termHeight * 0.7) - 10)
  const maxVisibleTiers = Math.max(0, Math.floor(termHeight * 0.9) - 9)
  const maxVisibleColors = Math.max(0, Math.floor(termHeight * 0.7) - 9)
  const maxVisibleActionResultLines = Math.max(0, Math.floor(termHeight * 0.7) - 8)
  const modelModalInnerWidth = Math.max(1, Math.floor(termWidth * 0.7) - 6)
  const repairConfirmContentWidth = Math.max(1, Math.floor(termWidth * 0.76) - 6)

  const refreshModelCatalog = () => {
    const catalog = loadModelCatalog(undefined, true)
    setModelCatalog(catalog)
    setModels(catalog.status === "verified" ? catalog.models : [])
  }

  useEffect(() => {
    if (viewMode === "action-result") setActionResultScrollOffset(0)
  }, [viewMode, actionResultLines])

  useEffect(() => {
    setGraphScrollOffset(0)
  }, [focusedIndex])

  useEffect(() => {
    setResourceScrollIndex(0)
  }, [focusedIndex, inspectorTab])

  useEffect(() => {
    if (viewMode === "bridge-prompt") {
      setBridgeSuggestionIndex(0)
      setBridgeSuggestionScrollOffset(0)
    }
  }, [viewMode])

  useEffect(() => {
    const maxOffset = Math.max(0, actionResultLines.length - maxVisibleActionResultLines)
    setActionResultScrollOffset((offset) => Math.min(offset, maxOffset))
  }, [actionResultLines.length, maxVisibleActionResultLines])

  const refreshData = (ds: ActiveDataSource | null = activeDataSource) => {
    if (!ds) {
      setAgents([])
      return
    }
    if (ds.kind === "source" && ds.source.kind === "git") {
      setAgents(loadSourceAgents(ds.root))
    } else {
      setAgents(findAgentFiles(ds.root))
    }
  }

  const openSourcesModal = (preserveStatus = false) => {
    refreshSourcesView(preserveStatus)
    setSourcesInputFocused(false)
    setSourcesFocusIndex(0)
    setSourcesScrollOffset(0)
    if (!preserveStatus) setSourcesStatus("")
    setViewMode("sources")
  }

  const switchToDataSource = (next: ActiveDataSource) => {
    const loadedAgents = next.kind === "source" && next.source.kind === "git"
      ? loadSourceAgents(next.root)
      : findAgentFiles(next.root)
    const loadedConfig = loadTranslationFor(next)
    setActiveDataSource(next)
    setActiveRevision(next.kind === "source" ? sourceRevision(next.source) : null)
    if (next.kind === "source") setActiveSourceName(next.source.name)
    setAgents(loadedAgents)
    setTranslationConfig(loadedConfig)
    setSelectedAgentPaths(new Set())
    setExpandedCategories(new Set())
    setFocusedIndex(0)
    setScrollOffset(0)
    setSearchQuery("")
    setIsSearching(false)
    setLayoutStatus("")
    setViewMode("main")
  }

  const activateRegisteredSource = (source: Source) => {
    try {
      if (source.kind === "git" && !fs.existsSync(path.join(sourceRoot(source), ".git"))) {
        setSourcesStatus(`Pulling ${source.name}...`)
        pullSource(source)
      }
      const registry = loadSources()
      registry.active = source.name
      saveSources(registry)
      switchToDataSource({ kind: "source", source, root: sourceRoot(source) })
    } catch (error: any) {
      setSourcesStatus(`Could not open ${source.name}: ${terminalSafeText(error?.message || error)}`)
    }
  }

  const attachNewSourceSpec = (spec: string) => {
    const trimmed = spec.trim()
    if (!trimmed) return
    try {
      const registry = loadSources()
      const existing = registry.sources.find(candidate =>
        candidate.kind === "local"
          ? (() => { try { return candidate.path === fs.realpathSync(path.resolve(trimmed)) } catch { return false } })()
          : candidate.url.toLowerCase().replace(/\.git$/i, "") === `https://github.com/${trimmed.replace(/^(?:github|gh):/i, "").split("#")[0].replace(/\.git$/i, "").toLowerCase()}`
      )
      const source = existing ?? addSource(registry, deriveSourceName(trimmed, registry), trimmed)
      registry.active = source.name
      saveSources(registry)
      if (source.kind === "git" && !fs.existsSync(path.join(sourceRoot(source), ".git"))) {
        pullSource(source)
      }
      setSourcesQuery("")
      setSourcesInputFocused(false)
      switchToDataSource({ kind: "source", source, root: sourceRoot(source) })
    } catch (error: any) {
      setSourcesStatus(`Attach failed: ${terminalSafeText(error?.message || error)}`)
    }
  }

  const runInteractiveGhLogin = () => {
    try {
      renderer.suspend()
      let outcome: { ok: boolean; message: string }
      try {
        outcome = runGhWebLogin("github.com")
      } finally {
        renderer.resume()
        renderer.requestRender()
      }
      refreshSourcesView(true)
      setSourcesStatus(terminalSafeText(outcome.message))
    } catch (error: any) {
      setSourcesStatus(`GitHub login failed: ${terminalSafeText(error?.message || error)}`)
    }
  }

  const applyAgentMutation = (
    paths: string[],
    fn: (writer?: typeof saveAgentFile) => void,
    title: string,
    lines: string[],
  ) => {
    if (!isReadOnlyGitSource) {
      const tx = mutate(paths, "tune", () => fn(undefined))
      try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); setViewMode("action-result"); return }
      setSelectedAgentPaths(new Set())
      setMutationSuccess(title, lines, tx.warning)
      setViewMode("action-result")
      return
    }
    void (async () => {
      try {
        runWithOverrideWriter(workspaceRoot, writer => fn(writer))
        refreshData()
        setSelectedAgentPaths(new Set())
        const outcome = await reconcileTargetIfInstalled("override")
        setActionResultTitle(title)
        setActionResultLines([...lines, "", ...formatReconcileLines(outcome)])
      } catch (error: any) {
        setActionResultTitle(`Error: ${title}`)
        setActionResultLines([`An error occurred:`, `  ${error?.message || error}`])
      }
      setViewMode("action-result")
    })()
  }

  const packDescription = (pack: string) => {
    const dir = packDir(workspaceRoot, pack)
    if (!dir) return "Not a pack of this workspace."
    try {
      const description = readManifest(dir).description
      return typeof description === "string" && description ? description : "No description in opencode-pack.json."
    } catch (error: any) {
      return `Unreadable opencode-pack.json: ${error?.message || error}`
    }
  }

  const openResourceManager = (agent: AgentInfo) => {
    try {
      const catalog = discoverAgentResources(workspaceRoot, agent, agents)
      setResourceTargetAgent(agent)
      setResourceCatalog(catalog)
      setDraftSkillAll(catalog.skills.find(item => item.kind === "skill-wildcard")?.allowed || false)
      setDraftAllowedSkills(new Set(catalog.skills.filter(item => item.kind === "skill" && item.allowed).map(item => item.name)))
      setDraftPermissions(Object.fromEntries([...catalog.tools, ...catalog.mcpServers].map(item => [item.permissionKey, item.allowed])))
      setExplicitResourcePermissions(new Set(catalog.tools
        .filter(item => item.kind === "tool" && item.familyKey && Object.prototype.hasOwnProperty.call(agent.frontmatter.permission || {}, item.permissionKey))
        .map(item => item.permissionKey)))
      setResourceModalFocusIndex(0)
      setResourceModalScrollOffset(0)
      setLayoutStatus("")
      setViewMode("resource-manager")
    } catch (error: any) {
      setLayoutStatus(terminalSafeText(error?.message || error))
    }
  }

  // Installs a pack of this workspace or active registered source into the OpenCode config.
  const installRequest = (pack: string) => {
    const registry = loadSources()
    if (activeDataSource?.kind === "source") {
      const source = findSource(registry, activeDataSource.source.name)
      return { registry, added: false, request: `${source.name}/${pack}`, sourceName: source.name }
    }
    const root = fs.realpathSync(workspaceRoot)
    let source = registry.sources.find(candidate => candidate.kind === "local" && candidate.path === root)
    const added = !source
    if (!source) {
      source = addSource(registry, deriveSourceName(root, registry), root)
    }
    return { registry, added, request: `${source.name}/${pack}`, sourceName: source.name }
  }

  const previewInstall = (pack: string) => {
    if (!packDir(workspaceRoot, pack)) {
      setLayoutStatus(`${pack} is not a pack of this workspace.`)
      return
    }
    const target = defaultTarget()
    void (async () => {
      try {
        const { registry, added, request, sourceName } = installRequest(pack)
        const result = await changeTarget(target, "install", registry, installChange(registry, [request]), { dryRun: true })
        setInstallPreview({
          pack, target,
          lines: [...(added ? [`This workspace will be registered as source "${sourceName}".`, ""] : []), ...describeChangeResult(target, result)],
          confirmations: result.confirmations,
          blocked: result.status === "failed",
          lockText: result.change ? serializeLock(result.change.lock) : "",
        })
        setViewMode("install-confirm")
      } catch (error: any) {
        setActionResultTitle("Install Preview Failed")
        setActionResultLines([`An error occurred:`, `  ${terminalSafeText(error?.message || error)}`])
        setViewMode("action-result")
      }
    })()
  }

  const applyInstall = (preview: InstallPreview) => {
    const fail = (error: any) => {
      setActionResultTitle("Install Failed")
      setActionResultLines([`An error occurred:`, `  ${terminalSafeText(error?.message || error)}`])
    }
    void (async () => {
      let prepared: ReturnType<typeof installRequest>
      try {
        prepared = installRequest(preview.pack)
      } catch (error) {
        fail(error)
        setViewMode("action-result")
        return
      }
      const { registry, added, request, sourceName } = prepared
      let succeeded = false
      try {
        // Saved first, so an applied lock never names a source the registry lacks; dropped again if nothing was installed.
        if (added) saveSources(registry)
        // The user approved the preview: install it only if the packs and the confirmations are still the same.
        const compute = installChange(registry, [request])
        const result = await changeTarget(preview.target, "install", registry, current => {
          const change = compute(current)
          return change.problems.length || serializeLock(change.lock) === preview.lockText
            ? change
            : { ...change, problems: ["the packs changed since the preview; press e again to review the new version"] }
        }, { confirm: async reasons => isDeepStrictEqual([...reasons].sort(), [...preview.confirmations].sort()) })
        succeeded = result.status === "applied" || result.status === "unchanged"
        setActionResultTitle(succeeded ? "Install Complete" : "Install Failed")
        setActionResultLines(describeChangeResult(preview.target, result))
      } catch (error) {
        fail(error)
      }
      if (!succeeded && added) {
        try {
          const current = loadSources()
          if (current.sources.some(source => source.name === sourceName)) {
            removeSource(current, sourceName)
            saveSources(current)
          }
        } catch {
          // The source registration only made the failed install possible; leaving it is harmless.
        }
      }
      setViewMode("action-result")
    })()
  }

  const setMutationRefreshFailure = (error: unknown, warning?: TransactionWarning) => {
    setActionResultTitle("Change completed, refresh failed")
    setActionResultLines([
      ...(warning ? [`⚠ AUTO-COMMIT: ${warning.message}`, `  ${warning.recovery}`, ""] : []),
      `An error occurred:`, `  ${(error as any)?.message || error}`
    ])
    setViewMode("action-result")
  }

  const inferenceIndex = useMemo(
    () => translationConfig ? buildInferenceIndex(agents, translationConfig) : null,
    [agents, translationConfig]
  )
  const resolvedAgents = useMemo(() => {
    if (!translationConfig || !inferenceIndex) return new Map<string, ReturnType<typeof resolveModelTarget>>()
    return new Map(agents.map(agent => [agent.currentPath, resolveModelTarget(agent, inferenceIndex, translationConfig, "claude")]))
  }, [agents, inferenceIndex, translationConfig])

  const generateBridge = () => {
    if (!bridgePluginName || !activeDataSource) return
    try {
      const bridgeConfig = loadTranslationFor(activeDataSource) ?? loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false })
      const modelTarget = bridgeModelTarget.trim()
      const modelMap = bridgeConfig[bridgeTarget].modelMap
      if (modelTarget) {
        // Claude aliases need validation; Codex model ids are validated as non-empty strings on save.
        if (bridgeTarget === "claude") validateClaudeModelName(modelTarget)
        const nextModelMap = { ...modelMap, "*": modelTarget }
        if (bridgeTarget === "codex") bridgeConfig.codex.modelMap = nextModelMap
        else bridgeConfig.claude.modelMap = nextModelMap
      } else if (modelMap) {
        delete modelMap["*"]
      }
      const pack = activeItems[focusedIndex]?.category || ""
      if (!packDir(workspaceRoot, pack)) {
        setActionResultTitle("No Pack to Bridge")
        setActionResultLines(["Focus an agent or a pack folder: the bridge translates a whole pack."])
        setViewMode("action-result")
        return
      }
      const safePluginName = sanitizeFilename(bridgePluginName)
      const config = { ...bridgeConfig, pluginName: bridgePluginName, prefix: bridgePipelinePrefix }
      let result: ReturnType<typeof bridgePack>
      let txWarning: TransactionWarning | undefined
      if (activeDataSource.kind === "source" && activeDataSource.source.kind === "git") {
        const loc = sourceTranslationConfigLocation(activeDataSource.source.name, workspaceRoot)
        const outputDir = sourceBridgeOutputDir(activeDataSource.source.name, bridgeTarget, safePluginName)
        saveTranslationConfig(loc.configRoot, config, loc.configPath)
        result = bridgePack({ workspaceRoot, pack, target: bridgeTarget, outputDir, config, pluginName: bridgePluginName, prefix: bridgePipelinePrefix })
      } else {
        const outputDir = path.join(workspaceRoot, "bridges", bridgeTarget === "codex" ? "codex" : "claude-code", safePluginName)
        const tx = mutate([translationConfigPath(workspaceRoot), outputDir], "bridge", () => {
          saveTranslationConfig(workspaceRoot, config)
          return bridgePack({ workspaceRoot, pack, target: bridgeTarget, outputDir, config, pluginName: bridgePluginName, prefix: bridgePipelinePrefix })
        })
        result = tx.value
        txWarning = tx.warning
      }
      setTranslationConfig(loadTranslationFor(activeDataSource))
       setSelectedAgentPaths(new Set())
      setActionResultTitle(`Bridge to ${bridgeTarget === "codex" ? "Codex" : "Claude Code"} Complete`)
      const lines = [`${bridgeTarget === "codex" ? "Translation layer" : "Plugin"} '${safePluginName}' generated successfully!`, `Output directory:`, `  ${result.pluginDir}`, ``, `Generated ${result.files.length} files:`, ...result.files.map((f) => `  * ${f}`)]
      if (result.warnings.length > 0) lines.push(``, `⚠ Warnings:`, ...result.warnings.map((w) => `  * ${w}`))
      if (result.preview?.length) {
        const counts = result.preview.reduce<Record<string, number>>((acc, item) => { acc[item.source] = (acc[item.source] || 0) + 1; return acc }, {})
        lines.push(``, `Preview summary: ${Object.entries(counts).map(([source, count]) => `${count} by ${source}`).join(", ")}`, ...result.preview.map(item => `  ${item.agent} → ${item.role} → ${item.tier} → ${item.model} → ${item.source}`))
      }
      lines.push(``, ...(bridgeTarget === "codex" || !("pluginName" in result) ? [`Codex project-scoped agents:`, `  cd ${result.pluginDir} && codex`, ``, `Plugin manifest:`, `  ${result.pluginDir}/.codex-plugin/plugin.json`] : [`Validate and run locally:`, ...claudeNextSteps(result.pluginName, result.orchestratorName, result.pluginDir)]))
      if (bridgeTarget === "claude" && "pluginName" in result) {
        let registrationSkipped = false
        if (bridgeConfig.claude.autoValidate !== false) {
          const validation = validatePlugin(result.pluginDir)
          lines.push(``, `Validation: ${validation.kind}`, `  ${validation.message}`)
          if (validation.detail) lines.push(`  ${validation.detail}`)
          if (validation.kind === "fail") {
            registrationSkipped = true
            lines.push(`  ⚠ Registration skipped: validation failed.`)
          } else if (validation.kind === "error") {
            registrationSkipped = true
            lines.push(`  ⚠ Registration skipped: validation could not decide (unexpected CLI error).`)
          }
        }
        if (bridgeConfig.claude.autoRegister !== false && !registrationSkipped) {
          if (result.marketplaceName === null) {
            lines.push(``, `Registration skipped: no marketplace manifest is emitted (claude.emitMarketplace is off).`)
          } else {
            const registration = registerPlugin(result.pluginDir, result.pluginName, result.marketplaceName)
            lines.push(``, `Registration: ${registration.kind}`, `  ${registration.message}`)
            if (registration.detail) lines.push(`  ${registration.detail}`)
          }
        }
      }
       try { refreshData() } catch (error) { setMutationRefreshFailure(error, txWarning); setViewMode("action-result"); return }
       setMutationSuccess(`Bridge to ${bridgeTarget === "codex" ? "Codex" : "Claude Code"} Complete`, lines, txWarning)
      setViewMode("action-result")
    } catch (error: any) {
      setActionResultTitle("Error During Bridge")
      setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
      setViewMode("action-result")
    }
  }

  // Build color tree items
  const colorTreeItems = useMemo<ColorTreeItem[]>(() => {
    const items: ColorTreeItem[] = []
    COLOR_PALETTE.forEach(group => {
      const isExpanded = expandedColorGroups.has(group.group)
      items.push({
        type: "group",
        id: group.group,
        label: `${isExpanded ? "▼" : "▶"} ${group.emoji} ${group.group.toUpperCase()} (${group.colors.length})`,
        group: group.group,
        hex: "",
        value: ""
      })
      if (isExpanded) {
        group.colors.forEach(color => {
          items.push({
            type: "color",
            id: color.value,
            label: `  ${color.name}`,
            group: group.group,
            hex: color.hex,
            value: color.value
          })
        })
      }
    })
    return items
  }, [expandedColorGroups])

  // Clamp color index on layout tree size updates
  useEffect(() => {
    if (focusedColorIndex >= colorTreeItems.length) {
      const nextIndex = Math.max(0, colorTreeItems.length - 1)
      setFocusedColorIndex(nextIndex)
      updateColorScroll(nextIndex)
    }
  }, [colorTreeItems.length])

  // Filter and build active list items in real-time
  const activeItems = useMemo<ActiveItem[]>(() => {
    const filtered = agents.filter((a) =>
      a.filename.toLowerCase().includes(searchQuery.toLowerCase())
    )

    const items: ActiveItem[] = []

    // Get unique categories dynamically from the parsed agents
    const categoriesSet = new Set<string>()
    agents.forEach((a) => categoriesSet.add(a.category))
    const categoriesList = Array.from(categoriesSet).sort((a, b) => {
      if (a === "general") return 1
      if (b === "general") return -1
      return a.localeCompare(b)
    })
    categoriesList.forEach((cat) => {
      const catAgents = filtered.filter((a) => a.category === cat)
      if (catAgents.length === 0) return

      // A search opens every folder with matches, like the provider folders of the model selector.
      const isExpanded = searchQuery.trim() !== "" || expandedCategories.has(cat)
      items.push({
        type: "folder",
        id: cat,
        label: `${isExpanded ? "▼" : "▶"} 📁 ${cat.toUpperCase()} (${catAgents.length})`,
        category: cat
      })

      if (isExpanded) {
        catAgents.forEach((a) => {
          items.push({
            type: "file",
            id: a.currentPath,
            label: `  ${a.filename}`,
            category: cat,
            agent: a
          })
        })
      }
    })

    return items
  }, [agents, searchQuery, expandedCategories])

  const delegationItems = useMemo(
    () => delegationTargetAgent
      ? agents.filter((a) => a.filename.replace(/\.md$/, "") !== delegationTargetAgent.filename.replace(/\.md$/, ""))
      : [],
    [agents, delegationTargetAgent]
  )

  // Clamp focusedIndex and scrollOffset when list size changes
  useEffect(() => {
    setFocusedIndex(0)
    setScrollOffset(0)
  }, [searchQuery])

  useEffect(() => {
    if (focusedIndex < 0 || focusedIndex >= activeItems.length) {
      const nextIndex = Math.max(0, activeItems.length - 1)
      setFocusedIndex(nextIndex)
      updateScroll(nextIndex)
    }
  }, [activeItems.length])

  useEffect(() => {
    const maxOffset = Math.max(0, activeItems.length - maxVisibleItems)
    setScrollOffset(offset => Math.min(offset, maxOffset))
  }, [activeItems.length, maxVisibleItems])

  // A resize can make the focused row fall below the new viewport. Keep both
  // focus and offset valid whenever the available list height changes.
  useEffect(() => {
    setScrollOffset(offset => {
      const maxOffset = Math.max(0, activeItems.length - maxVisibleItems)
      if (maxVisibleItems <= 0) return 0
      if (focusedIndex < offset) return Math.max(0, focusedIndex)
      if (focusedIndex >= offset + maxVisibleItems) {
        return Math.min(maxOffset, focusedIndex - maxVisibleItems + 1)
      }
      return Math.min(offset, maxOffset)
    })
  }, [maxVisibleItems])

  interface ModelTreeItem {
    type: "provider" | "model"
    id: string // provider name or full model name
    label: string
    provider: string
  }

  // Group models by provider and build tree items
  const modelTreeItems = useMemo<ModelTreeItem[]>(() => {
    const words = modelFilter.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (value: string) => words.every(word => value.toLowerCase().includes(word))
    const providers: Record<string, string[]> = {}
    models.filter(matches).forEach(model => {
      const parts = model.split("/")
      const provider = parts.length > 1 ? parts[0] : "other"
      if (!providers[provider]) {
        providers[provider] = []
      }
      providers[provider].push(model)
    })

    const items: ModelTreeItem[] = []
    if (viewMode === "repair-selector" && repairGroupKey !== null) {
      const group = invalidModelGroups[Number(repairGroupKey)]
      const suggestions = group ? suggestModels(group.value, modelCatalog) : []
      suggestions.filter(matches).forEach(model => items.push({ type: "model", id: model, label: `★ ${model}`, provider: "suggestions" }))
    }
    if (viewMode === "model-selector" && routingPick?.kind === "trigger") {
      if (matches("* any model provider wildcard")) {
        const mark = pendingTriggers.has(WILDCARD_TRIGGER) ? "[x]" : "[ ]"
        items.push({ type: "model", id: WILDCARD_TRIGGER, label: `${mark} ★ * (any model / provider)`, provider: "wildcard" })
      }
    }
    if (viewMode === "model-selector" && routingPick?.kind === "roles") {
      items.push({ type: "model", id: INHERIT, label: "↺ inherit (use the calling agent's model)", provider: "routing" })
    }
    Object.keys(providers).forEach(prov => {
      const isExpanded = words.length > 0 || expandedProviders.has(prov)
      items.push({
        type: "provider",
        id: prov,
        label: `${isExpanded ? "▼" : "▶"} 📁 ${prov.toUpperCase()} (${providers[prov].length})`,
        provider: prov
      })

      if (isExpanded) {
        // A configuration can trigger on one or more providers/models in OR; exact model wins over provider, then *.
        if (viewMode === "model-selector" && routingPick?.kind === "trigger") {
          const mark = pendingTriggers.has(prov) ? "[x]" : "[ ]"
          items.push({ type: "model", id: prov, label: `  ${mark} ★ any ${prov} model`, provider: prov })
        }
        providers[prov].forEach(model => {
          const prefix = viewMode === "model-selector" && routingPick?.kind === "trigger"
            ? `${pendingTriggers.has(model) ? "[x]" : "[ ]"} `
            : ""
          items.push({
            type: "model",
            id: model,
            label: `  ${prefix}${model.split("/").slice(1).join("/")}`,
            provider: prov
          })
        })
      }
    })
    return items
  }, [models, expandedProviders, viewMode, repairGroupKey, invalidModelGroups, modelCatalog, routingPick, pendingTriggers, modelFilter])
  useEffect(() => {
    if (viewMode !== "model-selector" && viewMode !== "repair-selector") setModelFilter("")
  }, [viewMode])

  const sourceModalRows = useMemo<SourceModalRow[]>(() => {
    const query = sourcesQuery.trim().toLowerCase()
    const rows: SourceModalRow[] = []
    const registeredGitUrls = new Set(
      registeredSources
        .filter((s): s is Source & { kind: "git" } => s.kind === "git")
        .map(s => s.url.toLowerCase().replace(/\.git$/i, ""))
    )
    for (const source of registeredSources) {
      const targetText = source.kind === "local" ? source.path : source.url
      if (query && !source.name.toLowerCase().includes(query) && !targetText.toLowerCase().includes(query)) continue
      rows.push({
        id: `reg:${source.name}`,
        kind: "registered",
        source,
        revision: sourceRevisions[source.name] ?? null,
        isActive: (activeDataSource?.kind === "source" ? activeDataSource.source.name : activeSourceName) === source.name,
      })
    }
    for (const repo of ghRepos) {
      if (registeredGitUrls.has(repo.url.toLowerCase().replace(/\.git$/i, ""))) continue
      if (query && !repo.nameWithOwner.toLowerCase().includes(query) && !repo.description.toLowerCase().includes(query)) continue
      rows.push({ id: `gh:${repo.nameWithOwner}`, kind: "gh-repo", repo })
    }
    if (sourcesQuery.trim()) {
      rows.push({ id: "connect-input", kind: "connect-input", spec: sourcesQuery.trim() })
    }
    return rows
  }, [registeredSources, sourceRevisions, ghRepos, sourcesQuery, activeDataSource, activeSourceName])

  const maxVisibleSourceRows = Math.max(2, Math.floor(termHeight * 0.78) - 11)
  useEffect(() => {
    if (sourcesFocusIndex >= sourceModalRows.length) {
      const next = Math.max(0, sourceModalRows.length - 1)
      setSourcesFocusIndex(next)
      setSourcesScrollOffset(offset => Math.min(offset, Math.max(0, sourceModalRows.length - maxVisibleSourceRows)))
    }
  }, [sourceModalRows.length, maxVisibleSourceRows])

  const routingLoad = useMemo((): { view: ReturnType<typeof describeConfiguredPackFlows>; error: string } => {
    if (!routingArchetype || !workspaceRoot) return { view: null, error: "" }
    try {
      const view = describeConfiguredPackFlows(workspaceRoot, routingArchetype, {
        applySourceOverrides: isReadOnlyGitSource,
      })
      return { view, error: "" }
    } catch (error: any) {
      return { view: null, error: error?.message || String(error) }
    }
  }, [workspaceRoot, isReadOnlyGitSource, routingArchetype, routingRevision, agents])
  const routingView = routingLoad.view
  const routingVariantChoices = (model: string) => {
    const variants = getModelVariants(modelCatalog, model)
    return variants !== null ? ["", ...variants] : ["", ...AGENT_EFFORT_VARIANTS]
  }
  const withRoutingVariant = (model: string, variant: string) => {
    const base = model.split("#")[0]
    return variant && routingVariantChoices(base).includes(variant) ? `${base}#${variant}` : base
  }
  const summarizeUnifiedFlow = (flow: Pick<UnifiedFlowItem, "roles" | "tools" | "permissions" | "delegations">, related: ArchetypeAgent[]) => {
    const parts: string[] = []
    if (related.length > 0) {
      const groups = new Map<string, string[]>()
      for (const agent of related) {
        const model = flow.roles[agent.role] ?? INHERIT
        groups.set(model, [...(groups.get(model) ?? []), agent.role])
      }
      const modelSummary = [...groups]
        .map(([model, names]) => model === INHERIT ? `${names.join(", ")} ${names.length === 1 ? "inherits" : "inherit"}` : `${names.join(", ")} → ${model}`)
        .join(" · ")
      if (modelSummary) parts.push(modelSummary)
    }
    const toolEntries = Object.entries(flow.tools)
    if (toolEntries.length > 0) parts.push(`tools: ${toolEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`)
    const permEntries = Object.entries(flow.permissions)
    if (permEntries.length > 0) parts.push(`perms: ${permEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`)
    const delEntries = Object.entries(flow.delegations)
    if (delEntries.length > 0) parts.push(`delegations: ${delEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`)
    return parts.join("  |  ") || "no overrides"
  }
  const formatTriggerLabel = (triggers: string[]) =>
    triggers.map(t => t === WILDCARD_TRIGGER ? "* (any model)" : t.includes("/") ? t : `${t} (any model)`).join(" OR ")

  const isWorkspaceVirtualPack = useMemo(
    () => Boolean(workspaceRoot && !isReadOnlyGitSource && isVirtualPackRoot(workspaceRoot)),
    [workspaceRoot, isReadOnlyGitSource, agents],
  )
  const saveFlowDraft = (draft: FlowDraftInput | null, previousKey?: string): { ok: boolean; savedKey?: string | null } => {
    if (!routingArchetype) return { ok: false }
    try {
      const savedKey = saveUserPackFlow(workspaceRoot, routingArchetype, draft, {
        previousKey,
        applySourceOverrides: isReadOnlyGitSource,
      })
      setRoutingRevision(revision => revision + 1)
      const label = draft ? formatTriggerLabel(draft.triggers) : previousKey ?? ""
      setRoutingStatus(`${draft ? "Saved" : "Removed"} flow '${label}' in routing.json; reconciling target...`)
      void reconcileTargetIfInstalled("models").then(outcome => {
        setRoutingStatus(`${draft ? "Saved" : "Removed"} flow '${label}'. ${formatReconcileLines(outcome)[0]}`)
      }).catch(error => {
        setRoutingStatus(`Saved in routing.json; reconcile failed: ${terminalSafeText(error?.message || error)}`)
      })
      return { ok: true, savedKey }
    } catch (error: any) {
      setRoutingStatus(`Error: ${terminalSafeText(error?.message || error)}`)
      return { ok: false }
    }
  }
  /** Save a draft at once into user settings (routing.json) and refresh the baseline key from the saved key. */
  const applyRoutingDraft = (next: RoutingDraftState): boolean => {
    const roles: RoleModels = Object.fromEntries(Object.entries<string>(next.roles).filter(([, model]) => model !== INHERIT))
    const cleaned: FlowDraftInput = {
      ...(next.callers?.length ? { callers: next.callers } : {}),
      triggers: next.triggers,
      roles,
      tools: next.tools,
      permissions: next.permissions,
      delegations: next.delegations,
    }
    const res = saveFlowDraft(cleaned, next.previousKey)
    if (!res.ok) return false
    setRoutingDraft({ ...cleaned, previousKey: res.savedKey ?? next.previousKey })
    return true
  }
  const exportRoutingToManifest = () => {
    if (!routingView || isReadOnlyGitSource) return
    try {
      const manifestFile = path.join(routingView.dir, "opencode-pack.json")
      const tx = mutate([manifestFile], "routing", () => exportFlowsToPackManifest(workspaceRoot, routingView))
      setRoutingRevision(revision => revision + 1)
      setRoutingStatus(`Exported callers & conditional flows to ${path.relative(workspaceRoot, manifestFile) || "opencode-pack.json"}.${tx.warning ? ` ⚠ auto-commit: ${tx.warning.message}` : ""}`)
    } catch (error: any) {
      setRoutingStatus(`Error: ${terminalSafeText(error?.message || error)}`)
    }
  }
  const openInitPackModal = () => {
    const slug = derivePackSlug(path.basename(path.resolve(workspaceRoot)))
    setInitPackName(slug)
    setInitPackVersion("0.1.0")
    setInitPackDesc(`Agent pack ${slug}`)
    setInitPackOrganize(true)
    setInitPackField("name")
    setViewMode("pack-init")
  }
  const openRoutingPicker = (pick: RoutingPick, current?: string | string[]) => {
    if (modelCatalog.status !== "verified" && !(pick.kind === "trigger" && models.length === 0)) {
      if (modelCatalog.status !== "verified" && pick.kind === "roles") {
        setRoutingStatus("Model catalog is unavailable; press CTRL+R in model picker or check OpenCode.")
        return
      }
    }
    const list = Array.isArray(current) ? current : current ? [current] : []
    for (const item of list) {
      const provider = item && item !== INHERIT && item !== WILDCARD_TRIGGER ? item.split("/")[0] : ""
      if (provider) setExpandedProviders(previous => new Set([...previous, provider]))
    }
    if (pick.kind === "trigger") setPendingTriggers(new Set(list))
    setRoutingPick(pick)
    setFocusedModelIndex(0)
    setModelScrollOffset(0)
    setViewMode("model-selector")
  }

  // Clamp model index on layout tree size updates
  useEffect(() => {
    if (focusedModelIndex >= modelTreeItems.length) {
      const nextIndex = Math.max(0, modelTreeItems.length - 1)
      setFocusedModelIndex(nextIndex)
      updateModelScroll(nextIndex)
    }
  }, [modelTreeItems.length])

  // Keyboard navigation and actions
  useKeyboard((e) => {
    const key = e.name.toLowerCase()
    const rawChar = /^[\x20-\x7E]$/.test(e.sequence)
      ? e.sequence
      : e.shift
        ? e.name.toUpperCase()
        : e.name
    const isUppercaseF = key === "f" && (e.sequence === "F" || !!e.shift)
    const isUppercaseL = key === "l" && (e.sequence === "L" || !!e.shift)

    // 1. Intercept search input mode
    if (isSearching) {
      if (key === "escape") {
        setSearchQuery("")
        setIsSearching(false)
      } else if (key === "enter" || key === "return") {
        setIsSearching(false)
      } else if (key === "backspace") {
        setSearchQuery((q) => q.slice(0, -1))
      } else if (/^[\x20-\x7E]$/.test(rawChar)) {
        setSearchQuery((q) => q + rawChar)
      }
      return
    }

    // Layout modal owns these keys before they can affect the agent tree.
    if (viewMode === "layout") {
      if (key === "left" || key === "h" || key === "down") {
        const next = adjustListShare(layoutDraft, -0.01); setLayoutDraft(next); setAppliedShare(next)
      } else if (key === "right" || (key === "l" && !isUppercaseL) || key === "up") {
        const next = adjustListShare(layoutDraft, 0.01); setLayoutDraft(next); setAppliedShare(next)
      } else if (key === "home") {
        setLayoutDraft(0.60); setAppliedShare(0.60)
      } else if (key === "end") {
        setLayoutDraft(0.75); setAppliedShare(0.75)
      } else if (key === "r") {
        const next = resetListShare(); setLayoutDraft(next); setAppliedShare(next)
      } else if (key === "escape") {
        setLayoutDraft(layoutSnapshot); setAppliedShare(layoutSnapshot); setLayoutError(""); setViewMode("main")
      } else if (key === "enter" || key === "return") {
        if (configReadOnly) {
          setLayoutError("Read-only environment override: preview only; Enter does not save.")
        } else {
          try {
             const revision = saveUiConfig(engineConfigDir(), layoutDraft, uiConfigRevisionState)
             setUiConfigRevision(revision)
            setLayoutSnapshot(layoutDraft); setAppliedShare(layoutDraft); setLayoutError(""); setLayoutStatus("Layout saved")
            setActionResultTitle("Layout saved")
            setActionResultLines(["List/inspector proportions saved."])
            setViewMode("main")
          } catch (error: any) {
            if (error?.message === "configuration changed; reload and retry") {
              const current = loadUiConfig()
              setUiConfigRevision(current.revision)
              setLayoutStatus("Configuration changed externally. Reloaded revision; press Enter again to overwrite with current preview, or Esc.")
            } else {
              setLayoutError(terminalSafeText(error?.message || error).slice(0, 160))
            }
          }
        }
      }
      return
    }

    if (viewMode === "sources") {
      const clampScroll = (nextIndex: number, total: number) => {
        setSourcesScrollOffset(offset => {
          if (total <= 0) return 0
          if (nextIndex < offset) return Math.max(0, nextIndex)
          if (nextIndex >= offset + maxVisibleSourceRows) return Math.max(0, nextIndex - maxVisibleSourceRows + 1)
          return Math.min(offset, Math.max(0, total - maxVisibleSourceRows))
        })
      }
      if (key === "g" && e.ctrl) {
        runInteractiveGhLogin()
        return
      }
      if (sourcesInputFocused) {
        if (key === "escape") {
          setSourcesInputFocused(false)
        } else if (key === "up" || key === "down") {
          if (!sourceModalRows.length) return
          const delta = key === "up" ? -1 : 1
          const next = (sourcesFocusIndex + delta + sourceModalRows.length) % sourceModalRows.length
          setSourcesFocusIndex(next)
          clampScroll(next, sourceModalRows.length)
        } else if (key === "backspace") {
          setSourcesQuery(q => q.slice(0, -1))
          setSourcesFocusIndex(0)
          setSourcesScrollOffset(0)
        } else if (key === "enter" || key === "return") {
          const row = sourceModalRows[sourcesFocusIndex]
          if (row?.kind === "registered") activateRegisteredSource(row.source)
          else if (row?.kind === "gh-repo") attachNewSourceSpec(`github:${row.repo.nameWithOwner}`)
          else if (row?.kind === "connect-input") attachNewSourceSpec(row.spec)
          else if (sourcesQuery.trim()) attachNewSourceSpec(sourcesQuery.trim())
        } else if (!e.ctrl && !e.meta && /^[\x20-\x7E]$/.test(rawChar)) {
          setSourcesQuery(q => q + rawChar)
          setSourcesFocusIndex(0)
          setSourcesScrollOffset(0)
        }
        return
      }

      if (key === "escape") {
        if (sourcesQuery) {
          setSourcesQuery("")
          setSourcesFocusIndex(0)
          setSourcesScrollOffset(0)
        } else if (activeDataSource) {
          setViewMode("main")
        } else {
          setSourcesStatus("Connect a GitHub repository or local folder first (or press Ctrl+C to quit).")
        }
      } else if (key === "/" || key === "a") {
        setSourcesInputFocused(true)
        setSourcesStatus("")
      } else if (key === "g") {
        runInteractiveGhLogin()
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        if (!sourceModalRows.length) return
        const delta = key === "up" || key === "k" ? -1 : 1
        const next = (sourcesFocusIndex + delta + sourceModalRows.length) % sourceModalRows.length
        setSourcesFocusIndex(next)
        clampScroll(next, sourceModalRows.length)
      } else if (key === "pageup" || key === "pagedown") {
        if (!sourceModalRows.length) return
        const delta = key === "pageup" ? -maxVisibleSourceRows : maxVisibleSourceRows
        const next = Math.max(0, Math.min(sourceModalRows.length - 1, sourcesFocusIndex + delta))
        setSourcesFocusIndex(next)
        clampScroll(next, sourceModalRows.length)
      } else if (key === "p" || (key === "r" && e.ctrl)) {
        const row = sourceModalRows[sourcesFocusIndex]
        if (row?.kind === "registered" && row.source.kind === "git") {
          try {
            const commit = pullSource(row.source)
            refreshSourcesView(true)
            if (activeDataSource?.kind === "source" && activeDataSource.source.name === row.source.name) {
              setActiveRevision(commit)
              refreshData(activeDataSource)
            }
            setSourcesStatus(`Pulled ${row.source.name}: ${commit?.slice(0, 12) ?? "up to date"}.`)
          } catch (error: any) {
            setSourcesStatus(`Pull failed: ${terminalSafeText(error?.message || error)}`)
          }
        } else {
          refreshSourcesView(true)
          setSourcesStatus("Refreshed sources and GitHub repository list.")
        }
      } else if (key === "t") {
        const row = sourceModalRows[sourcesFocusIndex]
        if (row?.kind === "registered") {
          try {
            const registry = loadSources()
            const target = findSource(registry, row.source.name)
            target.trusted = !target.trusted
            saveSources(registry)
            if (activeDataSource?.kind === "source" && activeDataSource.source.name === target.name) {
              setActiveDataSource({ ...activeDataSource, source: { ...target } })
            }
            refreshSourcesView(true)
            setSourcesStatus(`Source "${target.name}" is now ${target.trusted ? "trusted" : "untrusted"}.`)
          } catch (error: any) {
            setSourcesStatus(terminalSafeText(error?.message || error))
          }
        }
      } else if (key === "x" || key === "delete" || key === "backspace") {
        const row = sourceModalRows[sourcesFocusIndex]
        if (row?.kind === "registered") {
          try {
            const registry = loadSources()
            removeSource(registry, row.source.name)
            saveSources(registry)
            if (activeDataSource?.kind === "source" && activeDataSource.source.name === row.source.name) {
              const fallback = registry.sources[0]
              if (fallback) {
                try {
                  switchToDataSource({ kind: "source", source: fallback, root: sourceRoot(fallback) })
                  openSourcesModal(true)
                } catch {
                  setActiveDataSource(null)
                  setAgents([])
                }
              } else {
                setActiveDataSource(null)
                setAgents([])
              }
            }
            refreshSourcesView(true)
            setSourcesStatus(`Removed source "${row.source.name}".`)
          } catch (error: any) {
            setSourcesStatus(terminalSafeText(error?.message || error))
          }
        }
      } else if (key === "enter" || key === "return") {
        const row = sourceModalRows[sourcesFocusIndex]
        if (row?.kind === "registered") activateRegisteredSource(row.source)
        else if (row?.kind === "gh-repo") attachNewSourceSpec(`github:${row.repo.nameWithOwner}`)
        else if (row?.kind === "connect-input") attachNewSourceSpec(row.spec)
      }
      return
    }

    // 2. Main view mode
    if (viewMode === "main") {
      if (key === "o") {
        openSourcesModal()
      } else if (key === "l" && isUppercaseL) {
        if (!isSearching) { setLayoutSnapshot(appliedShare); setLayoutDraft(appliedShare); setLayoutError(""); setLayoutStatus(""); setViewMode("layout") }
      } else if ((key === "up" || key === "k") && (inspectorTab === "security" || inspectorTab === "delegations") && currentItem?.agent) {
        setGraphScrollOffset((offset) => Math.max(0, offset - 1))
      } else if ((key === "up" || key === "k") && inspectorTab === "resources" && activeItems[focusedIndex]?.agent) {
        setResourceScrollIndex((offset) => Math.max(0, offset - 1))
      } else if ((key === "down" || key === "j") && (inspectorTab === "security" || inspectorTab === "delegations") && currentItem?.agent) {
        const itemCount = inspectorTab === "security"
          ? Object.keys(currentItem.agent.frontmatter.permission || {}).filter((key) => key !== "task").length
          : (currentItem.agent.allowedSubagents || []).length
        setGraphScrollOffset((offset) => Math.min(Math.max(0, itemCount - Math.max(1, maxVisibleItems - 2)), offset + 1))
      } else if ((key === "down" || key === "j") && inspectorTab === "resources" && activeItems[focusedIndex]?.agent) {
        setResourceScrollIndex((offset) => Math.min(Math.max(0, resourceInspectorLines.length - Math.max(1, layout.listRows - 5)), offset + 1))
      } else if (key === "up" || key === "k") {
        if (activeItems.length === 0) return
        setFocusedIndex((prev) => {
          const next = prev > 0 ? prev - 1 : activeItems.length - 1
          return next
        })
        updateScroll(focusedIndex > 0 ? focusedIndex - 1 : activeItems.length - 1)
      } else if (key === "down" || key === "j") {
        if (activeItems.length === 0) return
        setFocusedIndex((prev) => {
          const next = prev < activeItems.length - 1 ? prev + 1 : 0
          return next
        })
        updateScroll(focusedIndex < activeItems.length - 1 ? focusedIndex + 1 : 0)
      } else if (key === "left" || key === "h") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "folder" && expandedCategories.has(item.id)) {
            setExpandedCategories((prev) => {
              const next = new Set(prev)
              next.delete(item.id)
              return next
            })
          }
        }
      } else if (key === "right" || key === "l") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "folder" && !expandedCategories.has(item.id)) {
            setExpandedCategories((prev) => {
              const next = new Set(prev)
              next.add(item.id)
              return next
            })
          }
        }
      } else if (key === "space") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "file" && item.agent) {
            const path = item.agent.currentPath
            setSelectedAgentPaths((prev) => {
              const next = new Set(prev)
              if (next.has(path)) {
                next.delete(path)
              } else {
                next.add(path)
              }
              return next
            })
          }
        }
      } else if (key === "a") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          const folderCategory = item.category
          const folderAgents = agents.filter((a) => a.category === folderCategory)
          const folderAgentPaths = folderAgents.map((a) => a.currentPath)

          setSelectedAgentPaths((prev) => {
            const next = new Set(prev)
            const allSelected = folderAgentPaths.every((path) => next.has(path))
            if (allSelected) {
              folderAgentPaths.forEach((path) => next.delete(path))
            } else {
              folderAgentPaths.forEach((path) => next.add(path))
            }
            return next
          })
        }
      } else if (key === "s") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "file" && item.agent) {
            const targetModel = item.agent.model
            const targetCategory = item.category

            const matchingAgents = agents.filter((a) => {
              const modelMatch = a.model === targetModel
              const categoryMatch = a.category === targetCategory
              return modelMatch && categoryMatch
            })

            const matchingAgentPaths = matchingAgents.map((a) => a.currentPath)

            setSelectedAgentPaths((prev) => {
              const next = new Set(prev)
              const allSelected = matchingAgentPaths.every((path) => next.has(path))
              if (allSelected) {
                matchingAgentPaths.forEach((path) => next.delete(path))
              } else {
                matchingAgentPaths.forEach((path) => next.add(path))
              }
              return next
            })
          }
        }
      } else if (key === "/") {
        setIsSearching(true)
      } else if (key === "i" && isWorkspaceVirtualPack) {
        openInitPackModal()
      } else if (key === "m") {
        const focusedFolder = activeItems[focusedIndex]
        if (selectedAgentPaths.size === 0 && focusedFolder?.type === "folder" && isConfigurablePack(workspaceRoot, focusedFolder.category)) {
          setRoutingArchetype(focusedFolder.category)
          setRoutingFocus(0)
          setRoutingConfirmDelete(false)
          setRoutingStatus("")
          setViewMode("routing-configs")
          return
        }
        if (modelCatalog.status !== "verified") {
          setActionResultTitle("Model Catalog Unavailable")
          setActionResultLines(["Models are not present in the loaded catalog.", "No model writes or suggestions are available.", "Press Y to retry refreshing the model catalog."])
          setViewMode("action-result")
          return
        }
        if (activeItems.length === 0 || (!activeItems[focusedIndex]?.agent && selectedAgentPaths.size === 0)) {
          setActionResultTitle("No Agent Focused")
           setActionResultLines([
             "Select at least one agent (SPACE) to change its model,",
             "or focus a pack folder and press M to configure conditional IF/OR flows."
           ])
          setViewMode("action-result")
        } else {
          const current = activeItems[focusedIndex]?.agent?.frontmatter?.model
          if (typeof current === "string" && current.includes("/")) setExpandedProviders(previous => new Set([...previous, current.split("/")[0]]))
          setFocusedModelIndex(0)
          setModelScrollOffset(0)
          setViewMode("model-selector")
        }
      } else if (key === "v") {
        if (modelCatalog.status === "verified" && invalidModelGroups.length > 0) {
          setRepairMappings({})
          setRepairGroupKey("0")
          setFocusedModelIndex(0)
          setModelScrollOffset(0)
          setViewMode("repair-selector")
        }
      } else if (key === "t" && e.shift) {
        if (activeItems.length === 0 || !activeItems[focusedIndex]?.agent) {
          setActionResultTitle("No Agent Focused")
          setActionResultLines(["Please focus an agent (or select agents using SPACE)", "before assigning a tier."])
          setViewMode("action-result")
        } else {
          setFocusedTierIndex(0)
          setTierScrollOffset(0)
          setViewMode("tier-selector")
        }
      } else if (key === "b" && !e.shift) {
        if (activeItems.length > 0 && activeDataSource) {
          let config = translationConfig
          try {
            config = loadTranslationFor(activeDataSource)
            setTranslationConfig(config)
          } catch {
            // Keep the in-memory config; generateBridge surfaces the load error on submit.
          }
          setBridgeTarget("claude")
          setBridgeModelTarget(config?.claude.modelMap?.["*"] || "")
          setBridgePluginName(config?.pluginName || "decent-pipeline")
          setBridgePipelinePrefix(config?.prefix || "")
          setBridgeFocusedField("name")
          setViewMode("bridge-prompt")
        }
      } else if (key === "b" && e.shift) {
        if (activeItems.length > 0 && activeDataSource) {
          let config = translationConfig
          try {
            config = loadTranslationFor(activeDataSource)
            setTranslationConfig(config)
          } catch {
            // Keep the in-memory config; generateBridge surfaces the load error on submit.
          }
          setBridgeTarget("codex")
          setBridgeModelTarget(config?.codex.modelMap?.["*"] || "")
          setBridgePluginName(config?.pluginName || "decent-pipeline")
          setBridgePipelinePrefix(config?.prefix || "")
          setBridgeFocusedField("name")
          setViewMode("bridge-prompt")
        }
      } else if (key === "e") {
        const focused = activeItems[focusedIndex]
        if (focused) previewInstall(focused.category)
      } else if (key === "c") {
        if (activeItems.length === 0 || !activeItems[focusedIndex]?.agent) {
          setActionResultTitle("No Agent Focused")
          setActionResultLines([
            "Please select at least one agent (using SPACE)",
            "before trying to change the color."
          ])
          setViewMode("action-result")
        } else {
          setFocusedColorIndex(0)
          setColorScrollOffset(0)
          setViewMode("color-selector")
        }
      } else if (key === "r") {
        if (activeItems.length > 0) {
          if (isReadOnlyGitSource) {
            setActionResultTitle("Read-Only GitHub Source")
            setActionResultLines([
              "Renaming agent files requires a local pack workspace.",
              "Model, routing, color, permissions, delegations, resources and parameter changes",
              "on GitHub sources are saved in user settings (overrides.json / routing.json).",
            ])
            setViewMode("action-result")
          } else {
            const item = activeItems[focusedIndex]
            if (item.type === "file" && item.agent) {
              const analysis = analyzeAgentName(item.agent.filename, allAgentFilenames)
              setRenameTargetAgent(item.agent)
              setRenameFamily(analysis.family || "")
              setRenameCategory(analysis.category || "")
              setRenameRole((analysis.role || "").replace(/[\s-]/g, "_"))
              setRenameFocusedField("role")
              setViewMode("rename-prompt")
            }
          }
        }
      } else if (key === "p") {
        if (activeItems.length > 0 && activeItems[focusedIndex]?.agent) {
          setFocusedPresetIndex(0)
          setViewMode("permission-preset")
        }
      } else if (key === "g") {
        if (activeItems.length > 0 && activeItems[focusedIndex]?.agent) {
          const target = activeItems[focusedIndex].agent!
          setDelegationTargetAgent(target)
          setSelectedDelegations(new Set(target.allowedSubagents || []))
          setFocusedDelegationIndex(0)
          setDelegationScrollOffset(0)
          setViewMode("delegation-manager")
        }
      } else if (key === "u") {
        const target = activeItems[focusedIndex]
        if (target?.type === "file" && target.agent) openResourceManager(target.agent)
        else setLayoutStatus("Focus an agent to manage its skills, tools and MCP permissions.")
      } else if (key === "t") {
        if (activeItems.length > 0) {
          const focusedItem = activeItems[focusedIndex]
          const targetAgents = selectedAgentPaths.size > 0
            ? agents.filter(a => selectedAgentPaths.has(a.currentPath))
            : focusedItem?.type === "folder"
              ? agents.filter(a => a.category === focusedItem.category)
              : focusedItem?.agent ? [focusedItem.agent] : []
          if (targetAgents.length === 0) return
          const summary = inspectTuningTargets(targetAgents)
          setTuningTargetPaths(targetAgents.map((a) => a.currentPath))
          setTuningSteps(summary.steps.value)
          setTuningTemp(summary.temp.value)
          setTuningVariant(summary.variant.value)
          setTuningMode(summary.mode.value)
          setTuningHidden(summary.hidden.value)
          setTuningDirtyFields(new Set())
          setTuningFocusedField("steps")
          setViewMode("parameter-tuning")
        }
      } else if (key === "1") {
        setInspectorTab("overview")
      } else if (key === "2") {
        setInspectorTab("naming")
      } else if (key === "3") {
        setInspectorTab("security")
        setGraphScrollOffset(0)
      } else if (key === "4") {
        setInspectorTab("delegations")
        setGraphScrollOffset(0)
      } else if (key === "5") {
        setInspectorTab("resources")
        setResourceScrollIndex(0)
      } else if (key === "pageup" && inspectorTab === "resources") {
        setResourceScrollIndex(offset => Math.max(0, offset - resourceInspectorPageSize))
      } else if (key === "pagedown" && inspectorTab === "resources") {
        setResourceScrollIndex(offset => Math.min(Math.max(0, resourceInspectorLines.length - resourceInspectorPageSize), offset + resourceInspectorPageSize))
      } else if (key === "pageup" && (inspectorTab === "security" || inspectorTab === "delegations")) {
        const graphPageSize = Math.max(1, maxVisibleItems - 2)
        setGraphScrollOffset((offset) => {
          const graphTotal = inspectorTab === "security"
            ? Object.entries(activeItems[focusedIndex]?.agent?.frontmatter.permission || {}).filter(([key]) => key !== "task").length
            : activeItems[focusedIndex]?.agent?.allowedSubagents?.length || 0
          return Math.max(0, Math.min(Math.max(0, graphTotal - graphPageSize), offset - graphPageSize))
        })
      } else if (key === "pagedown" && (inspectorTab === "security" || inspectorTab === "delegations")) {
        const graphPageSize = Math.max(1, maxVisibleItems - 2)
        setGraphScrollOffset((offset) => {
          const graphTotal = inspectorTab === "security"
            ? Object.entries(activeItems[focusedIndex]?.agent?.frontmatter.permission || {}).filter(([key]) => key !== "task").length
            : activeItems[focusedIndex]?.agent?.allowedSubagents?.length || 0
          return Math.min(Math.max(0, graphTotal - graphPageSize), offset + graphPageSize)
        })
      } else if (isUppercaseF && inspectorTab === "security" && activeItems[focusedIndex]?.agent) {
        const ag = activeItems[focusedIndex].agent!
        if (!analyzePermissionOrder(ag).hasOrderError) return
        try {
          applyAgentMutation(
            [ag.currentPath],
            writer => { fixPermissionOrder(ag, writer) },
            "Permission Order Fixed",
            [
              `Successfully reordered permissions for:`,
              `  ${ag.filename}`,
              `Placed wildcard "*": "deny" FIRST to comply with OpenCode spec.`
            ]
          )
        } catch (error: any) {
          setActionResultTitle("Error Fixing Permission Order")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
      }
    } else if (viewMode === "model-selector" || viewMode === "repair-selector") {
      // 3. Model selector mode. In trigger mode, TAB (or SPACE with empty search) toggles OR triggers.
      if (
        viewMode === "model-selector" &&
        routingPick?.kind === "trigger" &&
        (key === "tab" || (key === "space" && !modelFilter)) &&
        modelTreeItems.length > 0
      ) {
        const item = modelTreeItems[focusedModelIndex]
        if (item?.type === "model") {
          setPendingTriggers(prev => {
            const next = new Set(prev)
            if (next.has(item.id)) next.delete(item.id)
            else next.add(item.id)
            return next
          })
          return
        }
      }
      const typed = !e.ctrl && !e.meta && e.sequence.length === 1 && /^[\x20-\x7E]$/.test(e.sequence)
      if (typed || (key === "backspace" && modelFilter) || (key === "escape" && modelFilter)) {
        setModelFilter(filter => typed ? filter + e.sequence : key === "backspace" ? filter.slice(0, -1) : "")
        setFocusedModelIndex(0)
        setModelScrollOffset(0)
        return
      }
      if (key === "up") {
        if (modelTreeItems.length === 0) return
        const next = focusedModelIndex > 0 ? focusedModelIndex - 1 : modelTreeItems.length - 1
        setFocusedModelIndex(next)
        setModelScrollOffset((offset) => {
          if (next < offset) return next
          if (next >= offset + maxVisibleModels) return next - maxVisibleModels + 1
          return offset
        })
      } else if (key === "down") {
        if (modelTreeItems.length === 0) return
        const next = focusedModelIndex < modelTreeItems.length - 1 ? focusedModelIndex + 1 : 0
        setFocusedModelIndex(next)
        setModelScrollOffset((offset) => {
          if (next < offset) return next
          if (next >= offset + maxVisibleModels) return next - maxVisibleModels + 1
          return offset
        })
      } else if (key === "pageup" || key === "pagedown") {
        const delta = key === "pageup" ? -maxVisibleModels : maxVisibleModels
        const next = Math.max(0, Math.min(Math.max(0, modelTreeItems.length - 1), focusedModelIndex + delta))
        setFocusedModelIndex(next)
        setModelScrollOffset(Math.max(0, Math.min(Math.max(0, modelTreeItems.length - maxVisibleModels), next)))
      } else if (key === "left") {
        if (modelTreeItems.length > 0) {
          const item = modelTreeItems[focusedModelIndex]
          if (item.type === "provider" && expandedProviders.has(item.id)) {
            setExpandedProviders((prev) => {
              const next = new Set(prev)
              next.delete(item.id)
              return next
            })
          }
        }
      } else if (key === "right") {
        if (modelTreeItems.length > 0) {
          const item = modelTreeItems[focusedModelIndex]
          if (item.type === "provider" && !expandedProviders.has(item.id)) {
            setExpandedProviders((prev) => {
              const next = new Set(prev)
              next.add(item.id)
              return next
            })
          }
        }
      } else if (key === "enter" || key === "return") {
        if (modelTreeItems.length > 0) {
          const item = modelTreeItems[focusedModelIndex]
          if (item.type === "provider" && !(routingPick?.kind === "trigger" && pendingTriggers.size > 0)) {
            setExpandedProviders((prev) => {
              const next = new Set(prev)
              if (next.has(item.id)) {
                next.delete(item.id)
              } else {
                next.add(item.id)
              }
              return next
            })
          } else {
            const selectedModel = item.id
            if (routingPick && routingDraft) {
              const pick = routingPick
              setRoutingPick(null)
              if (pick.kind === "trigger") {
                const chosenTriggers = pendingTriggers.size > 0
                  ? [...pendingTriggers]
                  : item.type === "model"
                    ? [selectedModel]
                    : []
                setPendingTriggers(new Set())
                if (!chosenTriggers.length) {
                  setViewMode(routingDraft.previousKey ? "routing-editor" : "routing-configs")
                  return
                }
                const saved = applyRoutingDraft({ ...routingDraft, triggers: chosenTriggers })
                setViewMode(saved || routingDraft.previousKey ? "routing-editor" : "routing-configs")
              } else {
                const roles = { ...routingDraft.roles }
                for (const role of pick.roles) roles[role] = selectedModel === INHERIT ? INHERIT : withRoutingVariant(selectedModel, routingDraft.roles[role]?.split("#")[1] ?? "")
                if (applyRoutingDraft({ ...routingDraft, roles })) setRoutingSelected(new Set())
                setViewMode("routing-editor")
              }
              return
            }
            try {
              if (viewMode === "repair-selector") {
                const index = Number(repairGroupKey)
                setRepairMappings(previous => ({ ...previous, [String(index)]: selectedModel }))
                if (index + 1 < invalidModelGroups.length) {
                  setRepairGroupKey(String(index + 1))
                  setFocusedModelIndex(0)
                  setModelScrollOffset(0)
                  return
                }
                const mappings = invalidModelGroups.map((group, groupIndex) => ({
                  oldModel: group.value,
                  newModel: groupIndex === index ? selectedModel : repairMappings[String(groupIndex)],
                  agentPaths: group.agents.map(agent => agent.currentPath)
                }))
                if (mappings.some(mapping => !mapping.newModel)) throw new Error("Choose a replacement for every invalid model group")
                setRepairMappings(Object.fromEntries(mappings.map((mapping, i) => [String(i), mapping.newModel])))
                setViewMode("repair-confirm")
                return
              }
              const selectedAgents = selectedAgentPaths.size > 0
                ? agents.filter((a) => selectedAgentPaths.has(a.currentPath))
                : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
              if (!modelCatalog.models.includes(selectedModel)) throw new Error("Model is not present in refreshed catalog")
              if (isReadOnlyGitSource) {
                void (async () => {
                  try {
                    overrideAgentsModel(workspaceRoot, selectedAgents, selectedModel, modelCatalog.models)
                    refreshData()
                    setSelectedAgentPaths(new Set())
                    const outcome = await reconcileTargetIfInstalled("override")
                    setActionResultTitle("Model Updated Successfully")
                    setActionResultLines([
                      `Successfully set model:`,
                      `  ${selectedModel}`,
                      `on ${selectedAgents.length} agents.`,
                      "",
                      ...formatReconcileLines(outcome),
                    ])
                  } catch (error: any) {
                    setActionResultTitle("Error Updating Model")
                    setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
                  }
                  setViewMode("action-result")
                })()
                return
              }
              const tx = mutate(selectedAgents.map(a => a.currentPath), "tune", () => updateAgentsModel(selectedAgents, selectedModel, modelCatalog.models))
              try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
              setSelectedAgentPaths(new Set())
              setMutationSuccess("Model Updated Successfully", [`Successfully set model:`, `  ${selectedModel}`, `on ${selectedAgents.length} agents.`], tx.warning)
            } catch (error: any) {
              setActionResultTitle("Error Updating Model")
              setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
            }
            setViewMode("action-result")
          }
        }
      } else if (key === "escape") {
        setRepairGroupKey(null)
        setPendingTriggers(new Set())
        setViewMode(!routingPick ? "main" : routingDraft?.previousKey ? "routing-editor" : "routing-configs")
        setRoutingPick(null)
      } else if (key === "r" && e.ctrl) {
        refreshModelCatalog()
        setRoutingPick(null)
        setViewMode("main")
      }
    } else if (viewMode === "repair-confirm") {
      if (key === "escape" || key === "n") setViewMode("main")
      else if (key === "enter" || key === "return" || key === "y") {
        const mappings = invalidModelGroups.map((group, index) => ({ oldModel: group.value, newModel: repairMappings[String(index)], agentPaths: group.agents.map(agent => agent.currentPath) }))
        const verified = modelCatalog.status === "verified" ? modelCatalog.models : []
        if (isReadOnlyGitSource) {
          void (async () => {
            try {
              const result = overrideRepairAgentModels(workspaceRoot, agents, mappings, verified)
              refreshData()
              setSelectedAgentPaths(new Set())
              const outcome = await reconcileTargetIfInstalled("override")
              setActionResultTitle("Grouped Model Repair Complete")
              setActionResultLines([
                `Repaired ${result.groups} group(s); changed ${result.agentsChanged} agent(s).`,
                "Writes were validated against the loaded catalog.",
                "",
                ...formatReconcileLines(outcome),
              ])
            } catch (error: any) {
              setActionResultTitle("Error During Grouped Repair")
              setActionResultLines([error.message || String(error)])
            }
            setViewMode("action-result")
          })()
          return
        }
        try {
           const tx = mutate(mappings.flatMap(mapping => mapping.agentPaths), "tune", () => repairAgentModels(agents, mappings, verified))
           const result = tx.value
           try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
          setSelectedAgentPaths(new Set())
            setMutationSuccess("Grouped Model Repair Complete", [`Repaired ${result.groups} group(s); changed ${result.agentsChanged} agent(s).`, "Writes were validated against the loaded catalog."], tx.warning)
          setViewMode("action-result")
        } catch (error: any) {
          setActionResultTitle("Error During Grouped Repair")
          setActionResultLines(["No repository-wide atomicity is claimed.", error.message || String(error)])
          setViewMode("action-result")
        }
      }
    } else if (viewMode === "tier-selector") {
      const tiers = translationConfig ? Object.keys(translationConfig.tiers) : []
      const targetAgents = selectedAgentPaths.size > 0
        ? agents.filter(a => selectedAgentPaths.has(a.currentPath))
        : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
      if (key === "up" || key === "k" || key === "down" || key === "j") {
        if (tiers.length === 0) return
        const direction = key === "up" || key === "k" ? -1 : 1
        const next = (focusedTierIndex + direction + tiers.length) % tiers.length
        setFocusedTierIndex(next)
        setTierScrollOffset(Math.max(0, Math.min(Math.max(0, tiers.length - maxVisibleTiers), next)))
      } else if (key === "pageup" || key === "pagedown") {
        const delta = key === "pageup" ? -maxVisibleTiers : maxVisibleTiers
        const next = Math.max(0, Math.min(Math.max(0, tiers.length - 1), focusedTierIndex + delta))
        setFocusedTierIndex(next)
        setTierScrollOffset(Math.max(0, Math.min(Math.max(0, tiers.length - maxVisibleTiers), next)))
      } else if (key === "enter" || key === "return") {
        const chosenTier = tiers[focusedTierIndex]
        if (!chosenTier || !translationConfig) return
        try {
          const roles: Set<string> = new Set(targetAgents.map(agent => resolveRole(agent, translationConfig)))
          const impacted = agents.filter(agent => !targetAgents.some(target => target.currentPath === agent.currentPath) && roles.has(resolveRole(agent, translationConfig)))
          const nextConfig = { ...translationConfig, roles: { ...translationConfig.roles } }
          roles.forEach(role => { nextConfig.roles[role] = chosenTier })
          let txWarning: TransactionWarning | undefined
          if (activeDataSource?.kind === "source" && activeDataSource.source.kind === "git") {
            const loc = sourceTranslationConfigLocation(activeDataSource.source.name, workspaceRoot)
            saveTranslationConfig(loc.configRoot, nextConfig, loc.configPath)
          } else {
            const tx = mutate([translationConfigPath(workspaceRoot)], "config", () => saveTranslationConfig(workspaceRoot, nextConfig))
            txWarning = tx.warning
          }
          setTranslationConfig(loadTranslationFor(activeDataSource))
          try { refreshData() } catch (error) { setMutationRefreshFailure(error, txWarning); return }
          setSelectedAgentPaths(new Set())
          setMutationSuccess("Tier Assigned Successfully", [
            `Tier: ${chosenTier}`,
            `Roles modified: ${Array.from(roles).join(", ") || "none"}`,
            ...(impacted.length ? [`⚠ Shared-role impact on non-selected agents:`, ...impacted.map(agent => `  ${agent.filename}`)] : ["No non-selected agents share these roles."])
          ], txWarning)
        } catch (error: any) {
          setActionResultTitle("Error Assigning Tier")
          setActionResultLines(["An error occurred:", `  ${error.message || error}`])
        }
        setViewMode("action-result")
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "bridge-prompt") {
      // 6. Bridge to Claude Code prompt mode
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "tab") {
        if (bridgeFocusedField === "prefix" && filteredBridgePrefixSuggestions.length > 0) {
          setBridgePipelinePrefix(filteredBridgePrefixSuggestions[bridgeSuggestionIndex].prefix)
        }
        setBridgeFocusedField((prev) => prev === "name" ? "prefix" : prev === "prefix" ? "model" : "name")
      } else if (key === "up" || key === "down") {
        if (bridgeFocusedField === "prefix" && filteredBridgePrefixSuggestions.length > 0) {
            setBridgeSuggestionIndex(index => {
             const delta = key === "down" ? 1 : -1
             const length = filteredBridgePrefixSuggestions.length
             const next = (index + delta + length) % length
             setBridgeSuggestionScrollOffset(offset => next < offset ? next : next >= offset + 5 ? next - 4 : offset)
             return next
           })
        } else {
          setBridgeFocusedField((prev) => prev === "name" ? "prefix" : prev === "prefix" ? "model" : "name")
        }
      }
    } else if (viewMode === "install-confirm") {
      if ((key === "y" || key === "enter" || key === "return") && installPreview && !installPreview.blocked) {
        applyInstall(installPreview)
      } else if (key === "n" || key === "escape" || ((key === "enter" || key === "return") && installPreview?.blocked)) {
        setViewMode("main")
      }
    } else if (viewMode === "routing-configs") {
      const flows = routingView?.flows ?? []
      const rows = flows.length + 1
      const focusedFlow = flows[routingFocus]
      if (key === "escape") {
        setRoutingArchetype(null)
        setViewMode("main")
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        setRoutingFocus(focus => (focus + (key === "up" || key === "k" ? -1 : 1) + rows) % rows)
        setRoutingConfirmDelete(false)
      } else if (key === "c" && routingView) {
        setCallerDraftSet(new Set(routingView.callers.map(c => c.name)))
        setCallerFocus(0)
        setRoutingStatus("")
        setViewMode("routing-callers")
      } else if (key === "w" && routingView && !isReadOnlyGitSource && routingView.hasManifest) {
        exportRoutingToManifest()
      } else if (key === "i" && routingView && !isReadOnlyGitSource && !routingView.hasManifest) {
        openInitPackModal()
      } else if ((key === "enter" || key === "return") && routingView) {
        setRoutingEditorFocus(focusedFlow ? (routingView.related.length > 0 ? 1 : 2) : 0)
        setRoutingSelected(new Set())
        setRoutingStatus("")
        if (focusedFlow) {
          setRoutingDraft({
            previousKey: focusedFlow.key,
            ...(focusedFlow.callers ? { callers: [...focusedFlow.callers] } : {}),
            triggers: [...focusedFlow.triggers],
            roles: { ...focusedFlow.roles },
            tools: { ...focusedFlow.tools },
            permissions: { ...focusedFlow.permissions },
            delegations: { ...focusedFlow.delegations },
          })
          setViewMode("routing-editor")
        } else {
          setRoutingDraft({ triggers: [], roles: {}, tools: {}, permissions: {}, delegations: {} })
          openRoutingPicker({ kind: "trigger" })
        }
      } else if ((key === "d" || key === "delete") && focusedFlow) {
        if (!routingConfirmDelete) {
          setRoutingConfirmDelete(true)
          setRoutingStatus(`Press D again to delete '${formatTriggerLabel(focusedFlow.triggers)}'.`)
          return
        }
        setRoutingConfirmDelete(false)
        if (saveFlowDraft(null, focusedFlow.key).ok) setRoutingFocus(focus => Math.max(0, Math.min(focus, flows.length - 1)))
      }
    } else if (viewMode === "routing-callers") {
      const candidates = routingView?.callerCandidates ?? []
      if (key === "escape") {
        setViewMode("routing-configs")
      } else if ((key === "up" || key === "k" || key === "down" || key === "j") && candidates.length > 0) {
        setCallerFocus(f => (f + (key === "up" || key === "k" ? -1 : 1) + candidates.length) % candidates.length)
      } else if (key === "space" && candidates[callerFocus]) {
        const name = candidates[callerFocus].name
        setCallerDraftSet(prev => {
          const next = new Set(prev)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          return next
        })
      } else if (key === "r" && routingArchetype) {
        try {
          saveUserPackCallers(workspaceRoot, routingArchetype, null, { applySourceOverrides: isReadOnlyGitSource })
          setRoutingRevision(r => r + 1)
          setRoutingStatus("Reset callers to pack / inferred defaults.")
          void reconcileTargetIfInstalled("models")
          setViewMode("routing-configs")
        } catch (err: any) {
          setRoutingStatus(`Error: ${terminalSafeText(err?.message || err)}`)
        }
      } else if ((key === "enter" || key === "return") && routingArchetype) {
        try {
          saveUserPackCallers(workspaceRoot, routingArchetype, [...callerDraftSet], { applySourceOverrides: isReadOnlyGitSource })
          setRoutingRevision(r => r + 1)
          setRoutingStatus(`Updated callers (OR): ${[...callerDraftSet].join(", ")}.`)
          void reconcileTargetIfInstalled("models")
          setViewMode("routing-configs")
        } catch (err: any) {
          setRoutingStatus(`Error: ${terminalSafeText(err?.message || err)}`)
        }
      }
    } else if (viewMode === "routing-editor") {
      const related = routingView?.related ?? []
      const toolsRowIdx = related.length + 1
      const permsRowIdx = related.length + 2
      const delegationsRowIdx = related.length + 3
      const rows = related.length + 4
      const focusedAgent = routingEditorFocus > 0 && routingEditorFocus <= related.length ? related[routingEditorFocus - 1] : undefined
      const targets = routingSelected.size > 0 ? related.filter(agent => routingSelected.has(agent.role)).map(agent => agent.role) : focusedAgent ? [focusedAgent.role] : []
      if (!routingDraft) {
        setViewMode("routing-configs")
      } else if (key === "escape") {
        if (routingSelected.size > 0) { setRoutingSelected(new Set()); return }
        setRoutingDraft(null)
        setViewMode("routing-configs")
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        setRoutingEditorFocus(focus => (focus + (key === "up" || key === "k" ? -1 : 1) + rows) % rows)
      } else if (key === "u") {
        setFlowSubFocus(0)
        setFlowSubScroll(0)
        setViewMode("routing-tools")
      } else if (key === "p") {
        setFlowSubFocus(0)
        setFlowSubScroll(0)
        setViewMode("routing-permissions")
      } else if (key === "g") {
        setFlowSubFocus(0)
        setFlowSubScroll(0)
        setViewMode("routing-delegations")
      } else if (key === "space" && focusedAgent) {
        setRoutingSelected(previous => {
          const next = new Set(previous)
          if (next.has(focusedAgent.role)) next.delete(focusedAgent.role)
          else next.add(focusedAgent.role)
          return next
        })
      } else if (key === "a" && related.length > 0) {
        setRoutingSelected(previous => previous.size === related.length ? new Set() : new Set(related.map(agent => agent.role)))
      } else if (key === "enter" || key === "return" || key === "m") {
        if (routingEditorFocus === 0) openRoutingPicker({ kind: "trigger" }, routingDraft.triggers)
        else if (routingEditorFocus === toolsRowIdx && key !== "m") {
          setFlowSubFocus(0)
          setFlowSubScroll(0)
          setViewMode("routing-tools")
        } else if (routingEditorFocus === permsRowIdx && key !== "m") {
          setFlowSubFocus(0)
          setFlowSubScroll(0)
          setViewMode("routing-permissions")
        } else if (routingEditorFocus === delegationsRowIdx && key !== "m") {
          setFlowSubFocus(0)
          setFlowSubScroll(0)
          setViewMode("routing-delegations")
        } else if (targets.length > 0) {
          openRoutingPicker({ kind: "roles", roles: targets }, routingDraft.roles[targets[0]])
        }
      } else if ((key === "tab" || key === "left" || key === "right") && targets.length > 0) {
        const withModel = targets.filter(role => routingDraft.roles[role] && routingDraft.roles[role] !== INHERIT)
        if (withModel.length === 0) { setRoutingStatus("Choose a model first: variants belong to a model."); return }
        const [base, variant = ""] = routingDraft.roles[withModel[0]].split("#")
        const choices = routingVariantChoices(base)
        const nextVariant = choices[(choices.indexOf(variant) + (key === "left" ? -1 : 1) + choices.length) % choices.length]
        const roles = { ...routingDraft.roles }
        for (const role of withModel) roles[role] = withRoutingVariant(roles[role], nextVariant)
        applyRoutingDraft({ ...routingDraft, roles })
      } else if ((key === "backspace" || key === "delete") && targets.length > 0) {
        const roles = { ...routingDraft.roles }
        for (const role of targets) roles[role] = INHERIT
        if (applyRoutingDraft({ ...routingDraft, roles })) setRoutingSelected(new Set())
      }
    } else if (viewMode === "routing-tools") {
      const toolRows = [{ key: "*", label: "* (All tools fallback)", group: "builtin" as const, staticallyDeniedByCaller: false }, ...(routingView?.availableTools ?? [])]
      const visibleCount = Math.max(2, Math.floor(termHeight * 0.72) - 8)
      if (!routingDraft || key === "escape" || key === "enter" || key === "return") {
        setViewMode("routing-editor")
      } else if ((key === "up" || key === "k" || key === "down" || key === "j") && toolRows.length > 0) {
        const next = (flowSubFocus + (key === "up" || key === "k" ? -1 : 1) + toolRows.length) % toolRows.length
        setFlowSubFocus(next)
        setFlowSubScroll(offset => next < offset ? next : next >= offset + visibleCount ? next - visibleCount + 1 : offset)
      } else if ((key === "space" || key === "left" || key === "right") && toolRows[flowSubFocus]) {
        const targetKey = toolRows[flowSubFocus].key
        const cycle: Array<PolicyEffect | undefined> = [undefined, "deny", "ask", "allow"]
        const current = routingDraft.tools[targetKey]
        const nextEffect = cycle[(cycle.indexOf(current) + (key === "left" ? -1 : 1) + cycle.length) % cycle.length]
        const tools = { ...routingDraft.tools }
        if (nextEffect === undefined) delete tools[targetKey]
        else tools[targetKey] = nextEffect
        applyRoutingDraft({ ...routingDraft, tools })
      } else if ((key === "backspace" || key === "delete") && toolRows[flowSubFocus]) {
        const tools = { ...routingDraft.tools }
        delete tools[toolRows[flowSubFocus].key]
        applyRoutingDraft({ ...routingDraft, tools })
      }
    } else if (viewMode === "routing-permissions") {
      const permRows = [
        { key: "*", label: "* (All permissions fallback)" },
        { key: "shell", label: "shell / bash (command execution)" },
        { key: "edit", label: "edit / write (file modifications)" },
        { key: "read", label: "read (file & directory reads)" },
        { key: "webfetch", label: "webfetch (HTTP requests)" },
        { key: "skill", label: "skill (load skills)" },
        { key: "external_directory", label: "external_directory (outside workspace)" },
      ]
      if (!routingDraft || key === "escape" || key === "enter" || key === "return") {
        setViewMode("routing-editor")
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        setFlowSubFocus(f => (f + (key === "up" || key === "k" ? -1 : 1) + permRows.length) % permRows.length)
      } else if ((key === "space" || key === "left" || key === "right") && permRows[flowSubFocus]) {
        const targetKey = permRows[flowSubFocus].key
        const cycle: Array<PolicyEffect | undefined> = [undefined, "deny", "ask", "allow"]
        const current = routingDraft.permissions[targetKey]
        const nextEffect = cycle[(cycle.indexOf(current) + (key === "left" ? -1 : 1) + cycle.length) % cycle.length]
        const permissions = { ...routingDraft.permissions }
        if (nextEffect === undefined) delete permissions[targetKey]
        else permissions[targetKey] = nextEffect
        applyRoutingDraft({ ...routingDraft, permissions })
      } else if ((key === "backspace" || key === "delete") && permRows[flowSubFocus]) {
        const permissions = { ...routingDraft.permissions }
        delete permissions[permRows[flowSubFocus].key]
        applyRoutingDraft({ ...routingDraft, permissions })
      }
    } else if (viewMode === "routing-delegations") {
      const delRows = [
        { name: "*", label: "* (All subagents fallback)" },
        ...(routingView?.subagents ?? []).map(sub => ({ name: sub.name, label: sub.name })),
      ]
      const visibleCount = Math.max(2, Math.floor(termHeight * 0.72) - 8)
      if (!routingDraft || key === "escape" || key === "enter" || key === "return") {
        setViewMode("routing-editor")
      } else if ((key === "up" || key === "k" || key === "down" || key === "j") && delRows.length > 0) {
        const next = (flowSubFocus + (key === "up" || key === "k" ? -1 : 1) + delRows.length) % delRows.length
        setFlowSubFocus(next)
        setFlowSubScroll(offset => next < offset ? next : next >= offset + visibleCount ? next - visibleCount + 1 : offset)
      } else if ((key === "space" || key === "left" || key === "right") && delRows[flowSubFocus]) {
        const targetName = delRows[flowSubFocus].name
        const cycle: Array<DelegationEffect | undefined> = [undefined, "deny", "allow"]
        const current = routingDraft.delegations[targetName]
        const nextEffect = cycle[(cycle.indexOf(current) + (key === "left" ? -1 : 1) + cycle.length) % cycle.length]
        const delegations = { ...routingDraft.delegations }
        if (nextEffect === undefined) delete delegations[targetName]
        else delegations[targetName] = nextEffect
        applyRoutingDraft({ ...routingDraft, delegations })
      } else if ((key === "backspace" || key === "delete") && delRows[flowSubFocus]) {
        const delegations = { ...routingDraft.delegations }
        delete delegations[delRows[flowSubFocus].name]
        applyRoutingDraft({ ...routingDraft, delegations })
      }
    } else if (viewMode === "pack-init") {
      const fieldOrder: Array<"name" | "version" | "desc" | "organize"> = ["name", "version", "desc", "organize"]
      if (key === "escape") {
        setViewMode(routingArchetype ? "routing-configs" : "main")
      } else if (key === "tab" || key === "up" || key === "down") {
        const delta = key === "up" ? -1 : 1
        setInitPackField(f => fieldOrder[(fieldOrder.indexOf(f) + delta + fieldOrder.length) % fieldOrder.length])
      } else if (key === "space" && initPackField === "organize") {
        setInitPackOrganize(prev => !prev)
      } else if (key === "backspace") {
        if (initPackField === "name") setInitPackName(s => s.slice(0, -1))
        else if (initPackField === "version") setInitPackVersion(s => s.slice(0, -1))
        else if (initPackField === "desc") setInitPackDesc(s => s.slice(0, -1))
      } else if (key === "enter" || key === "return") {
        try {
          const res = initPackManifest(workspaceRoot, {
            name: initPackName,
            version: initPackVersion,
            description: initPackDesc,
            organize: initPackOrganize,
          })
          refreshData()
          setRoutingArchetype(null)
          setActionResultTitle("Pack Manifest Initialized")
          setActionResultLines([
            `Created ${res.manifestPath}`,
            `Pack: ${res.manifest.name}@${res.manifest.version} (contract ${res.manifest.contract})`,
            ...(res.movedAgents.length ? ["", "Organized agents:", ...res.movedAgents.map(m => `  ${m.from} -> ${m.to}`)] : []),
            ...(res.warnings.length ? ["", "Validation notes:", ...res.warnings.map(w => `  ${w}`)] : []),
          ])
          setViewMode("action-result")
        } catch (err: any) {
          setActionResultTitle("Pack Initialization Failed")
          setActionResultLines([`Error: ${terminalSafeText(err?.message || err)}`])
          setViewMode("action-result")
        }
      } else if (/^[\x20-\x7E]$/.test(rawChar)) {
        if (initPackField === "name" && /[a-zA-Z0-9-]/.test(rawChar)) setInitPackName(s => (s + rawChar.toLowerCase()).slice(0, 64))
        else if (initPackField === "version" && rawChar !== " ") setInitPackVersion(s => s + rawChar)
        else if (initPackField === "desc") setInitPackDesc(s => s + rawChar)
      }
    } else if (viewMode === "color-selector") {
      // 8. Color selector mode
      if (key === "up" || key === "k") {
        if (colorTreeItems.length === 0) return
        const next = focusedColorIndex > 0 ? focusedColorIndex - 1 : colorTreeItems.length - 1
        setFocusedColorIndex(next)
        setColorScrollOffset((offset) => next < offset ? next : next >= offset + maxVisibleColors ? next - maxVisibleColors + 1 : offset)
      } else if (key === "down" || key === "j") {
        if (colorTreeItems.length === 0) return
        const next = focusedColorIndex < colorTreeItems.length - 1 ? focusedColorIndex + 1 : 0
        setFocusedColorIndex(next)
        setColorScrollOffset((offset) => next < offset ? next : next >= offset + maxVisibleColors ? next - maxVisibleColors + 1 : offset)
      } else if (key === "left" || key === "h") {
        if (colorTreeItems.length > 0) {
          const item = colorTreeItems[focusedColorIndex]
          if (item.type === "group" && expandedColorGroups.has(item.id)) {
            setExpandedColorGroups((prev) => {
              const next = new Set(prev)
              next.delete(item.id)
              return next
            })
          }
        }
      } else if (key === "right" || key === "l") {
        if (colorTreeItems.length > 0) {
          const item = colorTreeItems[focusedColorIndex]
          if (item.type === "group" && !expandedColorGroups.has(item.id)) {
            setExpandedColorGroups((prev) => {
              const next = new Set(prev)
              next.add(item.id)
              return next
            })
          }
        }
      } else if (key === "enter" || key === "return") {
        if (colorTreeItems.length > 0) {
          const item = colorTreeItems[focusedColorIndex]
          if (item.type === "group") {
            setExpandedColorGroups((prev) => {
              const next = new Set(prev)
              if (next.has(item.id)) {
                next.delete(item.id)
              } else {
                next.add(item.id)
              }
              return next
            })
          } else {
            const selectedColor = item.value
            try {
              const selectedAgents = selectedAgentPaths.size > 0
                ? agents.filter((a) => selectedAgentPaths.has(a.currentPath))
                : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
              applyAgentMutation(
                selectedAgents.map(a => a.currentPath),
                writer => updateAgentsColor(selectedAgents, selectedColor, writer),
                "Color Updated Successfully",
                [`Successfully set color:`, `  ${selectedColor} (${item.label.trim()})`, `on ${selectedAgents.length} agents.`]
              )
            } catch (error: any) {
              setActionResultTitle("Error Updating Color")
              setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
              setViewMode("action-result")
            }
          }
        }
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "permission-preset") {
      // 10. Permission preset mode
      if (key === "up" || key === "k") {
        setFocusedPresetIndex((prev) => (prev > 0 ? prev - 1 : SAFETY_PRESETS.length - 1))
      } else if (key === "down" || key === "j") {
        setFocusedPresetIndex((prev) => (prev < SAFETY_PRESETS.length - 1 ? prev + 1 : 0))
      } else if (key === "enter" || key === "return") {
        const preset = SAFETY_PRESETS[focusedPresetIndex]
        const targetAgents = selectedAgentPaths.size > 0
          ? agents.filter((a) => selectedAgentPaths.has(a.currentPath))
          : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
        try {
          applyAgentMutation(
            targetAgents.map(a => a.currentPath),
            writer => applySafetyPreset(targetAgents, preset.key, writer),
            "Safety Preset Applied",
            [`Successfully applied preset '${preset.name}'`, `to ${targetAgents.length} agents.`]
          )
        } catch (error: any) {
          setActionResultTitle("Error Applying Safety Preset")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "delegation-manager") {
      // 11. Delegation manager mode
      if (key === "up" || key === "k") {
        if (delegationItems.length === 0) return
        const next = focusedDelegationIndex > 0 ? focusedDelegationIndex - 1 : delegationItems.length - 1
        setFocusedDelegationIndex(next)
         updateDelegationScroll(next)
       } else if (key === "pageup" || key === "pagedown") {
         if (delegationItems.length === 0) return
         const pageSize = Math.max(1, maxVisibleItems)
         const maxOffset = Math.max(0, delegationItems.length - pageSize)
         setDelegationScrollOffset((offset) => {
           const nextOffset = key === "pageup" ? offset - pageSize : offset + pageSize
           const clampedOffset = Math.max(0, Math.min(maxOffset, nextOffset))
           setFocusedDelegationIndex(Math.min(delegationItems.length - 1, clampedOffset))
           return clampedOffset
         })
      } else if (key === "down" || key === "j") {
        if (delegationItems.length === 0) return
        const next = focusedDelegationIndex < delegationItems.length - 1 ? focusedDelegationIndex + 1 : 0
        setFocusedDelegationIndex(next)
        updateDelegationScroll(next)
      } else if (key === "space") {
        const targetSubagent = delegationItems[focusedDelegationIndex]
        if (targetSubagent) {
          const subName = targetSubagent.filename.replace(/\.md$/, "")
          setSelectedDelegations((prev) => {
            const next = new Set(prev)
            if (next.has(subName)) next.delete(subName)
            else next.add(subName)
            return next
          })
        }
      } else if (key === "enter" || key === "return") {
        if (delegationTargetAgent) {
          const allowedNames: string[] = Array.from(selectedDelegations)
          try {
            applyAgentMutation(
              [delegationTargetAgent.currentPath],
              writer => updateAgentDelegations(delegationTargetAgent, allowedNames, writer),
              "Delegation Graph Updated",
              [`Updated subagent delegation permissions for:`, `  ${delegationTargetAgent.filename}`, ``, `Allowed subagents (${allowedNames.length}):`, ...allowedNames.map((name) => `  * ${name}`)]
            )
          } catch (error: any) {
            setActionResultTitle("Error Updating Delegations")
            setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
            setViewMode("action-result")
          }
        }
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "resource-manager") {
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        if (resourceManagerRows.length === 0) return
        const direction = key === "up" || key === "k" ? -1 : 1
        const next = Math.max(0, Math.min(resourceManagerRows.length - 1, resourceModalFocusIndex + direction))
        setResourceModalFocusIndex(next)
        setResourceModalScrollOffset(offset => next < offset ? next : next >= offset + maxVisibleResourceRows ? next - maxVisibleResourceRows + 1 : offset)
      } else if (key === "pageup" || key === "pagedown") {
        if (resourceManagerRows.length === 0) return
        const delta = key === "pageup" ? -maxVisibleResourceRows : maxVisibleResourceRows
        const next = Math.max(0, Math.min(resourceManagerRows.length - 1, resourceModalFocusIndex + delta))
        setResourceModalFocusIndex(next)
        setResourceModalScrollOffset(Math.max(0, Math.min(Math.max(0, resourceManagerRows.length - maxVisibleResourceRows), next)))
        } else if (key === "space") {
        const row = resourceManagerRows[resourceModalFocusIndex]
        if (!row) return
        if (!resourceCatalog) return
        const agentItem = row.item
        if (row.kind === "skill-wildcard") {
          const nextAll = !draftSkillAll
          setDraftSkillAll(nextAll)
          setDraftAllowedSkills(nextAll
            ? new Set(resourceCatalog.skills.filter(item => item.kind === "skill").map(item => item.name))
            : new Set())
        } else if (row.kind === "skill") {
          const name = agentItem.name
          const next = new Set(draftAllowedSkills)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          const skillNames = resourceCatalog.skills.filter(item => item.kind === "skill").map(item => item.name)
          if (!draftSkillAll && skillNames.length > 0 && skillNames.every(skill => next.has(skill))) {
            setDraftSkillAll(true)
          } else if (draftSkillAll && next.size === 0) {
            setDraftSkillAll(false)
          }
          setDraftAllowedSkills(next)
        } else if (row.kind === "tool-family") {
          const nextAllowed = !draftPermissions[agentItem.permissionKey]
          const keys = [agentItem.permissionKey, ...resourceCatalog.tools
            .filter(item => item.kind === "tool" && item.familyKey === agentItem.permissionKey && !explicitResourcePermissions.has(item.permissionKey))
            .map(item => item.permissionKey)]
          setDraftPermissions(previous => Object.fromEntries(Object.entries({ ...previous, ...Object.fromEntries(keys.map(key => [key, nextAllowed])) })))
          setExplicitResourcePermissions(previous => new Set([...previous, agentItem.permissionKey]))
        } else {
          setDraftPermissions(previous => ({ ...previous, [agentItem.permissionKey]: !previous[agentItem.permissionKey] }))
          setExplicitResourcePermissions(previous => new Set([...previous, agentItem.permissionKey]))
        }
      } else if (key === "enter" || key === "return") {
        if (!resourceCatalog || !resourceTargetAgent) return
        const initialWildcard = resourceCatalog.skills.find(item => item.kind === "skill-wildcard")?.allowed || false
        const initialAllowedSkills = new Set<string>(resourceCatalog.skills.filter(item => item.kind === "skill" && item.allowed).map(item => item.name))
        const allowedNames: string[] = Array.from(draftAllowedSkills)
        const skillsChanged = draftSkillAll !== initialWildcard || allowedNames.length !== initialAllowedSkills.size || allowedNames.some(name => !initialAllowedSkills.has(name))
        const permissions: Record<string, boolean> = Object.fromEntries([...resourceCatalog.tools, ...resourceCatalog.mcpServers]
          .filter(item => {
            const changed = draftPermissions[item.permissionKey] !== item.allowed
            const inheritedChildTool = item.kind === "tool" && Boolean(item.familyKey)
            return changed && (!inheritedChildTool || explicitResourcePermissions.has(item.permissionKey))
          })
          .map(item => [item.permissionKey, draftPermissions[item.permissionKey]]))
        const changes: AgentResourceChanges = {
          ...(skillsChanged ? { skills: { all: draftSkillAll, allowedNames } } : {}),
          ...(Object.keys(permissions).length ? { permissions } : {})
        }
        if (!changes.skills && !changes.permissions) {
          setLayoutStatus("No changes to save.")
          setViewMode("main")
          return
        }
        try {
          const target = resourceTargetAgent
          applyAgentMutation(
            [target.currentPath],
            writer => { updateAgentResources(target, resourceCatalog, changes, writer) },
            "Resources Updated",
            [`Updated skills, custom tools, and MCP permissions for:`, `  ${target.filename}`]
          )
        } catch (error: any) {
          setActionResultTitle("Error Updating Agent Resources")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
      }
    } else if (viewMode === "parameter-tuning") {
      // 12. Parameter tuning mode
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "tab" && tuningFocusedField === "variant") {
        const index = tuningVariantChoices.indexOf(tuningVariant)
        setTuningVariant(tuningVariantChoices[(index + 1 + tuningVariantChoices.length) % tuningVariantChoices.length])
        markTuningDirty("variant")
      } else if (key === "tab" || key === "down") {
        setTuningFocusedField((prev) =>
          prev === "steps" ? "temp" : prev === "temp" ? "variant" : prev === "variant" ? "mode" : prev === "mode" ? "hidden" : "steps"
        )
      } else if (key === "up") {
        setTuningFocusedField((prev) =>
          prev === "hidden" ? "mode" : prev === "mode" ? "variant" : prev === "variant" ? "temp" : prev === "temp" ? "steps" : "hidden"
        )
      } else if (key === "space") {
        if (tuningFocusedField === "variant") {
          const choices = tuningVariantChoices
          const currentIndex = choices.indexOf(tuningVariant)
          setTuningVariant(choices[(currentIndex + 1 + choices.length) % choices.length])
          markTuningDirty("variant")
        } else if (tuningFocusedField === "mode") {
          setTuningMode((prev) => (prev === "primary" ? "subagent" : "primary"))
          markTuningDirty("mode")
        } else if (tuningFocusedField === "hidden") {
          setTuningHidden((prev) => !prev)
          markTuningDirty("hidden")
        }
      } else if (key === "backspace") {
        if (tuningFocusedField === "steps") {
          if (!tuningDirtyFields.has("steps") && tuningSummary.steps.mixed) setTuningSteps("")
          else setTuningSteps(prev => prev.slice(0, -1))
          markTuningDirty("steps")
        } else if (tuningFocusedField === "temp") {
          if (!tuningDirtyFields.has("temp") && tuningSummary.temp.mixed) setTuningTemp("")
          else setTuningTemp(prev => prev.slice(0, -1))
          markTuningDirty("temp")
        } else if (tuningFocusedField === "variant") {
          setTuningVariant((prev) => prev.slice(0, -1))
          markTuningDirty("variant")
        }
      } else if (key === "enter" || key === "return") {
        const targetAgents = tuningTargetPaths.length > 0
          ? agents.filter((a) => tuningTargetPaths.includes(a.currentPath))
          : []
        if (tuningDirtyFields.size === 0) {
          setViewMode("main")
          setLayoutStatus("No parameters modified — left all agents unchanged.")
          return
        }
        if (targetAgents.length === 0) return

        try {
          const params = buildTuningUpdateParams(
            { steps: tuningSteps, temp: tuningTemp, variant: tuningVariant, mode: tuningMode, hidden: tuningHidden },
            tuningDirtyFields,
            modelVariants && modelVariants.length > 0 ? modelVariants : undefined
          )
          applyAgentMutation(
            targetAgents.map(a => a.currentPath),
            writer => updateAgentParams(targetAgents, params, writer),
            "Parameters Updated Successfully",
            [
              `Successfully tuned parameters for ${targetAgents.length} agents:`,
              `  * Steps:  ${tuningDirtyFields.has("steps") ? tuningSteps : "unchanged"}`,
              `  * Temp:   ${tuningDirtyFields.has("temp") ? tuningTemp : "unchanged"}`,
              `  * Variant (Effort): ${tuningDirtyFields.has("variant") ? (tuningVariant.trim() || "cleared (default)") : "unchanged"}`,
              `  * Mode:   ${tuningDirtyFields.has("mode") ? tuningMode : "unchanged"}`,
              `  * Hidden: ${tuningDirtyFields.has("hidden") ? tuningHidden : "unchanged"}`
            ]
          )
        } catch (error: any) {
          setLayoutStatus(error.message || String(error))
          return
        }
      } else if (/^[\x20-\x7E]$/.test(rawChar) && rawChar !== " ") {
        if (tuningFocusedField === "steps" && /[0-9]/.test(rawChar)) {
          if (!tuningDirtyFields.has("steps") && tuningSummary.steps.mixed) setTuningSteps(rawChar)
          else setTuningSteps(prev => prev + rawChar)
          markTuningDirty("steps")
        } else if (tuningFocusedField === "temp" && /[0-9]/.test(rawChar)) {
          if (!tuningDirtyFields.has("temp") && tuningSummary.temp.mixed) setTuningTemp(rawChar)
          else setTuningTemp(prev => prev + rawChar)
          markTuningDirty("temp")
        } else if (tuningFocusedField === "temp" && rawChar === ".") {
          if (!tuningDirtyFields.has("temp") && tuningSummary.temp.mixed) setTuningTemp("0.")
          else setTuningTemp(prev => rawChar === "." && prev.includes(".") ? prev : prev + rawChar)
          markTuningDirty("temp")
        } else if (tuningFocusedField === "variant" && /^[a-zA-Z0-9_-]$/.test(rawChar)) {
          setTuningVariant((prev) => prev + rawChar)
          markTuningDirty("variant")
        }
      } else if (key === "left" || key === "right") {
        if (tuningFocusedField === "variant") {
          const choices = tuningVariantChoices
          const currentIndex = choices.indexOf(tuningVariant)
          const nextIndex = currentIndex < 0
            ? (key === "right" ? 0 : choices.length - 1)
            : (currentIndex + (key === "right" ? 1 : -1) + choices.length) % choices.length
          setTuningVariant(choices[nextIndex])
          markTuningDirty("variant")
        } else if (tuningFocusedField === "mode") {
          setTuningMode(prev => prev === "primary" ? "subagent" : "primary")
          markTuningDirty("mode")
        } else if (tuningFocusedField === "hidden") {
          setTuningHidden(prev => !prev)
          markTuningDirty("hidden")
        }
      }
    } else if (viewMode === "rename-prompt") {
      // 13. Rename agent prompt mode
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "tab" || key === "down") {
        setRenameFocusedField((prev) =>
          prev === "family" ? "category" : prev === "category" ? "role" : "family"
        )
      } else if (key === "up") {
        setRenameFocusedField((prev) =>
          prev === "family" ? "role" : prev === "role" ? "category" : "family"
        )
      } else if (key === "backspace") {
        if (renameFocusedField === "family") {
          setRenameFamily((prev) => prev.slice(0, -1))
        } else if (renameFocusedField === "category") {
          setRenameCategory((prev) => prev.slice(0, -1))
        } else {
          setRenameRole((prev) => prev.slice(0, -1))
        }
      } else if (key === "enter" || key === "return") {
        const role = renameRole.trim().replace(/\s+/g, "_").replace(/-/g, "_")
        const cat = renameCategory.trim()
        const fam = renameFamily.trim()
        if (!renameTargetAgent || !cat || !role) return
        const newFilename = fam ? `${fam}-${cat}-${role}.md` : `${cat}-${role}.md`
        try {
           const destination = path.join(path.dirname(renameTargetAgent.currentPath), sanitizeFilename(newFilename))
            const tx = mutate([renameTargetAgent.currentPath, destination, ...agents.map(a => a.currentPath)], "rename", () => renameAgent(workspaceRoot, renameTargetAgent.currentPath, newFilename, agents))
            const result = tx.value
           try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
          setSelectedAgentPaths(new Set())
           setMutationSuccess("Rename Complete", [
             `Successfully renamed agent:`,
             `  ${middleEllipsis(renameTargetAgent.filename, Math.max(1, Math.floor(termWidth * 0.7) - 8))} → ${middleEllipsis(newFilename, Math.max(1, Math.floor(termWidth * 0.7) - 8))}`,
            ...result.updatedReferences.map((reference) => `  ${reference}`)
             , ...(result.skipped.length > 0 ? [`Skipped files:`, ...result.skipped.map((file) => `  ${file}`)] : []),
             ...(result.error ? [``, `⚠ ${result.error}`] : [])
           ], tx.warning)
          setViewMode("action-result")
        } catch (error: any) {
          setActionResultTitle("Error During Rename")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
      } else if (/^[\x20-\x7E]$/.test(rawChar)) {
        if (renameFocusedField === "family") {
          setRenameFamily((prev) => prev + rawChar)
        } else if (renameFocusedField === "category") {
          setRenameCategory((prev) => prev + rawChar)
        } else {
          setRenameRole((prev) => prev + rawChar)
        }
      }
    } else if (viewMode === "action-result") {
      // 10. Action result dialog
      const maxOffset = Math.max(0, actionResultLines.length - maxVisibleActionResultLines)
      if (key === "up" || key === "k") {
        setActionResultScrollOffset((offset) => Math.max(0, offset - 1))
      } else if (key === "down" || key === "j") {
        setActionResultScrollOffset((offset) => Math.min(maxOffset, offset + 1))
      } else if (key === "pageup") {
        setActionResultScrollOffset((offset) => Math.max(0, offset - maxVisibleActionResultLines))
      } else if (key === "pagedown") {
        setActionResultScrollOffset((offset) => Math.min(maxOffset, offset + maxVisibleActionResultLines))
      } else if (key === "y" && actionResultTitle === "Model Catalog Unavailable") {
        refreshModelCatalog()
        setViewMode("main")
      } else if (key === "escape" || key === "enter" || key === "return") {
        setViewMode("main")
      }
    } else {
      if (key === "escape") setViewMode("main")
    }
  })

  const updateScroll = (index: number) => {
    setScrollOffset((offset) => {
      if (index < offset) return Math.max(0, index)
      if (index >= offset + maxVisibleItems) return Math.max(0, index - maxVisibleItems + 1)
      return Math.max(0, offset)
    })
  }

  const updateDelegationScroll = (index: number) => {
    setDelegationScrollOffset((offset) => {
      if (index < offset) return index
      if (index >= offset + maxVisibleItems) return index - maxVisibleItems + 1
      return offset
    })
  }

  const updateModelScroll = (index: number) => {
    setModelScrollOffset((offset) => {
      if (index < offset) return index
      if (index >= offset + maxVisibleModels) return index - maxVisibleModels + 1
      return offset
    })
  }

  const updateColorScroll = (index: number) => {
    setColorScrollOffset((offset) => {
      if (index < offset) return index
      if (index >= offset + maxVisibleColors) return index - maxVisibleColors + 1
      return offset
    })
  }

  // Get active item
  const currentItem = activeItems[focusedIndex]
  const tuningAgents = viewMode === "parameter-tuning" && tuningTargetPaths.length > 0
    ? agents.filter(agent => tuningTargetPaths.includes(agent.currentPath))
    : selectedAgentPaths.size > 0
      ? agents.filter(agent => selectedAgentPaths.has(agent.currentPath))
      : currentItem?.type === "folder"
        ? agents.filter(agent => agent.category === currentItem.category)
        : currentItem?.agent ? [currentItem.agent] : []
  const tuningSummary = useMemo(() => inspectTuningTargets(tuningAgents), [tuningAgents])
  const tuningModels = Array.from(new Set<string>(tuningAgents.map(agent => agent.frontmatter.model)
    .filter((model): model is string => typeof model === "string" && model.trim().length > 0)))
  const modelVariants = tuningModels.length === 1
    ? getModelVariants(modelCatalog, tuningModels[0])
    : tuningModels.length > 1
      ? (() => {
          const variants = tuningModels.map(model => getModelVariants(modelCatalog, model))
          return variants.every((variant): variant is string[] => variant !== null)
            ? variants[0].filter(variant => variants.every(items => items.includes(variant)))
            : null
        })()
      : null
  const tuningVariantChoices = modelVariants !== null
    ? (modelVariants.length > 0 ? ["", ...modelVariants] : [""])
    : ["", ...AGENT_EFFORT_VARIANTS]
  if (tuningVariant && !tuningVariantChoices.includes(tuningVariant)) tuningVariantChoices.push(tuningVariant)

  const resourceInspector = useMemo(() => {
    if (inspectorTab !== "resources" || currentItem?.type !== "file" || !currentItem.agent) return { catalog: null, error: "" }
    try {
      return { catalog: discoverAgentResources(workspaceRoot, currentItem.agent, agents), error: "" }
    } catch (error: any) {
      return { catalog: null, error: terminalSafeText(error?.message || error) }
    }
  }, [inspectorTab, currentItem?.agent, agents, workspaceRoot])
  const resourceInspectorLines = useMemo(() => {
    const catalog = resourceInspector.catalog
    if (!catalog) return []
    return ["--- SKILLS ---", ...catalog.skills.map(item =>
      `* ${item.name} [${item.allowed ? "ALLOW" : "DENY"}]${item.exists ? "" : " [Dead Ref]"}`
    ), "--- CUSTOM TOOLS ---", ...catalog.tools.map(item =>
      `${item.kind === "tool-family" ? "*" : "  -"} ${item.name} [${item.allowed ? "ALLOW" : "DENY"}]`
    ), "--- MCP SERVERS ---", ...catalog.mcpServers.map(item =>
      `* ${item.name} [${item.allowed ? "ALLOW" : "DENY"}] ${item.configuredInOpencode
        ? `[MCP: ${item.serverEnabled ? "ON" : "OFF"}]`
        : item.recommendedInRepo
          ? "[Declared by its packs]"
          : "[Not declared by its packs nor installed]"}`
    )]
  }, [resourceInspector.catalog])
  const resourceManagerRows = useMemo<ResourceManagerRow[]>(() => resourceCatalog
    ? [...resourceCatalog.skills, ...resourceCatalog.tools, ...resourceCatalog.mcpServers].map(item => ({ kind: item.kind, item }))
    : [], [resourceCatalog])
  const maxVisibleResourceRows = Math.max(1, layout.listRows - 7)
  const visibleResourceRows = resourceManagerRows.slice(resourceModalScrollOffset, resourceModalScrollOffset + maxVisibleResourceRows)
  const resourceInspectorPageSize = Math.max(1, layout.listRows - 5)

  // Render viewport lists
  const visibleItems = activeItems.slice(scrollOffset, scrollOffset + maxVisibleItems)
  const visibleModels = modelTreeItems.slice(modelScrollOffset, modelScrollOffset + maxVisibleModels)
  const visibleColors = colorTreeItems.slice(colorScrollOffset, colorScrollOffset + maxVisibleColors)
  const visibleDelegationItems = delegationItems.slice(delegationScrollOffset, delegationScrollOffset + maxVisibleItems)
  const actionResultMaxOffset = Math.max(0, actionResultLines.length - maxVisibleActionResultLines)
  const visibleActionResultLines = actionResultLines.slice(
    actionResultScrollOffset,
    actionResultScrollOffset + maxVisibleActionResultLines
  )

  if (layout.mode === "too-small") {
    return <box width="100%" height="100%" padding={1} overflow="hidden" backgroundColor="#1e1e1e"><text style={{ textColor: "yellow" }}>Terminal too small. Please increase terminal size.</text></box>
  }

  return (
     <box
       width="100%"
      height="100%"
      minHeight={0}
      overflow="hidden"
      flexDirection="column"
      backgroundColor="#1e1e1e"
      padding={1}
    >
       {/* Header Banner */}
       <box
         width="100%"
         height={3}
        borderStyle="single"
        borderColor="#2B5581"
         justifyContent="center"
        alignItems="center"
         paddingLeft={2}
         paddingRight={2}
         flexDirection="row"
        >
          <box width={headerGroupWidth} height={1} flexShrink={0} flexDirection="row" overflow="hidden">
            <text width={headerTitleWidth} height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "#9ECBFF" }} b>
              {middleEllipsis(headerTitle, headerTitleWidth)}
            </text>
            <text width={1} height={1} wrapMode="none" overflow="hidden" flexShrink={0}> </text>
           <box width={visibleMetaWidth} height={1} flexShrink={0} flexDirection="row" overflow="hidden">
              {showCommit && <text width={commitWidth} height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: autoCommitEnabled() ? "green" : "gray" }}>{commitLabel}</text>}
              {showCommit && visibleWorkspaceWidth > 0 && <text width={separatorWidth} height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "gray" }}>{headerSeparator}</text>}
              {showCommit && visibleWorkspaceWidth > 0 && <text width={visibleWorkspaceWidth} height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "gray" }}>{middleEllipsis(workspaceLabel, visibleWorkspaceWidth)}</text>}
           </box>
          </box>
       </box>

      {statusMessage && (
        <box height={1} flexShrink={0} overflow="hidden">
          <text width={statusMessageWidth} height={1} wrapMode="none" overflow="hidden" style={{ textColor: "yellow" }}>
            {middleEllipsis(statusMessage, statusMessageWidth)}
          </text>
        </box>
      )}
      {viewMode === "repair-confirm" && (
        <box style={{ position: "absolute", left: "12%", top: "15%", width: "76%", height: "65%" }} borderStyle="double" borderColor="yellow" backgroundColor="#1e1e1e" title=" Confirm Grouped Model Repair " padding={1} flexDirection="column">
          <text style={{ textColor: "yellow" }} b>Review mappings before writing:</text>
          {invalidModelGroups.map((group, index) => {
            const agentCount = `${group.agents.length} agents`
            const separatorWidth = displayWidth(` →  (${agentCount})`)
            const modelBudget = Math.max(1, Math.floor((repairConfirmContentWidth - separatorWidth) / 2))
            return <text key={index} width="100%" height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: "white" }}>
              {`${middleEllipsis(JSON.stringify(group.value), modelBudget)} → ${middleEllipsis(repairMappings[String(index)] || "", modelBudget)} (${agentCount})`}
            </text>
          })}
          <text style={{ textColor: "gray" }} marginTop={1}>[Y/ENTER] Apply | [N/ESC] Cancel</text>
        </box>
      )}
      {/* Main Panel */}
      <box width="100%" minHeight={0} flexGrow={1} flexDirection="row" marginTop={1} overflow="hidden">
        {/* Left Side: Agents List (Wider to prevent filename cut-offs) */}
         <box
            width={listPanelWidth}
            flexGrow={0}
           minHeight={0}
          borderStyle="round"
          borderColor="#444444"
          title=" Agents (Tree) "
           titleColor="#9ECBFF"
           flexDirection="column"
           padding={1}
           overflow="hidden"
        >
           {/* Table Header */}
              <box width={listColumns.total} flexDirection="row" borderStyle="single" border={["bottom"]} borderColor="#333333">
                 <text wrapMode="none" overflow="hidden" style={{ textColor: "gray" }} width={columnWidth(0)}>Sel/Lint</text>{gutter("th1")}
                <text wrapMode="none" overflow="hidden" style={{ textColor: "gray" }} width={columnWidth(1)}>Agent Name</text>{gutter("th2")}
                <text wrapMode="none" overflow="hidden" style={{ textColor: "gray" }} width={columnWidth(2)}>Tier / Model</text>
             </box>

          {/* List items */}
           <box width="100%" height={layout.listRows} minHeight={0} overflow="hidden" flexGrow={0} flexShrink={0} flexDirection="column" marginTop={1}>
            {activeItems.length === 0 ? (
              <text style={{ textColor: "yellow" }}>
                {!activeDataSource
                  ? "No data source connected. Press [O] to connect a GitHub repo or local folder."
                  : searchQuery
                    ? `No agents match search: "${searchQuery}"`
                    : "No agent markdown files found in this source (press [O] to switch sources)."}
              </text>
            ) : (
              visibleItems.map((item, index) => {
                const globalIndex = scrollOffset + index
                const isFocused = globalIndex === focusedIndex

                const rowBg = isFocused ? "#2B5581" : "transparent"
                const itemColor = isFocused ? "#FFFFFF" : item.type === "folder" ? "yellow" : "#9ECBFF"

                const isSelected = item.agent ? selectedAgentPaths.has(item.id) : false
                const modelText = item.agent ? modelDisplayValue(item.agent, true, modelCatalog) : ""
                const analysis = item.agent ? analyzeAgentName(item.agent.filename, allAgentFilenames) : null
                const lintBadge = analysis ? (analysis.isValid ? "✓" : "⚠") : ""
                const lintColor = analysis ? (analysis.isValid ? "green" : "yellow") : "yellow"

                   return (
                    <box
                      key={`${item.type}-${item.id}`}
                      width="100%"
                      flexDirection="row"
                      backgroundColor={rowBg}
                       height={1}
                    >
                       <text style={{ textColor: item.type === "file" ? (isSelected ? "green" : lintColor) : "yellow" }} width={columnWidth(0)} wrapMode="none" overflow="hidden">
                         {item.type === "file" ? `${isSelected ? "[x]" : "[ ]"} ${lintBadge}` : " "}
                       </text>
                       {gutter(`tree-${item.id}-1`)}
                       <text style={{ textColor: itemColor }} width={columnWidth(1)} wrapMode="none" overflow="hidden" u={isFocused && item.type === "file"}>
                          {middleEllipsis(item.type === "file" ? item.label : ` ${item.label}`, columnWidth(1))}
                       </text>
                       {gutter(`tree-${item.id}-2`)}
                        {item.type === "file" && <text style={{ textColor: "magenta" }} width={columnWidth(2)} wrapMode="none" overflow="hidden">{middleEllipsis(`${resolvedAgents.get(item.agent!.currentPath)?.tier || "-"} / ${modelText}`, columnWidth(2))}</text>}
                       {item.type !== "file" && <text width={columnWidth(2)}> </text>}
                     </box>
                   )
              })
            )}
          </box>

          {/* Real-time search filter display */}
           <box width="100%" height={3} flexShrink={0} padding={1} borderStyle="single" border={["top"]} borderColor="#333333" flexDirection="row" alignItems="center" overflow="hidden">
             <text wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: isSearching ? "yellow" : "gray" }}>
              {isSearching ? "🔍 Filter typing: " : "🔍 Filter (Press /): "}
            </text>
             <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: searchQuery ? "cyan" : "gray" }} b>
               {middleEllipsis(searchQuery ? `${searchQuery}_` : isSearching ? "type here..._" : "none", 40)}
            </text>
          </box>

          {/* List Footer / Counter */}
           <box width="100%" height={2} flexShrink={0} justifyContent="space-between" paddingTop={1} borderStyle="single" border={["top"]} borderColor="#333333" overflow="hidden" flexDirection="row">
              <text width={footerFirstWidth} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "gray" }}>
               {middleEllipsis(`Total: ${agents.length} | Shown: ${activeItems.length} | Selected: ${selectedAgentPaths.size}`, 36)}
             </text>
              <text width={footerSecondWidth} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "gray" }}>
                {middleEllipsis("[/] Search | ◀/▶ Collapse/Expand", 36)}
            </text>
          </box>
        </box>

         {layout.showInspector && <>
         <text width={panelWidths.gutter}> </text>
        {/* Right Side: Details & Actions (Tabbed Inspector) */}
         <box
            width={panelWidths.inspector}
            flexGrow={0}
           minHeight={0}
          borderStyle="round"
          borderColor="#444444"
          title=" Inspector "
          titleColor="#9ECBFF"
          flexDirection="column"
          padding={1}
           overflow="hidden"
        >
          {/* Tab Navigation Bar */}
          <box flexDirection="row" width="100%" borderStyle="single" border={["bottom"]} borderColor="#333333" paddingBottom={1} marginBottom={1}>
            <text style={{ textColor: inspectorTab === "overview" ? "cyan" : "gray" }} u={inspectorTab === "overview"}>
              1.Info
            </text>
            <text style={{ textColor: "gray" }}>|</text>
            <text style={{ textColor: inspectorTab === "naming" ? "yellow" : "gray" }} u={inspectorTab === "naming"}>
              2.Name
            </text>
            <text style={{ textColor: "gray" }}>|</text>
            <text style={{ textColor: inspectorTab === "security" ? "red" : "gray" }} u={inspectorTab === "security"}>
              3.Sec
            </text>
            <text style={{ textColor: "gray" }}>|</text>
            <text style={{ textColor: inspectorTab === "delegations" ? "green" : "gray" }} u={inspectorTab === "delegations"}>
              4.Graph
            </text>
            <text style={{ textColor: "gray" }}>|</text>
            <text style={{ textColor: inspectorTab === "resources" ? "magenta" : "gray" }} u={inspectorTab === "resources"}>
              5.Res
            </text>
          </box>

          {currentItem ? (
             <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
              {currentItem.type === "file" && currentItem.agent ? (
                <box flexDirection="column" flexGrow={1}>
                  <text style={{ textColor: "#9ECBFF" }} b>
                     {middleEllipsis(currentItem.agent.filename, 30)}
                  </text>

                  {/* TAB 1: OVERVIEW */}
                  {inspectorTab === "overview" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1}>
                      <box flexDirection="row">
                        <text style={{ textColor: "gray" }} width="35%">Pack:</text>
                        <text style={{ textColor: "yellow" }} width="65%">
                           {middleEllipsis(currentItem.agent.category, 30)}
                        </text>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Model:</text>
                        <text style={{ textColor: "cyan" }} width="65%">
                          {middleEllipsis(modelDisplayValue(currentItem.agent, false, modelCatalog), 30)}
                        </text>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Color:</text>
                        <box flexDirection="row" width="65%">
                          {(() => {
                            const rawCol = currentItem.agent.frontmatter.color
                             if (!rawCol) return <text style={{ textColor: "gray" }}>Not set</text>
                             if (typeof rawCol !== "string") return <text style={{ textColor: "red" }}>{`Invalid: ${middleEllipsis(terminalSafeText(rawCol), 20)}`}</text>
                            
                            // Find matching color hex from palette or raw hex
                            let hexColor = rawCol.startsWith("#") ? rawCol : "#9ECBFF"
                            COLOR_PALETTE.forEach(group => {
                              group.colors.forEach(c => {
                                if (c.value === rawCol) hexColor = c.hex
                              })
                            })

                            return (
                              <box flexDirection="row">
                                <box width={2} height={1} backgroundColor={hexColor} marginRight={1}>
                                  <text>{" "}</text>
                                </box>
                                 <text style={{ textColor: "white" }}>{middleEllipsis(rawCol, 20)}</text>
                              </box>
                            )
                          })()}
                        </box>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Steps/Temp:</text>
                        <text style={{ textColor: "white" }}>
                           {middleEllipsis(`${currentItem.agent.frontmatter.steps || 50} steps / ${currentItem.agent.frontmatter.temperature ?? 0.2}°`, 30)}
                        </text>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Thinking / Effort:</text>
                        <text style={{ textColor: currentItem.agent.frontmatter.variant ? "cyan" : "gray" }} width="65%">
                          {middleEllipsis(`${String(currentItem.agent.frontmatter.variant ?? "default")}${currentItem.agent.frontmatter.reasoningEffort ?? currentItem.agent.frontmatter.options?.reasoningEffort ? ` (reasoningEffort: ${String(currentItem.agent.frontmatter.reasoningEffort ?? currentItem.agent.frontmatter.options?.reasoningEffort)})` : ""}`, 36)}
                        </text>
                      </box>

                      <box flexDirection="column" marginTop={1} flexGrow={1}>
                        <text style={{ textColor: "gray" }}>Description:</text>
                        <box borderStyle="single" borderColor="#333333" padding={1} marginTop={1} flexGrow={1}>
                          <text style={{ textColor: "white" }}>
                             {terminalSafeText(currentItem.agent.description || "No description provided.")}
                          </text>
                        </box>
                      </box>
                    </box>
                  )}

                  {/* TAB 2: NAMING CONVENTION */}
                  {inspectorTab === "naming" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1}>
                      {(() => {
                        const analysis = analyzeAgentName(currentItem.agent.filename, allAgentFilenames)
                        return (
                          <box flexDirection="column" borderStyle="single" borderColor="#333333" padding={1} flexGrow={1}>
                            <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                              <text style={{ textColor: "white" }} b>Naming Status:</text>
                              <text style={{ textColor: analysis.isValid ? "green" : "yellow" }} b>
                                {analysis.isValid ? "✓ Valid" : "⚠ Non-Compliant"}
                              </text>
                            </box>
                            <box flexDirection="row" marginTop={1}>
                              <text style={{ textColor: "gray" }} width="35%">Family:</text>
                              <text style={{ textColor: "cyan" }}>{middleEllipsis(analysis.family || "(none)", 30)}</text>
                            </box>
                            <box flexDirection="row">
                              <text style={{ textColor: "gray" }} width="35%">Pack:</text>
                              <text style={{ textColor: "yellow" }}>{middleEllipsis(analysis.category || "(none)", 30)}</text>
                            </box>
                            <box flexDirection="row">
                              <text style={{ textColor: "gray" }} width="35%">Role:</text>
                              <text style={{ textColor: "white" }}>{middleEllipsis(analysis.role || "(none)", 30)}</text>
                            </box>
                            {!analysis.isValid && analysis.suggestedName && (
                              <box flexDirection="column" marginTop={1}>
                                <text style={{ textColor: "gray" }}>Suggested Name:</text>
                                 <text style={{ textColor: "green" }}>{middleEllipsis(analysis.suggestedName, 40)}</text>
                              </box>
                            )}
                          </box>
                        )
                      })()}
                    </box>
                  )}

                  {/* TAB 3: SECURITY MATRIX & PERMISSION DETAILS */}
                  {inspectorTab === "security" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1}>
                      {(() => {
                        const permSummary = getAgentPermissionSummary(currentItem.agent)
                         const orderCheck = analyzePermissionOrder(currentItem.agent)
                         const perm = currentItem.agent.frontmatter.permission || {}
                         const permissionEntries = Object.entries(perm).filter(([key]) => key !== "task")
                         const permissionPageSize = Math.max(1, maxVisibleItems - 2)

                        return (
                          <box flexDirection="column" borderStyle="single" borderColor="#333333" padding={1} flexGrow={1} overflow="hidden">
                            <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                              <text style={{ textColor: "white" }} b>Security Matrix:</text>
                              <text style={{ textColor: permSummary.riskLevel === "HIGH" ? "red" : permSummary.riskLevel === "MEDIUM" ? "yellow" : "green" }} b>
                                {`${permSummary.riskLevel} RISK`}
                              </text>
                            </box>

                            {/* Order Error Alert */}
                            {orderCheck.hasOrderError && (
                              <box flexDirection="column" marginTop={1} backgroundColor="#5A1818" padding={1}>
                                <text style={{ textColor: "red" }} b>⚠ PERMISSION ORDER ERROR!</text>
                                <text style={{ textColor: "white" }}>Wildcard "*": "deny" MUST be first.</text>
                              <text style={{ textColor: "yellow" }} b>[Press SHIFT+F to Fix order]</text>
                              </box>
                            )}

                            {/* Permission Details */}
                            <box flexDirection="column" marginTop={1}>
                              <text style={{ textColor: "yellow" }} b>Frontmatter Permissions:</text>
                              {permissionEntries.slice(graphScrollOffset, graphScrollOffset + permissionPageSize).map(([key, val]) => {
                                let valStr = typeof val === "object" ? JSON.stringify(val) : String(val)
                                 const safeKey = middleEllipsis(key, 30)
                                 const safeVal = middleEllipsis(valStr, 40)
                                 const isDanger = key === "bash" && (val === "allow" || val === true || valStr.includes("allow"))
                                return (
                                  <box key={key} flexDirection="row" justifyContent="space-between">
                                     <text style={{ textColor: "gray" }}>{`${safeKey}:`}</text>
                                     <text style={{ textColor: isDanger ? "red" : "cyan" }}>{safeVal}</text>
                                  </box>
                                )
                              })}
                              {permissionEntries.length > permissionPageSize && <text style={{ textColor: "gray" }} flexShrink={0}>
                                {`▲ ${graphScrollOffset + 1}-${Math.min(graphScrollOffset + permissionPageSize, permissionEntries.length)}/${permissionEntries.length} ▼`}
                              </text>}
                            </box>
                          </box>
                        )
                      })()}
                    </box>
                  )}

                  {/* TAB 4: DELEGATIONS GRAPH (SCROLLABLE) */}
                  {inspectorTab === "delegations" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1}>
                      {(() => {
                        const allowed = currentItem.agent.allowedSubagents || []
                        return (
                          <box flexDirection="column" flexGrow={1}>
                            <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                              <text style={{ textColor: "gray" }}>Authorized Subagents:</text>
                              <text style={{ textColor: "yellow" }}>{`${allowed.length} total`}</text>
                            </box>

                            <box borderStyle="single" borderColor="#333333" padding={1} marginTop={1} flexGrow={1} overflow="hidden">
                              {allowed.length > 0 ? (
                                allowed.slice(graphScrollOffset, graphScrollOffset + Math.max(1, maxVisibleItems - 2)).map((subName) => {
                                  const exists = agents.some((a) => a.filename.replace(/\.md$/, "") === subName)
                                  return (
                                    <box key={subName} flexDirection="row" justifyContent="space-between">
                                      <text style={{ textColor: exists ? "cyan" : "red" }}>
                                         {middleEllipsis(exists ? `├─ @${subName}` : `├─ ❌ @${subName} (Dead Ref)`, 40)}
                                      </text>
                                    </box>
                                  )
                                })
                              ) : (
                                <text style={{ textColor: "gray" }}>No subagents authorized.</text>
                              )}
                              {allowed.length > Math.max(1, maxVisibleItems - 2) && <text style={{ textColor: "gray" }} flexShrink={0}>
                                {`▲ ${graphScrollOffset + 1}-${Math.min(graphScrollOffset + Math.max(1, maxVisibleItems - 2), allowed.length)}/${allowed.length} ▼`}
                              </text>}
                            </box>
                          </box>
                        )
                      })()}
                    </box>
                  )}

                  {inspectorTab === "resources" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0} overflow="hidden">
                      {resourceInspector.error ? (
                        <text style={{ textColor: "red" }}>{resourceInspector.error}</text>
                      ) : (
                        <>
                          <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
                            {resourceInspectorLines.slice(resourceScrollIndex, resourceScrollIndex + resourceInspectorPageSize).map((line, index) => (
                              <text key={`${resourceScrollIndex}-${index}`} style={{ textColor: line.startsWith("---") ? "yellow" : line.includes("[DENY]") || line.includes("[Dead Ref]") ? "red" : "white" }} wrapMode="none" overflow="hidden">
                                {middleEllipsis(line, Math.max(1, panelWidths.inspector - 6))}
                              </text>
                            ))}
                          </box>
                          {resourceInspectorLines.length > resourceInspectorPageSize && <text style={{ textColor: "gray" }} flexShrink={0}>
                            {`▲ ${resourceScrollIndex + 1}-${Math.min(resourceScrollIndex + resourceInspectorPageSize, resourceInspectorLines.length)}/${resourceInspectorLines.length} ▼`}
                          </text>}
                          <text style={{ textColor: "cyan" }} flexShrink={0}>Press 'u' to edit Skills, Tools &amp; MCP</text>
                        </>
                      )}
                    </box>
                  )}
                </box>
              ) : (
                <box flexDirection="column" flexGrow={1} overflow="hidden">
                  <text style={{ textColor: "yellow" }} b>
                     {middleEllipsis(`📁 Pack: ${currentItem.category.toUpperCase()}`, 40)}
                  </text>
                  <text style={{ textColor: "white" }} marginTop={1}>
                     {middleEllipsis(`Directory: ${path.relative(workspaceRoot, packDir(workspaceRoot, currentItem.category) ?? workspaceRoot) || "."}/`, 50)}
                  </text>
                  {(() => {
                    const folderDir = packDir(workspaceRoot, currentItem.category)
                    const isVirtual = Boolean(folderDir && !fs.existsSync(path.join(folderDir, "opencode-pack.json")))
                    return (
                      <box flexDirection="column" marginTop={1}>
                        <text style={{ textColor: isVirtual ? "cyan" : "green" }}>
                          {middleEllipsis(isVirtual ? "Format: Virtual .md Pack (no opencode-pack.json)" : "Format: OpenCode Pack (opencode-pack.json)", Math.max(20, panelWidths.inspector - 6))}
                        </text>
                        <text style={{ textColor: "cyan" }}>
                          {middleEllipsis(`[M] Conditional IF/OR Flows${isVirtual && !isReadOnlyGitSource ? " · [I] Init opencode-pack.json" : ""}`, Math.max(20, panelWidths.inspector - 6))}
                        </text>
                      </box>
                    )
                  })()}
                  <text style={{ textColor: "gray" }} marginTop={1}>
                    Purpose Summary:
                  </text>
                  <box borderStyle="single" borderColor="#333333" padding={1} marginTop={1} flexGrow={1}>
                    <text style={{ textColor: "white" }}>
                       {terminalSafeText(packDescription(currentItem.category))}
                    </text>
                  </box>
                </box>
              )}
            </box>
          ) : (
            <box flexGrow={1} justifyContent="center" alignItems="center">
              <text style={{ textColor: "yellow" }}>Select an item to inspect details</text>
            </box>
          )}

         </box></>}
      </box>

        {(() => {
          const footerInnerWidth = Math.max(0, termWidth - 6)
          const compact = footerInnerWidth < 118
          const showInitHint = isWorkspaceVirtualPack
            const footerRows = viewMode !== "main" ? [[], [], []] : compact ? [
              [["O", "Sources"], ["SPACE", "Sel"], ["A", "All"], ["S", "Match"], ["/", "Search"], ["1-5", "Tabs"]],
              [["M", "Mod/Flows"], ["C", "Col"], ["P", "Perm"], ["G", "Del"], ["T", "Tun"], ["S+T", "Tier"], ["S+L", "Layout"]],
              [["B", "Claude"], ["S+B", "Codex"], ["R", "Rename"], ["E", "Install"], ...(showInitHint ? [["I", "InitPack"]] : []), ["V", "Repair"], ["U", "Resources"]]
            ] : [
              [["O", "Sources"], ["SPACE", "Select"], ["A", "All"], ["S", "Same model"], ["/", "Search"], ["1-5", "Inspector"]],
              [["M", "Model/Flows"], ["C", "Color"], ["P", "Permissions"], ["G", "Delegations"], ["T", "Tune"], ["SHIFT+T", "Tier"], ["V", "Repair"]],
              [["B", "Claude bridge"], ["SHIFT+B", "Codex bridge"], ["R", "Rename"], ["E", "Install"], ...(showInitHint ? [["I", "Init pack"]] : []), ["U", "Skills/Tools"], ["SHIFT+L", "Layout"]]
          ]
         return (
           <box height={5} flexShrink={0} overflow="hidden" flexDirection="column" borderStyle="single" borderColor="#2B5581" paddingLeft={1} paddingRight={1}>
             {footerRows.map((row, rowIndex) => (
               <box key={rowIndex} height={1} flexShrink={0} flexDirection="row" overflow="hidden">
                 {row.map(([shortcut, action], index) => (
                   <React.Fragment key={shortcut}>
                      {index > 0 && <text wrapMode="none" flexShrink={0} style={{ textColor: "#E1E4E8" }}>{compact ? " " : " | "}</text>}
                     <text wrapMode="none" flexShrink={0} style={{ textColor: "#E1E4E8" }}>{`[${shortcut}]`}</text>
                     <text wrapMode="none" flexShrink={0} style={{ textColor: "#E1E4E8" }}>{` ${action}`}</text>
                   </React.Fragment>
                 ))}
               </box>
             ))}
           </box>
         )
       })()}

       {viewMode === "layout" && (
         <box style={{ position: "absolute", left: "10%", top: "24%", width: "80%", height: "52%" }} borderStyle="double" borderColor="cyan" backgroundColor="#1e1e1e" title=" Layout " titleColor="cyan" padding={1} flexDirection="column" justifyContent="space-between" overflow="hidden">
           <box flexDirection="column" overflow="hidden">
             <text style={{ textColor: "white" }} b>Adjust the normal list / inspector split</text>
             <text style={{ textColor: "cyan" }} marginTop={1}>{`List ${Math.round(layoutDraft * 100)}%  /  Inspector ${Math.round((1 - layoutDraft) * 100)}%`}</text>
             <text style={{ textColor: "gray" }} marginTop={1} wrapMode="none" overflow="hidden">{`[${"=".repeat(Math.max(1, Math.round(layoutDraft * 30)))}|${"-".repeat(Math.max(1, 30 - Math.round(layoutDraft * 30)))}]`}</text>
             <text style={{ textColor: "gray" }} marginTop={1}>Preview applies to normal mode; the inspector may be hidden at this width.</text>
             {configReadOnly && <text style={{ textColor: "yellow" }} marginTop={1}>Environment override is read-only: preview only; Enter will not save.</text>}
             {layoutError && <text style={{ textColor: "red" }} marginTop={1} wrapMode="none" overflow="hidden">{layoutError}</text>}
           </box>
           <box borderStyle="single" border={['top']} borderColor="#333333" paddingTop={1}>
             <text style={{ textColor: "gray" }}>←/→ or h/l adjust | ↑/↓ also adjust | Home .60 | End .75 | R reset</text>
             <text style={{ textColor: "green" }}>[ENTER] Save | [ESC] Cancel</text>
           </box>
         </box>
       )}

       {/* Modal - Permission Presets */}
      {viewMode === "permission-preset" && (
        <box
          style={{
            position: "absolute",
           left: "8%",
           top: "8%",
           width: "84%",
           height: "84%"
          }}
          borderStyle="double"
          borderColor="#E74C3C"
          backgroundColor="#1e1e1e"
          title=" Apply Safety Preset "
          titleColor="#E74C3C"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column">
            <text style={{ textColor: "white" }} paddingBottom={1}>
              Select safety preset to apply to {selectedAgentPaths.size > 0 ? selectedAgentPaths.size : 1} agents:
            </text>
            <box flexDirection="column" marginTop={1}>
              {SAFETY_PRESETS.map((preset, idx) => {
                const isFocused = idx === focusedPresetIndex
                return (
                  <box
                    key={preset.key}
                    backgroundColor={isFocused ? "#2B5581" : "transparent"}
                    padding={1}
                    flexDirection="column"
                    marginTop={idx > 0 ? 1 : 0}
                  >
                    <text style={{ textColor: isFocused ? "#FFFFFF" : "yellow" }} b>
                      {isFocused ? `► ${preset.name}` : `  ${preset.name}`}
                    </text>
                    <text style={{ textColor: "#E1E4E8" }}>
                      {`   ${preset.description}`}
                    </text>
                  </box>
                )
              })}
            </box>
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} flexShrink={0}>
            <text style={{ textColor: "gray" }}>[↑/↓] Select Preset | [ENTER] Apply to Selected</text>
            <text style={{ textColor: "red" }} b>[ESC] Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Subagent Delegation Manager */}
      {viewMode === "delegation-manager" && delegationTargetAgent && (
        <box
          style={{
            position: "absolute",
            left: "12%",
            top: "12%",
            width: "76%",
            height: "76%"
          }}
          borderStyle="double"
          borderColor="#3498DB"
          backgroundColor="#1e1e1e"
           title={` Delegation Manager: ${middleEllipsis(delegationTargetAgent.filename, 45)} `}
          titleColor="#3498DB"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <text style={{ textColor: "white" }} flexShrink={0}>
              Toggle subagents authorized for invocation via permission.task:
            </text>

            <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
              {visibleDelegationItems.map((ag) => {
                const idx = delegationItems.indexOf(ag)
                const subName = ag.filename.replace(/\.md$/, "")
                const isSelected = selectedDelegations.has(subName)
                const isFocused = idx === focusedDelegationIndex

                return (
                  <box
                    key={ag.currentPath}
                    backgroundColor={isFocused ? "#2B5581" : "transparent"}
                    paddingLeft={1}
                    height={1}
                    flexDirection="row"
                  >
                    <text style={{ textColor: isSelected ? "green" : "gray" }} width="8%">
                      {isSelected ? "[x]" : "[ ]"}
                    </text>
                    <text style={{ textColor: isFocused ? "#FFFFFF" : "#9ECBFF" }} width="50%">
                       {middleEllipsis(ag.filename, 35)}
                    </text>
                    <text style={{ textColor: "yellow" }} width="20%">
                       {middleEllipsis(ag.category, 15)}
                    </text>
                    <text style={{ textColor: "gray" }} width="22%">
                       {middleEllipsis(ag.model.split("/").pop() || "", 15)}
                    </text>
                  </box>
                )
              })}
            </box>
          </box>

           <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} flexShrink={0}>
            {delegationItems.length > maxVisibleItems && <text style={{ textColor: "gray" }} flexShrink={0}>
              {`▲ ${delegationScrollOffset + 1}-${Math.min(delegationScrollOffset + maxVisibleItems, delegationItems.length)}/${delegationItems.length} ▼`}
            </text>}
            <text style={{ textColor: "gray" }}>[↑/↓] Navigate | [SPACE] Toggle | [ENTER] Save</text>
            <text style={{ textColor: "red" }} b>[ESC] Cancel</text>
          </box>
        </box>
      )}

      {viewMode === "resource-manager" && resourceCatalog && (
        <box
          style={{ position: "absolute", left: "10%", top: "8%", width: "80%", height: "84%" }}
          borderStyle="double"
          borderColor="#9B59B6"
          backgroundColor="#1e1e1e"
          title={` Resource Manager: ${middleEllipsis(resourceTargetAgent?.filename ?? "", 38)} `}
          titleColor="#9B59B6"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
        >
          <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            <text style={{ textColor: "white" }} flexShrink={0}>Toggle the skills, custom tools and MCP servers this agent may use (from its pack and the packs it requires).</text>
            <box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0} overflow="hidden">
              {resourceTargetAgent && <text style={{ textColor: "yellow" }}>--- AGENT RESOURCES ---</text>}
              {visibleResourceRows.map((row, index) => {
                const rowIndex = resourceModalScrollOffset + index
                const item = row.item
                const isFocused = rowIndex === resourceModalFocusIndex
                const agentResource = item
                const allowed = row.kind === "skill-wildcard"
                  ? draftSkillAll
                  : row.kind === "skill"
                    ? draftAllowedSkills.has(agentResource.name)
                    : draftPermissions[agentResource.permissionKey]
                const tag = row.kind === "skill-wildcard" || row.kind === "skill" ? "[SKILL]"
                  : row.kind === "tool-family" ? "[TOOL-GRP]"
                    : row.kind === "tool" ? "[TOOL]" : "[MCP]"
                const mcpItem = agentResource as AgentMcpResourceItem
                const status = row.kind === "mcp"
                  ? mcpItem.configuredInOpencode
                    ? ` [MCP: ${mcpItem.serverEnabled ? "ON" : "OFF"}]`
                    : mcpItem.recommendedInRepo ? " [declared by its packs]" : " [not declared nor installed]"
                  : ""
                return (
                  <box key={`${item.id}-${rowIndex}`} backgroundColor={isFocused ? "#2B5581" : "transparent"} height={1} flexShrink={0} flexDirection="row">
                    <text width={8} style={{ textColor: allowed ? "green" : "gray" }}>{allowed ? "[x]" : "[ ]"}</text>
                    <text width={12} style={{ textColor: "magenta" }}>{tag}</text>
                    <text flexGrow={1} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "white" : "#E1E4E8" }} u={isFocused}>
                      {middleEllipsis(item.name, Math.max(1, panelWidths.inspector + panelWidths.list - 42))}
                    </text>
                    <text style={{ textColor: row.kind === "mcp" && mcpItem.configuredInOpencode && mcpItem.serverEnabled ? "green" : "gray" }}>{status}</text>
                  </box>
                )
              })}
            </box>
          </box>
          <box flexDirection="column" flexShrink={0} borderStyle="single" border={['top']} borderColor="#333333" paddingTop={1} overflow="hidden">
            {resourceManagerRows.length > maxVisibleResourceRows && <text style={{ textColor: "gray" }} flexShrink={0}>
              {`▲ ${resourceModalScrollOffset + 1}-${Math.min(resourceModalScrollOffset + maxVisibleResourceRows, resourceManagerRows.length)}/${resourceManagerRows.length} ▼`}
            </text>}
            <text style={{ textColor: "gray" }} wrapMode="none" overflow="hidden">Navigate: ↑/↓ | Space: Toggle | Enter: Save | Esc: Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Parameter Tuning */}
      {viewMode === "parameter-tuning" && (
        <box
          style={{
            position: "absolute",
            left: "15%",
             top: layout.mode === "compact" ? "0%" : "15%",
            width: "70%",
             height: layout.mode === "compact" ? "100%" : "70%"
          }}
          borderStyle="double"
          borderColor="#F1C40F"
          backgroundColor="#1e1e1e"
           title={` Tune Agent Parameters (${tuningTargetPaths.length} agents) `}
          titleColor="#F1C40F"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column" gap={layout.mode === "compact" ? 0 : 1} overflow="hidden" flexShrink={0}>
            <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: "white" }}>
              Regulate execution limits, temperature, thinking effort, mode, and visibility:
            </text>

            {/* Steps field */}
            <box
              flexDirection="row"
              height={3}
              flexShrink={0}
              borderStyle="single"
              borderColor={tuningFocusedField === "steps" ? "#F1C40F" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
               marginTop={layout.mode === "compact" ? 0 : 1}
            >
              <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningFocusedField === "steps" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "steps" ? "► 1. Max Agentic Steps (e.g. 50):" : "  1. Max Agentic Steps:"}
              </text>
              <text width="40%" height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "white" }}>{!tuningDirtyFields.has("steps") && tuningSummary.steps.mixed ? tuningSummary.steps.displayMixed : `${tuningSteps}${!tuningDirtyFields.has("steps") && tuningTargetPaths.length > 1 ? " (unchanged)" : ""}`}</text>
            </box>

            {/* Temp field */}
            <box
              flexDirection="row"
              borderStyle="single"
              borderColor={tuningFocusedField === "temp" ? "#F1C40F" : "#333333"}
              height={3}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
            >
              <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningFocusedField === "temp" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "temp" ? "► 2. Temperature (e.g. 0.1 - 0.7):" : "  2. Temperature:"}
              </text>
              <text width="40%" height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "white" }}>{!tuningDirtyFields.has("temp") && tuningSummary.temp.mixed ? tuningSummary.temp.displayMixed : `${tuningTemp}${!tuningDirtyFields.has("temp") && tuningTargetPaths.length > 1 ? " (unchanged)" : ""}`}</text>
            </box>

            {/* Thinking / Effort field */}
            <box
              flexDirection="column"
              height={4}
              flexShrink={0}
              borderStyle="single"
              borderColor={tuningFocusedField === "variant" ? "#F1C40F" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
            >
              <box flexDirection="row" height={1}>
                <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningFocusedField === "variant" ? "#F1C40F" : "gray" }} b>
                  {tuningFocusedField === "variant" ? "► 3. Thinking / Effort (variant):" : "  3. Thinking / Effort:"}
                </text>
                <text width="40%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "cyan" }}>
                  {!tuningDirtyFields.has("variant") && tuningSummary.variant.mixed ? tuningSummary.variant.displayMixed : `${tuningVariant || "(default / unset)"}${!tuningDirtyFields.has("variant") && tuningTargetPaths.length > 1 ? " (unchanged)" : ""}`}
                </text>
              </box>
              {tuningFocusedField === "variant" && <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>{modelVariants !== null && modelVariants.length > 0
                ? `[Space/←/→: model variants (${modelVariants.join(" | ")}) | type custom | Backspace: clear]`
                : modelVariants !== null
                  ? "[Model exposes no preset variants in OpenCode | type custom | Backspace: clear]"
                  : `[Space/←/→: none/${AGENT_EFFORT_VARIANTS.join("/")} | type custom | Backspace: clear]`}</text>}
            </box>

            {/* Mode field */}
            <box
              flexDirection="row"
              borderStyle="single"
              borderColor={tuningFocusedField === "mode" ? "#F1C40F" : "#333333"}
              height={3}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
            >
              <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningFocusedField === "mode" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "mode" ? "► 4. Mode (Press SPACE to toggle):" : "  4. Mode:"}
              </text>
              <text width="40%" height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "yellow" }}>{!tuningDirtyFields.has("mode") && tuningSummary.mode.mixed ? tuningSummary.mode.displayMixed : `${tuningMode.toUpperCase()}${!tuningDirtyFields.has("mode") && tuningTargetPaths.length > 1 ? " (unchanged)" : ""}`}</text>
            </box>

            {/* Hidden field */}
            <box
              flexDirection="row"
              borderStyle="single"
              borderColor={tuningFocusedField === "hidden" ? "#F1C40F" : "#333333"}
              height={3}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
            >
              <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningFocusedField === "hidden" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "hidden" ? "► 5. Hidden Status (Press SPACE to toggle):" : "  5. Hidden Status:"}
              </text>
              <text width="40%" height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningHidden ? "red" : "green" }}>{!tuningDirtyFields.has("hidden") && tuningSummary.hidden.mixed ? tuningSummary.hidden.displayMixed : `${tuningHidden ? "TRUE" : "FALSE"}${!tuningDirtyFields.has("hidden") && tuningTargetPaths.length > 1 ? " (unchanged)" : ""}`}</text>
            </box>
          </box>

          <box height={2} flexShrink={0} justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} overflow="hidden" flexDirection="row">
            <text width="78%" wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>{middleEllipsis("[TAB/↑/↓] Switch Fields | [SPACE] Variant/Toggle | [ENTER] Save", 58)}</text>
            <text width="22%" wrapMode="none" overflow="hidden" style={{ textColor: "red" }} b>[ESC] Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Rename Assistant */}
      {viewMode === "rename-prompt" && renameTargetAgent && (
        <box
          style={{
            position: "absolute",
            left: "15%",
            top: "15%",
            width: "70%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="#9B59B6"
          backgroundColor="#1e1e1e"
          title=" Rename Agent (Naming Convention) "
          titleColor="#9B59B6"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column" gap={1}>
            <box flexDirection="row">
              <text style={{ textColor: "white" }} b>CURRENT FILE: </text>
               <text style={{ textColor: "yellow" }} b>{middleEllipsis(renameTargetAgent.filename, Math.max(1, Math.floor(termWidth * 0.7) - 8))}</text>
            </box>
            <text style={{ textColor: "gray" }}>
              Convention: [family-]category-role_with_underscores.md
            </text>

            {/* Family Field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={renameFocusedField === "family" ? "#9B59B6" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
            >
              <text style={{ textColor: renameFocusedField === "family" ? "#9B59B6" : "gray" }} b>
                {renameFocusedField === "family" ? "► 1. Family (Optional):" : "  1. Family (Optional):"}
              </text>
              <text style={{ textColor: "white" }}>
                {renameFamily || "[ e.g. go, mistral, hybrid or leave empty ]"}
              </text>
            </box>

            {/* Category Field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={renameFocusedField === "category" ? "#9B59B6" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
            >
              <text style={{ textColor: renameFocusedField === "category" ? "#9B59B6" : "gray" }} b>
                {renameFocusedField === "category" ? "► 2. Category (Required):" : "  2. Category (Required):"}
              </text>
              <text style={{ textColor: "white" }}>
                {renameCategory || "[ e.g. pipeline, wiki, slides, docs, general ]"}
              </text>
            </box>

            {/* Role Field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={renameFocusedField === "role" ? "#9B59B6" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
            >
              <text style={{ textColor: renameFocusedField === "role" ? "#9B59B6" : "gray" }} b>
                {renameFocusedField === "role" ? "► 3. Role (Required, '_' for multi-word):" : "  3. Role (Required, '_' for multi-word):"}
              </text>
              <text style={{ textColor: "white" }}>
                {renameRole || "[ e.g. code_reviewer, orchestrator, html_writer ]"}
              </text>
            </box>

            {/* Live Preview */}
            <box flexDirection="column" marginTop={1} borderStyle="single" borderColor="#2B5581" padding={1}>
              <text style={{ textColor: "gray" }}>Live Preview Filename:</text>
              <text style={{ textColor: "green" }} b>
                {(() => {
                  const cleanRole = (renameRole || "role").trim().replace(/\s+/g, "_").replace(/-/g, "_")
                  const cleanCategory = (renameCategory || "category").trim()
                  const cleanFamily = renameFamily.trim()
                  return cleanFamily
                    ? `${cleanFamily}-${cleanCategory}-${cleanRole}.md`
                    : `${cleanCategory}-${cleanRole}.md`
                })()}
              </text>
            </box>
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1}>
            <text style={{ textColor: "gray" }}>
              [TAB/↑/↓] Switch Fields | [ENTER] Confirm Rename
            </text>
            <text style={{ textColor: "red" }} b>
              [ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {/* Modal - Model Selection */}
      {viewMode === "model-selector" || viewMode === "repair-selector" ? (
        <box
          style={{
            position: "absolute",
            left: "15%",
            top: "15%",
            width: "70%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="#00AAFF"
          backgroundColor="#1e1e1e"
           title={viewMode === "repair-selector" ? ` Repair Model Group ${Number(repairGroupKey) + 1}/${invalidModelGroups.length} ` : routingPick?.kind === "trigger" ? " Select OR Triggers " : routingPick ? " Model Configuration " : " Select LLM Model "}
          titleColor="#00AAFF"
          padding={1}
          flexDirection="column"
          overflow="hidden"
        >
          <text style={{ textColor: "white" }} paddingBottom={1} flexShrink={0}>
             {viewMode === "repair-selector"
                ? middleEllipsis(`Choose an exact replacement for explicit model ${JSON.stringify(invalidModelGroups[Number(repairGroupKey)]?.value)} (${invalidModelGroups[Number(repairGroupKey)]?.agents.length || 0} agents):`, modelModalInnerWidth)
               : routingPick?.kind === "trigger"
                 ? middleEllipsis(`When ${routingView ? callersLabel(routingView) : "callers"} run on (OR)${pendingTriggers.size > 0 ? `: [${[...pendingTriggers].join(" OR ")}]` : " — SPACE/TAB toggle multiple, ENTER confirm"}:`, modelModalInnerWidth)
                 : routingPick?.kind === "roles"
                   ? middleEllipsis(`${routingPick.roles.map(role => `${routingArchetype}-${role}`).join(", ")} use (when ${routingView ? callersLabel(routingView) : "?"} runs on ${routingDraft ? formatTriggerLabel(routingDraft.triggers) : "?"}):`, modelModalInnerWidth)
                   : `Choose model to apply to ${selectedAgentPaths.size > 0 ? selectedAgentPaths.size : 1} selected agents:`}
          </text>
          <text style={{ textColor: modelFilter ? "cyan" : "gray" }} flexShrink={0}>{middleEllipsis(modelFilter ? `Search: ${modelFilter}▏ (${modelTreeItems.filter(item => item.type === "model").length} matches)` : "Search: type to filter models", modelModalInnerWidth)}</text>
          {viewMode === "repair-selector" && invalidModelGroups[Number(repairGroupKey)] && (
            <text style={{ textColor: "gray" }}>
               Suggestions: {middleEllipsis(suggestModels(invalidModelGroups[Number(repairGroupKey)].value, modelCatalog).join(", ") || "none (choose from catalog below)", modelModalInnerWidth)}
            </text>
          )}

          <box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden">
            {visibleModels.map((item, index) => {
              const globalIndex = modelScrollOffset + index
              const isFocused = globalIndex === focusedModelIndex
              const rowBg = isFocused ? "#00AAFF" : "transparent"
              
              const textColor = isFocused
                ? "#FFFFFF"
                : item.type === "provider"
                ? "yellow"
                : "#E1E4E8"

              return (
                <box
                  key={`${item.type}-${item.id}`}
                  backgroundColor={rowBg}
                  paddingLeft={2}
                  height={1}
                  width="100%"
                >
                  <text style={{ textColor }}>
                    {middleEllipsis(isFocused && item.type === "model" ? `> ${item.label.trim()}` : item.label, modelModalInnerWidth)}
                  </text>
                </box>
              )
            })}
          </box>

          <box flexDirection="column" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} flexShrink={0}>
              <text width="100%" height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>{middleEllipsis(`Total: ${modelTreeItems.length} · Position: ${focusedModelIndex + 1}/${modelTreeItems.length}${routingPick?.kind === "trigger" && pendingTriggers.size > 0 ? ` · Selected OR: ${pendingTriggers.size}` : ""}`, modelModalInnerWidth)}</text>
              <text width="100%" height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>{middleEllipsis(routingPick?.kind === "trigger" ? "SPACE/TAB toggle OR triggers · ENTER confirm · ↑/↓ browse · ←/→ fold · type to search" : "ENTER select · ↑/↓ browse · ←/→ fold provider · type to search", modelModalInnerWidth)}</text>
              <text width="100%" height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>{middleEllipsis("BACKSPACE edit search · ESC clear search / cancel · CTRL+R reload catalog", modelModalInnerWidth)}</text>
          </box>
        </box>
      ) : null}

      {/* Modal - Color Selection */}
      {viewMode === "tier-selector" && translationConfig && (() => {
        const tiers = Object.keys(translationConfig.tiers)
        const targets = selectedAgentPaths.size > 0 ? agents.filter(a => selectedAgentPaths.has(a.currentPath)) : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
        const states = targets.map(a => resolvedAgents.get(a.currentPath)).filter((state): state is ReturnType<typeof resolveModelTarget> => Boolean(state))
        const current = new Set(states.map(s => `${s!.tier} (${s!.source})`))
        return <box style={{ position: "absolute", left: "15%", top: "5%", width: "70%", height: "90%" }} borderStyle="double" borderColor="magenta" backgroundColor="#1e1e1e" title=" Assign Tier " titleColor="magenta" padding={1} flexDirection="column" overflow="hidden">
          <text style={{ textColor: "yellow" }} flexShrink={0}>Role-based assignment: basename, not an individual file.</text>
          <text style={{ textColor: "white" }} flexShrink={0}>{middleEllipsis(`Current: ${current.size > 1 ? `multiple tiers - ${Array.from(current).join(", ")}` : Array.from(current)[0] || "unknown"}`, 70)}</text>
          <box flexGrow={1} flexDirection="column" overflow="hidden">
            {tiers.slice(tierScrollOffset, tierScrollOffset + maxVisibleTiers).map((tier, index) => {
              const tierIndex = tierScrollOffset + index
              const isFocused = tierIndex === focusedTierIndex
              const tierConfig = translationConfig.tiers[tier]
              return (
                <box key={tier} flexDirection="column" flexShrink={0}>
                  <box height={1} backgroundColor={isFocused ? "magenta" : "transparent"}>
                    <text style={{ textColor: isFocused ? "white" : "cyan" }}>
                       {middleEllipsis(`${tier} - Claude: ${tierConfig.claude.model} | Codex: ${tierConfig.codex.model}`, 70)}
                    </text>
                  </box>
                   {isFocused && tierConfig.description && <text style={{ textColor: "gray" }}>{terminalSafeText(tierConfig.description)}</text>}
                </box>
              )
            })}
          </box>
          <text style={{ textColor: "gray" }} flexShrink={0}>[UP/DOWN/j/k] Select | [ENTER] Assign | [ESC] Cancel</text>
        </box>
      })()}

      {/* Modal - Conditional IF/OR Flows of any pack (M on its folder) */}
      {(viewMode === "routing-configs" || viewMode === "routing-editor" || viewMode === "routing-callers" || viewMode === "routing-tools" || viewMode === "routing-permissions" || viewMode === "routing-delegations") && (
        <box
          style={{ position: "absolute", left: "10%", top: "8%", width: "80%", height: "84%" }}
          borderStyle="double"
          borderColor="#00AAFF"
          backgroundColor="#1e1e1e"
          title={` ${(routingArchetype || "").toUpperCase()} · Conditional Flows (IF / OR) `}
          titleColor="#00AAFF"
          padding={1}
          flexDirection="column"
          overflow="hidden"
        >
          {!routingView ? (
            <text style={{ textColor: "red" }}>{routingLoad.error || `No agents found for ${routingArchetype}.`}</text>
          ) : viewMode === "routing-callers" ? (
            <>
              <text style={{ textColor: "white" }} flexShrink={0}>
                {middleEllipsis(`Choose which agents act as callers in OR for ${routingArchetype} (saved in routing.json):`, modelModalInnerWidth)}
              </text>
              <text style={{ textColor: "gray" }} flexShrink={0}>
                {middleEllipsis(`Active source: ${routingView.callerSource} · Press R to reset to pack / inferred defaults.`, modelModalInnerWidth)}
              </text>
              <box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden">
                {routingView.callerCandidates.map((cand, index) => {
                  const focused = index === callerFocus
                  const checked = callerDraftSet.has(cand.name)
                  return (
                    <box key={`caller-${cand.name}`} height={1} backgroundColor={focused ? "#00AAFF" : "transparent"} paddingLeft={1} flexShrink={0}>
                      <text style={{ textColor: focused ? "#FFFFFF" : checked ? "green" : "#E1E4E8" }}>
                        {middleEllipsis(`${focused ? "> " : "  "}${checked ? "[x]" : "[ ]"} ${cand.name}${cand.model ? ` (${cand.model})` : ""}`, modelModalInnerWidth)}
                      </text>
                    </box>
                  )
                })}
              </box>
              {routingStatus && <text style={{ textColor: routingStatus.startsWith("Error") ? "red" : "yellow" }} flexShrink={0}>{middleEllipsis(routingStatus, modelModalInnerWidth)}</text>}
              <text style={{ textColor: "gray" }} flexShrink={0}>[↑/↓] Navigate | [SPACE] Toggle caller | [ENTER] Save callers | [R] Reset defaults | [ESC] Back</text>
            </>
          ) : viewMode === "routing-tools" && routingDraft ? (() => {
            const toolRows = [{ key: "*", label: "* (All tools fallback)", group: "builtin" as const, staticallyDeniedByCaller: false }, ...routingView.availableTools]
            const visibleCount = Math.max(2, Math.floor(termHeight * 0.72) - 8)
            const visible = toolRows.slice(flowSubScroll, flowSubScroll + visibleCount)
            return (
              <>
                <text style={{ textColor: "white" }} flexShrink={0}>
                  {middleEllipsis(`Tools & MCP overrides when ${callersLabel(routingView)} runs on ${formatTriggerLabel(routingDraft.triggers)}:`, modelModalInnerWidth)}
                </text>
                <text style={{ textColor: "gray" }} flexShrink={0}>
                  {middleEllipsis(`SPACE or ←/→ cycles: unchanged -> deny -> ask -> allow. Denied tools are removed from context & blocked.`, modelModalInnerWidth)}
                </text>
                <box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden">
                  {visible.map((row, idx) => {
                    const globalIdx = flowSubScroll + idx
                    const focused = globalIdx === flowSubFocus
                    const effect = routingDraft.tools[row.key]
                    const effectColor = focused ? "#FFFFFF" : effect === "deny" ? "red" : effect === "ask" ? "yellow" : effect === "allow" ? "green" : "gray"
                    return (
                      <box key={`ftool-${row.key}`} flexDirection="row" height={1} backgroundColor={focused ? "#00AAFF" : "transparent"} paddingLeft={1} flexShrink={0}>
                        <text style={{ textColor: focused ? "#FFFFFF" : "#E1E4E8" }} width="55%">
                          {middleEllipsis(`${focused ? "> " : "  "}${row.label}`, Math.max(12, Math.floor(modelModalInnerWidth * 0.54)))}
                        </text>
                        <text style={{ textColor: effectColor }}>
                          {middleEllipsis(`${effect ? effect.toUpperCase() : "unchanged"}${effect === "allow" && row.staticallyDeniedByCaller ? " ⚠ static deny on caller" : ""}`, Math.max(12, Math.floor(modelModalInnerWidth * 0.44)))}
                        </text>
                      </box>
                    )
                  })}
                </box>
                {routingStatus && <text style={{ textColor: routingStatus.startsWith("Error") ? "red" : "yellow" }} flexShrink={0}>{middleEllipsis(routingStatus, modelModalInnerWidth)}</text>}
                <text style={{ textColor: "gray" }} flexShrink={0}>[↑/↓] Navigate | [SPACE/←/→] Cycle allow/ask/deny | [BACKSPACE] Unchanged | [ENTER/ESC] Done</text>
              </>
            )
          })() : viewMode === "routing-permissions" && routingDraft ? (() => {
            const permRows = [
              { key: "*", label: "* (All permissions fallback)" },
              { key: "shell", label: "shell / bash (command execution)" },
              { key: "edit", label: "edit / write (file modifications)" },
              { key: "read", label: "read (file & directory reads)" },
              { key: "webfetch", label: "webfetch (HTTP requests)" },
              { key: "skill", label: "skill (load skills)" },
              { key: "external_directory", label: "external_directory (outside workspace)" },
            ]
            return (
              <>
                <text style={{ textColor: "white" }} flexShrink={0}>
                  {middleEllipsis(`Permission overrides when ${callersLabel(routingView)} runs on ${formatTriggerLabel(routingDraft.triggers)}:`, modelModalInnerWidth)}
                </text>
                <text style={{ textColor: "gray" }} flexShrink={0}>
                  {middleEllipsis(`SPACE or ←/→ cycles: unchanged -> deny -> ask -> allow.`, modelModalInnerWidth)}
                </text>
                <box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden">
                  {permRows.map((row, idx) => {
                    const focused = idx === flowSubFocus
                    const effect = routingDraft.permissions[row.key]
                    const staticDeny = routingView.staticDeniedTools.has(row.key) || routingView.staticDeniedTools.has("*")
                    const effectColor = focused ? "#FFFFFF" : effect === "deny" ? "red" : effect === "ask" ? "yellow" : effect === "allow" ? "green" : "gray"
                    return (
                      <box key={`fperm-${row.key}`} flexDirection="row" height={1} backgroundColor={focused ? "#00AAFF" : "transparent"} paddingLeft={1} flexShrink={0}>
                        <text style={{ textColor: focused ? "#FFFFFF" : "#E1E4E8" }} width="55%">
                          {middleEllipsis(`${focused ? "> " : "  "}${row.label}`, Math.max(12, Math.floor(modelModalInnerWidth * 0.54)))}
                        </text>
                        <text style={{ textColor: effectColor }}>
                          {middleEllipsis(`${effect ? effect.toUpperCase() : "unchanged"}${effect === "allow" && staticDeny ? " ⚠ static deny on caller" : ""}`, Math.max(12, Math.floor(modelModalInnerWidth * 0.44)))}
                        </text>
                      </box>
                    )
                  })}
                </box>
                {routingStatus && <text style={{ textColor: routingStatus.startsWith("Error") ? "red" : "yellow" }} flexShrink={0}>{middleEllipsis(routingStatus, modelModalInnerWidth)}</text>}
                <text style={{ textColor: "gray" }} flexShrink={0}>[↑/↓] Navigate | [SPACE/←/→] Cycle allow/ask/deny | [BACKSPACE] Unchanged | [ENTER/ESC] Done</text>
              </>
            )
          })() : viewMode === "routing-delegations" && routingDraft ? (() => {
            const delRows = [
              { name: "*", label: "* (All subagents fallback)", staticDeny: routingView.staticDeniedDelegations.has("*") },
              ...routingView.subagents.map(sub => ({ name: sub.name, label: sub.name, staticDeny: routingView.staticDeniedDelegations.has(sub.name) || routingView.staticDeniedDelegations.has("*") })),
            ]
            const visibleCount = Math.max(2, Math.floor(termHeight * 0.72) - 8)
            const visible = delRows.slice(flowSubScroll, flowSubScroll + visibleCount)
            return (
              <>
                <text style={{ textColor: "white" }} flexShrink={0}>
                  {middleEllipsis(`Subagent delegation policy when ${callersLabel(routingView)} runs on ${formatTriggerLabel(routingDraft.triggers)}:`, modelModalInnerWidth)}
                </text>
                <text style={{ textColor: "gray" }} flexShrink={0}>
                  {middleEllipsis(`SPACE or ←/→ cycles: unchanged -> deny -> allow. Denied delegations are blocked before execution.`, modelModalInnerWidth)}
                </text>
                <box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden">
                  {visible.map((row, idx) => {
                    const globalIdx = flowSubScroll + idx
                    const focused = globalIdx === flowSubFocus
                    const effect = routingDraft.delegations[row.name]
                    const effectColor = focused ? "#FFFFFF" : effect === "deny" ? "red" : effect === "allow" ? "green" : "gray"
                    return (
                      <box key={`fdel-${row.name}`} flexDirection="row" height={1} backgroundColor={focused ? "#00AAFF" : "transparent"} paddingLeft={1} flexShrink={0}>
                        <text style={{ textColor: focused ? "#FFFFFF" : "#E1E4E8" }} width="55%">
                          {middleEllipsis(`${focused ? "> " : "  "}${row.label}`, Math.max(12, Math.floor(modelModalInnerWidth * 0.54)))}
                        </text>
                        <text style={{ textColor: effectColor }}>
                          {middleEllipsis(`${effect ? effect.toUpperCase() : "unchanged"}${effect === "allow" && row.staticDeny ? " ⚠ static deny on caller" : ""}`, Math.max(12, Math.floor(modelModalInnerWidth * 0.44)))}
                        </text>
                      </box>
                    )
                  })}
                </box>
                {routingStatus && <text style={{ textColor: routingStatus.startsWith("Error") ? "red" : "yellow" }} flexShrink={0}>{middleEllipsis(routingStatus, modelModalInnerWidth)}</text>}
                <text style={{ textColor: "gray" }} flexShrink={0}>[↑/↓] Navigate | [SPACE/←/→] Cycle allow/deny | [BACKSPACE] Unchanged | [ENTER/ESC] Done</text>
              </>
            )
          })() : (
            <>
              <text style={{ textColor: "white" }} flexShrink={0}>{middleEllipsis(viewMode === "routing-configs"
                ? `Callers (OR): ${callersLabel(routingView)} [${routingView.callerSource}] · press [C] to edit callers`
                : `Configure triggers (OR), subagent models, tools/MCP [U] and delegations [G] for this flow.`, modelModalInnerWidth)}</text>
              <text style={{ textColor: "cyan" }} flexShrink={0}>{middleEllipsis(
                isReadOnlyGitSource
                  ? `Saved in user settings (routing.json) · reconciles target automatically`
                  : routingView.hasManifest
                    ? `Saved in user settings (routing.json) by default · press [W] to export defaults into opencode-pack.json`
                    : `Virtual .md pack · saved in routing.json · press [I] to generate opencode-pack.json`,
                modelModalInnerWidth,
              )}</text>
              {routingView.pinned.length > 0 && <text style={{ textColor: "gray" }} flexShrink={0}>{middleEllipsis(`Pinned subagents (fixed model, skipped by model routing): ${routingView.pinned.map(agent => `${agent.name}=${agent.model}`).join(", ")}`, modelModalInnerWidth)}</text>}
              {viewMode === "routing-editor" && routingDraft && (() => {
                const blockedAllowTools = Object.entries(routingDraft.tools).filter(([k, v]) => v === "allow" && (routingView.staticDeniedTools.has(k) || routingView.staticDeniedTools.has("*"))).map(([k]) => k)
                const blockedAllowDels = Object.entries(routingDraft.delegations).filter(([k, v]) => v === "allow" && (routingView.staticDeniedDelegations.has(k) || routingView.staticDeniedDelegations.has("*"))).map(([k]) => k)
                if (!blockedAllowTools.length && !blockedAllowDels.length) return null
                return (
                  <text style={{ textColor: "yellow" }} flexShrink={0}>
                    {middleEllipsis(`⚠ Static 'deny' on caller frontmatter overrides runtime 'allow' in OpenCode V2 (${[...blockedAllowTools, ...blockedAllowDels].join(", ")}); set caller base permission to allow/ask.`, modelModalInnerWidth)}
                  </text>
                )
              })()}
              <box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden">
                {viewMode === "routing-configs"
                  ? [...routingView.flows, null].map((flow, index) => {
                      const focused = index === routingFocus
                      return (
                        <box key={flow ? flow.key : "routing-new"} flexDirection="column" backgroundColor={focused ? "#00AAFF" : "transparent"} paddingLeft={1} flexShrink={0}>
                          <text style={{ textColor: focused ? "#FFFFFF" : flow ? "yellow" : "#7EE787" }}>
                            {middleEllipsis(
                              flow
                                ? `${focused ? "> " : "  "}IF ${flow.callers?.join(" or ") || callersLabel(routingView)} runs on ${formatTriggerLabel(flow.triggers)} [${flow.origin}]`
                                : `${focused ? "> " : "  "}+ New conditional flow (IF / OR)`,
                              modelModalInnerWidth,
                            )}
                          </text>
                          {flow && <text style={{ textColor: focused ? "#FFFFFF" : "gray" }}>{middleEllipsis(`    ${summarizeUnifiedFlow(flow, routingView.related)}`, modelModalInnerWidth)}</text>}
                        </box>
                      )
                    })
                  : routingDraft && (() => {
                      const toolsSummary = Object.entries(routingDraft.tools).map(([k, v]) => `${k}=${v}`).join(", ") || "unchanged (press U or ENTER to configure)"
                      const permSummary = Object.entries(routingDraft.permissions).map(([k, v]) => `${k}=${v}`).join(", ") || "unchanged (press P or ENTER to configure)"
                      const delSummary = Object.entries(routingDraft.delegations).map(([k, v]) => `${k}=${v}`).join(", ") || "unchanged (press G or ENTER to configure)"
                      const editorRows = [
                        { kind: "triggers" as const, role: "", label: `When ${routingView.callers.map(agent => agent.role).join("/")} runs on (OR)`, value: formatTriggerLabel(routingDraft.triggers) },
                        ...routingView.related.map(agent => ({
                          kind: "agent" as const,
                          role: agent.role,
                          label: agent.name,
                          value: routingDraft.roles[agent.role] && routingDraft.roles[agent.role] !== INHERIT ? routingDraft.roles[agent.role] : INHERIT,
                        })),
                        { kind: "tools" as const, role: "", label: "Tools & MCP policy [U]", value: toolsSummary },
                        { kind: "permissions" as const, role: "", label: "Permissions policy [P]", value: permSummary },
                        { kind: "delegations" as const, role: "", label: "Subagent delegations [G]", value: delSummary },
                      ]
                      return editorRows.map((row, index) => {
                        const focused = index === routingEditorFocus
                        const selected = row.kind === "agent" && routingSelected.has(row.role)
                        const leftText = row.kind === "agent"
                          ? `${selected ? "[x]" : "[ ]"} ${row.label}`
                          : `${focused ? "> " : "  "}${row.label}`
                        const leftColor = focused ? "#FFFFFF" : row.kind === "triggers" ? "yellow" : row.kind !== "agent" ? "magenta" : selected ? "green" : "#E1E4E8"
                        const rightColor = focused ? "#FFFFFF" : row.value === INHERIT || row.value.startsWith("unchanged") ? "gray" : "cyan"
                        return (
                          <box key={`routing-row-${index}`} flexDirection="row" backgroundColor={focused ? "#00AAFF" : "transparent"} paddingLeft={1} height={1} flexShrink={0} marginBottom={index === 0 ? 1 : 0} marginTop={row.kind === "tools" ? 1 : 0}>
                            <text style={{ textColor: leftColor }} width="42%">{middleEllipsis(leftText, Math.max(10, Math.floor(modelModalInnerWidth * 0.41)))}</text>
                            <text style={{ textColor: rightColor }}>{middleEllipsis(row.value === INHERIT ? "inherit (same model as caller)" : row.value, Math.max(10, Math.floor(modelModalInnerWidth * 0.56)))}</text>
                          </box>
                        )
                      })
                    })()}
              </box>
              {routingStatus && <text style={{ textColor: routingStatus.startsWith("Error") ? "red" : "yellow" }} flexShrink={0}>{middleEllipsis(routingStatus, modelModalInnerWidth)}</text>}
              <text style={{ textColor: "gray" }} flexShrink={0}>{middleEllipsis(
                viewMode === "routing-configs"
                  ? `[↑/↓] Select | [ENTER] Edit/New | [C] Callers (OR)${!isReadOnlyGitSource ? (routingView.hasManifest ? " | [W] Save to pack" : " | [I] Init pack") : ""} | [D] Delete | [ESC] Close`
                  : "[SPACE/A] Select | [M/ENTER] Pick | [U] Tools | [P] Perms | [G] Delegations | [TAB/←/→] Variant | [ESC] Back",
                modelModalInnerWidth,
              )}</text>
            </>
          )}
        </box>
      )}

      {/* Modal - Guided opencode-pack.json Initializer ([I] on virtual .md folder) */}
      {viewMode === "pack-init" && (
        <box
          style={{ position: "absolute", left: "15%", top: "18%", width: "70%", height: "62%" }}
          borderStyle="double"
          borderColor="#7EE787"
          backgroundColor="#1e1e1e"
          title=" Initialize OpenCode Pack (opencode-pack.json) "
          titleColor="#7EE787"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
        >
          <box flexDirection="column">
            <text style={{ textColor: "white" }}>
              {middleEllipsis(`Turn ${workspaceRoot} into a standard contract pack while keeping virtual mode compatible:`, Math.max(20, Math.floor(termWidth * 0.66)))}
            </text>
            <box flexDirection="row" marginTop={1} backgroundColor={initPackField === "name" ? "#2B5581" : "transparent"} paddingLeft={1}>
              <text style={{ textColor: "yellow" }} width="32%">Pack Name:</text>
              <text style={{ textColor: "white" }}>{`${initPackName}${initPackField === "name" ? "▏" : ""}`}</text>
            </box>
            <box flexDirection="row" marginTop={1} backgroundColor={initPackField === "version" ? "#2B5581" : "transparent"} paddingLeft={1}>
              <text style={{ textColor: "yellow" }} width="32%">Semver Version:</text>
              <text style={{ textColor: "white" }}>{`${initPackVersion}${initPackField === "version" ? "▏" : ""}`}</text>
            </box>
            <box flexDirection="row" marginTop={1} backgroundColor={initPackField === "desc" ? "#2B5581" : "transparent"} paddingLeft={1}>
              <text style={{ textColor: "yellow" }} width="32%">Description:</text>
              <text style={{ textColor: "white" }}>{middleEllipsis(`${initPackDesc}${initPackField === "desc" ? "▏" : ""}`, Math.max(16, Math.floor(termWidth * 0.42)))}</text>
            </box>
            <box flexDirection="row" marginTop={1} backgroundColor={initPackField === "organize" ? "#2B5581" : "transparent"} paddingLeft={1}>
              <text style={{ textColor: "yellow" }} width="32%">Organize Layout:</text>
              <text style={{ textColor: initPackOrganize ? "green" : "gray" }}>
                {`${initPackOrganize ? "[x]" : "[ ]"} Move loose .md agents into agents/ & normalize V2 frontmatter`}
              </text>
            </box>
          </box>
          <box borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1}>
            <text style={{ textColor: "gray" }}>[TAB/↑/↓] Next field | [SPACE] Toggle organize | [ENTER] Create opencode-pack.json | [ESC] Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Color Selection */}
      {viewMode === "color-selector" && (
        <box
          style={{
            position: "absolute",
            left: "15%",
            top: "15%",
            width: "70%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="#E84393"
          backgroundColor="#1e1e1e"
          title=" Select Agent Color "
          titleColor="#E84393"
          padding={1}
          flexDirection="column"
        >
          <text style={{ textColor: "white" }} paddingBottom={1}>
            Choose color to apply to {selectedAgentPaths.size} selected agents:
          </text>

          <box flexGrow={1} flexDirection="column" marginTop={1}>
            {visibleColors.map((item, index) => {
              const globalIndex = colorScrollOffset + index
              const isFocused = globalIndex === focusedColorIndex

              if (item.type === "group") {
                const rowBg = isFocused ? "#444444" : "transparent"
                return (
                  <box
                    key={`group-${item.id}`}
                    backgroundColor={rowBg}
                    paddingLeft={2}
                    height={1}
                    width="100%"
                  >
                    <text style={{ textColor: isFocused ? "#FFFFFF" : "yellow" }}>
                      {item.label}
                    </text>
                  </box>
                )
              }

              // Color item — show colored swatch preview
              const rowBg = isFocused ? item.hex : "transparent"
              const textCol = isFocused ? "#FFFFFF" : "#E1E4E8"

              return (
                <box
                  key={`color-${item.id}`}
                  backgroundColor={rowBg}
                  paddingLeft={2}
                  height={1}
                  width="100%"
                  flexDirection="row"
                >
                  <box width={3} height={1} backgroundColor={item.hex}>
                    <text>{" "}</text>
                  </box>
                  <text style={{ textColor: textCol }}>
                    {isFocused ? ` > ${item.label.trim()}` : `   ${item.label.trim()}`}
                  </text>
                  <text style={{ textColor: "gray" }}>
                    {`  ${item.value}`}
                  </text>
                </box>
              )
            })}
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1}>
            <text style={{ textColor: "gray" }}>
              Total: {colorTreeItems.length} | Scroll: {focusedColorIndex + 1}/{colorTreeItems.length}
            </text>
            <text style={{ textColor: "gray" }}>
              [ENTER/RETURN] Confirm | [ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {/* Modal - Bridge to Claude Code */}
      {viewMode === "bridge-prompt" && (
        <box
          style={{
             position: "absolute",
             left: "15%",
             top: "5%",
             width: "70%",
             height: "90%"
          }}
          borderStyle="double"
          borderColor={bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35"}
          backgroundColor="#1e1e1e"
          title={` Bridge to ${bridgeTarget === "codex" ? "Codex" : "Claude Code"} `}
          titleColor={bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35"}
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
        >
          <box flexDirection="column" gap={0} flexShrink={1} overflow="hidden">
            <box flexDirection="row" flexShrink={0}>
              <text style={{ textColor: "white" }} b>BRIDGE TO {bridgeTarget === "codex" ? "CODEX" : "CLAUDE CODE"} </text>
              <text style={{ textColor: bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35" }} b>
                OpenCode → {bridgeTarget === "codex" ? "Codex Translation Layer" : "Claude Code Plugin"}
              </text>
            </box>
            <text style={{ textColor: "gray" }} marginTop={1} flexShrink={0}>
              {bridgeTarget === "codex"
                ? "Generate a Codex plugin manifest and project-scoped agents with configurable Sol/Luna mapping."
                : "Convert agents to a Claude Code plugin with deterministic field mapping."}
            </text>

            {/* Plugin Name field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={bridgeFocusedField === "name" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
              flexShrink={0}
            >
              <text width={bridgeFocusedField === "name" ? undefined : "30%"} flexShrink={0} style={{ textColor: bridgeFocusedField === "name" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "gray" }} b>
                {bridgeFocusedField === "name" ? "► Plugin Name:" : "  Plugin Name:"}
              </text>
          <input width={bridgeFocusedField === "name" ? undefined : "70%"} value={bridgePluginName} placeholder="e.g. decent-pipeline" focused={bridgeFocusedField === "name"} onInput={setBridgePluginName} onSubmit={generateBridge} />
              {bridgeFocusedField === "name" && <text flexShrink={0} style={{ textColor: "gray" }}>Output plugin or translation-layer name.</text>}
            </box>

            {/* Prefix to Strip field */}
            <box
              flexDirection={bridgeFocusedField === "prefix" ? "column" : "row"}
              borderStyle="single"
              borderColor={bridgeFocusedField === "prefix" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
              flexShrink={0}
            >
              <text width="30%" flexShrink={0} style={{ textColor: bridgeFocusedField === "prefix" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "gray" }} b>
                       {bridgeFocusedField === "prefix" ? "► Prefix to Strip:" : "  Prefix to Strip:"}
              </text>
              <input width="70%" value={bridgePipelinePrefix} placeholder="empty = include all" focused={bridgeFocusedField === "prefix"} onInput={(value) => { setBridgePipelinePrefix(value); setBridgeSuggestionIndex(0); setBridgeSuggestionScrollOffset(0) }} onSubmit={generateBridge} />
              {bridgeFocusedField === "prefix" && <text flexShrink={0} style={{ textColor: "gray" }}>Includes matching agents and removes this prefix from generated names.</text>}
                {bridgeFocusedField === "prefix" && <box borderStyle="single" borderColor="#444444" width="100%" flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0} overflow="hidden">
                <text flexShrink={0} style={{ textColor: "gray" }}>Suggestions (↑/↓, TAB selects):</text>
                {filteredBridgePrefixSuggestions.slice(bridgeSuggestionScrollOffset, bridgeSuggestionScrollOffset + 5).map(({ prefix, count }, index) => {
                  const globalIndex = bridgeSuggestionScrollOffset + index
                  return (
                  <text key={prefix || "all"} flexShrink={0} style={{ textColor: globalIndex === bridgeSuggestionIndex ? "yellow" : "gray" }}>
                     {globalIndex === bridgeSuggestionIndex ? "► " : "  "}{middleEllipsis(prefix || "(empty)", 30)}  ({count} agents)
                  </text>
                  )
                })}
               </box>}
            </box>

            {/* Map all models to field */}
            <box
              flexDirection={bridgeFocusedField === "model" ? "column" : "row"}
              borderStyle="single"
              borderColor={bridgeFocusedField === "model" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
              flexShrink={0}
            >
              <text width="30%" flexShrink={0} style={{ textColor: bridgeFocusedField === "model" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "gray" }} b>
                {bridgeFocusedField === "model" ? "► Map all models to:" : "  Map all models to:"}
              </text>
              <input width="70%" value={bridgeModelTarget} placeholder="empty = tier mapping" focused={bridgeFocusedField === "model"} onInput={setBridgeModelTarget} onSubmit={generateBridge} />
              {bridgeFocusedField === "model" && <text flexShrink={0} style={{ textColor: "gray" }}>empty = tier mapping; full per-model editing lives in bridges/translation-config.json</text>}
            </box>

            {/* Info */}
            <box marginTop={1} flexDirection="column">
              <text flexShrink={0} style={{ textColor: "gray" }}>
                {`Source: pack '${activeItems[focusedIndex]?.category ?? ""}' and the packs it requires`}
              </text>
              <text flexShrink={0} style={{ textColor: "gray" }}>
                {`Output: bridges/${bridgeTarget === "codex" ? "codex" : "claude-code"}/${bridgePluginName || "..."}/`}
              </text>
            </box>
          </box>

          <box flexDirection="column" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} flexShrink={0} overflow="hidden">
            <text flexShrink={0} style={{ textColor: "gray" }}>
             Target: {bridgeTarget === "codex" ? "Codex" : "Claude Code"} | main b/B
            </text>
            <text flexShrink={0} style={{ textColor: "red" }} b>
               Field: {bridgeFocusedField} | TAB next | ENTER generate | ESC
            </text>
          </box>
        </box>
      )}

      {/* Modal - Install a pack of the workspace into OpenCode */}
      {viewMode === "install-confirm" && installPreview && (
        <box
          style={{
            position: "absolute",
            left: "12%",
            top: "15%",
            width: "76%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="#00CC66"
          backgroundColor="#1e1e1e"
          title={` Install ${installPreview.pack} `}
          titleColor="#00CC66"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column" overflow="hidden">
            <text style={{ textColor: "white" }} b>
              {`Install pack '${installPreview.pack}' and the packs it requires into ${installPreview.target.replace(os.homedir(), "~")}`}
            </text>
            {installPreview.lines.map((line, index) => (
              <text key={`install-${index}`} style={{ textColor: line.startsWith("ERROR") ? "red" : line.startsWith("warning") ? "yellow" : "#E1E4E8" }}>{line}</text>
            ))}
            {installPreview.confirmations.length > 0 && <text style={{ textColor: "yellow" }} b marginTop={1}>Confirming also accepts:</text>}
            {installPreview.confirmations.map((reason, index) => (
              <text key={`confirm-${index}`} style={{ textColor: "yellow" }}>{`  * ${terminalSafeText(reason)}`}</text>
            ))}
          </box>

          <box justifyContent="center" gap={4}>
            {installPreview.blocked
              ? <text style={{ textColor: "red" }} b>Nothing can be installed: press [ESC] to go back</text>
              : <text style={{ textColor: "green" }} b>Press [Y] or [ENTER/RETURN] to install</text>}
            {!installPreview.blocked && <text style={{ textColor: "red" }} b>Press [N] or [ESC] to cancel</text>}
          </box>
        </box>
      )}

      {/* Modal - Data Sources (GitHub & Local) */}
      {viewMode === "sources" && (() => {
        const innerWidth = Math.max(20, Math.floor(termWidth * 0.88) - 6)
        const visibleSourceRows = sourceModalRows.slice(sourcesScrollOffset, sourcesScrollOffset + maxVisibleSourceRows)
        const ghLine = !ghAuth
          ? "GitHub CLI (gh): checking status..."
          : ghAuth.authenticated
            ? `✓ GitHub CLI: authenticated on ${ghAuth.host}${ghAuth.login ? ` as ${ghAuth.login}` : ""} (${ghRepos.length} repos)`
            : ghAuth.available
              ? `⚠ GitHub CLI: ${ghAuth.message} — press [G] to log in via browser`
              : `⚠ ${ghAuth.message}`
        const ghColor = ghAuth?.authenticated ? "#2ECC71" : "yellow"
        const inputDisplay = sourcesQuery
          ? `${sourcesQuery}${sourcesInputFocused ? "█" : ""}`
          : sourcesInputFocused
            ? "█"
            : "owner/repo[#ref], https://...git, or /local/path  (press [A] or [/] to type)"

        return (
          <box
            style={{
              position: "absolute",
              left: "6%",
              top: "8%",
              width: "88%",
              height: "84%"
            }}
            borderStyle="double"
            borderColor="#9ECBFF"
            backgroundColor="#1e1e1e"
            title=" Data Sources (GitHub & Local) "
            titleColor="#9ECBFF"
            padding={1}
            flexDirection="column"
            justifyContent="space-between"
            overflow="hidden"
          >
            <box flexDirection="column" flexGrow={1} overflow="hidden">
              <text width="100%" height={1} wrapMode="none" overflow="hidden" style={{ textColor: ghColor }} b>
                {middleEllipsis(terminalSafeText(ghLine), innerWidth)}
              </text>

              <box
                width="100%"
                height={3}
                marginTop={1}
                borderStyle="single"
                borderColor={sourcesInputFocused ? "cyan" : "#444444"}
                title={sourcesInputFocused ? " Connect or Filter (typing) " : " Connect or Filter "}
                titleColor={sourcesInputFocused ? "cyan" : "gray"}
                paddingLeft={1}
                paddingRight={1}
                overflow="hidden"
              >
                <text width="100%" height={1} wrapMode="none" overflow="hidden" style={{ textColor: sourcesQuery || sourcesInputFocused ? "white" : "gray" }}>
                  {middleEllipsis(terminalSafeText(inputDisplay), Math.max(10, innerWidth - 4))}
                </text>
              </box>

              <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
                {sourceModalRows.length === 0 ? (
                  <box flexDirection="column">
                    <text style={{ textColor: "yellow" }}>
                      No registered sources or GitHub repositories listed yet.
                    </text>
                    <text style={{ textColor: "gray" }} marginTop={1}>
                      Press [G] to sign in with GitHub CLI, or press [A] and type owner/repo (e.g. lorecanc/agents) or a local folder path.
                    </text>
                  </box>
                ) : (
                  visibleSourceRows.map((row, idx) => {
                    const globalIdx = sourcesScrollOffset + idx
                    const focused = globalIdx === sourcesFocusIndex
                    const bg = focused ? "#2B5581" : "transparent"
                    let line = ""
                    let color = "#E1E4E8"
                    if (row.kind === "connect-input") {
                      line = `+ Attach "${row.spec}"`
                      color = focused ? "#FFFFFF" : "#2ECC71"
                    } else if (row.kind === "registered") {
                      const mark = row.isActive ? "★" : "●"
                      const trustTag = row.source.trusted ? "trusted" : "untrusted"
                      const loc = row.source.kind === "local"
                        ? formatDisplayPath(row.source.path)
                        : `${row.source.url.replace(/^https?:\/\/github\.com\//i, "github.com/").replace(/\.git$/i, "")}${row.source.ref ? `#${row.source.ref}` : ""} (${row.revision ? row.revision.slice(0, 7) : "not pulled"})`
                      line = `${mark} [source] ${row.source.name}  [${row.source.kind} · ${trustTag}]  ${loc}`
                      color = focused ? "#FFFFFF" : row.isActive ? "#9ECBFF" : "yellow"
                    } else {
                      const vis = row.repo.isPrivate ? "private" : "public"
                      const desc = row.repo.description ? ` · ${row.repo.description}` : ""
                      line = `  [gh]     ${row.repo.nameWithOwner}  [${vis}]${desc}`
                      color = focused ? "#FFFFFF" : "#E1E4E8"
                    }
                    return (
                      <box key={row.id} width="100%" height={1} backgroundColor={bg} paddingLeft={1} overflow="hidden" flexShrink={0}>
                        <text width="100%" height={1} wrapMode="none" overflow="hidden" style={{ textColor: color }}>
                          {middleEllipsis(terminalSafeText(line), Math.max(10, innerWidth - 2))}
                        </text>
                      </box>
                    )
                  })
                )}
              </box>
            </box>

            <box flexDirection="column" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} flexShrink={0} overflow="hidden">
              {sourcesStatus !== "" && (
                <text width="100%" height={1} wrapMode="none" overflow="hidden" style={{ textColor: "yellow" }}>
                  {middleEllipsis(terminalSafeText(sourcesStatus), innerWidth)}
                </text>
              )}
              <text width="100%" height={1} wrapMode="none" overflow="hidden" style={{ textColor: "#2ECC71" }}>
                {middleEllipsis(
                  sourcesInputFocused
                    ? "[ENTER] Attach/Open selected | [↑/↓] Choose row"
                    : "[ENTER] Open/Attach | [A /] Type repo or path | [G] gh Login",
                  innerWidth
                )}
              </text>
              <text width="100%" height={1} wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>
                {middleEllipsis(
                  sourcesInputFocused
                    ? "[CTRL+G] gh Login | [ESC] Done typing"
                    : "[P] Pull/Refresh | [T] Trust | [X] Remove | [ESC] Back",
                  innerWidth
                )}
              </text>
            </box>
          </box>
        )
      })()}

      {/* Modal - Action Result */}
      {viewMode === "action-result" && (
        <box
          style={{
            position: "absolute",
            left: "12%",
            top: "15%",
            width: "76%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="green"
          backgroundColor="#1e1e1e"
           title={` ${middleEllipsis(actionResultTitle, 50)} `}
          titleColor="green"
          padding={1}
          flexDirection="column"
          overflow="hidden"
        >
          <box flexGrow={1} flexDirection="column" overflow="hidden" flexShrink={1}>
             {visibleActionResultLines.map((line, idx) => (
                <text key={actionResultScrollOffset + idx} style={{ textColor: line.startsWith("⚠ AUTO-COMMIT:") ? "yellow" : "white" }} flexShrink={0}>{terminalSafeText(line)}</text>
            ))}
          </box>

          <box justifyContent="center" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} marginTop={1} flexShrink={0} overflow="hidden">
            <text style={{ textColor: "yellow" }} flexShrink={0}>
              {actionResultMaxOffset > 0 ? `▲ ${actionResultScrollOffset + 1}-${Math.min(actionResultLines.length, actionResultScrollOffset + maxVisibleActionResultLines)}/${actionResultLines.length} ▼  ` : ""}
            </text>
            <text style={{ textColor: "green" }} b flexShrink={0}>
              Press [ENTER/RETURN] or [ESC] to continue
            </text>
          </box>
        </box>
      )}
    </box>
  )
}
