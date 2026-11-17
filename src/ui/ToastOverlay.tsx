import React from "react"
import { middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { classifyToastTone, fractionalBar, THEME, toastAppearance } from "../utils/uiTheme.js"
import { useToastCountdown } from "./animations.js"

export interface ToastOverlayProps {
  message: string | null
  toastId: number
  termWidth: number
  reducedMotion: boolean
  onDismiss: () => void
}

export function ToastOverlay({ message, toastId, termWidth, reducedMotion, onDismiss }: ToastOverlayProps) {
  const tone = message ? classifyToastTone(message) : "info"
  const durationMs = tone === "error" ? 5500 : tone === "warning" ? 4500 : 3200
  const remaining = useToastCountdown(toastId, Boolean(message), durationMs, reducedMotion, onDismiss)

  if (!message || termWidth < 48) return null

  const appearance = toastAppearance(tone)
  const cleanMessage = terminalSafeText(message).replace(/^[✓✅✗❌⚠]\s*/, "")
  const boxWidth = Math.min(Math.max(32, Math.floor(termWidth * 0.44)), Math.max(32, termWidth - 6))
  const innerWidth = Math.max(10, boxWidth - 4)
  const barWidth = Math.max(8, innerWidth - 12)

  return (
    <box
      position="absolute"
      right={2}
      top={4}
      width={boxWidth}
      height={4}
      zIndex={60}
      border={true}
      borderStyle="rounded"
      borderColor={appearance.border}
      backgroundColor={appearance.bg}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      overflow="hidden"
      onMouseDown={() => onDismiss()}
    >
      <box width="100%" height={1} flexDirection="row" justifyContent="space-between" overflow="hidden">
        <text wrapMode="none" overflow="hidden" style={{ textColor: appearance.fg }} b>
          {middleEllipsis(`${appearance.icon} ${cleanMessage}`, innerWidth)}
        </text>
      </box>
      <box width="100%" height={1} flexDirection="row" justifyContent="space-between" overflow="hidden">
        <text wrapMode="none" overflow="hidden" style={{ textColor: appearance.border }}>
          {fractionalBar(remaining, barWidth, "─")}
        </text>
        <text wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
          {" click ×"}
        </text>
      </box>
    </box>
  )
}
