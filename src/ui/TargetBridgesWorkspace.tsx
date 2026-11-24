import React from "react"
import type { TargetStatus } from "../utils/installer.js"
import { parsePackRequest } from "../utils/resolver.js"
import {
  formatBridgeBadges,
  formatPackAssetBadges,
  type CatalogIndex,
  type PackCatalogEntry,
} from "../utils/catalogIndex.js"
import type { TargetBackupSummary } from "../utils/targetActions.js"
import { middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { lerpColor, THEME } from "../utils/uiTheme.js"

export type TargetSubTab = "installed" | "bridges" | "backups"

export type TargetWorkspaceRow =
  | {
      kind: "installed-pack"
      id: string
      packName: string
      version: string
      source: string
      revision?: string
      isRoot: boolean
      catalogEntry?: PackCatalogEntry
    }
  | {
      kind: "bridge-pack"
      id: string
      packName: string
      pack: PackCatalogEntry
      isInstalled: boolean
      installedVersion?: string
    }
  | {
      kind: "backup"
      id: string
      backup: TargetBackupSummary
    }

export function buildTargetRowsForTab(
  subTab: TargetSubTab,
  targetStatusInfo: TargetStatus | null,
  backups: readonly TargetBackupSummary[],
  catalogIndex: CatalogIndex,
): TargetWorkspaceRow[] {
  const lockedMap = targetStatusInfo?.lock?.packs ?? {}
  const rootNames = new Set((targetStatusInfo?.desired?.roots ?? []).map(r => parsePackRequest(r).name))

  if (subTab === "installed") {
    return Object.entries(lockedMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, locked]) => ({
        kind: "installed-pack",
        id: `installed:${name}`,
        packName: name,
        version: locked.version,
        source: locked.source,
        revision: locked.revision,
        isRoot: rootNames.has(name),
        catalogEntry: catalogIndex.byName.get(name),
      }))
  }

  if (subTab === "bridges") {
    return catalogIndex.packs.map(pack => {
      const locked = lockedMap[pack.name]
      return {
        kind: "bridge-pack",
        id: `bridge:${pack.name}`,
        packName: pack.name,
        pack,
        isInstalled: Boolean(locked),
        installedVersion: locked?.version,
      }
    })
  }

  return backups.map(backup => ({
    kind: "backup",
    id: `backup:${backup.id}`,
    backup,
  }))
}

export interface TargetBridgesWorkspaceProps {
  subTab: TargetSubTab
  rows: TargetWorkspaceRow[]
  installedCount: number
  bridgesCount: number
  backupsCount: number
  focusedIndex: number
  scrollOffset: number
  listRows: number
  targetStatusInfo: TargetStatus | null
  leftWidth: number
  rightWidth: number
  gutterWidth: number
  showInspector: boolean
  activePane: "list" | "inspector"
  focusBorderBlend: number
  inspectorScrollOffset: number
  busySpinner: string
  onSelectSubTab: (tab: TargetSubTab) => void
  onSelectPane: (pane: "list" | "inspector") => void
  onFocusIndex: (index: number) => void
  onScrollDelta: (delta: number) => void
  onScrollInspectorDelta: (delta: number) => void
  onInstallPack: (packName: string) => void
  onUpdatePack: (packName?: string) => void
  onUninstallPack: (packName: string) => void
  onReconcile: (adopt: boolean) => void
  onRestoreBackup: (backupId: string) => void
  onRefresh: () => void
  onBridgeCheck: (packName: string) => void
  onBridgeClaude: (packName: string) => void
  onBridgeCodex: (packName: string) => void
  onCodexInstall: (packName: string) => void
}

