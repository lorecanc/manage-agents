import React from "react"
import type { WorkspaceTab } from "../utils/commandPalette.js"
import { displayWidth, middleEllipsis } from "../utils/terminalText.js"
import { THEME } from "../utils/uiTheme.js"

export interface WorkspaceTopbarProps {
  activeTab: WorkspaceTab
  termWidth: number
  dimmed: boolean
  spinner: string
  workspaceLabel: string
  hasActiveSource: boolean
  commitLabel: string
  isReadOnlyGitSource: boolean
  autoCommitOn: boolean
  isWorkspaceVirtualPack: boolean
  onSelectTab: (tab: WorkspaceTab) => void
  onOpenSources: () => void
  onOpenOnboarding: () => void
  onOpenPalette: () => void
}

interface TopbarTabSpec {
  key: WorkspaceTab
  label: string
  accent: string
}

export function getTopbarTabs(termWidth: number): TopbarTabSpec[] {
  const wide = termWidth >= 122
  return [
    { key: "catalog", label: "Catalog", accent: THEME.accentBlue },
    { key: "target", label: wide ? "Target & Bridges" : "Target", accent: THEME.accentPurple },
    { key: "flows", label: wide ? "Flows & Graph" : "Flows", accent: THEME.accentCyan },
    { key: "sources", label: "Sources", accent: THEME.accentGreen },
  ]
}

