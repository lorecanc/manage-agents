import { displayWidth, middleEllipsis, terminalSafeText } from "./terminalText.js"

export type InlineSpanStyle = "text" | "bold" | "italic" | "code" | "link" | "muted" | "marker" | "heading1" | "heading2" | "heading3" | "quoteBar" | "codeFrame"

export interface StyledSpan {
  text: string
  style: InlineSpanStyle
}

export interface RenderedMarkdownLine {
  spans: StyledSpan[]
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function splitByCellBudget(text: string, maxCells: number): string[] {
  const budget = Math.max(1, Math.floor(maxCells))
  const out: string[] = []
  let current = ""
  let width = 0
  for (const part of graphemeSegmenter.segment(text)) {
    const g = part.segment
    const gw = Math.max(1, displayWidth(g))
    if (current && width + gw > budget) {
      out.push(current)
      current = g
      width = gw
    } else {
      current += g
      width += gw
    }
  }
  if (current) out.push(current)
  return out.length ? out : [""]
}

/** Parse inline Markdown (`code`, **bold**, *italic*, [label](url)) into styled spans. */
export function tokenizeInlineMarkdown(text: string, defaultStyle: InlineSpanStyle = "text"): StyledSpan[] {
  const spans: StyledSpan[] = []
  const push = (chunk: string, style: InlineSpanStyle) => {
    if (!chunk) return
    const prev = spans[spans.length - 1]
    if (prev && prev.style === style) prev.text += chunk
    else spans.push({ text: chunk, style })
  }

  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\(([^)]+)\)|(?<!\w)\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      push(text.slice(lastIndex, match.index), defaultStyle)
    }
    if (match[1] !== undefined) push(match[1], "code")
    else if (match[2] !== undefined) push(match[2], "bold")
    else if (match[3] !== undefined) push(match[3], "bold")
    else if (match[4] !== undefined) push(match[4], "link")
    else if (match[6] !== undefined) push(match[6], "italic")
    else if (match[7] !== undefined) push(match[7], "italic")
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < text.length) {
    push(text.slice(lastIndex), defaultStyle)
  }
  return spans.length ? spans : [{ text: "", style: defaultStyle }]
}

interface WordPiece {
  text: string
  style: InlineSpanStyle
  isSpace: boolean
  width: number
}

function spansToWordPieces(spans: StyledSpan[]): WordPiece[] {
  const pieces: WordPiece[] = []
  for (const span of spans) {
    if (!span.text) continue
    if (span.style === "code") {
      // Keep short inline code intact when possible; split on spaces only if needed
      const parts = span.text.split(/(\s+)/)
      for (const part of parts) {
        if (!part) continue
        const isSpace = /^\s+$/.test(part)
        const normalized = isSpace ? " " : part
        pieces.push({ text: normalized, style: span.style, isSpace, width: displayWidth(normalized) })
      }
      continue
    }
    const parts = span.text.split(/(\s+)/)
    for (const part of parts) {
      if (!part) continue
      const isSpace = /^\s+$/.test(part)
      const normalized = isSpace ? " " : part
      pieces.push({ text: normalized, style: span.style, isSpace, width: displayWidth(normalized) })
    }
  }
  return pieces
}

function coalesceSpans(spans: StyledSpan[]): StyledSpan[] {
  const merged: StyledSpan[] = []
  for (const span of spans) {
    if (!span.text) continue
    const prev = merged[merged.length - 1]
    if (prev && prev.style === span.style) prev.text += span.text
    else merged.push({ text: span.text, style: span.style })
  }
  return merged
}

/**
 * Word-wrap inline-styled text with exact first-line prefix and hanging continuation prefix.
 * Every wrapped continuation line aligns cleanly under the start of the content column.
 */
