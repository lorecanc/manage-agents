import React from "react"
import type { TargetStatus } from "../utils/installer.js"
import {
  assetSectionLabel,
  formatPackAssetBadges,
  type CatalogAssetItem,
  type CatalogAssetKind,
  type PackCatalogEntry,
} from "../utils/catalogIndex.js"
import { middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { THEME } from "../utils/uiTheme.js"
import { PromptMarkdownView } from "./PromptMarkdownView.js"

export interface PackInspectorProps {
  pack: PackCatalogEntry
  focusedSection?: CatalogAssetKind | null
  targetStatusInfo: TargetStatus | null
  isReadOnlyGitSource: boolean
  inspectorWidth: number
  scrollOffset: number
  maxRows: number
  onInstallPack: (packName: string) => void
  onBridgeCheck: (packName: string) => void
  onBridgeClaude: (packName: string) => void
  onBridgeCodex: (packName: string) => void
  onBridgeVibe: (packName: string) => void
  onCodexInstall: (packName: string) => void
  onOpenDoctor: (packName: string) => void
  onOpenScaffold: (packName: string) => void
}

function renderTargetPill(label: string, enabled: boolean, color: string) {
  return (
    <text
      height={1}
      wrapMode="none"
      backgroundColor={enabled ? THEME.bgPillActive : THEME.bgPill}
      style={{ textColor: enabled ? color : THEME.fgMuted }}
      b={enabled}
    >
      {` ${enabled ? "✓" : "–"} ${label} `}
    </text>
  )
}

function renderActionBtn(label: string, color: string, accent: boolean, onClick: () => void) {
  return (
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
}

export function PackInspector({
  pack,
  focusedSection,
  targetStatusInfo,
  isReadOnlyGitSource,
  inspectorWidth,
  scrollOffset,
  maxRows,
  onInstallPack,
  onBridgeCheck,
  onBridgeClaude,
  onBridgeCodex,
  onBridgeVibe,
  onCodexInstall,
  onOpenDoctor,
  onOpenScaffold,
}: PackInspectorProps) {
  const safeW = Math.max(24, inspectorWidth - 6)
  const locked = targetStatusInfo?.lock?.packs?.[pack.name]
  const isRootInstalled = Boolean(
    targetStatusInfo?.desired?.roots?.some(r => r.split("@")[0]?.split("/").pop() === pack.name),
  )
  const reqEntries = Object.entries(pack.requires)

  const execParts: string[] = []
  if (pack.executable.plugins.length) execParts.push(`${pack.executable.plugins.length} plugin`)
  if (pack.executable.toolModules.length) execParts.push(`${pack.executable.toolModules.length} tool`)
  if (pack.executable.skillScripts.length) execParts.push(`${pack.executable.skillScripts.length} script`)
  if (pack.executable.mcpServers.length) execParts.push(`${pack.executable.mcpServers.length} MCP`)

  const detailLines: Array<{ text: string; color: string; bold?: boolean }> = []
  if (pack.description) {
    detailLines.push({ text: middleEllipsis(terminalSafeText(pack.description), safeW - 2), color: THEME.fgPrimary })
  }
  if (focusedSection) {
    detailLines.push({
      text: `Focused section: ${assetSectionLabel(focusedSection)} (Enter / → to open)`,
      color: THEME.accentAmber,
    })
  }
  detailLines.push({
    text: locked
      ? `OpenCode v2: ✓ Installed v${terminalSafeText(locked.version)} (${isRootInstalled ? "root" : "dep"} · ${terminalSafeText(locked.source)})`
      : "OpenCode v2: Not installed",
    color: locked ? THEME.accentGreen : THEME.fgMuted,
  })
  detailLines.push({
    text: `Claude Code: ${pack.bridgeCompat.claude ? "✓" : "–"} ${middleEllipsis(pack.bridgeCompat.claudeReason, Math.max(12, safeW - 18))}`,
    color: pack.bridgeCompat.claude ? THEME.accentPurple : THEME.fgMuted,
  })
  detailLines.push({
    text: `OpenAI Codex: ${pack.bridgeCompat.codex ? "✓" : "–"} ${middleEllipsis(pack.bridgeCompat.codexReason, Math.max(12, safeW - 19))}`,
    color: pack.bridgeCompat.codex ? THEME.accentCyan : THEME.fgMuted,
  })
  detailLines.push({
    text: `Mistral Vibe: ${pack.bridgeCompat.vibe ? "✓" : "–"} ${middleEllipsis(pack.bridgeCompat.vibeReason, Math.max(12, safeW - 18))}`,
    color: pack.bridgeCompat.vibe ? THEME.accentAmber : THEME.fgMuted,
  })

  if (reqEntries.length > 0) {
    detailLines.push({ text: "", color: THEME.fgMuted })
    detailLines.push({ text: `Dependencies (${reqEntries.length})`, color: THEME.fgSecondary, bold: true })
    for (const [dep, range] of reqEntries) {
      detailLines.push({ text: `  • ${terminalSafeText(dep)} ${terminalSafeText(range)}`, color: THEME.fgPrimary })
    }
  }

  if (pack.issues.length > 0) {
    detailLines.push({ text: "", color: THEME.fgMuted })
    detailLines.push({ text: `Validation Issues (${pack.issues.length})`, color: THEME.accentAmber, bold: true })
    for (const issue of pack.issues.slice(0, 12)) {
      const prefix = issue.level === "error" ? "✗" : "⚠"
      const loc = issue.path ? `${terminalSafeText(issue.path)}: ` : ""
      detailLines.push({
        text: `  ${prefix} ${middleEllipsis(loc + terminalSafeText(issue.message), Math.max(12, safeW - 6))}`,
        color: issue.level === "error" ? THEME.accentRed : THEME.accentAmber,
      })
    }
  }

  const detailViewport = Math.max(3, maxRows - 12)
  const clampedOffset = Math.min(Math.max(0, detailLines.length - detailViewport), Math.max(0, scrollOffset))
  const visibleDetails = detailLines.slice(clampedOffset, clampedOffset + detailViewport)

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} justifyContent="space-between" overflow="hidden">
      <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        {/* Card 1: Pack Identity, Counts & Target Badges */}
        <box
          border={true}
          borderStyle="rounded"
          borderColor={pack.errorCount > 0 ? THEME.accentRed : locked ? THEME.accentGreen : THEME.accentBlue}
          backgroundColor={THEME.bgInput}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
          flexShrink={0}
        >
          <box flexDirection="row" justifyContent="space-between" height={1}>
            <text height={1} wrapMode="none" style={{ textColor: "#ffffff" }} b>
              {middleEllipsis(`📦 ${terminalSafeText(pack.name)}@${terminalSafeText(pack.version)}`, Math.max(12, safeW - 16))}
            </text>
            <text height={1} wrapMode="none" style={{ textColor: pack.isVirtual ? THEME.accentAmber : pack.errorCount > 0 ? THEME.accentRed : THEME.accentGreen }} b>
              {pack.isVirtual ? "◌ virtual" : pack.errorCount > 0 ? `✗ ${pack.errorCount} err` : "✓ valid"}
            </text>
          </box>

          <text height={1} wrapMode="none" style={{ textColor: THEME.accentCyan }}>
            {middleEllipsis(
              `${formatPackAssetBadges(pack.counts)}  ·  ${execParts.length > 0 ? `⚠ ${execParts.join(", ")}` : "declarative"}`,
              safeW - 2,
            )}
          </text>

          <box flexDirection="row" gap={1} height={1} marginTop={0}>
            {renderTargetPill("OC", true, THEME.accentGreen)}
            {renderTargetPill("Claude", pack.bridgeCompat.claude, THEME.accentPurple)}
            {renderTargetPill("Codex", pack.bridgeCompat.codex, THEME.accentCyan)}
            {renderTargetPill("Vibe", pack.bridgeCompat.vibe, THEME.accentAmber)}
          </box>
        </box>

        {/* Card 2: Targets, Dependencies & Validation Details */}
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
          {visibleDetails.map((line, idx) => (
            <text key={idx} height={1} wrapMode="none" overflow="hidden" style={{ textColor: line.color }} b={line.bold}>
              {line.text}
            </text>
          ))}
        </box>
      </box>

      {/* Footer Actions: Clean 2-row action bar */}
      <box
        borderStyle="single"
        border={["top"]}
        borderColor={THEME.borderSubtle}
        paddingTop={1}
        flexDirection="column"
        flexShrink={0}
      >
        <box flexDirection="row" gap={1} height={1} overflow="hidden">
          {renderActionBtn("E Install", THEME.accentGreen, true, () => onInstallPack(pack.name))}
          {renderActionBtn("⇧K Check", THEME.accentCyan, false, () => onBridgeCheck(pack.name))}
          {!isReadOnlyGitSource && !pack.isVirtual && renderActionBtn("D Doctor", THEME.accentAmber, false, () => onOpenDoctor(pack.name))}
          {!isReadOnlyGitSource && !pack.isVirtual && renderActionBtn("N New", THEME.accentGreen, false, () => onOpenScaffold(pack.name))}
        </box>
        <box flexDirection="row" gap={1} height={1} marginTop={1} overflow="hidden">
          {pack.bridgeCompat.claude && renderActionBtn("B Claude", THEME.accentPurple, false, () => onBridgeClaude(pack.name))}
          {pack.bridgeCompat.codex && renderActionBtn("⇧B Codex", THEME.accentCyan, false, () => onBridgeCodex(pack.name))}
          {pack.bridgeCompat.vibe && renderActionBtn("⇧V Vibe", THEME.accentAmber, false, () => onBridgeVibe(pack.name))}
          {pack.bridgeCompat.codex && renderActionBtn("C +Codex", THEME.accentGreen, false, () => onCodexInstall(pack.name))}
        </box>
      </box>
    </box>
  )
}

