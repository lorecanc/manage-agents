import React from "react"
import type {
  PackDoctorReport,
  ScaffoldResourceKind,
  SemverReleaseKind,
} from "../utils/packOnboarding.js"
import { middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { THEME } from "../utils/uiTheme.js"

export type PackDoctorTab = "doctor" | "scaffold"
export type ScaffoldField = "kind" | "id" | "desc" | "mode"

export interface PackDoctorModalProps {
  tab: PackDoctorTab
  report: PackDoctorReport | null
  scrollOffset: number
  statusMessage: string | null
  scaffoldField: ScaffoldField
  scaffoldKind: ScaffoldResourceKind
  scaffoldId: string
  scaffoldDesc: string
  scaffoldMode: "primary" | "subagent" | "all"
  termWidth: number
  termHeight: number
  onSwitchTab: (tab: PackDoctorTab) => void
  onScrollDelta: (delta: number) => void
  onAutoFix: () => void
  onInstallKit: () => void
  onBumpVersion: (release: SemverReleaseKind) => void
  onFocusScaffoldField: (field: ScaffoldField) => void
  onSelectScaffoldKind: (kind: ScaffoldResourceKind) => void
  onSelectScaffoldMode: (mode: "primary" | "subagent" | "all") => void
  onSubmitScaffold: () => void
  onClose: () => void
}

export function getScaffoldFieldOrder(kind: ScaffoldResourceKind): ScaffoldField[] {
  return kind === "agent" ? ["kind", "id", "desc", "mode"] : ["kind", "id", "desc"]
}

export function getDoctorModalHeight(termHeight: number): number {
  return Math.min(Math.max(14, termHeight - 2), Math.max(16, Math.min(26, termHeight - 4)))
}

export function getDoctorMaxFindingRows(termHeight: number): number {
  return Math.max(2, getDoctorModalHeight(termHeight) - 11)
}

export function PackDoctorModal({
  tab,
  report,
  scrollOffset,
  statusMessage,
  scaffoldField,
  scaffoldKind,
  scaffoldId,
  scaffoldDesc,
  scaffoldMode,
  termWidth,
  termHeight,
  onSwitchTab,
  onScrollDelta,
  onAutoFix,
  onInstallKit,
  onBumpVersion,
  onFocusScaffoldField,
  onSelectScaffoldKind,
  onSelectScaffoldMode,
  onSubmitScaffold,
  onClose,
}: PackDoctorModalProps) {
  const modalWidth = Math.min(Math.max(24, termWidth - 2), Math.max(56, Math.min(96, termWidth - 6)))
  const modalHeight = getDoctorModalHeight(termHeight)
  const innerWidth = Math.max(20, modalWidth - 4)
  const left = Math.max(0, Math.floor((termWidth - modalWidth) / 2))
  const top = Math.max(0, Math.floor((termHeight - modalHeight) / 2))

  const manifest = report?.manifest
  const titleText = manifest
    ? ` Pack Doctor & Authoring · ${terminalSafeText(manifest.name)}@${terminalSafeText(manifest.version)} `
    : " Pack Doctor & Authoring "

  const maxFindingRows = getDoctorMaxFindingRows(termHeight)
  const findings = report?.findings ?? []
  const visibleFindings = findings.slice(scrollOffset, scrollOffset + maxFindingRows)

  const previewPath =
    scaffoldKind === "agent"
      ? `agents/${scaffoldId.trim() || "<id>"}.md`
      : scaffoldKind === "skill"
        ? `skills/${scaffoldId.trim() || "<id>"}/SKILL.md`
        : `commands/${scaffoldId.trim() || "<id>"}.md`

  const labelColWidth = Math.min(18, Math.max(13, Math.floor(innerWidth * 0.24)))
  const valueMaxWidth = Math.max(12, innerWidth - labelColWidth - 3)

  const renderPill = (active: boolean, focused: boolean, label: string, onClick: () => void) => (
    <text
      height={1}
      wrapMode="none"
      backgroundColor={active ? (focused ? THEME.accentCyan : THEME.bgPillActive) : THEME.bgPill}
      style={{ textColor: active ? (focused ? THEME.bgBase : "#ffffff") : THEME.fgSecondary }}
      b={active}
      onMouseDown={(_self, event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {` ${active ? "● " : ""}${label} `}
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
      borderColor={tab === "doctor" ? THEME.accentCyan : THEME.accentGreen}
      backgroundColor={THEME.bgElevated}
      title={titleText}
      titleColor={tab === "doctor" ? THEME.accentCyan : THEME.accentGreen}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={0}
      flexDirection="column"
      justifyContent="space-between"
      overflow="hidden"
      onMouseScroll={(_self, event) => {
        if (tab !== "doctor") return
        const dir = (event as any).scroll?.direction
        if (dir === "down") onScrollDelta(1)
        else if (dir === "up") onScrollDelta(-1)
      }}
    >
      <box flexDirection="column" overflow="hidden">
        <box flexDirection="row" justifyContent="space-between" height={1}>
          <box flexDirection="row" gap={1}>
            <text
              height={1}
              wrapMode="none"
              backgroundColor={tab === "doctor" ? THEME.accentCyan : THEME.bgPill}
              style={{ textColor: tab === "doctor" ? THEME.bgBase : THEME.fgSecondary }}
              b={tab === "doctor"}
              onMouseDown={() => onSwitchTab("doctor")}
            >
              {" [D] Contract Doctor "}
            </text>
            <text
              height={1}
              wrapMode="none"
              backgroundColor={tab === "scaffold" ? THEME.accentGreen : THEME.bgPill}
              style={{ textColor: tab === "scaffold" ? THEME.bgBase : THEME.fgSecondary }}
              b={tab === "scaffold"}
              onMouseDown={() => onSwitchTab("scaffold")}
            >
              {" [N] New Agent / Skill / Cmd "}
            </text>
          </box>
          {manifest && (
            <box flexDirection="row" gap={1}>
              <text height={1} wrapMode="none" backgroundColor={THEME.bgPill} style={{ textColor: THEME.accentAmber }} onMouseDown={() => onBumpVersion("patch")}>
                {" [1] +patch "}
              </text>
              <text height={1} wrapMode="none" backgroundColor={THEME.bgPill} style={{ textColor: THEME.accentAmber }} onMouseDown={() => onBumpVersion("minor")}>
                {" [2] +minor "}
              </text>
              <text height={1} wrapMode="none" backgroundColor={THEME.bgPill} style={{ textColor: THEME.accentAmber }} onMouseDown={() => onBumpVersion("major")}>
                {" [3] +major "}
              </text>
            </box>
          )}
        </box>

        {statusMessage && (
          <text wrapMode="none" marginTop={1} style={{ textColor: THEME.accentGreen }} b>
            {middleEllipsis(`✓ ${terminalSafeText(statusMessage)}`, innerWidth)}
          </text>
        )}

        {tab === "doctor" ? (
          <box flexDirection="column" marginTop={1} overflow="hidden">
            {report && (
              <text wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
                {middleEllipsis(
                  `Contract ${terminalSafeText(manifest?.contract ?? "?")} · ${report.validation.ids.agents.length} agents · ${report.validation.ids.skills.length} skills · ${report.validation.ids.commands.length} cmds · Kit: ${report.hasAuthoringSkill ? "✓ skill" : "○ skill"} / ${report.hasCiWorkflow ? "✓ CI" : "○ CI"}`,
                  innerWidth,
                )}
              </text>
            )}
            <box flexDirection="column" marginTop={1} overflow="hidden">
              {findings.length === 0 ? (
                <text wrapMode="none" style={{ textColor: THEME.accentGreen }} b>
                  ✓ Pack satisfies OpenCode Contract 1.1 with zero warnings or drift.
                </text>
              ) : (
                visibleFindings.map(item => {
                  const badge = item.level === "error" ? "✗" : item.level === "warning" ? "!" : "◆"
                  const color =
                    item.level === "error"
                      ? THEME.accentRed
                      : item.level === "warning"
                        ? THEME.accentAmber
                        : THEME.accentCyan
                  const fixTag = item.autoFixable ? " [auto-fix]" : ""
                  const loc = item.path ? ` ${terminalSafeText(item.path)}:` : ""
                  return (
                    <text key={item.id} wrapMode="none" style={{ textColor: color }}>
                      {middleEllipsis(`${badge} [${terminalSafeText(item.code)}]${loc} ${terminalSafeText(item.message)}${fixTag}`, innerWidth)}
                    </text>
                  )
                })
              )}
            </box>
          </box>
        ) : (
          <box flexDirection="column" marginTop={1} overflow="hidden">
            <text wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
              {middleEllipsis(`Target file: ${terminalSafeText(previewPath)} (OpenCode V2 compliant)`, innerWidth)}
            </text>

            <box
              flexDirection="row"
              marginTop={1}
              backgroundColor={scaffoldField === "kind" ? THEME.bgRowFocus : "transparent"}
              paddingLeft={1}
              onMouseDown={() => onFocusScaffoldField("kind")}
            >
              <text width={labelColWidth} wrapMode="none" style={{ textColor: scaffoldField === "kind" ? THEME.accentGreen : THEME.fgSecondary }} b={scaffoldField === "kind"}>
                {scaffoldField === "kind" ? "▎Resource:" : " Resource:"}
              </text>
              <box flexDirection="row" gap={1} height={1}>
                {(["agent", "skill", "command"] as const).map(k => (
                  <React.Fragment key={k}>
                    {renderPill(scaffoldKind === k, scaffoldField === "kind", k, () => {
                      onFocusScaffoldField("kind")
                      onSelectScaffoldKind(k)
                    })}
                  </React.Fragment>
                ))}
              </box>
            </box>

            <box
              flexDirection="row"
              marginTop={1}
              backgroundColor={scaffoldField === "id" ? THEME.bgRowFocus : "transparent"}
              paddingLeft={1}
              onMouseDown={() => onFocusScaffoldField("id")}
            >
              <text width={labelColWidth} wrapMode="none" style={{ textColor: scaffoldField === "id" ? THEME.accentGreen : THEME.accentAmber }} b={scaffoldField === "id"}>
                {scaffoldField === "id" ? "▎ID / Slug:" : " ID / Slug:"}
              </text>
              <text wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
                {middleEllipsis(`${terminalSafeText(scaffoldId)}${scaffoldField === "id" ? "▋" : ""}`, valueMaxWidth)}
              </text>
            </box>

            <box
              flexDirection="row"
              marginTop={1}
              backgroundColor={scaffoldField === "desc" ? THEME.bgRowFocus : "transparent"}
              paddingLeft={1}
              onMouseDown={() => onFocusScaffoldField("desc")}
            >
              <text width={labelColWidth} wrapMode="none" style={{ textColor: scaffoldField === "desc" ? THEME.accentGreen : THEME.accentAmber }} b={scaffoldField === "desc"}>
                {scaffoldField === "desc" ? "▎Description:" : " Description:"}
              </text>
              <text wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
                {middleEllipsis(`${terminalSafeText(scaffoldDesc)}${scaffoldField === "desc" ? "▋" : ""}`, valueMaxWidth)}
              </text>
            </box>

            {scaffoldKind === "agent" && (
              <box
                flexDirection="row"
                marginTop={1}
                backgroundColor={scaffoldField === "mode" ? THEME.bgRowFocus : "transparent"}
                paddingLeft={1}
                onMouseDown={() => onFocusScaffoldField("mode")}
              >
                <text width={labelColWidth} wrapMode="none" style={{ textColor: scaffoldField === "mode" ? THEME.accentGreen : THEME.fgSecondary }} b={scaffoldField === "mode"}>
                  {scaffoldField === "mode" ? "▎Agent Mode:" : " Agent Mode:"}
                </text>
                <box flexDirection="row" gap={1} height={1}>
                  {(["subagent", "primary", "all"] as const).map(m => (
                    <React.Fragment key={m}>
                      {renderPill(scaffoldMode === m, scaffoldField === "mode", m, () => {
                        onFocusScaffoldField("mode")
                        onSelectScaffoldMode(m)
                      })}
                    </React.Fragment>
                  ))}
                </box>
              </box>
            )}
          </box>
        )}
      </box>

      <box borderStyle="single" border={["top"]} borderColor={THEME.borderSubtle} flexDirection="row" justifyContent="space-between" height={2}>
        {tab === "doctor" ? (
          <>
            <box flexDirection="row" gap={1}>
              <text
                height={1}
                wrapMode="none"
                backgroundColor={(report?.autoFixableCount ?? 0) > 0 ? THEME.bgSuccessSoft : THEME.bgPill}
                style={{ textColor: (report?.autoFixableCount ?? 0) > 0 ? THEME.accentGreen : THEME.fgSecondary }}
                b={(report?.autoFixableCount ?? 0) > 0}
                onMouseDown={() => onAutoFix()}
              >
                {` [F] Auto-Fix (${report?.autoFixableCount ?? 0}) `}
              </text>
              <text
                height={1}
                wrapMode="none"
                backgroundColor={THEME.bgPill}
                style={{ textColor: THEME.accentCyan }}
                onMouseDown={() => onInstallKit()}
              >
                {" [A] Authoring Kit "}
              </text>
            </box>
            <text height={1} wrapMode="none" style={{ textColor: THEME.accentRed }} b onMouseDown={() => onClose()}>
              {" [ESC] Close "}
            </text>
          </>
        ) : (
          <>
            <text wrapMode="none" style={{ textColor: THEME.fgSecondary }}>
              {middleEllipsis("[TAB/↑/↓] Field · [◀/▶/SPACE] Cycle", Math.max(16, innerWidth - 34))}
            </text>
            <box flexDirection="row" gap={1}>
              <text
                height={1}
                wrapMode="none"
                backgroundColor={THEME.bgSuccessSoft}
                style={{ textColor: THEME.accentGreen }}
                b
                onMouseDown={() => onSubmitScaffold()}
              >
                {" [ENTER] Create "}
              </text>
              <text height={1} wrapMode="none" style={{ textColor: THEME.accentRed }} b onMouseDown={() => onClose()}>
                {" [ESC] Close "}
              </text>
            </box>
          </>
        )}
      </box>
    </box>
  )
}
