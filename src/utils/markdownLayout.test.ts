import test from "node:test"
import assert from "node:assert/strict"
import { displayWidth } from "./terminalText.js"
import { layoutMarkdownDocument, type RenderedMarkdownLine } from "./markdownLayout.js"

const plainLine = (line: RenderedMarkdownLine) => line.spans.map(s => s.text).join("")

test("hanging indent aligns wrapped list continuations and nested sublists", () => {
  const md = [
    "1. **Understand.** Restate the goal to yourself and act on the most likely reading",
    "   of the request right away.",
    "   - `flow-frontend-design` for any user-facing UI that needs visual structure and polish;",
    "   - [x] Verify layout boundaries across narrow viewports.",
  ].join("\n")

  const lines = layoutMarkdownDocument(md, 42).map(plainLine)
  // Top-level ordered item "1. " (3 cols) hangs wrapped lines at 3 spaces
  assert.match(lines[0], /^1\. Understand\. /)
  assert.match(lines[1], /^   \S/)

  // Nested bullet "  ◦ " (4 cols) hangs its wrapped continuation at 4 spaces
  const subBulletIdx = lines.findIndex(l => l.startsWith("  ◦ "))
  assert.ok(subBulletIdx > 0, `expected nested bullet in:\n${lines.join("\n")}`)
  assert.match(lines[subBulletIdx + 1], /^    \S/)

  // Task checkbox renders as legible [X] with 8-col hanging indent ("  ◦ [X] ")
  const taskIdx = lines.findIndex(l => l.includes("[X] Verify"))
  assert.ok(taskIdx > 0)
  assert.match(lines[taskIdx + 1], /^        \S/)

  for (const l of lines) {
    assert.ok(displayWidth(l) <= 42, `line exceeded width 42 (${displayWidth(l)}): "${l}"`)
  }
})

test("fenced code blocks, blockquotes, tables and headings stay within target width and strip escapes", () => {
  const md = [
    "# Heading \u001b[31mOne\u001b[0m",
    "",
    "> Quoted line one that wraps cleanly across narrow inspector panes.",
    "> Continuation of the quote.",
    "",
    "```bash",
    "npm run validate -- --verbose",
    "```",
    "",
    "| Key | Action |",
    "| --- | --- |",
    "| Space | Toggle agent |",
  ].join("\n")

  const lines = layoutMarkdownDocument(md, 38).map(plainLine)
  const joined = lines.join("\n")
  assert.ok(!joined.includes("\u001b"))
  assert.ok(lines.some(l => l.startsWith("▌ Heading One")))
  const quoteLines = lines.filter(l => l.startsWith("▎ "))
  assert.ok(quoteLines.length >= 2)
  assert.ok(lines.some(l => l.startsWith("╭─ bash")))
  assert.ok(lines.some(l => l.startsWith("┌─")))

  for (const l of lines) {
    assert.ok(displayWidth(l) <= 38, `line exceeded width 38 (${displayWidth(l)}): "${l}"`)
  }
})

test("GFM tables stay within narrow terminal widths across varying column counts", () => {
  for (const colCount of [3, 4, 5]) {
    const header = Array.from({ length: colCount }, (_, idx) => `Column ${idx + 1}`)
    const separator = Array.from({ length: colCount }, () => "---")
    const firstRow = Array.from({ length: colCount }, (_, idx) => `Long value ${idx + 1}`)
    const secondRow = Array.from({ length: colCount }, (_, idx) => `Cell ${idx + 1}`)
    const markdown = [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      `| ${firstRow.join(" | ")} |`,
      `| ${secondRow.join(" | ")} |`,
    ].join("\n")

    for (const width of [22, 18, 16, 10, 4]) {
      const lines = layoutMarkdownDocument(markdown, width).map(plainLine)
      for (const line of lines) {
        assert.ok(displayWidth(line) <= width, `${colCount}-column table exceeded width ${width} (${displayWidth(line)}): "${line}"`)
      }
    }
  }
})
