import { terminalSafeText } from "./terminalText.js"

export const THEME = {
  bgBase: "#0f1117",
  bgBaseDimmed: "#080a0e",
  bgPanel: "#161922",
  bgPanelDimmed: "#10131a",
  bgElevated: "#1c202c",
  bgInput: "#12151d",
  bgRowHover: "#1b2130",
  bgRowFocus: "#1f324a",
  bgRowSelected: "#172b24",
  bgRowFlash: "#1e4631",
  bgPill: "#232a3b",
  bgPillActive: "#2b4263",
  bgDangerSoft: "#3a181c",
  bgWarnSoft: "#362a14",
  bgSuccessSoft: "#163323",
  borderSubtle: "#252b38",
  borderIdle: "#2d3546",
  borderFocus: "#58a6ff",
  borderInspectorFocus: "#a371f7",
  borderModal: "#79c0ff",
  borderSuccess: "#3fb950",
  borderWarn: "#d29922",
  borderDanger: "#f85149",
  fgPrimary: "#e6edf3",
  fgSecondary: "#9aa4b2",
  fgMuted: "#636e7b",
  accentBlue: "#58a6ff",
  accentCyan: "#39c5cf",
  accentPurple: "#bc8cff",
  accentGreen: "#3fb950",
  accentAmber: "#e3b341",
  accentRed: "#ff7b72",
  accentPink: "#f778ba",
} as const

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

const EIGHTH_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const

export type ToastTone = "success" | "warning" | "error" | "info"

function parseHexChannelPair(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16)
  return Number.isFinite(value) ? value : 0
}

const SAFE_HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** Strictly validate a CSS hex color so untrusted frontmatter can never inject escapes. */
export function sanitizeHexColor(value: unknown, fallback: string = THEME.accentBlue): string {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  return SAFE_HEX_COLOR_RE.test(trimmed) ? trimmed : fallback
}

export function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "")
  if (clean.length === 3) {
    const r = Number.parseInt(clean[0] + clean[0], 16)
    const g = Number.parseInt(clean[1] + clean[1], 16)
    const b = Number.parseInt(clean[2] + clean[2], 16)
    return [Number.isFinite(r) ? r : 0, Number.isFinite(g) ? g : 0, Number.isFinite(b) ? b : 0]
  }
  if (clean.length >= 6) {
    return [
      parseHexChannelPair(clean, 0),
      parseHexChannelPair(clean, 2),
      parseHexChannelPair(clean, 4),
    ]
  }
  return [0, 0, 0]
}

export function lerpColor(fromHex: string, toHex: string, ratio: number): string {
  const t = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  if (t <= 0) return fromHex
  if (t >= 1) return toHex
  const [r1, g1, b1] = parseHexRgb(fromHex)
  const [r2, g2, b2] = parseHexRgb(toHex)
  const r = Math.round(r1 + (r2 - r1) * t)
  const g = Math.round(g1 + (g2 - g1) * t)
  const b = Math.round(b1 + (b2 - b1) * t)
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}

/** High-resolution horizontal progress bar using Unicode eighth-blocks. */
export function fractionalBar(ratio: number, width: number, trackChar = "░"): string {
  const cells = Math.max(0, Math.floor(width))
  if (cells === 0) return ""
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const totalEighths = Math.round(clamped * cells * 8)
  const fullCells = Math.floor(totalEighths / 8)
  const remainder = totalEighths % 8
  const partial = fullCells < cells && remainder > 0 ? EIGHTH_BLOCKS[remainder] : ""
  const emptyCount = Math.max(0, cells - fullCells - (partial ? 1 : 0))
  return `${"█".repeat(fullCells)}${partial}${trackChar.repeat(emptyCount)}`
}

/** Sleek knob gauge (`━━━●────`) for bounded numeric settings like temperature and steps. */
export function gaugeBar(ratio: number, width: number): string {
  const cells = Math.max(3, Math.floor(width))
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const knobIndex = Math.min(cells - 1, Math.max(0, Math.round(clamped * (cells - 1))))
  return `${"━".repeat(knobIndex)}●${"─".repeat(Math.max(0, cells - 1 - knobIndex))}`
}

export function classifyToastTone(message: string): ToastTone {
  const clean = message.trim()
  if (/^(✗|❌|error\b|failed\b)/i.test(clean) || /\bfailed\b|\berror:/i.test(clean)) return "error"
  if (/^(⚠|warning\b)/i.test(clean) || /\bread-only\b|\bno invalid\b|\bcancelled\b|\bblocked\b/i.test(clean)) return "warning"
  if (/^(✓|✅|updated\b|applied\b|saved\b|repaired\b|renamed\b|installed\b|reconciled\b|pulled\b|initialized\b|exported\b|switched\b)/i.test(clean)) return "success"
  return "info"
}

export function toastAppearance(tone: ToastTone): { icon: string; border: string; fg: string; bg: string } {
  switch (tone) {
    case "error":
      return { icon: "✗", border: THEME.borderDanger, fg: THEME.accentRed, bg: THEME.bgDangerSoft }
    case "warning":
      return { icon: "⚠", border: THEME.borderWarn, fg: THEME.accentAmber, bg: THEME.bgWarnSoft }
    case "success":
      return { icon: "✓", border: THEME.borderSuccess, fg: THEME.accentGreen, bg: THEME.bgSuccessSoft }
    default:
      return { icon: "●", border: THEME.borderFocus, fg: THEME.accentBlue, bg: THEME.bgElevated }
  }
}

/** Build a compact unified diff suitable for OpenTUI's `<diff>` component. */
export function buildPreviewUnifiedDiff(fileLabel: string, beforeLines: string[], afterLines: string[]): string {
  const safeLabel = terminalSafeText(fileLabel || "preview").replace(/\s+/g, "_")
  const removed = beforeLines.map(line => `-${terminalSafeText(line)}`)
  const added = afterLines.map(line => `+${terminalSafeText(line)}`)
  const beforeCount = Math.max(1, removed.length)
  const afterCount = Math.max(1, added.length)
  return [
    `--- a/${safeLabel}`,
    `+++ b/${safeLabel}`,
    `@@ -1,${beforeCount} +1,${afterCount} @@`,
    ...(removed.length ? removed : ["-"]),
    ...(added.length ? added : ["+"]),
  ].join("\n")
}

/** Sanitize untrusted multi-line markdown while preserving line breaks and indentation. */
export function terminalSafeMarkdown(raw: string, maxLines = 400): string {
  const lines = String(raw ?? "").replace(/\t/g, "  ").split(/\r?\n/)
  const sliced = lines.slice(0, maxLines).map(line => terminalSafeText(line))
  if (lines.length > maxLines) {
    sliced.push("", `*(… ${lines.length - maxLines} more lines truncated for preview)*`)
  }
  return sliced.join("\n")
}