export interface AssetItemInspectorProps {
  asset: CatalogAssetItem
  pack: PackCatalogEntry | undefined
  inspectorWidth: number
  scrollOffset: number
  maxRows: number
}

function assetBridgeNote(kind: CatalogAssetItem["kind"]): { claude: string; codex: string; vibe: string; color: string } {
  switch (kind) {
    case "skill":
      return { claude: "Native Claude skill", codex: "Native Codex skill", vibe: "Native Vibe skill", color: THEME.accentGreen }
    case "command":
      return { claude: "Converted to Claude skill", codex: "OpenCode/Claude only", vibe: "Converted to Vibe skill (user-invocable)", color: THEME.accentCyan }
    case "mcp":
      return { claude: "Translated to .mcp.json", codex: "Translated to .mcp.json", vibe: "Translated to plugin mcp.json", color: THEME.accentPurple }
    case "tool":
      return { claude: "OpenCode-only", codex: "OpenCode-only", vibe: "OpenCode-only (skills recommended)", color: THEME.accentAmber }
    case "plugin":
      return { claude: "OpenCode-only", codex: "OpenCode-only", vibe: "OpenCode-only (skills recommended)", color: THEME.accentAmber }
    case "theme":
      return { claude: "OpenCode-only", codex: "OpenCode-only", vibe: "OpenCode-only", color: THEME.accentBlue }
  }
}