export function wrapStyledParagraph(
  rawSegments: string[],
  maxWidth: number,
  firstPrefix: StyledSpan[],
  continuationPrefix: StyledSpan[],
  defaultStyle: InlineSpanStyle = "text",
): RenderedMarkdownLine[] {
  const firstPrefixWidth = firstPrefix.reduce((s, sp) => s + displayWidth(sp.text), 0)
  const contPrefixWidth = continuationPrefix.reduce((s, sp) => s + displayWidth(sp.text), 0)
  const out: RenderedMarkdownLine[] = []
  let isFirstLineOfBlock = true

  for (const segment of rawSegments) {
    const trimmed = segment.replace(/\s+/g, " ").trim()
    if (!trimmed) {
      const pfx = isFirstLineOfBlock ? firstPrefix : continuationPrefix
      out.push({ spans: coalesceSpans([...pfx]) })
      isFirstLineOfBlock = false
      continue
    }

    const spans = tokenizeInlineMarkdown(trimmed, defaultStyle)
    const pieces = spansToWordPieces(spans)

    let currentPrefix = isFirstLineOfBlock ? firstPrefix : continuationPrefix
    let currentPrefixW = isFirstLineOfBlock ? firstPrefixWidth : contPrefixWidth
    let avail = Math.max(6, maxWidth - currentPrefixW)
    let lineSpans: StyledSpan[] = [...currentPrefix]
    let used = 0

    const flushLine = () => {
      out.push({ spans: coalesceSpans(lineSpans) })
      isFirstLineOfBlock = false
      currentPrefix = continuationPrefix
      currentPrefixW = contPrefixWidth
      avail = Math.max(6, maxWidth - currentPrefixW)
      lineSpans = [...currentPrefix]
      used = 0
    }

    for (const piece of pieces) {
      if (piece.isSpace) {
        if (used > 0 && used + 1 < avail) {
          lineSpans.push({ text: " ", style: defaultStyle })
          used += 1
        }
        continue
      }

      if (piece.width <= avail) {
        if (used > 0 && used + piece.width > avail) {
          // Strip trailing space before flushing
          const last = lineSpans[lineSpans.length - 1]
          if (last && last.text.endsWith(" ") && last !== currentPrefix[currentPrefix.length - 1]) {
            last.text = last.text.slice(0, -1)
          }
          flushLine()
        }
        lineSpans.push({ text: piece.text, style: piece.style })
        used += piece.width
      } else {
        // Single token wider than available column: flush current words first, then split by cell budget
        if (used > 0) {
          const last = lineSpans[lineSpans.length - 1]
          if (last && last.text.endsWith(" ") && last !== currentPrefix[currentPrefix.length - 1]) {
            last.text = last.text.slice(0, -1)
          }
          flushLine()
        }
        const chunks = splitByCellBudget(piece.text, avail)
        chunks.forEach((chunk, idx) => {
          lineSpans.push({ text: chunk, style: piece.style })
          used = displayWidth(chunk)
          if (idx < chunks.length - 1) flushLine()
        })
      }
    }

    if (used > 0 || isFirstLineOfBlock) {
      flushLine()
    }
  }

  return out
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*$/
const HR_RE = /^\s*(?:[-]{3,}|[*]{3,}|[_]{3,})\s*$/
const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^\s`~]*).*$/
const BLOCKQUOTE_RE = /^\s*(>+)\s?(.*)$/
const LIST_ITEM_RE = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/
const TABLE_SEP_RE = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/

function parseTableCells(line: string): string[] {
  const m = TABLE_ROW_RE.exec(line)
  if (!m) return []
  return m[1].split("|").map(cell => cell.trim())
}

/**
 * Format untrusted Markdown into terminal-safe, cell-exact lines with:
 * - true hanging indentation on nested bullet, numbered, and `[ ]`/`[X]` task lists
 * - soft-wrap prose reflow inside paragraphs, list items, and blockquotes
 * - framed code blocks, GFM tables, and styled headings
 */
export function layoutMarkdownDocument(rawMarkdown: string, targetWidth: number, maxLines = 600): RenderedMarkdownLine[] {
  const width = Math.max(16, Math.floor(targetWidth))
  const rawLines = String(rawMarkdown ?? "")
    .replace(/\t/g, "  ")
    .split(/\r?\n/)
    .slice(0, maxLines)
    .map(line => terminalSafeText(line))

  const result: RenderedMarkdownLine[] = []
  const pushBlank = () => {
    if (result.length > 0 && result[result.length - 1].spans.some(s => s.text.length > 0)) {
      result.push({ spans: [] })
    }
  }

  const indentStack: number[] = []
  const resolveListLevel = (indentSpaces: number): number => {
    while (indentStack.length > 0 && indentSpaces < indentStack[indentStack.length - 1]) {
      indentStack.pop()
    }
    if (indentStack.length === 0 || indentSpaces > indentStack[indentStack.length - 1]) {
      indentStack.push(indentSpaces)
    }
    return Math.max(0, indentStack.length - 1)
  }

  let i = 0
  while (i < rawLines.length) {
    const line = rawLines[i]

    // 1. Blank line
    if (!line.trim()) {
      pushBlank()
      i++
      continue
    }

    // 2. Fenced code block
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const fenceMarker = fenceMatch[2][0]
      const fenceLen = fenceMatch[2].length
      const lang = fenceMatch[3] || "code"
      const codeLines: string[] = []
      i++
      while (i < rawLines.length) {
        const closeRe = new RegExp(`^\\s*${fenceMarker}{${fenceLen},}\\s*$`)
        if (closeRe.test(rawLines[i])) {
          i++
          break
        }
        codeLines.push(rawLines[i])
        i++
      }

      const frameInner = Math.max(8, width - 4)
      const titleTag = ` ${lang} `
      const topFill = Math.max(1, width - 3 - displayWidth(titleTag))
      result.push({
        spans: [
          { text: "╭─", style: "codeFrame" },
          { text: middleEllipsis(titleTag, Math.max(4, width - 4)), style: "muted" },
          { text: `${"─".repeat(topFill)}╮`, style: "codeFrame" },
        ],
      })
      if (codeLines.length === 0) {
        result.push({ spans: [{ text: `│ ${" ".repeat(frameInner)} │`, style: "codeFrame" }] })
      } else {
        for (const cLine of codeLines) {
          if (!cLine) {
            result.push({
              spans: [
                { text: "│ ", style: "codeFrame" },
                { text: " ".repeat(frameInner), style: "code" },
                { text: " │", style: "codeFrame" },
              ],
            })
            continue
          }
          const chunks = splitByCellBudget(cLine, frameInner)
          chunks.forEach((chunk, cIdx) => {
            const prefix = cIdx > 0 ? "↪ " : ""
            const body = cIdx > 0 ? middleEllipsis(chunk, Math.max(2, frameInner - 2)) : chunk
            const pad = Math.max(0, frameInner - displayWidth(prefix) - displayWidth(body))
            result.push({
              spans: [
                { text: "│ ", style: "codeFrame" },
                ...(prefix ? [{ text: prefix, style: "muted" as const }] : []),
                { text: `${body}${" ".repeat(pad)}`, style: "code" },
                { text: " │", style: "codeFrame" },
              ],
            })
          })
        }
      }
      result.push({
        spans: [{ text: `╰${"─".repeat(Math.max(2, width - 2))}╯`, style: "codeFrame" }],
      })
      continue
    }

    // 3. Horizontal rule
    if (HR_RE.test(line)) {
      indentStack.length = 0
      result.push({ spans: [{ text: "─".repeat(Math.max(8, width)), style: "codeFrame" }] })
      i++
      continue
    }

    // 4. Heading
    const headingMatch = HEADING_RE.exec(line)
    if (headingMatch) {
      indentStack.length = 0
      pushBlank()
      const level = headingMatch[1].length
      const headingText = headingMatch[2]
      const hStyle: InlineSpanStyle = level === 1 ? "heading1" : level === 2 ? "heading2" : "heading3"
      const hPrefix = level === 1 ? "▌ " : level === 2 ? "▍ " : "• "
      const wrapped = wrapStyledParagraph(
        [headingText],
        width,
        [{ text: hPrefix, style: hStyle }],
        [{ text: "  ", style: hStyle }],
        hStyle,
      )
      result.push(...wrapped)
      i++
      continue
    }

    // 5. GFM Table
    if (TABLE_ROW_RE.test(line) && i + 1 < rawLines.length && TABLE_SEP_RE.test(rawLines[i + 1])) {
      indentStack.length = 0
      const headerCells = parseTableCells(line)
      const colCount = Math.max(1, headerCells.length)
      i += 2
      const bodyRows: string[][] = []
      while (i < rawLines.length && TABLE_ROW_RE.test(rawLines[i])) {
        const row = parseTableCells(rawLines[i])
        const normalized = Array.from({ length: colCount }, (_, idx) => row[idx] ?? "")
        bodyRows.push(normalized)
        i++
      }
      const tableWidth = Math.max(1, Math.floor(targetWidth))
      const bordersBudget = 3 * colCount + 1
      const naturalWidths = Array.from({ length: colCount }, (_, c) =>
        Math.max(3, displayWidth(headerCells[c] ?? ""), ...bodyRows.map(r => displayWidth(r[c] ?? ""))),
      )

      if (tableWidth < bordersBudget + colCount) {
        const renderCompactRow = (cells: string[], cellStyle: InlineSpanStyle) => {
          const clean = Array.from({ length: colCount }, (_, idx) =>
            tokenizeInlineMarkdown(cells[idx] ?? "", cellStyle).map(span => span.text).join(""),
          ).join(" | ")
          result.push({ spans: [{ text: middleEllipsis(clean, tableWidth), style: cellStyle }] })
        }
        renderCompactRow(headerCells, "heading2")
        for (const row of bodyRows) renderCompactRow(row, "text")
        continue
      }

      const minCol = tableWidth >= bordersBudget + colCount * 3 ? 3 : 1
      const usableCols = tableWidth - bordersBudget
      const totalNatural = naturalWidths.reduce((a, b) => a + b, 0)
      let colWidths: number[]
      if (totalNatural <= usableCols) {
        colWidths = naturalWidths.map(nw => Math.max(minCol, nw))
      } else {
        const extra = usableCols - colCount * minCol
        const weights = naturalWidths.map(nw => Math.max(0, nw - minCol))
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
        const allocations = weights.map(weight => Math.floor(extra * weight / totalWeight))
        let remaining = extra - allocations.reduce((sum, allocation) => sum + allocation, 0)
        const remainders = weights
          .map((weight, idx) => ({ idx, remainder: (extra * weight) % totalWeight }))
          .sort((a, b) => b.remainder - a.remainder || a.idx - b.idx)
        for (let idx = 0; remaining > 0; idx++, remaining--) {
          allocations[remainders[idx].idx]++
        }
        colWidths = weights.map((_, idx) => minCol + allocations[idx])
      }

      const drawBorder = (left: string, mid: string, right: string) =>
        `${left}${colWidths.map(w => "─".repeat(w + 2)).join(mid)}${right}`

      result.push({ spans: [{ text: drawBorder("┌", "┬", "┐"), style: "codeFrame" }] })
      const renderTableRow = (cells: string[], cellStyle: InlineSpanStyle) => {
        const spans: StyledSpan[] = []
        cells.forEach((cell, idx) => {
          const clean = tokenizeInlineMarkdown(cell, cellStyle).map(s => s.text).join("")
          const fitted = middleEllipsis(clean, colWidths[idx])
          const pad = Math.max(0, colWidths[idx] - displayWidth(fitted))
          spans.push({ text: "│ ", style: "codeFrame" })
          spans.push({ text: `${fitted}${" ".repeat(pad)}`, style: cellStyle })
          spans.push({ text: " ", style: "codeFrame" })
        })
        spans.push({ text: "│", style: "codeFrame" })
        result.push({ spans: coalesceSpans(spans) })
      }
      renderTableRow(headerCells, "heading2")
      result.push({ spans: [{ text: drawBorder("├", "┼", "┤"), style: "codeFrame" }] })
      for (const r of bodyRows) renderTableRow(r, "text")
      result.push({ spans: [{ text: drawBorder("└", "┴", "┘"), style: "codeFrame" }] })
      continue
    }

    // 6. Blockquote
    const quoteMatch = BLOCKQUOTE_RE.exec(line)
    if (quoteMatch) {
      indentStack.length = 0
      const depth = Math.min(3, quoteMatch[1].length)
      const segments: string[] = []
      let currentSeg = quoteMatch[2]
      i++
      while (i < rawLines.length) {
        const nextQuote = BLOCKQUOTE_RE.exec(rawLines[i])
        if (!nextQuote || Math.min(3, nextQuote[1].length) !== depth) break
        const nextText = nextQuote[2]
        if (!nextText.trim()) {
          segments.push(currentSeg)
          currentSeg = ""
        } else if (/(?: {2}|\\)$/.test(currentSeg)) {
          segments.push(currentSeg.replace(/(?: {2}|\\)$/, ""))
          currentSeg = nextText
        } else {
          currentSeg = currentSeg ? `${currentSeg} ${nextText}` : nextText
        }
        i++
      }
      if (currentSeg || segments.length === 0) segments.push(currentSeg)
      const barPrefix: StyledSpan[] = [{ text: "▎ ".repeat(depth), style: "quoteBar" }]
      result.push(...wrapStyledParagraph(segments, width, barPrefix, barPrefix, "muted"))
      continue
    }

    // 7. Nested Bullet / Numbered / Task List Item (with true hanging indent & soft-wrap reflow!)
    const listMatch = LIST_ITEM_RE.exec(line)
    if (listMatch) {
      const leadingSpaces = listMatch[1].length
      const level = Math.min(5, resolveListLevel(leadingSpaces))
      const isOrdered = listMatch[3] !== undefined
      const orderNum = listMatch[3] ?? ""
      const taskState = listMatch[4]
      const segments: string[] = []
      let currentSeg = listMatch[5]
      i++

      // Absorb indented soft-wrapped continuation lines belonging to this list item
      while (i < rawLines.length) {
        const peek = rawLines[i]
        if (!peek.trim()) break
        if (
          LIST_ITEM_RE.test(peek) ||
          HEADING_RE.test(peek) ||
          FENCE_RE.test(peek) ||
          HR_RE.test(peek) ||
          BLOCKQUOTE_RE.test(peek) ||
          TABLE_ROW_RE.test(peek)
        ) {
          break
        }
        const peekIndent = /^(\s*)/.exec(peek)?.[1].length ?? 0
        if (peekIndent <= leadingSpaces && leadingSpaces > 0) break
        if (peekIndent === 0 && !/(?:[,;:\-]|and|or|to|of|in|for|with)$/i.test(currentSeg.trim())) {
          // Unindented line after a list item ends the list unless manifestly mid-sentence
          if (peekIndent === 0 && leadingSpaces > 0) break
        }
        if (/(?: {2}|\\)$/.test(currentSeg)) {
          segments.push(currentSeg.replace(/(?: {2}|\\)$/, ""))
          currentSeg = peek.trim()
        } else {
          currentSeg = `${currentSeg} ${peek.trim()}`
        }
        i++
      }
      segments.push(currentSeg)

      const baseIndent = "  ".repeat(level)
      const bulletStr = isOrdered
        ? `${orderNum}. `
        : level === 0
          ? "• "
          : level === 1
            ? "◦ "
            : "▪ "
      const firstPrefix: StyledSpan[] = [
        ...(baseIndent ? [{ text: baseIndent, style: "text" as const }] : []),
        { text: bulletStr, style: "marker" },
        ...(taskState !== undefined
          ? [{ text: taskState.toLowerCase() === "x" ? "[X] " : "[ ] ", style: taskState.toLowerCase() === "x" ? "heading3" as const : "muted" as const }]
          : []),
      ]
      const hangingCells = firstPrefix.reduce((s, sp) => s + displayWidth(sp.text), 0)
      const contPrefix: StyledSpan[] = [{ text: " ".repeat(hangingCells), style: "text" }]
      result.push(...wrapStyledParagraph(segments, width, firstPrefix, contPrefix, "text"))
      continue
    }

    // 8. Regular Paragraph (reflow consecutive soft-wrapped prose lines)
    indentStack.length = 0
    const paraSegments: string[] = []
    let currentPara = line.trim()
    i++
    while (i < rawLines.length) {
      const peek = rawLines[i]
      if (
        !peek.trim() ||
        HEADING_RE.test(peek) ||
        FENCE_RE.test(peek) ||
        HR_RE.test(peek) ||
        BLOCKQUOTE_RE.test(peek) ||
        LIST_ITEM_RE.test(peek) ||
        (TABLE_ROW_RE.test(peek) && i + 1 < rawLines.length && TABLE_SEP_RE.test(rawLines[i + 1]))
      ) {
        break
      }
      if (/(?: {2}|\\)$/.test(currentPara)) {
        paraSegments.push(currentPara.replace(/(?: {2}|\\)$/, ""))
        currentPara = peek.trim()
      } else {
        currentPara = `${currentPara} ${peek.trim()}`
      }
      i++
    }
    paraSegments.push(currentPara)
    result.push(...wrapStyledParagraph(paraSegments, width, [], [], "text"))
  }

  if (String(rawMarkdown ?? "").split(/\r?\n/).length > maxLines) {
    pushBlank()
    result.push({ spans: [{ text: "… (truncated for preview)", style: "muted" }] })
  }

  return result
}
