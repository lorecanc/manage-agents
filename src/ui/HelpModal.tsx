import React from "react"
import {
  calculateHelpViewport,
  HELP_TABS,
  type HelpShortcutItem,
  type HelpTabContent,
  type HelpTabId,
  type HelpTabMeta,
} from "../utils/helpGuide.js"
import { displayWidth, middleEllipsis } from "../utils/terminalText.js"
import { THEME } from "../utils/uiTheme.js"

export interface HelpModalProps {
  activeTab: HelpTabId
  content: HelpTabContent
  focusedItemIndex: number
  scrollOffset: number
  termWidth: number
  termHeight: number
  reducedMotion: boolean
  onSelectTab: (tab: HelpTabId) => void
  onFocusItem: (itemIndex: number) => void
  onActivateItem: (item: HelpShortcutItem) => void
  onScrollDelta: (delta: number) => void
  onToggleReducedMotion: () => void
  onClose: () => void
}

const TAB_ACCENT_COLOR: Record<HelpTabMeta["accent"], string> = {
  blue: THEME.accentBlue,
  amber: THEME.accentAmber,
  green: THEME.accentGreen,
  purple: THEME.accentPurple,
}

const KEY_COLUMN_CELLS = 13

export function HelpModal({
  activeTab,
  content,
  focusedItemIndex,
  scrollOffset,
  termWidth,
  termHeight,
  reducedMotion,
  onSelectTab,
  onFocusItem,
  onActivateItem,
  onScrollDelta,
  onToggleReducedMotion,
  onClose,
}: HelpModalProps) {
  const vp = calculateHelpViewport(termWidth, termHeight)
  const { modalWidth, modalHeight, left, top, innerWidth, viewportRows, compactChrome } = vp

  const totalRows = content.rows.length
  const safeOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, totalRows - viewportRows)))
  const rawVisibleRows = content.rows.slice(safeOffset, safeOffset + viewportRows)
  const lastRow = rawVisibleRows[rawVisibleRows.length - 1]
  // Never leave a section heading orphaned at the bottom edge with zero items beneath it.
  const visibleRows =
    lastRow?.kind === "group" && safeOffset + rawVisibleRows.length < totalRows
      ? [...rawVisibleRows.slice(0, -1), { kind: "spacer" as const, id: `${lastRow.id}:tail-pad` }]
      : rawVisibleRows
  const tabAccent = TAB_ACCENT_COLOR[content.tab.accent]
  const useShortTabs = innerWidth < 66
  const showRightScope = innerWidth >= 42
  const showTabSwitchHint = innerWidth >= 72
  const showMotionToggle = innerWidth >= 58

  const hasOverflow = totalRows > viewportRows
  const canScrollUp = safeOffset > 0
  const canScrollDown = safeOffset + rawVisibleRows.length < totalRows
  const scrollArrows = canScrollUp && canScrollDown ? "↕" : canScrollDown ? "↓" : "↑"
  const scrollBadge = hasOverflow
    ? `${scrollArrows} ${Math.min(content.items.length, focusedItemIndex + 1)}/${content.items.length}`
    : ""
  const subtitleBudget = Math.max(12, innerWidth - (scrollBadge ? displayWidth(scrollBadge) + 2 : 0))

  const motionLabel = showMotionToggle ? `[Ctrl+E] ${reducedMotion ? "Reduced" : "Smooth"}  ` : ""
  const closeLabel = "[Esc / ?] Close"
  const footerRightCells = displayWidth(motionLabel) + displayWidth(closeLabel)
  const footerLeftBudget = Math.max(12, innerWidth - footerRightCells - 2)
  const footerHint =
    footerLeftBudget >= 42
      ? "↑/↓ Select · Enter Run · Tab / 1–4 Section"
      : footerLeftBudget >= 30
        ? "↑/↓ Nav · Enter Run · 1–4 Tabs"
        : middleEllipsis("↑/↓ · Enter · 1–4", footerLeftBudget)

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      zIndex={50}
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
        borderColor={tabAccent}
        backgroundColor={THEME.bgElevated}
        title=" ? Keyboard & Mouse Guide "
        titleColor={tabAccent}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
        justifyContent="space-between"
        overflow="hidden"
        onMouseDown={(_self, event) => {
          event.stopPropagation()
        }}
        onMouseScroll={(_self, event) => {
          event.stopPropagation()
          const dir = (event as any).scroll?.direction
          if (dir === "down") onScrollDelta(2)
          else if (dir === "up") onScrollDelta(-2)
        }}
      >
        <box flexDirection="column" width="100%" overflow="hidden">
          {/* Contextual Tab Bar */}
          <box
            width="100%"
            height={1}
            marginTop={compactChrome ? 0 : 1}
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            overflow="hidden"
          >
            <box flexDirection="row" alignItems="center" overflow="hidden" flexShrink={0}>
              {HELP_TABS.map((tab, idx) => {
                const isActive = tab.id === activeTab
                const label = useShortTabs ? tab.shortLabel : tab.label
                return (
                  <React.Fragment key={tab.id}>
                    {idx > 0 && (
                      <text height={1} wrapMode="none" flexShrink={0}>
                        {" "}
                      </text>
                    )}
                    <box
                      height={1}
                      paddingLeft={1}
                      paddingRight={1}
                      flexShrink={0}
                      backgroundColor={isActive ? THEME.bgPillActive : THEME.bgPill}
                      onMouseDown={(_self, event) => {
                        event.stopPropagation()
                        onSelectTab(tab.id)
                      }}
                    >
                      <text
                        height={1}
                        wrapMode="none"
                        style={{ textColor: isActive ? "#ffffff" : THEME.fgSecondary }}
                        b={isActive}
                      >
                        {label}
                      </text>
                    </box>
                  </React.Fragment>
                )
              })}
            </box>

            {showTabSwitchHint && (
              <text height={1} wrapMode="none" flexShrink={0} style={{ textColor: THEME.fgMuted }}>
                Tab / 1–4 ⇄
              </text>
            )}
          </box>

          {/* Active Tab Subtitle + Scroll Position */}
          <box
            width="100%"
            height={2}
            borderStyle="single"
            border={["bottom"]}
            borderColor={THEME.borderSubtle}
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            overflow="hidden"
          >
            <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
              {middleEllipsis(content.tab.subtitle, subtitleBudget)}
            </text>
            {scrollBadge ? (
              <text height={1} wrapMode="none" flexShrink={0} style={{ textColor: THEME.accentCyan }} b>
                {scrollBadge}
              </text>
            ) : null}
          </box>

          {/* Shortcut Rows */}
          <box
            width="100%"
            flexDirection="column"
            marginTop={compactChrome ? 0 : 1}
            overflow="hidden"
          >
            {visibleRows.map(row => {
              if (row.kind === "spacer") {
                return <box key={row.id} width="100%" height={1} />
              }

              if (row.kind === "group") {
                const prefix = `▎ ${row.title.toUpperCase()} `
                const ruleCells = Math.max(0, innerWidth - displayWidth(prefix))
                return (
                  <box key={row.id} width="100%" height={1} flexDirection="row" overflow="hidden">
                    <text height={1} wrapMode="none" flexShrink={0} style={{ textColor: tabAccent }} b>
                      {prefix}
                    </text>
                    {ruleCells > 0 && (
                      <text height={1} wrapMode="none" style={{ textColor: THEME.borderSubtle }}>
                        {"─".repeat(ruleCells)}
                      </text>
                    )}
                  </box>
                )
              }

              const { item, itemIndex } = row
              const isFocused = itemIndex === focusedItemIndex
              const isActionable = Boolean(item.actionId) && !item.disabled
              const pillWidth = displayWidth(item.keyLabel) + 2
              const padAfterPill = Math.max(1, KEY_COLUMN_CELLS - 2 - pillWidth)

              const rightText = !showRightScope
                ? ""
                : item.actionId
                  ? item.disabled
                    ? "n/a"
                    : isFocused
                      ? "↵ Run"
                      : item.scope
                  : item.scope
              const rightColor = item.actionId
                ? item.disabled
                  ? THEME.fgMuted
                  : isFocused
                    ? THEME.accentGreen
                    : THEME.fgMuted
                : isFocused
                  ? THEME.fgSecondary
                  : THEME.fgMuted

              const rightCells = rightText ? displayWidth(rightText) + 2 : 0
              const usedLeftCells = 2 + pillWidth + padAfterPill
              const titleBudget = Math.max(8, innerWidth - usedLeftCells - rightCells)

              return (
                <box
                  key={row.id}
                  width="100%"
                  height={1}
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                  backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                  overflow="hidden"
                  onMouseOver={() => onFocusItem(itemIndex)}
                  onMouseDown={(_self, event) => {
                    event.stopPropagation()
                    onFocusItem(itemIndex)
                    onActivateItem(item)
                  }}
                >
                  <box flexDirection="row" alignItems="center" overflow="hidden">
                    <text
                      height={1}
                      wrapMode="none"
                      flexShrink={0}
                      style={{ textColor: isFocused ? tabAccent : THEME.fgMuted }}
                      b
                    >
                      {isFocused ? "▎ " : "  "}
                    </text>
                    <box
                      height={1}
                      paddingLeft={1}
                      paddingRight={1}
                      flexShrink={0}
                      backgroundColor={isFocused ? THEME.bgPillActive : THEME.bgPill}
                    >
                      <text
                        height={1}
                        wrapMode="none"
                        style={{
                          textColor: item.disabled
                            ? THEME.fgMuted
                            : isFocused
                              ? "#ffffff"
                              : THEME.accentAmber,
                        }}
                        b
                      >
                        {item.keyLabel}
                      </text>
                    </box>
                    <text height={1} wrapMode="none" flexShrink={0}>
                      {" ".repeat(padAfterPill)}
                    </text>
                    <text
                      height={1}
                      wrapMode="none"
                      overflow="hidden"
                      style={{
                        textColor: item.disabled
                          ? THEME.fgMuted
                          : isFocused
                            ? "#ffffff"
                            : THEME.fgPrimary,
                      }}
                      b={isFocused}
                    >
                      {middleEllipsis(item.title, titleBudget)}
                    </text>
                  </box>

                  {rightText ? (
                    <text
                      height={1}
                      wrapMode="none"
                      flexShrink={0}
                      style={{ textColor: rightColor }}
                      b={isFocused && isActionable}
                    >
                      {`  ${rightText}`}
                    </text>
                  ) : null}
                </box>
              )
            })}
          </box>
        </box>

        {/* Footer */}
        <box
          width="100%"
          height={2}
          borderStyle="single"
          border={["top"]}
          borderColor={THEME.borderSubtle}
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          overflow="hidden"
        >
          <text
            height={1}
            wrapMode="none"
            overflow="hidden"
            style={{ textColor: THEME.fgSecondary }}
          >
            {footerHint}
          </text>

          <box flexDirection="row" alignItems="center" flexShrink={0}>
            {showMotionToggle && (
              <text
                height={1}
                wrapMode="none"
                style={{ textColor: reducedMotion ? THEME.accentAmber : THEME.accentGreen }}
                onMouseDown={(_self, event) => {
                  event.stopPropagation()
                  onToggleReducedMotion()
                }}
              >
                {motionLabel}
              </text>
            )}
            <text
              height={1}
              wrapMode="none"
              style={{ textColor: THEME.accentCyan }}
              b
              onMouseDown={(_self, event) => {
                event.stopPropagation()
                onClose()
              }}
            >
              {closeLabel}
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}
