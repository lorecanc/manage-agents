import React from "react"
import type { PaletteCommand } from "../utils/commandPalette.js"
import { calculateModalViewport } from "../utils/layout.js"
import { displayWidth, middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { lerpColor, THEME } from "../utils/uiTheme.js"
import { useAnimatedNumber } from "./animations.js"

export interface CommandPaletteModalProps {
  query: string
  commands: PaletteCommand[]
  focusedIndex: number
  scrollOffset: number
  maxRows: number
  termWidth: number
  termHeight: number
  reducedMotion: boolean
  onFocusRow: (index: number) => void
  onExecute: (cmd: PaletteCommand) => void
  onScrollDelta: (delta: number) => void
  onClose: () => void
}

const CATEGORY_COLORS: Record<PaletteCommand["category"], string> = {
  "Workspace": THEME.accentCyan,
  "Agent": THEME.accentBlue,
  "Pack": THEME.accentAmber,
  "Target & Bridges": THEME.accentGreen,
  "View & Motion": THEME.accentPurple,
  "Jump to Agent": THEME.accentPink,
}

export function CommandPaletteModal({
  query,
  commands,
  focusedIndex,
  scrollOffset,
  maxRows,
  termWidth,
  termHeight,
  reducedMotion,
  onFocusRow,
  onExecute,
  onScrollDelta,
  onClose,
}: CommandPaletteModalProps) {
  const reveal = useAnimatedNumber(1, { duration: 140, ease: "outExpo", reducedMotion })
  const vp = calculateModalViewport("command-palette", termWidth, termHeight)
  const modalWidth = vp.modalWidth
  const targetHeight = vp.modalHeight
  const modalHeight = Math.max(10, Math.round(targetHeight * (0.85 + 0.15 * reveal)))
  const left = vp.left
  const top = Math.max(0, Math.floor((termHeight - modalHeight) / 3))
  const innerWidth = vp.innerWidth
  const effectiveMaxRows = Math.max(1, Math.min(maxRows, modalHeight - 8))
  const visible = commands.slice(scrollOffset, scrollOffset + effectiveMaxRows)
  const borderColor = lerpColor(THEME.borderIdle, THEME.borderFocus, reveal)

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
        borderColor={borderColor}
        backgroundColor={THEME.bgElevated}
        title=" ⌘ Command Palette "
        titleColor={THEME.accentBlue}
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
          <box
            width="100%"
            height={3}
            border={true}
            borderStyle="rounded"
            borderColor={THEME.accentBlue}
            backgroundColor={THEME.bgInput}
            paddingLeft={1}
            paddingRight={1}
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
          >
            <text wrapMode="none" overflow="hidden" style={{ textColor: query ? THEME.fgPrimary : THEME.fgSecondary }}>
              {middleEllipsis(`❯ ${query ? terminalSafeText(query) : "Type an action, pack, model or agent..."}▋`, Math.max(12, innerWidth - 14))}
            </text>
            <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
              {`${commands.length} match${commands.length === 1 ? "" : "es"}`}
            </text>
          </box>

          <box flexDirection="column" width="100%" marginTop={1} overflow="hidden">
            {visible.length === 0 ? (
              <text style={{ textColor: THEME.accentAmber }}>
                No matching command or agent. Press Backspace or Esc.
              </text>
            ) : (
              visible.map((cmd, idx) => {
                const absIndex = scrollOffset + idx
                const isFocused = absIndex === focusedIndex
                const shortcutText = cmd.shortcut ? `[${cmd.shortcut}]` : ""
                const catText = cmd.category === "Jump to Agent" ? "Agent ↗" : cmd.category
                const rightMeta = `${catText}${shortcutText ? `  ${shortcutText}` : ""}`
                const rightWidth = displayWidth(rightMeta)
                const labelBudget = Math.max(10, innerWidth - rightWidth - 3)
                const labelWithHint = cmd.hint ? `${cmd.label} · ${terminalSafeText(cmd.hint)}` : cmd.label

                return (
                  <box
                    key={cmd.id}
                    width="100%"
                    height={1}
                    flexDirection="row"
                    justifyContent="space-between"
                    backgroundColor={isFocused ? THEME.bgRowFocus : "transparent"}
                    onMouseOver={() => onFocusRow(absIndex)}
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      onFocusRow(absIndex)
                      onExecute(cmd)
                    }}
                  >
                    <text wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "#ffffff" : THEME.fgPrimary }} b={isFocused}>
                      {middleEllipsis(`${isFocused ? "▎ " : "  "}${terminalSafeText(labelWithHint)}`, labelBudget)}
                    </text>
                    <box flexDirection="row" flexShrink={0}>
                      <text wrapMode="none" style={{ textColor: CATEGORY_COLORS[cmd.category] ?? THEME.fgSecondary }}>
                        {catText}
                      </text>
                      {shortcutText ? (
                        <text wrapMode="none" style={{ textColor: isFocused ? THEME.accentCyan : THEME.fgMuted }} b={isFocused}>
                          {`  ${shortcutText}`}
                        </text>
                      ) : null}
                    </box>
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
            {middleEllipsis("↑/↓ Navigate · Enter Run · Click row to run", Math.max(16, innerWidth - 14))}
          </text>
          <text
            wrapMode="none"
            style={{ textColor: THEME.accentCyan }}
            onMouseDown={(_self, event) => {
              event.stopPropagation()
              onClose()
            }}
          >
            [Esc] Close
          </text>
        </box>
      </box>
    </box>
  )
}
