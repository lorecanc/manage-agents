import React, { useState, useEffect, useMemo, useRef } from "react"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { isDeepStrictEqual } from "node:util"
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react"
import {
  extractFrontmatter,
  findAgentFiles,
  agentId,
  AgentInfo,
  type AgentList,
  updateAgentsModel,
  repairAgentModels,
  updateAgentsColor,
  analyzeAgentName,
  renameAgent,
  getAgentPermissionSummary,
  SAFETY_PRESETS,
  AGENT_EFFORT_VARIANTS,
  AGENT_TUNING_MODES,
  KNOWN_MODEL_VARIANTS,
  type AgentTuningMode,
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
  resolveAgentSteps,
  resolveAgentTuningMode,
  inspectTuningTargets,
  buildTuningUpdateParams,
  sanitizeFilename,
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
import {
  ASSET_TYPE_FILTERS,
  assetFilterIcon,
  buildCatalogIndex,
  buildCatalogTreeItems,
  formatBridgeBadges,
  formatPackAssetBadges,
  packCountForFilter,
  type AssetTypeFilter,
  type CatalogTreeItem,
} from "./utils/catalogIndex.js"
import { checkPackBridge } from "./utils/bridgeCheck.js"
import {
  executeCodexInstall,
  listTargetBackups,
  previewCodexInstall,
  runRestoreBackup,
  runTargetLifecycleOperation,
  type TargetBackupSummary,
  type TargetLifecycleOp,
} from "./utils/targetActions.js"
import {
  applyFixNames,
  previewFixNames,
  runWorkspaceAudit,
  runWorkspaceLint,
  runWorkspaceValidate,
  type FixNamePlanItem,
  type WorkspaceLintReport,
  type WorkspaceValidationReport,
} from "./utils/workspaceMaintenance.js"
import { changeTarget, installChange, reconcileChange, targetStatus, type TargetStatus } from "./utils/installer.js"
import { realpathThroughExistingAncestor } from "./utils/pathValidation.js"
import { effectiveOverrides, loadOverrideSettings, patchedConfigSections } from "./utils/userSettings.js"
import { parseJsonc } from "./utils/packs.js"
import { isServerDisabled } from "./utils/opencodeMcp.js"
import { addSource, deriveSourceName, engineConfigDir, findSource, isSourceSpecLike, loadSources, pullSource, removeSource, saveSources, sourceRevision, sourceRoot, validateSourceSpec, type Source } from "./utils/sources.js"
import { inspectGhAuthAsync, listGhReposAsync, runGhWebLogin, type GhAuthStatus, type GhRepoSummary } from "./utils/github.js"
import {
  describeConfiguredPackFlows,
  formatReconcileLines,
  loadSourceAgents,
  overrideAgentsModel,
  overrideRepairAgentModels,
  reconcileTargetIfInstalled,
  runWithOverrideWriter,
  saveConfigOverride,
  saveUserPackCallers,
  saveUserPackFlow,
  sourceBridgeOutputDir,
  standaloneBridgeKey,
  sourceTranslationConfigLocation,
  type FlowDraftInput,
} from "./utils/sourceCustomization.js"
import { own as ownProp, WILDCARD_TRIGGER, type DelegationEffect, type PolicyEffect } from "./utils/values.js"
import { derivePackSlug, isVirtualPackRoot } from "./utils/virtualPacks.js"
import {
  applyPackOnboarding,
  bumpPackVersion,
  cloneGitSourceForOnboarding,
  fixPackDoctor,
  inspectOnboardingCandidate,
  inspectPackDoctor,
  installPackAuthoringKit,
  resolveEditablePackDir,
  scaffoldPackResource,
  suggestCloneDestination,
  type EffectiveOnboardingLayout,
  type OnboardingInspection,
  type PackDoctorReport,
  type ScaffoldResourceKind,
  type SemverReleaseKind,
} from "./utils/packOnboarding.js"
import { bridgeConfirmationsNeeded, bridgePack, resolveBridgeWorkspaceTrust, type BridgePackOptions } from "./utils/bridgeWorkspace.js"
import {
  applyBridgeDraftToConfig,
  buildPackBridgePreview,
  CLAUDE_TIER_MODEL_PRESETS,
  cloneBridgeTiers,
  CODEX_EFFORT_PRESETS,
  collectBridgeablePacks,
  comparePackCategories,
  cycleAgentRoleTier,
  cyclePresetValue,
  deriveBridgePrefix,
  filterBridgePacks,
  initialBridgeModelCatchAll,
  reconcileBridgePackQuery,
  resolveInitialBridgePack,
  stepBridgeField,
  stepBridgePackSelection,
  validateDraftBridgeTiers,
  VIBE_TIER_MODEL_PRESETS,
  type BridgeField,
} from "./utils/bridgePrompt.js"
import { changeToast, describeChangeResult } from "./utils/changeReport.js"
import { defaultTarget, serializeLock } from "./utils/lock.js"
import {
  buildInferenceIndex,
  DEFAULT_TRANSLATION_CONFIG,
  loadTranslationConfig,
  resolveModelTarget,
  resolveRole,
  saveTranslationConfig,
  translationConfigPath,
  validateClaudeModelName,
  type TranslationConfig,
  type TranslationTier,
} from "./utils/translationConfig.js"
import { claudeNextSteps } from "./utils/claudeNextSteps.js"
import { codexNextSteps, type CodexBridgeResult } from "./utils/codexBridge.js"
import { vibeNextSteps, type VibeBridgeResult } from "./utils/vibeBridge.js"
import { installVibeAgentProfiles, installVibePlugin, type VibeAgentProfileInstallResult, type VibePluginInstallResult } from "./utils/vibePluginInstall.js"
import { registerPlugin, validatePlugin } from "./utils/claudePluginCli.js"
import { AUTO_COMMIT_MESSAGES, autoCommitEnabled, repositoryTransaction, type TransactionWarning } from "./utils/repositoryTransaction.js"
import {
  adjustListShare,
  calculateLayout,
  calculateListColumnBudget,
  calculateModalViewport,
  calculatePanelWidths,
  calculateWorkspaceViewports,
  clampListScroll,
  computeCatalogJumpState,
  resetListShare,
} from "./utils/layout.js"
import { resolveEngineVersion, type EngineVersionInfo } from "./utils/engineVersion.js"
import { applyEngineUpdate, checkForEngineUpdate, type EngineUpdateCheckResult } from "./utils/selfUpdate.js"
import { loadUiConfig, saveUiConfig } from "./utils/uiConfig.js"
import { displayWidth, middleEllipsis, terminalSafeText } from "./utils/terminalText.js"
import { buildContextualShortcuts, filterPaletteCommands, type PaletteCommand, type WorkspaceTab } from "./utils/commandPalette.js"
import { buildSourceWorkspaceRows } from "./utils/sourceRows.js"
import { MAX_PASTE_CHARS, consumePasteSequence, emptyPasteBuffer, sanitizePasteText, type PasteBuffer } from "./utils/keyboardInput.js"
import { loadRecentSourcePaths, recordRecentSourcePath, saveRecentSourcePaths, suggestLocalPaths, type RecentSourcePaths } from "./utils/recentSourcePaths.js"
import { buildPreviewUnifiedDiff, fractionalBar, gaugeBar, lerpColor, sanitizeHexColor, terminalSafeMarkdown, THEME } from "./utils/uiTheme.js"
import { isReducedMotionPreferred, useAnimatedNumber, useFlashDecay, usePulseLoop } from "./ui/animations.js"
import { CommandPaletteModal } from "./ui/CommandPaletteModal.js"
import { HelpModal } from "./ui/HelpModal.js"
import { ParameterTuningModal } from "./ui/ParameterTuningModal.js"
import { BridgeModal, bridgeTargetFolder, bridgeTargetLabel, calculateBridgeModalLayout } from "./ui/BridgeModal.js"
import { getOnboardingFieldOrder, PackOnboardingModal, type OnboardingField } from "./ui/PackOnboardingModal.js"
import { getDoctorMaxFindingRows, getScaffoldFieldOrder, PackDoctorModal, type PackDoctorTab, type ScaffoldField } from "./ui/PackDoctorModal.js"
import {
  buildHelpSections,
  calculateHelpViewport,
  clampFocusIntoHelpSlice,
  clampHelpScroll,
  cycleHelpTab,
  defaultHelpTabForWorkspace,
  helpTabByNumber,
  type HelpShortcutItem,
  type HelpTabId,
} from "./utils/helpGuide.js"
import { ToastOverlay } from "./ui/ToastOverlay.js"
import { buildFlowsInspectorItems, buildFlowsNavRows, FlowsWorkspace } from "./ui/FlowsWorkspace.js"
import { calculateTargetInstalledPackRows, SourcesTargetWorkspace, type SourceWorkspaceRow } from "./ui/SourcesTargetWorkspace.js"
import { WorkspaceTopbar } from "./ui/WorkspaceTopbar.js"
import { PackInspector, AssetItemInspector } from "./ui/AssetInspector.js"
import { buildTargetRowsForTab, TargetBridgesWorkspace, type TargetSubTab } from "./ui/TargetBridgesWorkspace.js"
import { MaintenanceModal, type MaintenanceAuditSummary, type MaintenanceTab } from "./ui/MaintenanceModal.js"
import {
  calculatePackFlowsModalLayout,
  formatTriggerLabel,
  PackFlowsModal,
  PERMISSION_POLICY_ROWS,
} from "./ui/PackFlowsModal.js"
import { getMarkdownSyntaxStyle } from "./ui/markdownStyle.js"
import { PromptMarkdownView } from "./ui/PromptMarkdownView.js"
import { layoutMarkdownDocument } from "./utils/markdownLayout.js"

interface AppProps {
  workspaceRoot?: string
  initialSource?: Source
  startupNotice?: string
  listShare?: number
  reducedMotion?: boolean
  uiConfigWarning?: string
  configReadOnly?: boolean
  uiConfigRevision?: string
  initialModelCatalog?: ModelCatalog
}

type ActiveDataSource =
  | { kind: "workspace"; root: string }
  | { kind: "source"; source: Source; root: string }

type ViewMode =
  | "main"
  | "command-palette"
  | "help"
  | "model-selector"
  | "repair-selector"
  | "repair-confirm"
  | "tier-selector"
   | "action-result"
  | "bridge-prompt"
  | "bridge-confirm"
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
  | "pack-doctor"
  | "self-update"
  | "maintenance"
  | "codex-install-confirm"

type ActiveItem = CatalogTreeItem

interface InstallPreview {
  operation: TargetLifecycleOp
  adopt?: boolean
  packs: string[]
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

/** Standalone pack roots cannot contain generated bridge or config files. */
function externalBridgeKey(ds: ActiveDataSource | null): string | null {
  if (!ds) return null
  if (ds.kind === "source" && ds.source.kind === "git") return ds.source.name
  return standaloneBridgeKey(ds.root)
}

export function App({ workspaceRoot: workspaceRootProp, initialSource, startupNotice, listShare = 2 / 3, reducedMotion: reducedMotionProp, uiConfigWarning, configReadOnly = false, uiConfigRevision = "missing", initialModelCatalog }: AppProps) {
  const renderer = useRenderer()
  const [reducedMotionState, setReducedMotionState] = useState<boolean>(() => isReducedMotionPreferred(reducedMotionProp))
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(() => (workspaceRootProp || initialSource ? "catalog" : "sources"))
  const [activePane, setActivePane] = useState<"list" | "inspector">("list")
  const initialBanner = startupNotice
    ? terminalSafeText(startupNotice)
    : uiConfigWarning
      ? `⚠ ${terminalSafeText(uiConfigWarning)}`
      : null
  const [toastMessage, setToastMessage] = useState<string | null>(() => initialBanner)
  const [toastId, setToastId] = useState<number>(() => initialBanner ? 1 : 0)
  const pushToast = (msg: string) => {
    const clean = terminalSafeText(msg).trim()
    if (!clean) return
    setToastMessage(clean)
    setToastId(id => id + 1)
  }
  const [flashTick, setFlashTick] = useState(0)
  const [flashedPaths, setFlashedPaths] = useState<Set<string>>(new Set())
  const triggerRowFlash = (paths: string[]) => {
    setFlashedPaths(new Set(paths))
    setFlashTick(t => t + 1)
  }
  const [isAsyncBusy, setIsAsyncBusy] = useState(false)
  const [targetStatusInfo, setTargetStatusInfo] = useState<TargetStatus | null>(null)
  const [flowsFocusIndex, setFlowsFocusIndex] = useState(0)
  const [flowsScrollOffset, setFlowsScrollOffset] = useState(0)
  const [flowsInspectorFocus, setFlowsInspectorFocus] = useState(0)
  const [sourcesInspectorScroll, setSourcesInspectorScroll] = useState(0)
  const [paletteQuery, setPaletteQuery] = useState("")
  const [paletteFocusIndex, setPaletteFocusIndex] = useState(0)
  const [paletteScrollOffset, setPaletteScrollOffset] = useState(0)
  const [helpTab, setHelpTab] = useState<HelpTabId>("catalog")
  const [helpFocusIndex, setHelpFocusIndex] = useState(0)
  const [helpScrollOffset, setHelpScrollOffset] = useState(0)
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
  const [agents, setAgents] = useState<AgentList>([])
  const bridgeStorageKey = useMemo(() => externalBridgeKey(activeDataSource), [activeDataSource, agents])
  const [models, setModels] = useState<string[]>(() => (initialModelCatalog?.status === "verified" ? initialModelCatalog.models : []))
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(() => initialModelCatalog ?? { status: "unavailable", models: [] })
  const [repairGroupKey, setRepairGroupKey] = useState<string | null>(null)
  const [repairMappings, setRepairMappings] = useState<Record<string, string>>({})
  const [selectedAgentPaths, setSelectedAgentPaths] = useState<Set<string>>(new Set())
  const [selectedPackNames, setSelectedPackNames] = useState<Set<string>>(new Set())

  // View Settings
  // Every folder starts closed: the TUI opens on a compact list of categories.
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState("")
  const [isSearching, setIsSearching] = useState(false)

  // Navigation State
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)

  // Modal / Action State
  const [viewMode, setViewMode] = useState<ViewMode>("main")
  const installPreviewReqIdRef = useRef(0)
  const installInFlightRef = useRef(false)
  const pendingJumpIndexRef = useRef<number | null>(null)
  useEffect(() => {
    installPreviewReqIdRef.current += 1
  }, [workspaceTab, activeDataSource, viewMode])
  useEffect(() => {
    if (workspaceTab !== "catalog" || viewMode !== "main") setIsSearching(false)
  }, [workspaceTab, viewMode])
  const [registeredSources, setRegisteredSources] = useState<Source[]>([])
  const [sourceRevisions, setSourceRevisions] = useState<Record<string, string | null>>({})
  const [activeSourceName, setActiveSourceName] = useState<string | undefined>(initialSource?.name)
  const [ghAuth, setGhAuth] = useState<GhAuthStatus | null>(null)
  const [ghRepos, setGhRepos] = useState<GhRepoSummary[]>([])
  const [sourcesQuery, setSourcesQuery] = useState("")
  const [sourcesInputFocused, setSourcesInputFocused] = useState(false)
  const [recentPaths, setRecentPaths] = useState<RecentSourcePaths>(() => {
    try {
      return loadRecentSourcePaths()
    } catch {
      return { schemaVersion: 1, items: [] }
    }
  })
  const pasteRef = useRef<PasteBuffer>(emptyPasteBuffer())
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
  const [routingScroll, setRoutingScroll] = useState(0)
  const [routingEditorFocus, setRoutingEditorFocus] = useState(0)
  const [routingEditorScroll, setRoutingEditorScroll] = useState(0)
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
  const [callerScroll, setCallerScroll] = useState(0)
  const [flowSubFocus, setFlowSubFocus] = useState(0)
  const [flowSubScroll, setFlowSubScroll] = useState(0)

  const [engineVersionInfo, setEngineVersionInfo] = useState<EngineVersionInfo | null>(() => {
    try { return resolveEngineVersion() } catch { return null }
  })
  const [selfUpdateCheck, setSelfUpdateCheck] = useState<EngineUpdateCheckResult | null>(null)
  const [selfUpdateStatus, setSelfUpdateStatus] = useState("")
  const [selfUpdateBusy, setSelfUpdateBusy] = useState(false)

  // Guided Contract 1.1 onboarding wizard ([I] key & proactive prompt on virtual sources)
  const promptedVirtualRootsRef = useRef<Set<string>>(new Set())
  const [initInspection, setInitInspection] = useState<OnboardingInspection | null>(null)
  const [initCloneDest, setInitCloneDest] = useState("")
  const [initPackName, setInitPackName] = useState("")
  const [initPackVersion, setInitPackVersion] = useState("0.1.0")
  const [initPackDesc, setInitPackDesc] = useState("")
  const [initPackLayout, setInitPackLayout] = useState<EffectiveOnboardingLayout>("root")
  const [initPackOrganize, setInitPackOrganize] = useState(true)
  const [initPackKit, setInitPackKit] = useState(true)
  const [initPackField, setInitPackField] = useState<OnboardingField>("name")

  // Pack Doctor & Resource Scaffolding ([D] / [N] on initialized local packs)
  const [doctorTab, setDoctorTab] = useState<PackDoctorTab>("doctor")
  const [doctorPackDir, setDoctorPackDir] = useState<string>("")
  const [doctorReport, setDoctorReport] = useState<PackDoctorReport | null>(null)
  const [doctorScrollOffset, setDoctorScrollOffset] = useState(0)
  const [doctorStatusMessage, setDoctorStatusMessage] = useState<string | null>(null)
  const [scaffoldField, setScaffoldField] = useState<ScaffoldField>("id")
  const [scaffoldKind, setScaffoldKind] = useState<ScaffoldResourceKind>("agent")
  const [scaffoldId, setScaffoldId] = useState("")
  const [scaffoldDesc, setScaffoldDesc] = useState("")
  const [scaffoldMode, setScaffoldMode] = useState<"primary" | "subagent" | "all">("subagent")

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
    pushToast(warning ? `⚠ ${title} (auto-commit warning)` : `✓ ${title}`)
  }
  const [actionResultScrollOffset, setActionResultScrollOffset] = useState(0)

  const [installPreview, setInstallPreview] = useState<InstallPreview | null>(null)

  // Bridge State
  const [bridgePluginName, setBridgePluginName] = useState("")
  const [bridgeSelectedPack, setBridgeSelectedPack] = useState("")
  const [bridgePackSuggested, setBridgePackSuggested] = useState("")
  const [bridgePackQuery, setBridgePackQuery] = useState("")
  const [bridgeTarget, setBridgeTarget] = useState<"claude" | "codex" | "vibe">("claude")
  const [bridgeModelTarget, setBridgeModelTarget] = useState("")
  const bridgeModelTargetDirtyRef = useRef(false)
  const [bridgeConfirmReasons, setBridgeConfirmReasons] = useState<string[]>([])
  const [bridgeFocusedField, setBridgeFocusedField] = useState<BridgeField>("name")
  const [bridgeDraftTiers, setBridgeDraftTiers] = useState<Record<string, TranslationTier>>(() => cloneBridgeTiers(DEFAULT_TRANSLATION_CONFIG.tiers))
  const [bridgeDraftRoles, setBridgeDraftRoles] = useState<Record<string, string>>(() => ({ ...DEFAULT_TRANSLATION_CONFIG.roles }))
  const [bridgeTiersDirty, setBridgeTiersDirty] = useState(false)
  const [bridgeTierIndex, setBridgeTierIndex] = useState(0)
  const [bridgeTierScrollOffset, setBridgeTierScrollOffset] = useState(0)
  const [bridgeAgentIndex, setBridgeAgentIndex] = useState(0)
  const [bridgeAgentScrollOffset, setBridgeAgentScrollOffset] = useState(0)
  const [bridgeClaudeTierTyping, setBridgeClaudeTierTyping] = useState(false)
  const loadTranslationFor = (ds: ActiveDataSource | null): TranslationConfig | null => {
    if (!ds) return null
    try {
      const key = externalBridgeKey(ds)
      if (key) {
        const loc = sourceTranslationConfigLocation(key, ds.root)
        const baseRoot = fs.existsSync(loc.configPath) ? loc.configRoot : ds.root
        return loadTranslationConfig(baseRoot, loc.readPath, { persistMigration: false })
      }
      return loadTranslationConfig(ds.root, undefined, { persistMigration: false })
    } catch {
      return null
    }
  }
  const [translationConfig, setTranslationConfig] = useState<TranslationConfig | null>(() => loadTranslationFor(activeDataSource))
  useEffect(() => {
    if (viewMode === "bridge-prompt" && !bridgeModelTargetDirtyRef.current) {
      setBridgeModelTarget(initialBridgeModelCatchAll(translationConfig, bridgeTarget))
    }
  }, [bridgeTarget, translationConfig, viewMode])

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
  const [tuningVariant, setTuningVariant] = useState("")
  const [tuningVariantTyping, setTuningVariantTyping] = useState(false)
  const [tuningDirtyFields, setTuningDirtyFields] = useState<Set<TuningField>>(new Set())
  const [tuningMode, setTuningMode] = useState<AgentTuningMode>("subagent")
  const [tuningHidden, setTuningHidden] = useState(false)
  const [tuningFocusedField, setTuningFocusedField] = useState<TuningField>("steps")
  const [tuningTargetPaths, setTuningTargetPaths] = useState<string[]>([])
  const markTuningDirty = (field: TuningField) => setTuningDirtyFields(prev => {
    if (prev.has(field)) return prev
    const next = new Set(prev)
    next.add(field)
    return next
  })

  // Inspector Tab State
  const INSPECTOR_TABS = ["overview", "prompt", "naming", "security", "delegations", "resources"] as const
  const [inspectorTab, setInspectorTab] = useState<"overview" | "prompt" | "naming" | "security" | "delegations" | "resources">("overview")
  const [overviewScrollOffset, setOverviewScrollOffset] = useState(0)
  const [promptScrollOffset, setPromptScrollOffset] = useState(0)
  const [graphScrollOffset, setGraphScrollOffset] = useState(0)
  const [catalogDelFocus, setCatalogDelFocus] = useState(0)
  const [resourceScrollIndex, setResourceScrollIndex] = useState(0)
  const [assetFilter, setAssetFilter] = useState<AssetTypeFilter>("all")
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set())
  const [catalogRefreshSeq, setCatalogRefreshSeq] = useState(0)
  const [hasLoadedWorkspace, setHasLoadedWorkspace] = useState(false)
  const [targetBackups, setTargetBackups] = useState<TargetBackupSummary[]>([])
  const [targetSubTab, setTargetSubTab] = useState<TargetSubTab>("installed")
  const [targetFocusIndex, setTargetFocusIndex] = useState(0)
  const [targetScrollOffset, setTargetScrollOffset] = useState(0)
  const [targetInspectorScroll, setTargetInspectorScroll] = useState(0)
  const [maintenanceTab, setMaintenanceTab] = useState<MaintenanceTab>("validate")
  const [maintenanceScrollOffset, setMaintenanceScrollOffset] = useState(0)
  const [maintenanceValidation, setMaintenanceValidation] = useState<WorkspaceValidationReport | null>(null)
  const [maintenanceLint, setMaintenanceLint] = useState<WorkspaceLintReport | null>(null)
  const [maintenanceFixPlan, setMaintenanceFixPlan] = useState<FixNamePlanItem[]>([])
  const [maintenanceAudit, setMaintenanceAudit] = useState<MaintenanceAuditSummary | null>(null)
  const [codexInstallPreview, setCodexInstallPreview] = useState<{
    packName: string
    lines: string[]
    confirmations: string[]
  } | null>(null)

  const allAgentFilenames = useMemo(() => agents.map(a => a.filename), [agents])
  const catalogIndex = useMemo(
    () => buildCatalogIndex(hasLoadedWorkspace && activeDataSource ? (workspaceRoot || null) : null, agents),
    [hasLoadedWorkspace, activeDataSource, workspaceRoot, agents, catalogRefreshSeq],
  )
  const claudeBridgePacks = useMemo(
    () =>
      catalogIndex.packs
        .filter(pack => pack.bridgeCompat.claude)
        .map(pack => ({ pack: pack.name, count: pack.counts.agents, assetSummary: formatPackAssetBadges(pack.counts) })),
    [catalogIndex],
  )
  const codexBridgePacks = useMemo(
    () =>
      catalogIndex.packs
        .filter(pack => pack.bridgeCompat.codex)
        .map(pack => ({ pack: pack.name, count: pack.counts.agents, assetSummary: formatPackAssetBadges(pack.counts) })),
    [catalogIndex],
  )
  const vibeBridgePacks = useMemo(
    () =>
      catalogIndex.packs
        .filter(pack => pack.bridgeCompat.vibe)
        .map(pack => ({ pack: pack.name, count: pack.counts.agents, assetSummary: formatPackAssetBadges(pack.counts) })),
    [catalogIndex],
  )
  const bridgeablePacks = bridgeTarget === "codex" ? codexBridgePacks : bridgeTarget === "vibe" ? vibeBridgePacks : claudeBridgePacks
  const filteredBridgePacks = useMemo(
    () => filterBridgePacks(bridgeablePacks, bridgePackQuery),
    [bridgeablePacks, bridgePackQuery],
  )
  const [bridgePackIndex, setBridgePackIndex] = useState(0)
  const [bridgePackScrollOffset, setBridgePackScrollOffset] = useState(0)

  const refreshTargetStatus = () => {
    try {
      const target = realpathThroughExistingAncestor(path.resolve(defaultTarget()))
      const registry = loadSources()
      setTargetStatusInfo(targetStatus(target, registry))
      setTargetBackups(listTargetBackups(target))
    } catch {
      setTargetStatusInfo(null)
      setTargetBackups([])
    }
  }

  const runTargetReconcile = () => {
    setIsAsyncBusy(true)
    void (async () => {
      try {
        const target = realpathThroughExistingAncestor(path.resolve(defaultTarget()))
        const registry = loadSources()
        const result = await changeTarget(target, "reconcile", registry, reconcileChange)
        refreshTargetStatus()
        const summary = describeChangeResult(target, result)
        pushToast(changeToast(target, result))
        if (result.status === "failed") {
          setActionResultTitle("Reconcile Failed")
          setActionResultLines(summary)
          setViewMode("action-result")
        } else if ((result.status === "applied" || result.status === "unchanged") && result.plan?.skippedMcpServers.length) {
          setActionResultTitle("Reconcile Complete")
          setActionResultLines(summary)
          setViewMode("action-result")
        }
      } catch (error: any) {
        pushToast(`✗ Reconcile failed: ${terminalSafeText(error?.message || error)}`)
      } finally {
        setIsAsyncBusy(false)
        renderer.requestRender()
      }
    })()
  }

  const toggleReducedMotion = () => {
    const next = !reducedMotionState
    setReducedMotionState(next)
    if (!configReadOnly) {
      try {
        const rev = saveUiConfig(engineConfigDir(), appliedShare, uiConfigRevisionState, { reducedMotion: next })
        setUiConfigRevision(rev)
      } catch {
        // Session toggle still takes effect even if persisting is temporarily locked.
      }
    }
    pushToast(next ? "Animations set to Reduced Motion" : "✓ Smooth 60fps animations enabled")
  }

  const refreshSourcesView = (preserveStatus = false) => {
    refreshTargetStatus()
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
      refreshSourcesView(true)
    } else {
      refreshSourcesView(Boolean(startupNotice))
    }
    if (!initialModelCatalog) {
      try {
        const catalog = loadModelCatalog(true)
        setModelCatalog(catalog)
        setModels(catalog.status === "verified" ? catalog.models : [])
      } catch (e) {
        // Ignore
      }
    }
    renderer.requestRender()
  }, [])

  const invalidModelGroups = useMemo(() => collectInvalidModelGroups(agents, modelCatalog), [agents, modelCatalog])

  // Terminal dimensions are also the source of truth for the main screen budget.
  const { width: termWidth = 80, height: termHeight = 24 } = useTerminalDimensions() || {}
  useEffect(() => {
    if (layoutStatus) pushToast(layoutStatus)
  }, [layoutStatus])
  // Floating toasts avoid vertical layout shifts, so main screen keeps full height budget.
  const layout = calculateLayout(termWidth, termHeight, false)
  const effectivePane: "list" | "inspector" = layout.showInspector ? activePane : "list"
  const animatedShare = useAnimatedNumber(appliedShare, { duration: 150, ease: "outExpo", reducedMotion: reducedMotionState })
  const focusPaneBlend = useAnimatedNumber(effectivePane === "inspector" ? 1 : 0, { duration: 140, ease: "outQuad", reducedMotion: reducedMotionState })
  const mutationFlash = useFlashDecay(flashTick, reducedMotionState)
  const pulse = usePulseLoop(isAsyncBusy || (workspaceTab === "sources" && ghAuth === null), reducedMotionState)
  // Keep the table's integer cell widths independent from percentage rounding.
  const panelWidths = calculatePanelWidths(termWidth, layout.mode, animatedShare)
  const listPanelWidth = panelWidths.list
  const listContentWidth = Math.max(0, listPanelWidth - 4)
  const footerFirstWidth = Math.floor(listContentWidth / 2)
  const footerSecondWidth = Math.max(0, listContentWidth - footerFirstWidth)
  const listColumns = calculateListColumnBudget(listContentWidth, "compact")
  const columnWidth = (index: number) => listColumns.widths[index] || 0
  const gutter = (key: string) => <text key={key} width={listColumns.gutters[0] || 0}> </text>
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
  const commitLabel = termWidth >= 124 ? fullCommitLabel : compactCommitLabel
  const wsViewports = calculateWorkspaceViewports(termHeight, { hasSourcesStatus: Boolean(sourcesStatus) })
  const maxVisibleItems = wsViewports.catalogRows
  const isRepairSuggestionsVisible = viewMode === "repair-selector" && Boolean(invalidModelGroups[Number(repairGroupKey)])
  const modelViewport = calculateModalViewport("model-selector", termWidth, termHeight, isRepairSuggestionsVisible ? 2 : 0)
  const delegationViewport = calculateModalViewport("delegation-manager", termWidth, termHeight)
  const resourceViewport = calculateModalViewport("resource-manager", termWidth, termHeight)
  const tierViewport = calculateModalViewport("tier-selector", termWidth, termHeight)
  const colorViewport = calculateModalViewport("color-selector", termWidth, termHeight)
  const actionResultViewport = calculateModalViewport("action-result", termWidth, termHeight)
  const paletteViewport = calculateModalViewport("command-palette", termWidth, termHeight)
  const selfUpdateViewport = calculateModalViewport("self-update", termWidth, termHeight)
  const maxVisibleModels = modelViewport.viewportRows
  const maxVisibleDelegations = delegationViewport.viewportRows
  const maxVisibleTiers = tierViewport.viewportRows
  const maxVisibleColors = colorViewport.viewportRows
  const maxVisibleActionResultLines = actionResultViewport.viewportRows
  const modelModalInnerWidth = modelViewport.innerWidth
  const bridgeTierNames = useMemo(() => Object.keys(bridgeDraftTiers), [bridgeDraftTiers])
  const bridgeModalLayout = calculateBridgeModalLayout(termWidth, termHeight, {
    packExpanded: bridgeFocusedField === "pack",
    tierCount: bridgeTierNames.length,
  })
  const bridgePackViewportRows = bridgeModalLayout.packViewportRows
  const bridgePreview = useMemo(
    () => (viewMode === "bridge-prompt" || viewMode === "bridge-confirm")
      ? buildPackBridgePreview(agents, translationConfig, {
          target: bridgeTarget,
          pack: bridgeSelectedPack,
          tiers: bridgeDraftTiers,
          roles: bridgeDraftRoles,
          modelCatchAll: bridgeModelTarget,
        })
      : { items: [], tierCounts: {} },
    [viewMode, agents, translationConfig, bridgeTarget, bridgeSelectedPack, bridgeDraftTiers, bridgeDraftRoles, bridgeModelTarget],
  )

  useEffect(() => {
    if (filteredBridgePacks.length === 0) {
      setBridgePackIndex(0)
      setBridgePackScrollOffset(0)
      return
    }
    setBridgePackIndex(index => {
      const clamped = Math.max(0, Math.min(filteredBridgePacks.length - 1, index))
      setBridgePackScrollOffset(offset => clampListScroll(clamped, filteredBridgePacks.length, offset, bridgePackViewportRows))
      return clamped
    })
  }, [filteredBridgePacks.length, bridgePackViewportRows])

  useEffect(() => {
    if (bridgeTierNames.length === 0) {
      setBridgeTierIndex(0)
      setBridgeTierScrollOffset(0)
      return
    }
    setBridgeTierIndex(index => {
      const clamped = Math.max(0, Math.min(bridgeTierNames.length - 1, index))
      setBridgeTierScrollOffset(offset => clampListScroll(clamped, bridgeTierNames.length, offset, bridgeModalLayout.tierViewportRows))
      return clamped
    })
  }, [bridgeTierNames.length, bridgeModalLayout.tierViewportRows])

  useEffect(() => {
    if (bridgePreview.items.length === 0) {
      setBridgeAgentIndex(0)
      setBridgeAgentScrollOffset(0)
      return
    }
    setBridgeAgentIndex(index => {
      const clamped = Math.max(0, Math.min(bridgePreview.items.length - 1, index))
      setBridgeAgentScrollOffset(offset => clampListScroll(clamped, bridgePreview.items.length, offset, bridgeModalLayout.agentViewportRows))
      return clamped
    })
  }, [bridgePreview.items.length, bridgeModalLayout.agentViewportRows])

  const runSelfUpdateCheck = () => {
    setSelfUpdateBusy(true)
    setSelfUpdateStatus("Checking latest GitHub release...")
    void (async () => {
      try {
        setEngineVersionInfo(resolveEngineVersion())
        const res = await checkForEngineUpdate(undefined, {
          onProgress: msg => {
            setSelfUpdateStatus(msg)
            renderer.requestRender()
          },
        })
        setSelfUpdateCheck(res)
        setSelfUpdateStatus("")
      } catch (err: any) {
        setSelfUpdateCheck(null)
        setSelfUpdateStatus(`Error: ${terminalSafeText(err?.message || err)}`)
      } finally {
        setSelfUpdateBusy(false)
        renderer.requestRender()
      }
    })()
  }

  const openSelfUpdateModal = () => {
    setViewMode("self-update")
    runSelfUpdateCheck()
  }

  const runSelfUpdateApply = (force = false) => {
    if (selfUpdateBusy) return
    setSelfUpdateBusy(true)
    setSelfUpdateStatus("Downloading and applying engine update...")
    void (async () => {
      try {
        const res = await applyEngineUpdate(undefined, {
          force,
          checkResult: selfUpdateCheck ?? undefined,
          onProgress: msg => {
            setSelfUpdateStatus(msg)
            renderer.requestRender()
          },
        })
        setEngineVersionInfo(res.versionInfo)
        refreshTargetStatus()
        setSelfUpdateBusy(false)
        setActionResultTitle("Engine Updated Successfully")
        setActionResultLines([
          `manage-agents updated: ${res.checkResult.currentVersion.displayVersion} -> ${res.versionInfo.displayVersion}`,
          ...(res.dependenciesInstalled ? ["Dependencies synchronized."] : []),
          ...(res.reconcileResult ? [`OpenCode target reconciled (${res.reconcileResult.status}).`] : []),
          "",
          "Restart manage-agents to load the newly installed bundle in this session.",
        ])
        setViewMode("action-result")
      } catch (err: any) {
        setSelfUpdateBusy(false)
        setSelfUpdateStatus(`Error: ${terminalSafeText(err?.message || err)}`)
        renderer.requestRender()
      }
    })()
  }

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
    setCatalogDelFocus(0)
    setOverviewScrollOffset(0)
  }, [focusedIndex])

  useEffect(() => {
    setFlowsInspectorFocus(0)
  }, [flowsFocusIndex])

  useEffect(() => {
    setResourceScrollIndex(0)
    setPromptScrollOffset(0)
    setOverviewScrollOffset(0)
  }, [focusedIndex, inspectorTab])

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
    setHasLoadedWorkspace(true)
  }

  const openSourcesModal = (preserveStatus = false) => {
    refreshSourcesView(preserveStatus)
    setSourcesInputFocused(false)
    setSourcesFocusIndex(0)
    setSourcesScrollOffset(0)
    if (!preserveStatus) setSourcesStatus("")
    setWorkspaceTab("sources")
    setViewMode("main")
  }

  const prepareOnboardingWizard = (targetRoot: string, gitSource: Source | null) => {
    const fallbackRaw = gitSource ? gitSource.name : path.basename(path.resolve(targetRoot))
    const slug = derivePackSlug(fallbackRaw)
    let inspection: OnboardingInspection | null = null
    try {
      inspection = inspectOnboardingCandidate(targetRoot, { name: slug })
    } catch {
      inspection = null
    }
    setInitInspection(inspection)
    setInitCloneDest(gitSource ? suggestCloneDestination(gitSource) : "")
    setInitPackName(inspection?.suggestedName || slug)
    setInitPackVersion("0.1.0")
    setInitPackDesc(`Agent pack ${inspection?.suggestedName || slug}`)
    setInitPackLayout(inspection?.recommendedLayout ?? "root")
    setInitPackOrganize(true)
    setInitPackKit(true)
    setInitPackField(gitSource ? "cloneDest" : "name")
    setViewMode("pack-init")
  }

  const switchToDataSource = (next: ActiveDataSource, beforeActivate?: () => void) => {
    const loadedAgents = next.kind === "source" && next.source.kind === "git"
      ? loadSourceAgents(next.root)
      : findAgentFiles(next.root)
    const loadedConfig = loadTranslationFor(next)
    beforeActivate?.()
    setActiveDataSource(next)
    setActiveRevision(next.kind === "source" ? sourceRevision(next.source) : null)
    if (next.kind === "source") setActiveSourceName(next.source.name)
    setAgents(loadedAgents)
    setHasLoadedWorkspace(true)
    setTranslationConfig(loadedConfig)
    setSelectedAgentPaths(new Set())
    setSelectedPackNames(new Set())
    setExpandedCategories(new Set())
    setFocusedIndex(0)
    setScrollOffset(0)
    setFlowsFocusIndex(0)
    setFlowsScrollOffset(0)
    setSearchQuery("")
    setIsSearching(false)
    setLayoutStatus("")
    setWorkspaceTab("catalog")
    setActivePane("list")
    refreshTargetStatus()
    const isNextVirtual = Boolean(next.root && isVirtualPackRoot(next.root))
    if (isNextVirtual && !promptedVirtualRootsRef.current.has(next.root)) {
      promptedVirtualRootsRef.current.add(next.root)
      prepareOnboardingWizard(next.root, next.kind === "source" && next.source.kind === "git" ? next.source : null)
    } else {
      setViewMode("main")
    }
    pushToast(`✓ Activated ${next.kind === "source" ? next.source.name : path.basename(next.root)} (${loadedAgents.length} agents)`)
  }

  const activateRegisteredSource = (source: Source) => {
    try {
      if (source.kind === "git" && !fs.existsSync(path.join(sourceRoot(source), ".git"))) {
        setSourcesStatus(`Pulling ${source.name}...`)
        pullSource(source)
      }
      const registry = loadSources()
      registry.active = source.name
      switchToDataSource({ kind: "source", source, root: sourceRoot(source) }, () => saveSources(registry))
    } catch (error: any) {
      setSourcesStatus(`Could not open ${source.name}: ${terminalSafeText(error?.message || error)}`)
    }
  }

  const rememberSourcePath = (source: Source, rawSpec: string) => {
    try {
      recordRecentSourcePath(source, rawSpec)
      const next = loadRecentSourcePaths()
      saveRecentSourcePaths(next)
      setRecentPaths(next)
    } catch {
      // Il registro dei percorsi recenti è best-effort: non blocca l'attivazione.
    }
  }

  const attachNewSourceSpec = (spec: string) => {
    const trimmed = spec.trim()
    if (!trimmed) return
    try {
      const registry = loadSources()
      const spec = validateSourceSpec(trimmed)
      if ("error" in spec) throw new Error(spec.error)
      const existing = registry.sources.find(candidate =>
        candidate.kind === "local" ? spec.kind === "local" && candidate.path === spec.path :
          spec.kind === "git" && candidate.ref === spec.ref && candidate.url.replace(/\.git$/, "") === spec.spec.replace(/\.git$/, "")
      )
      const source = existing ?? addSource(registry, deriveSourceName(trimmed, registry), trimmed)
      registry.active = source.name
      if (source.kind === "git" && (!existing || !sourceRevision(source))) {
        pullSource(source)
      }
      switchToDataSource({ kind: "source", source, root: sourceRoot(source) }, () => saveSources(registry))
      if (source.kind === "local") rememberSourcePath(source, trimmed)
      setSourcesQuery("")
      setSourcesInputFocused(false)
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
      triggerRowFlash(paths)
      refreshTargetStatus()
      setMutationSuccess(title, lines, tx.warning)
      setViewMode("action-result")
      return
    }
    setIsAsyncBusy(true)
    void (async () => {
      let overrideSaved = false
      try {
        runWithOverrideWriter(workspaceRoot, writer => fn(writer))
        overrideSaved = true
        refreshData()
        setSelectedAgentPaths(new Set())
        triggerRowFlash(paths)
        const outcome = await reconcileTargetIfInstalled("override")
        refreshTargetStatus()
        setActionResultTitle(title)
        setActionResultLines([...lines, "", ...formatReconcileLines(outcome)])
        pushToast(`✓ ${title}`)
      } catch (error: any) {
        try { refreshData() } catch {}
        if (overrideSaved) {
          setActionResultTitle(`${title} (Reconcile Failed)`)
          setActionResultLines([...lines, "", `⚠ Saved in overrides.json, but target reconcile failed:`, `  ${error?.message || error}`])
          pushToast(`⚠ Saved override; reconcile failed`)
        } else {
          setActionResultTitle(`Error: ${title}`)
          setActionResultLines([`An error occurred:`, `  ${error?.message || error}`])
          pushToast(`✗ ${title} failed`)
        }
      } finally {
        setIsAsyncBusy(false)
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

  // Resolve all requested packs through the same source.
  const installRequests = (packs: readonly string[]) => {
    const registry = loadSources()
    if (activeDataSource?.kind === "source") {
      const source = findSource(registry, activeDataSource.source.name)
      return { registry, added: false, requests: packs.map(pack => `${source.name}/${pack}`), sourceName: source.name }
    }
    const root = fs.realpathSync(workspaceRoot)
    let source = registry.sources.find(candidate => candidate.kind === "local" && candidate.path === root)
    const added = !source
    if (!source) {
      source = addSource(registry, deriveSourceName(root, registry), root)
    }
    return { registry, added, requests: packs.map(pack => `${source.name}/${pack}`), sourceName: source.name }
  }

  const previewInstall = (packs: string[]) => {
    if (packs.length === 0) return
    const missing = packs.find(pack => !packDir(workspaceRoot, pack))
    if (missing) {
      setLayoutStatus(`${missing} is not a pack of this workspace.`)
      return
    }
    const reqId = ++installPreviewReqIdRef.current
    const target = realpathThroughExistingAncestor(path.resolve(defaultTarget()))
    void (async () => {
      try {
        const { registry, added, requests, sourceName } = installRequests(packs)
        const result = await changeTarget(target, "install", registry, installChange(registry, requests), { dryRun: true })
        if (installPreviewReqIdRef.current !== reqId) return
        setInstallPreview({
          operation: "install",
          packs, target,
          lines: [...(added ? [`This workspace will be registered as source "${sourceName}".`, ""] : []), ...describeChangeResult(target, result)],
          confirmations: result.confirmations,
          blocked: result.status === "failed",
          lockText: result.change ? serializeLock(result.change.lock) : "",
        })
        setViewMode("install-confirm")
      } catch (error: any) {
        if (installPreviewReqIdRef.current !== reqId) return
        setActionResultTitle("Install Preview Failed")
        setActionResultLines([`An error occurred:`, `  ${terminalSafeText(error?.message || error)}`])
        setViewMode("action-result")
      }
    })()
  }

  const previewTargetOp = (operation: TargetLifecycleOp, packs: string[], adopt = false) => {
    if (operation === "install") {
      previewInstall(packs)
      return
    }
    const reqId = ++installPreviewReqIdRef.current
    const target = realpathThroughExistingAncestor(path.resolve(defaultTarget()))
    void (async () => {
      try {
        const registry = loadSources()
        const result = await runTargetLifecycleOperation(target, operation, registry, packs, {
          dryRun: true,
          adopt,
        })
        if (installPreviewReqIdRef.current !== reqId) return
        setInstallPreview({
          operation,
          adopt,
          packs,
          target,
          lines: describeChangeResult(target, result),
          confirmations: result.confirmations,
          blocked: result.status === "failed",
          lockText: result.change ? serializeLock(result.change.lock) : "",
        })
        setViewMode("install-confirm")
      } catch (error: any) {
        if (installPreviewReqIdRef.current !== reqId) return
        setActionResultTitle(`${operation.toUpperCase()} Preview Failed`)
        setActionResultLines([`An error occurred:`, `  ${terminalSafeText(error?.message || error)}`])
        setViewMode("action-result")
      }
    })()
  }

  const applyInstall = (preview: InstallPreview) => {
    if (installInFlightRef.current) return
    installInFlightRef.current = true
    const op = preview.operation
    const opTitle = op[0].toUpperCase() + op.slice(1)
    const packLabel = preview.packs.length === 1
      ? preview.packs[0]
      : preview.packs.length > 1
        ? `${preview.packs.length} packs`
        : "target"
    const fail = (error: any) => {
      setActionResultTitle(`${opTitle} Failed`)
      setActionResultLines([`An error occurred:`, `  ${terminalSafeText(error?.message || error)}`])
      pushToast(`✗ ${opTitle} failed for ${packLabel}`)
    }
    setIsAsyncBusy(true)
    void (async () => {
      if (op !== "install") {
        try {
          const registry = loadSources()
          const result = await runTargetLifecycleOperation(preview.target, op, registry, preview.packs, {
            dryRun: false,
            adopt: preview.adopt,
            expectedLockText: preview.lockText,
            confirm: async reasons => isDeepStrictEqual([...reasons].sort(), [...preview.confirmations].sort()),
          })
          const succeeded = result.status === "applied" || result.status === "unchanged"
          refreshTargetStatus()
          refreshSourcesView(true)
          setActionResultTitle(succeeded ? `${opTitle} Complete` : `${opTitle} Failed`)
          setActionResultLines(describeChangeResult(preview.target, result))
          pushToast(succeeded ? `✓ ${opTitle} complete (${packLabel})` : `✗ ${opTitle} failed (${packLabel})`)
        } catch (error) {
          fail(error)
        } finally {
          setIsAsyncBusy(false)
          installInFlightRef.current = false
          setViewMode("action-result")
          renderer.requestRender()
        }
        return
      }
      let prepared: ReturnType<typeof installRequests>
      try {
        prepared = installRequests(preview.packs)
      } catch (error) {
        fail(error)
        setIsAsyncBusy(false)
        installInFlightRef.current = false
        setViewMode("action-result")
        return
      }
      const { registry, added, requests, sourceName } = prepared
      let succeeded = false
      try {
        // Saved first, so an applied lock never names a source the registry lacks; dropped again if nothing was installed.
        if (added) saveSources(registry)
        // The user approved the preview: install it only if the packs and the confirmations are still the same.
        const compute = installChange(registry, requests)
        const result = await changeTarget(preview.target, "install", registry, current => {
          const change = compute(current)
          return change.problems.length || serializeLock(change.lock) === preview.lockText
            ? change
            : { ...change, problems: ["the packs changed since the preview; press e again to review the new version"] }
        }, { confirm: async reasons => isDeepStrictEqual([...reasons].sort(), [...preview.confirmations].sort()) })
        succeeded = result.status === "applied" || result.status === "unchanged"
        refreshTargetStatus()
        refreshSourcesView(true)
        setActionResultTitle(succeeded ? "Install Complete" : "Install Failed")
        setActionResultLines(describeChangeResult(preview.target, result))
        if (succeeded) {
          setSelectedPackNames(prev => new Set([...prev].filter(pack => !preview.packs.includes(pack))))
        }
        pushToast(succeeded ? `✓ Installed ${packLabel}` : `✗ Install failed for ${packLabel}`)
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
      setIsAsyncBusy(false)
      installInFlightRef.current = false
      setViewMode("action-result")
    })()
  }

  const runTargetRestoreAction = (backupId: string) => {
    setIsAsyncBusy(true)
    void (async () => {
      try {
        const target = realpathThroughExistingAncestor(path.resolve(defaultTarget()))
        const restored = await runRestoreBackup(target, backupId)
        refreshTargetStatus()
        setActionResultTitle(`Backup Restored (${terminalSafeText(backupId)})`)
        setActionResultLines([
          `Restored ${restored.files.length} file(s) and ${restored.config.length} config entry/entries.`,
          ...restored.files.slice(0, 12).map(f => `  • ${terminalSafeText(f)}`),
        ])
        setViewMode("action-result")
        pushToast(`✓ Restored backup ${backupId}`)
      } catch (error: any) {
        setActionResultTitle("Restore Failed")
        setActionResultLines([terminalSafeText(error?.message || error)])
        setViewMode("action-result")
        pushToast(`✗ Restore failed`)
      } finally {
        setIsAsyncBusy(false)
        renderer.requestRender()
      }
    })()
  }

  const runBridgeCheckAction = (packName: string) => {
    if (!workspaceRoot || !packName) {
      pushToast("⚠ Focus a pack first to run bridge check")
      return
    }
    const pack = catalogIndex.byName.get(packName)
    const config = translationConfig ?? DEFAULT_TRANSLATION_CONFIG
    const lines: string[] = [
      `Pack: ${terminalSafeText(packName)}  ${pack ? formatPackAssetBadges(pack.counts) : ""}`,
      `OpenCode v2: ✓ Ready`,
      `Claude Code: ${pack?.bridgeCompat.claude ? "✓" : "–"} ${pack?.bridgeCompat.claudeReason ?? ""}`,
      `OpenAI Codex: ${pack?.bridgeCompat.codex ? "✓" : "–"} ${pack?.bridgeCompat.codexReason ?? ""}`,
      `Mistral Vibe: ${pack?.bridgeCompat.vibe ? "✓" : "–"} ${pack?.bridgeCompat.vibeReason ?? ""}`,
      "",
    ]

    const targets: Array<"claude" | "codex" | "vibe"> = []
    if (pack?.bridgeCompat.claude) targets.push("claude")
    if (pack?.bridgeCompat.codex) targets.push("codex")
    if (pack?.bridgeCompat.vibe) targets.push("vibe")

    if (targets.length === 0) {
      lines.push("No Claude, Codex or Vibe bridgeable assets in this pack (OpenCode v2 only).")
    } else {
      for (const target of targets) {
        const label = target === "claude" ? "Claude Code" : target === "codex" ? "OpenAI Codex" : "Mistral Vibe"
        const bridgeKey = activeDataSource?.kind === "source"
          ? activeDataSource.source.name
          : standaloneBridgeKey(workspaceRoot)
        const committedDir = sourceBridgeOutputDir(bridgeKey, target, config.pluginName || packName)
        try {
          const diff = checkPackBridge({
            workspaceRoot,
            pack: packName,
            target,
            config,
            committedDir,
          })
          if (diff.clean) {
            lines.push(`✓ ${label}: Clean (matches existing bridge output)`)
          } else {
            lines.push(`⚠ ${label}: ${diff.missing.length} new, ${diff.changed.length} changed, ${diff.extra.length} extra file(s)`)
            for (const f of diff.missing.slice(0, 5)) lines.push(`    + ${terminalSafeText(f)}`)
            for (const f of diff.changed.slice(0, 5)) lines.push(`    ~ ${terminalSafeText(f)}`)
            for (const f of diff.extra.slice(0, 5)) lines.push(`    - ${terminalSafeText(f)}`)
          }
        } catch (err: any) {
          lines.push(`✗ ${label}: ${terminalSafeText(err?.message || err)}`)
        }
      }
    }

    setActionResultTitle(`Bridge Check · ${terminalSafeText(packName)}`)
    setActionResultLines(lines)
    setViewMode("action-result")
  }

  const openCodexInstallPreviewAction = (packName: string) => {
    if (!packName) {
      pushToast("⚠ Focus a pack first to install into Codex")
      return
    }
    setIsAsyncBusy(true)
    void (async () => {
      try {
        const preview = await previewCodexInstall([packName], {
          source: activeDataSource?.kind === "source" ? activeDataSource.source.name : undefined,
          workspace: activeDataSource?.kind === "workspace" ? workspaceRoot : undefined,
        })
        const lines: string[] = [
          `Codex Install Preview: ${terminalSafeText(packName)}`,
          `Target profile: ${terminalSafeText(preview.profile)}`,
          "",
          ...(preview.packs.length > 0
            ? preview.packs.map(p => `  • ${terminalSafeText(p.pack)}  (${p.roles} role(s), ${p.skills} skill(s)${p.plugin ? `, plugin ${terminalSafeText(p.plugin)}` : ""})`)
            : [`  • ${terminalSafeText(packName)} (skills/MCP bundle)`]),
        ]
        if (preview.confirmations.length > 0) {
          lines.push("", "Confirmations required:")
          for (const reason of preview.confirmations) {
            lines.push(`  ⚠ ${terminalSafeText(reason)}`)
          }
        }
        setCodexInstallPreview({ packName, lines, confirmations: preview.confirmations })
        setViewMode("codex-install-confirm")
      } catch (error: any) {
        setActionResultTitle("Codex Install Preview Failed")
        setActionResultLines([terminalSafeText(error?.message || error)])
        setViewMode("action-result")
      } finally {
        setIsAsyncBusy(false)
        renderer.requestRender()
      }
    })()
  }

  const applyCodexInstallAction = () => {
    if (!codexInstallPreview) return
    const { packName, confirmations } = codexInstallPreview
    setIsAsyncBusy(true)
    void (async () => {
      try {
        await executeCodexInstall([packName], {
          source: activeDataSource?.kind === "source" ? activeDataSource.source.name : undefined,
          workspace: activeDataSource?.kind === "workspace" ? workspaceRoot : undefined,
          expectedConfirmations: confirmations,
        })
        setCodexInstallPreview(null)
        setActionResultTitle(`Codex Install Complete`)
        setActionResultLines([`✓ Installed ${terminalSafeText(packName)} into Codex.`])
        setViewMode("action-result")
        pushToast(`✓ Installed ${packName} into Codex`)
      } catch (error: any) {
        setCodexInstallPreview(null)
        setActionResultTitle("Codex Install Failed")
        setActionResultLines([terminalSafeText(error?.message || error)])
        setViewMode("action-result")
        pushToast(`✗ Codex install failed`)
      } finally {
        setIsAsyncBusy(false)
        renderer.requestRender()
      }
    })()
  }

  const refreshMaintenanceReports = () => {
    if (!workspaceRoot) return
    try {
      setMaintenanceValidation(runWorkspaceValidate(workspaceRoot))
    } catch {
      setMaintenanceValidation(null)
    }
    const lint = runWorkspaceLint(agents)
    setMaintenanceLint(lint)
    setMaintenanceFixPlan(previewFixNames(agents))
    setMaintenanceAudit(runWorkspaceAudit(agents))
  }

  const openMaintenanceModal = (tab: MaintenanceTab = "validate") => {
    refreshMaintenanceReports()
    setMaintenanceTab(tab)
    setMaintenanceScrollOffset(0)
    setViewMode("maintenance")
  }

  const applyMaintenanceFixNames = () => {
    if (isReadOnlyGitSource || !workspaceRoot || maintenanceFixPlan.length === 0) return
    try {
      const result = applyFixNames(workspaceRoot, agents, maintenanceFixPlan)
      refreshData()
      setCatalogRefreshSeq(seq => seq + 1)
      refreshMaintenanceReports()
      pushToast(`✓ Renamed ${result.renamedCount} agent(s), updated ${result.updatedReferences} ref(s)`)
    } catch (error: any) {
      refreshData()
      setCatalogRefreshSeq(seq => seq + 1)
      pushToast(`✗ Fix-names failed: ${terminalSafeText(error?.message || error)}`)
    }
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

  const updateBridgeTierModel = (tierName: string, model: string) => {
    setBridgeDraftTiers(prev => {
      const existing = prev[tierName]
      if (!existing) return prev
      return {
        ...prev,
        [tierName]: {
          ...existing,
          [bridgeTarget]: {
            ...existing[bridgeTarget],
            model,
          },
        },
      }
    })
    setBridgeTiersDirty(true)
  }

  const updateBridgeTierEffort = (tierName: string, effort: string) => {
    setBridgeDraftTiers(prev => {
      const existing = prev[tierName]
      if (!existing) return prev
      return {
        ...prev,
        [tierName]: {
          ...existing,
          codex: {
            ...existing.codex,
            reasoningEffort: effort,
          },
        },
      }
    })
    setBridgeTiersDirty(true)
  }

  const cycleBridgeAgentTierAt = (index: number, delta: 1 | -1) => {
    const item = bridgePreview.items[index]
    if (!item || bridgeTierNames.length === 0) return
    const next = cycleAgentRoleTier(bridgeDraftRoles, item.role, bridgeTierNames, item.tier, delta)
    setBridgeDraftRoles(next.roles)
    setBridgeTiersDirty(true)
  }

  const saveBridgeTiersOnly = () => {
    if (!activeDataSource) return
    try {
      validateDraftBridgeTiers(bridgeDraftTiers, bridgeTarget)
      const baseCfg = loadTranslationFor(activeDataSource) ?? loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false })
      const nextConfig = applyBridgeDraftToConfig(baseCfg, {
        target: bridgeTarget,
        tiers: bridgeDraftTiers,
        roles: bridgeDraftRoles,
      })
      let txWarning: TransactionWarning | undefined
      if (bridgeStorageKey) {
        const loc = sourceTranslationConfigLocation(bridgeStorageKey, workspaceRoot)
        saveTranslationConfig(loc.configRoot, nextConfig, loc.configPath)
      } else {
        const tx = mutate([translationConfigPath(workspaceRoot)], "config", () => saveTranslationConfig(workspaceRoot, nextConfig))
        txWarning = tx.warning
      }
      const reloaded = loadTranslationFor(activeDataSource)
      setTranslationConfig(reloaded)
      if (reloaded) {
        setBridgeDraftTiers(cloneBridgeTiers(reloaded.tiers))
        setBridgeDraftRoles({ ...reloaded.roles })
      }
      setBridgeTiersDirty(false)
      setBridgeClaudeTierTyping(false)
      pushToast(txWarning ? "⚠ Tiers saved (auto-commit warning)" : "✓ Saved bridge tier configuration")
    } catch (error: any) {
      pushToast(`✗ ${terminalSafeText(error?.message || error)}`)
    }
  }

  const generateBridge = (confirmedUntrusted = false) => {
    if (!activeDataSource) return
    const trimmedName = bridgePluginName.trim()
    if (!trimmedName) {
      setBridgeFocusedField("name")
      pushToast("⚠ Insert a plugin name first")
      return
    }
    const pack = bridgeSelectedPack.trim()
    if (!pack || !packDir(workspaceRoot, pack)) {
      setBridgeFocusedField("pack")
      pushToast("⚠ Select a valid pack to bridge")
      return
    }
    try {
      validateDraftBridgeTiers(bridgeDraftTiers, bridgeTarget)
    } catch (error: any) {
      setBridgeFocusedField("tiers")
      pushToast(`✗ ${terminalSafeText(error?.message || error)}`)
      return
    }
    const modelTarget = bridgeModelTarget.trim()
    if (modelTarget && bridgeTarget === "claude") {
      try {
        validateClaudeModelName(modelTarget)
      } catch (error: any) {
        setBridgeFocusedField("model")
        pushToast(`✗ ${terminalSafeText(error?.message || error)}`)
        return
      }
    }
    try {
      const trusted = activeDataSource.kind === "source"
        ? activeDataSource.source.trusted
        : resolveBridgeWorkspaceTrust(workspaceRoot).trusted
      const reasons = bridgeConfirmationsNeeded(
        workspaceRoot,
        pack,
        trusted,
        activeDataSource.kind === "source" ? activeDataSource.source.name : undefined,
        process.env, bridgeTarget,
      )
      if (reasons.length > 0 && !confirmedUntrusted) {
        setBridgeConfirmReasons(reasons)
        setViewMode("bridge-confirm")
        return
      }
      setBridgeConfirmReasons([])
      const bridgeConfig = loadTranslationFor(activeDataSource) ?? loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false })
      const safePluginName = sanitizeFilename(trimmedName)
      const prefix = deriveBridgePrefix(pack)
      const config = applyBridgeDraftToConfig(bridgeConfig, {
        target: bridgeTarget,
        tiers: bridgeDraftTiers,
        roles: bridgeDraftRoles,
        pack,
        pluginName: trimmedName,
        modelCatchAll: bridgeModelTarget,
      })
      const bridgeOptions: Omit<BridgePackOptions, "outputDir"> = { workspaceRoot, pack, target: bridgeTarget, config, pluginName: trimmedName, prefix, trusted, allowUntrustedExecutable: true }
      let result: ReturnType<typeof bridgePack>
      let txWarning: TransactionWarning | undefined
      if (bridgeStorageKey) {
        const loc = sourceTranslationConfigLocation(bridgeStorageKey, workspaceRoot)
        const outputDir = sourceBridgeOutputDir(bridgeStorageKey, bridgeTarget, safePluginName)
        saveTranslationConfig(loc.configRoot, config, loc.configPath)
        result = bridgePack({ ...bridgeOptions, outputDir })
      } else {
        const outputDir = path.join(workspaceRoot, "bridges", bridgeTargetFolder(bridgeTarget), safePluginName)
        const tx = mutate([translationConfigPath(workspaceRoot), outputDir], "bridge", () => {
          saveTranslationConfig(workspaceRoot, config)
          return bridgePack({ ...bridgeOptions, outputDir })
        })
        result = tx.value
        txWarning = tx.warning
      }
      setBridgeTiersDirty(false)
      setBridgeClaudeTierTyping(false)
      setTranslationConfig(loadTranslationFor(activeDataSource))
       setSelectedAgentPaths(new Set())
      setActionResultTitle(`Bridge to ${bridgeTargetLabel(bridgeTarget)} Complete`)
      const layerLabel = bridgeTarget === "claude" ? "Plugin" : bridgeTarget === "vibe" ? "Vibe plugin" : "Translation layer"
      const lines = [`${layerLabel} '${safePluginName}' generated successfully!`, `Output directory:`, `  ${result.pluginDir}`, ``, `Generated ${result.files.length} files:`, ...result.files.map((f) => `  * ${f}`)]
      if (result.warnings.length > 0) lines.push(``, `⚠ Warnings:`, ...result.warnings.map((w) => `  * ${w}`))
      if (result.preview?.length) {
        const counts = result.preview.reduce<Record<string, number>>((acc, item) => { acc[item.source] = (acc[item.source] || 0) + 1; return acc }, {})
        lines.push(``, `Preview summary: ${Object.entries(counts).map(([source, count]) => `${count} by ${source}`).join(", ")}`, ...result.preview.map(item => `  ${item.agent} → ${item.role} → ${item.tier} → ${item.model} → ${item.source}`))
      }
      let vibeInstall: VibePluginInstallResult | null = null
      let vibeInstallError: string | null = null
      let vibeProfilesInstall: VibeAgentProfileInstallResult | null = null
      let vibeProfilesError: string | null = null
      if (bridgeTarget === "vibe" && "plugin" in result) {
        if (bridgeConfig.vibe.autoInstall !== false) {
          try {
            vibeInstall = installVibePlugin(result.pluginDir, result.plugin.pluginName)
          } catch (error: any) {
            vibeInstallError = error?.message || String(error)
          }
        }
        if (bridgeConfig.vibe.installAgentProfiles !== false) {
          try {
            vibeProfilesInstall = installVibeAgentProfiles(result.pluginDir, result.plugin.pluginName)
          } catch (error: any) {
            vibeProfilesError = error?.message || String(error)
          }
        }
      }
      lines.push("", ...("plugin" in result
        ? bridgeTarget === "vibe"
          ? [
              ...(vibeInstall ? [`Installed in:`, `  ${vibeInstall.path}${vibeInstall.changed ? "" : " (already up to date)"}`, ...(vibeInstall.warnings.length ? [``, `⚠ Pruned stale entries:`, ...vibeInstall.warnings.map(w => `  * ${w}`)] : [])] : []),
              ...(vibeInstallError ? [`⚠ Install into the Vibe plugins root failed:`, `  ${vibeInstallError}`, ``, `Copy the plugin manually to ~/.vibe/plugins/ to use it.`] : []),
              ...(vibeProfilesInstall && vibeProfilesInstall.installed.length > 0 ? [``, `Main agent profiles installed in:`, `  ${vibeProfilesInstall.path}${vibeProfilesInstall.changed ? "" : " (already up to date)"}`, ...vibeProfilesInstall.installed.map(name => `  * ${name}`), ...(vibeProfilesInstall.warnings.length ? [``, `⚠ Profile install notes:`, ...vibeProfilesInstall.warnings.map(w => `  * ${w}`)] : [])] : []),
              ...(vibeProfilesError ? [`⚠ Main agent profile install failed:`, `  ${vibeProfilesError}`, ``, `Copy agent-profiles/*.toml manually to ~/.vibe/agents/ to use them.`] : []),
              `${vibeInstall ? "Start a session and use the plugin:" : "Install the generated plugin in Vibe:"}`,
              ...vibeNextSteps(result as VibeBridgeResult, vibeInstall, vibeProfilesInstall)
            ]
          : ["Open the generated project in Codex:", ...codexNextSteps(result as CodexBridgeResult)]
        : ["Validate and run locally:", ...claudeNextSteps(result.pluginName, result.orchestratorName, result.pluginDir)]))
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
       setMutationSuccess(`Bridge to ${bridgeTarget === "codex" ? "Codex" : bridgeTarget === "vibe" ? "Vibe" : "Claude Code"} Complete`, lines, txWarning)
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

  const catalogPacks = useMemo(
    () => catalogIndex.packs.map(pack => pack.name),
    [catalogIndex],
  )
  const selectedPacks = catalogPacks.filter(pack => selectedPackNames.has(pack))
  const hasEditablePacks = catalogPacks.length > 0 || Boolean(agents.packNames?.length)

  const targetInstalledCount = Object.keys(targetStatusInfo?.lock?.packs ?? {}).length
  const targetWorkspaceRows = useMemo(
    () => buildTargetRowsForTab(targetSubTab, targetStatusInfo, targetBackups, catalogIndex),
    [targetSubTab, targetStatusInfo, targetBackups, catalogIndex],
  )

  useEffect(() => {
    if (targetWorkspaceRows.length === 0) {
      if (targetFocusIndex !== 0) setTargetFocusIndex(0)
      return
    }
    if (targetFocusIndex >= targetWorkspaceRows.length) {
      setTargetFocusIndex(targetWorkspaceRows.length - 1)
    }
  }, [targetWorkspaceRows.length, targetFocusIndex])

  // Filter and build active list items in real-time (Pack -> Section -> Asset)
  const activeItems = useMemo<ActiveItem[]>(
    () =>
      buildCatalogTreeItems(catalogIndex, {
        searchQuery,
        assetFilter,
        expandedCategories,
        expandedSections,
      }),
    [catalogIndex, searchQuery, assetFilter, expandedCategories, expandedSections],
  )

  const delegationItems = useMemo(
    () => delegationTargetAgent
      ? agents.filter((a) => agentId(a) !== agentId(delegationTargetAgent))
      : [],
    [agents, delegationTargetAgent]
  )

  // Clamp focusedIndex and scrollOffset when list size changes
  useEffect(() => {
    if (pendingJumpIndexRef.current !== null && searchQuery === "") return
    setFocusedIndex(0)
    setScrollOffset(0)
  }, [searchQuery])

  useEffect(() => {
    const pendingIndex = pendingJumpIndexRef.current
    if (pendingIndex === null || workspaceTab !== "catalog" || viewMode !== "main") return
    const index = Math.max(0, Math.min(Math.max(0, activeItems.length - 1), pendingIndex))
    setFocusedIndex(index)
    setScrollOffset(offset => clampListScroll(index, activeItems.length, offset, maxVisibleItems))
    pendingJumpIndexRef.current = null
  }, [activeItems.length, expandedCategories, maxVisibleItems, searchQuery, viewMode, workspaceTab])

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
        const mark = pendingTriggers.has(WILDCARD_TRIGGER) ? "[X]" : "[ ]"
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
          const mark = pendingTriggers.has(prov) ? "[X]" : "[ ]"
          items.push({ type: "model", id: prov, label: `  ${mark} ★ any ${prov} model`, provider: prov })
        }
        providers[prov].forEach(model => {
          const prefix = viewMode === "model-selector" && routingPick?.kind === "trigger"
            ? `${pendingTriggers.has(model) ? "[X]" : "[ ]"} `
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
    if (viewMode === "model-selector" && routingPick === null) {
      items.push({ type: "model", id: INHERIT, label: "↺ inherit (remove explicit model)", provider: "routing" })
    }
    return items
  }, [models, expandedProviders, viewMode, repairGroupKey, invalidModelGroups, modelCatalog, routingPick, pendingTriggers, modelFilter])
  useEffect(() => {
    if (viewMode !== "model-selector" && viewMode !== "repair-selector") setModelFilter("")
  }, [viewMode])

  const sourceModalRows = useMemo<SourceWorkspaceRow[]>(() => {
    const query = sourcesQuery.trim().toLowerCase()
    const registeredGitUrls = new Set(
      registeredSources
        .filter((s): s is Source & { kind: "git" } => s.kind === "git")
        .map(s => s.url.toLowerCase().replace(/\.git$/i, ""))
    )
    const registered = registeredSources
      .filter(source => {
        if (!query) return true
        const targetText = source.kind === "local" ? source.path : source.url
        return source.name.toLowerCase().includes(query) || targetText.toLowerCase().includes(query)
      })
      .map(source => ({
        source,
        revision: sourceRevisions[source.name] ?? null,
        isActive: (activeDataSource?.kind === "source" ? activeDataSource.source.name : activeSourceName) === source.name,
      }))
    const ghReposFiltered = ghRepos.filter(repo => {
      if (registeredGitUrls.has(repo.url.toLowerCase().replace(/\.git$/i, ""))) return false
      return !query || repo.nameWithOwner.toLowerCase().includes(query) || repo.description.toLowerCase().includes(query)
    })

    let recentSuggestions: string[] = []
    if (isSourceSpecLike(sourcesQuery)) {
      const trimmed = sourcesQuery.trim()
      let dir = process.cwd()
      let needle = trimmed
      try {
        const expanded = trimmed.startsWith("~") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed
        const resolved = path.resolve(expanded)
        const resolvedStat = fs.lstatSync(resolved, { throwIfNoEntry: false })
        if (resolvedStat?.isDirectory() && !resolvedStat.isSymbolicLink()) {
          dir = resolved
          needle = ""
        } else {
          const parent = path.dirname(resolved)
          const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false })
          if (parentStat?.isDirectory() && !parentStat.isSymbolicLink()) {
            dir = parent
            needle = path.basename(resolved)
          }
        }
      } catch {
        // La directory di partenza resta quella corrente.
      }
      let entries: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }> = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isSymbolicLink: entry.isSymbolicLink(),
        }))
      } catch {
        // Directory non leggibile: restano solo i percorsi recenti.
      }
      const home = os.homedir()
      const toSpec = (name: string) => {
        const full = path.join(dir, name)
        if (trimmed === "~" || trimmed.startsWith("~/")) {
          const rel = path.relative(home, full)
          if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return `~/${rel.split(path.sep).join("/")}`
        }
        return full
      }
      const localSuggestions = suggestLocalPaths(needle, entries, 4).map(toSpec)
      const remembered = recentPaths.items.map(item => item.kind === "local" ? item.path : item.spec)
      recentSuggestions = [...remembered, ...localSuggestions]
    }

    return buildSourceWorkspaceRows({ query: sourcesQuery, registered, ghRepos: ghReposFiltered, recentSuggestions })
  }, [registeredSources, sourceRevisions, ghRepos, sourcesQuery, activeDataSource, activeSourceName, recentPaths])

  const sourceValidation = useMemo(() => {
    if (!sourcesInputFocused || !sourcesQuery.trim()) return null
    const result = validateSourceSpec(sourcesQuery)
    if (result.ok) {
      const value = result.kind === "local" ? result.path : `${result.spec}${result.ref ? `#${result.ref}` : ""}`
      return { ok: true, message: terminalSafeText(value) }
    }
    return { ok: false, message: terminalSafeText("error" in result ? result.error : String(result)) }
  }, [sourcesInputFocused, sourcesQuery])

  const maxVisibleSourceRows = wsViewports.sourcesRows
  useEffect(() => {
    const clampedFocus = sourceModalRows.length ? Math.min(sourcesFocusIndex, sourceModalRows.length - 1) : 0
    if (clampedFocus !== sourcesFocusIndex) setSourcesFocusIndex(clampedFocus)
    setSourcesScrollOffset(offset => clampListScroll(clampedFocus, sourceModalRows.length, offset, maxVisibleSourceRows))
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

  const isWorkspaceVirtualPack = useMemo(
    () => Boolean(workspaceRoot && isVirtualPackRoot(workspaceRoot)),
    [workspaceRoot, agents],
  )

  useEffect(() => {
    if (workspaceRoot && isWorkspaceVirtualPack && viewMode === "main" && !promptedVirtualRootsRef.current.has(workspaceRoot)) {
      promptedVirtualRootsRef.current.add(workspaceRoot)
      prepareOnboardingWizard(
        workspaceRoot,
        activeDataSource?.kind === "source" && activeDataSource.source.kind === "git" ? activeDataSource.source : null,
      )
    }
  }, [workspaceRoot, isWorkspaceVirtualPack])
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
    prepareOnboardingWizard(
      workspaceRoot,
      activeDataSource?.kind === "source" && activeDataSource.source.kind === "git" ? activeDataSource.source : null,
    )
  }

  const submitPackOnboarding = () => {
    try {
      let targetRepoRoot = workspaceRoot
      let clonedFromSource: string | null = null
      let activatedLocalSource: Source | null = null

      if (isReadOnlyGitSource && activeDataSource?.kind === "source" && activeDataSource.source.kind === "git") {
        const registry = loadSources()
        const cloned = cloneGitSourceForOnboarding({
          source: activeDataSource.source,
          destDir: initCloneDest,
          registry,
        })
        targetRepoRoot = cloned.localRoot
        clonedFromSource = activeDataSource.source.name
        activatedLocalSource = cloned.localSource
        promptedVirtualRootsRef.current.add(targetRepoRoot)
      }

      const res = applyPackOnboarding(targetRepoRoot, {
        name: initPackName,
        version: initPackVersion,
        description: initPackDesc,
        layout: initPackLayout,
        organize: initPackOrganize,
        authoringKit: initPackKit,
      })

      if (activatedLocalSource) {
        refreshSourcesView(true)
        switchToDataSource({ kind: "source", source: activatedLocalSource, root: targetRepoRoot })
      } else {
        refreshData()
      }
      setRoutingArchetype(null)
      setActionResultTitle(clonedFromSource ? "Cloned & Onboarded OpenCode Pack" : "OpenCode Pack Onboarded")
      setActionResultLines([
        ...(clonedFromSource ? [`Cloned ${clonedFromSource} -> ${targetRepoRoot} (active source: ${activatedLocalSource?.name ?? "local"})`] : []),
        `Created ${res.manifestPath}`,
        `Pack: ${res.manifest.name}@${res.manifest.version} (contract ${res.manifest.contract}, layout: ${res.layout})`,
        ...(res.manifest.archetype ? [`Archetype: ${res.manifest.archetype.callers.join(", ")} (ref: ${res.manifest.archetype.reference})`] : []),
        ...(res.movedAgents.length ? ["", "Organized agents:", ...res.movedAgents.map(m => `  ${m.from} -> ${m.to}`)] : []),
        ...(res.movedResources.length ? ["", "Organized resources:", ...res.movedResources.map(m => `  ${m.from} -> ${m.to}`)] : []),
        ...(res.strippedConfigKeys.length ? ["", `Separated user config keys into .opencode/opencode.user-backup.json: ${res.strippedConfigKeys.join(", ")}`] : []),
        ...(res.kitFiles.length ? ["", "Installed authoring kit:", ...res.kitFiles.map(f => `  ${f}`)] : []),
        ...(res.warnings.length ? ["", "Validation notes:", ...res.warnings.map(w => `  ${w}`)] : ["", "✓ Pack satisfies OpenCode Contract 1.1 with zero warnings."]),
      ])
      setViewMode("action-result")
    } catch (err: any) {
      setActionResultTitle("Pack Onboarding Failed")
      setActionResultLines([`Error: ${terminalSafeText(err?.message || err)}`])
      setViewMode("action-result")
    }
  }

  const openPackDoctorModal = (initialTab: PackDoctorTab = "doctor") => {
    if (isWorkspaceVirtualPack) {
      openInitPackModal()
      return
    }
    if (isReadOnlyGitSource) {
      pushToast("⚠ Pack Doctor edits local pack files; clone this Git source locally first")
      return
    }
    const preferredCategory = workspaceTab === "flows"
      ? flowsNav.rows[flowsFocusIndex]?.pack
      : activeItems[focusedIndex]?.category
    const resolvedPack = workspaceRoot ? resolveEditablePackDir(workspaceRoot, preferredCategory) : null
    if (!resolvedPack) {
      pushToast("⚠ No editable OpenCode pack manifest found in workspace")
      return
    }
    try {
      const rep = inspectPackDoctor(resolvedPack, workspaceRoot)
      setDoctorPackDir(resolvedPack)
      setDoctorReport(rep)
      setDoctorTab(initialTab)
      setDoctorScrollOffset(0)
      setDoctorStatusMessage(null)
      setScaffoldField("id")
      setScaffoldId("")
      setScaffoldDesc("")
      setViewMode("pack-doctor")
    } catch (err: any) {
      pushToast(`⚠ Doctor failed: ${terminalSafeText(err?.message || err)}`)
    }
  }

  const runPackDoctorAutoFix = () => {
    if (!doctorPackDir) return
    try {
      const res = fixPackDoctor(doctorPackDir, { repoRoot: workspaceRoot })
      setDoctorReport(res.report)
      setDoctorScrollOffset(0)
      refreshData()
      setDoctorStatusMessage(
        res.appliedFixes.length > 0
          ? `Applied ${res.appliedFixes.length} fix(es): ${res.appliedFixes[0]}`
          : "Nothing to fix — pack is already clean",
      )
    } catch (err: any) {
      setDoctorStatusMessage(`Fix error: ${terminalSafeText(err?.message || err)}`)
    }
  }

  const runPackDoctorAuthoringKit = () => {
    if (!doctorPackDir || !doctorReport?.manifest) return
    try {
      const files = installPackAuthoringKit(workspaceRoot || doctorPackDir, doctorPackDir, doctorReport.manifest)
      setDoctorReport(inspectPackDoctor(doctorPackDir, workspaceRoot))
      setDoctorStatusMessage(files.length > 0 ? `Installed authoring kit (${files.join(", ")})` : "Authoring kit refreshed")
    } catch (err: any) {
      setDoctorStatusMessage(`Kit error: ${terminalSafeText(err?.message || err)}`)
    }
  }

  const runPackDoctorBump = (release: SemverReleaseKind) => {
    if (!doctorPackDir) return
    try {
      const res = bumpPackVersion(doctorPackDir, release)
      setDoctorReport(inspectPackDoctor(doctorPackDir, workspaceRoot))
      refreshData()
      setDoctorStatusMessage(`Bumped version ${res.previousVersion} -> ${res.nextVersion}`)
    } catch (err: any) {
      setDoctorStatusMessage(`Version bump failed: ${terminalSafeText(err?.message || err)}`)
    }
  }

  const submitPackScaffold = () => {
    if (!doctorPackDir) return
    try {
      const res = scaffoldPackResource(doctorPackDir, {
        kind: scaffoldKind,
        id: scaffoldId,
        description: scaffoldDesc,
        mode: scaffoldMode,
      })
      refreshData()
      setCatalogRefreshSeq(seq => seq + 1)
      setDoctorReport(inspectPackDoctor(doctorPackDir, workspaceRoot))
      setScaffoldId("")
      setScaffoldDesc("")
      setDoctorStatusMessage(`Created ${res.relativePath}`)
    } catch (err: any) {
      setDoctorStatusMessage(`Error: ${terminalSafeText(err?.message || err)}`)
    }
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

  useEffect(() => {
    const clamped = modelTreeItems.length ? Math.min(focusedModelIndex, modelTreeItems.length - 1) : 0
    if (clamped !== focusedModelIndex) setFocusedModelIndex(clamped)
    setModelScrollOffset(offset => clampListScroll(clamped, modelTreeItems.length, offset, maxVisibleModels))
  }, [modelTreeItems.length, maxVisibleModels])

  useEffect(() => {
    const clamped = colorTreeItems.length ? Math.min(focusedColorIndex, colorTreeItems.length - 1) : 0
    if (clamped !== focusedColorIndex) setFocusedColorIndex(clamped)
    setColorScrollOffset(offset => clampListScroll(clamped, colorTreeItems.length, offset, maxVisibleColors))
  }, [colorTreeItems.length, maxVisibleColors])

  useEffect(() => {
    const clamped = delegationItems.length ? Math.min(focusedDelegationIndex, delegationItems.length - 1) : 0
    if (clamped !== focusedDelegationIndex) setFocusedDelegationIndex(clamped)
    setDelegationScrollOffset(offset => clampListScroll(clamped, delegationItems.length, offset, maxVisibleDelegations))
  }, [delegationItems.length, maxVisibleDelegations])

  const packFlowsByCategory = useMemo(() => {
    const map = new Map<string, ReturnType<typeof describeConfiguredPackFlows>>()
    if (!workspaceRoot) return map
    const cats = new Set<string>(agents.map(a => a.category))
    for (const cat of cats) {
      try {
        map.set(cat, describeConfiguredPackFlows(workspaceRoot, cat, { applySourceOverrides: isReadOnlyGitSource }))
      } catch {
        map.set(cat, null)
      }
    }
    return map
  }, [workspaceRoot, agents, isReadOnlyGitSource, routingRevision])

  const userOverridesSummary = useMemo(() => {
    const countsByPack = new Map<string, number>()
    const overriddenAgents = new Set<string>()
    const overriddenConfigKeys = new Set<string>()
    try {
      const target = realpathThroughExistingAncestor(path.resolve(defaultTarget()))
      const settings = loadOverrideSettings()
      const cats = new Set<string>(agents.map(a => a.category))
      for (const cat of cats) {
        const eff = effectiveOverrides(settings, target, cat)
        const ids = Object.keys(eff.agents).filter(id => Object.keys(ownProp(eff.agents, id) ?? {}).length > 0)
        for (const id of ids) overriddenAgents.add(`${cat}/${id}`)
        const configKeys = Object.entries(eff.config)
          .flatMap(([section, entries]) => Object.keys(entries ?? {}).map(key => `${section}/${key}`))
          .map(spec => `${cat}/${spec}`)
        for (const spec of configKeys) overriddenConfigKeys.add(spec)
        if (ids.length + configKeys.length > 0) countsByPack.set(cat, ids.length + configKeys.length)
      }
    } catch {
      // Ignore unreadable override settings in status badges
    }
    return { countsByPack, overriddenAgents, overriddenConfigKeys }
  }, [agents, flashTick, routingRevision])

  const resolveAgentHexColor = (rawCol: unknown): string => {
    if (typeof rawCol !== "string" || !rawCol.trim()) return THEME.accentBlue
    if (rawCol.startsWith("#")) return sanitizeHexColor(rawCol, THEME.accentBlue)
    for (const group of COLOR_PALETTE) {
      for (const c of group.colors) {
        if (c.value === rawCol) return c.hex
      }
    }
    return THEME.accentBlue
  }

  const categoryAgentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const ag of agents) counts.set(ag.category, (counts.get(ag.category) ?? 0) + 1)
    return counts
  }, [agents])

  const flowsNav = useMemo(() => buildFlowsNavRows(agents, packFlowsByCategory), [agents, packFlowsByCategory])

  useEffect(() => {
    const flowBudget = wsViewports.flowsRows
    const clamped = flowsNav.rows.length ? Math.min(flowsFocusIndex, flowsNav.rows.length - 1) : 0
    if (clamped !== flowsFocusIndex) setFlowsFocusIndex(clamped)
    setFlowsScrollOffset(off => clampListScroll(clamped, flowsNav.rows.length, off, flowBudget))
  }, [flowsNav.rows.length, wsViewports.flowsRows])

  const openPackFlowsModal = (pack: string, initialFlowIndex = 0) => {
    if (!workspaceRoot || !isConfigurablePack(workspaceRoot, pack)) {
      pushToast(`⚠ Pack "${pack}" has no configurable callers or agents.`)
      return
    }
    setRoutingArchetype(pack)
    setRoutingFocus(Math.max(0, initialFlowIndex))
    setRoutingScroll(0)
    setRoutingConfirmDelete(false)
    setRoutingStatus("")
    setViewMode("routing-configs")
  }

  /** MCP servers this pack contributes, as the effective (override-patched) contribution sees them. */
  const packMcpServers = useMemo<Array<{ name: string; enabled: boolean; overridden: boolean }>>(() => {
    if (!workspaceRoot || !routingArchetype) return []
    try {
      const dir = packDir(workspaceRoot, routingArchetype)
      if (!dir) return []
      const configFile = ["opencode.json", "opencode.jsonc"].find(name => fs.existsSync(path.join(dir, name)))
      if (!configFile) return []
      const config = parseJsonc(fs.readFileSync(path.join(dir, configFile), "utf8")) as Record<string, any>
      const target = realpathThroughExistingAncestor(path.resolve(defaultTarget()))
      const eff = effectiveOverrides(loadOverrideSettings(), target, routingArchetype)
      const servers = patchedConfigSections(config, eff.config, routingArchetype)["mcp.servers"] ?? {}
      return Object.keys(servers).sort().map(name => {
        const server = ownProp(servers, name) as Record<string, any> | undefined
        const sectionOverrides = ownProp(eff.config, "mcp.servers") as Record<string, unknown> | undefined
        return { name, enabled: server ? !isServerDisabled(server) : true, overridden: Boolean(sectionOverrides && Object.hasOwn(sectionOverrides, name)) }
      })
    } catch {
      return []
    }
  }, [workspaceRoot, routingArchetype, routingRevision, flashTick])

  const togglePackMcpServer = (name: string) => {
    if (!routingArchetype) return
    try {
      const server = packMcpServers.find(candidate => candidate.name === name)
      // Disabling writes `disabled: true`; enabling writes `disabled: null`, which removes the field from the entry
      // the pack contributes (the same semantics as `models unpin`), so pack-level and global disables are beaten too.
      const target = realpathThroughExistingAncestor(path.resolve(defaultTarget()))
      saveConfigOverride(routingArchetype, "mcp.servers", name, server?.enabled ? { disabled: true } : { disabled: null }, { target })
      setRoutingRevision(r => r + 1)
      const nextState = server?.enabled ? "disabled" : "enabled"
      setRoutingStatus(`MCP server '${name}' ${nextState} in overrides.json; reconciling target...`)
      void reconcileTargetIfInstalled("override").then(outcome => {
        setRoutingStatus(`MCP server '${name}' ${nextState}. ${formatReconcileLines(outcome)[0]}`)
      }).catch(error => {
        setRoutingStatus(`MCP server '${name}' ${nextState} in overrides.json; reconcile failed: ${terminalSafeText(error?.message || error)}`)
      })
    } catch (error: any) {
      setRoutingStatus(`Error: ${terminalSafeText(error?.message || error)}`)
    }
  }

  const openRoutingBranchAtIndex = (index: number) => {
    if (!routingView) return
    const focusedFlow = routingView.flows[index]
    const initialFocus = focusedFlow ? (routingView.related.length > 0 ? 1 : 2) : 0
    setRoutingFocus(index)
    setRoutingConfirmDelete(false)
    setRoutingEditorFocus(initialFocus)
    setRoutingEditorScroll(0)
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
  }

  const openRoutingCallersModal = () => {
    if (!routingView) return
    setRoutingConfirmDelete(false)
    setCallerDraftSet(new Set(routingView.callers.map(c => c.name)))
    setCallerFocus(0)
    setCallerScroll(0)
    setRoutingStatus("")
    setViewMode("routing-callers")
  }

  const saveCallersDraftAction = () => {
    if (!routingArchetype) return
    try {
      const nextCallers = [...callerDraftSet]
      saveUserPackCallers(workspaceRoot, routingArchetype, nextCallers, { applySourceOverrides: isReadOnlyGitSource })
      setRoutingRevision(r => r + 1)
      setRoutingStatus(`Updated callers (OR): ${nextCallers.join(", ")}; reconciling target...`)
      void reconcileTargetIfInstalled("models").then(outcome => {
        setRoutingStatus(`Updated callers (OR): ${nextCallers.join(", ")}. ${formatReconcileLines(outcome)[0]}`)
      }).catch(error => {
        setRoutingStatus(`Updated callers in routing.json; reconcile failed: ${terminalSafeText(error?.message || error)}`)
      })
      setViewMode("routing-configs")
    } catch (err: any) {
      setRoutingStatus(`Error: ${terminalSafeText(err?.message || err)}`)
    }
  }

  const resetCallersToDefaultsAction = () => {
    if (!routingArchetype) return
    try {
      saveUserPackCallers(workspaceRoot, routingArchetype, null, { applySourceOverrides: isReadOnlyGitSource })
      setRoutingRevision(r => r + 1)
      setRoutingStatus("Reset callers to pack / inferred defaults; reconciling target...")
      void reconcileTargetIfInstalled("models").then(outcome => {
        setRoutingStatus(`Reset callers to pack / inferred defaults. ${formatReconcileLines(outcome)[0]}`)
      }).catch(error => {
        setRoutingStatus(`Reset callers in routing.json; reconcile failed: ${terminalSafeText(error?.message || error)}`)
      })
      setViewMode("routing-configs")
    } catch (err: any) {
      setRoutingStatus(`Error: ${terminalSafeText(err?.message || err)}`)
    }
  }

  const activateRoutingEditorRow = (rowIndex: number, modelShortcutOnly = false) => {
    if (!routingView || !routingDraft) return
    const related = routingView.related
    const toolsRowIdx = related.length + 1
    const permsRowIdx = related.length + 2
    const delegationsRowIdx = related.length + 3
    const focusedAgent = rowIndex > 0 && rowIndex <= related.length ? related[rowIndex - 1] : undefined
    const targets = routingSelected.size > 0
      ? related.filter(agent => routingSelected.has(agent.role)).map(agent => agent.role)
      : focusedAgent
        ? [focusedAgent.role]
        : []

    if (rowIndex === 0) openRoutingPicker({ kind: "trigger" }, routingDraft.triggers)
    else if (rowIndex === toolsRowIdx && !modelShortcutOnly) {
      setFlowSubFocus(0)
      setFlowSubScroll(0)
      setViewMode("routing-tools")
    } else if (rowIndex === permsRowIdx && !modelShortcutOnly) {
      setFlowSubFocus(0)
      setFlowSubScroll(0)
      setViewMode("routing-permissions")
    } else if (rowIndex === delegationsRowIdx && !modelShortcutOnly) {
      setFlowSubFocus(0)
      setFlowSubScroll(0)
      setViewMode("routing-delegations")
    } else if (targets.length > 0) {
      openRoutingPicker({ kind: "roles", roles: targets }, routingDraft.roles[targets[0]])
    }
  }

  const cycleRoutingSubPolicyAt = (index: number, delta: 1 | -1 = 1) => {
    if (!routingDraft || !routingView) return
    if (viewMode === "routing-tools") {
      const toolRows = [{ key: "*" }, ...routingView.availableTools]
      const row = toolRows[index]
      if (!row) return
      const cycle: Array<PolicyEffect | undefined> = [undefined, "deny", "ask", "allow"]
      const current = routingDraft.tools[row.key]
      const nextEffect = cycle[(cycle.indexOf(current) + delta + cycle.length) % cycle.length]
      const tools = { ...routingDraft.tools }
      if (nextEffect === undefined) delete tools[row.key]
      else tools[row.key] = nextEffect
      applyRoutingDraft({ ...routingDraft, tools })
    } else if (viewMode === "routing-permissions") {
      const row = PERMISSION_POLICY_ROWS[index]
      if (!row) return
      const cycle: Array<PolicyEffect | undefined> = [undefined, "deny", "ask", "allow"]
      const current = routingDraft.permissions[row.key]
      const nextEffect = cycle[(cycle.indexOf(current) + delta + cycle.length) % cycle.length]
      const permissions = { ...routingDraft.permissions }
      if (nextEffect === undefined) delete permissions[row.key]
      else permissions[row.key] = nextEffect
      applyRoutingDraft({ ...routingDraft, permissions })
    } else if (viewMode === "routing-delegations") {
      const delRows = [{ name: "*" }, ...routingView.subagents]
      const row = delRows[index]
      if (!row) return
      const cycle: Array<DelegationEffect | undefined> = [undefined, "deny", "allow"]
      const current = routingDraft.delegations[row.name]
      const nextEffect = cycle[(cycle.indexOf(current) + delta + cycle.length) % cycle.length]
      const delegations = { ...routingDraft.delegations }
      if (nextEffect === undefined) delete delegations[row.name]
      else delegations[row.name] = nextEffect
      applyRoutingDraft({ ...routingDraft, delegations })
    }
  }

  const jumpToCatalogAgent = (agentPath: string) => {
    const jump = computeCatalogJumpState(agents, expandedCategories, agentPath, scrollOffset, maxVisibleItems, comparePackCategories)
    if (!jump) return
    pendingJumpIndexRef.current = jump.foundIndex
    setWorkspaceTab("catalog")
    setSearchQuery("")
    setIsSearching(false)
    setExpandedCategories(jump.expandedCategories)
    setFocusedIndex(jump.foundIndex)
    setScrollOffset(jump.scrollOffset)
  }

  const pullSelectedOrActiveSource = () => {
    const row = sourceModalRows[sourcesFocusIndex]
    const targetSource = row?.kind === "registered"
      ? row.source
      : activeDataSource?.kind === "source"
        ? activeDataSource.source
        : null
    if (targetSource && targetSource.kind === "git") {
      try {
        const commit = pullSource(targetSource)
        refreshSourcesView(true)
        if (activeDataSource?.kind === "source" && activeDataSource.source.name === targetSource.name) {
          setActiveRevision(commit)
          refreshData(activeDataSource)
        }
        const msg = `✓ Pulled ${targetSource.name}: ${commit?.slice(0, 12) ?? "up to date"}`
        setSourcesStatus(msg)
        pushToast(msg)
      } catch (error: any) {
        const msg = `✗ Pull failed: ${terminalSafeText(error?.message || error)}`
        setSourcesStatus(msg)
        pushToast(msg)
      }
    } else {
      refreshSourcesView(true)
      setSourcesStatus("Refreshed sources and GitHub repository list.")
      pushToast("✓ Refreshed sources & target status")
    }
  }

  const activateSourceRowAtIndex = (index: number) => {
    const row = sourceModalRows[index]
    if (row?.kind === "registered") activateRegisteredSource(row.source)
    else if (row?.kind === "gh-repo") attachNewSourceSpec(`github:${row.repo.nameWithOwner}`)
    else if (row?.kind === "connect-input") attachNewSourceSpec(row.spec)
    else if (sourcesQuery.trim()) attachNewSourceSpec(sourcesQuery.trim())
  }

  const openModelOrFlowsAction = () => {
    const focusedFolder = activeItems[focusedIndex]
    if (selectedAgentPaths.size === 0 && focusedFolder?.type === "folder" && isConfigurablePack(workspaceRoot, focusedFolder.category)) {
      openPackFlowsModal(focusedFolder.category)
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
        "Mark at least one agent (SPACE) to change its model,",
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
  }

  const openBridgeModalAction = (target: "claude" | "codex" | "vibe", explicitPack?: string) => {
    if (activeDataSource) {
      const candidates = target === "codex" ? codexBridgePacks : target === "vibe" ? vibeBridgePacks : claudeBridgePacks
      if (candidates.length === 0) {
        setActionResultTitle("No Pack to Bridge")
        setActionResultLines([`No ${target === "codex" ? "Codex" : target === "vibe" ? "Vibe" : "Claude"}-compatible pack was found in the active workspace.`])
        setViewMode("action-result")
        return
      }
      let loadedConfig = translationConfig
      try {
        loadedConfig = loadTranslationFor(activeDataSource)
        setTranslationConfig(loadedConfig)
      } catch {
        // Keep the in-memory config; generateBridge surfaces the load error on submit.
      }
      const baseCfg = loadedConfig ?? DEFAULT_TRANSLATION_CONFIG
      const nextTiers = cloneBridgeTiers(baseCfg.tiers)
      const nextRoles = { ...baseCfg.roles }
      const focusedPack = explicitPack
        ?? (workspaceTab === "flows"
          ? flowsNav.rows[flowsFocusIndex]?.pack
          : workspaceTab === "target"
            ? focusedTargetPackName() ?? undefined
            : activeItems[focusedIndex]?.category)
      const initialLayout = calculateBridgeModalLayout(termWidth, termHeight, {
        packExpanded: false,
        tierCount: Object.keys(nextTiers).length,
      })
      const initialPack = resolveInitialBridgePack(candidates, focusedPack, initialLayout.packViewportRows)
      bridgeModelTargetDirtyRef.current = false
      setBridgeConfirmReasons([])
      setBridgeTarget(target)
      setBridgePluginName("")
      setBridgeModelTarget(initialBridgeModelCatchAll(baseCfg, target))
      setBridgeDraftTiers(nextTiers)
      setBridgeDraftRoles(nextRoles)
      setBridgeTiersDirty(false)
      setBridgeTierIndex(0)
      setBridgeTierScrollOffset(0)
      setBridgeAgentIndex(0)
      setBridgeAgentScrollOffset(0)
      setBridgeClaudeTierTyping(false)
      setBridgePackSuggested(initialPack.selectedPack)
      setBridgeSelectedPack(initialPack.selectedPack)
      setBridgePackQuery(initialPack.query)
      setBridgePackIndex(initialPack.index)
      setBridgePackScrollOffset(initialPack.scrollOffset)
      setBridgeFocusedField("name")
      setViewMode("bridge-prompt")
    }
  }

  const adjustTuningSteps = (delta: number) => {
    const parsedFallback = Number.parseInt(tuningSummary.steps.value, 10)
    const fallback = Number.isFinite(parsedFallback) ? parsedFallback : 50
    const parsedDraft = Number.parseInt(tuningSteps, 10)
    const current =
      !tuningDirtyFields.has("steps") && tuningSummary.steps.mixed
        ? fallback
        : Number.isFinite(parsedDraft)
          ? parsedDraft
          : fallback
    setTuningSteps(String(Math.max(1, current + delta)))
    markTuningDirty("steps")
  }

  const submitTuningModal = () => {
    const targetAgents = tuningTargetPaths.length > 0
      ? agents.filter((a) => tuningTargetPaths.includes(a.currentPath))
      : []
    if (tuningDirtyFields.size === 0) {
      setViewMode("main")
      pushToast("No parameters modified — left all agents unchanged.")
      return
    }
    if (targetAgents.length === 0) return

    try {
      const params = buildTuningUpdateParams(
        { steps: tuningSteps, variant: tuningVariant, mode: tuningMode, hidden: tuningHidden },
        tuningDirtyFields,
        modelVariants && modelVariants.length > 0 ? modelVariants : undefined
      )
      applyAgentMutation(
        targetAgents.map(a => a.currentPath),
        writer => updateAgentParams(targetAgents, params, writer),
        "Parameters Updated Successfully",
        [
          `Successfully tuned parameters for ${targetAgents.length} agents:`,
          `  * Steps:      ${tuningDirtyFields.has("steps") ? params.steps : "unchanged"}`,
          `  * Variant:    ${tuningDirtyFields.has("variant") ? (params.variant ?? "default (unset)") : "unchanged"}`,
          `  * Mode:       ${tuningDirtyFields.has("mode") ? tuningMode : "unchanged"}`,
          `  * Visibility: ${tuningDirtyFields.has("hidden") ? (tuningHidden ? "hidden" : "visible") : "unchanged"}`
        ]
      )
    } catch (error: any) {
      pushToast(`✗ ${terminalSafeText(error.message || String(error))}`)
    }
  }

  const openTuningModalAction = () => {
    if (activeItems.length === 0) return
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
    setTuningVariant(summary.variant.value)
    setTuningVariantTyping(false)
    setTuningMode(summary.mode.value)
    setTuningHidden(summary.hidden.value)
    setTuningDirtyFields(new Set())
    setTuningFocusedField("steps")
    setViewMode("parameter-tuning")
  }

  const toggleFolderAtFocused = () => {
    const item = activeItems[focusedIndex]
    if (item?.type === "folder") {
      setExpandedCategories(prev => {
        const next = new Set(prev)
        if (next.has(item.id)) next.delete(item.id)
        else next.add(item.id)
        return next
      })
    } else if (item?.type === "section") {
      setExpandedSections(prev => {
        const next = new Set(prev)
        if (next.has(item.id)) next.delete(item.id)
        else next.add(item.id)
        return next
      })
    }
  }

  const cycleAssetFilter = () => {
    setAssetFilter(prev => {
      const idx = ASSET_TYPE_FILTERS.findIndex(f => f.key === prev)
      const next = ASSET_TYPE_FILTERS[(idx + 1) % ASSET_TYPE_FILTERS.length]!
      pushToast(`Filter: ${next.label}`)
      return next.key
    })
  }

  const focusedTargetPackName = (): string | null => {
    if (workspaceTab === "target") {
      const row = targetWorkspaceRows[targetFocusIndex]
      if (row?.kind === "installed-pack" || row?.kind === "bridge-pack") return row.packName
      return null
    }
    const item = activeItems[focusedIndex]
    return item?.category ?? catalogPacks[0] ?? null
  }

  const toggleSelectionAtPath = (agentPath: string) => {
    setSelectedAgentPaths(prev => {
      const next = new Set(prev)
      if (next.has(agentPath)) next.delete(agentPath)
      else next.add(agentPath)
      return next
    })
  }

  const togglePackSelection = (packs: string[]) => {
    if (packs.length === 0) return
    setSelectedPackNames(prev => {
      const next = new Set(prev)
      const allSelected = packs.every(pack => prev.has(pack))
      for (const pack of packs) {
        if (allSelected) next.delete(pack)
        else next.add(pack)
      }
      return next
    })
  }

  const openCommandPalette = () => {
    setPaletteQuery("")
    setPaletteFocusIndex(0)
    setPaletteScrollOffset(0)
    setViewMode("command-palette")
  }

  const openHelpGuide = (preferredTab?: HelpTabId) => {
    setHelpTab(preferredTab ?? defaultHelpTabForWorkspace(workspaceTab))
    setHelpFocusIndex(0)
    setHelpScrollOffset(0)
    setViewMode("help")
  }

  const selectHelpTab = (nextTab: HelpTabId) => {
    setHelpTab(nextTab)
    setHelpFocusIndex(0)
    setHelpScrollOffset(0)
  }

  const activateHelpItem = (item: HelpShortcutItem) => {
    if (!item.actionId) {
      pushToast(`● [${item.keyLabel}] ${item.title}`)
      return
    }
    if (item.disabled) {
      if (item.actionId === "repair-models") {
        pushToast("✓ All agent models are already valid")
      } else if (item.actionId === "pack-init") {
        pushToast("⚠ Current workspace already has an opencode-pack.json manifest")
      } else if (item.actionId === "pack-doctor" || item.actionId === "pack-scaffold") {
        pushToast(isWorkspaceVirtualPack ? "⚠ Press [I] to onboard this virtual pack first" : "⚠ Requires a writable local pack workspace")
      } else if (isReadOnlyGitSource && (item.actionId === "agent-rename" || item.actionId === "fix-permission-order")) {
        pushToast("⚠ Requires a writable local pack workspace")
      } else {
        pushToast("⚠ Connect or activate a pack source with agents first")
      }
      return
    }
    executeActionById(item.actionId)
  }

  const toggleFocusedSourceTrust = () => {
    const row = sourceModalRows[sourcesFocusIndex]
    if (row?.kind !== "registered") {
      pushToast("⚠ Focus a registered source row to toggle trust")
      return
    }
    try {
      const registry = loadSources()
      const target = findSource(registry, row.source.name)
      target.trusted = !target.trusted
      saveSources(registry)
      if (activeDataSource?.kind === "source" && activeDataSource.source.name === target.name) {
        setActiveDataSource({ ...activeDataSource, source: { ...target } })
      }
      refreshSourcesView(true)
      const msg = `Source "${target.name}" is now ${target.trusted ? "trusted" : "untrusted"}.`
      setSourcesStatus(msg)
      pushToast(`✓ ${msg}`)
    } catch (error: any) {
      setSourcesStatus(terminalSafeText(error?.message || error))
    }
  }

  const removeFocusedSource = () => {
    const row = sourceModalRows[sourcesFocusIndex]
    if (row?.kind !== "registered") {
      pushToast("⚠ Focus a registered source row to remove it")
      return
    }
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
      pushToast(`✓ Removed source "${row.source.name}"`)
    } catch (error: any) {
      setSourcesStatus(terminalSafeText(error?.message || error))
    }
  }

  const executeActionById = (actionId: string) => {
    if (actionId.startsWith("jump:")) {
      setViewMode("main")
      jumpToCatalogAgent(actionId.slice("jump:".length))
      return
    }
    setViewMode("main")
    switch (actionId) {
      case "palette":
        openCommandPalette()
        break
      case "help":
        openHelpGuide()
        break
      case "ws-catalog":
        setWorkspaceTab("catalog")
        break
      case "ws-target":
        refreshTargetStatus()
        setWorkspaceTab("target")
        break
      case "ws-flows":
        setWorkspaceTab("flows")
        break
      case "ws-sources":
        openSourcesModal()
        break
      case "ws-next":
        if (workspaceTab === "catalog") {
          refreshTargetStatus()
          setWorkspaceTab("target")
        } else if (workspaceTab === "target") setWorkspaceTab("flows")
        else if (workspaceTab === "flows") openSourcesModal()
        else setWorkspaceTab("catalog")
        break
      case "pane-toggle":
        if (!layout.showInspector) {
          pushToast("⚠ Widen terminal (>=100 cols) to display the right sidebar")
        } else {
          setActivePane(prev => (prev === "inspector" ? "list" : "inspector"))
        }
        break
      case "pane-list":
        setActivePane("list")
        break
      case "pane-inspector":
        if (layout.showInspector) setActivePane("inspector")
        break
      case "folder-toggle":
        toggleFolderAtFocused()
        break
      case "select-toggle": {
        const item = activeItems[focusedIndex]
        if (item?.type === "file" && item.agent) toggleSelectionAtPath(item.agent.currentPath)
        else if (item?.type === "folder" || item?.type === "section" || item?.type === "asset") togglePackSelection([item.category])
        break
      }
      case "select-all-packs": {
        togglePackSelection(activeItems.filter(item => item.type === "folder").map(item => item.category))
        break
      }
      case "select-category": {
        const item = activeItems[focusedIndex]
        if (item) {
          const folderPaths = agents.filter(a => a.category === item.category).map(a => a.currentPath)
          setSelectedAgentPaths(prev => {
            const next = new Set(prev)
            const allSelected = folderPaths.every(p => next.has(p))
            folderPaths.forEach(p => allSelected ? next.delete(p) : next.add(p))
            return next
          })
        }
        break
      }
      case "select-same-model": {
        const item = activeItems[focusedIndex]
        if (item?.type === "file" && item.agent) {
          const targetModel = item.agent.model
          const targetCategory = item.category
          const matchingAgentPaths = agents
            .filter(a => a.model === targetModel && a.category === targetCategory)
            .map(a => a.currentPath)
          setSelectedAgentPaths(prev => {
            const next = new Set(prev)
            const allSelected = matchingAgentPaths.every(p => next.has(p))
            matchingAgentPaths.forEach(p => allSelected ? next.delete(p) : next.add(p))
            return next
          })
        } else {
          pushToast("⚠ Focus an agent file to mark same-model peers")
        }
        break
      }
      case "catalog-search":
        setWorkspaceTab("catalog")
        setIsSearching(true)
        break
      case "agent-model":
        openModelOrFlowsAction()
        break
      case "pack-flows": {
        const pack = workspaceTab === "flows"
          ? flowsNav.rows[flowsFocusIndex]?.pack
          : activeItems[focusedIndex]?.category
        if (pack) openPackFlowsModal(pack)
        break
      }
      case "flow-jump": {
        if (workspaceTab !== "flows") {
          setWorkspaceTab("flows")
          pushToast("● Switched to Flows — focus a row and press Enter")
          break
        }
        const row = flowsNav.rows[flowsFocusIndex]
        if (row?.kind === "pack") openPackFlowsModal(row.pack)
        else if (row?.agent) jumpToCatalogAgent(row.agent.currentPath)
        break
      }
      case "pack-install": {
        const pack = workspaceTab === "flows"
          ? flowsNav.rows[flowsFocusIndex]?.pack
          : activeItems[focusedIndex]?.category
        const packs = workspaceTab === "catalog" && selectedPacks.length > 0 ? selectedPacks : pack ? [pack] : []
        previewInstall(packs)
        break
      }
      case "pack-init":
        if (isWorkspaceVirtualPack) openInitPackModal()
        else pushToast("⚠ Current workspace already has an opencode-pack.json manifest")
        break
      case "pack-doctor":
        openPackDoctorModal("doctor")
        break
      case "pack-scaffold":
        openPackDoctorModal("scaffold")
        break
      case "repair-models":
        if (modelCatalog.status === "verified" && invalidModelGroups.length > 0) {
          setRepairMappings({})
          setRepairGroupKey("0")
          setFocusedModelIndex(0)
          setModelScrollOffset(0)
          setViewMode("repair-selector")
        } else {
          pushToast("✓ No invalid or missing models detected")
        }
        break
      case "agent-tune":
        openTuningModalAction()
        break
      case "agent-tier":
        if (activeItems[focusedIndex]?.agent) {
          setFocusedTierIndex(0)
          setTierScrollOffset(0)
          setViewMode("tier-selector")
        } else {
          pushToast("⚠ Focus an agent first to assign a translation tier")
        }
        break
      case "agent-color":
        if (activeItems[focusedIndex]?.agent || selectedAgentPaths.size > 0) {
          setFocusedColorIndex(0)
          setColorScrollOffset(0)
          setViewMode("color-selector")
        } else {
          pushToast("⚠ Focus or mark an agent to change badge color")
        }
        break
      case "agent-rename":
        if (isReadOnlyGitSource) {
          pushToast("⚠ Renaming files requires a local pack workspace")
        } else if (activeItems[focusedIndex]?.agent) {
          const ag = activeItems[focusedIndex].agent!
          const analysis = analyzeAgentName(ag.filename, allAgentFilenames)
          setRenameTargetAgent(ag)
          setRenameFamily(analysis.family || "")
          setRenameCategory(analysis.category || "")
          setRenameRole((analysis.role || "").replace(/[\s-]/g, "_"))
          setRenameFocusedField("role")
          setViewMode("rename-prompt")
        } else {
          pushToast("⚠ Focus an agent file to rename it")
        }
        break
      case "agent-permissions":
        if (activeItems[focusedIndex]?.agent || selectedAgentPaths.size > 0) {
          setFocusedPresetIndex(0)
          setViewMode("permission-preset")
        } else {
          pushToast("⚠ Focus or mark an agent to apply a safety preset")
        }
        break
      case "agent-delegations": {
        const flowRow = flowsNav.rows[Math.max(0, Math.min(flowsFocusIndex, Math.max(0, flowsNav.rows.length - 1)))] ?? null
        const target = workspaceTab === "flows"
          ? buildFlowsInspectorItems(flowRow, agents, packFlowsByCategory, flowsNav.agentByShortName).activeAgent
          : activeItems[focusedIndex]?.agent
        if (target) {
          setDelegationTargetAgent(target)
          setSelectedDelegations(new Set(target.allowedSubagents || []))
          setFocusedDelegationIndex(0)
          setDelegationScrollOffset(0)
          setViewMode("delegation-manager")
        } else {
          pushToast("⚠ Focus an agent to edit its @subagent delegations")
        }
        break
      }
      case "agent-resources":
        if (activeItems[focusedIndex]?.agent) openResourceManager(activeItems[focusedIndex].agent!)
        else pushToast("⚠ Focus an agent to manage Skills, Tools & MCP")
        break
      case "bridge-claude":
        openBridgeModalAction("claude")
        break
      case "bridge-codex":
        openBridgeModalAction("codex")
        break
      case "bridge-vibe":
        openBridgeModalAction("vibe")
        break
      case "layout-adjust":
        setLayoutSnapshot(appliedShare)
        setLayoutDraft(appliedShare)
        setLayoutError("")
        setLayoutStatus("")
        setViewMode("layout")
        break
      case "toggle-motion":
        toggleReducedMotion()
        break
      case "source-activate":
        if (workspaceTab !== "sources") {
          openSourcesModal(true)
          pushToast("● Switched to Sources — choose a row and press Enter")
        } else {
          activateSourceRowAtIndex(sourcesFocusIndex)
        }
        break
      case "source-trust":
        if (workspaceTab !== "sources") {
          openSourcesModal(true)
          pushToast("● Switched to Sources — focus a registered source to toggle trust")
        } else {
          toggleFocusedSourceTrust()
        }
        break
      case "source-remove":
        if (workspaceTab !== "sources") {
          openSourcesModal(true)
          pushToast("● Switched to Sources — focus a registered source to remove it")
        } else {
          removeFocusedSource()
        }
        break
      case "source-search":
        setWorkspaceTab("sources")
        setSourcesInputFocused(true)
        break
      case "source-pull":
        pullSelectedOrActiveSource()
        break
      case "source-gh-auth":
        runInteractiveGhLogin()
        break
      case "target-reconcile":
        runTargetReconcile()
        break
      case "target-reconcile-adopt":
        previewTargetOp("reconcile", [], true)
        break
      case "target-update": {
        const row = workspaceTab === "target" ? targetWorkspaceRows[targetFocusIndex] : null
        const packNames = row?.kind === "installed-pack" ? [row.packName] : []
        previewTargetOp("update", packNames)
        break
      }
      case "target-uninstall": {
        const row = workspaceTab === "target" ? targetWorkspaceRows[targetFocusIndex] : null
        if (row?.kind === "installed-pack" && row.isRoot) {
          previewTargetOp("uninstall", [row.packName])
        } else {
          pushToast("⚠ Focus an installed [root] pack in Target & Bridges to uninstall")
        }
        break
      }
      case "target-restore": {
        const row = workspaceTab === "target" ? targetWorkspaceRows[targetFocusIndex] : null
        if (row?.kind === "backup") {
          runTargetRestoreAction(row.backup.id)
        } else if (targetBackups[0]) {
          runTargetRestoreAction(targetBackups[0].id)
        } else {
          pushToast("⚠ No backup snapshots available to restore")
        }
        break
      }
      case "bridge-check": {
        const packName = focusedTargetPackName()
        if (packName) runBridgeCheckAction(packName)
        else pushToast("⚠ Focus a pack first to run bridge check")
        break
      }
      case "codex-install": {
        const packName = focusedTargetPackName()
        if (packName) openCodexInstallPreviewAction(packName)
        else pushToast("⚠ Focus a pack first to install into Codex")
        break
      }
      case "catalog-asset-filter":
        cycleAssetFilter()
        break
      case "workspace-maintenance":
        openMaintenanceModal("validate")
        break
      case "target-refresh":
        refreshSourcesView(true)
        pushToast("✓ Refreshed sources & target status")
        break
      case "engine-self-update":
        openSelfUpdateModal()
        break
      case "fix-permission-order": {
        if (isReadOnlyGitSource) {
          pushToast("⚠ Fixing frontmatter permission order requires a local pack workspace")
          break
        }
        const ag = activeItems[focusedIndex]?.agent
        if (!ag) {
          pushToast("⚠ Focus an agent file first")
          break
        }
        setWorkspaceTab("catalog")
        setInspectorTab("security")
        if (!analyzePermissionOrder(ag).hasOrderError) {
          pushToast("✓ Wildcard permission order is already valid")
          break
        }
        try {
          applyAgentMutation(
            [ag.currentPath],
            writer => { fixPermissionOrder(ag, writer) },
            "Permission Order Fixed",
            [
              `Successfully reordered permissions for:`,
              `  ${ag.filename}`,
              `Placed wildcard "*": "deny" FIRST to comply with OpenCode spec.`,
            ],
          )
        } catch (error: any) {
          setActionResultTitle("Error Fixing Permission Order")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
        break
      }
    }
  }

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const base: PaletteCommand[] = [
      { id: "ws-catalog", label: "Switch to Catalog & Inspector", category: "Workspace", shortcut: "Tab", keywords: ["packs", "agents", "skills", "commands", "tools", "plugins", "mcp"] },
      { id: "ws-target", label: "Switch to Target & Bridges (OpenCode / Claude / Codex)", category: "Workspace", shortcut: "Tab", keywords: ["target", "installed", "update", "uninstall", "backup", "restore", "claude", "codex"] },
      { id: "ws-flows", label: "Switch to Flows & Call Graph", category: "Workspace", shortcut: "Tab", keywords: ["routing", "delegations", "topology", "subagents"] },
      { id: "ws-sources", label: "Switch to Sources & GitHub", category: "Workspace", shortcut: "O", keywords: ["github", "repo", "status", "sources"] },
      { id: "pane-toggle", label: "Toggle Focus: Main Panel / Right Sidebar", category: "Workspace", shortcut: "⇧← / ⇧→", keywords: ["sidebar", "inspector", "pane", "panel", "focus"], disabled: !layout.showInspector },
      { id: "agent-model", label: "Assign LLM Model (or Pack Flows)", category: "Agent", shortcut: "M", keywords: ["provider", "claude", "gpt", "gemini"], disabled: agents.length === 0 },
      { id: "agent-tune", label: "Tune Steps, Thinking Effort, Mode & Visibility", category: "Agent", shortcut: "T", keywords: ["reasoning", "variant", "mode", "hidden"], disabled: agents.length === 0 },
      { id: "agent-permissions", label: "Apply Security / Safety Preset", category: "Agent", shortcut: "P", keywords: ["sandbox", "bash", "deny", "allow"], disabled: agents.length === 0 },
      { id: "agent-resources", label: "Manage Skills, Custom Tools & MCP Servers", category: "Agent", shortcut: "U", keywords: ["mcp", "skills", "permissions"], disabled: agents.length === 0 },
      { id: "agent-delegations", label: "Edit Authorized @subagent Delegations", category: "Agent", shortcut: "G", keywords: ["graph", "call", "subagents"], disabled: agents.length === 0 },
      { id: "agent-color", label: "Pick Agent Badge Color", category: "Agent", shortcut: "C", keywords: ["theme", "hex", "palette"], disabled: agents.length === 0 },
      { id: "agent-tier", label: "Assign Bridge Translation Tier", category: "Agent", shortcut: "Shift+T", keywords: ["planning", "execution", "light"], disabled: agents.length === 0 },
      { id: "agent-rename", label: "Rename Agent File & References", category: "Agent", shortcut: "R", keywords: ["refactor", "filename"], disabled: agents.length === 0 || isReadOnlyGitSource },
      { id: "repair-models", label: "Batch-Repair Invalid / Missing Models", category: "Pack", shortcut: "V", keywords: ["fix", "broken"], disabled: invalidModelGroups.length === 0 },
      { id: "pack-flows", label: "Configure Conditional IF/OR Pack Flows", category: "Pack", shortcut: "M", keywords: ["rules", "triggers", "routing"], disabled: agents.length === 0 },
      { id: "pack-install", label: "Preview & Install Packs into OpenCode", category: "Target & Bridges", shortcut: "E", keywords: ["deploy", "update", "lock"], disabled: catalogPacks.length === 0 },
      { id: "target-update", label: "Update Installed OpenCode Packs", category: "Target & Bridges", shortcut: "U", keywords: ["upgrade", "pull", "lock"] },
      { id: "target-uninstall", label: "Uninstall Focused Root Pack from OpenCode", category: "Target & Bridges", shortcut: "X", keywords: ["remove", "delete"] },
      { id: "target-reconcile", label: "Reconcile Installed OpenCode Target Now", category: "Target & Bridges", shortcut: "R", keywords: ["sync", "drift", "opencode.json"] },
      { id: "target-reconcile-adopt", label: "Reconcile OpenCode Target with --adopt (Backup Local Edits)", category: "Target & Bridges", shortcut: "Shift+A", keywords: ["adopt", "backup", "drift"] },
      { id: "target-restore", label: "Restore Target Backup Snapshot", category: "Target & Bridges", shortcut: "Shift+R", keywords: ["rollback", "backup", "restore"], disabled: targetBackups.length === 0 },
      { id: "bridge-check", label: "Check Claude, Codex & Vibe Bridge Compatibility", category: "Target & Bridges", shortcut: "Shift+K", keywords: ["check", "validate", "claude", "codex", "vibe"], disabled: catalogPacks.length === 0 },
      { id: "bridge-claude", label: "Generate Claude Code Plugin Bridge", category: "Target & Bridges", shortcut: "B", keywords: ["anthropic", "marketplace", "skills", "commands"], disabled: claudeBridgePacks.length === 0 },
      { id: "bridge-codex", label: "Generate OpenAI Codex Bridge", category: "Target & Bridges", shortcut: "Shift+B", keywords: ["codex", "toml", "skills", "mcp"], disabled: codexBridgePacks.length === 0 },
      { id: "bridge-vibe", label: "Generate Mistral Vibe Bridge", category: "Target & Bridges", shortcut: "Shift+V", keywords: ["vibe", "mistral", "toml", "skills", "mcp", "subagents"], disabled: vibeBridgePacks.length === 0 },
      { id: "codex-install", label: "Install Pack Directly into Codex (--codex)", category: "Target & Bridges", shortcut: "C", keywords: ["codex", "install", "skills", "mcp"], disabled: codexBridgePacks.length === 0 },
      { id: "catalog-asset-filter", label: "Cycle Catalog Asset-Type Filter (All/Agents/Skills/Cmds/Tools/Plugins/MCP)", category: "Pack", shortcut: "F", keywords: ["filter", "skills", "commands", "tools", "plugins", "mcp"], disabled: catalogPacks.length === 0 },
      { id: "workspace-maintenance", label: "Open Workspace Maintenance (Validate, Lint, Fix-Names, Audit)", category: "Pack", shortcut: "W", keywords: ["validate", "lint", "audit", "fix-names", "security"], disabled: catalogPacks.length === 0 },
      { id: "engine-self-update", label: "Check / Apply manage-agents Engine Release Update", category: "Target & Bridges", shortcut: "Shift+U", keywords: ["self-update", "version", "upgrade", "github", "release"] },
      { id: "source-pull", label: "Pull Git Source & Refresh GitHub Repos", category: "Target & Bridges", shortcut: "P", keywords: ["fetch", "git", "sync"] },
      { id: "pack-init", label: isReadOnlyGitSource ? "Clone & Onboard Virtual Git Repo into Pack" : "Onboard Virtual Folder into OpenCode Pack (1.1)", category: "Pack", shortcut: "I", keywords: ["virtual", "manifest", "onboard", "clone"], disabled: !isWorkspaceVirtualPack },
      { id: "pack-doctor", label: "Open Pack Doctor & Auto-Fix Contract Issues", category: "Pack", shortcut: "D", keywords: ["validate", "doctor", "fix", "semver", "bump", "kit"], disabled: isWorkspaceVirtualPack || isReadOnlyGitSource || !hasEditablePacks },
      { id: "pack-scaffold", label: "Create New Pack Agent, Skill, Command, Tool, Plugin or MCP", category: "Pack", shortcut: "N", keywords: ["new", "scaffold", "add", "agent", "skill", "command", "tool", "plugin", "mcp"], disabled: isWorkspaceVirtualPack || isReadOnlyGitSource || !hasEditablePacks },
      { id: "layout-adjust", label: "Adjust List / Inspector Split Width", category: "View & Motion", shortcut: "Shift+L", keywords: ["resize", "columns"] },
      { id: "toggle-motion", label: reducedMotionState ? "Enable Smooth 60fps Micro-Animations" : "Enable Reduced Motion Mode", category: "View & Motion", shortcut: "Ctrl+E", keywords: ["animation", "motion", "fps"] },
      { id: "help", label: "Open Keyboard & Mouse Guide", category: "View & Motion", shortcut: "?", keywords: ["shortcuts", "cheatsheet"] },
    ]
    for (const ag of agents) {
      base.push({
        id: `jump:${ag.currentPath}`,
        label: agentId(ag),
        category: "Jump to Agent",
        hint: `${ag.category} · ${modelDisplayValue(ag, true, modelCatalog)}`,
        keywords: [ag.category, ag.filename, String(ag.frontmatter.model ?? "")],
      })
    }
    return base
  }, [agents, catalogPacks, claudeBridgePacks, codexBridgePacks, targetBackups.length, hasEditablePacks, isReadOnlyGitSource, invalidModelGroups.length, isWorkspaceVirtualPack, reducedMotionState, modelCatalog, layout.showInspector])

  const filteredPaletteCommands = useMemo(
    () => filterPaletteCommands(paletteCommands, paletteQuery),
    [paletteCommands, paletteQuery],
  )
  const maxPaletteRows = paletteViewport.viewportRows

  const helpContent = useMemo(
    () =>
      buildHelpSections(helpTab, {
        hasPacks: catalogPacks.length > 0,
        hasAgents: agents.length > 0,
        isReadOnlyGitSource,
        isVirtualPack: isWorkspaceVirtualPack,
        hasInvalidModels: modelCatalog.status === "verified" && invalidModelGroups.length > 0,
      }),
    [helpTab, catalogPacks.length, agents.length, isReadOnlyGitSource, isWorkspaceVirtualPack, modelCatalog.status, invalidModelGroups.length],
  )

  useEffect(() => {
    if (viewMode !== "help") return
    const vpRows = calculateHelpViewport(termWidth, termHeight).viewportRows
    const clampedFocus = Math.max(0, Math.min(Math.max(0, helpContent.items.length - 1), helpFocusIndex))
    if (clampedFocus !== helpFocusIndex) setHelpFocusIndex(clampedFocus)
    setHelpScrollOffset(off => clampHelpScroll(clampedFocus, helpContent.rows, off, vpRows))
  }, [viewMode, termWidth, termHeight, helpContent.rows, helpContent.items.length])

  useEffect(() => {
    pasteRef.current = emptyPasteBuffer()
  }, [viewMode, workspaceTab, isSearching, sourcesInputFocused, doctorTab, initPackField, scaffoldField, tuningFocusedField, renameFocusedField])

  const resolvePasteTarget = (): { set: (text: string) => void; append: (ch: string) => void; after: () => void } | null => {
    const printable = (ch: string) => /^[\x20-\x7E]$/.test(ch)
    const simple = (
      setter: (updater: (value: string) => string) => void,
      after: () => void,
      accept: (ch: string) => boolean = printable,
    ) => {
      const append = (ch: string) => { if (accept(ch)) setter(value => value + ch) }
      return { set: (text: string) => { for (const ch of text) append(ch) }, append, after }
    }

    if (viewMode === "command-palette") {
      return simple(setPaletteQuery, () => { setPaletteFocusIndex(0); setPaletteScrollOffset(0) })
    }
    if (viewMode === "main" && workspaceTab === "catalog" && isSearching) {
      return simple(setSearchQuery, () => {})
    }
    if (viewMode === "main" && workspaceTab === "sources" && sourcesInputFocused) {
      return {
        set: text => setSourcesQuery(query => query + text),
        append: ch => setSourcesQuery(query => query + ch),
        after: () => { setSourcesFocusIndex(0); setSourcesScrollOffset(0) },
      }
    }
    if (viewMode === "pack-init") {
      const append = (ch: string) => {
        if (!printable(ch)) return
        if (initPackField === "cloneDest") setInitCloneDest(s => s + ch)
        else if (initPackField === "name" && /[a-zA-Z0-9-]/.test(ch)) setInitPackName(s => (s + ch.toLowerCase()).slice(0, 64))
        else if (initPackField === "version" && ch !== " ") setInitPackVersion(s => s + ch)
        else if (initPackField === "desc") setInitPackDesc(s => s + ch)
      }
      return { set: text => { for (const ch of text) append(ch) }, append, after: () => {} }
    }
    if (viewMode === "pack-doctor" && doctorTab !== "doctor") {
      const append = (ch: string) => {
        if (!printable(ch)) return
        if (scaffoldField === "id" && /[a-zA-Z0-9._/-]/.test(ch)) setScaffoldId(s => s + ch)
        else if (scaffoldField === "desc") setScaffoldDesc(s => s + ch)
      }
      return { set: text => { for (const ch of text) append(ch) }, append, after: () => {} }
    }
    if (viewMode === "parameter-tuning" && (tuningFocusedField === "steps" || tuningFocusedField === "variant")) {
      const append = (ch: string) => {
        if (!printable(ch) || ch === " ") return
        if (tuningFocusedField === "steps") {
          if (/[0-9]/.test(ch)) {
            setTuningSteps(prev => (!tuningDirtyFields.has("steps") && tuningSummary.steps.mixed ? ch : prev + ch))
            markTuningDirty("steps")
          } else if (ch === "-" || ch === "_") adjustTuningSteps(-1)
          else if (ch === "+" || ch === "=") adjustTuningSteps(1)
        } else if (/^[a-zA-Z0-9._-]$/.test(ch)) {
          const lower = ch.toLowerCase()
          setTuningVariant(prev => (!tuningVariantTyping || (!tuningDirtyFields.has("variant") && tuningSummary.variant.mixed) ? lower : prev + lower))
          setTuningVariantTyping(true)
          markTuningDirty("variant")
        }
      }
      return { set: text => { for (const ch of text) append(ch) }, append, after: () => {} }
    }
    if (viewMode === "rename-prompt") {
      const append = (ch: string) => {
        if (!printable(ch)) return
        if (renameFocusedField === "family") setRenameFamily(prev => prev + ch)
        else if (renameFocusedField === "category") setRenameCategory(prev => prev + ch)
        else setRenameRole(prev => prev + ch)
      }
      return { set: text => { for (const ch of text) append(ch) }, append, after: () => {} }
    }
    return null
  }

  usePaste(event => {
    const target = resolvePasteTarget()
    if (!target || event.metadata?.kind === "binary" || event.bytes.length > MAX_PASTE_CHARS * 4) return
    const text = sanitizePasteText(new TextDecoder().decode(event.bytes))
    if (text.length > MAX_PASTE_CHARS) return
    target.set(text)
    target.after()
    event.preventDefault()
  })

  // Keyboard navigation and actions
  useKeyboard((e) => {
    const key = e.name.toLowerCase()
    const rawChar = /^[\x20-\x7E]$/.test(e.sequence)
      ? e.sequence
      : e.shift
        ? e.name.toUpperCase()
        : e.name
    const pasteStep = consumePasteSequence(e.sequence ?? "", pasteRef.current)
    pasteRef.current = pasteStep.buffer
    if (pasteStep.outcome.kind !== "pass") {
      if (pasteStep.outcome.kind === "commit") {
        const target = resolvePasteTarget()
        if (target) {
          target.set(sanitizePasteText(pasteStep.outcome.text))
          target.after()
        }
      } else if (pasteStep.outcome.kind === "hold" && pasteStep.outcome.prefix) {
        const target = resolvePasteTarget()
        if (target) {
          target.set(sanitizePasteText(pasteStep.outcome.prefix))
          target.after()
        }
      }
      return
    }
    const isUppercaseF = key === "f" && (e.sequence === "F" || !!e.shift)
    const isUppercaseL = key === "l" && (e.sequence === "L" || !!e.shift)
    const isUppercaseU = key === "u" && (e.sequence === "U" || !!e.shift)

    // Global Ctrl+K / Ctrl+P / Cmd+K toggles Command Palette; Ctrl+E toggles motion
    if ((e.ctrl || e.meta) && (key === "k" || key === "p")) {
      if (viewMode === "command-palette") setViewMode("main")
      else openCommandPalette()
      return
    }
    if (e.ctrl && key === "e") {
      toggleReducedMotion()
      return
    }
    if (viewMode === "self-update") {
      if (key === "escape" || key === "n") {
        if (!selfUpdateBusy) setViewMode("main")
      } else if (key === "r" && !selfUpdateBusy) {
        runSelfUpdateCheck()
      } else if ((key === "y" || key === "enter" || key === "return") && !selfUpdateBusy && selfUpdateCheck?.updateAvailable && !selfUpdateCheck.localGitDirty) {
        runSelfUpdateApply(false)
      } else if (key === "f" && !selfUpdateBusy && selfUpdateCheck && (selfUpdateCheck.updateAvailable || selfUpdateCheck.downgrade || selfUpdateCheck.localGitDirty)) {
        runSelfUpdateApply(true)
      }
      return
    }

    if (viewMode === "maintenance") {
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "1") {
        setMaintenanceTab("validate")
        setMaintenanceScrollOffset(0)
      } else if (key === "2") {
        setMaintenanceTab("lint")
        setMaintenanceScrollOffset(0)
      } else if (key === "3") {
        setMaintenanceTab("audit")
        setMaintenanceScrollOffset(0)
      } else if (key === "up" || key === "k") {
        setMaintenanceScrollOffset(off => Math.max(0, off - 1))
      } else if (key === "down" || key === "j") {
        setMaintenanceScrollOffset(off => off + 1)
      } else if (key === "r") {
        refreshMaintenanceReports()
        pushToast("✓ Maintenance reports refreshed")
      } else if ((key === "enter" || key === "return") && maintenanceTab === "lint" && maintenanceFixPlan.length > 0 && !isReadOnlyGitSource) {
        applyMaintenanceFixNames()
      }
      return
    }

    if (viewMode === "codex-install-confirm") {
      if (key === "escape" || key === "n") {
        setCodexInstallPreview(null)
        setViewMode("main")
      } else if ((key === "y" || key === "enter" || key === "return") && !isAsyncBusy) {
        applyCodexInstallAction()
      }
      return
    }

    if (viewMode === "command-palette") {
      const clampPaletteScroll = (nextIndex: number, total: number) => {
        setPaletteScrollOffset(offset => {
          if (total <= 0) return 0
          if (nextIndex < offset) return Math.max(0, nextIndex)
          if (nextIndex >= offset + maxPaletteRows) return Math.max(0, nextIndex - maxPaletteRows + 1)
          return Math.min(offset, Math.max(0, total - maxPaletteRows))
        })
      }
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "up" || key === "down") {
        if (!filteredPaletteCommands.length) return
        const delta = key === "up" ? -1 : 1
        const next = (paletteFocusIndex + delta + filteredPaletteCommands.length) % filteredPaletteCommands.length
        setPaletteFocusIndex(next)
        clampPaletteScroll(next, filteredPaletteCommands.length)
      } else if (key === "pageup" || key === "pagedown") {
        if (!filteredPaletteCommands.length) return
        const delta = key === "pageup" ? -maxPaletteRows : maxPaletteRows
        const next = Math.max(0, Math.min(filteredPaletteCommands.length - 1, paletteFocusIndex + delta))
        setPaletteFocusIndex(next)
        clampPaletteScroll(next, filteredPaletteCommands.length)
      } else if (key === "backspace") {
        setPaletteQuery(q => q.slice(0, -1))
        setPaletteFocusIndex(0)
        setPaletteScrollOffset(0)
      } else if (key === "enter" || key === "return") {
        const chosen = filteredPaletteCommands[paletteFocusIndex]
        if (chosen) executeActionById(chosen.id)
      } else if (!e.ctrl && !e.meta && /^[\x20-\x7E]$/.test(rawChar)) {
        setPaletteQuery(q => q + rawChar)
        setPaletteFocusIndex(0)
        setPaletteScrollOffset(0)
      }
      return
    }

    if (viewMode === "help") {
      const vpRows = calculateHelpViewport(termWidth, termHeight).viewportRows
      const totalItems = helpContent.items.length
      const numericTab = /^[1-9]$/.test(key) ? helpTabByNumber(Number(key)) : null

      if (key === "escape" || rawChar === "?" || key === "q") {
        setViewMode("main")
      } else if (numericTab) {
        selectHelpTab(numericTab)
      } else if (key === "tab") {
        selectHelpTab(cycleHelpTab(helpTab, e.shift ? -1 : 1))
      } else if (key === "left" || key === "h") {
        selectHelpTab(cycleHelpTab(helpTab, -1))
      } else if (key === "right" || (key === "l" && !isUppercaseL)) {
        selectHelpTab(cycleHelpTab(helpTab, 1))
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        if (!totalItems) return
        const delta = key === "up" || key === "k" ? -1 : 1
        const next = (helpFocusIndex + delta + totalItems) % totalItems
        setHelpFocusIndex(next)
        setHelpScrollOffset(off => clampHelpScroll(next, helpContent.rows, off, vpRows))
      } else if (key === "pageup" || key === "pagedown") {
        if (!totalItems) return
        const jump = Math.max(2, vpRows - 2)
        const delta = key === "pageup" ? -jump : jump
        const next = Math.max(0, Math.min(totalItems - 1, helpFocusIndex + delta))
        setHelpFocusIndex(next)
        setHelpScrollOffset(off => clampHelpScroll(next, helpContent.rows, off, vpRows))
      } else if (key === "home") {
        setHelpFocusIndex(0)
        setHelpScrollOffset(0)
      } else if (key === "end") {
        if (!totalItems) return
        const last = totalItems - 1
        setHelpFocusIndex(last)
        setHelpScrollOffset(off => clampHelpScroll(last, helpContent.rows, off, vpRows))
      } else if (key === "enter" || key === "return") {
        const chosen = helpContent.items[helpFocusIndex]
        if (chosen) activateHelpItem(chosen)
      }
      return
    }

    // 1. Intercept search input mode
    if (isSearching && viewMode === "main" && workspaceTab === "catalog") {
      if (e.shift && key === "left") {
        setIsSearching(false)
        setActivePane("list")
      } else if (e.shift && key === "right") {
        setIsSearching(false)
        if (layout.showInspector) setActivePane("inspector")
      } else if (key === "escape") {
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
             const revision = saveUiConfig(engineConfigDir(), layoutDraft, uiConfigRevisionState, { reducedMotion: reducedMotionState })
             setUiConfigRevision(revision)
            setLayoutSnapshot(layoutDraft); setAppliedShare(layoutDraft); setLayoutError(""); setLayoutStatus("✓ Layout proportions saved")
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

    if (viewMode === "main" && workspaceTab === "target") {
      const totalRows = targetWorkspaceRows.length
      const page = Math.max(4, wsViewports.sourcesRows - 3)
      const clampTargetScroll = (nextIndex: number) => {
        setTargetScrollOffset(offset => clampListScroll(nextIndex, totalRows, offset, page))
      }
      if (key === "tab" && !e.shift) {
        setWorkspaceTab("flows")
        return
      }
      if (key === "backtab" || (key === "tab" && e.shift)) {
        const order: TargetSubTab[] = ["installed", "bridges", "backups"]
        const next = order[(order.indexOf(targetSubTab) + 1) % order.length]!
        setTargetSubTab(next)
        setTargetFocusIndex(0)
        setTargetScrollOffset(0)
        setTargetInspectorScroll(0)
        return
      }
      if (key === "?" || (e.shift && key === "/")) {
        openHelpGuide()
        return
      }
      if ((e.shift && key === "left") || key === "[") {
        setActivePane("list")
        return
      }
      if ((e.shift && key === "right") || key === "]") {
        if (layout.showInspector) setActivePane("inspector")
        return
      }
      if (key === "r" && e.ctrl) {
        refreshTargetStatus()
        pushToast("✓ Refreshed target status & backups")
        return
      }
      if (key === "1") {
        setTargetSubTab("installed")
        setTargetFocusIndex(0)
        setTargetScrollOffset(0)
        setTargetInspectorScroll(0)
      } else if (key === "2") {
        setTargetSubTab("bridges")
        setTargetFocusIndex(0)
        setTargetScrollOffset(0)
        setTargetInspectorScroll(0)
      } else if (key === "3") {
        setTargetSubTab("backups")
        setTargetFocusIndex(0)
        setTargetScrollOffset(0)
        setTargetInspectorScroll(0)
      } else if (key === "up" || (key === "k" && !e.shift)) {
        if (effectivePane === "inspector") {
          setTargetInspectorScroll(off => Math.max(0, off - 1))
        } else if (totalRows > 0) {
          const next = targetFocusIndex > 0 ? targetFocusIndex - 1 : totalRows - 1
          setTargetFocusIndex(next)
          setTargetInspectorScroll(0)
          clampTargetScroll(next)
        }
      } else if (key === "down" || key === "j") {
        if (effectivePane === "inspector") {
          setTargetInspectorScroll(off => off + 1)
        } else if (totalRows > 0) {
          const next = targetFocusIndex < totalRows - 1 ? targetFocusIndex + 1 : 0
          setTargetFocusIndex(next)
          setTargetInspectorScroll(0)
          clampTargetScroll(next)
        }
      } else if (key === "u") {
        executeActionById("target-update")
      } else if (key === "x") {
        executeActionById("target-uninstall")
      } else if (key === "r" && !e.shift) {
        runTargetReconcile()
      } else if (key === "r" && e.shift) {
        executeActionById("target-restore")
      } else if (key === "a" && e.shift) {
        previewTargetOp("reconcile", [], true)
      } else if (key === "e") {
        const row = targetWorkspaceRows[targetFocusIndex]
        if (row?.kind === "bridge-pack") previewInstall([row.packName])
        else if (row?.kind === "installed-pack") previewTargetOp("update", [row.packName])
      } else if (key === "k" && e.shift) {
        executeActionById("bridge-check")
      } else if (key === "b" && !e.shift) {
        openBridgeModalAction("claude")
      } else if (key === "b" && e.shift) {
        openBridgeModalAction("codex")
      } else if (key === "v" && e.shift) {
        openBridgeModalAction("vibe")
      } else if (key === "c") {
        executeActionById("codex-install")
      } else if (key === "o") {
        openSourcesModal()
      }
      return
    }

    if (viewMode === "main" && workspaceTab === "sources") {
      const visibleSourceBudget = wsViewports.sourcesRows
      const clampScroll = (nextIndex: number, total: number) => {
        setSourcesScrollOffset(offset => clampListScroll(nextIndex, total, offset, visibleSourceBudget))
      }
      if (key === "g" && e.ctrl) {
        runInteractiveGhLogin()
        return
      }
      if (sourcesInputFocused) {
        if (e.shift && key === "left") {
          setSourcesInputFocused(false)
          setActivePane("list")
        } else if (e.shift && key === "right") {
          setSourcesInputFocused(false)
          if (layout.showInspector) setActivePane("inspector")
        } else if (key === "escape") {
          setSourcesInputFocused(false)
        } else if (key === "up" || key === "down") {
          if (!sourceModalRows.length) return
          const delta = key === "up" ? -1 : 1
          const next = (sourcesFocusIndex + delta + sourceModalRows.length) % sourceModalRows.length
          setSourcesFocusIndex(next)
          clampScroll(next, sourceModalRows.length)
        } else if (key === "tab") {
          const suggestion = sourceModalRows.find(row => row.kind === "connect-input" && row.spec !== sourcesQuery.trim())
          if (suggestion?.kind === "connect-input") {
            setSourcesQuery(suggestion.spec)
            setSourcesFocusIndex(0)
            setSourcesScrollOffset(0)
          }
        } else if (key === "backspace") {
          setSourcesQuery(q => q.slice(0, -1))
          setSourcesFocusIndex(0)
          setSourcesScrollOffset(0)
        } else if (key === "enter" || key === "return") {
          activateSourceRowAtIndex(sourcesFocusIndex)
        } else if (!e.ctrl && !e.meta && /^[\x20-\x7E]$/.test(rawChar)) {
          setSourcesQuery(q => q + rawChar)
          setSourcesFocusIndex(0)
          setSourcesScrollOffset(0)
        }
        return
      }

      if (key === "tab" && !e.shift) {
        setWorkspaceTab("catalog")
        setViewMode("main")
      } else if (key === "backtab" || (key === "tab" && e.shift)) {
        if (layout.showInspector) setActivePane(prev => (prev === "inspector" ? "list" : "inspector"))
      } else if ((e.shift && key === "left") || rawChar === "[") {
        setActivePane("list")
      } else if ((e.shift && key === "right") || rawChar === "]") {
        if (layout.showInspector) setActivePane("inspector")
      } else if (rawChar === "?") {
        openHelpGuide("sources")
      } else if (key === "escape") {
        if (effectivePane === "inspector") {
          setActivePane("list")
        } else if (sourcesQuery) {
          setSourcesQuery("")
          setSourcesFocusIndex(0)
          setSourcesScrollOffset(0)
        } else if (activeDataSource) {
          setWorkspaceTab("catalog")
          setViewMode("main")
        } else {
          setSourcesStatus("Connect a GitHub repository or local folder first (or press Ctrl+C to quit).")
        }
      } else if (key === "/" || key === "a") {
        setActivePane("list")
        setSourcesInputFocused(true)
        setSourcesStatus("")
      } else if (key === "g") {
        runInteractiveGhLogin()
      } else if (isUppercaseU) {
        openSelfUpdateModal()
      } else if (key === "r" && !e.ctrl) {
        runTargetReconcile()
      } else if (effectivePane === "inspector" && (key === "up" || key === "k" || key === "down" || key === "j" || key === "pageup" || key === "pagedown")) {
        const installedCount = Object.keys(targetStatusInfo?.lock?.packs ?? {}).length
        const driftCount = targetStatusInfo?.drift?.length ?? 0
        const maxPackRows = calculateTargetInstalledPackRows(termHeight, {
          hasEngineLine: Boolean(engineVersionInfo?.displayVersion),
          driftCount,
        })
        const maxOff = Math.max(0, installedCount - maxPackRows)
        const step = key === "pageup" ? -maxPackRows : key === "pagedown" ? maxPackRows : key === "up" || key === "k" ? -1 : 1
        setSourcesInspectorScroll(off => Math.max(0, Math.min(maxOff, off + step)))
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        if (!sourceModalRows.length) return
        const delta = key === "up" || key === "k" ? -1 : 1
        const next = (sourcesFocusIndex + delta + sourceModalRows.length) % sourceModalRows.length
        setSourcesFocusIndex(next)
        clampScroll(next, sourceModalRows.length)
      } else if (key === "pageup" || key === "pagedown") {
        if (!sourceModalRows.length) return
        const delta = key === "pageup" ? -visibleSourceBudget : visibleSourceBudget
        const next = Math.max(0, Math.min(sourceModalRows.length - 1, sourcesFocusIndex + delta))
        setSourcesFocusIndex(next)
        clampScroll(next, sourceModalRows.length)
      } else if (key === "p") {
        pullSelectedOrActiveSource()
      } else if (key === "r" && e.ctrl) {
        refreshSourcesView(true)
        pushToast("✓ Refreshed sources & target status")
      } else if (key === "t") {
        toggleFocusedSourceTrust()
      } else if (key === "x" || key === "delete" || key === "backspace") {
        removeFocusedSource()
      } else if (key === "enter" || key === "return") {
        if (effectivePane === "inspector") runTargetReconcile()
        else activateSourceRowAtIndex(sourcesFocusIndex)
      }
      return
    }

    if (viewMode === "main" && workspaceTab === "flows") {
      const flowBudget = wsViewports.flowsRows
      const clampFlowScroll = (nextIndex: number, total: number) => {
        setFlowsScrollOffset(offset => clampListScroll(nextIndex, total, offset, flowBudget))
      }
      const currentFlowNavRow = flowsNav.rows[Math.max(0, Math.min(flowsFocusIndex, Math.max(0, flowsNav.rows.length - 1)))] ?? null
      const flowsInsp = buildFlowsInspectorItems(currentFlowNavRow, agents, packFlowsByCategory, flowsNav.agentByShortName)
      if (key === "tab" && !e.shift) {
        openSourcesModal()
        refreshSourcesView(true)
      } else if (key === "backtab" || (key === "tab" && e.shift)) {
        if (layout.showInspector) setActivePane(prev => (prev === "inspector" ? "list" : "inspector"))
      } else if ((e.shift && key === "left") || rawChar === "[") {
        setActivePane("list")
      } else if ((e.shift && key === "right") || rawChar === "]") {
        if (layout.showInspector) setActivePane("inspector")
      } else if (rawChar === "?") {
        openHelpGuide("flows")
      } else if (key === "escape") {
        if (effectivePane === "inspector") setActivePane("list")
        else setWorkspaceTab("catalog")
      } else if (key === "o") {
        openSourcesModal()
      } else if (isUppercaseU) {
        openSelfUpdateModal()
      } else if (key === "l" && isUppercaseL) {
        executeActionById("layout-adjust")
      } else if (effectivePane === "inspector" && (key === "up" || key === "k" || key === "down" || key === "j" || key === "pageup" || key === "pagedown")) {
        const total = flowsInsp.items.length
        if (!total) return
        const delta = key === "pageup" ? -4 : key === "pagedown" ? 4 : key === "up" || key === "k" ? -1 : 1
        const next = key === "pageup" || key === "pagedown"
          ? Math.max(0, Math.min(total - 1, flowsInspectorFocus + delta))
          : (flowsInspectorFocus + delta + total) % total
        setFlowsInspectorFocus(next)
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        if (!flowsNav.rows.length) return
        const delta = key === "up" || key === "k" ? -1 : 1
        const next = (flowsFocusIndex + delta + flowsNav.rows.length) % flowsNav.rows.length
        setFlowsFocusIndex(next)
        clampFlowScroll(next, flowsNav.rows.length)
      } else if (key === "pageup" || key === "pagedown") {
        if (!flowsNav.rows.length) return
        const delta = key === "pageup" ? -flowBudget : flowBudget
        const next = Math.max(0, Math.min(flowsNav.rows.length - 1, flowsFocusIndex + delta))
        setFlowsFocusIndex(next)
        clampFlowScroll(next, flowsNav.rows.length)
      } else if (key === "m") {
        executeActionById("pack-flows")
      } else if (key === "g") {
        executeActionById("agent-delegations")
      } else if (key === "b" && !e.shift) {
        openBridgeModalAction("claude")
      } else if (key === "b" && e.shift) {
        openBridgeModalAction("codex")
      } else if (key === "v" && e.shift) {
        openBridgeModalAction("vibe")
      } else if (key === "e") {
        executeActionById("pack-install")
      } else if (key === "i" && isWorkspaceVirtualPack) {
        openInitPackModal()
      } else if (key === "d" && !isWorkspaceVirtualPack && !isReadOnlyGitSource) {
        openPackDoctorModal("doctor")
      } else if (key === "n" && !isWorkspaceVirtualPack && !isReadOnlyGitSource) {
        openPackDoctorModal("scaffold")
      } else if (key === "enter" || key === "return") {
        if (effectivePane === "inspector") {
          const item = flowsInsp.items[Math.max(0, Math.min(flowsInspectorFocus, Math.max(0, flowsInsp.items.length - 1)))]
          if (item?.kind === "flow") {
            openPackFlowsModal(item.pack, item.flowIndex)
          } else if (item?.kind === "subagent" && item.targetAgent) {
            setActivePane("list")
            jumpToCatalogAgent(item.targetAgent.currentPath)
          }
        } else {
          executeActionById("flow-jump")
        }
      }
      return
    }

    // 2. Main Catalog view mode
    if (viewMode === "main") {
      if (key === "tab" && !e.shift) {
        refreshTargetStatus()
        setWorkspaceTab("target")
      } else if (key === "backtab" || (key === "tab" && e.shift)) {
        if (currentItem?.type === "file" && currentItem.agent) {
          const idx = INSPECTOR_TABS.indexOf(inspectorTab)
          const nextTab = INSPECTOR_TABS[(idx + 1) % INSPECTOR_TABS.length]!
          setInspectorTab(nextTab)
          if (nextTab === "security" || nextTab === "delegations") setGraphScrollOffset(0)
          if (nextTab === "resources") setResourceScrollIndex(0)
        } else if (layout.showInspector) {
          setActivePane(prev => (prev === "inspector" ? "list" : "inspector"))
        }
      } else if ((e.shift && key === "left") || rawChar === "[") {
        setActivePane("list")
      } else if ((e.shift && key === "right") || rawChar === "]") {
        if (layout.showInspector) setActivePane("inspector")
      } else if (key === "escape" && effectivePane === "inspector") {
        setActivePane("list")
      } else if (key === "escape" && selectedPacks.length > 0) {
        setSelectedPackNames(new Set())
      } else if (rawChar === "?") {
        openHelpGuide("catalog")
      } else if (key === "o") {
        openSourcesModal()
      } else if (isUppercaseU) {
        openSelfUpdateModal()
      } else if (key === "l" && isUppercaseL) {
        if (!isSearching) executeActionById("layout-adjust")
      } else if (effectivePane === "inspector" && (key === "left" || key === "h") && !e.shift) {
        const idx = INSPECTOR_TABS.indexOf(inspectorTab)
        const nextTab = INSPECTOR_TABS[(idx - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length]!
        setInspectorTab(nextTab)
        if (nextTab === "security" || nextTab === "delegations") setGraphScrollOffset(0)
        if (nextTab === "resources") setResourceScrollIndex(0)
      } else if (effectivePane === "inspector" && (key === "right" || (key === "l" && !isUppercaseL)) && !e.shift) {
        const idx = INSPECTOR_TABS.indexOf(inspectorTab)
        const nextTab = INSPECTOR_TABS[(idx + 1) % INSPECTOR_TABS.length]!
        setInspectorTab(nextTab)
        if (nextTab === "security" || nextTab === "delegations") setGraphScrollOffset(0)
        if (nextTab === "resources") setResourceScrollIndex(0)
      } else if ((key === "up" || key === "k") && effectivePane === "inspector" && inspectorTab === "overview" && currentItem) {
        setOverviewScrollOffset(offset => Math.max(0, offset - 1))
      } else if ((key === "down" || key === "j") && effectivePane === "inspector" && inspectorTab === "overview" && currentItem) {
        if (currentItem.type === "file" && currentItem.agent) {
          const mdText = currentItem.agent.description || "No description provided."
          const total = layoutMarkdownDocument(mdText, Math.max(16, panelWidths.inspector - 8)).length
          const page = Math.max(2, maxVisibleItems - 7)
          setOverviewScrollOffset(offset => Math.min(Math.max(0, total - page), offset + 1))
        } else {
          setOverviewScrollOffset(offset => offset + 1)
        }
      } else if ((key === "up" || key === "k") && effectivePane === "inspector" && inspectorTab === "prompt" && currentItem?.agent) {
        setPromptScrollOffset(offset => Math.max(0, offset - 1))
      } else if ((key === "down" || key === "j") && effectivePane === "inspector" && inspectorTab === "prompt" && currentItem?.agent) {
        const body = extractFrontmatter(currentItem.agent.rawContent).body.trim() || "*Empty system prompt body.*"
        const total = layoutMarkdownDocument(body, Math.max(16, panelWidths.inspector - 8)).length
        const page = Math.max(1, wsViewports.promptRows - 1)
        setPromptScrollOffset(offset => Math.min(Math.max(0, total - page), offset + 1))
      } else if ((key === "up" || key === "k") && effectivePane === "inspector" && inspectorTab === "delegations" && currentItem?.agent) {
        const allowed = currentItem.agent.allowedSubagents || []
        if (allowed.length > 0) {
          const next = (catalogDelFocus - 1 + allowed.length) % allowed.length
          setCatalogDelFocus(next)
          setGraphScrollOffset(off => clampListScroll(next, allowed.length, off, wsViewports.delegationsInspectorRows))
        }
      } else if ((key === "down" || key === "j") && effectivePane === "inspector" && inspectorTab === "delegations" && currentItem?.agent) {
        const allowed = currentItem.agent.allowedSubagents || []
        if (allowed.length > 0) {
          const next = (catalogDelFocus + 1) % allowed.length
          setCatalogDelFocus(next)
          setGraphScrollOffset(off => clampListScroll(next, allowed.length, off, wsViewports.delegationsInspectorRows))
        }
      } else if ((key === "up" || key === "k") && effectivePane === "inspector" && inspectorTab === "security" && currentItem?.agent) {
        setGraphScrollOffset((offset) => Math.max(0, offset - 1))
      } else if ((key === "up" || key === "k") && effectivePane === "inspector" && inspectorTab === "resources" && activeItems[focusedIndex]?.agent) {
        setResourceScrollIndex((offset) => Math.max(0, offset - 1))
      } else if ((key === "down" || key === "j") && effectivePane === "inspector" && inspectorTab === "security" && currentItem?.agent) {
        const hasErr = analyzePermissionOrder(currentItem.agent).hasOrderError
        const secViewport = calculateWorkspaceViewports(termHeight, { hasSecurityOrderError: hasErr })
        const pageSize = secViewport.securityRows
        const itemCount = Object.keys(currentItem.agent.frontmatter.permission || {}).filter((k) => k !== "task").length
        setGraphScrollOffset((offset) => Math.min(Math.max(0, itemCount - pageSize), offset + 1))
      } else if ((key === "down" || key === "j") && effectivePane === "inspector" && inspectorTab === "resources" && activeItems[focusedIndex]?.agent) {
        setResourceScrollIndex((offset) => Math.min(Math.max(0, resourceInspectorLines.length - wsViewports.resourcesInspectorRows), offset + 1))
      } else if (key === "up" || (key === "k" && !e.shift)) {
        if (activeItems.length === 0) return
        const next = focusedIndex > 0 ? focusedIndex - 1 : activeItems.length - 1
        setFocusedIndex(next)
        updateScroll(next)
      } else if (key === "down" || key === "j") {
        if (activeItems.length === 0) return
        const next = focusedIndex < activeItems.length - 1 ? focusedIndex + 1 : 0
        setFocusedIndex(next)
        updateScroll(next)
      } else if (key === "enter" || key === "return") {
        if (effectivePane === "inspector" && inspectorTab === "delegations" && currentItem?.agent) {
          const allowed = currentItem.agent.allowedSubagents || []
          const targetName = allowed[catalogDelFocus]
          const targetAg = targetName ? agents.find(a => agentId(a) === targetName) : undefined
          if (targetAg) {
            setActivePane("list")
            jumpToCatalogAgent(targetAg.currentPath)
          }
          return
        }
        const item = activeItems[focusedIndex]
        if (item?.type === "folder" || item?.type === "section") toggleFolderAtFocused()
        else if (item?.type === "file") openModelOrFlowsAction()
      } else if (key === "left" || key === "h") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "folder" && expandedCategories.has(item.id)) {
            setExpandedCategories((prev) => {
              const next = new Set(prev)
              next.delete(item.id)
              return next
            })
          } else if (item.type === "section" && expandedSections.has(item.id)) {
            setExpandedSections(prev => {
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
          } else if (item.type === "section" && !expandedSections.has(item.id)) {
            setExpandedSections(prev => {
              const next = new Set(prev)
              next.add(item.id)
              return next
            })
          }
        }
      } else if (key === "space") {
        executeActionById("select-toggle")
      } else if (key === "a" && e.ctrl) {
        executeActionById("select-all-packs")
      } else if (key === "a") {
        executeActionById("select-category")
      } else if (key === "s") {
        executeActionById("select-same-model")
      } else if (key === "/") {
        setIsSearching(true)
      } else if (key === "i" && isWorkspaceVirtualPack) {
        openInitPackModal()
      } else if (key === "d" && !isWorkspaceVirtualPack && !isReadOnlyGitSource) {
        openPackDoctorModal("doctor")
      } else if (key === "n" && !isWorkspaceVirtualPack && !isReadOnlyGitSource) {
        openPackDoctorModal("scaffold")
      } else if (key === "m") {
        openModelOrFlowsAction()
      } else if (key === "v") {
        executeActionById("repair-models")
      } else if (key === "t" && e.shift) {
        executeActionById("agent-tier")
      } else if (key === "b" && !e.shift) {
        openBridgeModalAction("claude")
      } else if (key === "b" && e.shift) {
        openBridgeModalAction("codex")
      } else if (key === "v" && e.shift) {
        openBridgeModalAction("vibe")
      } else if (key === "e") {
        executeActionById("pack-install")
      } else if (key === "f" && !isUppercaseF) {
        cycleAssetFilter()
      } else if (key === "w") {
        openMaintenanceModal("validate")
      } else if (key === "k" && e.shift) {
        executeActionById("bridge-check")
      } else if (key === "c") {
        if (activeItems[focusedIndex]?.type === "file") executeActionById("agent-color")
        else executeActionById("codex-install")
      } else if (key === "r") {
        executeActionById("agent-rename")
      } else if (key === "p") {
        executeActionById("agent-permissions")
      } else if (key === "g") {
        executeActionById("agent-delegations")
      } else if (key === "u") {
        executeActionById("agent-resources")
      } else if (key === "t") {
        openTuningModalAction()
      } else if (/^[1-8]$/.test(key)) {
        if (effectivePane === "inspector" && currentItem?.type === "file" && currentItem.agent && /^[1-6]$/.test(key)) {
          if (key === "1") setInspectorTab("overview")
          else if (key === "2") setInspectorTab("prompt")
          else if (key === "3") setInspectorTab("naming")
          else if (key === "4") { setInspectorTab("security"); setGraphScrollOffset(0) }
          else if (key === "5") { setInspectorTab("delegations"); setGraphScrollOffset(0) }
          else if (key === "6") { setInspectorTab("resources"); setResourceScrollIndex(0) }
        } else {
          const matchedFilter = ASSET_TYPE_FILTERS.find(f => f.shortcut === key)
          if (matchedFilter) setAssetFilter(matchedFilter.key)
        }
      } else if (key === "pageup" && inspectorTab === "prompt" && currentItem?.agent) {
        const page = Math.max(1, wsViewports.promptRows - 1)
        setPromptScrollOffset(offset => Math.max(0, offset - page))
      } else if (key === "pagedown" && inspectorTab === "prompt" && currentItem?.agent) {
        const body = extractFrontmatter(currentItem.agent.rawContent).body.trim() || "*Empty system prompt body.*"
        const total = layoutMarkdownDocument(body, Math.max(16, panelWidths.inspector - 8)).length
        const page = Math.max(1, wsViewports.promptRows - 1)
        setPromptScrollOffset(offset => Math.min(Math.max(0, total - page), offset + page))
      } else if (key === "pageup" && inspectorTab === "resources") {
        setResourceScrollIndex(offset => Math.max(0, offset - resourceInspectorPageSize))
      } else if (key === "pagedown" && inspectorTab === "resources") {
        setResourceScrollIndex(offset => Math.min(Math.max(0, resourceInspectorLines.length - resourceInspectorPageSize), offset + resourceInspectorPageSize))
      } else if ((key === "pageup" || key === "pagedown") && (inspectorTab === "security" || inspectorTab === "delegations")) {
        const ag = activeItems[focusedIndex]?.agent
        const hasErr = Boolean(ag && inspectorTab === "security" && analyzePermissionOrder(ag).hasOrderError)
        const secViewport = calculateWorkspaceViewports(termHeight, { hasSecurityOrderError: hasErr })
        const graphPageSize = inspectorTab === "security" ? secViewport.securityRows : secViewport.delegationsInspectorRows
        setGraphScrollOffset((offset) => {
          const graphTotal = inspectorTab === "security"
            ? Object.entries(ag?.frontmatter.permission || {}).filter(([k]) => k !== "task").length
            : ag?.allowedSubagents?.length || 0
          const delta = key === "pageup" ? -graphPageSize : graphPageSize
          return Math.max(0, Math.min(Math.max(0, graphTotal - graphPageSize), offset + delta))
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
            const unpin = selectedModel === INHERIT
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
              if (!unpin && !modelCatalog.models.includes(selectedModel)) throw new Error("Model is not present in refreshed catalog")
              if (isReadOnlyGitSource) {
                void (async () => {
                  try {
                    overrideAgentsModel(workspaceRoot, selectedAgents, unpin ? "" : selectedModel, modelCatalog.models, undefined, unpin)
                    refreshData()
                    setSelectedAgentPaths(new Set())
                    const outcome = await reconcileTargetIfInstalled("override")
                    setActionResultTitle("Model Updated Successfully")
                    setActionResultLines(unpin
                      ? [
                          `Successfully unpinned model on ${selectedAgents.length} agents.`,
                          "",
                          ...formatReconcileLines(outcome),
                        ]
                      : [
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
              const tx = mutate(selectedAgents.map(a => a.currentPath), "tune", () => updateAgentsModel(selectedAgents, unpin ? "" : selectedModel, modelCatalog.models, undefined, unpin))
              try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
              setSelectedAgentPaths(new Set())
              setMutationSuccess("Model Updated Successfully", unpin
                ? [`Successfully unpinned model on ${selectedAgents.length} agents.`]
                : [`Successfully set model:`, `  ${selectedModel}`, `on ${selectedAgents.length} agents.`], tx.warning)
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
        setTierScrollOffset(offset => clampListScroll(next, tiers.length, offset, maxVisibleTiers))
      } else if (key === "pageup" || key === "pagedown") {
        const delta = key === "pageup" ? -maxVisibleTiers : maxVisibleTiers
        const next = Math.max(0, Math.min(Math.max(0, tiers.length - 1), focusedTierIndex + delta))
        setFocusedTierIndex(next)
        setTierScrollOffset(offset => clampListScroll(next, tiers.length, offset, maxVisibleTiers))
      } else if (key === "enter" || key === "return") {
        const chosenTier = tiers[focusedTierIndex]
        if (!chosenTier || !translationConfig) return
        try {
          const roles: Set<string> = new Set(targetAgents.map(agent => resolveRole(agent, translationConfig)))
          const impacted = agents.filter(agent => !targetAgents.some(target => target.currentPath === agent.currentPath) && roles.has(resolveRole(agent, translationConfig)))
          const nextConfig = { ...translationConfig, roles: { ...translationConfig.roles } }
          roles.forEach(role => { nextConfig.roles[role] = chosenTier })
          let txWarning: TransactionWarning | undefined
          if (bridgeStorageKey) {
            const loc = sourceTranslationConfigLocation(bridgeStorageKey, workspaceRoot)
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
      // 6. Bridge to Claude Code / Codex modal with inline tier management & live mapping
      const isNativeInputField =
        bridgeFocusedField === "name" ||
        bridgeFocusedField === "pack" ||
        bridgeFocusedField === "model" ||
        (bridgeTarget === "codex" && bridgeFocusedField === "tiers")

      if (key === "escape") {
        setBridgeClaudeTierTyping(false)
        setViewMode("main")
      } else if (e.ctrl && key === "s") {
        saveBridgeTiersOnly()
      } else if ((key === "enter" || key === "return") && !isNativeInputField) {
        generateBridge()
      } else if (key === "tab") {
        setBridgeClaudeTierTyping(false)
        setBridgeFocusedField(prev => stepBridgeField(prev, Boolean(e.shift), bridgeTarget))
      } else if (key === "up" || key === "down") {
        const delta: 1 | -1 = key === "down" ? 1 : -1
        setBridgeClaudeTierTyping(false)
        if (bridgeFocusedField === "pack" && filteredBridgePacks.length > 0) {
          const next = stepBridgePackSelection(
            filteredBridgePacks,
            bridgePackIndex,
            delta,
            bridgePackScrollOffset,
            bridgePackViewportRows,
          )
          setBridgePackIndex(next.index)
          setBridgePackScrollOffset(next.scrollOffset)
          setBridgeSelectedPack(next.selectedPack)
          setBridgeAgentIndex(0)
          setBridgeAgentScrollOffset(0)
        } else if ((bridgeFocusedField === "tiers" || bridgeFocusedField === "effort") && bridgeTierNames.length > 0) {
          const nextIndex = (bridgeTierIndex + delta + bridgeTierNames.length) % bridgeTierNames.length
          setBridgeTierIndex(nextIndex)
          setBridgeTierScrollOffset(off => clampListScroll(nextIndex, bridgeTierNames.length, off, bridgeModalLayout.tierViewportRows))
        } else if (bridgeFocusedField === "agents" && bridgePreview.items.length > 0) {
          const nextIndex = (bridgeAgentIndex + delta + bridgePreview.items.length) % bridgePreview.items.length
          setBridgeAgentIndex(nextIndex)
          setBridgeAgentScrollOffset(off => clampListScroll(nextIndex, bridgePreview.items.length, off, bridgeModalLayout.agentViewportRows))
        } else {
          setBridgeFocusedField(prev => stepBridgeField(prev, key === "up", bridgeTarget))
        }
      } else if (key === "left" || key === "right" || (key === "space" && !isNativeInputField)) {
        const delta: 1 | -1 = key === "left" ? -1 : 1
        if (bridgeFocusedField === "tiers" && bridgeTarget !== "codex" && bridgeTierNames.length > 0) {
          const tierName = bridgeTierNames[bridgeTierIndex]
          const currentModel = bridgeDraftTiers[tierName]?.[bridgeTarget]?.model ?? (bridgeTarget === "vibe" ? "mistral-medium-3.5" : "sonnet")
          setBridgeClaudeTierTyping(false)
          updateBridgeTierModel(tierName, cyclePresetValue(bridgeTarget === "vibe" ? VIBE_TIER_MODEL_PRESETS : CLAUDE_TIER_MODEL_PRESETS, currentModel, delta))
        } else if (bridgeFocusedField === "effort" && bridgeTarget === "codex" && bridgeTierNames.length > 0) {
          const tierName = bridgeTierNames[bridgeTierIndex]
          const currentEffort = bridgeDraftTiers[tierName]?.codex.reasoningEffort || "high"
          updateBridgeTierEffort(tierName, cyclePresetValue(CODEX_EFFORT_PRESETS, currentEffort, delta))
        } else if (bridgeFocusedField === "agents" && bridgePreview.items.length > 0) {
          cycleBridgeAgentTierAt(bridgeAgentIndex, delta)
        }
      } else if (bridgeFocusedField === "tiers" && bridgeTarget !== "codex" && bridgeTierNames.length > 0) {
        const tierName = bridgeTierNames[bridgeTierIndex]
        const currentModel = bridgeDraftTiers[tierName]?.[bridgeTarget]?.model ?? ""
        if (key === "backspace" || key === "delete") {
          setBridgeClaudeTierTyping(true)
          updateBridgeTierModel(tierName, currentModel.slice(0, -1))
        } else if (rawChar && /^[a-zA-Z0-9._-]$/.test(rawChar) && !e.ctrl && !e.meta) {
          const base = bridgeClaudeTierTyping ? currentModel : ""
          setBridgeClaudeTierTyping(true)
          updateBridgeTierModel(tierName, `${base}${rawChar.toLowerCase()}`)
        }
      }
    } else if (viewMode === "bridge-confirm") {
      if (key === "y" || key === "enter" || key === "return") {
        generateBridge(true)
      } else if (key === "n" || key === "escape") {
        setBridgeConfirmReasons([])
        setViewMode("bridge-prompt")
      }
    } else if (viewMode === "install-confirm") {
      if ((key === "y" || key === "enter" || key === "return") && installPreview && !installPreview.blocked) {
        applyInstall(installPreview)
      } else if (key === "n" || key === "escape" || ((key === "enter" || key === "return") && installPreview?.blocked)) {
        setViewMode("main")
      }
    } else if (viewMode === "routing-configs") {
      const flows = routingView?.flows ?? []
      const mcpRows = packMcpServers
      const rows = flows.length + 1 + mcpRows.length
      const focusedMcpIndex = routingFocus - flows.length - 1
      const focusedMcp = focusedMcpIndex >= 0 && focusedMcpIndex < mcpRows.length ? mcpRows[focusedMcpIndex] : null
      const modalLayout = calculatePackFlowsModalLayout(termWidth, termHeight, {
        hasPinned: Boolean(routingView?.pinned.length),
        hasStatus: Boolean(routingStatus),
      })
      const focusedFlow = flows[routingFocus]
      if (key === "escape") {
        setRoutingArchetype(null)
        setViewMode("main")
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        const next = (routingFocus + (key === "up" || key === "k" ? -1 : 1) + rows) % rows
        setRoutingFocus(next)
        setRoutingScroll(offset => clampListScroll(next, rows, offset, modalLayout.configViewportRows))
        setRoutingConfirmDelete(false)
      } else if ((key === "t" || ((key === "enter" || key === "return" || key === "space") && focusedMcp)) && focusedMcp) {
        togglePackMcpServer(focusedMcp.name)
      } else if (key === "c" && routingView) {
        openRoutingCallersModal()
      } else if (key === "w" && routingView && !isReadOnlyGitSource && routingView.hasManifest) {
        exportRoutingToManifest()
      } else if (key === "i" && routingView && !isReadOnlyGitSource && !routingView.hasManifest) {
        openInitPackModal()
      } else if ((key === "enter" || key === "return") && routingView) {
        openRoutingBranchAtIndex(routingFocus)
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
      const callerViewportRows = calculatePackFlowsModalLayout(termWidth, termHeight, {
        hasStatus: Boolean(routingStatus),
      }).subviewViewportRows
      if (key === "escape") {
        setRoutingConfirmDelete(false)
        setViewMode("routing-configs")
      } else if ((key === "up" || key === "k" || key === "down" || key === "j") && candidates.length > 0) {
        const next = (callerFocus + (key === "up" || key === "k" ? -1 : 1) + candidates.length) % candidates.length
        setCallerFocus(next)
        setCallerScroll(offset => clampListScroll(next, candidates.length, offset, callerViewportRows))
      } else if (key === "space" && candidates[callerFocus]) {
        const name = candidates[callerFocus].name
        setCallerDraftSet(prev => {
          const next = new Set(prev)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          return next
        })
      } else if (key === "r" && routingArchetype) {
        resetCallersToDefaultsAction()
      } else if ((key === "enter" || key === "return") && routingArchetype) {
        saveCallersDraftAction()
      }
    } else if (viewMode === "routing-editor") {
      const related = routingView?.related ?? []
      const rows = related.length + 4
      const hasStaticDenyWarn = Boolean(
        routingDraft &&
          routingView &&
          (Object.entries(routingDraft.tools).some(([k, v]) => v === "allow" && (routingView.staticDeniedTools.has(k) || routingView.staticDeniedTools.has("*"))) ||
            Object.entries(routingDraft.delegations).some(([k, v]) => v === "allow" && (routingView.staticDeniedDelegations.has(k) || routingView.staticDeniedDelegations.has("*")))),
      )
      const editorViewportRows = calculatePackFlowsModalLayout(termWidth, termHeight, {
        hasPinned: Boolean(routingView?.pinned.length),
        hasStaticWarn: hasStaticDenyWarn,
        hasStatus: Boolean(routingStatus),
      }).editorViewportRows
      const focusedAgent = routingEditorFocus > 0 && routingEditorFocus <= related.length ? related[routingEditorFocus - 1] : undefined
      const targets = routingSelected.size > 0 ? related.filter(agent => routingSelected.has(agent.role)).map(agent => agent.role) : focusedAgent ? [focusedAgent.role] : []
      if (!routingDraft) {
        setViewMode("routing-configs")
      } else if (key === "escape") {
        if (routingSelected.size > 0) { setRoutingSelected(new Set()); return }
        setRoutingConfirmDelete(false)
        setRoutingDraft(null)
        setViewMode("routing-configs")
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        const next = (routingEditorFocus + (key === "up" || key === "k" ? -1 : 1) + rows) % rows
        setRoutingEditorFocus(next)
        setRoutingEditorScroll(offset => clampListScroll(next, rows, offset, editorViewportRows))
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
        activateRoutingEditorRow(routingEditorFocus, key === "m")
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
      const toolRows = [{ key: "*" }, ...(routingView?.availableTools ?? [])]
      const visibleCount = calculatePackFlowsModalLayout(termWidth, termHeight, { hasStatus: Boolean(routingStatus) }).subviewViewportRows
      if (!routingDraft || key === "escape" || key === "enter" || key === "return") {
        setViewMode("routing-editor")
      } else if ((key === "up" || key === "k" || key === "down" || key === "j") && toolRows.length > 0) {
        const next = (flowSubFocus + (key === "up" || key === "k" ? -1 : 1) + toolRows.length) % toolRows.length
        setFlowSubFocus(next)
        setFlowSubScroll(offset => clampListScroll(next, toolRows.length, offset, visibleCount))
      } else if ((key === "space" || key === "left" || key === "right") && toolRows[flowSubFocus]) {
        cycleRoutingSubPolicyAt(flowSubFocus, key === "left" ? -1 : 1)
      } else if ((key === "backspace" || key === "delete") && toolRows[flowSubFocus]) {
        const tools = { ...routingDraft.tools }
        delete tools[toolRows[flowSubFocus].key]
        applyRoutingDraft({ ...routingDraft, tools })
      }
    } else if (viewMode === "routing-permissions") {
      const visiblePermCount = calculatePackFlowsModalLayout(termWidth, termHeight, { hasStatus: Boolean(routingStatus) }).subviewViewportRows
      if (!routingDraft || key === "escape" || key === "enter" || key === "return") {
        setViewMode("routing-editor")
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        const next = (flowSubFocus + (key === "up" || key === "k" ? -1 : 1) + PERMISSION_POLICY_ROWS.length) % PERMISSION_POLICY_ROWS.length
        setFlowSubFocus(next)
        setFlowSubScroll(offset => clampListScroll(next, PERMISSION_POLICY_ROWS.length, offset, visiblePermCount))
      } else if ((key === "space" || key === "left" || key === "right") && PERMISSION_POLICY_ROWS[flowSubFocus]) {
        cycleRoutingSubPolicyAt(flowSubFocus, key === "left" ? -1 : 1)
      } else if ((key === "backspace" || key === "delete") && PERMISSION_POLICY_ROWS[flowSubFocus]) {
        const permissions = { ...routingDraft.permissions }
        delete permissions[PERMISSION_POLICY_ROWS[flowSubFocus].key]
        applyRoutingDraft({ ...routingDraft, permissions })
      }
    } else if (viewMode === "routing-delegations") {
      const delRows = [{ name: "*" }, ...(routingView?.subagents ?? []).map(sub => ({ name: sub.name }))]
      const visibleCount = calculatePackFlowsModalLayout(termWidth, termHeight, { hasStatus: Boolean(routingStatus) }).subviewViewportRows
      if (!routingDraft || key === "escape" || key === "enter" || key === "return") {
        setViewMode("routing-editor")
      } else if ((key === "up" || key === "k" || key === "down" || key === "j") && delRows.length > 0) {
        const next = (flowSubFocus + (key === "up" || key === "k" ? -1 : 1) + delRows.length) % delRows.length
        setFlowSubFocus(next)
        setFlowSubScroll(offset => clampListScroll(next, delRows.length, offset, visibleCount))
      } else if ((key === "space" || key === "left" || key === "right") && delRows[flowSubFocus]) {
        cycleRoutingSubPolicyAt(flowSubFocus, key === "left" ? -1 : 1)
      } else if ((key === "backspace" || key === "delete") && delRows[flowSubFocus]) {
        const delegations = { ...routingDraft.delegations }
        delete delegations[delRows[flowSubFocus].name]
        applyRoutingDraft({ ...routingDraft, delegations })
      }
    } else if (viewMode === "pack-init") {
      const fieldOrder = getOnboardingFieldOrder(isReadOnlyGitSource)
      if (key === "escape") {
        setViewMode(routingArchetype ? "routing-configs" : "main")
      } else if (key === "tab" || key === "up" || key === "down") {
        const delta = key === "up" || (key === "tab" && e.shift) ? -1 : 1
        setInitPackField(f => {
          const idx = Math.max(0, fieldOrder.indexOf(f))
          return fieldOrder[(idx + delta + fieldOrder.length) % fieldOrder.length]
        })
      } else if ((key === "space" || key === "left" || key === "right") && (initPackField === "layout" || initPackField === "organize" || initPackField === "kit")) {
        if (initPackField === "layout") setInitPackLayout(prev => (prev === "root" ? "subpack" : "root"))
        else if (initPackField === "organize") setInitPackOrganize(prev => !prev)
        else if (initPackField === "kit") setInitPackKit(prev => !prev)
      } else if (key === "backspace") {
        if (initPackField === "cloneDest") setInitCloneDest(s => s.slice(0, -1))
        else if (initPackField === "name") setInitPackName(s => s.slice(0, -1))
        else if (initPackField === "version") setInitPackVersion(s => s.slice(0, -1))
        else if (initPackField === "desc") setInitPackDesc(s => s.slice(0, -1))
      } else if (key === "enter" || key === "return") {
        submitPackOnboarding()
      } else if (!e.ctrl && !e.meta && /^[\x20-\x7E]$/.test(rawChar)) {
        if (initPackField === "cloneDest") setInitCloneDest(s => s + rawChar)
        else if (initPackField === "name" && /[a-zA-Z0-9-]/.test(rawChar)) setInitPackName(s => (s + rawChar.toLowerCase()).slice(0, 64))
        else if (initPackField === "version" && rawChar !== " ") setInitPackVersion(s => s + rawChar)
        else if (initPackField === "desc") setInitPackDesc(s => s + rawChar)
      }
    } else if (viewMode === "pack-doctor") {
      if (key === "escape") {
        setViewMode("main")
      } else if (doctorTab === "doctor") {
        const totalFindings = doctorReport?.findings.length ?? 0
        const maxRows = getDoctorMaxFindingRows(termHeight)
        if (key === "up" || key === "k") {
          setDoctorScrollOffset(off => Math.max(0, off - 1))
        } else if (key === "down" || key === "j") {
          setDoctorScrollOffset(off => Math.min(Math.max(0, totalFindings - maxRows), off + 1))
        } else if (key === "f") {
          runPackDoctorAutoFix()
        } else if (key === "a") {
          runPackDoctorAuthoringKit()
        } else if (key === "n") {
          setDoctorTab("scaffold")
          setScaffoldField("id")
        } else if (key === "1") {
          runPackDoctorBump("patch")
        } else if (key === "2") {
          runPackDoctorBump("minor")
        } else if (key === "3") {
          runPackDoctorBump("major")
        }
      } else {
        const scOrder = getScaffoldFieldOrder(scaffoldKind)
        const isText = scaffoldField === "id" || scaffoldField === "desc"
        if (key === "tab" || key === "up" || key === "down") {
          const delta = key === "up" || (key === "tab" && e.shift) ? -1 : 1
          setScaffoldField(f => {
            const idx = Math.max(0, scOrder.indexOf(f))
            return scOrder[(idx + delta + scOrder.length) % scOrder.length]
          })
        } else if ((key === "space" || key === "left" || key === "right") && !isText) {
          const delta = key === "left" ? -1 : 1
          if (scaffoldField === "kind") {
            const kinds: ScaffoldResourceKind[] = ["agent", "skill", "command", "tool", "plugin", "mcp"]
            setScaffoldKind(prev => kinds[(kinds.indexOf(prev) + delta + kinds.length) % kinds.length])
          } else if (scaffoldField === "mode") {
            const modes: Array<"subagent" | "primary" | "all"> = ["subagent", "primary", "all"]
            setScaffoldMode(prev => modes[(modes.indexOf(prev) + delta + modes.length) % modes.length])
          }
        } else if (!isText && key === "d") {
          setDoctorTab("doctor")
        } else if (key === "backspace") {
          if (scaffoldField === "id") setScaffoldId(s => s.slice(0, -1))
          else if (scaffoldField === "desc") setScaffoldDesc(s => s.slice(0, -1))
        } else if (key === "enter" || key === "return") {
          submitPackScaffold()
        } else if (!e.ctrl && !e.meta && /^[\x20-\x7E]$/.test(rawChar)) {
          if (scaffoldField === "id" && /[a-zA-Z0-9._/-]/.test(rawChar)) setScaffoldId(s => s + rawChar)
          else if (scaffoldField === "desc") setScaffoldDesc(s => s + rawChar)
        }
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
         const pageSize = maxVisibleDelegations
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
          const subName = agentId(targetSubagent)
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
      const tuningFields: readonly TuningField[] = ["steps", "variant", "mode", "hidden"]
      const stepVariant = (direction: 1 | -1) => {
        const choices = tuningVariantChoices
        const currentIndex = choices.indexOf(tuningVariant)
        setTuningVariantTyping(false)
        if (currentIndex < 0 && tuningVariant) {
          const prefixMatches = choices.filter(c => c !== "" && c.startsWith(tuningVariant))
          if (prefixMatches.length > 0) {
            setTuningVariant(direction === 1 ? prefixMatches[0] : prefixMatches[prefixMatches.length - 1])
            markTuningDirty("variant")
            return
          }
        }
        const nextIndex = currentIndex < 0
          ? (direction === 1 ? 0 : choices.length - 1)
          : (currentIndex + direction + choices.length) % choices.length
        setTuningVariant(choices[nextIndex])
        markTuningDirty("variant")
      }

      if (key === "escape") {
        setViewMode("main")
      } else if (key === "tab") {
        const delta = e.shift ? -1 : 1
        setTuningVariantTyping(false)
        setTuningFocusedField((prev) => tuningFields[(tuningFields.indexOf(prev) + delta + tuningFields.length) % tuningFields.length])
      } else if (key === "down") {
        setTuningVariantTyping(false)
        setTuningFocusedField((prev) => tuningFields[(tuningFields.indexOf(prev) + 1) % tuningFields.length])
      } else if (key === "up") {
        setTuningVariantTyping(false)
        setTuningFocusedField((prev) => tuningFields[(tuningFields.indexOf(prev) - 1 + tuningFields.length) % tuningFields.length])
      } else if (key === "space") {
        if (tuningFocusedField === "variant") {
          stepVariant(1)
        } else if (tuningFocusedField === "mode") {
          setTuningMode((prev) => AGENT_TUNING_MODES[(AGENT_TUNING_MODES.indexOf(prev) + 1) % AGENT_TUNING_MODES.length])
          markTuningDirty("mode")
        } else if (tuningFocusedField === "hidden") {
          setTuningHidden((prev) => !prev)
          markTuningDirty("hidden")
        }
      } else if (key === "delete" || (e.ctrl && key === "u")) {
        if (tuningFocusedField === "variant") {
          setTuningVariant("")
          setTuningVariantTyping(false)
          markTuningDirty("variant")
        } else if (tuningFocusedField === "steps") {
          setTuningSteps("")
          markTuningDirty("steps")
        }
      } else if (key === "backspace") {
        if (tuningFocusedField === "steps") {
          if (!tuningDirtyFields.has("steps") && tuningSummary.steps.mixed) setTuningSteps("")
          else setTuningSteps(prev => prev.slice(0, -1))
          markTuningDirty("steps")
        } else if (tuningFocusedField === "variant") {
          if (!tuningDirtyFields.has("variant") && tuningSummary.variant.mixed) setTuningVariant("")
          else setTuningVariant((prev) => prev.slice(0, -1))
          setTuningVariantTyping(true)
          markTuningDirty("variant")
        }
      } else if (key === "enter" || key === "return") {
        submitTuningModal()
      } else if (/^[\x20-\x7E]$/.test(rawChar) && rawChar !== " ") {
        if (tuningFocusedField === "steps") {
          if (/[0-9]/.test(rawChar)) {
            if (!tuningDirtyFields.has("steps") && tuningSummary.steps.mixed) setTuningSteps(rawChar)
            else setTuningSteps(prev => prev + rawChar)
            markTuningDirty("steps")
          } else if (rawChar === "-" || rawChar === "_") {
            adjustTuningSteps(-1)
          } else if (rawChar === "+" || rawChar === "=") {
            adjustTuningSteps(1)
          }
        } else if (tuningFocusedField === "variant" && /^[a-zA-Z0-9._-]$/.test(rawChar)) {
          const ch = rawChar.toLowerCase()
          if (!tuningVariantTyping || (!tuningDirtyFields.has("variant") && tuningSummary.variant.mixed)) {
            setTuningVariant(ch)
            setTuningVariantTyping(true)
          } else {
            setTuningVariant((prev) => prev + ch)
          }
          markTuningDirty("variant")
        }
      } else if (key === "left" || key === "right") {
        if (tuningFocusedField === "steps") {
          const step = e.shift ? 10 : 1
          adjustTuningSteps(key === "right" ? step : -step)
        } else if (tuningFocusedField === "variant") {
          stepVariant(key === "right" ? 1 : -1)
        } else if (tuningFocusedField === "mode") {
          const delta = key === "right" ? 1 : -1
          setTuningMode(prev => AGENT_TUNING_MODES[(AGENT_TUNING_MODES.indexOf(prev) + delta + AGENT_TUNING_MODES.length) % AGENT_TUNING_MODES.length])
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
           const renameLines = [
             result.success ? `Successfully renamed agent:` : `Agent file renamed with reference warnings:`,
             `  ${middleEllipsis(renameTargetAgent.filename, Math.max(1, Math.floor(termWidth * 0.7) - 8))} → ${middleEllipsis(newFilename, Math.max(1, Math.floor(termWidth * 0.7) - 8))}`,
             ...result.updatedReferences.map((reference) => `  ${reference}`),
             ...(result.skipped.length > 0 ? [`Skipped files:`, ...result.skipped.map((file) => `  ${file}`)] : []),
             ...(result.error ? [``, `⚠ ${result.error}`] : []),
           ]
           if (result.success) {
             setMutationSuccess("Rename Complete", renameLines, tx.warning)
           } else {
             setActionResultTitle("Rename Incomplete")
             setActionResultLines(tx.warning ? [...renameLines, "", `⚠ Auto-commit warning: ${tx.warning}`] : renameLines)
             pushToast("⚠ Rename incomplete (reference update failed)")
           }
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
    setScrollOffset(offset => clampListScroll(index, activeItems.length, offset, maxVisibleItems))
  }

  const updateDelegationScroll = (index: number) => {
    setDelegationScrollOffset(offset => clampListScroll(index, delegationItems.length, offset, maxVisibleDelegations))
  }

  const updateModelScroll = (index: number) => {
    setModelScrollOffset(offset => clampListScroll(index, modelTreeItems.length, offset, maxVisibleModels))
  }

  const updateColorScroll = (index: number) => {
    setColorScrollOffset(offset => clampListScroll(index, colorTreeItems.length, offset, maxVisibleColors))
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
  const tuningVariantChoices = modelVariants !== null && modelVariants.length > 0
    ? ["", ...modelVariants]
    : ["", ...KNOWN_MODEL_VARIANTS]
  if (!tuningSummary.variant.mixed && tuningSummary.variant.value && !tuningVariantChoices.includes(tuningSummary.variant.value)) {
    tuningVariantChoices.push(tuningSummary.variant.value)
  }

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
  const maxVisibleResourceRows = resourceViewport.viewportRows
  const visibleResourceRows = resourceManagerRows.slice(resourceModalScrollOffset, resourceModalScrollOffset + maxVisibleResourceRows)
  const resourceInspectorPageSize = wsViewports.resourcesInspectorRows

  // Render viewport lists
  const visibleItems = activeItems.slice(scrollOffset, scrollOffset + maxVisibleItems)
  const visibleModels = modelTreeItems.slice(modelScrollOffset, modelScrollOffset + maxVisibleModels)
  const visibleColors = colorTreeItems.slice(colorScrollOffset, colorScrollOffset + maxVisibleColors)
  const visibleDelegationItems = delegationItems.slice(delegationScrollOffset, delegationScrollOffset + maxVisibleDelegations)
  const actionResultMaxOffset = Math.max(0, actionResultLines.length - maxVisibleActionResultLines)
  const visibleActionResultLines = actionResultLines.slice(
    actionResultScrollOffset,
    actionResultScrollOffset + maxVisibleActionResultLines
  )

  if (layout.mode === "too-small") {
    return (
      <box width="100%" height="100%" padding={1} overflow="hidden" backgroundColor={THEME.bgBase}>
        <text style={{ textColor: THEME.accentAmber }}>Terminal too small. Please increase terminal size.</text>
      </box>
    )
  }

  const hasOverlayModal = viewMode !== "main"
  const catalogListBorder = lerpColor(THEME.borderFocus, THEME.borderIdle, focusPaneBlend)
  const catalogInspectorBorder = lerpColor(THEME.borderIdle, THEME.borderInspectorFocus, focusPaneBlend)
  const activeFocusedPack = currentItem?.category || ""
  const activeFocusedIsVirtual = Boolean(
    activeFocusedPack &&
    packDir(workspaceRoot, activeFocusedPack) &&
    !fs.existsSync(path.join(packDir(workspaceRoot, activeFocusedPack)!, "opencode-pack.json")),
  )
  const contextualChips = buildContextualShortcuts({
    workspaceTab,
    itemType: currentItem?.type ?? null,
    selectedCount: selectedAgentPaths.size,
    isVirtualPack: activeFocusedIsVirtual || isWorkspaceVirtualPack,
    isReadOnlyGitSource,
    hasInvalidModels: modelCatalog.status === "verified" && invalidModelGroups.length > 0,
    activePane: effectivePane,
    showInspector: layout.showInspector,
  })

  return (
    <box
      width="100%"
      height="100%"
      minHeight={0}
      overflow="hidden"
      flexDirection="column"
      backgroundColor={hasOverlayModal ? THEME.bgBaseDimmed : THEME.bgBase}
      padding={1}
    >
      {/* Top Browser-Style Workspace Header */}
      <WorkspaceTopbar
        activeTab={workspaceTab}
        termWidth={termWidth}
        dimmed={hasOverlayModal}
        spinner={pulse.spinner}
        workspaceLabel={workspaceLabel}
        hasActiveSource={Boolean(activeDataSource)}
        commitLabel={commitLabel}
        isReadOnlyGitSource={isReadOnlyGitSource}
        autoCommitOn={autoCommitEnabled()}
        isWorkspaceVirtualPack={isWorkspaceVirtualPack}
        onSelectTab={tabKey => {
          setViewMode("main")
          setIsSearching(false)
          if (tabKey === "sources") {
            if (workspaceTab !== "sources") refreshSourcesView(true)
            setWorkspaceTab("sources")
          } else if (tabKey === "target") {
            refreshTargetStatus()
            setWorkspaceTab("target")
          } else {
            setWorkspaceTab(tabKey)
          }
        }}
        onOpenSources={() => openSourcesModal(true)}
        onOpenOnboarding={() => openInitPackModal()}
        onOpenPalette={() => openCommandPalette()}
      />

      {/* Non-blocking Animated Floating Toast */}
      <ToastOverlay
        message={toastMessage}
        toastId={toastId}
        termWidth={termWidth}
        reducedMotion={reducedMotionState}
        onDismiss={() => setToastMessage(null)}
      />

      {/* Workspace Maintenance Modal */}
      {viewMode === "maintenance" && (
        <MaintenanceModal
          termWidth={termWidth}
          termHeight={termHeight}
          activeTab={maintenanceTab}
          validation={maintenanceValidation}
          lint={maintenanceLint}
          fixPlan={maintenanceFixPlan}
          audit={maintenanceAudit}
          isReadOnlyGitSource={isReadOnlyGitSource}
          scrollOffset={maintenanceScrollOffset}
          onSelectTab={tab => {
            setMaintenanceTab(tab)
            setMaintenanceScrollOffset(0)
          }}
          onScrollDelta={delta => setMaintenanceScrollOffset(off => Math.max(0, off + delta))}
          onApplyFixNames={applyMaintenanceFixNames}
          onRefresh={refreshMaintenanceReports}
          onClose={() => setViewMode("main")}
        />
      )}

      {/* Codex Install Preview Confirmation Modal */}
      {viewMode === "codex-install-confirm" && codexInstallPreview && (
        <box
          position="absolute"
          left={Math.max(0, Math.floor((termWidth - Math.min(82, termWidth - 6)) / 2))}
          top={Math.max(0, Math.floor((termHeight - Math.min(22, termHeight - 4)) / 2))}
          width={Math.min(82, termWidth - 6)}
          height={Math.min(22, termHeight - 4)}
          borderStyle="rounded"
          borderColor={THEME.accentCyan}
          backgroundColor={THEME.bgPanel}
          flexDirection="column"
          padding={1}
          zIndex={45}
        >
          <text height={1} wrapMode="none" style={{ textColor: THEME.accentCyan }} b>
            {` Confirm Codex Install (--codex) · ${terminalSafeText(codexInstallPreview.packName)} `}
          </text>
          <box flexDirection="column" flexGrow={1} minHeight={0} marginTop={1} overflow="hidden">
            {codexInstallPreview.lines.slice(0, 14).map((line, i) => (
              <text key={i} height={1} wrapMode="none" overflow="hidden" style={{ textColor: line.includes("⚠") ? THEME.accentAmber : THEME.fgPrimary }}>
                {line}
              </text>
            ))}
          </box>
          <box flexDirection="row" justifyContent="space-between" height={1} marginTop={1}>
            <text height={1} wrapMode="none" style={{ textColor: THEME.accentGreen }} b onMouseDown={applyCodexInstallAction}>
              {" [Enter / Y] Install into Codex "}
            </text>
            <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }} onMouseDown={() => { setCodexInstallPreview(null); setViewMode("main") }}>
              {" [Esc / N] Cancel "}
            </text>
          </box>
        </box>
      )}

      {/* Command Palette Overlay */}
      {viewMode === "command-palette" && (
        <CommandPaletteModal
          query={paletteQuery}
          commands={filteredPaletteCommands}
          focusedIndex={paletteFocusIndex}
          scrollOffset={paletteScrollOffset}
          maxRows={maxPaletteRows}
          termWidth={termWidth}
          termHeight={termHeight}
          reducedMotion={reducedMotionState}
          onFocusRow={idx => setPaletteFocusIndex(idx)}
          onExecute={cmd => executeActionById(cmd.id)}
          onScrollDelta={delta => {
            setPaletteScrollOffset(off => Math.max(0, Math.min(Math.max(0, filteredPaletteCommands.length - maxPaletteRows), off + delta)))
          }}
          onClose={() => setViewMode("main")}
        />
      )}

      {/* Keyboard & Mouse Guide Overlay */}
      {viewMode === "help" && (
        <HelpModal
          activeTab={helpTab}
          content={helpContent}
          focusedItemIndex={helpFocusIndex}
          scrollOffset={helpScrollOffset}
          termWidth={termWidth}
          termHeight={termHeight}
          reducedMotion={reducedMotionState}
          onSelectTab={selectHelpTab}
          onFocusItem={idx => setHelpFocusIndex(idx)}
          onActivateItem={activateHelpItem}
          onScrollDelta={delta => {
            const vpRows = calculateHelpViewport(termWidth, termHeight).viewportRows
            const maxOff = Math.max(0, helpContent.rows.length - vpRows)
            setHelpScrollOffset(off => {
              const nextOff = Math.max(0, Math.min(maxOff, off + delta))
              setHelpFocusIndex(idx => clampFocusIntoHelpSlice(idx, helpContent.rows, nextOff, vpRows))
              return nextOff
            })
          }}
          onToggleReducedMotion={toggleReducedMotion}
          onClose={() => setViewMode("main")}
        />
      )}

      {/* Grouped Model Repair Confirmation with Native Diff Preview */}
      {viewMode === "repair-confirm" && (
        <box
          style={{ position: "absolute", left: "10%", top: "12%", width: "80%", height: "74%" }}
          zIndex={45}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.borderWarn}
          backgroundColor={THEME.bgElevated}
          title=" Confirm Grouped Model Repair "
          titleColor={THEME.accentAmber}
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
        >
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <text style={{ textColor: THEME.accentAmber }} b>
              Review model replacements before writing:
            </text>
            <scrollbox scrollY={true} width="100%" flexGrow={1} contentOptions={{ width: "100%" }} marginTop={1} overflow="hidden">
              <diff
                width="100%"
                view="unified"
                showLineNumbers={true}
                syntaxStyle={getMarkdownSyntaxStyle()}
                diff={buildPreviewUnifiedDiff(
                  "agent-models.yaml",
                  invalidModelGroups.map(g => `model: ${JSON.stringify(g.value)}  # ${g.agents.length} agent(s)`),
                  invalidModelGroups.map((g, i) => `model: "${repairMappings[String(i)] || ""}"  # ${g.agents.length} agent(s)`),
                )}
              />
            </scrollbox>
          </box>
          <box
            borderStyle="single"
            border={["top"]}
            borderColor={THEME.borderSubtle}
            paddingTop={1}
            flexDirection="row"
            justifyContent="space-between"
          >
            <text style={{ textColor: THEME.accentGreen }} b>
              [Y / ENTER] Apply Repair
            </text>
            <text
              style={{ textColor: THEME.accentRed }}
              b
              onMouseDown={() => setViewMode("main")}
            >
              [N / ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {/* Workspace 2: Flows & Call Graph */}
      {workspaceTab === "flows" ? (
        <FlowsWorkspace
          agents={agents}
          navData={flowsNav}
          packFlowsByCategory={packFlowsByCategory}
          focusedIndex={flowsFocusIndex}
          scrollOffset={flowsScrollOffset}
          listRows={wsViewports.flowsRows}
          leftWidth={listPanelWidth}
          rightWidth={panelWidths.inspector}
          gutterWidth={panelWidths.gutter}
          showInspector={layout.showInspector}
          activePane={effectivePane}
          focusBorderBlend={focusPaneBlend}
          inspectorFocusIndex={flowsInspectorFocus}
          onSelectPane={pane => setActivePane(pane)}
          onFocusIndex={idx => setFlowsFocusIndex(idx)}
          onScrollDelta={delta => {
            if (!flowsNav.rows.length) return
            const page = Math.max(1, wsViewports.flowsRows)
            const maxOff = Math.max(0, flowsNav.rows.length - page)
            setFlowsScrollOffset(off => {
              const nextOff = Math.max(0, Math.min(maxOff, off + delta))
              setFlowsFocusIndex(idx => Math.max(nextOff, Math.min(Math.min(flowsNav.rows.length - 1, nextOff + page - 1), idx)))
              return nextOff
            })
          }}
          onFocusInspectorItem={idx => setFlowsInspectorFocus(idx)}
          onScrollInspectorDelta={delta => {
            setActivePane("inspector")
            const currentFlowNavRow = flowsNav.rows[Math.max(0, Math.min(flowsFocusIndex, Math.max(0, flowsNav.rows.length - 1)))] ?? null
            const flowsInsp = buildFlowsInspectorItems(currentFlowNavRow, agents, packFlowsByCategory, flowsNav.agentByShortName)
            const total = flowsInsp.items.length
            if (!total) return
            setFlowsInspectorFocus(prev => Math.max(0, Math.min(total - 1, prev + delta)))
          }}
          onOpenPackFlows={(pack, initialIdx) => openPackFlowsModal(pack, initialIdx ?? 0)}
          onOpenDelegations={agent => {
            setDelegationTargetAgent(agent)
            setSelectedDelegations(new Set(agent.allowedSubagents || []))
            setFocusedDelegationIndex(0)
            setDelegationScrollOffset(0)
            setViewMode("delegation-manager")
          }}
          onJumpToCatalogAgent={agentPath => jumpToCatalogAgent(agentPath)}
        />
      ) : workspaceTab === "target" ? (
        /* Workspace 2: OpenCode v2 Target & Claude/Codex Bridges */
        <TargetBridgesWorkspace
          subTab={targetSubTab}
          rows={targetWorkspaceRows}
          installedCount={targetInstalledCount}
          bridgesCount={catalogIndex.packs.length}
          backupsCount={targetBackups.length}
          focusedIndex={targetFocusIndex}
          scrollOffset={targetScrollOffset}
          listRows={wsViewports.sourcesRows}
          targetStatusInfo={targetStatusInfo}
          leftWidth={listPanelWidth}
          rightWidth={panelWidths.inspector}
          gutterWidth={panelWidths.gutter}
          showInspector={layout.showInspector}
          activePane={effectivePane}
          focusBorderBlend={focusPaneBlend}
          inspectorScrollOffset={targetInspectorScroll}
          busySpinner={isAsyncBusy ? pulse.spinner : ""}
          onSelectSubTab={tab => {
            setTargetSubTab(tab)
            setTargetFocusIndex(0)
            setTargetScrollOffset(0)
            setTargetInspectorScroll(0)
          }}
          onSelectPane={pane => setActivePane(pane)}
          onFocusIndex={idx => {
            setTargetFocusIndex(idx)
            setTargetInspectorScroll(0)
          }}
          onScrollDelta={delta => {
            const total = targetWorkspaceRows.length
            if (!total) return
            const page = Math.max(2, wsViewports.sourcesRows - 2)
            const maxOff = Math.max(0, total - page)
            setTargetScrollOffset(off => Math.max(0, Math.min(maxOff, off + delta)))
          }}
          onScrollInspectorDelta={delta => setTargetInspectorScroll(off => Math.max(0, off + delta))}
          onInstallPack={packName => previewInstall([packName])}
          onUpdatePack={packName => previewTargetOp("update", packName ? [packName] : [])}
          onUninstallPack={packName => previewTargetOp("uninstall", [packName])}
          onReconcile={adopt => (adopt ? previewTargetOp("reconcile", [], true) : runTargetReconcile())}
          onRestoreBackup={backupId => runTargetRestoreAction(backupId)}
          onRefresh={() => {
            refreshTargetStatus()
            pushToast("✓ Refreshed target status & backups")
          }}
          onBridgeCheck={packName => runBridgeCheckAction(packName)}
          onBridgeClaude={packName => openBridgeModalAction("claude", packName)}
          onBridgeCodex={packName => openBridgeModalAction("codex", packName)}
          onBridgeVibe={packName => openBridgeModalAction("vibe", packName)}
          onCodexInstall={packName => openCodexInstallPreviewAction(packName)}
        />
      ) : workspaceTab === "sources" ? (
        /* Workspace 3: Sources & OpenCode Target */
        <SourcesTargetWorkspace
          rows={sourceModalRows}
          focusedIndex={sourcesFocusIndex}
          scrollOffset={sourcesScrollOffset}
          listRows={wsViewports.sourcesRows}
          termHeight={termHeight}
          query={sourcesQuery}
          inputFocused={sourcesInputFocused}
          inputMode={isSourceSpecLike(sourcesQuery) ? "spec" : "filter"}
          inputValidation={sourceValidation}
          ghAuth={ghAuth}
          busySpinner={pulse.spinner}
          sourcesStatus={sourcesStatus || null}
          targetStatusInfo={targetStatusInfo}
          leftWidth={listPanelWidth}
          rightWidth={panelWidths.inspector}
          gutterWidth={panelWidths.gutter}
          showInspector={layout.showInspector}
          activePane={effectivePane}
          focusBorderBlend={focusPaneBlend}
          inspectorScrollOffset={sourcesInspectorScroll}
          onSelectPane={pane => setActivePane(pane)}
          onFocusIndex={idx => setSourcesFocusIndex(idx)}
          onActivateRow={idx => activateSourceRowAtIndex(idx)}
          onScrollDelta={delta => {
            if (!sourceModalRows.length) return
            const page = Math.max(1, wsViewports.sourcesRows)
            const maxOff = Math.max(0, sourceModalRows.length - page)
            setSourcesScrollOffset(off => {
              const nextOff = Math.max(0, Math.min(maxOff, off + delta))
              setSourcesFocusIndex(idx => Math.max(nextOff, Math.min(Math.min(sourceModalRows.length - 1, nextOff + page - 1), idx)))
              return nextOff
            })
          }}
          onScrollInspectorDelta={delta => {
            setActivePane("inspector")
            const installedCount = Object.keys(targetStatusInfo?.lock?.packs ?? {}).length
            const driftCount = targetStatusInfo?.drift?.length ?? 0
            const maxPackRows = calculateTargetInstalledPackRows(termHeight, {
              hasEngineLine: Boolean(engineVersionInfo?.displayVersion),
              driftCount,
            })
            const maxOff = Math.max(0, installedCount - maxPackRows)
            setSourcesInspectorScroll(off => Math.max(0, Math.min(maxOff, off + delta)))
          }}
          onToggleInputFocus={focused => setSourcesInputFocused(focused)}
          onPullSelected={pullSelectedOrActiveSource}
          onGhLogin={runInteractiveGhLogin}
          onReconcileTarget={runTargetReconcile}
          onRefreshTarget={() => {
            refreshSourcesView(true)
            pushToast("✓ Refreshed sources & target status")
          }}
          engineVersionLabel={engineVersionInfo?.displayVersion}
          onOpenSelfUpdate={openSelfUpdateModal}
        />
      ) : (
        /* Workspace 1: Catalog & 6-Tab Inspector */
        <box width="100%" minHeight={0} flexGrow={1} flexDirection="row" marginTop={1} overflow="hidden">
          <box
            width={listPanelWidth}
            flexGrow={0}
            minHeight={0}
            border={true}
            borderStyle="rounded"
            borderColor={catalogListBorder}
            backgroundColor={hasOverlayModal ? THEME.bgPanelDimmed : THEME.bgPanel}
            title={
              layout.showInspector
                ? effectivePane === "list"
                  ? ` ● Catalog (${catalogPacks.length} packs · ${catalogIndex.totals.total} assets) `
                  : ` Catalog (${catalogPacks.length} packs · ${catalogIndex.totals.total} assets) · ⇧← `
                : ` Catalog (${catalogPacks.length} packs · ${catalogIndex.totals.total} assets) `
            }
            titleColor={effectivePane === "list" ? THEME.accentBlue : THEME.fgSecondary}
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            justifyContent="space-between"
            overflow="hidden"
            onMouseDown={() => setActivePane("list")}
            onMouseScroll={(_self, event) => {
              const dir = (event as any).scroll?.direction
              if (!dir || activeItems.length === 0) return
              const delta = dir === "down" ? 2 : -2
              const maxOff = Math.max(0, activeItems.length - maxVisibleItems)
              setScrollOffset(off => Math.max(0, Math.min(maxOff, off + delta)))
            }}
          >
            <box flexDirection="column" width="100%" overflow="hidden">
              {/* Integrated Search & Filter Bar */}
              <box
                width="100%"
                height={2}
                borderStyle="single"
                border={["bottom"]}
                borderColor={isSearching ? THEME.accentAmber : THEME.borderSubtle}
                flexDirection="row"
                justifyContent="space-between"
                alignItems="center"
                overflow="hidden"
                onMouseDown={(_self, event) => {
                  event.stopPropagation()
                  setActivePane("list")
                  setIsSearching(true)
                }}
              >
                <text
                  wrapMode="none"
                  overflow="hidden"
                  style={{ textColor: isSearching ? THEME.accentAmber : searchQuery ? THEME.accentCyan : THEME.fgSecondary }}
                  b={Boolean(searchQuery || isSearching)}
                >
                  {middleEllipsis(
                    isSearching
                      ? `🔍 /${terminalSafeText(searchQuery)}▋`
                      : searchQuery
                        ? `🔍 Filter: ${terminalSafeText(searchQuery)}`
                        : "🔍 Press / or click to filter packs and agents...",
                    Math.max(12, listContentWidth - 18),
                  )}
                </text>
                {searchQuery ? (
                  <text
                    wrapMode="none"
                    style={{ textColor: THEME.accentRed }}
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      setSearchQuery("")
                      setIsSearching(false)
                    }}
                  >
                    [× Clear]
                  </text>
                ) : (
                  <text
                    wrapMode="none"
                    style={{ textColor: THEME.fgMuted }}
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      setActivePane("list")
                      executeActionById("select-all-packs")
                    }}
                  >
                    {catalogPacks.length > 0 ? "[Ctrl+A] All packs" : ""}
                  </text>
                )}
              </box>

              {/* Asset-Type Filter Pills (1–8 / [F] cycles) */}
              <box
                width="100%"
                height={2}
                borderStyle="single"
                border={["bottom"]}
                borderColor={THEME.borderSubtle}
                flexDirection="row"
                alignItems="center"
                gap={listContentWidth >= 72 ? 1 : 0}
                overflow="hidden"
              >
                {ASSET_TYPE_FILTERS.map(f => {
                  const active = assetFilter === f.key
                  const pillName = `${f.shortcut}. ${listContentWidth >= 94 ? f.label : f.shortLabel}`
                  return (
                    <text
                      key={f.key}
                      height={1}
                      wrapMode="none"
                      backgroundColor={active ? THEME.bgPillActive : "transparent"}
                      style={{ textColor: active ? THEME.accentBlue : THEME.fgMuted }}
                      b={active}
                      onMouseDown={(_self, event) => {
                        event.stopPropagation()
                        setActivePane("list")
                        setAssetFilter(f.key)
                      }}
                    >
                      {active ? ` ● ${pillName} ` : ` ${pillName} `}
                    </text>
                  )
                })}
              </box>

              {/* Column Header */}
              <box width={listColumns.total} height={1} flexDirection="row" marginTop={0}>
                <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }} width={columnWidth(0)}>
                  Sel
                </text>
                {gutter("th1")}
                <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }} width={columnWidth(1)}>
                  Pack / Agent
                </text>
                {gutter("th2")}
                <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }} width={columnWidth(2)}>
                  Status / Model
                </text>
              </box>

              {/* Tree Rows */}
              <box width="100%" height={maxVisibleItems} minHeight={0} overflow="hidden" flexGrow={0} flexShrink={0} flexDirection="column">
                {activeItems.length === 0 ? (
                  <box flexDirection="column" marginTop={1}>
                    <text style={{ textColor: THEME.accentAmber }}>
                      {!activeDataSource
                        ? "No data source connected. Press [O] or click Sources above."
                        : searchQuery
                          ? `No packs or agents match "${terminalSafeText(searchQuery)}".`
                          : "No packs with agents found. Press O to choose another source."}
                    </text>
                  </box>
                ) : (
                  visibleItems.map((item, index) => {
                    const globalIndex = scrollOffset + index
                    const isFocused = globalIndex === focusedIndex

                    if (item.type === "folder") {
                      const lockedPack = targetStatusInfo?.lock?.packs?.[item.category]
                      const folderDir = packDir(workspaceRoot, item.category)
                      const isVirtual = Boolean(folderDir && !fs.existsSync(path.join(folderDir, "opencode-pack.json")))
                      const overrideCount = userOverridesSummary.countsByPack.get(item.category) ?? 0
                      const flowCount = packFlowsByCategory.get(item.category)?.flows.length ?? 0
                      const hasUpdate = Boolean(
                        lockedPack &&
                        activeDataSource?.kind === "source" &&
                        activeDataSource.source.kind === "git" &&
                        activeRevision &&
                        lockedPack.revision &&
                        lockedPack.revision !== activeRevision,
                      )
                      const statusParts: string[] = []
                      if (hasUpdate) statusParts.push("↑ update")
                      else if (lockedPack) statusParts.push("● installed")
                      else if (isVirtual) statusParts.push("◌ virtual")
                      if (overrideCount > 0) statusParts.push(`✎ ${overrideCount}`)
                      if (flowCount > 0) statusParts.push(`⇄ ${flowCount}`)
                      const rightMeta = statusParts.join(" · ")
                      const isExpanded = searchQuery.trim() !== "" || expandedCategories.has(item.id)
                      const catCount = categoryAgentCounts.get(item.category) ?? 0
                      const isSelected = selectedPackNames.has(item.category)

                      return (
                        <box
                          key={`folder-${item.id}`}
                          width="100%"
                          height={1}
                          flexDirection="row"
                          backgroundColor={isFocused ? THEME.bgRowFocus : isSelected ? THEME.bgRowSelected : "transparent"}
                          onMouseDown={(_self, event) => {
                            event.stopPropagation()
                            setActivePane("list")
                            setFocusedIndex(globalIndex)
                            setExpandedCategories(prev => {
                              const next = new Set(prev)
                              if (next.has(item.id)) next.delete(item.id)
                              else next.add(item.id)
                              return next
                            })
                          }}
                        >
                          <box width={columnWidth(0)} height={1} flexDirection="row" overflow="hidden">
                            <text width={1} style={{ textColor: THEME.fgPrimary }}>{isFocused ? "▎" : " "}</text>
                            <text
                              width={3}
                              wrapMode="none"
                              style={{ textColor: isSelected ? THEME.accentGreen : THEME.fgMuted }}
                              b={isSelected}
                              onMouseDown={(_self, event) => {
                                event.stopPropagation()
                                setActivePane("list")
                                setFocusedIndex(globalIndex)
                                togglePackSelection([item.category])
                              }}
                            >
                              {isSelected ? "[X]" : "[ ]"}
                            </text>
                            <text width={1} style={{ textColor: THEME.accentAmber }}>{isExpanded ? "▾" : "▸"}</text>
                          </box>
                          {gutter(`tree-${item.id}-1`)}
                          <text width={columnWidth(1)} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#ffffff" : THEME.accentAmber }} b>
                            {middleEllipsis(`${assetFilterIcon(assetFilter)} ${terminalSafeText(item.category)} (${packCountForFilter(item.pack.counts, assetFilter)})`, columnWidth(1))}
                          </text>
                          {gutter(`tree-${item.id}-2`)}
                          <text
                            width={columnWidth(2)}
                            wrapMode="none"
                            overflow="hidden"
                            style={{
                              textColor: hasUpdate
                                ? THEME.accentAmber
                                : lockedPack
                                  ? THEME.accentGreen
                                  : overrideCount > 0
                                    ? THEME.accentPurple
                                    : THEME.fgSecondary,
                            }}
                          >
                            {middleEllipsis(rightMeta, columnWidth(2))}
                          </text>
                        </box>
                      )
                    }

                    if (item.type === "section") {
                      const isSecExpanded = searchQuery.trim() !== "" || expandedSections.has(item.id)
                      return (
                        <box
                          key={`section-${item.id}`}
                          width="100%"
                          height={1}
                          flexDirection="row"
                          backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                          onMouseDown={(_self, event) => {
                            event.stopPropagation()
                            setActivePane("list")
                            setFocusedIndex(globalIndex)
                            setExpandedSections(prev => {
                              const next = new Set(prev)
                              if (next.has(item.id)) next.delete(item.id)
                              else next.add(item.id)
                              return next
                            })
                          }}
                        >
                          <text width={columnWidth(0)} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                            {isFocused ? "▎  " : "   "}
                          </text>
                          {gutter(`sec-${item.id}-1`)}
                          <text width={columnWidth(1)} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#ffffff" : THEME.accentCyan }} b={isFocused}>
                            {middleEllipsis(` ${isSecExpanded ? "▾" : "▸"} ${item.label.trim().replace(/^[▾▸]\s*/, "")}`, columnWidth(1))}
                          </text>
                          {gutter(`sec-${item.id}-2`)}
                          <text width={columnWidth(2)} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
                            {item.assetKind}
                          </text>
                        </box>
                      )
                    }

                    if (item.type === "asset") {
                      const kindTag = item.assetKind === "skill" ? "SK" : item.assetKind === "command" ? "CM" : item.assetKind === "tool" ? "TL" : item.assetKind === "plugin" ? "PL" : item.assetKind === "theme" ? "TH" : "MCP"
                      const kindColor = item.assetKind === "skill" ? THEME.accentGreen : item.assetKind === "command" ? THEME.accentCyan : item.assetKind === "mcp" ? THEME.accentPurple : THEME.accentAmber
                      return (
                        <box
                          key={`asset-${item.id}`}
                          width="100%"
                          height={1}
                          flexDirection="row"
                          backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                          onMouseDown={(_self, event) => {
                            event.stopPropagation()
                            setActivePane("list")
                            setFocusedIndex(globalIndex)
                          }}
                        >
                          <text width={columnWidth(0)} wrapMode="none" style={{ textColor: isFocused ? "#ffffff" : kindColor }} b={isFocused}>
                            {`${isFocused ? "▎" : " "}${kindTag}`}
                          </text>
                          {gutter(`asset-${item.id}-1`)}
                          <text width={columnWidth(1)} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#ffffff" : THEME.fgPrimary }} b={isFocused}>
                            {middleEllipsis(`  ${terminalSafeText(item.asset.name)}`, columnWidth(1))}
                          </text>
                          {gutter(`asset-${item.id}-2`)}
                          <text width={columnWidth(2)} wrapMode="none" overflow="hidden" style={{ textColor: item.asset.executable ? THEME.accentAmber : THEME.fgMuted }}>
                            {middleEllipsis(item.asset.executable ? "⚠ exec" : terminalSafeText(item.asset.description || item.asset.relPath), columnWidth(2))}
                          </text>
                        </box>
                      )
                    }

                    const ag = item.agent!
                    const isSelected = selectedAgentPaths.has(item.id)
                    const baseBg = isFocused ? THEME.bgRowFocus : isSelected ? THEME.bgRowSelected : "transparent"
                    const rowBg = flashedPaths.has(item.id) && mutationFlash > 0
                      ? lerpColor(baseBg === "transparent" ? THEME.bgPanel : baseBg, THEME.bgRowFlash, mutationFlash)
                      : baseBg
                    const dotHex = resolveAgentHexColor(ag.frontmatter.color)
                    const hasWarn = analyzePermissionOrder(ag).hasOrderError
                    const shortName = agentId(ag)
                    const isOverridden = userOverridesSummary.overriddenAgents.has(`${ag.category}/${shortName}`)
                    const modelText = modelDisplayValue(ag, true, modelCatalog)
                    const isModelInvalid = modelText.startsWith("invalid:")
                    const resolvedTier = resolvedAgents.get(ag.currentPath)?.tier
                    const rightText = resolvedTier ? `${resolvedTier} · ${modelText}` : modelText

                    return (
                      <box
                        key={`file-${item.id}`}
                        width="100%"
                        height={1}
                        flexDirection="row"
                        backgroundColor={rowBg}
                        onMouseDown={(_self, event) => {
                          event.stopPropagation()
                          setActivePane("list")
                          if (isFocused) openModelOrFlowsAction()
                          else setFocusedIndex(globalIndex)
                        }}
                      >
                        <box
                          width={columnWidth(0)}
                          height={1}
                          flexDirection="row"
                          overflow="hidden"
                          onMouseDown={(_self, event) => {
                            event.stopPropagation()
                            setActivePane("list")
                            setFocusedIndex(globalIndex)
                            toggleSelectionAtPath(ag.currentPath)
                          }}
                        >
                          <text width={1} wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
                            {isFocused ? "▎" : " "}
                          </text>
                          <text width={1} wrapMode="none">{" "}</text>
                          <text
                            width={3}
                            wrapMode="none"
                            style={{
                              textColor: isSelected
                                ? THEME.accentGreen
                                : hasWarn
                                  ? THEME.accentAmber
                                  : isFocused
                                    ? "#ffffff"
                                    : THEME.fgMuted,
                            }}
                            b={isSelected}
                          >
                            {isSelected ? "[X]" : "[ ]"}
                          </text>
                        </box>
                        {gutter(`tree-${item.id}-1`)}
                        <box width={columnWidth(1)} height={1} flexDirection="row" overflow="hidden">
                          <text height={1} flexShrink={0} wrapMode="none" style={{ textColor: dotHex }} b>
                            {"  ● "}
                          </text>
                          <text
                            height={1}
                            wrapMode="none"
                            overflow="hidden"
                            style={{ textColor: isFocused ? "#ffffff" : THEME.fgPrimary }}
                            b={isFocused}
                          >
                            {middleEllipsis(`${terminalSafeText(shortName)}${isOverridden ? " ✎" : ""}${hasWarn ? " ⚠" : ""}`, Math.max(4, columnWidth(1) - 4))}
                          </text>
                        </box>
                        {gutter(`tree-${item.id}-2`)}
                        <text
                          width={columnWidth(2)}
                          wrapMode="none"
                          overflow="hidden"
                          style={{
                            textColor: isModelInvalid
                              ? THEME.accentRed
                              : isFocused
                                ? THEME.accentCyan
                                : THEME.fgSecondary,
                          }}
                        >
                          {middleEllipsis(rightText, columnWidth(2))}
                        </text>
                      </box>
                    )
                  })
                )}
              </box>
            </box>

            {/* Compact Catalog Status Footer */}
            <box
              width="100%"
              height={1}
              flexShrink={0}
              justifyContent="space-between"
              flexDirection="row"
              overflow="hidden"
            >
              <text width={footerFirstWidth} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: selectedPacks.length > 0 ? THEME.accentGreen : THEME.fgMuted }}>
                {middleEllipsis(
                  [
                    selectedPacks.length > 0 ? `${selectedPacks.length} pack${selectedPacks.length === 1 ? "" : "s"} selected` : activeItems.length ? `Row ${focusedIndex + 1}/${activeItems.length}` : "Empty",
                    selectedAgentPaths.size > 0 ? `${selectedAgentPaths.size} agents marked` : "",
                  ].filter(Boolean).join(" · "),
                  footerFirstWidth,
                )}
              </text>
              <text width={footerSecondWidth} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: invalidModelGroups.length > 0 ? THEME.accentAmber : THEME.fgMuted }}>
                {middleEllipsis(
                  selectedPacks.length > 0
                    ? "[E] Install · [Esc] Clear"
                    : invalidModelGroups.length > 0
                    ? `⚠ ${invalidModelGroups.length} invalid model group(s) [V]`
                    : "Click [ ] to mark · Click twice to edit",
                  footerSecondWidth,
                )}
              </text>
            </box>
          </box>

          {layout.showInspector && (
            <>
              {/* Draggable Split Divider */}
              <box
                width={panelWidths.gutter}
                height="100%"
                justifyContent="center"
                alignItems="center"
                onMouseDrag={(_self, event) => {
                  const usable = Math.max(40, termWidth - 2)
                  const rawRatio = ((event as any).x - 1) / usable
                  const clamped = Math.max(0.60, Math.min(0.75, Math.round(rawRatio * 100) / 100))
                  setLayoutDraft(clamped)
                  setAppliedShare(clamped)
                }}
                onMouseDragEnd={() => {
                  if (!configReadOnly) {
                    try {
                      const rev = saveUiConfig(engineConfigDir(), appliedShare, uiConfigRevisionState, { reducedMotion: reducedMotionState })
                      setUiConfigRevision(rev)
                    } catch {
                      // Ignore drag-end persistence lock collision
                    }
                  }
                }}
              >
                <text style={{ textColor: THEME.borderSubtle }}>│</text>
              </box>

              {/* Right Side: 6-Tab Inspector */}
              <box
                width={panelWidths.inspector}
                flexGrow={0}
                minHeight={0}
                border={true}
                borderStyle="rounded"
                borderColor={catalogInspectorBorder}
                backgroundColor={hasOverlayModal ? THEME.bgPanelDimmed : THEME.bgPanel}
                title={effectivePane === "inspector" ? " ● Inspector · ◀/▶ Tab " : " Inspector · ⇧→ "}
                titleColor={effectivePane === "inspector" ? THEME.accentPurple : THEME.fgSecondary}
                flexDirection="column"
                paddingLeft={1}
                paddingRight={1}
                overflow="hidden"
                onMouseDown={() => setActivePane("inspector")}
                onMouseScroll={(_self, event) => {
                  const dir = (event as any).scroll?.direction
                  if (!dir) return
                  const delta = dir === "down" ? 2 : -2
                  if (inspectorTab === "overview" && currentItem) {
                    const mdText = currentItem.type === "file" && currentItem.agent
                      ? (currentItem.agent.description || "No description provided.")
                      : packDescription(currentItem.category)
                    const total = layoutMarkdownDocument(mdText, Math.max(16, panelWidths.inspector - 8)).length
                    const page = Math.max(2, maxVisibleItems - (currentItem.type === "file" ? 7 : 6))
                    setOverviewScrollOffset(off => Math.max(0, Math.min(Math.max(0, total - page), off + delta)))
                  } else if (inspectorTab === "prompt" && currentItem?.agent) {
                    const body = extractFrontmatter(currentItem.agent.rawContent).body.trim() || "*Empty system prompt body.*"
                    const total = layoutMarkdownDocument(body, Math.max(16, panelWidths.inspector - 8)).length
                    const page = Math.max(1, wsViewports.promptRows - 1)
                    setPromptScrollOffset(off => Math.max(0, Math.min(Math.max(0, total - page), off + delta)))
                  } else if (inspectorTab === "resources") {
                    setResourceScrollIndex(off => Math.max(0, Math.min(Math.max(0, resourceInspectorLines.length - resourceInspectorPageSize), off + delta)))
                  } else if (inspectorTab === "security" || inspectorTab === "delegations") {
                    const ag = currentItem?.agent
                    const hasErr = Boolean(ag && inspectorTab === "security" && analyzePermissionOrder(ag).hasOrderError)
                    const secViewport = calculateWorkspaceViewports(termHeight, { hasSecurityOrderError: hasErr })
                    const pageSize = inspectorTab === "security" ? secViewport.securityRows : secViewport.delegationsInspectorRows
                    const total = inspectorTab === "security"
                      ? Object.keys(ag?.frontmatter.permission || {}).filter(k => k !== "task").length
                      : (ag?.allowedSubagents || []).length
                    setGraphScrollOffset(off => Math.max(0, Math.min(Math.max(0, total - pageSize), off + delta)))
                  }
                }}
              >
                {/* Clickable 6-Tab Navigation Bar (only when an Agent is focused) */}
                {currentItem?.type === "file" && currentItem.agent && (
                  <box
                    flexDirection="row"
                    width="100%"
                    height={2}
                    borderStyle="single"
                    border={["bottom"]}
                    borderColor={THEME.borderSubtle}
                    alignItems="center"
                    overflow="hidden"
                  >
                    {(
                      [
                        ["overview", "1. Info", THEME.accentCyan],
                        ["prompt", "2. Prompt", THEME.accentBlue],
                        ["naming", "3. Name", THEME.accentAmber],
                        ["security", "4. Sec", THEME.accentRed],
                        ["delegations", "5. Graph", THEME.accentGreen],
                        ["resources", "6. Res", THEME.accentPurple],
                      ] as const
                    ).map(([tKey, tLabel, tColor], idx) => {
                      const active = inspectorTab === tKey
                      return (
                        <React.Fragment key={tKey}>
                          {idx > 0 && <text wrapMode="none" style={{ textColor: THEME.borderSubtle }}>{" "}</text>}
                          <box
                            height={1}
                            paddingLeft={panelWidths.inspector >= 56 ? 1 : 0}
                            paddingRight={panelWidths.inspector >= 56 ? 1 : 0}
                            backgroundColor={active ? THEME.bgPillActive : "transparent"}
                            onMouseDown={(_self, event) => {
                              event.stopPropagation()
                              setActivePane("inspector")
                              setInspectorTab(tKey)
                              if (tKey === "security" || tKey === "delegations") setGraphScrollOffset(0)
                              if (tKey === "resources") setResourceScrollIndex(0)
                            }}
                          >
                            <text wrapMode="none" style={{ textColor: active ? tColor : THEME.fgSecondary }} b={active}>
                              {panelWidths.inspector >= 46 ? tLabel : tLabel.replace(/^\d\.\s/, "")}
                            </text>
                          </box>
                        </React.Fragment>
                      )
                    })}
                  </box>
                )}

                {currentItem ? (
                  <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden" marginTop={1}>
                    {currentItem.type === "file" && currentItem.agent ? (
                      <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
                        {(() => {
                          const ag = currentItem.agent
                          const dotHex = resolveAgentHexColor(ag.frontmatter.color)
                          const permSummary = getAgentPermissionSummary(ag)
                          const shortName = agentId(ag)
                          const isOverridden = userOverridesSummary.overriddenAgents.has(`${ag.category}/${shortName}`)
                          const riskColor = permSummary.riskLevel === "HIGH"
                            ? THEME.accentRed
                            : permSummary.riskLevel === "MEDIUM"
                              ? THEME.accentAmber
                              : THEME.accentGreen

                          return (
                            <box flexDirection="row" justifyContent="space-between" width="100%" flexShrink={0}>
                              <box flexDirection="row" overflow="hidden" flexShrink={1}>
                                <text style={{ textColor: dotHex }} b>{"● "}</text>
                                <text wrapMode="none" overflow="hidden" style={{ textColor: "#ffffff" }} b>
                                  {middleEllipsis(terminalSafeText(shortName), Math.max(12, panelWidths.inspector - 18))}
                                </text>
                                {isOverridden && (
                                  <text wrapMode="none" style={{ textColor: THEME.accentPurple }}>{" ✎"}</text>
                                )}
                              </box>
                              <text wrapMode="none" flexShrink={0} style={{ textColor: riskColor }} b>
                                {`${permSummary.riskLevel}`}
                              </text>
                            </box>
                          )
                        })()}

                        {/* TAB 1: OVERVIEW */}
                        {inspectorTab === "overview" && (() => {
                          const ag = currentItem.agent
                          const inspInner = Math.max(18, panelWidths.inspector - 4)
                          const stepsNum = resolveAgentSteps(ag.frontmatter)
                          const modeText = `${resolveAgentTuningMode(ag.frontmatter.mode)}${ag.frontmatter.hidden ? " · hidden" : ""}`
                          const gaugeW = Math.max(6, Math.min(12, inspInner - 28))
                          const effortText = terminalSafeText(`${String(ag.frontmatter.variant ?? "default")}${ag.frontmatter.reasoningEffort ?? ag.frontmatter.options?.reasoningEffort ? ` (${String(ag.frontmatter.reasoningEffort ?? ag.frontmatter.options?.reasoningEffort)})` : ""}`)

                          return (
                            <box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0} overflow="hidden">
                              <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
                                <text height={1} style={{ textColor: THEME.fgSecondary }}>Pack</text>
                                <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentAmber }} b>
                                  {middleEllipsis(terminalSafeText(ag.category), Math.max(10, inspInner - 8))}
                                </text>
                              </box>

                              <box
                                height={1}
                                flexShrink={0}
                                flexDirection="row"
                                justifyContent="space-between"
                                onMouseDown={(_self, event) => {
                                  event.stopPropagation()
                                  openModelOrFlowsAction()
                                }}
                              >
                                <text height={1} style={{ textColor: THEME.fgSecondary }}>Model [M]</text>
                                <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentCyan }} u>
                                  {middleEllipsis(modelDisplayValue(ag, false, modelCatalog), Math.max(10, inspInner - 12))}
                                </text>
                              </box>

                              <box
                                height={1}
                                flexShrink={0}
                                flexDirection="row"
                                justifyContent="space-between"
                                onMouseDown={(_self, event) => {
                                  event.stopPropagation()
                                  openTuningModalAction()
                                }}
                              >
                                <text height={1} style={{ textColor: THEME.fgSecondary }}>Effort [T]</text>
                                <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: ag.frontmatter.variant ? THEME.accentPurple : THEME.fgMuted }}>
                                  {middleEllipsis(effortText, Math.max(10, inspInner - 12))}
                                </text>
                              </box>

                              <box
                                height={1}
                                flexShrink={0}
                                flexDirection="row"
                                justifyContent="space-between"
                                onMouseDown={(_self, event) => {
                                  event.stopPropagation()
                                  openTuningModalAction()
                                }}
                              >
                                <text height={1} style={{ textColor: THEME.fgSecondary }}>Mode [T]</text>
                                <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: ag.frontmatter.hidden ? THEME.accentRed : THEME.accentAmber }}>
                                  {middleEllipsis(modeText, Math.max(10, inspInner - 12))}
                                </text>
                              </box>

                              <box
                                height={1}
                                flexShrink={0}
                                flexDirection="row"
                                justifyContent="space-between"
                                onMouseDown={(_self, event) => {
                                  event.stopPropagation()
                                  openTuningModalAction()
                                }}
                              >
                                <text height={1} style={{ textColor: THEME.fgSecondary }}>Steps</text>
                                <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentBlue }}>
                                  {`${gaugeBar(Math.min(1, Math.max(0, stepsNum / 100)), gaugeW)} ${stepsNum}`}
                                </text>
                              </box>

                              <box
                                flexDirection="column"
                                marginTop={1}
                                flexGrow={1}
                                minHeight={0}
                                border={true}
                                borderStyle="rounded"
                                borderColor={THEME.borderSubtle}
                                backgroundColor={THEME.bgInput}
                                paddingLeft={1}
                                paddingRight={1}
                                overflow="hidden"
                              >
                                <PromptMarkdownView
                                  markdown={ag.description || "No description provided."}
                                  width={Math.max(16, panelWidths.inspector - 8)}
                                  maxRows={Math.max(2, maxVisibleItems - 7)}
                                  scrollOffset={overviewScrollOffset}
                                  showFooter={false}
                                />
                              </box>
                            </box>
                          )
                        })()}

                        {/* TAB 2: MARKDOWN PROMPT PREVIEW */}
                        {inspectorTab === "prompt" && (() => {
                          const rawBody = extractFrontmatter(currentItem.agent.rawContent).body.trim()
                          const mdBody = rawBody || "*Empty system prompt body.*"
                          const promptInnerWidth = Math.max(16, panelWidths.inspector - 8)
                          const promptMaxRows = wsViewports.promptRows
                          return (
                            <box
                              flexDirection="column"
                              marginTop={1}
                              flexGrow={1}
                              minHeight={0}
                              border={true}
                              borderStyle="rounded"
                              borderColor={THEME.borderSubtle}
                              backgroundColor={THEME.bgInput}
                              paddingLeft={1}
                              paddingRight={1}
                              overflow="hidden"
                            >
                              <PromptMarkdownView
                                markdown={mdBody}
                                width={promptInnerWidth}
                                maxRows={promptMaxRows}
                                scrollOffset={promptScrollOffset}
                                onScrollDelta={delta => {
                                  const total = layoutMarkdownDocument(mdBody, promptInnerWidth).length
                                  setPromptScrollOffset(off => Math.max(0, Math.min(Math.max(0, total - promptMaxRows), off + delta)))
                                }}
                              />
                            </box>
                          )
                        })()}

                        {/* TAB 3: NAMING CONVENTION */}
                        {inspectorTab === "naming" && (
                          <box flexDirection="column" marginTop={1} flexGrow={1}>
                            {(() => {
                              const analysis = analyzeAgentName(currentItem.agent.filename, allAgentFilenames)
                              return (
                                <box
                                  flexDirection="column"
                                  border={true}
                                  borderStyle="rounded"
                                  borderColor={THEME.borderSubtle}
                                  backgroundColor={THEME.bgInput}
                                  padding={1}
                                  flexGrow={1}
                                >
                                  <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                                    <text style={{ textColor: THEME.fgPrimary }} b>Filename style</text>
                                    <text style={{ textColor: analysis.isValid ? THEME.accentGreen : THEME.fgSecondary }} b>
                                      {analysis.isValid ? "Role convention" : "Custom"}
                                    </text>
                                  </box>
                                  <box flexDirection="row" marginTop={1}>
                                    <text style={{ textColor: THEME.fgSecondary }} width="35%">Family:</text>
                                    <text style={{ textColor: THEME.accentCyan }}>{middleEllipsis(analysis.family || "(none)", 30)}</text>
                                  </box>
                                  <box flexDirection="row">
                                    <text style={{ textColor: THEME.fgSecondary }} width="35%">Pack:</text>
                                    <text style={{ textColor: THEME.accentAmber }}>{middleEllipsis(currentItem.category, 30)}</text>
                                  </box>
                                  <box flexDirection="row">
                                    <text style={{ textColor: THEME.fgSecondary }} width="35%">Role:</text>
                                    <text style={{ textColor: THEME.fgPrimary }}>{middleEllipsis(analysis.role || "(none)", 30)}</text>
                                  </box>
                                  {!analysis.isValid && analysis.suggestedName && (
                                    <box flexDirection="column" marginTop={1}>
                                      <text style={{ textColor: THEME.fgSecondary }}>Suggested Name:</text>
                                      <text style={{ textColor: THEME.accentGreen }} b>{middleEllipsis(analysis.suggestedName, 40)}</text>
                                    </box>
                                  )}
                                  {!isReadOnlyGitSource && (
                                    <text
                                      style={{ textColor: THEME.accentCyan }}
                                      marginTop={1}
                                      u
                                      onMouseDown={(_self, event) => {
                                        event.stopPropagation()
                                        executeActionById("agent-rename")
                                      }}
                                    >
                                      [R] Open Rename Assistant
                                    </text>
                                  )}
                                </box>
                              )
                            })()}
                          </box>
                        )}

                        {/* TAB 4: SECURITY MATRIX */}
                        {inspectorTab === "security" && (
                          <box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0}>
                            {(() => {
                              const orderCheck = analyzePermissionOrder(currentItem.agent)
                              const perm = currentItem.agent.frontmatter.permission || {}
                              const permissionEntries = Object.entries(perm).filter(([k]) => k !== "task")
                              const permissionPageSize = calculateWorkspaceViewports(termHeight, { hasSecurityOrderError: orderCheck.hasOrderError }).securityRows

                              return (
                                <box
                                  flexDirection="column"
                                  border={true}
                                  borderStyle="rounded"
                                  borderColor={THEME.borderSubtle}
                                  backgroundColor={THEME.bgInput}
                                  padding={1}
                                  flexGrow={1}
                                  overflow="hidden"
                                >
                                  <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                                    <text style={{ textColor: THEME.fgPrimary }} b>Permissions</text>
                                    <text
                                      style={{ textColor: THEME.accentCyan }}
                                      u
                                      onMouseDown={(_self, event) => {
                                        event.stopPropagation()
                                        executeActionById("agent-permissions")
                                      }}
                                    >
                                      [P] Preset
                                    </text>
                                  </box>

                                  {orderCheck.hasOrderError && (
                                    <box flexDirection="column" marginTop={1} backgroundColor={THEME.bgDangerSoft} paddingLeft={1} paddingRight={1}>
                                      <text style={{ textColor: THEME.accentRed }} b>⚠ Wildcard "*": "deny" must be first!</text>
                                      <text style={{ textColor: THEME.accentAmber }} u>[Press SHIFT+F to fix order]</text>
                                    </box>
                                  )}

                                  <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
                                    {permissionEntries.slice(graphScrollOffset, graphScrollOffset + permissionPageSize).map(([k, val]) => {
                                      const valStr = typeof val === "object" ? JSON.stringify(val) : String(val)
                                      const safeKey = middleEllipsis(k, Math.max(10, Math.floor((panelWidths.inspector - 8) * 0.48)))
                                      const safeVal = middleEllipsis(valStr, Math.max(10, Math.floor((panelWidths.inspector - 8) * 0.48)))
                                      const isDanger = k === "bash" && (val === "allow" || val === true || valStr.includes("allow"))
                                      return (
                                        <box key={k} flexDirection="row" justifyContent="space-between">
                                          <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>{safeKey}</text>
                                          <text wrapMode="none" overflow="hidden" style={{ textColor: isDanger ? THEME.accentRed : valStr.includes("deny") ? THEME.fgMuted : THEME.accentCyan }}>{safeVal}</text>
                                        </box>
                                      )
                                    })}
                                  </box>
                                  {permissionEntries.length > permissionPageSize && (
                                    <text style={{ textColor: THEME.fgMuted }} flexShrink={0}>
                                      {`▲ ${graphScrollOffset + 1}-${Math.min(graphScrollOffset + permissionPageSize, permissionEntries.length)}/${permissionEntries.length} ▼ (scroll)`}
                                    </text>
                                  )}
                                </box>
                              )
                            })()}
                          </box>
                        )}

                        {/* TAB 5: DELEGATIONS GRAPH */}
                        {inspectorTab === "delegations" && (
                          <box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0}>
                            {(() => {
                              const allowed = currentItem.agent.allowedSubagents || []
                              const delInspectorPageSize = wsViewports.delegationsInspectorRows
                              return (
                                <box flexDirection="column" flexGrow={1} minHeight={0}>
                                  <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                                    <text style={{ textColor: THEME.fgSecondary }}>{`Authorized (${allowed.length})`}</text>
                                    <text
                                      style={{ textColor: THEME.accentCyan }}
                                      u
                                      onMouseDown={(_self, event) => {
                                        event.stopPropagation()
                                        executeActionById("agent-delegations")
                                      }}
                                    >
                                      [G] Edit
                                    </text>
                                  </box>

                                  <box
                                    border={true}
                                    borderStyle="rounded"
                                    borderColor={THEME.borderSubtle}
                                    backgroundColor={THEME.bgInput}
                                    padding={1}
                                    marginTop={1}
                                    flexGrow={1}
                                    overflow="hidden"
                                  >
                                    {allowed.length > 0 ? (
                                      allowed.slice(graphScrollOffset, graphScrollOffset + delInspectorPageSize).map((subName, sliceIdx) => {
                                        const absIdx = graphScrollOffset + sliceIdx
                                        const isSubFocused = effectivePane === "inspector" && absIdx === catalogDelFocus
                                        const targetAg = agents.find((a) => agentId(a) === subName)
                                        return (
                                          <box
                                            key={subName}
                                            flexDirection="row"
                                            justifyContent="space-between"
                                            backgroundColor={isSubFocused ? THEME.bgRowFocus : "transparent"}
                                            onMouseDown={(_self, event) => {
                                              event.stopPropagation()
                                              setActivePane("inspector")
                                              setCatalogDelFocus(absIdx)
                                              if (targetAg) jumpToCatalogAgent(targetAg.currentPath)
                                            }}
                                          >
                                            <text
                                              wrapMode="none"
                                              overflow="hidden"
                                              style={{ textColor: isSubFocused ? "#ffffff" : targetAg ? THEME.accentCyan : THEME.accentRed }}
                                              b={isSubFocused}
                                            >
                                              {middleEllipsis(
                                                targetAg
                                                  ? `${isSubFocused ? "▎ " : ""}├─▶ @${subName}${isSubFocused ? " [Enter: Jump]" : ""}`
                                                  : `${isSubFocused ? "▎ " : ""}├─▶ ❌ @${subName} (Dead Ref)`,
                                                Math.max(14, panelWidths.inspector - 8),
                                              )}
                                            </text>
                                          </box>
                                        )
                                      })
                                    ) : (
                                      <text style={{ textColor: THEME.fgMuted }}>Leaf agent · no @subagents authorized.</text>
                                    )}
                                    {allowed.length > delInspectorPageSize && (
                                      <text style={{ textColor: THEME.fgMuted }} flexShrink={0}>
                                        {`▲ ${graphScrollOffset + 1}-${Math.min(graphScrollOffset + delInspectorPageSize, allowed.length)}/${allowed.length} ▼`}
                                      </text>
                                    )}
                                  </box>
                                </box>
                              )
                            })()}
                          </box>
                        )}

                        {/* TAB 6: RESOURCES */}
                        {inspectorTab === "resources" && (
                          <box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0} overflow="hidden">
                            {resourceInspector.error ? (
                              <text style={{ textColor: THEME.accentRed }}>{resourceInspector.error}</text>
                            ) : (
                              <>
                                <box
                                  flexDirection="column"
                                  flexGrow={1}
                                  minHeight={0}
                                  border={true}
                                  borderStyle="rounded"
                                  borderColor={THEME.borderSubtle}
                                  backgroundColor={THEME.bgInput}
                                  paddingLeft={1}
                                  paddingRight={1}
                                  overflow="hidden"
                                >
                                  {resourceInspectorLines.slice(resourceScrollIndex, resourceScrollIndex + resourceInspectorPageSize).map((line, index) => (
                                    <text
                                      key={`${resourceScrollIndex}-${index}`}
                                      style={{
                                        textColor: line.startsWith("---")
                                          ? THEME.accentAmber
                                          : line.includes("[DENY]") || line.includes("[Dead Ref]")
                                            ? THEME.accentRed
                                            : line.includes("[ALLOW]")
                                              ? THEME.accentGreen
                                              : THEME.fgPrimary,
                                      }}
                                      wrapMode="none"
                                      overflow="hidden"
                                    >
                                      {middleEllipsis(line, Math.max(1, panelWidths.inspector - 6))}
                                    </text>
                                  ))}
                                </box>
                                <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                                  <text
                                    style={{ textColor: THEME.accentCyan }}
                                    u
                                    onMouseDown={(_self, event) => {
                                      event.stopPropagation()
                                      executeActionById("agent-resources")
                                    }}
                                  >
                                    [U] Edit Skills, Tools &amp; MCP
                                  </text>
                                  {resourceInspectorLines.length > resourceInspectorPageSize && (
                                    <text style={{ textColor: THEME.fgMuted }}>
                                      {`${resourceScrollIndex + 1}/${resourceInspectorLines.length}`}
                                    </text>
                                  )}
                                </box>
                              </>
                            )}
                          </box>
                        )}
                      </box>
                    ) : currentItem.type === "asset" ? (
                      <AssetItemInspector
                        asset={currentItem.asset}
                        pack={catalogIndex.byName.get(currentItem.category)}
                        inspectorWidth={panelWidths.inspector}
                        scrollOffset={overviewScrollOffset}
                        maxRows={maxVisibleItems}
                      />
                    ) : (
                      (() => {
                        const packEntry = catalogIndex.byName.get(currentItem.category)
                        if (!packEntry) {
                          return (
                            <box flexDirection="column">
                              <text style={{ textColor: THEME.fgSecondary }}>Pack metadata unavailable.</text>
                            </box>
                          )
                        }
                        return (
                          <PackInspector
                            pack={packEntry}
                            focusedSection={currentItem.type === "section" ? currentItem.assetKind : null}
                            targetStatusInfo={targetStatusInfo}
                            isReadOnlyGitSource={isReadOnlyGitSource}
                            inspectorWidth={panelWidths.inspector}
                            scrollOffset={overviewScrollOffset}
                            maxRows={maxVisibleItems}
                            onInstallPack={packName => previewInstall([packName])}
                            onBridgeCheck={packName => runBridgeCheckAction(packName)}
                            onBridgeClaude={packName => openBridgeModalAction("claude", packName)}
                            onBridgeCodex={packName => openBridgeModalAction("codex", packName)}
                            onBridgeVibe={packName => openBridgeModalAction("vibe", packName)}
                            onCodexInstall={packName => openCodexInstallPreviewAction(packName)}
                            onOpenDoctor={() => openPackDoctorModal("doctor")}
                            onOpenScaffold={() => openPackDoctorModal("scaffold")}
                          />
                        )
                      })()
                    )}
                  </box>
                ) : (
                  <box flexGrow={1} justifyContent="center" alignItems="center">
                    <text style={{ textColor: THEME.fgSecondary }}>Select a pack or agent to inspect</text>
                  </box>
                )}
              </box>
            </>
          )}
        </box>
      )}

      {/* Slim Contextual Pill Footer */}
      {(() => {
        const footerBudget = Math.max(20, termWidth - 6)
        const isTailChip = (id: string) => id === "pane-toggle" || id === "palette" || id === "help"
        const tailChips = contextualChips.filter(c => isTailChip(c.actionId))
        const bodyChips = contextualChips.filter(c => !isTailChip(c.actionId))
        const chipWidth = (c: { key: string; label: string }) => displayWidth(c.key) + 1 + displayWidth(c.label) + 2
        const reservedTail = tailChips.reduce((s, c) => s + chipWidth(c) + 1, 0)
        let used = 0
        const fittedBody = bodyChips.filter(c => {
          const w = chipWidth(c) + (used > 0 ? 1 : 0)
          if (used + w + reservedTail <= footerBudget) {
            used += w
            return true
          }
          return false
        })

        return (
          <box
            width="100%"
            height={3}
            flexShrink={0}
            border={true}
            borderStyle="rounded"
            borderColor={THEME.borderSubtle}
            backgroundColor={hasOverlayModal ? THEME.bgPanelDimmed : THEME.bgPanel}
            paddingLeft={1}
            paddingRight={1}
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
            overflow="hidden"
          >
            <box flexDirection="row" alignItems="center" overflow="hidden" flexShrink={0}>
              {fittedBody.map((chip, index) => (
                <React.Fragment key={`${chip.key}-${chip.actionId}`}>
                  {index > 0 && (
                    <text height={1} wrapMode="none" flexShrink={0} style={{ textColor: THEME.borderSubtle }}>
                      {" "}
                    </text>
                  )}
                  <box
                    height={1}
                    paddingLeft={1}
                    paddingRight={1}
                    flexShrink={0}
                    backgroundColor={chip.accent ? THEME.bgPillActive : THEME.bgPill}
                    onMouseDown={() => executeActionById(chip.actionId)}
                  >
                    <box flexDirection="row">
                      <text height={1} wrapMode="none" style={{ textColor: chip.accent ? THEME.accentCyan : THEME.accentAmber }} b>
                        {chip.key}
                      </text>
                      <text height={1} wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
                        {` ${chip.label}`}
                      </text>
                    </box>
                  </box>
                </React.Fragment>
              ))}
            </box>

            <box flexDirection="row" alignItems="center" overflow="hidden" flexShrink={0}>
              {tailChips.map((chip, index) => (
                <React.Fragment key={`tail-${chip.key}-${chip.actionId}`}>
                  {index > 0 && (
                    <text height={1} wrapMode="none" flexShrink={0} style={{ textColor: THEME.borderSubtle }}>
                      {" "}
                    </text>
                  )}
                  <box
                    height={1}
                    paddingLeft={1}
                    paddingRight={1}
                    flexShrink={0}
                    backgroundColor={chip.accent ? THEME.bgPillActive : THEME.bgPill}
                    onMouseDown={() => executeActionById(chip.actionId)}
                  >
                    <box flexDirection="row">
                      <text height={1} wrapMode="none" style={{ textColor: chip.accent ? THEME.accentCyan : THEME.accentAmber }} b>
                        {chip.key === "Ctrl+K" ? "⌘K" : chip.key}
                      </text>
                      <text height={1} wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
                        {` ${chip.label}`}
                      </text>
                    </box>
                  </box>
                </React.Fragment>
              ))}
            </box>
          </box>
        )
      })()}

      {viewMode === "layout" && (
        <box
          style={{ position: "absolute", left: "14%", top: "24%", width: "72%", height: "48%" }}
          zIndex={45}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.accentCyan}
          backgroundColor={THEME.bgElevated}
          title=" Split Layout & Motion "
          titleColor={THEME.accentCyan}
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
        >
          <box flexDirection="column" overflow="hidden">
            <text style={{ textColor: THEME.fgPrimary }} b>
              Adjust Catalog / Inspector split (or drag the center divider with the mouse)
            </text>
            <text style={{ textColor: THEME.accentCyan }} marginTop={1} b>
              {`Left ${Math.round(layoutDraft * 100)}%   │   Right ${Math.round((1 - layoutDraft) * 100)}%`}
            </text>
            <text style={{ textColor: THEME.accentBlue }} marginTop={1} wrapMode="none" overflow="hidden">
              {fractionalBar((layoutDraft - 0.60) / 0.15, Math.min(40, Math.max(16, termWidth - 28)), "─")}
            </text>
            {configReadOnly && (
              <text style={{ textColor: THEME.accentAmber }} marginTop={1}>
                Environment override is read-only: preview only; Enter will not save.
              </text>
            )}
            {layoutError && (
              <text style={{ textColor: THEME.accentRed }} marginTop={1} wrapMode="none" overflow="hidden">
                {layoutError}
              </text>
            )}
          </box>
          <box borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} flexDirection="row" justifyContent="space-between">
            <text style={{ textColor: THEME.fgSecondary }}>←/→ or h/l adjust · Home 60% · End 75% · R reset</text>
            <text style={{ textColor: THEME.accentGreen }} b>[ENTER] Save · [ESC] Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Permission Presets */}
      {viewMode === "permission-preset" && (
        <box
          style={{ position: "absolute", left: "10%", top: "10%", width: "80%", height: "80%" }}
          zIndex={45}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.borderDanger}
          backgroundColor={THEME.bgElevated}
          title=" Apply Safety Preset "
          titleColor={THEME.accentRed}
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column">
            <text style={{ textColor: THEME.fgPrimary }} paddingBottom={1}>
              Select safety preset to apply to {selectedAgentPaths.size > 0 ? selectedAgentPaths.size : 1} agent(s):
            </text>
            <box flexDirection="column" marginTop={1}>
              {SAFETY_PRESETS.map((preset, idx) => {
                const isFocused = idx === focusedPresetIndex
                return (
                  <box
                    key={preset.key}
                    backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                    padding={1}
                    flexDirection="column"
                    marginTop={idx > 0 ? 1 : 0}
                    onMouseDown={() => setFocusedPresetIndex(idx)}
                  >
                    <text style={{ textColor: isFocused ? "#FFFFFF" : THEME.accentAmber }} b>
                      {isFocused ? `▎ ${preset.name}` : `  ${preset.name}`}
                    </text>
                    <text style={{ textColor: THEME.fgSecondary }}>
                      {`   ${preset.description}`}
                    </text>
                  </box>
                )
              })}
            </box>
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} flexShrink={0}>
            <text style={{ textColor: THEME.fgSecondary }}>[↑/↓] Choose Preset · [ENTER] Apply</text>
            <text style={{ textColor: THEME.accentRed }} b onMouseDown={() => setViewMode("main")}>[ESC] Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Subagent Delegation Manager */}
      {viewMode === "delegation-manager" && delegationTargetAgent && (
        <box
          position="absolute"
          left={delegationViewport.left}
          top={delegationViewport.top}
          width={delegationViewport.modalWidth}
          height={delegationViewport.modalHeight}
          zIndex={45}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.accentBlue}
          backgroundColor={THEME.bgElevated}
          title={` Delegation Manager: ${middleEllipsis(delegationTargetAgent.filename, 45)} `}
          titleColor={THEME.accentBlue}
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
          onMouseScroll={(_self, event) => {
            const dir = (event as any).scroll?.direction
            if (!dir) return
            const delta = dir === "down" ? 2 : -2
            setDelegationScrollOffset(off => Math.max(0, Math.min(Math.max(0, delegationItems.length - maxVisibleDelegations), off + delta)))
          }}
        >
          <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }} flexShrink={0}>
              Toggle @subagents authorized for invocation (click row or press Space):
            </text>

            <box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0} overflow="hidden">
              {visibleDelegationItems.map((ag, offsetIdx) => {
                const idx = delegationScrollOffset + offsetIdx
                const subName = agentId(ag)
                const isSelected = selectedDelegations.has(subName)
                const isFocused = idx === focusedDelegationIndex

                return (
                  <box
                    key={ag.currentPath}
                    backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                    paddingLeft={1}
                    height={1}
                    flexShrink={0}
                    flexDirection="row"
                    onMouseDown={() => {
                      setFocusedDelegationIndex(idx)
                      setSelectedDelegations(prev => {
                        const next = new Set(prev)
                        if (next.has(subName)) next.delete(subName)
                        else next.add(subName)
                        return next
                      })
                    }}
                  >
                    <text style={{ textColor: isSelected ? THEME.accentGreen : THEME.fgMuted }} width="8%" b={isSelected}>
                      {isSelected ? "[X]" : "[ ]"}
                    </text>
                    <text wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#FFFFFF" : THEME.fgPrimary }} width="50%">
                      {middleEllipsis(subName, Math.max(12, Math.floor(delegationViewport.innerWidth * 0.48)))}
                    </text>
                    <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentAmber }} width="20%">
                      {middleEllipsis(ag.category, 15)}
                    </text>
                    <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }} width="22%">
                      {middleEllipsis(ag.model.split("/").pop() || "", 15)}
                    </text>
                  </box>
                )
              })}
            </box>
          </box>

          <box flexDirection="row" justifyContent="space-between" borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} flexShrink={0} overflow="hidden">
            <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
              {middleEllipsis(
                `${delegationItems.length > maxVisibleDelegations ? `▲ ${delegationScrollOffset + 1}-${Math.min(delegationScrollOffset + maxVisibleDelegations, delegationItems.length)}/${delegationItems.length} ▼ · ` : ""}[↑/↓] Nav · [Space] Toggle · [Enter] Save`,
                Math.max(16, delegationViewport.innerWidth - 15),
              )}
            </text>
            <text height={1} wrapMode="none" flexShrink={0} style={{ textColor: THEME.accentRed }} b onMouseDown={() => setViewMode("main")}>
              [ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {viewMode === "resource-manager" && resourceCatalog && (
        <box
          position="absolute"
          left={resourceViewport.left}
          top={resourceViewport.top}
          width={resourceViewport.modalWidth}
          height={resourceViewport.modalHeight}
          zIndex={45}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.accentPurple}
          backgroundColor={THEME.bgElevated}
          title={` Resource Manager: ${middleEllipsis(resourceTargetAgent?.filename ?? "", 38)} `}
          titleColor={THEME.accentPurple}
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
          onMouseScroll={(_self, event) => {
            const dir = (event as any).scroll?.direction
            if (!dir) return
            const delta = dir === "down" ? 2 : -2
            setResourceModalScrollOffset(off => Math.max(0, Math.min(Math.max(0, resourceManagerRows.length - maxVisibleResourceRows), off + delta)))
          }}
        >
          <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            <text style={{ textColor: THEME.fgPrimary }} flexShrink={0}>
              Toggle skills, custom tools and MCP servers this agent may use:
            </text>
            <box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0} overflow="hidden">
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
                const tag = row.kind === "skill-wildcard" || row.kind === "skill" ? "SKILL"
                  : row.kind === "tool-family" ? "TOOL-GRP"
                    : row.kind === "tool" ? "TOOL" : "MCP"
                const mcpItem = agentResource as AgentMcpResourceItem
                const status = row.kind === "mcp"
                  ? mcpItem.configuredInOpencode
                    ? ` [MCP: ${mcpItem.serverEnabled ? "ON" : "OFF"}]`
                    : mcpItem.recommendedInRepo ? " [declared]" : " [undeclared]"
                  : ""
                return (
                  <box
                    key={`${item.id}-${rowIndex}`}
                    backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                    height={1}
                    flexShrink={0}
                    flexDirection="row"
                    onMouseDown={() => setResourceModalFocusIndex(rowIndex)}
                  >
                    <text width={6} style={{ textColor: allowed ? THEME.accentGreen : THEME.fgMuted }} b={Boolean(allowed)}>
                      {allowed ? " [X]" : " [ ]"}
                    </text>
                    <text width={11} style={{ textColor: THEME.accentPurple }}>{tag}</text>
                    <text flexGrow={1} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#ffffff" : THEME.fgPrimary }} b={isFocused}>
                      {middleEllipsis(item.name, Math.max(1, panelWidths.inspector + panelWidths.list - 42))}
                    </text>
                    <text style={{ textColor: row.kind === "mcp" && mcpItem.configuredInOpencode && mcpItem.serverEnabled ? THEME.accentGreen : THEME.fgMuted }}>
                      {status}
                    </text>
                  </box>
                )
              })}
            </box>
          </box>
          <box flexDirection="row" justifyContent="space-between" flexShrink={0} borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} overflow="hidden">
            <text style={{ textColor: THEME.fgSecondary }} wrapMode="none" overflow="hidden">
              {`↑/↓ Navigate · Space Toggle · Enter Save${resourceManagerRows.length > maxVisibleResourceRows ? ` (${resourceModalScrollOffset + 1}/${resourceManagerRows.length})` : ""}`}
            </text>
            <text style={{ textColor: THEME.accentRed }} b onMouseDown={() => setViewMode("main")}>[ESC] Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Parameter Tuning */}
      {viewMode === "parameter-tuning" && (
        <ParameterTuningModal
          targetCount={tuningTargetPaths.length}
          singleTargetName={tuningAgents.length === 1 ? tuningAgents[0]?.filename : undefined}
          focusedField={tuningFocusedField}
          dirtyFields={tuningDirtyFields}
          summary={tuningSummary}
          steps={tuningSteps}
          variant={tuningVariant}
          mode={tuningMode}
          hidden={tuningHidden}
          variantChoices={tuningVariantChoices}
          hasModelSpecificVariants={Boolean(modelVariants && modelVariants.length > 0)}
          termWidth={termWidth}
          termHeight={termHeight}
          onFocusField={(next) => {
            setTuningVariantTyping(false)
            setTuningFocusedField(next)
          }}
          onStepDelta={adjustTuningSteps}
          onSelectVariant={(next) => {
            setTuningVariant(next)
            setTuningVariantTyping(false)
            markTuningDirty("variant")
          }}
          onSelectMode={(next) => {
            setTuningMode(next)
            markTuningDirty("mode")
          }}
          onSelectHidden={(next) => {
            setTuningHidden(next)
            markTuningDirty("hidden")
          }}
          onSave={submitTuningModal}
          onClose={() => setViewMode("main")}
        />
      )}

      {/* Modal - Rename Assistant */}
      {viewMode === "rename-prompt" && renameTargetAgent && (
        <box
          style={{ position: "absolute", left: "15%", top: "14%", width: "70%", height: "72%" }}
          zIndex={45}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.accentPurple}
          backgroundColor={THEME.bgElevated}
          title=" Rename Agent (Naming Convention) "
          titleColor={THEME.accentPurple}
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column" gap={1}>
            <box flexDirection="row">
              <text style={{ textColor: THEME.fgSecondary }} b>CURRENT FILE: </text>
              <text style={{ textColor: THEME.accentAmber }} b>{middleEllipsis(renameTargetAgent.filename, Math.max(1, Math.floor(termWidth * 0.7) - 18))}</text>
            </box>
            <text style={{ textColor: THEME.fgMuted }}>
              Convention: [family-]category-role_with_underscores.md
            </text>

            {/* Family Field */}
            <box
              flexDirection="row"
              justifyContent="space-between"
              height={3}
              border={true}
              borderStyle="rounded"
              borderColor={renameFocusedField === "family" ? THEME.accentPurple : THEME.borderSubtle}
              backgroundColor={THEME.bgInput}
              paddingLeft={1}
              paddingRight={1}
              onMouseDown={() => setRenameFocusedField("family")}
            >
              <box flexDirection="row" height={1}>
                <text style={{ textColor: renameFocusedField === "family" ? THEME.accentPurple : THEME.fgSecondary }} b>
                  {renameFocusedField === "family" ? "▎ Family" : "  Family"}
                </text>
                <text style={{ textColor: THEME.fgMuted }}>{"  optional"}</text>
              </box>
              <text style={{ textColor: renameFamily ? THEME.fgPrimary : THEME.fgMuted }} b={Boolean(renameFamily)}>
                {renameFamily ? `${terminalSafeText(renameFamily)}${renameFocusedField === "family" ? "▋" : ""}` : `e.g. flow${renameFocusedField === "family" ? "▋" : ""}`}
              </text>
            </box>

            {/* Category Field */}
            <box
              flexDirection="row"
              justifyContent="space-between"
              height={3}
              border={true}
              borderStyle="rounded"
              borderColor={renameFocusedField === "category" ? THEME.accentPurple : THEME.borderSubtle}
              backgroundColor={THEME.bgInput}
              paddingLeft={1}
              paddingRight={1}
              onMouseDown={() => setRenameFocusedField("category")}
            >
              <box flexDirection="row" height={1}>
                <text style={{ textColor: renameFocusedField === "category" ? THEME.accentPurple : THEME.fgSecondary }} b>
                  {renameFocusedField === "category" ? "▎ Category" : "  Category"}
                </text>
                <text style={{ textColor: THEME.fgMuted }}>{"  pack slug"}</text>
              </box>
              <text style={{ textColor: renameCategory ? THEME.fgPrimary : THEME.fgMuted }} b={Boolean(renameCategory)}>
                {renameCategory ? `${terminalSafeText(renameCategory)}${renameFocusedField === "category" ? "▋" : ""}` : `required${renameFocusedField === "category" ? "▋" : ""}`}
              </text>
            </box>

            {/* Role Field */}
            <box
              flexDirection="row"
              justifyContent="space-between"
              height={3}
              border={true}
              borderStyle="rounded"
              borderColor={renameFocusedField === "role" ? THEME.accentPurple : THEME.borderSubtle}
              backgroundColor={THEME.bgInput}
              paddingLeft={1}
              paddingRight={1}
              onMouseDown={() => setRenameFocusedField("role")}
            >
              <box flexDirection="row" height={1}>
                <text style={{ textColor: renameFocusedField === "role" ? THEME.accentPurple : THEME.fgSecondary }} b>
                  {renameFocusedField === "role" ? "▎ Role" : "  Role"}
                </text>
                <text style={{ textColor: THEME.fgMuted }}>{"  snake_case"}</text>
              </box>
              <text style={{ textColor: renameRole ? THEME.fgPrimary : THEME.fgMuted }} b={Boolean(renameRole)}>
                {renameRole ? `${terminalSafeText(renameRole)}${renameFocusedField === "role" ? "▋" : ""}` : `e.g. code_reviewer${renameFocusedField === "role" ? "▋" : ""}`}
              </text>
            </box>

            {/* Live Preview */}
            <box flexDirection="column" border={true} borderStyle="rounded" borderColor={THEME.borderSubtle} backgroundColor={THEME.bgInput} paddingLeft={1} paddingRight={1}>
              <text style={{ textColor: THEME.fgSecondary }}>Live Preview:</text>
              {(() => {
                const cleanRole = (renameRole || "role").trim().replace(/\s+/g, "_").replace(/-/g, "_")
                const cleanCategory = (renameCategory || "category").trim()
                const cleanFamily = renameFamily.trim()
                const candidate = cleanFamily
                  ? `${cleanFamily}-${cleanCategory}-${cleanRole}.md`
                  : `${cleanCategory}-${cleanRole}.md`
                let valid = Boolean(renameCategory.trim() && renameRole.trim())
                if (valid) {
                  try { sanitizeFilename(candidate) } catch { valid = false }
                }
                return (
                  <text style={{ textColor: valid ? THEME.accentGreen : THEME.accentAmber }} b>
                    {terminalSafeText(candidate)}
                  </text>
                )
              })()}
            </box>
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1}>
            <text style={{ textColor: THEME.fgSecondary }}>
              [TAB/↑/↓] Switch Fields · [ENTER] Confirm Rename
            </text>
            <text style={{ textColor: THEME.accentRed }} b onMouseDown={() => setViewMode("main")}>
              [ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {/* Modal - Model Selection */}
      {viewMode === "model-selector" || viewMode === "repair-selector" ? (
        <box
          position="absolute"
          left={modelViewport.left}
          top={modelViewport.top}
          width={modelViewport.modalWidth}
          height={modelViewport.modalHeight}
          zIndex={45}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.accentBlue}
          backgroundColor={THEME.bgElevated}
          title={viewMode === "repair-selector" ? ` Repair Model Group ${Number(repairGroupKey) + 1}/${invalidModelGroups.length} ` : routingPick?.kind === "trigger" ? " Select OR Triggers " : routingPick ? " Model Configuration " : " Select LLM Model "}
          titleColor={THEME.accentBlue}
          padding={1}
          flexDirection="column"
          overflow="hidden"
          onMouseScroll={(_self, event) => {
            const dir = (event as any).scroll?.direction
            if (!dir) return
            const delta = dir === "down" ? 2 : -2
            setModelScrollOffset(off => Math.max(0, Math.min(Math.max(0, modelTreeItems.length - maxVisibleModels), off + delta)))
          }}
        >
          <text height={2} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }} paddingBottom={1} flexShrink={0}>
            {middleEllipsis(
              viewMode === "repair-selector"
                ? `Choose replacement for ${JSON.stringify(invalidModelGroups[Number(repairGroupKey)]?.value)} (${invalidModelGroups[Number(repairGroupKey)]?.agents.length || 0} agents):`
                : routingPick?.kind === "trigger"
                  ? `When ${routingView ? callersLabel(routingView) : "callers"} run on (OR)${pendingTriggers.size > 0 ? `: [${[...pendingTriggers].join(" OR ")}]` : " · SPACE/TAB toggle, ENTER confirm"}:`
                  : routingPick?.kind === "roles"
                    ? `${routingPick.roles.map(role => `${routingArchetype}-${role}`).join(", ")} use (when ${routingView ? callersLabel(routingView) : "?"} runs on ${routingDraft ? formatTriggerLabel(routingDraft.triggers) : "?"}):`
                    : `Choose model to apply to ${selectedAgentPaths.size > 0 ? selectedAgentPaths.size : 1} target agent(s):`,
              modelModalInnerWidth,
            )}
          </text>
          <box
            height={1}
            flexShrink={0}
            backgroundColor={THEME.bgInput}
            paddingLeft={1}
            paddingRight={1}
          >
            <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: modelFilter ? THEME.accentCyan : THEME.fgSecondary }}>
              {middleEllipsis(modelFilter ? `🔍 ${modelFilter}▋ (${modelTreeItems.filter(item => item.type === "model").length} matches)` : "🔍 Type to filter providers & models...", modelModalInnerWidth - 2)}
            </text>
          </box>
          {viewMode === "repair-selector" && invalidModelGroups[Number(repairGroupKey)] && (
            <text height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: THEME.accentAmber }} marginTop={1}>
              {middleEllipsis(`Suggestions: ${suggestModels(invalidModelGroups[Number(repairGroupKey)].value, modelCatalog).join(", ") || "none (choose below)"}`, modelModalInnerWidth)}
            </text>
          )}

          <box flexGrow={1} minHeight={0} flexDirection="column" marginTop={1} overflow="hidden">
            {visibleModels.map((item, index) => {
              const globalIndex = modelScrollOffset + index
              const isFocused = globalIndex === focusedModelIndex
              const rowBg = isFocused ? THEME.bgRowFocus : "transparent"
              const textColor = isFocused
                ? "#FFFFFF"
                : item.type === "provider"
                  ? THEME.accentAmber
                  : THEME.fgPrimary

              return (
                <box
                  key={`${item.type}-${item.id}`}
                  backgroundColor={rowBg}
                  paddingLeft={1}
                  height={1}
                  flexShrink={0}
                  width="100%"
                  onMouseDown={() => {
                    setFocusedModelIndex(globalIndex)
                    if (item.type === "provider") {
                      setExpandedProviders(prev => {
                        const next = new Set(prev)
                        if (next.has(item.id)) next.delete(item.id)
                        else next.add(item.id)
                        return next
                      })
                    }
                  }}
                >
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor }} b={item.type === "provider" || isFocused}>
                    {middleEllipsis(isFocused && item.type === "model" ? `▎ ${item.label.trim()}` : item.label, modelModalInnerWidth)}
                  </text>
                </box>
              )
            })}
          </box>

          <box flexDirection="column" borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} flexShrink={0}>
            <text width="100%" height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
              {middleEllipsis(`${focusedModelIndex + 1}/${modelTreeItems.length} · ENTER confirm · ←/→ fold · CTRL+R reload · ESC cancel`, modelModalInnerWidth)}
            </text>
          </box>
        </box>
      ) : null}

      {/* Modal - Tier Selection */}
      {viewMode === "tier-selector" && translationConfig && (() => {
        const tiers = Object.keys(translationConfig.tiers)
        const targets = selectedAgentPaths.size > 0 ? agents.filter(a => selectedAgentPaths.has(a.currentPath)) : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
        const states = targets.map(a => resolvedAgents.get(a.currentPath)).filter((state): state is ReturnType<typeof resolveModelTarget> => Boolean(state))
        const current = new Set(states.map(s => `${s!.tier} (${s!.source})`))
        return (
          <box
            position="absolute"
            left={tierViewport.left}
            top={tierViewport.top}
            width={tierViewport.modalWidth}
            height={tierViewport.modalHeight}
            zIndex={45}
            border={true}
            borderStyle="rounded"
            borderColor={THEME.accentPurple}
            backgroundColor={THEME.bgElevated}
            title=" Assign Translation Tier "
            titleColor={THEME.accentPurple}
            padding={1}
            flexDirection="column"
            overflow="hidden"
            onMouseScroll={(_self, event) => {
              const dir = (event as any).scroll?.direction
              if (!dir) return
              const delta = dir === "down" ? 2 : -2
              setTierScrollOffset(off => Math.max(0, Math.min(Math.max(0, tiers.length - maxVisibleTiers), off + delta)))
            }}
          >
            <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentAmber }} flexShrink={0}>Role-based assignment: basename, not an individual file.</text>
            <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }} flexShrink={0}>{middleEllipsis(`Current: ${current.size > 1 ? `multiple tiers · ${Array.from(current).join(", ")}` : Array.from(current)[0] || "unknown"}`, tierViewport.innerWidth)}</text>
            <box flexGrow={1} minHeight={0} flexDirection="column" marginTop={1} overflow="hidden">
              {tiers.slice(tierScrollOffset, tierScrollOffset + maxVisibleTiers).map((tier, index) => {
                const tierIndex = tierScrollOffset + index
                const isFocused = tierIndex === focusedTierIndex
                const tierConfig = translationConfig.tiers[tier]
                return (
                  <box
                    key={tier}
                    flexDirection="column"
                    flexShrink={0}
                    onMouseDown={() => setFocusedTierIndex(tierIndex)}
                  >
                    <box height={1} backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"} paddingLeft={1}>
                      <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#ffffff" : THEME.accentCyan }} b={isFocused}>
                        {middleEllipsis(`${isFocused ? "▎ " : "  "}${tier} · Claude: ${tierConfig.claude.model} · Codex: ${tierConfig.codex.model}`, tierViewport.innerWidth)}
                      </text>
                    </box>
                    {isFocused && tierConfig.description && <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>{middleEllipsis(`   ${terminalSafeText(tierConfig.description)}`, tierViewport.innerWidth)}</text>}
                  </box>
                )
              })}
            </box>
            <box flexDirection="row" justifyContent="space-between" borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} flexShrink={0}>
              <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }} flexShrink={0}>[↑/↓] Select · [ENTER] Assign</text>
              <text height={1} wrapMode="none" style={{ textColor: THEME.accentRed }} b onMouseDown={() => setViewMode("main")}>[ESC] Cancel</text>
            </box>
          </box>
        )
      })()}

      {/* Modal - Conditional IF/OR Flows of any pack */}
      {(viewMode === "routing-configs" ||
        viewMode === "routing-editor" ||
        viewMode === "routing-callers" ||
        viewMode === "routing-tools" ||
        viewMode === "routing-permissions" ||
        viewMode === "routing-delegations") && (
        <PackFlowsModal
          packName={routingArchetype || ""}
          mode={viewMode}
          routingView={routingView}
          loadError={routingLoad.error}
          isReadOnlyGitSource={isReadOnlyGitSource}
          routingFocus={routingFocus}
          routingScroll={routingScroll}
          routingEditorFocus={routingEditorFocus}
          routingEditorScroll={routingEditorScroll}
          routingDraft={routingDraft}
          routingSelected={routingSelected}
          routingStatus={routingStatus}
          callerDraftSet={callerDraftSet}
          callerFocus={callerFocus}
          callerScroll={callerScroll}
          flowSubFocus={flowSubFocus}
          flowSubScroll={flowSubScroll}
          mcpServers={packMcpServers}
          termWidth={termWidth}
          termHeight={termHeight}
          onClose={() => {
            setRoutingConfirmDelete(false)
            setRoutingArchetype(null)
            setViewMode("main")
          }}
          onBackToConfigs={() => {
            setRoutingConfirmDelete(false)
            setRoutingSelected(new Set())
            setRoutingDraft(null)
            setViewMode("routing-configs")
          }}
          onBackToEditor={() => setViewMode("routing-editor")}
          onFocusBranch={idx => {
            setRoutingFocus(idx)
            setRoutingConfirmDelete(false)
          }}
          onOpenBranch={idx => openRoutingBranchAtIndex(idx)}
          onScrollBranches={delta => {
            const total = (routingView?.flows.length ?? 0) + 1 + packMcpServers.length
            if (total <= 0) return
            const vpRows = Math.max(1, calculatePackFlowsModalLayout(termWidth, termHeight, {
              hasPinned: Boolean(routingView?.pinned.length),
              hasStatus: Boolean(routingStatus),
            }).configViewportRows)
            const maxOff = Math.max(0, total - vpRows)
            setRoutingScroll(off => {
              const nextOff = Math.max(0, Math.min(maxOff, off + delta))
              setRoutingFocus(idx => Math.max(nextOff, Math.min(Math.min(total - 1, nextOff + vpRows - 1), idx)))
              return nextOff
            })
            setRoutingConfirmDelete(false)
          }}
          onOpenCallers={openRoutingCallersModal}
          onExportManifest={exportRoutingToManifest}
          onOpenInitPack={openInitPackModal}
          onToggleMcpServer={togglePackMcpServer}
          onFocusEditorRow={idx => setRoutingEditorFocus(idx)}
          onActivateEditorRow={idx => activateRoutingEditorRow(idx, false)}
          onToggleEditorAgentSelect={role => {
            setRoutingSelected(prev => {
              const next = new Set(prev)
              if (next.has(role)) next.delete(role)
              else next.add(role)
              return next
            })
          }}
          onScrollEditor={delta => {
            const total = (routingView?.related.length ?? 0) + 4
            if (total <= 0) return
            const vpRows = Math.max(1, calculatePackFlowsModalLayout(termWidth, termHeight, {
              hasPinned: Boolean(routingView?.pinned.length),
              hasStatus: Boolean(routingStatus),
            }).editorViewportRows)
            const maxOff = Math.max(0, total - vpRows)
            setRoutingEditorScroll(off => {
              const nextOff = Math.max(0, Math.min(maxOff, off + delta))
              setRoutingEditorFocus(idx => Math.max(nextOff, Math.min(Math.min(total - 1, nextOff + vpRows - 1), idx)))
              return nextOff
            })
          }}
          onOpenSubPolicy={target => {
            setFlowSubFocus(0)
            setFlowSubScroll(0)
            setViewMode(target)
          }}
          onFocusCaller={idx => setCallerFocus(idx)}
          onToggleCaller={name => {
            setCallerDraftSet(prev => {
              const next = new Set(prev)
              if (next.has(name)) next.delete(name)
              else next.add(name)
              return next
            })
          }}
          onSaveCallers={saveCallersDraftAction}
          onResetCallers={resetCallersToDefaultsAction}
          onScrollCallers={delta => {
            const total = routingView?.callerCandidates.length ?? 0
            if (total <= 0) return
            const vpRows = Math.max(1, calculatePackFlowsModalLayout(termWidth, termHeight, {
              hasStatus: Boolean(routingStatus),
            }).subviewViewportRows)
            const maxOff = Math.max(0, total - vpRows)
            setCallerScroll(off => {
              const nextOff = Math.max(0, Math.min(maxOff, off + delta))
              setCallerFocus(idx => Math.max(nextOff, Math.min(Math.min(total - 1, nextOff + vpRows - 1), idx)))
              return nextOff
            })
          }}
          onFocusSubRow={idx => setFlowSubFocus(idx)}
          onCycleSubRow={idx => cycleRoutingSubPolicyAt(idx, 1)}
          onScrollSubRows={delta => {
            const total =
              viewMode === "routing-tools"
                ? 1 + (routingView?.availableTools.length ?? 0)
                : viewMode === "routing-permissions"
                  ? PERMISSION_POLICY_ROWS.length
                  : 1 + (routingView?.subagents.length ?? 0)
            if (total <= 0) return
            const vpRows = Math.max(1, calculatePackFlowsModalLayout(termWidth, termHeight, {
              hasStatus: Boolean(routingStatus),
            }).subviewViewportRows)
            const maxOff = Math.max(0, total - vpRows)
            setFlowSubScroll(off => {
              const nextOff = Math.max(0, Math.min(maxOff, off + delta))
              setFlowSubFocus(idx => Math.max(nextOff, Math.min(Math.min(total - 1, nextOff + vpRows - 1), idx)))
              return nextOff
            })
          }}
        />
      )}

      {/* Modal - Guided OpenCode Pack Onboarding ([I] or proactive on virtual sources) */}
      {viewMode === "pack-init" && (
        <PackOnboardingModal
          workspaceRoot={workspaceRoot}
          sourceLabel={activeDataSource?.kind === "source" ? activeDataSource.source.name : undefined}
          isRemoteGit={isReadOnlyGitSource}
          inspection={initInspection}
          focusedField={initPackField}
          cloneDest={initCloneDest}
          name={initPackName}
          version={initPackVersion}
          description={initPackDesc}
          layout={initPackLayout}
          organize={initPackOrganize}
          authoringKit={initPackKit}
          termWidth={termWidth}
          termHeight={termHeight}
          onFocusField={f => setInitPackField(f)}
          onSelectLayout={l => setInitPackLayout(l)}
          onSelectOrganize={v => setInitPackOrganize(v)}
          onSelectAuthoringKit={v => setInitPackKit(v)}
          onSubmit={submitPackOnboarding}
          onCancel={() => setViewMode(routingArchetype ? "routing-configs" : "main")}
        />
      )}

      {/* Modal - Pack Doctor & Authoring Scaffolding ([D] / [N] on local packs) */}
      {viewMode === "pack-doctor" && (
        <PackDoctorModal
          tab={doctorTab}
          report={doctorReport}
          scrollOffset={doctorScrollOffset}
          statusMessage={doctorStatusMessage}
          scaffoldField={scaffoldField}
          scaffoldKind={scaffoldKind}
          scaffoldId={scaffoldId}
          scaffoldDesc={scaffoldDesc}
          scaffoldMode={scaffoldMode}
          termWidth={termWidth}
          termHeight={termHeight}
          onSwitchTab={nextTab => {
            setDoctorTab(nextTab)
            if (nextTab === "scaffold") setScaffoldField("id")
          }}
          onScrollDelta={delta => {
            const totalFindings = doctorReport?.findings.length ?? 0
            const maxRows = getDoctorMaxFindingRows(termHeight)
            setDoctorScrollOffset(off => Math.max(0, Math.min(Math.max(0, totalFindings - maxRows), off + delta)))
          }}
          onAutoFix={runPackDoctorAutoFix}
          onInstallKit={runPackDoctorAuthoringKit}
          onBumpVersion={runPackDoctorBump}
          onFocusScaffoldField={f => setScaffoldField(f)}
          onSelectScaffoldKind={k => setScaffoldKind(k)}
          onSelectScaffoldMode={m => setScaffoldMode(m)}
          onSubmitScaffold={submitPackScaffold}
          onClose={() => setViewMode("main")}
        />
      )}

      {/* Modal - Color Selection */}
      {viewMode === "color-selector" && (
        <box
          position="absolute"
          left={colorViewport.left}
          top={colorViewport.top}
          width={colorViewport.modalWidth}
          height={colorViewport.modalHeight}
          zIndex={45}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.accentPink}
          backgroundColor={THEME.bgElevated}
          title=" Select Agent Color "
          titleColor={THEME.accentPink}
          padding={1}
          flexDirection="column"
          overflow="hidden"
          onMouseScroll={(_self, event) => {
            const dir = (event as any).scroll?.direction
            if (!dir) return
            const delta = dir === "down" ? 2 : -2
            setColorScrollOffset(off => Math.max(0, Math.min(Math.max(0, colorTreeItems.length - maxVisibleColors), off + delta)))
          }}
        >
          <text height={2} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: THEME.fgPrimary }} paddingBottom={1}>
            {middleEllipsis(`Choose badge color for ${selectedAgentPaths.size > 0 ? selectedAgentPaths.size : 1} agent(s):`, colorViewport.innerWidth)}
          </text>

          <box flexGrow={1} minHeight={0} flexDirection="column" marginTop={1} overflow="hidden">
            {visibleColors.map((item, index) => {
              const globalIndex = colorScrollOffset + index
              const isFocused = globalIndex === focusedColorIndex

              if (item.type === "group") {
                return (
                  <box
                    key={`group-${item.id}`}
                    backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                    paddingLeft={1}
                    height={1}
                    flexShrink={0}
                    width="100%"
                    onMouseDown={() => {
                      setFocusedColorIndex(globalIndex)
                      setExpandedColorGroups(prev => {
                        const next = new Set(prev)
                        if (next.has(item.id)) next.delete(item.id)
                        else next.add(item.id)
                        return next
                      })
                    }}
                  >
                    <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#FFFFFF" : THEME.accentAmber }} b>
                      {item.label}
                    </text>
                  </box>
                )
              }

              return (
                <box
                  key={`color-${item.id}`}
                  backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                  paddingLeft={2}
                  height={1}
                  flexShrink={0}
                  width="100%"
                  flexDirection="row"
                  onMouseDown={() => setFocusedColorIndex(globalIndex)}
                >
                  <text height={1} style={{ textColor: item.hex }} b>{"● "}</text>
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#FFFFFF" : THEME.fgPrimary }} b={isFocused}>
                    {item.label.trim()}
                  </text>
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
                    {`  ${item.value}`}
                  </text>
                </box>
              )
            })}
          </box>

          <box flexDirection="row" justifyContent="space-between" borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} flexShrink={0}>
            <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
              {`${focusedColorIndex + 1}/${colorTreeItems.length} · [ENTER] Confirm`}
            </text>
            <text height={1} wrapMode="none" style={{ textColor: THEME.accentRed }} b onMouseDown={() => setViewMode("main")}>
              [ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {/* Modal - Bridge to Claude Code / Codex */}
      {viewMode === "bridge-confirm" && (
        <box
          style={{ position: "absolute", left: "10%", top: "16%", width: "80%", height: "68%" }}
          zIndex={46}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.borderWarn}
          backgroundColor={THEME.bgElevated}
          title=" Confirm Executable Bridge Content "
          titleColor={THEME.accentAmber}
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
        >
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <text style={{ textColor: THEME.accentAmber }} b>
              This untrusted pack includes executable content. Confirm before writing bridge output:
            </text>
            <scrollbox scrollY={true} flexGrow={1} marginTop={1} overflow="hidden">
              <box flexDirection="column">
                {bridgeConfirmReasons.map((reason, index) => (
                  <text key={`bridge-confirm-${index}`} style={{ textColor: THEME.fgPrimary }}>
                    {`• ${terminalSafeText(reason)}`}
                  </text>
                ))}
              </box>
            </scrollbox>
          </box>
          <box borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} justifyContent="space-between" flexDirection="row">
            <text style={{ textColor: THEME.accentGreen }} b>
              [Y / ENTER] Continue Bridge
            </text>
            <text style={{ textColor: THEME.accentRed }} b>
              [N / ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {viewMode === "bridge-prompt" && (
        <BridgeModal
          target={bridgeTarget}
          focusedField={bridgeFocusedField}
          pluginName={bridgePluginName}
          selectedPack={bridgeSelectedPack}
          suggestedPack={bridgePackSuggested}
          packQuery={bridgePackQuery}
          allPacks={bridgeablePacks}
          filteredPacks={filteredBridgePacks}
          packIndex={bridgePackIndex}
          packScrollOffset={bridgePackScrollOffset}
          tiers={bridgeDraftTiers}
          tierIndex={bridgeTierIndex}
          tierScrollOffset={bridgeTierScrollOffset}
          previewItems={bridgePreview.items}
          tierCounts={bridgePreview.tierCounts}
          agentIndex={bridgeAgentIndex}
          agentScrollOffset={bridgeAgentScrollOffset}
          modelTarget={bridgeModelTarget}
          tiersDirty={bridgeTiersDirty}
          termWidth={termWidth}
          termHeight={termHeight}
          onFocusField={field => {
            setBridgeClaudeTierTyping(false)
            setBridgeFocusedField(field)
          }}
          onChangePluginName={setBridgePluginName}
          onChangePackQuery={value => {
            const next = reconcileBridgePackQuery(bridgeablePacks, value, bridgeSelectedPack, bridgePackViewportRows)
            setBridgePackQuery(next.query)
            setBridgeSelectedPack(next.selectedPack)
            setBridgePackIndex(next.index)
            setBridgePackScrollOffset(next.scrollOffset)
            setBridgeAgentIndex(0)
            setBridgeAgentScrollOffset(0)
          }}
          onSelectPackAt={(filteredIndex, pack) => {
            setBridgeFocusedField("pack")
            setBridgePackIndex(filteredIndex)
            setBridgeSelectedPack(pack)
            setBridgeAgentIndex(0)
            setBridgeAgentScrollOffset(0)
          }}
          onSelectTierIndex={idx => {
            setBridgeClaudeTierTyping(false)
            setBridgeTierIndex(idx)
          }}
          onChangeTierModel={(tierName, model) => {
            setBridgeClaudeTierTyping(false)
            updateBridgeTierModel(tierName, model)
          }}
          onSelectTierEffort={(tierName, effort) => updateBridgeTierEffort(tierName, effort)}
          onSelectAgentIndex={idx => setBridgeAgentIndex(idx)}
          onCycleAgentTierAt={(idx, delta) => cycleBridgeAgentTierAt(idx, delta)}
          onChangeModelTarget={value => {
            bridgeModelTargetDirtyRef.current = true
            setBridgeModelTarget(value)
          }}
          onSaveTiers={saveBridgeTiersOnly}
          onSubmit={() => generateBridge()}
          onClose={() => setViewMode("main")}
        />
      )}

      {/* Modal - Target Lifecycle Diff Preview (Install / Update / Uninstall / Reconcile) */}
      {viewMode === "install-confirm" && installPreview && (() => {
        const opVerb = installPreview.operation === "reconcile" && installPreview.adopt
          ? "Reconcile --adopt"
          : installPreview.operation[0].toUpperCase() + installPreview.operation.slice(1)
        const packNames = installPreview.packs.map(pack => `'${terminalSafeText(pack)}'`).join(", ")
        const packLabel = installPreview.packs.length === 1
          ? terminalSafeText(installPreview.packs[0])
          : installPreview.packs.length > 1
            ? `${installPreview.packs.length} packs`
            : "target"
        const addedLines = installPreview.lines.filter(l => /^\s*\b(write|add|install|update)\b/i.test(l))
        const removedLines = installPreview.lines.filter(l => /^\s*\b(remove|delete|prune)\b/i.test(l))
        const hasDiffItems = addedLines.length > 0 || removedLines.length > 0
        const canAccept = !installPreview.blocked

        return (
          <box
            style={{ position: "absolute", left: "10%", top: "12%", width: "80%", height: "76%" }}
            zIndex={45}
            border={true}
            borderStyle="rounded"
            borderColor={installPreview.blocked ? THEME.borderDanger : installPreview.operation === "uninstall" ? THEME.accentAmber : THEME.borderSuccess}
            backgroundColor={THEME.bgElevated}
            title={` ${opVerb} ${packLabel} `}
            titleColor={installPreview.blocked ? THEME.accentRed : installPreview.operation === "uninstall" ? THEME.accentAmber : THEME.accentGreen}
            padding={1}
            flexDirection="column"
            justifyContent="space-between"
          >
            <box flexDirection="column" flexGrow={1} overflow="hidden">
              <text style={{ textColor: THEME.fgPrimary }} b>
                {installPreview.operation === "install"
                  ? `Install ${packNames} with dependencies into ${installPreview.target.replace(os.homedir(), "~")}`
                  : `${opVerb}${packNames ? ` ${packNames}` : ""} on ${installPreview.target.replace(os.homedir(), "~")}`}
              </text>
              <scrollbox scrollY={true} flexGrow={1} marginTop={1} overflow="hidden">
                <box flexDirection="column">
                  {installPreview.lines.map((line, index) => (
                    <text
                      key={`install-${index}`}
                      style={{
                        textColor: line.startsWith("ERROR")
                          ? THEME.accentRed
                          : line.startsWith("warning")
                            ? THEME.accentAmber
                            : THEME.fgPrimary,
                      }}
                    >
                      {line}
                    </text>
                  ))}
                  {hasDiffItems && (
                    <box width="100%" marginTop={1}>
                      <diff
                        width="100%"
                        view="unified"
                        showLineNumbers={true}
                        syntaxStyle={getMarkdownSyntaxStyle()}
                        diff={buildPreviewUnifiedDiff(
                          `${packLabel}-target-plan`,
                          removedLines.length ? removedLines : ["(no removals)"],
                          addedLines.length ? addedLines : ["(no additions)"],
                        )}
                      />
                    </box>
                  )}
                  {canAccept && installPreview.confirmations.length > 0 && (
                    <text style={{ textColor: THEME.accentAmber }} b marginTop={1}>
                      Confirming also accepts executable surface:
                    </text>
                  )}
                  {canAccept && installPreview.confirmations.map((reason, index) => (
                    <text key={`confirm-${index}`} style={{ textColor: THEME.accentAmber }}>
                      {`  • ${terminalSafeText(reason)}`}
                    </text>
                  ))}
                </box>
              </scrollbox>
            </box>

            <box borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} justifyContent="space-between" flexDirection="row">
              {installPreview.blocked ? (
                <text style={{ textColor: THEME.accentRed }} b onMouseDown={() => setViewMode("main")}>
                  Blocked · [ESC] Back
                </text>
              ) : (
                <text style={{ textColor: THEME.accentGreen }} b onMouseDown={() => applyInstall(installPreview)}>
                  {`[Y / ENTER] Confirm & ${opVerb}`}
                </text>
              )}
              {!installPreview.blocked && (
                <text style={{ textColor: THEME.accentRed }} b onMouseDown={() => setViewMode("main")}>
                  [N / ESC] Cancel
                </text>
              )}
            </box>
          </box>
        )
      })()}

      {/* Modal - Engine Self-Update (GitHub Releases) */}
      {viewMode === "self-update" && (
        <box
          position="absolute"
          left={selfUpdateViewport.left}
          top={selfUpdateViewport.top}
          width={selfUpdateViewport.modalWidth}
          height={selfUpdateViewport.modalHeight}
          zIndex={45}
          border={true}
          borderStyle="rounded"
          borderColor={THEME.accentCyan}
          backgroundColor={THEME.bgElevated}
          title=" Engine Update (manage-agents) "
          titleColor={THEME.accentCyan}
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
        >
          <box flexDirection="column" overflow="hidden">
            <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }} b>
              {middleEllipsis(`Installed: ${engineVersionInfo ? `${engineVersionInfo.displayVersion} (${engineVersionInfo.channel}${engineVersionInfo.dirty ? " · dirty" : " · clean"})` : "unknown"}`, selfUpdateViewport.innerWidth)}
            </text>
            {selfUpdateCheck && (
              <>
                <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: selfUpdateCheck.updateAvailable ? THEME.accentGreen : THEME.fgSecondary }} marginTop={1}>
                  {middleEllipsis(
                    `Latest:    ${selfUpdateCheck.metadata.tag} · commit ${selfUpdateCheck.metadata.commit.slice(0, 7)} · ${selfUpdateCheck.verificationMode === "ed25519" ? "Signed Ed25519" : "Verified SHA-256"}`,
                    selfUpdateViewport.innerWidth,
                  )}
                </text>
                <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                  {middleEllipsis(
                    `Asset:     ${selfUpdateCheck.metadata.archive.name} (${Math.max(1, Math.round(selfUpdateCheck.metadata.archive.size / 1024))} KB)`,
                    selfUpdateViewport.innerWidth,
                  )}
                </text>
                <text
                  height={1}
                  wrapMode="none"
                  overflow="hidden"
                  marginTop={1}
                  style={{
                    textColor: selfUpdateCheck.updateAvailable
                      ? THEME.accentGreen
                      : selfUpdateCheck.downgrade
                        ? THEME.accentAmber
                        : THEME.fgSecondary,
                  }}
                  b={selfUpdateCheck.updateAvailable}
                >
                  {middleEllipsis(
                    selfUpdateCheck.updateAvailable
                      ? `Status:    ↑ Update available${selfUpdateCheck.targetReconcileNeeded ? " (reconciles OpenCode router plugin)" : ""}`
                      : selfUpdateCheck.downgrade
                        ? "Status:    Installed version is newer than latest release ([F] force downgrade)"
                        : "Status:    ✓ manage-agents is already up to date",
                    selfUpdateViewport.innerWidth,
                  )}
                </text>
                {selfUpdateCheck.localGitDirty && (
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentAmber }} marginTop={1}>
                    {middleEllipsis("⚠ Engine directory has uncommitted changes ([F] force overwrite).", selfUpdateViewport.innerWidth)}
                  </text>
                )}
              </>
            )}
            {selfUpdateStatus && (
              <text
                height={1}
                wrapMode="none"
                overflow="hidden"
                marginTop={1}
                style={{ textColor: selfUpdateStatus.startsWith("Error") ? THEME.accentRed : THEME.accentCyan }}
              >
                {middleEllipsis(`${selfUpdateBusy && pulse.spinner ? `${pulse.spinner} ` : ""}${selfUpdateStatus}`, selfUpdateViewport.innerWidth)}
              </text>
            )}
          </box>

          <box flexDirection="row" justifyContent="space-between" borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} flexShrink={0}>
            <text height={1} wrapMode="none" style={{ textColor: selfUpdateCheck?.updateAvailable && !selfUpdateCheck.localGitDirty ? THEME.accentGreen : THEME.fgSecondary }} b={Boolean(selfUpdateCheck?.updateAvailable && !selfUpdateCheck.localGitDirty)}>
              {selfUpdateBusy
                ? "Working..."
                : selfUpdateCheck?.updateAvailable
                  ? selfUpdateCheck.localGitDirty
                    ? "[F] Force Update · [R] Re-check"
                    : "[Y / ENTER] Update Engine · [R] Re-check"
                  : "[R] Re-check"}
            </text>
            <text height={1} wrapMode="none" style={{ textColor: THEME.accentRed }} b onMouseDown={() => !selfUpdateBusy && setViewMode("main")}>
              [ESC] Close
            </text>
          </box>
        </box>
      )}

      {/* Modal - Action Result */}
      {viewMode === "action-result" && (
        <box
          position="absolute"
          left={actionResultViewport.left}
          top={actionResultViewport.top}
          width={actionResultViewport.modalWidth}
          height={actionResultViewport.modalHeight}
          zIndex={45}
          border={true}
          borderStyle="rounded"
          borderColor={actionResultTitle.toLowerCase().includes("error") || actionResultTitle.toLowerCase().includes("fail") ? THEME.borderDanger : THEME.borderSuccess}
          backgroundColor={THEME.bgElevated}
          title={` ${middleEllipsis(actionResultTitle, 50)} `}
          titleColor={actionResultTitle.toLowerCase().includes("error") || actionResultTitle.toLowerCase().includes("fail") ? THEME.accentRed : THEME.accentGreen}
          padding={1}
          flexDirection="column"
          overflow="hidden"
          onMouseScroll={(_self, event) => {
            const dir = (event as any).scroll?.direction
            if (!dir) return
            const delta = dir === "down" ? 2 : -2
            setActionResultScrollOffset(off => Math.max(0, Math.min(actionResultMaxOffset, off + delta)))
          }}
        >
          <box flexGrow={1} minHeight={0} flexDirection="column" overflow="hidden" flexShrink={1}>
            {visibleActionResultLines.map((line, idx) => (
              <text
                key={actionResultScrollOffset + idx}
                height={1}
                wrapMode="none"
                overflow="hidden"
                style={{
                  textColor: line.startsWith("⚠")
                    ? THEME.accentAmber
                    : line.toLowerCase().startsWith("error")
                      ? THEME.accentRed
                      : THEME.fgPrimary,
                }}
                flexShrink={0}
              >
                {middleEllipsis(terminalSafeText(line), actionResultViewport.innerWidth)}
              </text>
            ))}
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} marginTop={1} flexShrink={0} overflow="hidden" flexDirection="row">
            <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }} flexShrink={0}>
              {actionResultMaxOffset > 0 ? `▲ ${actionResultScrollOffset + 1}-${Math.min(actionResultLines.length, actionResultScrollOffset + maxVisibleActionResultLines)}/${actionResultLines.length} ▼` : "Result summary"}
            </text>
            <text height={1} wrapMode="none" style={{ textColor: THEME.accentGreen }} b flexShrink={0} onMouseDown={() => setViewMode("main")}>
              [ENTER / ESC] Continue
            </text>
          </box>
        </box>
      )}
    </box>
  )
}