export function TargetBridgesWorkspace({
  subTab,
  rows,
  installedCount,
  bridgesCount,
  backupsCount,
  focusedIndex,
  scrollOffset,
  listRows,
  targetStatusInfo,
  leftWidth,
  rightWidth,
  gutterWidth,
  showInspector,
  activePane,
  focusBorderBlend,
  inspectorScrollOffset,
  busySpinner,
  onSelectSubTab,
  onSelectPane,
  onFocusIndex,
  onScrollDelta,
  onScrollInspectorDelta,
  onInstallPack,
  onUpdatePack,
  onUninstallPack,
  onReconcile,
  onRestoreBackup,
  onRefresh,
  onBridgeCheck,
  onBridgeClaude,
  onBridgeCodex,
  onCodexInstall,
}: TargetBridgesWorkspaceProps) {
  const isInspectorFocused = showInspector && activePane === "inspector"
  const leftBorder = lerpColor(THEME.borderSubtle, THEME.accentPurple, isInspectorFocused ? 0 : focusBorderBlend)
  const rightBorder = lerpColor(THEME.borderSubtle, THEME.accentCyan, isInspectorFocused ? focusBorderBlend : 0)
  const leftInner = Math.max(20, leftWidth - 4)
  const rightInner = Math.max(24, rightWidth - 4)

  const driftList = targetStatusInfo?.drift ?? []
  const driftCount = driftList.length
  const targetDirLabel = targetStatusInfo?.target ? terminalSafeText(targetStatusInfo.target) : "(unavailable)"

  const pageSize = Math.max(2, listRows - 2)
  const clampedFocus = rows.length > 0 ? Math.max(0, Math.min(focusedIndex, rows.length - 1)) : 0
  const clampedScroll = Math.max(0, Math.min(scrollOffset, Math.max(0, rows.length - pageSize)))
  const visibleRows = rows.slice(clampedScroll, clampedScroll + pageSize)
  const focusedRow = rows[clampedFocus] ?? null

  const leftTitle = showInspector
    ? !isInspectorFocused
      ? ` ● ${busySpinner ? `${busySpinner} ` : ""}OpenCode v2 Target & Bridges `
      : ` OpenCode v2 Target & Bridges · ⇧← `
    : ` ${busySpinner ? `${busySpinner} ` : ""}OpenCode v2 Target & Bridges `

  const rightTitle = isInspectorFocused
    ? " ● Inspector & Actions "
    : " Inspector & Actions · ⇧→ "

  const subTabs: Array<{ key: TargetSubTab; label: string; short: string; color: string }> = [
    { key: "installed", label: `1 Installed (${installedCount})`, short: `1 Inst (${installedCount})`, color: THEME.accentGreen },
    { key: "bridges", label: `2 Bridges (${bridgesCount})`, short: `2 Brdg (${bridgesCount})`, color: THEME.accentPurple },
    { key: "backups", label: `3 Backups (${backupsCount})`, short: `3 Bkp (${backupsCount})`, color: THEME.accentAmber },
  ]

  // Responsive column widths for the left table
  const colNameW = Math.max(12, Math.floor(leftInner * 0.44))
  const colMidW = Math.max(10, Math.floor(leftInner * 0.30))
  const colRightW = Math.max(8, leftInner - colNameW - colMidW - 2)

  const colHeaders =
    subTab === "installed"
      ? ["Pack", "Version / Source", "Scope"]
      : subTab === "bridges"
        ? ["Pack", "Assets", "Targets"]
        : ["Backup Snapshot", "Contents", "Created"]

  const renderBadgePill = (label: string, active: boolean, activeColor: string) => (
    <text
      height={1}
      wrapMode="none"
      backgroundColor={active ? THEME.bgPillActive : THEME.bgPill}
      style={{ textColor: active ? activeColor : THEME.fgMuted }}
      b={active}
    >
      {` ${active ? "✓" : "–"} ${label} `}
    </text>
  )

  const renderActionPill = (label: string, color: string, accent: boolean, onClick: () => void) => (
    <text
      height={1}
      wrapMode="none"
      backgroundColor={accent ? THEME.bgPillActive : THEME.bgPill}
      style={{ textColor: accent ? "#ffffff" : color }}
      b={accent}
      onMouseDown={(_self, event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {` ${label} `}
    </text>
  )

  const renderInspectorCards = () => {
    if (!focusedRow) {
      return (
        <box flexDirection="column" flexGrow={1} minHeight={0} justifyContent="space-between" overflow="hidden">
          <box flexDirection="column" gap={1}>
            <box
              border={true}
              borderStyle="rounded"
              borderColor={driftCount > 0 ? THEME.accentAmber : THEME.borderSubtle}
              backgroundColor={THEME.bgInput}
              paddingLeft={1}
              paddingRight={1}
              flexDirection="column"
            >
              <text height={1} wrapMode="none" style={{ textColor: THEME.accentCyan }} b>
                {"Target Health"}
              </text>
              <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
                {middleEllipsis(targetDirLabel, rightInner - 4)}
              </text>
              <text height={1} wrapMode="none" style={{ textColor: driftCount === 0 ? THEME.accentGreen : THEME.accentAmber }}>
                {driftCount === 0 ? "✓ Target is clean and synced" : `⚠ ${driftCount} drift issue(s) detected`}
              </text>
            </box>
            <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
              {subTab === "installed"
                ? "No packs installed in this target yet. Switch to [2] Bridges or Catalog to install."
                : subTab === "backups"
                  ? "No adopt/backup snapshots yet. Backups are created by Reconcile --adopt."
                  : "No packs found in the active workspace."}
            </text>
          </box>
          <box borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} flexDirection="row" gap={1}>
            {renderActionPill("[R] Reconcile", THEME.accentCyan, false, () => onReconcile(false))}
            {renderActionPill("[Ctrl+R] Refresh", THEME.fgSecondary, false, onRefresh)}
          </box>
        </box>
      )
    }

    if (focusedRow.kind === "backup") {
      const b = focusedRow.backup
      const fileViewport = Math.max(3, listRows - 11)
      const safeOff = Math.min(Math.max(0, b.files.length - fileViewport), Math.max(0, inspectorScrollOffset))
      const visibleFiles = b.files.slice(safeOff, safeOff + fileViewport)

      return (
        <box flexDirection="column" flexGrow={1} minHeight={0} justifyContent="space-between" overflow="hidden">
          <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            <box
              border={true}
              borderStyle="rounded"
              borderColor={THEME.accentAmber}
              backgroundColor={THEME.bgInput}
              paddingLeft={1}
              paddingRight={1}
              flexDirection="column"
              flexShrink={0}
            >
              <text height={1} wrapMode="none" style={{ textColor: THEME.accentAmber }} b>
                {middleEllipsis(`↺ Snapshot ${terminalSafeText(b.id)}`, rightInner - 4)}
              </text>
              <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
                {`Created: ${b.createdAt ? terminalSafeText(b.createdAt) : "unknown"} · ${b.fileCount} file(s) · ${b.configCount} config entry/entries`}
              </text>
              <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                {"Restoring puts adopted files back and marks them unmanaged."}
              </text>
            </box>

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
              <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }} b>
                {`Backed-up Files (${b.files.length})`}
              </text>
              {visibleFiles.length === 0 ? (
                <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                  {"  (config-only backup)"}
                </text>
              ) : (
                visibleFiles.map((f, idx) => (
                  <text key={idx} height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }}>
                    {`  • ${middleEllipsis(terminalSafeText(f), rightInner - 8)}`}
                  </text>
                ))
              )}
            </box>
          </box>

          <box borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} paddingTop={1} flexDirection="row" gap={1} flexShrink={0}>
            {renderActionPill("[⇧R] Restore Snapshot", THEME.accentGreen, true, () => onRestoreBackup(b.id))}
            {renderActionPill("[Ctrl+R] Refresh", THEME.fgSecondary, false, onRefresh)}
          </box>
        </box>
      )
    }

    // Both "installed-pack" and "bridge-pack" render structured Pack Target & Bridge cards
    const packName = focusedRow.packName
    const cat = focusedRow.kind === "installed-pack" ? focusedRow.catalogEntry : focusedRow.pack
    const isInstalled = focusedRow.kind === "installed-pack" ? true : focusedRow.isInstalled
    const isRoot = focusedRow.kind === "installed-pack" ? focusedRow.isRoot : false
    const version = focusedRow.kind === "installed-pack"
      ? focusedRow.version
      : (focusedRow.installedVersion ?? focusedRow.pack.version)
    const sourceLabel = focusedRow.kind === "installed-pack"
      ? `${focusedRow.source}${focusedRow.revision ? ` (${focusedRow.revision.slice(0, 10)})` : ""}`
      : (cat?.isVirtual ? "virtual workspace" : "active catalog")

    const detailLines: Array<{ text: string; color: string }> = []
    if (driftCount > 0 && isInstalled) {
      for (const d of driftList.slice(0, 5)) {
        detailLines.push({ text: `⚠ ${middleEllipsis(terminalSafeText(d), rightInner - 6)}`, color: THEME.accentAmber })
      }
    }
    if (cat && Object.keys(cat.requires).length > 0) {
      detailLines.push({
        text: `Requires: ${Object.entries(cat.requires).map(([k, v]) => `${k}@${v}`).join(", ")}`,
        color: THEME.fgSecondary,
      })
    }
    if (cat && cat.issues.length > 0) {
      detailLines.push({
        text: `Contract: ${cat.errorCount} error(s), ${cat.warningCount} warning(s)`,
        color: cat.errorCount > 0 ? THEME.accentRed : THEME.accentAmber,
      })
    }

    return (
      <box flexDirection="column" flexGrow={1} minHeight={0} justifyContent="space-between" overflow="hidden">
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          {/* Card 1: Pack Identity & OpenCode v2 State */}
          <box
            border={true}
            borderStyle="rounded"
            borderColor={isInstalled ? THEME.accentGreen : THEME.accentBlue}
            backgroundColor={THEME.bgInput}
            paddingLeft={1}
            paddingRight={1}
            flexDirection="column"
            flexShrink={0}
          >
            <box flexDirection="row" justifyContent="space-between" height={1}>
              <text height={1} wrapMode="none" style={{ textColor: "#ffffff" }} b>
                {middleEllipsis(`📦 ${terminalSafeText(packName)}@${terminalSafeText(version)}`, Math.max(12, rightInner - 18))}
              </text>
              <text height={1} wrapMode="none" style={{ textColor: isInstalled ? THEME.accentGreen : THEME.fgMuted }} b>
                {isInstalled ? (isRoot ? "● root" : "● dep") : "◌ catalog"}
              </text>
            </box>
            <text height={1} wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
              {middleEllipsis(`Source: ${terminalSafeText(sourceLabel)}`, rightInner - 4)}
            </text>
            {cat && (
              <text height={1} wrapMode="none" style={{ textColor: THEME.accentCyan }}>
                {middleEllipsis(
                  `A:${cat.counts.agents}  S:${cat.counts.skills}  C:${cat.counts.commands}  T:${cat.counts.tools}  P:${cat.counts.plugins}  M:${cat.counts.mcp}`,
                  rightInner - 4,
                )}
              </text>
            )}
          </box>

          {/* Card 2: Multi-Target & Bridge Compatibility */}
          <box
            border={true}
            borderStyle="rounded"
            borderColor={THEME.borderSubtle}
            backgroundColor={THEME.bgInput}
            paddingLeft={1}
            paddingRight={1}
            marginTop={1}
            flexDirection="column"
            flexShrink={0}
          >
            <box flexDirection="row" gap={1} height={1}>
              {renderBadgePill("OpenCode v2", true, THEME.accentGreen)}
              {renderBadgePill("Claude", Boolean(cat?.bridgeCompat.claude), THEME.accentPurple)}
              {renderBadgePill("Codex", Boolean(cat?.bridgeCompat.codex), THEME.accentCyan)}
            </box>
            <text height={1} wrapMode="none" style={{ textColor: cat?.bridgeCompat.claude ? THEME.fgPrimary : THEME.fgMuted }}>
              {middleEllipsis(`Claude: ${cat ? cat.bridgeCompat.claudeReason : "inspect in catalog"}`, rightInner - 4)}
            </text>
            <text height={1} wrapMode="none" style={{ textColor: cat?.bridgeCompat.codex ? THEME.fgPrimary : THEME.fgMuted }}>
              {middleEllipsis(`Codex:  ${cat ? cat.bridgeCompat.codexReason : "inspect in catalog"}`, rightInner - 4)}
            </text>
          </box>

          {/* Card 3: Drift / Dependencies / Notes */}
          {detailLines.length > 0 && (
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
              {detailLines.slice(0, Math.max(2, listRows - 14)).map((line, idx) => (
                <text key={idx} height={1} wrapMode="none" overflow="hidden" style={{ textColor: line.color }}>
                  {line.text}
                </text>
              ))}
            </box>
          )}
        </box>

        {/* Footer Actions — Clean 2-row action bar */}
        <box
          borderStyle="single"
          border={["top"]}
          borderColor={THEME.borderSubtle}
          paddingTop={1}
          flexDirection="column"
          gap={0}
          flexShrink={0}
        >
          <box flexDirection="row" gap={1} height={1} overflow="hidden">
            {isInstalled ? (
              <>
                {renderActionPill("U Update", THEME.accentGreen, true, () => onUpdatePack(packName))}
                {isRoot && renderActionPill("X Uninstall", THEME.accentRed, false, () => onUninstallPack(packName))}
                {renderActionPill("R Reconcile", THEME.accentCyan, false, () => onReconcile(false))}
                {driftCount > 0 && renderActionPill("⇧A Adopt", THEME.accentAmber, false, () => onReconcile(true))}
              </>
            ) : (
              renderActionPill("E Install OpenCode v2", THEME.accentGreen, true, () => onInstallPack(packName))
            )}
          </box>
          <box flexDirection="row" gap={1} height={1} marginTop={1} overflow="hidden">
            {renderActionPill("⇧K Check", THEME.accentCyan, false, () => onBridgeCheck(packName))}
            {(!cat || cat.bridgeCompat.claude) && renderActionPill("B Claude", THEME.accentPurple, false, () => onBridgeClaude(packName))}
            {(!cat || cat.bridgeCompat.codex) && renderActionPill("⇧B Codex", THEME.accentCyan, false, () => onBridgeCodex(packName))}
            {(!cat || cat.bridgeCompat.codex) && renderActionPill("C +Codex", THEME.accentGreen, false, () => onCodexInstall(packName))}
          </box>
        </box>
      </box>
    )
  }

  return (
    <box width="100%" minHeight={0} flexGrow={1} flexDirection="row" marginTop={1} overflow="hidden">
      {/* Left Panel: Sub-tabbed clean list */}
      <box
        width={showInspector ? leftWidth : "100%"}
        flexGrow={0}
        minHeight={0}
        border={true}
        borderStyle="rounded"
        borderColor={leftBorder}
        backgroundColor={THEME.bgPanel}
        title={leftTitle}
        titleColor={!isInspectorFocused ? THEME.accentPurple : THEME.fgSecondary}
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
        <box flexDirection="column" width="100%" flexGrow={1} minHeight={0} overflow="hidden">
          {/* Sub-tab bar (1 Installed | 2 Bridges | 3 Backups) */}
          <box
            flexDirection="row"
            justifyContent="space-between"
            width="100%"
            height={2}
            borderStyle="single"
            border={["bottom"]}
            borderColor={THEME.borderSubtle}
            alignItems="center"
            overflow="hidden"
            flexShrink={0}
          >
            <box flexDirection="row" gap={1} height={1}>
              {subTabs.map(t => {
                const active = t.key === subTab
                return (
                  <text
                    key={t.key}
                    height={1}
                    wrapMode="none"
                    backgroundColor={active ? THEME.bgPillActive : "transparent"}
                    style={{ textColor: active ? t.color : THEME.fgSecondary }}
                    b={active}
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      onSelectPane("list")
                      onSelectSubTab(t.key)
                    }}
                  >
                    {` ${leftInner >= 56 ? t.label : t.short} `}
                  </text>
                )
              })}
            </box>
            <text height={1} wrapMode="none" style={{ textColor: driftCount === 0 ? THEME.accentGreen : THEME.accentAmber }} b>
              {driftCount === 0 ? "✓ Synced" : `⚠ ${driftCount} drift`}
            </text>
          </box>

          {/* Target directory strip */}
          <box flexDirection="row" justifyContent="space-between" height={1} marginTop={1} flexShrink={0}>
            <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
              {middleEllipsis(`Target: ${targetDirLabel}`, Math.max(14, leftInner - 14))}
            </text>
            <text
              height={1}
              wrapMode="none"
              style={{ textColor: THEME.accentCyan }}
              u
              onMouseDown={(_self, event) => {
                event.stopPropagation()
                onRefresh()
              }}
            >
              {"[Ctrl+R] Sync"}
            </text>
          </box>

          {/* Aligned Column Header */}
          <box flexDirection="row" width="100%" height={1} marginTop={1} flexShrink={0}>
            <text width={colNameW} wrapMode="none" style={{ textColor: THEME.fgMuted }}>{colHeaders[0]}</text>
            <text width={1}>{" "}</text>
            <text width={colMidW} wrapMode="none" style={{ textColor: THEME.fgMuted }}>{colHeaders[1]}</text>
            <text width={1}>{" "}</text>
            <text width={colRightW} wrapMode="none" style={{ textColor: THEME.fgMuted }}>{colHeaders[2]}</text>
          </box>

          {/* Clean single-entity rows */}
          <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            {visibleRows.length === 0 ? (
              <box marginTop={1}>
                <text wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                  {subTab === "installed"
                    ? "  No packs installed yet. Press [2] Bridges or switch to Catalog."
                    : subTab === "backups"
                      ? "  No backup snapshots found."
                      : "  No packs in the active workspace."}
                </text>
              </box>
            ) : (
              visibleRows.map((row, idx) => {
                const globalIdx = clampedScroll + idx
                const isFocused = globalIdx === clampedFocus
                let col1 = ""
                let col2 = ""
                let col3 = ""
                let col1Color: string = THEME.fgPrimary
                let col3Color: string = THEME.fgSecondary

                if (row.kind === "installed-pack") {
                  col1 = `${isFocused ? "▎" : " "} 📦 ${terminalSafeText(row.packName)}`
                  col2 = `v${terminalSafeText(row.version)} · ${terminalSafeText(row.source)}`
                  col3 = row.isRoot ? "● root" : "○ dep"
                  col1Color = isFocused ? "#ffffff" : THEME.accentGreen
                  col3Color = row.isRoot ? THEME.accentGreen : THEME.fgMuted
                } else if (row.kind === "bridge-pack") {
                  col1 = `${isFocused ? "▎" : " "} 📦 ${terminalSafeText(row.packName)}`
                  col2 = formatPackAssetBadges(row.pack.counts)
                  col3 = `${formatBridgeBadges(row.pack.bridgeCompat)}${row.isInstalled ? " ●" : ""}`
                  col1Color = isFocused ? "#ffffff" : THEME.fgPrimary
                  col3Color = row.pack.bridgeCompat.claude || row.pack.bridgeCompat.codex ? THEME.accentPurple : THEME.fgMuted
                } else {
                  col1 = `${isFocused ? "▎" : " "} ↺ ${terminalSafeText(row.backup.id)}`
                  col2 = `${row.backup.fileCount}f · ${row.backup.configCount} cfg`
                  col3 = row.backup.createdAt ? terminalSafeText(row.backup.createdAt.slice(0, 10)) : "snapshot"
                  col1Color = isFocused ? "#ffffff" : THEME.accentAmber
                }

                return (
                  <box
                    key={row.id}
                    width="100%"
                    height={1}
                    flexDirection="row"
                    backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      onSelectPane("list")
                      onFocusIndex(globalIdx)
                    }}
                  >
                    <text width={colNameW} wrapMode="none" overflow="hidden" style={{ textColor: col1Color }} b={isFocused}>
                      {middleEllipsis(col1, colNameW)}
                    </text>
                    <text width={1}>{" "}</text>
                    <text width={colMidW} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? THEME.fgPrimary : THEME.fgSecondary }}>
                      {middleEllipsis(col2, colMidW)}
                    </text>
                    <text width={1}>{" "}</text>
                    <text width={colRightW} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? THEME.accentCyan : col3Color }}>
                      {middleEllipsis(col3, colRightW)}
                    </text>
                  </box>
                )
              })
            )}
          </box>
        </box>

        {/* Left Panel Footer */}
        <box
          width="100%"
          height={1}
          flexDirection="row"
          justifyContent="space-between"
          flexShrink={0}
        >
          <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
            {rows.length > 0 ? `Row ${clampedFocus + 1}/${rows.length}` : "Empty"}
          </text>
          <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
            {"1/2/3 Sub-tabs · ↑/↓ Select"}
          </text>
        </box>
      </box>

      {/* Right Panel: Structured Cards & Actions */}
      {showInspector && (
        <>
          <box width={gutterWidth} flexShrink={0} />
          <box
            width={rightWidth}
            flexGrow={0}
            minHeight={0}
            border={true}
            borderStyle="rounded"
            borderColor={rightBorder}
            backgroundColor={THEME.bgPanel}
            title={rightTitle}
            titleColor={isInspectorFocused ? THEME.accentCyan : THEME.fgSecondary}
            padding={1}
            flexDirection="column"
            overflow="hidden"
            onMouseDown={() => onSelectPane("inspector")}
            onMouseScroll={(_self, event) => {
              const dir = (event as any).scroll?.direction
              if (dir === "down") onScrollInspectorDelta(2)
              else if (dir === "up") onScrollInspectorDelta(-2)
            }}
          >
            {renderInspectorCards()}
          </box>
        </>
      )}
    </box>
  )
}
