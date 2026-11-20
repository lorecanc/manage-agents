import React from "react"
import type { GhAuthStatus } from "../utils/github.js"
import type { TargetStatus } from "../utils/installer.js"
import { parsePackRequest } from "../utils/resolver.js"
import type { SourceWorkspaceRow } from "../utils/sourceRows.js"
import { displayWidth, middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { lerpColor, THEME } from "../utils/uiTheme.js"

export type { SourceWorkspaceRow }

export function calculateTargetInstalledPackRows(
  termHeight: number,
  options: { hasEngineLine?: boolean; driftCount?: number } = {},
): number {
  const safeH = Math.max(12, Math.floor(termHeight))
  // Workspace height = safeH - 9; right panel inner height = safeH - 13.
  // Fixed rows inside right panel: status(1) + margin+Dir(2) + engine(0|1) + card margin+borders+heading(4) + footer(2) = 9..10
  const driftShown = Math.min(4, Math.max(0, options.driftCount ?? 0))
  const driftBlockRows = driftShown > 0 ? driftShown + 4 : 0
  const engineRows = options.hasEngineLine ? 1 : 0
  return Math.max(2, safeH - 22 - engineRows - driftBlockRows)
}

export interface SourcesTargetWorkspaceProps {
  rows: SourceWorkspaceRow[]
  focusedIndex: number
  scrollOffset: number
  listRows: number
  termHeight: number
  query: string
  inputFocused: boolean
  ghAuth: GhAuthStatus | null
  busySpinner: string
  sourcesStatus: string | null
  targetStatusInfo: TargetStatus | null
  leftWidth: number
  rightWidth: number
  gutterWidth: number
  showInspector: boolean
  activePane: "list" | "inspector"
  focusBorderBlend: number
  inspectorScrollOffset: number
  onSelectPane: (pane: "list" | "inspector") => void
  onFocusIndex: (index: number) => void
  onActivateRow: (index: number) => void
  onScrollDelta: (delta: number) => void
  onScrollInspectorDelta: (delta: number) => void
  onToggleInputFocus: (focused: boolean) => void
  onPullSelected: () => void
  onGhLogin: () => void
  onReconcileTarget: () => void
  onRefreshTarget: () => void
  engineVersionLabel?: string
  onOpenSelfUpdate?: () => void
  inputMode?: "filter" | "spec"
  inputValidation?: { ok: boolean; message: string } | null
}

export function SourcesTargetWorkspace({
  rows,
  focusedIndex,
  scrollOffset,
  listRows,
  termHeight,
  query,
  inputFocused,
  ghAuth,
  busySpinner,
  sourcesStatus,
  targetStatusInfo,
  leftWidth,
  rightWidth,
  gutterWidth,
  showInspector,
  activePane,
  focusBorderBlend,
  inspectorScrollOffset,
  onSelectPane,
  onFocusIndex,
  onActivateRow,
  onScrollDelta,
  onScrollInspectorDelta,
  onToggleInputFocus,
  onPullSelected,
  onGhLogin,
  onReconcileTarget,
  onRefreshTarget,
  engineVersionLabel,
  onOpenSelfUpdate,
  inputMode,
  inputValidation,
}: SourcesTargetWorkspaceProps) {
  const leftInner = Math.max(18, leftWidth - 4)
  const rightInner = Math.max(20, rightWidth - 4)
  const visibleRows = rows.slice(scrollOffset, scrollOffset + Math.max(1, listRows))

  const isInspectorFocused = showInspector && activePane === "inspector"
  const leftBorder = lerpColor(THEME.borderSubtle, THEME.borderFocus, 1 - focusBorderBlend)
  const rightBaseBorder = (targetStatusInfo?.drift?.length ?? 0) > 0 ? THEME.borderWarn : THEME.borderSubtle
  const rightBorder = lerpColor(rightBaseBorder, THEME.borderInspectorFocus, focusBorderBlend)

  const installedEntries = Object.entries(targetStatusInfo?.lock?.packs ?? {})
  const rootNames = new Set(
    (targetStatusInfo?.desired.roots ?? []).map(req => {
      try {
        return parsePackRequest(req).name
      } catch {
        return req
      }
    }),
  )
  const driftLines = targetStatusInfo?.drift ?? []

  // Scrollable installed packs inside the right sidebar budgeted from actual sidebar height
  const maxPackRows = calculateTargetInstalledPackRows(termHeight, {
    hasEngineLine: Boolean(engineVersionLabel),
    driftCount: driftLines.length,
  })
  const safePackOffset = Math.max(0, Math.min(inspectorScrollOffset, Math.max(0, installedEntries.length - maxPackRows)))
  const visibleInstalled = installedEntries.slice(safePackOffset, safePackOffset + maxPackRows)

  const leftTitle = showInspector
    ? !isInspectorFocused
      ? " ● ☁ Sources & GitHub Discovery "
      : " ☁ Sources & GitHub Discovery · ⇧← "
    : " ☁ Sources & GitHub Discovery "
  const rightTitle = isInspectorFocused
    ? " ● 🎯 OpenCode Target Status "
    : " 🎯 OpenCode Target Status · ⇧→ "

  const safeQuery = terminalSafeText(query)
  const inputLine = query
    ? `${inputMode === "spec" ? "Connect" : "Filter"}  ${safeQuery}${inputFocused ? "▋" : ""}`
    : inputFocused ? "Local path, Git URL or owner/repo▋" : "[/] Filter sources or connect a repository"

  const focusedRow = rows[focusedIndex]
  const sidebarHint = showInspector ? " · [⇧→] Sidebar" : ""

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
        titleColor={!isInspectorFocused ? THEME.accentBlue : THEME.fgSecondary}
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
          <box flexDirection="row" justifyContent="space-between" width="100%">
            <text
              wrapMode="none"
              overflow="hidden"
              style={{
                textColor: ghAuth?.authenticated
                  ? THEME.accentGreen
                  : ghAuth === null
                    ? THEME.accentCyan
                    : THEME.accentAmber,
              }}
            >
              {middleEllipsis(
                ghAuth === null
                  ? `${busySpinner || "◌"} Checking GitHub CLI...`
                  : ghAuth.authenticated
                    ? `✓ GitHub @${terminalSafeText(ghAuth.login || "authenticated")} (${terminalSafeText(ghAuth.host)})`
                    : `⚠ ${terminalSafeText(ghAuth.message)}`,
                Math.max(16, leftInner - 14),
              )}
            </text>
            <text
              wrapMode="none"
              style={{ textColor: THEME.accentCyan }}
              u
              onMouseDown={(_self, event) => {
                event.stopPropagation()
                onGhLogin()
              }}
            >
              [G] Auth
            </text>
          </box>

          <box
            width="100%"
            height={3}
            marginTop={1}
            border={true}
            borderStyle="rounded"
            borderColor={inputFocused ? THEME.accentAmber : THEME.borderSubtle}
            backgroundColor={THEME.bgInput}
            paddingLeft={1}
            paddingRight={1}
            flexDirection="row"
            alignItems="center"
            onMouseDown={(_self, event) => {
              event.stopPropagation()
              onSelectPane("list")
              onToggleInputFocus(true)
            }}
          >
            <text wrapMode="none" overflow="hidden" style={{ textColor: query ? THEME.fgPrimary : THEME.fgSecondary }}>
              {middleEllipsis(inputLine, leftInner - 2)}
            </text>
          </box>

          {inputValidation && query.trim() && (
            <text
              wrapMode="none"
              overflow="hidden"
              style={{ textColor: inputValidation.ok ? THEME.accentGreen : THEME.accentAmber }}
            >
              {middleEllipsis(`${inputValidation.ok ? "✓" : "⚠"} ${terminalSafeText(inputValidation.message)}`, leftInner)}
            </text>
          )}

          {sourcesStatus && (
            <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.accentAmber }} marginTop={1}>
              {middleEllipsis(terminalSafeText(sourcesStatus), leftInner)}
            </text>
          )}

          <box flexDirection="column" width="100%" marginTop={1} overflow="hidden">
            {visibleRows.length === 0 ? (
              <text style={{ textColor: THEME.fgSecondary }}>
                Press / and enter a local path, Git URL or owner/repo. Enter opens the catalog.
              </text>
            ) : (
              visibleRows.map((row, idx) => {
                const absIndex = scrollOffset + idx
                const isFocused = absIndex === focusedIndex
                const rowBg = isFocused ? THEME.bgRowFocus : "transparent"

                if (row.kind === "connect-input") {
                  return (
                    <box
                      key={row.id}
                      width="100%"
                      height={1}
                      backgroundColor={rowBg}
                      onMouseDown={(_self, event) => {
                        event.stopPropagation()
                        onSelectPane("list")
                        onFocusIndex(absIndex)
                        onActivateRow(absIndex)
                      }}
                    >
                      <text wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#ffffff" : THEME.accentGreen }} b>
                        {middleEllipsis(`➕ Connect & activate "${terminalSafeText(row.spec)}"`, leftInner)}
                      </text>
                    </box>
                  )
                }

                if (row.kind === "registered") {
                  const loc = row.source.kind === "local" ? row.source.path : `${row.source.url}${row.source.ref ? `#${row.source.ref}` : ""}`
                  const rightBadge = `${row.source.kind}${row.revision ? `@${row.revision.slice(0, 7)}` : ""}${row.source.trusted ? " · trusted" : ""}`
                  const badgeW = displayWidth(rightBadge)
                  const leftBudget = Math.max(12, leftInner - badgeW - 2)
                  return (
                    <box
                      key={row.id}
                      width="100%"
                      height={1}
                      flexDirection="row"
                      justifyContent="space-between"
                      backgroundColor={rowBg}
                      onMouseDown={(_self, event) => {
                        event.stopPropagation()
                        onSelectPane("list")
                        if (isFocused) onActivateRow(absIndex)
                        else onFocusIndex(absIndex)
                      }}
                    >
                      <text
                        wrapMode="none"
                        overflow="hidden"
                        style={{ textColor: isFocused ? "#ffffff" : row.isActive ? THEME.accentGreen : THEME.accentBlue }}
                        b={row.isActive || isFocused}
                      >
                        {middleEllipsis(`${row.isActive ? "● " : "○ "}${terminalSafeText(row.source.name)}  ${terminalSafeText(loc)}`, leftBudget)}
                      </text>
                      <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                        {rightBadge}
                      </text>
                    </box>
                  )
                }

                const vis = row.repo.isPrivate ? "🔒 private" : "🌐 public"
                const visW = displayWidth(vis)
                const repoBudget = Math.max(12, leftInner - visW - 2)
                return (
                  <box
                    key={row.id}
                    width="100%"
                    height={1}
                    flexDirection="row"
                    justifyContent="space-between"
                    backgroundColor={rowBg}
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      onSelectPane("list")
                      if (isFocused) onActivateRow(absIndex)
                      else onFocusIndex(absIndex)
                    }}
                  >
                    <text wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#ffffff" : THEME.fgPrimary }}>
                      {middleEllipsis(`  🐙 ${terminalSafeText(row.repo.nameWithOwner)}${row.repo.description ? ` · ${terminalSafeText(row.repo.description)}` : ""}`, repoBudget)}
                    </text>
                    <text wrapMode="none" style={{ textColor: row.repo.isPrivate ? THEME.accentAmber : THEME.fgMuted }}>
                      {vis}
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
              `${!focusedRow ? "[/] Connect source" : focusedRow.kind === "connect-input"
                ? "[Enter] Connect · [↑↓] Suggestions · [/] Filter"
                : focusedRow?.kind === "gh-repo"
                  ? "[Enter] Attach · [G] GitHub Auth · [/] Filter"
                  : "[Enter] Open catalog · [T] Trust · [X] Remove"}${sidebarHint}`,
              Math.max(16, leftInner - 12),
            )}
          </text>
          <text
            wrapMode="none"
            style={{ textColor: THEME.accentCyan }}
            u
            onMouseDown={(_self, event) => {
              event.stopPropagation()
              onPullSelected()
            }}
          >
            [P] Pull
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
            titleColor={isInspectorFocused ? THEME.accentPurple : THEME.accentGreen}
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
            <box flexDirection="column" width="100%" overflow="hidden">
              <box flexDirection="row" justifyContent="space-between" width="100%">
                <text
                  wrapMode="none"
                  overflow="hidden"
                  style={{ textColor: driftLines.length === 0 ? THEME.accentGreen : THEME.accentAmber }}
                  b
                >
                  {driftLines.length === 0 ? "● Target In Sync" : `⚠ ${driftLines.length} Drift Notice${driftLines.length === 1 ? "" : "s"}`}
                </text>
                <text wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
                  {`${installedEntries.length} pack${installedEntries.length === 1 ? "" : "s"}`}
                </text>
              </box>

              <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }} marginTop={1}>
                {middleEllipsis(`Dir: ${terminalSafeText(targetStatusInfo?.target ?? "(unavailable)")}`, rightInner)}
              </text>
              {engineVersionLabel && (
                <box flexDirection="row" justifyContent="space-between" width="100%" marginTop={0}>
                  <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                    {middleEllipsis(`Engine: ${terminalSafeText(engineVersionLabel)}`, Math.max(16, rightInner - 18))}
                  </text>
                  {onOpenSelfUpdate && (
                    <text
                      wrapMode="none"
                      style={{ textColor: THEME.accentAmber }}
                      u
                      onMouseDown={(_self, event) => {
                        event.stopPropagation()
                        onOpenSelfUpdate()
                      }}
                    >
                      [Shift+U] Update
                    </text>
                  )}
                </box>
              )}

              <box
                width="100%"
                border={true}
                borderStyle="rounded"
                borderColor={isInspectorFocused ? THEME.accentPurple : THEME.borderSubtle}
                backgroundColor={THEME.bgInput}
                padding={1}
                marginTop={1}
                flexDirection="column"
                overflow="hidden"
              >
                <box flexDirection="row" justifyContent="space-between" width="100%">
                  <text style={{ textColor: THEME.fgSecondary }} b>
                    Installed Packs:
                  </text>
                  {installedEntries.length > maxPackRows && (
                    <text style={{ textColor: THEME.fgMuted }}>
                      {`${safePackOffset + 1}-${Math.min(installedEntries.length, safePackOffset + visibleInstalled.length)}/${installedEntries.length}`}
                    </text>
                  )}
                </box>
                {installedEntries.length === 0 ? (
                  <text style={{ textColor: THEME.fgMuted }} marginTop={1}>
                    Nothing installed in this target yet. Focus a pack in Catalog and press [E].
                  </text>
                ) : (
                  visibleInstalled.map(([packName, locked]) => {
                    const isRoot = rootNames.has(packName)
                    const meta = `${locked.version} · ${locked.source}${locked.revision ? `@${locked.revision.slice(0, 7)}` : ""}${isRoot ? "" : " (dep)"}`
                    return (
                      <box key={packName} flexDirection="row" justifyContent="space-between" width="100%">
                        <text wrapMode="none" overflow="hidden" style={{ textColor: isRoot ? THEME.accentCyan : THEME.fgPrimary }}>
                          {middleEllipsis(`● ${terminalSafeText(packName)}`, Math.max(10, Math.floor(rightInner * 0.42)))}
                        </text>
                        <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                          {middleEllipsis(terminalSafeText(meta), Math.max(10, Math.floor(rightInner * 0.54)))}
                        </text>
                      </box>
                    )
                  })
                )}
              </box>

              {driftLines.length > 0 && (
                <box
                  width="100%"
                  border={true}
                  borderStyle="rounded"
                  borderColor={THEME.borderWarn}
                  backgroundColor={THEME.bgWarnSoft}
                  padding={1}
                  marginTop={1}
                  flexDirection="column"
                  overflow="hidden"
                >
                  <text style={{ textColor: THEME.accentAmber }} b>
                    Drift / Pending Updates:
                  </text>
                  {driftLines.slice(0, 4).map((line, idx) => (
                    <text key={idx} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }}>
                      {middleEllipsis(`• ${terminalSafeText(line)}`, rightInner - 2)}
                    </text>
                  ))}
                </box>
              )}
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
              <text
                wrapMode="none"
                style={{ textColor: THEME.accentGreen }}
                b
                u
                onMouseDown={(_self, event) => {
                  event.stopPropagation()
                  onReconcileTarget()
                }}
              >
                {rightInner >= 40 ? "[R] Reconcile Target" : "[R] Reconcile"}
              </text>
              <text
                wrapMode="none"
                style={{ textColor: THEME.accentCyan }}
                u
                onMouseDown={(_self, event) => {
                  event.stopPropagation()
                  onRefreshTarget()
                }}
              >
                [Ctrl+R] Refresh
              </text>
            </box>
          </box>
        </>
      )}
    </box>
  )
}
