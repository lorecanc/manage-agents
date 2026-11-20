import React from "react"
import {
  callersLabel,
  INHERIT,
  type ArchetypeAgent,
  type PackFlowsView,
  type RoleModels,
  type UnifiedFlowItem,
} from "../utils/archetypes.js"
import { clampListScroll } from "../utils/layout.js"
import type { FlowDraftInput } from "../utils/sourceCustomization.js"
import { displayWidth, middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { THEME } from "../utils/uiTheme.js"
import { WILDCARD_TRIGGER, type DelegationEffect, type PolicyEffect } from "../utils/values.js"

export type PackFlowsMode =
  | "routing-configs"
  | "routing-editor"
  | "routing-callers"
  | "routing-tools"
  | "routing-permissions"
  | "routing-delegations"

export type PackFlowDraftState = FlowDraftInput & { previousKey?: string }

/** One MCP server entry the pack contributes, as the effective (override-patched) contribution sees it. */
export interface PackMcpServerRow {
  name: string
  enabled: boolean
  overridden: boolean
}

/** Rows of the pack config screen: a flow branch, the "+ new" card, or an MCP server toggle. */
type PackConfigRow = UnifiedFlowItem | { mcp: PackMcpServerRow } | null

export const PERMISSION_POLICY_ROWS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "*", label: "* (All permissions fallback)" },
  { key: "shell", label: "shell / bash (command execution)" },
  { key: "edit", label: "edit / write (file modifications)" },
  { key: "read", label: "read (file & directory reads)" },
  { key: "webfetch", label: "webfetch (HTTP requests)" },
  { key: "skill", label: "skill (load skills)" },
  { key: "external_directory", label: "external_directory (outside workspace)" },
]

export interface PackFlowsModalLayout {
  modalWidth: number
  modalHeight: number
  left: number
  top: number
  innerWidth: number
  innerHeight: number
  bodyHeight: number
  splitMasterDetail: boolean
  branchRowHeight: 1 | 2
  configViewportRows: number
  editorViewportRows: number
  subviewViewportRows: number
}

export function formatFlowTriggerShort(trigger: string): string {
  if (trigger === WILDCARD_TRIGGER) return "* (any model)"
  if (!trigger.includes("/")) return `${trigger}/*`
  return trigger
}

export function formatFlowTriggerVerbose(trigger: string): string {
  if (trigger === WILDCARD_TRIGGER) return "* (any model on any provider)"
  if (!trigger.includes("/")) return `${trigger}/* (any model on ${trigger})`
  return trigger
}

export function formatTriggerLabel(triggers: readonly string[]): string {
  if (triggers.length === 0) return "(select trigger)"
  return triggers
    .map(t => (t === WILDCARD_TRIGGER ? "* (any model)" : t.includes("/") ? t : `${t} (any model)`))
    .join(" OR ")
}

export function splitModelAndVariant(modelRef: string): { base: string; variant: string } {
  const hashIdx = modelRef.indexOf("#")
  if (hashIdx === -1) return { base: modelRef, variant: "" }
  return {
    base: modelRef.slice(0, hashIdx),
    variant: modelRef.slice(hashIdx + 1),
  }
}

