import React from "react"
import type { EffectiveOnboardingLayout, OnboardingInspection } from "../utils/packOnboarding.js"
import { middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { THEME } from "../utils/uiTheme.js"

export type OnboardingField = "cloneDest" | "name" | "version" | "desc" | "layout" | "organize" | "kit"

export interface PackOnboardingModalProps {
  workspaceRoot: string
  sourceLabel?: string
  isRemoteGit: boolean
  inspection: OnboardingInspection | null
  focusedField: OnboardingField
  cloneDest: string
  name: string
  version: string
  description: string
  layout: EffectiveOnboardingLayout
  organize: boolean
  authoringKit: boolean
  termWidth: number
  termHeight: number
  onFocusField: (field: OnboardingField) => void
  onSelectLayout: (layout: EffectiveOnboardingLayout) => void
  onSelectOrganize: (organize: boolean) => void
  onSelectAuthoringKit: (kit: boolean) => void
  onSubmit: () => void
  onCancel: () => void
}

export function getOnboardingFieldOrder(isRemoteGit: boolean): OnboardingField[] {
  return isRemoteGit
    ? ["cloneDest", "name", "version", "desc", "layout", "organize", "kit"]
    : ["name", "version", "desc", "layout", "organize", "kit"]
}

export function PackOnboardingModal({
  workspaceRoot,
  sourceLabel,
  isRemoteGit,
  inspection,
  focusedField,
  cloneDest,
  name,
  version,
  description,
  layout,
  organize,
  authoringKit,
  termWidth,
  termHeight,
  onFocusField,
  onSelectLayout,
  onSelectOrganize,
  onSelectAuthoringKit,
  onSubmit,
  onCancel,
}: PackOnboardingModalProps) {
  const modalWidth = Math.min(Math.max(24, termWidth - 2), Math.max(54, Math.min(92, termWidth - 6)))
  const innerWidth = Math.max(20, modalWidth - 4)
  const compact = termHeight < 28
  const rowGap = compact ? 0 : 1
  const fieldCount = isRemoteGit ? 7 : 6
  const desiredHeight = (compact ? 6 : 9) + fieldCount * (1 + rowGap) + 2
  const modalHeight = Math.min(Math.max(14, termHeight - 2), desiredHeight)
  const left = Math.max(0, Math.floor((termWidth - modalWidth) / 2))
  const top = Math.max(0, Math.floor((termHeight - modalHeight) / 2))

  const discoveryParts: string[] = []
  if (inspection) {
    discoveryParts.push(
      `${inspection.agents.length} agent${inspection.agents.length === 1 ? "" : "s"}${inspection.v1AgentCount > 0 ? ` (${inspection.v1AgentCount} V1->V2)` : ""}`,
    )
    if (inspection.skills.length > 0) discoveryParts.push(`${inspection.skills.length} skill${inspection.skills.length === 1 ? "" : "s"}`)
    if (inspection.commands.length > 0) discoveryParts.push(`${inspection.commands.length} cmd${inspection.commands.length === 1 ? "" : "s"}`)
    if (inspection.hasDotOpencode) discoveryParts.push(".opencode/")
    if (inspection.configUserKeys.length > 0) discoveryParts.push(`${inspection.configUserKeys.length} user key(s) cleaned`)
    if (inspection.inferredArchetype) discoveryParts.push(`archetype: ${terminalSafeText(inspection.inferredArchetype.reference)}`)
  }
  const discoveryLine = discoveryParts.length > 0 ? `Found: ${discoveryParts.join(" · ")}` : "Scan complete: ready to initialize Contract 1.1 pack"

  const contextLine = isRemoteGit
    ? `Remote Git (${terminalSafeText(sourceLabel || "git")}): clones locally & switches active source`
    : inspection && inspection.mixedProjectFiles.length > 0
      ? `Mixed repo (${terminalSafeText(inspection.mixedProjectFiles.slice(0, 3).join(", "))}): packs/${terminalSafeText(name || "pack")}/ keeps project root clean`
      : `Workspace: ${terminalSafeText(workspaceRoot)}`

  const labelColWidth = Math.min(18, Math.max(13, Math.floor(innerWidth * 0.24)))
  const valueMaxWidth = Math.max(12, innerWidth - labelColWidth - 3)
  const slugPreview = terminalSafeText(name || "pack")
  const primaryLabel = isRemoteGit ? " [ENTER] Clone & Onboard " : " [ENTER] Onboard Pack "

  const renderTogglePill = (active: boolean, focused: boolean, text: string, onClick: () => void) => (
    <text
      height={1}
      wrapMode="none"
      backgroundColor={active ? (focused ? THEME.accentGreen : THEME.bgSuccessSoft) : THEME.bgPill}
      style={{ textColor: active ? (focused ? THEME.bgBase : THEME.accentGreen) : THEME.fgSecondary }}
      b={active}
      onMouseDown={(_self, event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {` ${active ? "● " : ""}${text} `}
    </text>
  )

  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={modalWidth}
      height={modalHeight}
      zIndex={45}
      border={true}
      borderStyle="rounded"
      borderColor={THEME.accentGreen}
      backgroundColor={THEME.bgElevated}
      title={isRemoteGit ? " Clone & Onboard OpenCode Pack (1.1) " : " Onboard OpenCode Pack (contract 1.1) "}
      titleColor={THEME.accentGreen}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={compact ? 0 : 1}
      paddingBottom={compact ? 0 : 1}
      flexDirection="column"
      justifyContent="space-between"
      overflow="hidden"
    >
      <box flexDirection="column" overflow="hidden">
        <text wrapMode="none" style={{ textColor: THEME.accentCyan }} b>
          {middleEllipsis(discoveryLine, innerWidth)}
        </text>
        <text wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
          {middleEllipsis(contextLine, innerWidth)}
        </text>

        {isRemoteGit && (
          <box
            flexDirection="row"
            marginTop={1}
            backgroundColor={focusedField === "cloneDest" ? THEME.bgRowFocus : "transparent"}
            paddingLeft={1}
            onMouseDown={() => onFocusField("cloneDest")}
          >
            <text width={labelColWidth} wrapMode="none" style={{ textColor: focusedField === "cloneDest" ? THEME.accentGreen : THEME.accentAmber }} b={focusedField === "cloneDest"}>
              {focusedField === "cloneDest" ? "▎Clone Path:" : " Clone Path:"}
            </text>
            <text wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
              {middleEllipsis(`${terminalSafeText(cloneDest)}${focusedField === "cloneDest" ? "▋" : ""}`, valueMaxWidth)}
            </text>
          </box>
        )}

        <box
          flexDirection="row"
          marginTop={isRemoteGit ? rowGap : 1}
          backgroundColor={focusedField === "name" ? THEME.bgRowFocus : "transparent"}
          paddingLeft={1}
          onMouseDown={() => onFocusField("name")}
        >
          <text width={labelColWidth} wrapMode="none" style={{ textColor: focusedField === "name" ? THEME.accentGreen : THEME.accentAmber }} b={focusedField === "name"}>
            {focusedField === "name" ? "▎Pack Name:" : " Pack Name:"}
          </text>
          <text wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
            {middleEllipsis(`${terminalSafeText(name)}${focusedField === "name" ? "▋" : ""}`, valueMaxWidth)}
          </text>
        </box>

        <box
          flexDirection="row"
          marginTop={rowGap}
          backgroundColor={focusedField === "version" ? THEME.bgRowFocus : "transparent"}
          paddingLeft={1}
          onMouseDown={() => onFocusField("version")}
        >
          <text width={labelColWidth} wrapMode="none" style={{ textColor: focusedField === "version" ? THEME.accentGreen : THEME.accentAmber }} b={focusedField === "version"}>
            {focusedField === "version" ? "▎Version:" : " Version:"}
          </text>
          <text wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
            {middleEllipsis(`${terminalSafeText(version)}${focusedField === "version" ? "▋" : ""}`, valueMaxWidth)}
          </text>
        </box>

        <box
          flexDirection="row"
          marginTop={rowGap}
          backgroundColor={focusedField === "desc" ? THEME.bgRowFocus : "transparent"}
          paddingLeft={1}
          onMouseDown={() => onFocusField("desc")}
        >
          <text width={labelColWidth} wrapMode="none" style={{ textColor: focusedField === "desc" ? THEME.accentGreen : THEME.accentAmber }} b={focusedField === "desc"}>
            {focusedField === "desc" ? "▎Description:" : " Description:"}
          </text>
          <text wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
            {middleEllipsis(`${terminalSafeText(description)}${focusedField === "desc" ? "▋" : ""}`, valueMaxWidth)}
          </text>
        </box>

        <box
          flexDirection="row"
          marginTop={rowGap}
          backgroundColor={focusedField === "layout" ? THEME.bgRowFocus : "transparent"}
          paddingLeft={1}
          onMouseDown={() => onFocusField("layout")}
        >
          <text width={labelColWidth} wrapMode="none" style={{ textColor: focusedField === "layout" ? THEME.accentGreen : THEME.fgSecondary }} b={focusedField === "layout"}>
            {focusedField === "layout" ? "▎Pack Root:" : " Pack Root:"}
          </text>
          <box flexDirection="row" gap={1} height={1}>
            {renderTogglePill(
              layout === "root",
              focusedField === "layout",
              `Root ./${inspection?.recommendedLayout === "root" ? " (auto)" : ""}`,
              () => {
                onFocusField("layout")
                onSelectLayout("root")
              },
            )}
            {renderTogglePill(
              layout === "subpack",
              focusedField === "layout",
              middleEllipsis(`packs/${slugPreview}/${inspection?.recommendedLayout === "subpack" ? " (auto)" : ""}`, Math.max(14, valueMaxWidth - 18)),
              () => {
                onFocusField("layout")
                onSelectLayout("subpack")
              },
            )}
          </box>
        </box>

        <box
          flexDirection="row"
          marginTop={rowGap}
          backgroundColor={focusedField === "organize" ? THEME.bgRowFocus : "transparent"}
          paddingLeft={1}
          onMouseDown={() => onFocusField("organize")}
        >
          <text width={labelColWidth} wrapMode="none" style={{ textColor: focusedField === "organize" ? THEME.accentGreen : THEME.fgSecondary }} b={focusedField === "organize"}>
            {focusedField === "organize" ? "▎Normalize:" : " Normalize:"}
          </text>
          <box flexDirection="row" gap={1} height={1}>
            {renderTogglePill(organize, focusedField === "organize", "V2 + agents/ + archetype", () => {
              onFocusField("organize")
              onSelectOrganize(true)
            })}
            {renderTogglePill(!organize, focusedField === "organize", "Keep in place", () => {
              onFocusField("organize")
              onSelectOrganize(false)
            })}
          </box>
        </box>

        <box
          flexDirection="row"
          marginTop={rowGap}
          backgroundColor={focusedField === "kit" ? THEME.bgRowFocus : "transparent"}
          paddingLeft={1}
          onMouseDown={() => onFocusField("kit")}
        >
          <text width={labelColWidth} wrapMode="none" style={{ textColor: focusedField === "kit" ? THEME.accentGreen : THEME.fgSecondary }} b={focusedField === "kit"}>
            {focusedField === "kit" ? "▎Author Kit:" : " Author Kit:"}
          </text>
          <box flexDirection="row" gap={1} height={1}>
            {renderTogglePill(authoringKit, focusedField === "kit", ".opencode skill + CI", () => {
              onFocusField("kit")
              onSelectAuthoringKit(true)
            })}
            {renderTogglePill(!authoringKit, focusedField === "kit", "Skip", () => {
              onFocusField("kit")
              onSelectAuthoringKit(false)
            })}
          </box>
        </box>
      </box>

      <box borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} flexDirection="row" justifyContent="space-between" height={2}>
        <text wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
          {middleEllipsis("[TAB/↑/↓] Field · [SPACE/◀/▶] Toggle", Math.max(16, innerWidth - 36))}
        </text>
        <box flexDirection="row" gap={1}>
          <text
            height={1}
            wrapMode="none"
            backgroundColor={THEME.bgSuccessSoft}
            style={{ textColor: THEME.accentGreen }}
            b
            onMouseDown={() => onSubmit()}
          >
            {primaryLabel}
          </text>
          <text height={1} wrapMode="none" style={{ textColor: THEME.accentRed }} b onMouseDown={() => onCancel()}>
            {" [ESC] Later "}
          </text>
        </box>
      </box>
    </box>
  )
}
