import React, { useMemo } from "react"
import { layoutMarkdownDocument, type InlineSpanStyle, type StyledSpan } from "../utils/markdownLayout.js"
import { fractionalBar, THEME } from "../utils/uiTheme.js"

export interface PromptMarkdownViewProps {
  markdown: string
  width: number
  maxRows: number
  scrollOffset: number
  onScrollDelta?: (delta: number) => void
  showFooter?: boolean
}

function spanVisualProps(style: InlineSpanStyle): { fg: string; bg?: string; b?: boolean; i?: boolean; u?: boolean } {
  switch (style) {
    case "heading1":
      return { fg: THEME.accentCyan, b: true }
    case "heading2":
      return { fg: THEME.accentBlue, b: true }
    case "heading3":
      return { fg: THEME.accentPurple, b: true }
    case "bold":
      return { fg: "#ffffff", b: true }
    case "italic":
      return { fg: THEME.accentPurple, i: true }
    case "code":
      return { fg: THEME.accentAmber, bg: THEME.bgPill }
    case "link":
      return { fg: THEME.accentBlue, u: true }
    case "marker":
      return { fg: THEME.accentCyan, b: true }
    case "quoteBar":
      return { fg: THEME.accentPurple, b: true }
    case "codeFrame":
      return { fg: THEME.borderIdle }
    case "muted":
      return { fg: THEME.fgSecondary }
    default:
      return { fg: THEME.fgPrimary }
  }
}

function renderSpan(span: StyledSpan, key: number) {
  const vis = spanVisualProps(span.style)
  if (vis.bg) {
    return (
      <box key={key} height={1} flexShrink={0} backgroundColor={vis.bg}>
        <text height={1} flexShrink={0} wrapMode="none" style={{ textColor: vis.fg }} b={vis.b} i={vis.i} u={vis.u}>
          {span.text}
        </text>
      </box>
    )
  }
  return (
    <text key={key} height={1} flexShrink={0} wrapMode="none" style={{ textColor: vis.fg }} b={vis.b} i={vis.i} u={vis.u}>
      {span.text}
    </text>
  )
}

export function PromptMarkdownView({
  markdown,
  width,
  maxRows,
  scrollOffset,
  onScrollDelta,
  showFooter = true,
}: PromptMarkdownViewProps) {
  const safeWidth = Math.max(16, width)
  const lines = useMemo(() => layoutMarkdownDocument(markdown, safeWidth), [markdown, safeWidth])
  const footerHeight = showFooter && lines.length > maxRows ? 1 : 0
  const bodyRows = Math.max(1, maxRows - footerHeight)
  const maxOffset = Math.max(0, lines.length - bodyRows)
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxOffset))
  const visible = lines.slice(clampedOffset, clampedOffset + bodyRows)

  return (
    <box
      width="100%"
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
      justifyContent="space-between"
      overflow="hidden"
      onMouseScroll={(_self, event) => {
        if (!onScrollDelta) return
        const dir = (event as any).scroll?.direction
        if (dir === "down") onScrollDelta(3)
        else if (dir === "up") onScrollDelta(-3)
      }}
    >
      <box width="100%" flexDirection="column" overflow="hidden">
        {visible.map((line, idx) => (
          <box key={clampedOffset + idx} width="100%" height={1} flexShrink={0} flexDirection="row" overflow="hidden">
            {line.spans.length === 0 ? (
              <text height={1}> </text>
            ) : (
              line.spans.map((sp, sIdx) => renderSpan(sp, sIdx))
            )}
          </box>
        ))}
      </box>

      {footerHeight > 0 && (
        <box width="100%" height={1} flexShrink={0} flexDirection="row" justifyContent="space-between" overflow="hidden">
          <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
            {`Lines ${clampedOffset + 1}-${Math.min(lines.length, clampedOffset + bodyRows)} / ${lines.length}`}
          </text>
          <text height={1} wrapMode="none" style={{ textColor: THEME.accentBlue }}>
            {fractionalBar(maxOffset > 0 ? clampedOffset / maxOffset : 1, Math.min(10, Math.max(4, safeWidth - 22)), "─")}
          </text>
        </box>
      )}
    </box>
  )
}
