import React from "react"
import type {
  FixNamePlanItem,
  WorkspaceLintReport,
  WorkspaceValidationReport,
} from "../utils/workspaceMaintenance.js"
import type { AgentInfo } from "../utils/agents.js"
import { middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { THEME } from "../utils/uiTheme.js"

export type MaintenanceTab = "validate" | "lint" | "audit"

export interface MaintenanceAuditSummary {
  highRisk: { agent: AgentInfo; reason: string }[]
  mediumRisk: { agent: AgentInfo; reason: string }[]
  orderErrors: { agent: AgentInfo; categories: string[] }[]
  lowRisk: AgentInfo[]
}

export interface MaintenanceModalProps {
  termWidth: number
  termHeight: number
  activeTab: MaintenanceTab
  validation: WorkspaceValidationReport | null
  lint: WorkspaceLintReport | null
  fixPlan: readonly FixNamePlanItem[]
  audit: MaintenanceAuditSummary | null
  isReadOnlyGitSource: boolean
  scrollOffset: number
  onSelectTab: (tab: MaintenanceTab) => void
  onScrollDelta: (delta: number) => void
  onApplyFixNames: () => void
  onRefresh: () => void
  onClose: () => void
}

export function MaintenanceModal({
  termWidth,
  termHeight,
  activeTab,
  validation,
  lint,
  fixPlan,
  audit,
  isReadOnlyGitSource,
  scrollOffset,
  onSelectTab,
  onScrollDelta,
  onApplyFixNames,
  onRefresh,
  onClose,
}: MaintenanceModalProps) {
  const modalWidth = Math.max(50, Math.min(96, termWidth - 6))
  const modalHeight = Math.max(18, Math.min(32, termHeight - 4))
  const left = Math.max(0, Math.floor((termWidth - modalWidth) / 2))
  const top = Math.max(0, Math.floor((termHeight - modalHeight) / 2))
  const innerWidth = Math.max(36, modalWidth - 6)
  const viewportRows = Math.max(5, modalHeight - 13)

  let summaryText = ""
  let summaryColor: string = THEME.accentGreen
  let summarySub = ""
  const lines: Array<{ text: string; color: string; bold?: boolean }> = []

  if (activeTab === "validate") {
    if (!validation || validation.packs.length === 0) {
      summaryText = "No manifest packs found in this workspace."
      summaryColor = THEME.fgMuted
    } else {
      summaryText = `${validation.packs.length} pack(s) · ${validation.totalErrors} error(s) · ${validation.totalWarnings} warning(s)`
      summaryColor = validation.totalErrors > 0 ? THEME.accentRed : validation.totalWarnings > 0 ? THEME.accentAmber : THEME.accentGreen
      summarySub = validation.totalErrors === 0 ? "✓ All packs satisfy the OpenCode pack contract" : "Fix errors below or run Pack Doctor [D]"
      for (const entry of validation.packs) {
        const badge = entry.errors > 0 ? "✗" : entry.warnings > 0 ? "⚠" : "✓"
        const color = entry.errors > 0 ? THEME.accentRed : entry.warnings > 0 ? THEME.accentAmber : THEME.accentGreen
        lines.push({
          text: `${badge} ${terminalSafeText(entry.packName)}  (${entry.errors} err, ${entry.warnings} warn)`,
          color,
          bold: true,
        })
        for (const issue of entry.validation.issues) {
          const loc = issue.path ? `${terminalSafeText(issue.path)}: ` : ""
          lines.push({
            text: `    ${issue.level === "error" ? "✗" : "⚠"} ${middleEllipsis(loc + terminalSafeText(issue.message), innerWidth - 6)}`,
            color: issue.level === "error" ? THEME.accentRed : THEME.accentAmber,
          })
        }
      }
    }
  } else if (activeTab === "lint") {
    if (!lint || lint.total === 0) {
      summaryText = "No agents in workspace to lint."
      summaryColor = THEME.fgMuted
    } else {
      summaryText = `Compliant: ${lint.compliant}/${lint.total} · Non-compliant: ${lint.nonCompliant.length}`
      summaryColor = lint.nonCompliant.length === 0 ? THEME.accentGreen : THEME.accentAmber
      summarySub = lint.nonCompliant.length === 0
        ? "✓ Every agent filename matches the naming convention"
        : isReadOnlyGitSource
          ? "Read-only Git source: clone locally to apply renames"
          : fixPlan.length > 0
            ? `Press [Enter] to rename ${fixPlan.length} agent(s) and update cross-references`
            : "Manual fixes required"
      for (const { agent, analysis } of lint.nonCompliant) {
        lines.push({
          text: `• ${terminalSafeText(agent.filename)}  →  ${terminalSafeText(analysis.suggestedName ?? "(manual fix)")}`,
          color: THEME.accentAmber,
          bold: true,
        })
        for (const err of analysis.errors) {
          lines.push({
            text: `    ${middleEllipsis(terminalSafeText(err), innerWidth - 4)}`,
            color: THEME.fgSecondary,
          })
        }
      }
    }
  } else {
    if (!audit) {
      summaryText = "No agents in workspace to audit."
      summaryColor = THEME.fgMuted
    } else {
      summaryText = `Order Errors: ${audit.orderErrors.length} · High: ${audit.highRisk.length} · Medium: ${audit.mediumRisk.length} · Low: ${audit.lowRisk.length}`
      summaryColor = audit.orderErrors.length > 0 || audit.highRisk.length > 0 ? THEME.accentRed : audit.mediumRisk.length > 0 ? THEME.accentAmber : THEME.accentGreen
      summarySub = audit.orderErrors.length > 0
        ? "Wildcard \"*\": \"deny\" must come FIRST in OpenCode permissions"
        : "Review high/medium bash & edit permissions below"
      if (audit.orderErrors.length > 0) {
        lines.push({ text: "PERMISSION ORDER ERRORS", color: THEME.accentRed, bold: true })
        for (const item of audit.orderErrors) {
          lines.push({ text: `  ✗ ${terminalSafeText(item.agent.filename)}  [${item.categories.join(", ")}]`, color: THEME.accentRed })
        }
      }
      if (audit.highRisk.length > 0) {
        lines.push({ text: `HIGH RISK (${audit.highRisk.length})`, color: THEME.accentRed, bold: true })
        for (const item of audit.highRisk) {
          lines.push({ text: `  ● ${terminalSafeText(item.agent.filename)} — ${middleEllipsis(terminalSafeText(item.reason), innerWidth - 28)}`, color: THEME.accentRed })
        }
      }
      if (audit.mediumRisk.length > 0) {
        lines.push({ text: `MEDIUM RISK (${audit.mediumRisk.length})`, color: THEME.accentAmber, bold: true })
        for (const item of audit.mediumRisk) {
          lines.push({ text: `  ● ${terminalSafeText(item.agent.filename)} — ${middleEllipsis(terminalSafeText(item.reason), innerWidth - 28)}`, color: THEME.accentAmber })
        }
      }
      if (lines.length === 0) {
        lines.push({ text: "✓ All agents pass security audit with low risk.", color: THEME.accentGreen })
      }
    }
  }

  const clampedScroll = Math.min(Math.max(0, lines.length - viewportRows), Math.max(0, scrollOffset))
  const visible = lines.slice(clampedScroll, clampedScroll + viewportRows)
  const tabs: Array<{ key: MaintenanceTab; label: string; color: string }> = [
    { key: "validate", label: "1 Validate Packs", color: THEME.accentCyan },
    { key: "lint", label: "2 Lint & Fix-Names", color: THEME.accentAmber },
    { key: "audit", label: "3 Security Audit", color: THEME.accentRed },
  ]

  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={modalWidth}
      height={modalHeight}
      border={true}
      borderStyle="rounded"
      borderColor={THEME.accentAmber}
      backgroundColor={THEME.bgElevated}
      title=" Workspace Maintenance "
      titleColor={THEME.accentAmber}
      flexDirection="column"
      padding={1}
      zIndex={40}
      onMouseScroll={(_self, event) => {
        const dir = (event as any).scroll?.direction
        if (dir === "up") onScrollDelta(-3)
        else if (dir === "down") onScrollDelta(3)
      }}
    >
      {/* Sub-tab bar */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        height={2}
        borderStyle="single"
        border={["bottom"]}
        borderColor={THEME.borderSubtle}
        alignItems="center"
        flexShrink={0}
      >
        <box flexDirection="row" gap={1} height={1}>
          {tabs.map(t => {
            const active = t.key === activeTab
            return (
              <text
                key={t.key}
                height={1}
                wrapMode="none"
                backgroundColor={active ? THEME.bgPillActive : THEME.bgPill}
                style={{ textColor: active ? t.color : THEME.fgSecondary }}
                b={active}
                onMouseDown={(_self, event) => {
                  event.stopPropagation()
                  onSelectTab(t.key)
                }}
              >
                {` ${t.label} `}
              </text>
            )
          })}
        </box>
        <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }} onMouseDown={onClose}>
          {"[Esc] Close"}
        </text>
      </box>

      {/* KPI Summary Card */}
      <box
        border={true}
        borderStyle="rounded"
        borderColor={summaryColor}
        backgroundColor={THEME.bgInput}
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
        flexDirection="column"
        flexShrink={0}
      >
        <text height={1} wrapMode="none" style={{ textColor: summaryColor }} b>
          {middleEllipsis(summaryText, innerWidth)}
        </text>
        {summarySub && (
          <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
            {middleEllipsis(summarySub, innerWidth)}
          </text>
        )}
      </box>

      {/* Scrollable Findings Card */}
      <box
        border={true}
        borderStyle="rounded"
        borderColor={THEME.borderSubtle}
        backgroundColor={THEME.bgInput}
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
      >
        {visible.length === 0 ? (
          <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
            {"  Nothing to report."}
          </text>
        ) : (
          visible.map((line, idx) => (
            <text key={idx} height={1} wrapMode="none" overflow="hidden" style={{ textColor: line.color }} b={line.bold}>
              {line.text}
            </text>
          ))
        )}
      </box>

      {/* Footer */}
      <box
        borderStyle="single"
        border={["top"]}
        borderColor={THEME.borderSubtle}
        paddingTop={1}
        marginTop={1}
        flexDirection="row"
        justifyContent="space-between"
        flexShrink={0}
      >
        <box flexDirection="row" gap={1} height={1}>
          {activeTab === "lint" && fixPlan.length > 0 && !isReadOnlyGitSource && (
            <text height={1} wrapMode="none" backgroundColor={THEME.bgPillActive} style={{ textColor: THEME.accentGreen }} b onMouseDown={onApplyFixNames}>
              {` [Enter] Apply ${fixPlan.length} Rename(s) `}
            </text>
          )}
          <text height={1} wrapMode="none" backgroundColor={THEME.bgPill} style={{ textColor: THEME.fgSecondary }} onMouseDown={onRefresh}>
            {" [R] Re-run "}
          </text>
        </box>
        <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
          {lines.length > viewportRows ? `${clampedScroll + 1}-${Math.min(lines.length, clampedScroll + viewportRows)}/${lines.length} · ` : ""}
          {"1/2/3 Tabs · ↑/↓ Scroll"}
        </text>
      </box>
    </box>
  )
}
