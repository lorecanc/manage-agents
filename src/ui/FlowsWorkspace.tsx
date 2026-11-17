import React from "react"
import type { AgentInfo } from "../utils/agents.js"
import { callersLabel, INHERIT, type ArchetypeAgent, type PackFlowsView, type UnifiedFlowItem } from "../utils/archetypes.js"
import { clampListScroll } from "../utils/layout.js"
import { displayWidth, middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { lerpColor, THEME } from "../utils/uiTheme.js"
import { formatFlowTriggerShort, splitModelAndVariant } from "./PackFlowsModal.js"

export interface FlowsNavRow {
  kind: "pack" | "agent"
  id: string
  pack: string
  label: string
  agent?: AgentInfo
  flowCount: number
  outboundCount: number
  inboundCount: number
  deadRefCount: number
}

export interface FlowsNavData {
  rows: FlowsNavRow[]
  inboundByAgentName: Map<string, string[]>
  agentByShortName: Map<string, AgentInfo>
}

export type FlowsInspectorItem =
  | { kind: "flow"; id: string; pack: string; flowIndex: number; flow: UnifiedFlowItem }
  | { kind: "subagent"; id: string; subName: string; targetAgent?: AgentInfo }

export function buildFlowsInspectorItems(
  currentRow: FlowsNavRow | null,
  agents: AgentInfo[],
  packFlowsByCategory: Map<string, PackFlowsView | null>,
  agentByShortName: Map<string, AgentInfo>,
): {
  selectedFlowView: PackFlowsView | null
  activeAgent: AgentInfo | undefined
  items: FlowsInspectorItem[]
} {
  const selectedFlowView = currentRow ? (packFlowsByCategory.get(currentRow.pack) ?? null) : null
  const activeAgent =
    currentRow?.agent ??
    (currentRow
      ? agents.find(a => a.category === currentRow.pack && (a.allowedSubagents?.length ?? 0) > 0) ??
        agents.find(a => a.category === currentRow.pack)
      : undefined)

  const items: FlowsInspectorItem[] = []
  if (currentRow && selectedFlowView) {
    selectedFlowView.flows.forEach((flow, idx) => {
      items.push({
        kind: "flow",
        id: `flow:${flow.key}`,
        pack: currentRow.pack,
        flowIndex: idx,
        flow,
      })
    })
  }
  if (activeAgent) {
    for (const subName of activeAgent.allowedSubagents ?? []) {
      items.push({
        kind: "subagent",
        id: `sub:${subName}`,
        subName,
        targetAgent: agentByShortName.get(subName),
      })
    }
  }
  return { selectedFlowView, activeAgent, items }
}

function summarizeFlowCompactTargets(flow: UnifiedFlowItem, related: readonly ArchetypeAgent[], maxBudget: number): string {
  const routed = related.filter(a => flow.roles[a.role] && flow.roles[a.role] !== INHERIT)
  const policyCount =
    Object.keys(flow.tools).length +
    Object.keys(flow.permissions).length +
    Object.keys(flow.delegations).length

  if (routed.length === 0) {
    return policyCount > 0 ? `──▶ ${policyCount} pol` : "──▶ ↺ inherit"
  }
  const distinctModels = [...new Set(routed.map(a => flow.roles[a.role]!))]
  if (distinctModels.length === 1) {
    const { base, variant } = splitModelAndVariant(distinctModels[0]!)
    const shortModel = base.includes("/") ? base.split("/").slice(1).join("/") : base
    const full = `──▶ ${shortModel}${variant ? `#${variant}` : ""}`
    if (displayWidth(full) <= maxBudget) return full
  }
  const fullSummary = `──▶ ${routed.length}/${related.length} → ${distinctModels.length} model${distinctModels.length === 1 ? "" : "s"}${policyCount ? `+${policyCount}p` : ""}`
  if (displayWidth(fullSummary) <= maxBudget) return fullSummary
  return `──▶ ${routed.length}/${related.length} (${distinctModels.length}m)`
}

export interface FlowsWorkspaceProps {
  agents: AgentInfo[]
  navData: FlowsNavData
  packFlowsByCategory: Map<string, PackFlowsView | null>
  focusedIndex: number
  scrollOffset: number
  listRows: number
  leftWidth: number
  rightWidth: number
  gutterWidth: number
  showInspector: boolean
  activePane: "list" | "inspector"
  focusBorderBlend: number
  inspectorFocusIndex: number
  onSelectPane: (pane: "list" | "inspector") => void
  onFocusIndex: (index: number) => void
  onScrollDelta: (delta: number) => void
  onFocusInspectorItem: (index: number) => void
  onScrollInspectorDelta: (delta: number) => void
  onOpenPackFlows: (pack: string, initialFlowIndex?: number) => void
  onOpenDelegations: (agent: AgentInfo) => void
  onJumpToCatalogAgent: (agentPath: string) => void
}

export function buildFlowsNavRows(
  agents: AgentInfo[],
  packFlowsByCategory: Map<string, PackFlowsView | null>,
): FlowsNavData {
  const agentByShortName = new Map<string, AgentInfo>()
  for (const agent of agents) {
    agentByShortName.set(agent.filename.replace(/\.md$/, ""), agent)
  }

  const inboundByAgentName = new Map<string, string[]>()
  for (const agent of agents) {
    const callerName = agent.filename.replace(/\.md$/, "")
    for (const target of agent.allowedSubagents ?? []) {
      const list = inboundByAgentName.get(target) ?? []
      if (!list.includes(callerName)) list.push(callerName)
      inboundByAgentName.set(target, list)
    }
  }

  const byPack = new Map<string, AgentInfo[]>()
  for (const agent of agents) {
    const list = byPack.get(agent.category) ?? []
    list.push(agent)
    byPack.set(agent.category, list)
  }

  const rows: FlowsNavRow[] = []
  for (const [pack, packAgents] of [...byPack.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const flowView = packFlowsByCategory.get(pack) ?? null
    const flowCount = flowView?.flows.length ?? 0
    let packDeadRefs = 0
    for (const ag of packAgents) {
      for (const sub of ag.allowedSubagents ?? []) {
        if (!agentByShortName.has(sub)) packDeadRefs++
      }
    }
    rows.push({
      kind: "pack",
      id: `pack:${pack}`,
      pack,
      label: pack,
      flowCount,
      outboundCount: packAgents.reduce((sum, ag) => sum + (ag.allowedSubagents?.length ?? 0), 0),
      inboundCount: 0,
      deadRefCount: packDeadRefs,
    })

    for (const ag of [...packAgents].sort((a, b) => a.filename.localeCompare(b.filename))) {
      const shortName = ag.filename.replace(/\.md$/, "")
      const outbound = ag.allowedSubagents ?? []
      const deadRefCount = outbound.filter(sub => !agentByShortName.has(sub)).length
      const inbound = inboundByAgentName.get(shortName) ?? []
      rows.push({
        kind: "agent",
        id: ag.currentPath,
        pack,
        label: shortName,
        agent: ag,
        flowCount,
        outboundCount: outbound.length,
        inboundCount: inbound.length,
        deadRefCount,
      })
    }
  }

  return { rows, inboundByAgentName, agentByShortName }
}

export function FlowsWorkspace({
  agents,
  navData,
  packFlowsByCategory,
  focusedIndex,
  scrollOffset,
  listRows,
  leftWidth,
  rightWidth,
  gutterWidth,
  showInspector,
  activePane,
  focusBorderBlend,
  inspectorFocusIndex,
  onSelectPane,
  onFocusIndex,
  onScrollDelta,
  onFocusInspectorItem,
  onScrollInspectorDelta,
  onOpenPackFlows,
  onOpenDelegations,
  onJumpToCatalogAgent,
}: FlowsWorkspaceProps) {
  const { rows, inboundByAgentName, agentByShortName } = navData

  const pageSize = Math.max(1, listRows)
  const clampedIndex = rows.length ? Math.max(0, Math.min(focusedIndex, rows.length - 1)) : 0
  const clampedScroll = Math.max(0, Math.min(scrollOffset, Math.max(0, rows.length - pageSize)))
  const currentRow = rows[clampedIndex] ?? null
  const visibleRows = rows.slice(clampedScroll, clampedScroll + pageSize)
  const leftInner = Math.max(16, leftWidth - 4)
  const rightInner = Math.max(20, rightWidth - 4)

  const leftBorder = lerpColor(THEME.borderSubtle, THEME.borderFocus, 1 - focusBorderBlend)
  const rightBorder = lerpColor(THEME.borderSubtle, THEME.borderInspectorFocus, focusBorderBlend)
  const isInspectorFocused = showInspector && activePane === "inspector"

  const { selectedFlowView, activeAgent, items: inspectorItems } = buildFlowsInspectorItems(
    currentRow,
    agents,
    packFlowsByCategory,
    agentByShortName,
  )

  const flowItems = inspectorItems.filter((it): it is Extract<FlowsInspectorItem, { kind: "flow" }> => it.kind === "flow")
  const subagentItems = inspectorItems.filter((it): it is Extract<FlowsInspectorItem, { kind: "subagent" }> => it.kind === "subagent")

  const clampedInspFocus = inspectorItems.length
    ? Math.max(0, Math.min(inspectorFocusIndex, inspectorItems.length - 1))
    : 0
  const focusedInspItem = isInspectorFocused ? (inspectorItems[clampedInspFocus] ?? null) : null

  // Budget available rows across the two cards inside the right sidebar
  const flowCardMaxRows = Math.max(2, Math.min(Math.max(3, Math.floor(listRows * 0.45)), Math.max(2, flowItems.length)))
  const subCardMaxRows = Math.max(2, listRows - flowCardMaxRows - 4)

  const focusedFlowLocalIdx = focusedInspItem?.kind === "flow" ? focusedInspItem.flowIndex : 0
  const flowSliceOffset = clampListScroll(
    focusedFlowLocalIdx,
    flowItems.length,
    0,
    flowCardMaxRows,
  )
  const visibleFlowItems = flowItems.slice(flowSliceOffset, flowSliceOffset + flowCardMaxRows)

  const focusedSubLocalIdx =
    focusedInspItem?.kind === "subagent"
      ? Math.max(0, subagentItems.findIndex(s => s.id === focusedInspItem.id))
      : 0
  const subSliceOffset = clampListScroll(
    focusedSubLocalIdx,
    subagentItems.length,
    0,
    subCardMaxRows,
  )
  const visibleSubItems = subagentItems.slice(subSliceOffset, subSliceOffset + subCardMaxRows)

  const leftTitle = showInspector
    ? !isInspectorFocused
      ? " ● ⇄ Packs & Call Graph "
      : " ⇄ Packs & Call Graph · ⇧← "
    : " ⇄ Packs & Call Graph "
  const rightTitle = isInspectorFocused
    ? " ● Topology & IF/OR Rules "
    : " Topology & IF/OR Rules · ⇧→ "

  return (
    <box width="100%" minHeight={0} flexGrow={1} flexDirection="row" marginTop={1} overflow="hidden">
      <box
        width={leftWidth}
        flexGrow={0}
        minHeight={0}
        border={true}
        borderStyle="rounded"
        borderColor={leftBorder}
        backgroundColor={THEME.bgPanel}
        title={leftTitle}
        titleColor={!isInspectorFocused ? THEME.accentCyan : THEME.fgSecondary}
        padding={1}
        flexDirection="column"
        justifyContent="space-between"
        overflow="hidden"
        onMouseDown={() => onSelectPane("list")}
        onMouseScroll={(_self, event) => {
          const dir = (event as any).scroll?.direction
          if (dir === "down") onScrollDelta(2)
          else if (dir === "up") onScrollDelta(-2)
        }}
      >
        <box flexDirection="column" width="100%" overflow="hidden">
          <box
            width="100%"
            height={2}
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            borderStyle="single"
            border={["bottom"]}
            borderColor={THEME.borderSubtle}
          >
            <text height={1} flexShrink={0} wrapMode="none" style={{ textColor: THEME.fgSecondary }}>Pack / Agent Node</text>
            <text height={1} flexShrink={0} wrapMode="none" style={{ textColor: THEME.fgSecondary }}>Flows / Edges</text>
          </box>

          <box flexDirection="column" width="100%" marginTop={1} overflow="hidden">
            {rows.length === 0 ? (
              <text style={{ textColor: THEME.accentAmber }}>
                No packs or agents loaded. Switch to Sources (Tab or O) to connect a repository.
              </text>
            ) : (
              visibleRows.map((row, idx) => {
                const absIndex = clampedScroll + idx
                const isFocused = absIndex === clampedIndex
                const badge = row.kind === "pack"
                  ? `${row.flowCount} IF/OR · ${row.outboundCount} edges${row.deadRefCount ? ` · ⚠${row.deadRefCount}` : ""}`
                  : `out:${row.outboundCount} · in:${row.inboundCount}${row.deadRefCount ? ` · ⚠${row.deadRefCount}` : ""}`
                const badgeW = displayWidth(badge)
                const labelBudget = Math.max(10, leftInner - badgeW - 3)
                const prefix = row.kind === "pack" ? "📦 " : isFocused ? "▎ ● " : "  ● "

                return (
                  <box
                    key={row.id}
                    width="100%"
                    height={1}
                    flexDirection="row"
                    justifyContent="space-between"
                    backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      onSelectPane("list")
                      if (isFocused) {
                        if (row.kind === "pack") onOpenPackFlows(row.pack)
                        else if (row.agent) onJumpToCatalogAgent(row.agent.currentPath)
                      } else {
                        onFocusIndex(absIndex)
                      }
                    }}
                  >
                    <text
                      wrapMode="none"
                      overflow="hidden"
                      style={{
                        textColor: isFocused
                          ? "#ffffff"
                          : row.kind === "pack"
                            ? THEME.accentAmber
                            : THEME.fgPrimary,
                      }}
                      b={row.kind === "pack" || isFocused}
                    >
                      {middleEllipsis(`${prefix}${terminalSafeText(row.label)}`, labelBudget)}
                    </text>
                    <text
                      wrapMode="none"
                      overflow="hidden"
                      style={{
                        textColor: row.deadRefCount > 0
                          ? THEME.accentRed
                          : row.kind === "pack" && row.flowCount > 0
                            ? THEME.accentGreen
                            : THEME.fgSecondary,
                      }}
                    >
                      {badge}
                    </text>
                  </box>
                )
              })
            )}
          </box>
        </box>

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
          <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
            {middleEllipsis(
              `Nodes: ${rows.length}${showInspector ? " · [⇧→] Sidebar" : ""}`,
              Math.max(12, Math.floor(leftInner * 0.56)),
            )}
          </text>
          <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentCyan }}>
            {middleEllipsis("[M] Flows · [G] Graph", Math.max(12, Math.floor(leftInner * 0.42)))}
          </text>
        </box>
      </box>

      {showInspector && (
        <>
          <text width={gutterWidth}> </text>
          <box
            width={rightWidth}
            flexGrow={0}
            minHeight={0}
            border={true}
            borderStyle="rounded"
            borderColor={rightBorder}
            backgroundColor={THEME.bgPanel}
            title={rightTitle}
            titleColor={isInspectorFocused ? THEME.accentPurple : THEME.fgSecondary}
            padding={1}
            flexDirection="column"
            justifyContent="space-between"
            overflow="hidden"
            onMouseDown={() => onSelectPane("inspector")}
            onMouseScroll={(_self, event) => {
              const dir = (event as any).scroll?.direction
              if (dir === "down") onScrollInspectorDelta(1)
              else if (dir === "up") onScrollInspectorDelta(-1)
            }}
          >
            {currentRow ? (
              <box flexDirection="column" width="100%" flexGrow={1} overflow="hidden">
                <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between" width="100%">
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentAmber }} b>
                    {middleEllipsis(`📦 Pack: ${terminalSafeText(currentRow.pack)}`, Math.max(16, rightInner - 18))}
                  </text>
                  <text
                    height={1}
                    wrapMode="none"
                    style={{ textColor: THEME.accentCyan }}
                    u
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      onOpenPackFlows(currentRow.pack)
                    }}
                  >
                    [M] Edit Flows
                  </text>
                </box>

                <box
                  width="100%"
                  flexShrink={0}
                  border={true}
                  borderStyle="rounded"
                  borderColor={focusedInspItem?.kind === "flow" ? THEME.accentCyan : THEME.borderSubtle}
                  backgroundColor={THEME.bgInput}
                  paddingLeft={1}
                  paddingRight={1}
                  marginTop={1}
                  flexDirection="column"
                  overflow="hidden"
                >
                  <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between" width="100%">
                    <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                      {selectedFlowView
                        ? middleEllipsis(
                            `◉ Callers: ${selectedFlowView.callers.length ? callersLabel(selectedFlowView) : "(none)"}`,
                            flowItems.length > flowCardMaxRows ? Math.max(14, rightInner - 10) : Math.max(14, rightInner - 2),
                          )
                        : "No configurable callers detected in this pack."}
                    </text>
                    {flowItems.length > flowCardMaxRows && (
                      <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                        {`${flowSliceOffset + 1}-${Math.min(flowItems.length, flowSliceOffset + visibleFlowItems.length)}/${flowItems.length}`}
                      </text>
                    )}
                  </box>
                  {flowItems.length === 0 ? (
                    <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
                      {middleEllipsis("No IF/OR rules configured yet. Press [M] to add routing.", rightInner - 2)}
                    </text>
                  ) : (
                    visibleFlowItems.map((item, idx) => {
                      const globalItemIdx = item.flowIndex
                      const isItemFocused = isInspectorFocused && clampedInspFocus === globalItemIdx
                      const isLast = flowSliceOffset + idx === flowItems.length - 1
                      const connector = isLast ? "╰─▶" : "├─▶"
                      const triggerPart = item.flow.triggers.map(formatFlowTriggerShort).join(" ∨ ")
                      const prefixStr = `${isItemFocused ? "▎" : " "} ${connector} IF ${terminalSafeText(triggerPart)} `
                      const targetBudget = Math.max(12, rightInner - 2 - displayWidth(prefixStr))
                      const targetPart = summarizeFlowCompactTargets(item.flow, selectedFlowView?.related ?? [], targetBudget)
                      return (
                        <box
                          key={item.id}
                          width="100%"
                          height={1}
                          flexShrink={0}
                          backgroundColor={isItemFocused ? THEME.bgRowFocus : "transparent"}
                          onMouseDown={(_self, event) => {
                            event.stopPropagation()
                            onSelectPane("inspector")
                            if (isItemFocused) onOpenPackFlows(item.pack, item.flowIndex)
                            else onFocusInspectorItem(globalItemIdx)
                          }}
                        >
                          <text
                            height={1}
                            wrapMode="none"
                            overflow="hidden"
                            style={{ textColor: isItemFocused ? "#ffffff" : THEME.accentGreen }}
                            b={isItemFocused}
                          >
                            {middleEllipsis(
                              `${prefixStr}${terminalSafeText(targetPart)}`,
                              rightInner - 2,
                            )}
                          </text>
                        </box>
                      )
                    })
                  )}
                </box>

                {activeAgent && (
                  <box
                    width="100%"
                    border={true}
                    borderStyle="rounded"
                    borderColor={focusedInspItem?.kind === "subagent" ? THEME.accentPurple : THEME.borderSubtle}
                    backgroundColor={THEME.bgInput}
                    paddingLeft={1}
                    paddingRight={1}
                    marginTop={1}
                    flexGrow={1}
                    minHeight={0}
                    flexDirection="column"
                    overflow="hidden"
                  >
                    <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between" width="100%">
                      <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentBlue }} b>
                        {middleEllipsis(`◉ @${terminalSafeText(activeAgent.filename.replace(/\.md$/, ""))}`, Math.max(14, rightInner - 18))}
                      </text>
                      <text
                        height={1}
                        wrapMode="none"
                        style={{ textColor: THEME.accentCyan }}
                        u
                        onMouseDown={(_self, event) => {
                          event.stopPropagation()
                          onOpenDelegations(activeAgent)
                        }}
                      >
                        [G] Delegations
                      </text>
                    </box>

                    {(() => {
                      const shortName = activeAgent.filename.replace(/\.md$/, "")
                      const inbound = inboundByAgentName.get(shortName) ?? []
                      return (
                        <box flexDirection="column" overflow="hidden">
                          <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                            {inbound.length
                              ? middleEllipsis(`◀── Called by: ${inbound.map(n => `@${n}`).join(", ")}`, rightInner - 2)
                              : middleEllipsis("◀── Primary / Entry-point agent", rightInner - 2)}
                          </text>
                          <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between" width="100%">
                            <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                              {`Outbound @subagents (${subagentItems.length}):`}
                            </text>
                            {subagentItems.length > subCardMaxRows && (
                              <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                                {`${subSliceOffset + 1}-${Math.min(subagentItems.length, subSliceOffset + visibleSubItems.length)}/${subagentItems.length}`}
                              </text>
                            )}
                          </box>
                          {subagentItems.length === 0 ? (
                            <text height={1} flexShrink={0} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                              {"  ╰─ (leaf agent)"}
                            </text>
                          ) : (
                            visibleSubItems.map((subItem, idx) => {
                              const absSubIdx = flowItems.length + subSliceOffset + idx
                              const isSubFocused = isInspectorFocused && clampedInspFocus === absSubIdx
                              const isLast = subSliceOffset + idx === subagentItems.length - 1
                              const connector = isLast ? "╰─▶" : "├─▶"
                              return (
                                <box
                                  key={subItem.id}
                                  width="100%"
                                  height={1}
                                  flexShrink={0}
                                  backgroundColor={isSubFocused ? THEME.bgRowFocus : "transparent"}
                                  onMouseDown={(_self, event) => {
                                    event.stopPropagation()
                                    onSelectPane("inspector")
                                    if (isSubFocused && subItem.targetAgent) {
                                      onJumpToCatalogAgent(subItem.targetAgent.currentPath)
                                    } else {
                                      onFocusInspectorItem(absSubIdx)
                                    }
                                  }}
                                >
                                  <text
                                    height={1}
                                    wrapMode="none"
                                    overflow="hidden"
                                    style={{
                                      textColor: isSubFocused
                                        ? "#ffffff"
                                        : subItem.targetAgent
                                          ? THEME.accentCyan
                                          : THEME.accentRed,
                                    }}
                                    b={isSubFocused}
                                  >
                                    {middleEllipsis(
                                      subItem.targetAgent
                                        ? `${isSubFocused ? "▎ " : "  "}${connector} @${terminalSafeText(subItem.subName)}${isSubFocused ? " [Enter: Jump]" : ""}`
                                        : `${isSubFocused ? "▎ " : "  "}${connector} ❌ @${terminalSafeText(subItem.subName)} [Dead Ref]`,
                                      rightInner - 2,
                                    )}
                                  </text>
                                </box>
                              )
                            })
                          )}
                        </box>
                      )
                    })()}
                  </box>
                )}
              </box>
            ) : (
              <box flexGrow={1} justifyContent="center" alignItems="center">
                <text style={{ textColor: THEME.fgSecondary }}>Focus a pack or agent node to inspect its topology.</text>
              </box>
            )}
          </box>
        </>
      )}
    </box>
  )
}