export function WorkspaceTopbar({
  activeTab,
  termWidth,
  dimmed,
  spinner,
  workspaceLabel,
  hasActiveSource,
  commitLabel,
  isReadOnlyGitSource,
  autoCommitOn,
  isWorkspaceVirtualPack,
  onSelectTab,
  onOpenSources,
  onOpenOnboarding,
  onOpenPalette,
}: WorkspaceTopbarProps) {
  const barWidth = Math.max(24, Math.floor(termWidth) - 2)
  const stripBg = dimmed ? THEME.bgBaseDimmed : THEME.bgBase
  const raisedBg = dimmed ? THEME.bgPanelDimmed : THEME.bgPanel
  const baselineColor = THEME.borderIdle

  const brandText = termWidth >= 96 ? " ◆ manage-agents " : " ◆ "
  const brandWidth = displayWidth(brandText)
  const tabs = getTopbarTabs(termWidth)

  const tabMetrics = tabs.map((tab, idx) => {
    const active = tab.key === activeTab
    const prevActive = idx > 0 && tabs[idx - 1]!.key === activeTab
    const needsLeadingDivider = idx > 0 && !active && !prevActive
    const innerWidth = displayWidth(tab.label) + (active ? 4 : 2)
    const totalWidth = (needsLeadingDivider ? 1 : 0) + (active ? innerWidth + 2 : innerWidth)
    return { ...tab, active, needsLeadingDivider, innerWidth, totalWidth }
  })

  const tabsWidth = tabMetrics.reduce((sum, item) => sum + item.totalWidth, 0)
  const showTabKeyHint = termWidth >= 104
  const tabHintText = showTabKeyHint ? "  ⇥ Tab " : ""
  const tabHintWidth = displayWidth(tabHintText)

  const leftTotalWidth = brandWidth + tabsWidth + tabHintWidth
  const rightTotalWidth = Math.max(0, barWidth - leftTotalWidth)

  const showOnboardingPill = isWorkspaceVirtualPack && rightTotalWidth >= 42
  const onboardingLabel = isReadOnlyGitSource ? "[I] Clone & Onboard" : "[I] Onboard Pack"
  const onboardingCells = showOnboardingPill ? displayWidth(onboardingLabel) + 3 : 0

  const paletteLabel = "⌘K"
  const showPalettePill = rightTotalWidth >= 10
  const paletteCells = showPalettePill ? displayWidth(paletteLabel) + 3 : 0

  const showCommitSegment = rightTotalWidth >= 36
  const commitSegment = showCommitSegment ? ` · ${commitLabel}` : ""
  const commitCells = displayWidth(commitSegment)
  const spinnerCells = spinner ? displayWidth(spinner) + 1 : 0

  const wsBudget = Math.max(
    0,
    rightTotalWidth - spinnerCells - commitCells - onboardingCells - paletteCells - 2,
  )

  return (
    <box
      width="100%"
      height={3}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={stripBg}
      overflow="hidden"
    >
      {/* Brand column */}
      <box width={brandWidth} height={3} flexShrink={0} flexDirection="column" overflow="hidden">
        <text height={1} wrapMode="none">{" ".repeat(brandWidth)}</text>
        <text height={1} wrapMode="none" style={{ textColor: THEME.accentBlue }} b>
          {brandText}
        </text>
        <text height={1} wrapMode="none" style={{ textColor: baselineColor }}>
          {"─".repeat(brandWidth)}
        </text>
      </box>

      {/* Browser-style tab strip */}
      {tabMetrics.map((tab) => {
        if (tab.active) {
          const topArch = `╭${"─".repeat(tab.innerWidth)}╮`
          return (
            <box
              key={tab.key}
              width={tab.totalWidth}
              height={3}
              flexShrink={0}
              flexDirection="column"
              overflow="hidden"
              onMouseDown={() => onSelectTab(tab.key)}
            >
              <text height={1} wrapMode="none" style={{ textColor: tab.accent }}>
                {topArch}
              </text>
              <box width={tab.totalWidth} height={1} flexDirection="row" backgroundColor={raisedBg} overflow="hidden">
                <text height={1} wrapMode="none" style={{ textColor: tab.accent }}>│</text>
                <text height={1} wrapMode="none" style={{ textColor: tab.accent }} b>{" ● "}</text>
                <text height={1} wrapMode="none" style={{ textColor: "#ffffff" }} b>
                  {`${tab.label} `}
                </text>
                <text height={1} wrapMode="none" style={{ textColor: tab.accent }}>│</text>
              </box>
              <box width={tab.totalWidth} height={1} flexDirection="row" overflow="hidden">
                <text height={1} wrapMode="none" style={{ textColor: tab.accent }}>╯</text>
                <box width={tab.innerWidth} height={1} backgroundColor={raisedBg}>
                  <text height={1} wrapMode="none">{" ".repeat(tab.innerWidth)}</text>
                </box>
                <text height={1} wrapMode="none" style={{ textColor: tab.accent }}>╰</text>
              </box>
            </box>
          )
        }

        const inactivePadLabel = ` ${tab.label} `
        return (
          <React.Fragment key={tab.key}>
            {tab.needsLeadingDivider && (
              <box width={1} height={3} flexShrink={0} flexDirection="column" overflow="hidden">
                <text height={1} wrapMode="none"> </text>
                <text height={1} wrapMode="none" style={{ textColor: THEME.borderSubtle }}>│</text>
                <text height={1} wrapMode="none" style={{ textColor: baselineColor }}>─</text>
              </box>
            )}
            <box
              width={tab.innerWidth}
              height={3}
              flexShrink={0}
              flexDirection="column"
              overflow="hidden"
              onMouseDown={() => onSelectTab(tab.key)}
            >
              <text height={1} wrapMode="none">{" ".repeat(tab.innerWidth)}</text>
              <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
                {inactivePadLabel}
              </text>
              <text height={1} wrapMode="none" style={{ textColor: baselineColor }}>
                {"─".repeat(tab.innerWidth)}
              </text>
            </box>
          </React.Fragment>
        )
      })}

      {/* Keyboard tab-cycle hint */}
      {showTabKeyHint && (
        <box width={tabHintWidth} height={3} flexShrink={0} flexDirection="column" overflow="hidden">
          <text height={1} wrapMode="none">{" ".repeat(tabHintWidth)}</text>
          <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
            {tabHintText}
          </text>
          <text height={1} wrapMode="none" style={{ textColor: baselineColor }}>
            {"─".repeat(tabHintWidth)}
          </text>
        </box>
      )}

      {/* Right status bar + bottom baseline */}
      {rightTotalWidth > 0 && (
        <box width={rightTotalWidth} height={3} flexShrink={0} flexDirection="column" overflow="hidden">
          <text height={1} wrapMode="none">{" ".repeat(rightTotalWidth)}</text>
          <box
            width={rightTotalWidth}
            height={1}
            flexDirection="row"
            justifyContent="flex-end"
            alignItems="center"
            paddingRight={1}
            overflow="hidden"
          >
            {spinner ? (
              <text height={1} wrapMode="none" flexShrink={0} style={{ textColor: THEME.accentCyan }} b>
                {`${spinner} `}
              </text>
            ) : null}
            {wsBudget >= 10 && (
              <text
                height={1}
                wrapMode="none"
                overflow="hidden"
                flexShrink={0}
                style={{ textColor: hasActiveSource ? THEME.accentGreen : THEME.accentAmber }}
                onMouseDown={() => onOpenSources()}
              >
                {middleEllipsis(workspaceLabel, wsBudget)}
              </text>
            )}
            {showCommitSegment && (
              <text
                height={1}
                wrapMode="none"
                flexShrink={0}
                style={{
                  textColor: isReadOnlyGitSource
                    ? THEME.accentPurple
                    : autoCommitOn
                      ? THEME.accentGreen
                      : THEME.fgMuted,
                }}
              >
                {commitSegment}
              </text>
            )}
            {showOnboardingPill && (
              <box
                height={1}
                marginLeft={1}
                paddingLeft={1}
                paddingRight={1}
                flexShrink={0}
                backgroundColor={THEME.bgSuccessSoft}
                onMouseDown={() => onOpenOnboarding()}
              >
                <text height={1} wrapMode="none" style={{ textColor: THEME.accentGreen }} b>
                  {onboardingLabel}
                </text>
              </box>
            )}
            {showPalettePill && (
              <box
                height={1}
                marginLeft={1}
                paddingLeft={1}
                paddingRight={1}
                flexShrink={0}
                backgroundColor={THEME.bgPill}
                onMouseDown={() => onOpenPalette()}
              >
                <text height={1} wrapMode="none" style={{ textColor: THEME.accentCyan }} b>
                  {paletteLabel}
                </text>
              </box>
            )}
          </box>
          <text height={1} wrapMode="none" style={{ textColor: baselineColor }}>
            {"─".repeat(rightTotalWidth)}
          </text>
        </box>
      )}
    </box>
  )
}
