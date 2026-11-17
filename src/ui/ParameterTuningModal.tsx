import React from "react"
import type { AgentTuningMode, TuningField, TuningInitialState } from "../utils/agents.js"
import { AGENT_TUNING_MODES } from "../utils/agents.js"
import { displayWidth, middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { gaugeBar, THEME } from "../utils/uiTheme.js"

export interface PillOption<T extends string> {
  value: T
  label: string
}

/**
 * Deterministic balanced row wrapper for pill strips so OpenTUI box heights stay exact,
 * never leave a lone orphaned pill on the final line (across 2, 3, or N rows), and never
 * jitter when the active `● ` indicator moves between short and long labels.
 */
export function chunkPillsByWidth<T extends string>(
  options: readonly PillOption<T>[],
  maxWidth: number,
): PillOption<T>[][] {
  if (options.length === 0) return [[]]
  // Reserve 2 cells for the active `● ` marker so cycling selection never shifts line breaks.
  const safeMax = Math.max(10, Math.floor(maxWidth) - 2)
  const measureRow = (slice: readonly PillOption<T>[]) =>
    slice.reduce((sum, opt, idx) => sum + displayWidth(opt.label) + 2 + (idx > 0 ? 1 : 0), 0)

  if (measureRow(options) <= safeMax) return [[...options]]

  // Try balanced k-row partitions (2..N) so rows distribute items evenly without trailing orphans.
  for (let rowCount = 2; rowCount <= options.length; rowCount++) {
    const baseSize = Math.floor(options.length / rowCount)
    const remainder = options.length % rowCount
    const candidate: PillOption<T>[][] = []
    let cursor = 0
    let fits = true
    for (let r = 0; r < rowCount; r++) {
      const len = baseSize + (r < remainder ? 1 : 0)
      const slice = options.slice(cursor, cursor + len)
      if (measureRow(slice) > safeMax) {
        fits = false
        break
      }
      candidate.push(slice)
      cursor += len
    }
    if (fits) return candidate
  }

  // Fallback when an individual pill exceeds safeMax.
  const rows: PillOption<T>[][] = []
  let current: PillOption<T>[] = []
  let currentWidth = 0
  for (const option of options) {
    const pillWidth = displayWidth(option.label) + 2
    const gap = current.length > 0 ? 1 : 0
    if (current.length > 0 && currentWidth + gap + pillWidth > safeMax) {
      rows.push(current)
      current = [option]
      currentWidth = pillWidth
    } else {
      current.push(option)
      currentWidth += gap + pillWidth
    }
  }
  if (current.length > 0) rows.push(current)
  return rows
}

export interface ParameterTuningModalProps {
  targetCount: number
  singleTargetName?: string
  focusedField: TuningField
  dirtyFields: ReadonlySet<TuningField>
  summary: TuningInitialState
  steps: string
  variant: string
  mode: AgentTuningMode
  hidden: boolean
  variantChoices: readonly string[]
  hasModelSpecificVariants: boolean
  termWidth: number
  termHeight: number
  onFocusField: (field: TuningField) => void
  onStepDelta: (delta: number) => void
  onSelectVariant: (variant: string) => void
  onSelectMode: (mode: AgentTuningMode) => void
  onSelectHidden: (hidden: boolean) => void
  onSave: () => void
  onClose: () => void
}

export function ParameterTuningModal({
  targetCount,
  singleTargetName,
  focusedField,
  dirtyFields,
  summary,
  steps,
  variant,
  mode,
  hidden,
  variantChoices,
  hasModelSpecificVariants,
  termWidth,
  termHeight,
  onFocusField,
  onStepDelta,
  onSelectVariant,
  onSelectMode,
  onSelectHidden,
  onSave,
  onClose,
}: ParameterTuningModalProps) {
  const maxAllowedWidth = Math.max(20, termWidth - 2)
  const modalWidth = Math.min(maxAllowedWidth, Math.max(48, Math.min(86, termWidth - 4)))
  const innerWidth = Math.max(16, modalWidth - 4) // minus modal border(2) + left/right padding(2)

  // Switch to borderless compact rows on short terminals (e.g. 80x18..20) so no field or footer clips.
  const preliminarCardInner = Math.max(12, innerWidth - 4)
  const pillOptions: PillOption<string>[] = variantChoices.map(choice => ({
    value: choice,
    label: choice === "" ? "default" : terminalSafeText(choice),
  }))
  const boxedPillRows = chunkPillsByWidth(pillOptions, preliminarCardInner)
  const fullBoxedHeight = 4 + 1 + 3 + (3 + boxedPillRows.length) + 3 + 3 + 2
  const compactCards = termHeight < fullBoxedHeight
  const cardInnerWidth = compactCards ? Math.max(12, innerWidth - 2) : preliminarCardInner
  const variantPillRows = compactCards ? chunkPillsByWidth(pillOptions, cardInnerWidth) : boxedPillRows

  const singleRowHeight = compactCards ? 1 : 3
  const variantCardHeight = (compactCards ? 1 : 3) + variantPillRows.length
  const vPad = compactCards ? 0 : 1
  const outerChrome = 2 + vPad * 2

  const spaciousHeight = outerChrome + 1 + singleRowHeight * 3 + variantCardHeight + 2 + 5
  const useGap = !compactCards && termHeight >= spaciousHeight
  const gapRows = useGap ? 1 : 0
  const contentHeight = outerChrome + 1 + singleRowHeight * 3 + variantCardHeight + 2 + gapRows * 5
  const modalHeight = Math.min(termHeight, contentHeight)
  const left = Math.max(0, Math.floor((termWidth - modalWidth) / 2))
  const top = Math.max(0, Math.floor((termHeight - modalHeight) / 2))

  const stepsUntouchedMixed = !dirtyFields.has("steps") && summary.steps.mixed
  const variantUntouchedMixed = !dirtyFields.has("variant") && summary.variant.mixed
  const modeUntouchedMixed = !dirtyFields.has("mode") && summary.mode.mixed
  const hiddenUntouchedMixed = !dirtyFields.has("hidden") && summary.hidden.mixed

  const parsedSteps = Number.parseInt(steps, 10)
  const validStepsRatio = Number.isFinite(parsedSteps) && parsedSteps > 0 ? Math.min(1, parsedSteps / 100) : 0
  const showStepsGauge = cardInnerWidth >= 56 && !stepsUntouchedMixed
  const showStepButtons = cardInnerWidth >= 34

  const safeVariant = terminalSafeText(variant)
  const isTypingPartialVariant =
    !variantUntouchedMixed && safeVariant !== "" && !variantChoices.includes(variant)

  const targetSummary =
    targetCount === 1 && singleTargetName
      ? `Agent: ${terminalSafeText(singleTargetName.replace(/\.md$/, ""))}`
      : `Batch: ${targetCount} agents selected`
  const dirtyBadge =
    dirtyFields.size > 0
      ? `● ${dirtyFields.size} modified`
      : targetCount > 1 && innerWidth >= 48
        ? "unchanged fields stay as-is"
        : "unchanged"

  const showSaveButton = innerWidth >= 44
  const footerActionsLabel = showSaveButton ? "[ENTER] Save  [ESC] Cancel" : "[ESC] Cancel"
  const footerActionsWidth = displayWidth(footerActionsLabel)
  const footerLeftBudget = Math.max(8, innerWidth - footerActionsWidth - 2)
  const footerHint = (() => {
    if (focusedField === "steps") {
      return footerLeftBudget >= 36
        ? "Tab Field · ←/→ ±1 · 0–9 Type"
        : middleEllipsis("Tab · ←/→ ±1 · 0–9", footerLeftBudget)
    }
    if (focusedField === "variant") {
      if (footerLeftBudget >= 46) return "Tab Field · ←/→/Space Pick · Type · Del Reset"
      if (footerLeftBudget >= 34) return "Tab · ←/→/Space Pick · Type · Del"
      return middleEllipsis("Tab · ←/→/Space · Del", footerLeftBudget)
    }
    return footerLeftBudget >= 32
      ? "Tab Field · ←/→/Space Pick"
      : middleEllipsis("Tab · ←/→/Space", footerLeftBudget)
  })()

  const cardSurfaceProps = (focused: boolean) =>
    compactCards
      ? {
          border: false,
          backgroundColor: focused ? THEME.bgRowFocus : THEME.bgInput,
          paddingLeft: 1,
          paddingRight: 1,
        }
      : {
          border: true,
          borderStyle: "rounded" as const,
          borderColor: focused ? THEME.accentAmber : THEME.borderSubtle,
          backgroundColor: THEME.bgInput,
          paddingLeft: 1,
          paddingRight: 1,
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
        borderColor={THEME.borderWarn}
        backgroundColor={THEME.bgElevated}
        title={` Tune Agent Parameters (${targetCount} agent${targetCount === 1 ? "" : "s"}) `}
        titleColor={THEME.accentAmber}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={vPad}
        paddingBottom={vPad}
        flexDirection="column"
        justifyContent="space-between"
        overflow="hidden"
        onMouseDown={(_self, event) => event.stopPropagation()}
      >
        <box flexDirection="column" gap={gapRows} overflow="hidden" flexShrink={0}>
          {/* Target & dirty-state header */}
          <box height={1} flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }} b>
              {middleEllipsis(targetSummary, Math.max(10, innerWidth - displayWidth(dirtyBadge) - 2))}
            </text>
            <text
              height={1}
              wrapMode="none"
              flexShrink={0}
              style={{ textColor: dirtyFields.size > 0 ? THEME.accentAmber : THEME.fgMuted }}
              b={dirtyFields.size > 0}
            >
              {dirtyBadge}
            </text>
          </box>

          {/* 1. Max Steps — stepper + gauge + live numeric input */}
          <box
            flexDirection="row"
            justifyContent="space-between"
            height={singleRowHeight}
            flexShrink={0}
            {...cardSurfaceProps(focusedField === "steps")}
            onMouseDown={() => onFocusField("steps")}
          >
            <box flexDirection="row" height={1} overflow="hidden" flexShrink={1}>
              <text
                height={1}
                wrapMode="none"
                style={{ textColor: focusedField === "steps" ? THEME.accentAmber : THEME.fgSecondary }}
                b
              >
                {focusedField === "steps" ? "▎ Max Steps" : "  Max Steps"}
              </text>
              {cardInnerWidth >= 48 && (
                <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                  {"  max tool turns"}
                </text>
              )}
            </box>

            <box flexDirection="row" height={1} gap={1} flexShrink={0}>
              {showStepsGauge && (
                <text height={1} wrapMode="none" style={{ textColor: THEME.accentBlue }}>
                  {gaugeBar(validStepsRatio, 10)}
                </text>
              )}
              {showStepButtons && (
                <text
                  height={1}
                  wrapMode="none"
                  backgroundColor={THEME.bgPill}
                  style={{ textColor: THEME.fgSecondary }}
                  onMouseDown={(_self, event) => {
                    event.stopPropagation()
                    onFocusField("steps")
                    onStepDelta(-5)
                  }}
                >
                  {" −5 "}
                </text>
              )}
              <text
                height={1}
                wrapMode="none"
                backgroundColor={focusedField === "steps" ? THEME.bgPillActive : THEME.bgPill}
                style={{
                  textColor: stepsUntouchedMixed
                    ? THEME.fgMuted
                    : steps.trim() === ""
                      ? THEME.accentRed
                      : "#ffffff",
                }}
                b={!stepsUntouchedMixed}
              >
                {stepsUntouchedMixed
                  ? ` mixed (${summary.steps.distinctValues.join(", ")}) `
                  : ` ${steps || "—"}${focusedField === "steps" ? "▋" : ""} `}
              </text>
              {showStepButtons && (
                <text
                  height={1}
                  wrapMode="none"
                  backgroundColor={THEME.bgPill}
                  style={{ textColor: THEME.fgSecondary }}
                  onMouseDown={(_self, event) => {
                    event.stopPropagation()
                    onFocusField("steps")
                    onStepDelta(5)
                  }}
                >
                  {" +5 "}
                </text>
              )}
            </box>
          </box>

          {/* 2. Thinking / Effort — clean header + interactive segmented pill grid */}
          <box
            flexDirection="column"
            height={variantCardHeight}
            flexShrink={0}
            {...cardSurfaceProps(focusedField === "variant")}
            onMouseDown={() => onFocusField("variant")}
          >
            <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
              <box flexDirection="row" height={1} overflow="hidden" flexShrink={1}>
                <text
                  height={1}
                  wrapMode="none"
                  style={{ textColor: focusedField === "variant" ? THEME.accentAmber : THEME.fgSecondary }}
                  b
                >
                  {focusedField === "variant" ? "▎ Thinking / Effort" : "  Thinking / Effort"}
                </text>
                {cardInnerWidth >= 52 && (
                  <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                    {hasModelSpecificVariants ? "  model presets" : "  #variant"}
                  </text>
                )}
              </box>

              <text
                height={1}
                wrapMode="none"
                flexShrink={0}
                style={{
                  textColor: variantUntouchedMixed
                    ? THEME.fgMuted
                    : safeVariant
                      ? THEME.accentCyan
                      : THEME.fgMuted,
                }}
                b={Boolean(safeVariant) && !variantUntouchedMixed}
              >
                {variantUntouchedMixed
                  ? `mixed (${summary.variant.distinctValues.map(v => terminalSafeText(v) || "default").join(", ")})`
                  : safeVariant
                    ? `#${safeVariant}${focusedField === "variant" ? "▋" : ""}`
                    : `default${focusedField === "variant" ? "▋" : ""}`}
              </text>
            </box>

            {variantPillRows.map((row, rowIdx) => (
              <box key={`vrow-${rowIdx}`} flexDirection="row" gap={1} height={1} flexShrink={0}>
                {row.map(opt => {
                  const isSelected = !variantUntouchedMixed && variant === opt.value
                  const isPrefixMatch =
                    isTypingPartialVariant && opt.value !== "" && opt.value.startsWith(variant)
                  const bg = isSelected
                    ? focusedField === "variant"
                      ? THEME.accentCyan
                      : THEME.bgPillActive
                    : isPrefixMatch
                      ? THEME.bgRowFocus
                      : THEME.bgPill
                  const fg = isSelected
                    ? focusedField === "variant"
                      ? THEME.bgBase
                      : "#ffffff"
                    : isPrefixMatch
                      ? THEME.accentCyan
                      : isTypingPartialVariant
                        ? THEME.fgMuted
                        : THEME.fgSecondary
                  return (
                    <text
                      key={`vpill-${opt.value || "default"}`}
                      height={1}
                      wrapMode="none"
                      backgroundColor={bg}
                      style={{ textColor: fg }}
                      b={isSelected || isPrefixMatch}
                      onMouseDown={(_self, event) => {
                        event.stopPropagation()
                        onFocusField("variant")
                        onSelectVariant(opt.value)
                      }}
                    >
                      {` ${isSelected ? "● " : ""}${opt.label} `}
                    </text>
                  )
                })}
              </box>
            ))}
          </box>

          {/* 3. Execution Mode — single-row segmented pill selector */}
          <box
            flexDirection="row"
            justifyContent="space-between"
            height={singleRowHeight}
            flexShrink={0}
            {...cardSurfaceProps(focusedField === "mode")}
            onMouseDown={() => onFocusField("mode")}
          >
            <box flexDirection="row" height={1} overflow="hidden" flexShrink={1}>
              <text
                height={1}
                wrapMode="none"
                style={{ textColor: focusedField === "mode" ? THEME.accentAmber : THEME.fgSecondary }}
                b
              >
                {focusedField === "mode" ? "▎ Execution Mode" : "  Execution Mode"}
              </text>
              {modeUntouchedMixed && (
                <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                  {"  mixed"}
                </text>
              )}
            </box>

            <box flexDirection="row" gap={1} height={1} flexShrink={0}>
              {AGENT_TUNING_MODES.map(m => {
                const isSelected = !modeUntouchedMixed && mode === m
                const bg = isSelected
                  ? focusedField === "mode"
                    ? THEME.accentAmber
                    : THEME.bgPillActive
                  : THEME.bgPill
                const fg = isSelected
                  ? focusedField === "mode"
                    ? THEME.bgBase
                    : "#ffffff"
                  : THEME.fgSecondary
                return (
                  <text
                    key={`mpill-${m}`}
                    height={1}
                    wrapMode="none"
                    backgroundColor={bg}
                    style={{ textColor: fg }}
                    b={isSelected}
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      onFocusField("mode")
                      onSelectMode(m)
                    }}
                  >
                    {` ${isSelected ? "● " : ""}${m} `}
                  </text>
                )
              })}
            </box>
          </box>

          {/* 4. Visibility — positive Visible / Hidden segmented pills */}
          <box
            flexDirection="row"
            justifyContent="space-between"
            height={singleRowHeight}
            flexShrink={0}
            {...cardSurfaceProps(focusedField === "hidden")}
            onMouseDown={() => onFocusField("hidden")}
          >
            <box flexDirection="row" height={1} overflow="hidden" flexShrink={1}>
              <text
                height={1}
                wrapMode="none"
                style={{ textColor: focusedField === "hidden" ? THEME.accentAmber : THEME.fgSecondary }}
                b
              >
                {focusedField === "hidden" ? "▎ Visibility" : "  Visibility"}
              </text>
              {hiddenUntouchedMixed && (
                <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                  {"  mixed"}
                </text>
              )}
            </box>

            <box flexDirection="row" gap={1} height={1} flexShrink={0}>
              {([
                { value: false, label: "Visible" },
                { value: true, label: "Hidden" },
              ] as const).map(item => {
                const isSelected = !hiddenUntouchedMixed && hidden === item.value
                const activeBg = item.value
                  ? focusedField === "hidden"
                    ? THEME.accentRed
                    : THEME.bgDangerSoft
                  : focusedField === "hidden"
                    ? THEME.accentGreen
                    : THEME.bgSuccessSoft
                const activeFg =
                  focusedField === "hidden"
                    ? THEME.bgBase
                    : item.value
                      ? THEME.accentRed
                      : THEME.accentGreen
                return (
                  <text
                    key={`hpill-${String(item.value)}`}
                    height={1}
                    wrapMode="none"
                    backgroundColor={isSelected ? activeBg : THEME.bgPill}
                    style={{ textColor: isSelected ? activeFg : THEME.fgSecondary }}
                    b={isSelected}
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      onFocusField("hidden")
                      onSelectHidden(item.value)
                    }}
                  >
                    {` ${isSelected ? "● " : ""}${item.label} `}
                  </text>
                )
              })}
            </box>
          </box>
        </box>

        {/* Contextual Footer */}
        <box
          height={2}
          flexShrink={0}
          justifyContent="space-between"
          borderStyle="single"
          border={["top"]}
          borderColor={THEME.borderSubtle}
          overflow="hidden"
          flexDirection="row"
        >
          <text flexShrink={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
            {footerHint}
          </text>
          <box flexDirection="row" gap={2} flexShrink={0}>
            {showSaveButton && (
              <text wrapMode="none" style={{ textColor: THEME.accentGreen }} b onMouseDown={() => onSave()}>
                [ENTER] Save
              </text>
            )}
            <text wrapMode="none" style={{ textColor: THEME.accentRed }} b onMouseDown={() => onClose()}>
              [ESC] Cancel
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}