export function AssetItemInspector({
  asset,
  pack,
  inspectorWidth,
  scrollOffset,
  maxRows,
}: AssetItemInspectorProps) {
  const safeW = Math.max(24, inspectorWidth - 6)
  const notes = assetBridgeNote(asset.kind)
  const isMarkdownAsset = asset.kind === "skill" || asset.kind === "command"

  const fmEntries = asset.frontmatter ? Object.entries(asset.frontmatter) : []
  const previewRowsBudget = Math.max(4, maxRows - (fmEntries.length > 0 ? 11 : 9))

  const rawCodeLines = (asset.bodyPreview || "(empty file)").split(/\r?\n/)
  const clampedCodeOff = Math.min(Math.max(0, rawCodeLines.length - previewRowsBudget), Math.max(0, scrollOffset))
  const visibleCodeLines = rawCodeLines.slice(clampedCodeOff, clampedCodeOff + previewRowsBudget)

  const formatFmValue = (v: unknown): string => {
    if (typeof v === "string") return v
    try {
      return JSON.stringify(v) ?? ""
    } catch {
      return "[circular]"
    }
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
      {/* Card 1: Asset Metadata & Bridge Translation */}
      <box
        border={true}
        borderStyle="rounded"
        borderColor={notes.color}
        backgroundColor={THEME.bgInput}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
        flexShrink={0}
      >
        <box flexDirection="row" justifyContent="space-between" height={1}>
          <text height={1} wrapMode="none" style={{ textColor: "#ffffff" }} b>
            {middleEllipsis(`[${asset.kind.toUpperCase()}] ${terminalSafeText(asset.name)}`, Math.max(12, safeW - 14))}
          </text>
          <text height={1} wrapMode="none" style={{ textColor: asset.executable ? THEME.accentAmber : THEME.accentGreen }} b>
            {asset.executable ? "⚠ exec" : "✓ safe"}
          </text>
        </box>
        <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
          {middleEllipsis(`${terminalSafeText(asset.packName)}${pack ? `@${terminalSafeText(pack.version)}` : ""} · ${terminalSafeText(asset.relPath)}`, safeW - 2)}
        </text>
        {asset.extra?.serverType && (
          <text height={1} wrapMode="none" style={{ textColor: THEME.accentPurple }}>
            {middleEllipsis(
              `${terminalSafeText(asset.extra.serverType)} · ${asset.extra.enabled === false ? "disabled" : "enabled"}${asset.extra.commandOrUrl ? ` · ${terminalSafeText(asset.extra.commandOrUrl)}` : ""}`,
              safeW - 2,
            )}
          </text>
        )}
        <text height={1} wrapMode="none" style={{ textColor: THEME.accentPurple }}>
          {middleEllipsis(`Claude: ${notes.claude}`, safeW - 2)}
        </text>
        <text height={1} wrapMode="none" style={{ textColor: THEME.accentCyan }}>
          {middleEllipsis(`Codex:  ${notes.codex}`, safeW - 2)}
        </text>
        <text height={1} wrapMode="none" style={{ textColor: THEME.accentAmber }}>
          {middleEllipsis(`Vibe:   ${notes.vibe}`, safeW - 2)}
        </text>
        {fmEntries.slice(0, 2).map(([k, v]) => (
          <text key={k} height={1} wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
            {middleEllipsis(`${terminalSafeText(k)}: ${terminalSafeText(formatFmValue(v))}`, safeW - 2)}
          </text>
        ))}
      </box>

      {/* Card 2: Rich Content Preview (Markdown for Skill/Command, Code/JSON for Tool/Plugin/Theme/MCP) */}
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
        {isMarkdownAsset ? (
          <PromptMarkdownView
            markdown={asset.bodyPreview || "*Empty content.*"}
            width={Math.max(16, safeW - 2)}
            maxRows={previewRowsBudget}
            scrollOffset={scrollOffset}
            showFooter={false}
          />
        ) : (
          visibleCodeLines.map((rawLine, idx) => (
            <text key={idx} height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }}>
              {middleEllipsis(terminalSafeText(rawLine), safeW - 2)}
            </text>
          ))
        )}
      </box>
    </box>
  )
}