export function summarizeUnifiedFlow(
  flow: Pick<UnifiedFlowItem, "roles" | "tools" | "permissions" | "delegations">,
  related: readonly ArchetypeAgent[],
): string {
  const parts: string[] = []
  if (related.length > 0) {
    const groups = new Map<string, string[]>()
    for (const agent of related) {
      const model = flow.roles[agent.role] ?? INHERIT
      groups.set(model, [...(groups.get(model) ?? []), agent.role])
    }
    const modelSummary = [...groups]
      .map(([model, names]) =>
        model === INHERIT
          ? `${names.join(", ")} ${names.length === 1 ? "inherits" : "inherit"}`
          : `${names.join(", ")} → ${model}`,
      )
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

export function calculatePackFlowsModalLayout(
  termWidth: number,
  termHeight: number,
  options: {
    hasPinned?: boolean
    hasStaticWarn?: boolean
    hasStatus?: boolean
  } = {},
): PackFlowsModalLayout {
  const safeW = Math.max(24, Math.floor(termWidth))
  const safeH = Math.max(12, Math.floor(termHeight))
  const maxW = Math.max(24, safeW - 4)
  const maxH = Math.max(12, safeH - 2)

  const modalWidth = Math.min(maxW, Math.max(54, Math.floor(safeW * 0.84)))
  const modalHeight = Math.min(maxH, Math.max(14, Math.floor(safeH * 0.84)))
  const left = Math.max(0, Math.floor((safeW - modalWidth) / 2))
  const top = Math.max(0, Math.floor((safeH - modalHeight) / 2))

  const innerWidth = Math.max(20, modalWidth - 4)
  const innerHeight = Math.max(8, modalHeight - 2)

  const statusRows = options.hasStatus ? 1 : 0
  const splitMasterDetail = innerWidth >= 82 && innerHeight >= 13

  // Header (2) + subtitle (1) + footer (2) = 5 fixed chrome rows
  const configsExtra = (!splitMasterDetail && options.hasPinned ? 1 : 0) + statusRows
  const configsBodyHeight = Math.max(2, innerHeight - 5 - configsExtra)

  const leftListInnerRows = splitMasterDetail ? Math.max(1, configsBodyHeight - 4) : configsBodyHeight
  const branchRowHeight: 1 | 2 = leftListInnerRows >= 6 ? 2 : 1
  const configViewportRows = Math.max(1, Math.floor(leftListInnerRows / branchRowHeight))

  const editorExtra = (options.hasPinned ? 1 : 0) + (options.hasStaticWarn ? 1 : 0) + statusRows
  const editorViewportRows = Math.max(1, innerHeight - 5 - editorExtra)

  const subviewViewportRows = Math.max(1, innerHeight - 5 - statusRows)

  return {
    modalWidth,
    modalHeight,
    left,
    top,
    innerWidth,
    innerHeight,
    bodyHeight: configsBodyHeight,
    splitMasterDetail,
    branchRowHeight,
    configViewportRows,
    editorViewportRows,
    subviewViewportRows,
  }
}

function originBadgeMeta(origin: UnifiedFlowItem["origin"]): { label: string; fg: string; bg: string } {
  if (origin === "user") return { label: "USER", fg: THEME.accentGreen, bg: THEME.bgSuccessSoft }
  if (origin === "global") return { label: "GLOBAL", fg: THEME.accentPurple, bg: THEME.bgPill }
  return { label: "PACK", fg: THEME.accentCyan, bg: THEME.bgPillActive }
}

function effectBadgeMeta(effect: PolicyEffect | DelegationEffect | undefined): { label: string; fg: string; bg: string } {
  if (effect === "allow") return { label: "ALLOW", fg: THEME.accentGreen, bg: THEME.bgSuccessSoft }
  if (effect === "ask") return { label: "ASK", fg: THEME.accentAmber, bg: THEME.bgWarnSoft }
  if (effect === "deny") return { label: "DENY", fg: THEME.accentRed, bg: THEME.bgDangerSoft }
  return { label: "UNCHANGED", fg: THEME.fgMuted, bg: THEME.bgPill }
}

export interface PackFlowsModalProps {
  packName: string
  mode: PackFlowsMode
  routingView: PackFlowsView | null
  loadError: string
  isReadOnlyGitSource: boolean
  routingFocus: number
  routingScroll: number
  routingEditorFocus: number
  routingEditorScroll: number
  routingDraft: PackFlowDraftState | null
  routingSelected: ReadonlySet<string>
  routingStatus: string
  callerDraftSet: ReadonlySet<string>
  callerFocus: number
  callerScroll: number
  flowSubFocus: number
  flowSubScroll: number
  /** MCP servers the pack contributes (config screen rows, after the +new card). */
  mcpServers: ReadonlyArray<PackMcpServerRow>
  termWidth: number
  termHeight: number
  onClose: () => void
  onBackToConfigs: () => void
  onBackToEditor: () => void
  onFocusBranch: (index: number) => void
  onOpenBranch: (index: number) => void
  onScrollBranches: (delta: number) => void
  onOpenCallers: () => void
  onExportManifest: () => void
  onOpenInitPack: () => void
  onFocusEditorRow: (index: number) => void
  onActivateEditorRow: (index: number) => void
  onToggleEditorAgentSelect: (role: string) => void
  onScrollEditor: (delta: number) => void
  onOpenSubPolicy: (target: "routing-tools" | "routing-permissions" | "routing-delegations") => void
  onFocusCaller: (index: number) => void
  onToggleCaller: (name: string) => void
  onSaveCallers: () => void
  onResetCallers: () => void
  onScrollCallers: (delta: number) => void
  onFocusSubRow: (index: number) => void
  onCycleSubRow: (index: number) => void
  onScrollSubRows: (delta: number) => void
  onToggleMcpServer: (name: string) => void
}

export function PackFlowsModal({
  packName,
  mode,
  routingView,
  loadError,
  isReadOnlyGitSource,
  routingFocus,
  routingScroll,
  routingEditorFocus,
  routingEditorScroll,
  routingDraft,
  routingSelected,
  routingStatus,
  callerDraftSet,
  callerFocus,
  callerScroll,
  flowSubFocus,
  flowSubScroll,
  mcpServers,
  termWidth,
  termHeight,
  onClose,
  onBackToConfigs,
  onBackToEditor,
  onFocusBranch,
  onOpenBranch,
  onScrollBranches,
  onOpenCallers,
  onExportManifest,
  onOpenInitPack,
  onFocusEditorRow,
  onActivateEditorRow,
  onToggleEditorAgentSelect,
  onScrollEditor,
  onOpenSubPolicy,
  onFocusCaller,
  onToggleCaller,
  onSaveCallers,
  onResetCallers,
  onScrollCallers,
  onFocusSubRow,
  onCycleSubRow,
  onScrollSubRows,
  onToggleMcpServer,
}: PackFlowsModalProps) {
  const blockedAllowTools =
    mode === "routing-editor" && routingDraft && routingView
      ? Object.entries(routingDraft.tools)
          .filter(([k, v]) => v === "allow" && (routingView.staticDeniedTools.has(k) || routingView.staticDeniedTools.has("*")))
          .map(([k]) => k)
      : []
  const blockedAllowDels =
    mode === "routing-editor" && routingDraft && routingView
      ? Object.entries(routingDraft.delegations)
          .filter(([k, v]) => v === "allow" && (routingView.staticDeniedDelegations.has(k) || routingView.staticDeniedDelegations.has("*")))
          .map(([k]) => k)
      : []
  const hasStaticWarn = blockedAllowTools.length > 0 || blockedAllowDels.length > 0
  const hasPinned = Boolean(routingView && routingView.pinned.length > 0)

  const layout = calculatePackFlowsModalLayout(termWidth, termHeight, {
    hasPinned,
    hasStaticWarn,
    hasStatus: Boolean(routingStatus),
  })
  const { modalWidth, modalHeight, left, top, innerWidth } = layout

  const renderStatusBanner = () => {
    if (!routingStatus) return null
    const isErr = routingStatus.startsWith("Error")
    return (
      <box
        width="100%"
        height={1}
        flexShrink={0}
        backgroundColor={isErr ? THEME.bgDangerSoft : THEME.bgPill}
        paddingLeft={1}
        paddingRight={1}
        overflow="hidden"
      >
        <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: isErr ? THEME.accentRed : THEME.accentAmber }}>
          {middleEllipsis(terminalSafeText(routingStatus), Math.max(12, innerWidth - 2))}
        </text>
      </box>
    )
  }

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      zIndex={45}
      onMouseDown={() => onClose()}
    >
      <box
        position="absolute"
        left={left}
        top={top}
        width={modalWidth}
        height={modalHeight}
        border={true}
        borderStyle="rounded"
        borderColor={THEME.accentCyan}
        backgroundColor={THEME.bgElevated}
        title={` 📦 ${terminalSafeText(packName.toUpperCase())} · Conditional Flows (IF / OR) `}
        titleColor={THEME.accentCyan}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
        justifyContent="space-between"
        overflow="hidden"
        onMouseDown={(_self, event) => {
          event.stopPropagation()
        }}
      >
        {!routingView ? (
          <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
            <text style={{ textColor: THEME.accentRed }} b>
              {terminalSafeText(loadError || `No agents found for ${packName}.`)}
            </text>
            <text style={{ textColor: THEME.fgSecondary }} marginTop={1}>
              Press [ESC] to close
            </text>
          </box>
        ) : mode === "routing-callers" ? (() => {
          const candidates = routingView.callerCandidates
          const safeOffset = clampListScroll(callerFocus, candidates.length, callerScroll, layout.subviewViewportRows)
          const visibleCallers = candidates.slice(safeOffset, safeOffset + layout.subviewViewportRows)
          return (
            <>
              <box flexDirection="column" width="100%" flexGrow={1} minHeight={0} overflow="hidden">
                <box
                  width="100%"
                  height={2}
                  flexShrink={0}
                  borderStyle="single"
                  border={["bottom"]}
                  borderColor={THEME.borderSubtle}
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <box flexDirection="row" overflow="hidden">
                    <text height={1} wrapMode="none" style={{ textColor: THEME.accentAmber }} b>
                      {"◉ Entry Callers (OR) "}
                    </text>
                    <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                      {`[${routingView.callerSource}]`}
                    </text>
                  </box>
                  <text
                    height={1}
                    wrapMode="none"
                    style={{ textColor: THEME.accentCyan }}
                    u
                    onMouseDown={() => onResetCallers()}
                  >
                    [R] Reset defaults
                  </text>
                </box>

                <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                  {middleEllipsis(
                    `Choose which primary agents activate ${packName}'s conditional flows when running on a matching model:`,
                    innerWidth,
                  )}
                </text>

                <box
                  flexGrow={1}
                  minHeight={0}
                  flexDirection="column"
                  overflow="hidden"
                  onMouseScroll={(_self, event) => {
                    const dir = (event as any).scroll?.direction
                    if (dir === "down") onScrollCallers(2)
                    else if (dir === "up") onScrollCallers(-2)
                  }}
                >
                  {visibleCallers.map((cand, idx) => {
                    const index = safeOffset + idx
                    const focused = index === callerFocus
                    const checked = callerDraftSet.has(cand.name)
                    const modelTag = cand.model ? `default: ${cand.model}` : "no default model"
                    const rightW = Math.min(Math.floor(innerWidth * 0.46), displayWidth(modelTag) + 2)
                    const leftBudget = Math.max(12, innerWidth - rightW - 2)
                    return (
                      <box
                        key={`caller-${cand.name}`}
                        width="100%"
                        height={1}
                        flexShrink={0}
                        flexDirection="row"
                        justifyContent="space-between"
                        backgroundColor={focused ? THEME.bgRowFocus : checked ? THEME.bgRowSelected : "transparent"}
                        paddingLeft={1}
                        paddingRight={1}
                        onMouseDown={() => {
                          onFocusCaller(index)
                          onToggleCaller(cand.name)
                        }}
                      >
                        <text
                          height={1}
                          wrapMode="none"
                          overflow="hidden"
                          style={{ textColor: focused ? "#ffffff" : checked ? THEME.accentGreen : THEME.fgPrimary }}
                          b={focused || checked}
                        >
                          {middleEllipsis(
                            `${focused ? "▎ " : "  "}${checked ? "[✓]" : "[ ]"} @${terminalSafeText(cand.name)}`,
                            leftBudget,
                          )}
                        </text>
                        <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: focused ? THEME.accentCyan : THEME.fgMuted }}>
                          {middleEllipsis(terminalSafeText(modelTag), rightW)}
                        </text>
                      </box>
                    )
                  })}
                </box>
              </box>

              <box flexDirection="column" width="100%" flexShrink={0}>
                {renderStatusBanner()}
                <box
                  width="100%"
                  height={2}
                  borderStyle="single"
                  border={["top"]}
                  borderColor={THEME.borderSubtle}
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                    {middleEllipsis(
                      "↑/↓ Navigate · Space Toggle · R Reset defaults",
                      Math.max(16, innerWidth - 28),
                    )}
                  </text>
                  <box flexDirection="row">
                    <text height={1} wrapMode="none" style={{ textColor: THEME.accentGreen }} b onMouseDown={() => onSaveCallers()}>
                      {"[ENTER] Save  "}
                    </text>
                    <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }} onMouseDown={() => onBackToConfigs()}>
                      [ESC] Back
                    </text>
                  </box>
                </box>
              </box>
            </>
          )
        })() : (mode === "routing-tools" || mode === "routing-permissions" || mode === "routing-delegations") && routingDraft ? (() => {
          const policyTitle =
            mode === "routing-tools"
              ? "🛠 Tools & MCP Policy Overrides"
              : mode === "routing-permissions"
                ? "🛡 Runtime Permission Overrides"
                : "⇄ Subagent Delegation Policy"
          const subRows =
            mode === "routing-tools"
              ? [
                  { key: "*", label: "* (All tools fallback)", effect: routingDraft.tools["*"], staticDeny: false },
                  ...routingView.availableTools.map(t => ({
                    key: t.key,
                    label: t.label,
                    effect: routingDraft.tools[t.key],
                    staticDeny: t.staticallyDeniedByCaller,
                  })),
                ]
              : mode === "routing-permissions"
                ? PERMISSION_POLICY_ROWS.map(p => ({
                    key: p.key,
                    label: p.label,
                    effect: routingDraft.permissions[p.key],
                    staticDeny: routingView.staticDeniedTools.has(p.key) || routingView.staticDeniedTools.has("*"),
                  }))
                : [
                    {
                      key: "*",
                      label: "* (All subagents fallback)",
                      effect: routingDraft.delegations["*"],
                      staticDeny: routingView.staticDeniedDelegations.has("*"),
                    },
                    ...routingView.subagents.map(sub => ({
                      key: sub.name,
                      label: `@${sub.name}`,
                      effect: routingDraft.delegations[sub.name],
                      staticDeny: routingView.staticDeniedDelegations.has(sub.name) || routingView.staticDeniedDelegations.has("*"),
                    })),
                  ]

          const safeOffset = clampListScroll(flowSubFocus, subRows.length, flowSubScroll, layout.subviewViewportRows)
          const visible = subRows.slice(safeOffset, safeOffset + layout.subviewViewportRows)

          return (
            <>
              <box flexDirection="column" width="100%" flexGrow={1} minHeight={0} overflow="hidden">
                <box
                  width="100%"
                  height={2}
                  flexShrink={0}
                  borderStyle="single"
                  border={["bottom"]}
                  borderColor={THEME.borderSubtle}
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentPurple }} b>
                    {middleEllipsis(policyTitle, Math.max(18, innerWidth - 26))}
                  </text>
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentAmber }}>
                    {middleEllipsis(`IF ${formatTriggerLabel(routingDraft.triggers)}`, 24)}
                  </text>
                </box>

                <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                  {middleEllipsis(
                    mode === "routing-delegations"
                      ? "Space or ←/→ cycles: UNCHANGED → DENY → ALLOW (blocked before subagent spawn)"
                      : "Space or ←/→ cycles: UNCHANGED → DENY → ASK → ALLOW (applied dynamically on trigger match)",
                    innerWidth,
                  )}
                </text>

                <box
                  flexGrow={1}
                  minHeight={0}
                  flexDirection="column"
                  overflow="hidden"
                  onMouseScroll={(_self, event) => {
                    const dir = (event as any).scroll?.direction
                    if (dir === "down") onScrollSubRows(2)
                    else if (dir === "up") onScrollSubRows(-2)
                  }}
                >
                  {visible.map((row, idx) => {
                    const globalIdx = safeOffset + idx
                    const focused = globalIdx === flowSubFocus
                    const badge = effectBadgeMeta(row.effect)
                    const warnStatic = row.effect === "allow" && row.staticDeny
                    return (
                      <box
                        key={`sub-${row.key}`}
                        width="100%"
                        height={1}
                        flexShrink={0}
                        flexDirection="row"
                        justifyContent="space-between"
                        backgroundColor={focused ? THEME.bgRowFocus : "transparent"}
                        paddingLeft={1}
                        paddingRight={1}
                        onMouseDown={() => {
                          onFocusSubRow(globalIdx)
                          onCycleSubRow(globalIdx)
                        }}
                      >
                        <text
                          height={1}
                          wrapMode="none"
                          overflow="hidden"
                          style={{ textColor: focused ? "#ffffff" : THEME.fgPrimary }}
                          b={focused}
                        >
                          {middleEllipsis(
                            `${focused ? "▎ " : "  "}${terminalSafeText(row.label)}${warnStatic ? " ⚠ static deny on caller" : ""}`,
                            Math.max(14, innerWidth - 18),
                          )}
                        </text>
                        <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={badge.bg} flexShrink={0}>
                          <text height={1} wrapMode="none" style={{ textColor: badge.fg }} b>
                            {badge.label}
                          </text>
                        </box>
                      </box>
                    )
                  })}
                </box>
              </box>

              <box flexDirection="column" width="100%" flexShrink={0}>
                {renderStatusBanner()}
                <box
                  width="100%"
                  height={2}
                  borderStyle="single"
                  border={["top"]}
                  borderColor={THEME.borderSubtle}
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                    {middleEllipsis(
                      "↑/↓ Navigate · Space/←/→ Cycle policy · Backspace Reset",
                      Math.max(16, innerWidth - 20),
                    )}
                  </text>
                  <text
                    height={1}
                    wrapMode="none"
                    style={{ textColor: THEME.accentGreen }}
                    b
                    onMouseDown={() => onBackToEditor()}
                  >
                    [ENTER / ESC] Done
                  </text>
                </box>
              </box>
            </>
          )
        })() : mode === "routing-editor" && routingDraft ? (() => {
          const toolsEntries = Object.entries(routingDraft.tools)
          const permEntries = Object.entries(routingDraft.permissions)
          const delEntries = Object.entries(routingDraft.delegations)
          const toolsSummary = toolsEntries.length > 0
            ? toolsEntries.map(([k, v]) => `${k}=${v}`).join(", ")
            : "unchanged (press U or ENTER)"
          const permSummary = permEntries.length > 0
            ? permEntries.map(([k, v]) => `${k}=${v}`).join(", ")
            : "unchanged (press P or ENTER)"
          const delSummary = delEntries.length > 0
            ? delEntries.map(([k, v]) => `${k}=${v}`).join(", ")
            : "unchanged (press G or ENTER)"

          const editorRows = [
            {
              kind: "triggers" as const,
              role: "",
              label: `⚡ IF ${routingView.callers.map(a => `@${a.role}`).join(" ∨ ") || "caller"} runs on (OR)`,
              value: formatTriggerLabel(routingDraft.triggers),
              isLastAgent: false,
            },
            ...routingView.related.map((agent, i) => ({
              kind: "agent" as const,
              role: agent.role,
              label: agent.name,
              value:
                routingDraft.roles[agent.role] && routingDraft.roles[agent.role] !== INHERIT
                  ? routingDraft.roles[agent.role]
                  : INHERIT,
              isLastAgent: i === routingView.related.length - 1,
            })),
            { kind: "tools" as const, role: "", label: "Tools & MCP policy [U]", value: toolsSummary, isLastAgent: false },
            { kind: "permissions" as const, role: "", label: "Permissions policy [P]", value: permSummary, isLastAgent: false },
            { kind: "delegations" as const, role: "", label: "Subagent delegations [G]", value: delSummary, isLastAgent: false },
          ]

          const safeEditorOffset = clampListScroll(
            routingEditorFocus,
            editorRows.length,
            routingEditorScroll,
            layout.editorViewportRows,
          )
          const visibleEditorRows = editorRows.slice(safeEditorOffset, safeEditorOffset + layout.editorViewportRows)
          const leftColW = Math.max(18, Math.floor(innerWidth * 0.44))
          const rightColW = Math.max(14, innerWidth - leftColW - 2)

          return (
            <>
              <box flexDirection="column" width="100%" flexGrow={1} minHeight={0} overflow="hidden">
                <box
                  width="100%"
                  height={2}
                  flexShrink={0}
                  borderStyle="single"
                  border={["bottom"]}
                  borderColor={THEME.borderSubtle}
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <box flexDirection="row" overflow="hidden">
                    <text height={1} wrapMode="none" style={{ textColor: THEME.accentAmber }} b>
                      {middleEllipsis(
                        `◉ ${routingView.callers.map(c => `@${c.name}`).join(" ∨ ") || "(no callers)"}`,
                        Math.max(14, Math.floor(innerWidth * 0.45)),
                      )}
                    </text>
                    <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                      {"  ──▶  "}
                    </text>
                    <text height={1} wrapMode="none" style={{ textColor: THEME.accentCyan }} b>
                      {middleEllipsis(
                        `IF ${formatTriggerLabel(routingDraft.triggers)}`,
                        Math.max(14, Math.floor(innerWidth * 0.42)),
                      )}
                    </text>
                  </box>
                  <text
                    height={1}
                    wrapMode="none"
                    style={{ textColor: THEME.fgSecondary }}
                    onMouseDown={() => onBackToConfigs()}
                  >
                    [ESC] Branches
                  </text>
                </box>

                <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                  {middleEllipsis(
                    "Assign target models per @subagent (Space/A batch-select, Tab/←/→ cycle #effort, Del reset to inherit):",
                    innerWidth,
                  )}
                </text>

                {hasPinned && (
                  <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
                    {middleEllipsis(
                      `📌 Pinned (fixed model, skipped): ${routingView.pinned.map(a => `@${a.role}=${a.model}`).join(", ")}`,
                      innerWidth,
                    )}
                  </text>
                )}

                {hasStaticWarn && (
                  <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentAmber }}>
                    {middleEllipsis(
                      `⚠ Static 'deny' on caller frontmatter overrides runtime 'allow' (${[...blockedAllowTools, ...blockedAllowDels].join(", ")})`,
                      innerWidth,
                    )}
                  </text>
                )}

                <box
                  flexGrow={1}
                  minHeight={0}
                  flexDirection="column"
                  overflow="hidden"
                  onMouseScroll={(_self, event) => {
                    const dir = (event as any).scroll?.direction
                    if (dir === "down") onScrollEditor(2)
                    else if (dir === "up") onScrollEditor(-2)
                  }}
                >
                  {visibleEditorRows.map((row, idx) => {
                    const index = safeEditorOffset + idx
                    const focused = index === routingEditorFocus
                    const selected = row.kind === "agent" && routingSelected.has(row.role)

                    const connector = row.kind === "agent" ? (row.isLastAgent ? "╰─▶ " : "├─▶ ") : ""
                    const leftText =
                      row.kind === "agent"
                        ? `${focused ? "▎ " : "  "}${connector}${selected ? "[✓]" : "[ ]"} @${terminalSafeText(row.role)}`
                        : `${focused ? "▎ " : "  "}${terminalSafeText(row.label)}`

                    const leftColor = focused
                      ? "#ffffff"
                      : row.kind === "triggers"
                        ? THEME.accentAmber
                        : row.kind === "agent"
                          ? selected
                            ? THEME.accentGreen
                            : THEME.fgPrimary
                          : THEME.accentPurple

                    const renderRightValue = () => {
                      if (row.kind === "agent") {
                        if (row.value === INHERIT) {
                          return (
                            <text
                              height={1}
                              wrapMode="none"
                              overflow="hidden"
                              style={{ textColor: focused ? THEME.fgPrimary : THEME.fgMuted }}
                            >
                              {middleEllipsis("↺ inherit (same model as caller)", rightColW)}
                            </text>
                          )
                        }
                        const { base, variant } = splitModelAndVariant(row.value)
                        const variantChip = variant ? ` #${variant}` : ""
                        const baseBudget = Math.max(8, rightColW - displayWidth(variantChip) - 4)
                        return (
                          <box flexDirection="row" overflow="hidden">
                            <text height={1} wrapMode="none" style={{ textColor: THEME.accentGreen }}>
                              {"──▶ "}
                            </text>
                            <text
                              height={1}
                              wrapMode="none"
                              overflow="hidden"
                              style={{ textColor: focused ? "#ffffff" : THEME.accentCyan }}
                              b={focused}
                            >
                              {middleEllipsis(terminalSafeText(base), baseBudget)}
                            </text>
                            {variant ? (
                              <text height={1} wrapMode="none" style={{ textColor: THEME.accentPurple }} b>
                                {variantChip}
                              </text>
                            ) : null}
                          </box>
                        )
                      }

                      const isDefault = row.value.startsWith("unchanged")
                      return (
                        <text
                          height={1}
                          wrapMode="none"
                          overflow="hidden"
                          style={{
                            textColor: focused
                              ? "#ffffff"
                              : row.kind === "triggers"
                                ? THEME.accentCyan
                                : isDefault
                                  ? THEME.fgMuted
                                  : THEME.accentGreen,
                          }}
                          b={row.kind === "triggers" || (!isDefault && focused)}
                        >
                          {middleEllipsis(terminalSafeText(row.value), rightColW)}
                        </text>
                      )
                    }

                    return (
                      <box
                        key={`routing-row-${index}`}
                        width="100%"
                        height={1}
                        flexShrink={0}
                        flexDirection="row"
                        justifyContent="space-between"
                        backgroundColor={focused ? THEME.bgRowFocus : selected ? THEME.bgRowSelected : "transparent"}
                        paddingLeft={1}
                        paddingRight={1}
                        onMouseDown={() => {
                          if (focused) {
                            onActivateEditorRow(index)
                          } else {
                            onFocusEditorRow(index)
                          }
                        }}
                      >
                        <text
                          height={1}
                          wrapMode="none"
                          overflow="hidden"
                          width={leftColW}
                          style={{ textColor: leftColor }}
                          b={focused || row.kind === "triggers"}
                          onMouseDown={(_self, event) => {
                            if (row.kind === "agent") {
                              event.stopPropagation()
                              onFocusEditorRow(index)
                              onToggleEditorAgentSelect(row.role)
                            }
                          }}
                        >
                          {middleEllipsis(leftText, leftColW)}
                        </text>
                        <box width={rightColW} height={1} flexDirection="row" justifyContent="flex-start" overflow="hidden">
                          {renderRightValue()}
                        </box>
                      </box>
                    )
                  })}
                </box>
              </box>

              <box flexDirection="column" width="100%" flexShrink={0}>
                {renderStatusBanner()}
                <box
                  width="100%"
                  height={2}
                  borderStyle="single"
                  border={["top"]}
                  borderColor={THEME.borderSubtle}
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                    {middleEllipsis(
                      `${routingEditorFocus + 1}/${editorRows.length} · [Space/A] Mark · [Enter/M] Pick · [Tab] Effort`,
                      Math.max(18, innerWidth - 34),
                    )}
                  </text>
                  <box flexDirection="row">
                    <text
                      height={1}
                      wrapMode="none"
                      style={{ textColor: THEME.accentCyan }}
                      onMouseDown={() => onOpenSubPolicy("routing-tools")}
                    >
                      {"[U] Tools  "}
                    </text>
                    <text
                      height={1}
                      wrapMode="none"
                      style={{ textColor: THEME.accentPurple }}
                      onMouseDown={() => onOpenSubPolicy("routing-permissions")}
                    >
                      {"[P] Perms  "}
                    </text>
                    <text
                      height={1}
                      wrapMode="none"
                      style={{ textColor: THEME.accentGreen }}
                      onMouseDown={() => onOpenSubPolicy("routing-delegations")}
                    >
                      [G] Delegations
                    </text>
                  </box>
                </box>
              </box>
            </>
          )
        })() : (() => {
          // Mode: routing-configs (Master-Detail with Live Dependency Graph on wide screens, stacked cards on compact)
          const allFlowItems: PackConfigRow[] = [...routingView.flows, null, ...mcpServers.map(mcp => ({ mcp }))]
          const clampedFocus = Math.max(0, Math.min(allFlowItems.length - 1, routingFocus))
          const safeConfigOffset = clampListScroll(
            clampedFocus,
            allFlowItems.length,
            routingScroll,
            layout.configViewportRows,
          )
          const visibleFlowItems = allFlowItems.slice(safeConfigOffset, safeConfigOffset + layout.configViewportRows)
          const isMcpRow = (row: PackConfigRow | null | undefined): row is { mcp: PackMcpServerRow } => Boolean(row && "mcp" in row)
          const focusedRow = allFlowItems[clampedFocus] ?? null
          const focusedFlow: UnifiedFlowItem | null = !isMcpRow(focusedRow) ? (focusedRow as UnifiedFlowItem | null) : null
          const focusedMcp: PackMcpServerRow | null = isMcpRow(focusedRow) ? focusedRow.mcp : null

          const mcpBadge = (server: PackMcpServerRow) => ({ label: server.enabled ? "ON" : "OFF", fg: server.enabled ? THEME.accentGreen : THEME.accentRed })
          const renderMcpRow = (server: PackMcpServerRow, index: number, focused: boolean, width: number) => {
            const badge = mcpBadge(server)
            const titleBudget = Math.max(10, width - 16)
            return (
              <box
                key={`mcp-${server.name}`}
                width="100%"
                height={layout.branchRowHeight}
                flexShrink={0}
                flexDirection="column"
                backgroundColor={focused ? THEME.bgRowFocus : "transparent"}
                paddingLeft={1}
                paddingRight={1}
                onMouseDown={() => {
                  if (focused) onToggleMcpServer(server.name)
                  else onFocusBranch(index)
                }}
              >
                <box width="100%" height={1} flexDirection="row" justifyContent="space-between">
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: focused ? "#ffffff" : THEME.accentCyan }} b>
                    {middleEllipsis(
                      `${focused ? "▎" : " "} ⚡ MCP ${terminalSafeText(server.name)}${server.overridden ? " ✎" : ""}`,
                      titleBudget,
                    )}
                  </text>
                  <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={server.enabled ? THEME.bgSuccessSoft : THEME.bgDangerSoft}>
                    <text height={1} wrapMode="none" style={{ textColor: badge.fg }} b>
                      {`[${badge.label}]`}
                    </text>
                  </box>
                </box>
                {layout.branchRowHeight === 2 && (
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: focused ? THEME.accentCyan : THEME.fgMuted }}>
                    {middleEllipsis("   ╰─▶ [ENTER]/[T] toggle · saved in overrides.json", Math.max(12, width - 4))}
                  </text>
                )}
              </box>
            )
          }

          const callersText = routingView.callers.length > 0
            ? routingView.callers.map(c => `@${c.name}`).join(" ∨ ")
            : "(no callers)"

          const leftPaneWidth = layout.splitMasterDetail ? Math.max(32, Math.floor((innerWidth - 1) * 0.41)) : innerWidth
          const rightPaneWidth = layout.splitMasterDetail ? Math.max(34, innerWidth - leftPaneWidth - 1) : 0
          const leftInner = Math.max(16, leftPaneWidth - 4)
          const rightInner = Math.max(20, rightPaneWidth - 4)

          const describeBranchCounts = (flow: UnifiedFlowItem) => {
            const routed = routingView.related.filter(a => flow.roles[a.role] && flow.roles[a.role] !== INHERIT)
            const distinctTargets = new Set(routed.map(a => flow.roles[a.role])).size
            const policyCount =
              Object.keys(flow.tools).length +
              Object.keys(flow.permissions).length +
              Object.keys(flow.delegations).length
            const modelPart =
              routingView.related.length === 0
                ? "no routable subagents"
                : routed.length === 0
                  ? `all ${routingView.related.length} inherit caller`
                  : `${routed.length}/${routingView.related.length} routed → ${distinctTargets} model${distinctTargets === 1 ? "" : "s"}`
            return policyCount > 0 ? `${modelPart} · ${policyCount} pol` : modelPart
          }

          const renderRightDependencyGraph = () => {
            const graphInnerRows = Math.max(4, layout.bodyHeight - 2)
            if (focusedMcp) {
              const badge = mcpBadge(focusedMcp)
              return (
                <box flexDirection="column" width="100%" flexGrow={1} overflow="hidden">
                  <box width="100%" height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
                    <text height={1} wrapMode="none" style={{ textColor: THEME.accentCyan }} b>
                      {"⚡ MCP SERVER"}
                    </text>
                    <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={focusedMcp.enabled ? THEME.bgSuccessSoft : THEME.bgDangerSoft}>
                      <text height={1} wrapMode="none" style={{ textColor: badge.fg }} b>
                        {`[${badge.label}]`}
                      </text>
                    </box>
                  </box>
                  <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }} b>
                    {middleEllipsis(`  ${terminalSafeText(focusedMcp.name)}`, rightInner)}
                  </text>
                  <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }} marginTop={1}>
                    {middleEllipsis(
                      focusedMcp.enabled
                        ? "Contributed enabled by this pack's opencode.json."
                        : "Disabled for this target (the pack still contributes it, with an override).",
                      rightInner,
                    )}
                  </text>
                  <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: focusedMcp.overridden ? THEME.accentPurple : THEME.fgMuted }}>
                    {middleEllipsis(
                      focusedMcp.overridden
                        ? "✎ Patched by your overrides.json → config (mcp.servers)."
                        : "Pack default; a toggle writes overrides.json → config (mcp.servers).",
                      rightInner,
                    )}
                  </text>
                  <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }} marginTop={1}>
                    {middleEllipsis("[ENTER] / [T] / click: toggle on/off (reconciles the target).", rightInner)}
                  </text>
                  <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
                    {middleEllipsis(
                      `CLI: override config-set ${terminalSafeText(packName)}/mcp.servers/${terminalSafeText(focusedMcp.name)} ...`,
                      rightInner,
                    )}
                  </text>
                </box>
              )
            }
            if (!focusedFlow) {
              return (
                <box flexDirection="column" width="100%" flexGrow={1} overflow="hidden">
                  <text height={1} wrapMode="none" style={{ textColor: THEME.accentGreen }} b>
                    {"➕ Create a New Conditional Branch (IF / OR)"}
                  </text>
                  <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }} marginTop={1}>
                    {middleEllipsis(`1. Entry Callers (OR): ${callersText}`, rightInner)}
                  </text>
                  <text height={1} wrapMode="none" style={{ textColor: THEME.accentCyan }}>
                    {middleEllipsis("   ╰─▶ Press [C] to choose primary caller agents.", rightInner)}
                  </text>
                  <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }} marginTop={1}>
                    {middleEllipsis("2. IF Condition (OR): match provider or model(s)", rightInner)}
                  </text>
                  <text height={1} wrapMode="none" style={{ textColor: THEME.accentAmber }}>
                    {middleEllipsis("   ╰─▶ In picker, [SPACE]/[TAB] combines OR triggers.", rightInner)}
                  </text>
                  <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }} marginTop={1}>
                    {middleEllipsis(
                      `3. Downstream Subagents (${routingView.related.length} routable${routingView.pinned.length ? `, ${routingView.pinned.length} pinned` : ""}):`,
                      rightInner,
                    )}
                  </text>
                  <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                    {middleEllipsis(
                      routingView.related.length
                        ? `   ╰─▶ ${routingView.related.map(a => `@${a.role}`).join(", ")}`
                        : "   ╰─▶ Only policy overrides apply (no routable subagents).",
                      rightInner,
                    )}
                  </text>
                </box>
              )
            }

            const effectiveCallers = focusedFlow.callers?.length
              ? focusedFlow.callers.map(c => `@${c}`).join(" ∨ ")
              : callersText
            const callerScopeTag = focusedFlow.callers?.length ? "rule callers" : routingView.callerSource
            const badge = originBadgeMeta(focusedFlow.origin)

            const toolEntries = Object.entries(focusedFlow.tools)
            const permEntries = Object.entries(focusedFlow.permissions)
            const delEntries = Object.entries(focusedFlow.delegations)
            const hasPolicies = toolEntries.length + permEntries.length + delEntries.length > 0

            // Budget rows inside graph card so subagent tree never clips footer/policies:
            // Callers (2) + Trigger (2) + Subagent header (1) + Pinned (0|1) + Policies (1) = 6..7 rows
            const reservedGraphChrome = 6 + (routingView.pinned.length > 0 ? 1 : 0)
            const availSubRows = Math.max(1, graphInnerRows - reservedGraphChrome)

            // Show individual @subagent rows when they fit, or group by target model when pack is huge!
            type DepLine = { id: string; agentsLabel: string; targetModel: string; isInherit: boolean }
            const depLines: DepLine[] = (() => {
              if (routingView.related.length <= availSubRows) {
                return routingView.related.map(ag => {
                  const target = focusedFlow.roles[ag.role] && focusedFlow.roles[ag.role] !== INHERIT
                    ? focusedFlow.roles[ag.role]!
                    : INHERIT
                  return {
                    id: ag.role,
                    agentsLabel: `@${ag.role}`,
                    targetModel: target,
                    isInherit: target === INHERIT,
                  }
                })
              }
              const byModel = new Map<string, string[]>()
              for (const ag of routingView.related) {
                const target = focusedFlow.roles[ag.role] && focusedFlow.roles[ag.role] !== INHERIT
                  ? focusedFlow.roles[ag.role]!
                  : INHERIT
                let list = byModel.get(target)
                if (!list) {
                  list = []
                  byModel.set(target, list)
                }
                list.push(`@${ag.role}`)
              }
              const entries = [...byModel.entries()]
              if (entries.length <= availSubRows) {
                return entries.map(([target, roles], idx) => ({
                  id: `grp-${idx}`,
                  agentsLabel: roles.length <= 2 ? roles.join(", ") : `${roles[0]} +${roles.length - 1}`,
                  targetModel: target,
                  isInherit: target === INHERIT,
                }))
              }
              const shown = entries.slice(0, Math.max(1, availSubRows - 1)).map(([target, roles], idx) => ({
                id: `grp-${idx}`,
                agentsLabel: roles.length <= 2 ? roles.join(", ") : `${roles[0]} +${roles.length - 1}`,
                targetModel: target,
                isInherit: target === INHERIT,
              }))
              const hiddenGroups = entries.length - shown.length
              shown.push({
                id: "grp-more",
                agentsLabel: `+${hiddenGroups} more`,
                targetModel: "press ENTER to inspect all routes",
                isInherit: true,
              })
              return shown
            })()

            const roleColWidth = Math.min(
              Math.max(10, Math.floor(rightInner * 0.30)),
              Math.max(10, ...depLines.map(d => displayWidth(d.agentsLabel) + 1)),
            )

            return (
              <box flexDirection="column" width="100%" flexGrow={1} overflow="hidden">
                {/* 1. Entry Callers */}
                <box width="100%" height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
                  <box flexDirection="row" overflow="hidden">
                    <text height={1} wrapMode="none" style={{ textColor: THEME.accentAmber }} b>
                      {"◉ CALLERS (OR) "}
                    </text>
                    <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                      {`[${callerScopeTag}]`}
                    </text>
                  </box>
                  <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={badge.bg}>
                    <text height={1} wrapMode="none" style={{ textColor: badge.fg }} b>
                      {`#${clampedFocus + 1} ${badge.label}`}
                    </text>
                  </box>
                </box>
                <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }} b>
                  {middleEllipsis(`  ${terminalSafeText(effectiveCallers)}`, rightInner)}
                </text>

                {/* 2. IF Trigger Condition */}
                <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentCyan }} b>
                  {"  │  ▼  IF CALLER RUNS ON (OR)"}
                </text>
                <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentAmber }} b>
                  {middleEllipsis(
                    `  ⚡ ${focusedFlow.triggers.map(formatFlowTriggerVerbose).join("  ∨  ")}`,
                    rightInner,
                  )}
                </text>

                {/* 3. Downstream Subagents */}
                <box width="100%" height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
                  <text height={1} wrapMode="none" style={{ textColor: THEME.accentGreen }} b>
                    {`  ├─▶ SUBAGENT DEPENDENCIES (${routingView.related.length})`}
                  </text>
                  <text
                    height={1}
                    wrapMode="none"
                    style={{ textColor: THEME.accentCyan }}
                    u
                    onMouseDown={() => onOpenBranch(clampedFocus)}
                  >
                    [ENTER] Edit
                  </text>
                </box>

                {depLines.length === 0 ? (
                  <text height={1} flexShrink={0} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                    {"  │   ╰─ (no routable subagents in this pack)"}
                  </text>
                ) : (
                  depLines.map((dep, dIdx) => {
                    const branchChar = dIdx === depLines.length - 1 ? "  │   ╰─ " : "  │   ├─ "
                    const clippedAgent = middleEllipsis(dep.agentsLabel, roleColWidth)
                    const paddedAgent = clippedAgent + " ".repeat(Math.max(0, roleColWidth - displayWidth(clippedAgent)))
                    const usedLeft = displayWidth(branchChar) + roleColWidth + 5
                    const modelBudget = Math.max(10, rightInner - usedLeft)
                    const { base, variant } = dep.isInherit ? { base: "", variant: "" } : splitModelAndVariant(dep.targetModel)
                    const variantStr = variant ? ` #${variant}` : ""
                    const baseBudget = Math.max(6, modelBudget - displayWidth(variantStr))

                    return (
                      <box key={dep.id} width="100%" height={1} flexShrink={0} flexDirection="row" overflow="hidden">
                        <text height={1} wrapMode="none" style={{ textColor: THEME.borderFocus }}>
                          {branchChar}
                        </text>
                        <text height={1} wrapMode="none" style={{ textColor: dep.isInherit ? THEME.fgSecondary : "#ffffff" }} b={!dep.isInherit}>
                          {paddedAgent}
                        </text>
                        {dep.id === "grp-more" ? (
                          <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentAmber }}>
                            {middleEllipsis(` ──▶ ${dep.targetModel}`, modelBudget + 5)}
                          </text>
                        ) : dep.isInherit ? (
                          <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
                            {middleEllipsis(" ──▶ ↺ inherit caller model", modelBudget + 5)}
                          </text>
                        ) : (
                          <box flexDirection="row" overflow="hidden">
                            <text height={1} wrapMode="none" style={{ textColor: THEME.accentGreen }}>
                              {" ──▶ "}
                            </text>
                            <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentCyan }}>
                              {middleEllipsis(terminalSafeText(base), baseBudget)}
                            </text>
                            {variant ? (
                              <text height={1} wrapMode="none" style={{ textColor: THEME.accentPurple }} b>
                                {variantStr}
                              </text>
                            ) : null}
                          </box>
                        )}
                      </box>
                    )
                  })
                )}

                {/* 4. Pinned Subagents (if any) */}
                {routingView.pinned.length > 0 && (
                  <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
                    {middleEllipsis(
                      `  ├─ 📌 Pinned (fixed): ${routingView.pinned.map(a => `@${a.role} → ${a.model}`).join(" · ")}`,
                      rightInner,
                    )}
                  </text>
                )}

                {/* 5. Runtime Policies */}
                <text
                  height={1}
                  flexShrink={0}
                  wrapMode="none"
                  overflow="hidden"
                  style={{ textColor: hasPolicies ? THEME.accentPurple : THEME.fgMuted }}
                >
                  {middleEllipsis(
                    hasPolicies
                      ? `  ╰─▶ 🛡 Policies: ${[
                          toolEntries.length ? `tools(${toolEntries.map(([k, v]) => `${k}:${v}`).join(",")})` : "",
                          permEntries.length ? `perms(${permEntries.map(([k, v]) => `${k}:${v}`).join(",")})` : "",
                          delEntries.length ? `delegations(${delEntries.map(([k, v]) => `${k}:${v}`).join(",")})` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}`
                      : "  ╰─▶ 🛡 Policies: tools, permissions & delegations unchanged",
                    rightInner,
                  )}
                </text>
              </box>
            )
          }

          return (
            <>
              <box flexDirection="column" width="100%" flexGrow={1} minHeight={0} overflow="hidden">
                {/* Top Callers Pipeline Header */}
                <box
                  width="100%"
                  height={2}
                  flexShrink={0}
                  borderStyle="single"
                  border={["bottom"]}
                  borderColor={THEME.borderSubtle}
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <box flexDirection="row" overflow="hidden">
                    <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
                      {"Callers (OR): "}
                    </text>
                    <text height={1} wrapMode="none" style={{ textColor: THEME.accentAmber }} b>
                      {middleEllipsis(
                        terminalSafeText(callersText),
                        Math.max(8, innerWidth - 32 - displayWidth(` [${routingView.callerSource}]`)),
                      )}
                    </text>
                    <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                      {` [${routingView.callerSource}]`}
                    </text>
                  </box>
                  <text
                    height={1}
                    wrapMode="none"
                    style={{ textColor: THEME.accentCyan }}
                    b
                    u
                    onMouseDown={() => onOpenCallers()}
                  >
                    [C] Edit Callers
                  </text>
                </box>

                {/* Sync & Persistence Subtitle */}
                <box width="100%" height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                    {middleEllipsis(
                      isReadOnlyGitSource
                        ? "Saved in user settings (routing.json) · reconciles OpenCode target automatically"
                        : routingView.hasManifest
                          ? "Saved in user settings (routing.json) · reconciles target automatically"
                          : "Virtual .md pack · saved in routing.json",
                      Math.max(20, innerWidth - 24),
                    )}
                  </text>
                  {!isReadOnlyGitSource && (
                    <text
                      height={1}
                      wrapMode="none"
                      style={{ textColor: routingView.hasManifest ? THEME.accentPurple : THEME.accentGreen }}
                      u
                      onMouseDown={() => (routingView.hasManifest ? onExportManifest() : onOpenInitPack())}
                    >
                      {routingView.hasManifest ? "[W] Export to pack" : "[I] Init pack"}
                    </text>
                  )}
                </box>

                {!layout.splitMasterDetail && hasPinned && (
                  <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
                    {middleEllipsis(
                      `📌 Pinned: ${routingView.pinned.map(a => `@${a.role}=${a.model}`).join(", ")}`,
                      innerWidth,
                    )}
                  </text>
                )}

                {/* Body: Split Master-Detail on normal/wide terminals, compact cards on narrow terminals */}
                {layout.splitMasterDetail ? (
                  <box width="100%" height={layout.bodyHeight} flexDirection="row" overflow="hidden">
                    {/* Left Master List: IF Branches */}
                    <box
                      width={leftPaneWidth}
                      height={layout.bodyHeight}
                      flexShrink={0}
                      border={true}
                      borderStyle="rounded"
                      borderColor={THEME.borderFocus}
                      backgroundColor={THEME.bgPanel}
                      paddingLeft={1}
                      paddingRight={1}
                      flexDirection="column"
                      overflow="hidden"
                      onMouseScroll={(_self, event) => {
                        const dir = (event as any).scroll?.direction
                        if (dir === "down") onScrollBranches(1)
                        else if (dir === "up") onScrollBranches(-1)
                      }}
                    >
                      <box
                        width="100%"
                        height={2}
                        flexShrink={0}
                        borderStyle="single"
                        border={["bottom"]}
                        borderColor={THEME.borderSubtle}
                        flexDirection="row"
                        justifyContent="space-between"
                        alignItems="center"
                      >
                        <text height={1} wrapMode="none" style={{ textColor: THEME.accentCyan }} b>
                          {`IF Branches (${routingView.flows.length})${mcpServers.length ? ` + MCP (${mcpServers.length})` : ""}`}
                        </text>
                        <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                          {`${clampedFocus + 1}/${allFlowItems.length}`}
                        </text>
                      </box>

                      <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
                        {visibleFlowItems.map((flow, idx) => {
                          const index = safeConfigOffset + idx
                          const focused = index === clampedFocus

                          if (isMcpRow(flow)) return renderMcpRow(flow.mcp, index, focused, leftInner)

                          if (!flow) {
                            return (
                              <box
                                key="routing-new"
                                width="100%"
                                height={layout.branchRowHeight}
                                flexShrink={0}
                                flexDirection="column"
                                backgroundColor={focused ? THEME.bgRowFocus : "transparent"}
                                paddingLeft={1}
                                paddingRight={1}
                                onMouseDown={() => {
                                  onFocusBranch(index)
                                  onOpenBranch(index)
                                }}
                              >
                                <text
                                  height={1}
                                  wrapMode="none"
                                  overflow="hidden"
                                  style={{ textColor: focused ? "#ffffff" : THEME.accentGreen }}
                                  b
                                >
                                  {middleEllipsis(`${focused ? "▎ " : "  "}+ New conditional flow (IF / OR)`, leftInner - 2)}
                                </text>
                                {layout.branchRowHeight === 2 && (
                                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: focused ? THEME.accentCyan : THEME.fgMuted }}>
                                    {middleEllipsis("   Pick trigger & subagent models", leftInner - 4)}
                                  </text>
                                )}
                              </box>
                            )
                          }

                          const badge = originBadgeMeta(flow.origin)
                          const triggerStr = flow.triggers.map(formatFlowTriggerShort).join(" ∨ ")
                          const badgeW = displayWidth(badge.label) + 2
                          const titleBudget = Math.max(10, leftInner - badgeW - 3)

                          return (
                            <box
                              key={flow.key}
                              width="100%"
                              height={layout.branchRowHeight}
                              flexShrink={0}
                              flexDirection="column"
                              backgroundColor={focused ? THEME.bgRowFocus : "transparent"}
                              paddingLeft={1}
                              paddingRight={1}
                              onMouseDown={() => {
                                if (focused) onOpenBranch(index)
                                else onFocusBranch(index)
                              }}
                            >
                              <box width="100%" height={1} flexDirection="row" justifyContent="space-between">
                                <text
                                  height={1}
                                  wrapMode="none"
                                  overflow="hidden"
                                  style={{ textColor: focused ? "#ffffff" : THEME.accentAmber }}
                                  b
                                >
                                  {middleEllipsis(
                                    `${focused ? "▎" : " "} #${index + 1} IF ${terminalSafeText(triggerStr)}`,
                                    titleBudget,
                                  )}
                                </text>
                                <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={badge.bg}>
                                  <text height={1} wrapMode="none" style={{ textColor: badge.fg }} b>
                                    {badge.label}
                                  </text>
                                </box>
                              </box>
                              {layout.branchRowHeight === 2 && (
                                <text
                                  height={1}
                                  wrapMode="none"
                                  overflow="hidden"
                                  style={{ textColor: focused ? THEME.accentCyan : THEME.fgSecondary }}
                                >
                                  {middleEllipsis(`   ╰─▶ ${describeBranchCounts(flow)}`, leftInner - 2)}
                                </text>
                              )}
                            </box>
                          )
                        })}
                      </box>
                    </box>

                    <text width={1}> </text>

                    {/* Right Detail Pane: Live Visual Dependency Graph */}
                    <box
                      width={rightPaneWidth}
                      height={layout.bodyHeight}
                      flexShrink={0}
                      border={true}
                      borderStyle="rounded"
                      borderColor={THEME.borderSubtle}
                      backgroundColor={THEME.bgInput}
                      paddingLeft={1}
                      paddingRight={1}
                      flexDirection="column"
                      overflow="hidden"
                    >
                      {renderRightDependencyGraph()}
                    </box>
                  </box>
                ) : (
                  /* Compact Single-Column Fallback (< 82 cols) */
                  <box
                    width="100%"
                    height={layout.bodyHeight}
                    flexDirection="column"
                    overflow="hidden"
                    onMouseScroll={(_self, event) => {
                      const dir = (event as any).scroll?.direction
                      if (dir === "down") onScrollBranches(1)
                      else if (dir === "up") onScrollBranches(-1)
                    }}
                  >
                    {visibleFlowItems.map((flow, idx) => {
                      const index = safeConfigOffset + idx
                      const focused = index === clampedFocus
                      if (isMcpRow(flow)) return renderMcpRow(flow.mcp, index, focused, innerWidth)
                      if (!flow) {
                        return (
                          <box
                            key="routing-new"
                            width="100%"
                            height={layout.branchRowHeight}
                            flexShrink={0}
                            flexDirection="column"
                            backgroundColor={focused ? THEME.bgRowFocus : "transparent"}
                            paddingLeft={1}
                            onMouseDown={() => {
                              onFocusBranch(index)
                              onOpenBranch(index)
                            }}
                          >
                            <text height={1} wrapMode="none" style={{ textColor: focused ? "#ffffff" : THEME.accentGreen }} b>
                              {middleEllipsis(`${focused ? "▎ " : "  "}+ New conditional flow (IF / OR)`, innerWidth - 2)}
                            </text>
                            {layout.branchRowHeight === 2 && (
                              <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                                {middleEllipsis("    Pick trigger & route subagent models", innerWidth - 2)}
                              </text>
                            )}
                          </box>
                        )
                      }
                      const badge = originBadgeMeta(flow.origin)
                      return (
                        <box
                          key={flow.key}
                          width="100%"
                          height={layout.branchRowHeight}
                          flexShrink={0}
                          flexDirection="column"
                          backgroundColor={focused ? THEME.bgRowFocus : "transparent"}
                          paddingLeft={1}
                          paddingRight={1}
                          onMouseDown={() => {
                            if (focused) onOpenBranch(index)
                            else onFocusBranch(index)
                          }}
                        >
                          <box width="100%" height={1} flexDirection="row" justifyContent="space-between">
                            <text height={1} wrapMode="none" style={{ textColor: focused ? "#ffffff" : THEME.accentAmber }} b>
                              {middleEllipsis(
                                `${focused ? "▎" : " "} #${index + 1} IF ${flow.triggers.map(formatFlowTriggerShort).join(" ∨ ")}`,
                                innerWidth - 12,
                              )}
                            </text>
                            <text height={1} wrapMode="none" style={{ textColor: badge.fg }} b>
                              {`[${badge.label}]`}
                            </text>
                          </box>
                          {layout.branchRowHeight === 2 && (
                            <text height={1} wrapMode="none" style={{ textColor: focused ? THEME.accentCyan : THEME.fgSecondary }}>
                              {middleEllipsis(`   ╰─▶ ${summarizeUnifiedFlow(flow, routingView.related)}`, innerWidth - 2)}
                            </text>
                          )}
                        </box>
                      )
                    })}
                  </box>
                )}
              </box>

              <box flexDirection="column" width="100%" flexShrink={0}>
                {renderStatusBanner()}
                <box
                  width="100%"
                  height={2}
                  borderStyle="single"
                  border={["top"]}
                  borderColor={THEME.borderSubtle}
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                    {middleEllipsis(
                      `↑/↓ Branch · [Enter] Edit/New${mcpServers.length ? " · [T] MCP on/off" : ""} · [C] Callers${!isReadOnlyGitSource ? (routingView.hasManifest ? " · [W] Export" : " · [I] Init") : ""} · [D] Delete`,
                      Math.max(18, innerWidth - 16),
                    )}
                  </text>
                  <text
                    height={1}
                    wrapMode="none"
                    style={{ textColor: THEME.fgPrimary }}
                    b
                    onMouseDown={() => onClose()}
                  >
                    [ESC] Close
                  </text>
                </box>
              </box>
            </>
          )
        })()}
      </box>
    </box>
  )
}
