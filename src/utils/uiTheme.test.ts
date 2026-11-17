import test from "node:test"
import assert from "node:assert/strict"
import { buildPreviewUnifiedDiff, classifyToastTone, fractionalBar, gaugeBar, lerpColor, parseHexRgb, sanitizeHexColor, terminalSafeMarkdown, THEME } from "./uiTheme.js"

test("parseHexRgb and lerpColor interpolate RGB channels and clamp bounds", () => {
  assert.deepEqual(parseHexRgb("#0f1117"), [15, 17, 23])
  assert.deepEqual(parseHexRgb("#fff"), [255, 255, 255])
  assert.equal(lerpColor("#000000", "#ffffff", 0), "#000000")
  assert.equal(lerpColor("#000000", "#ffffff", 1), "#ffffff")
  assert.equal(lerpColor("#000000", "#ffffff", 0.5), "#808080")
  assert.equal(lerpColor("#102030", "#304050", -2), "#102030")
  assert.equal(lerpColor("#102030", "#304050", 5), "#304050")
})

test("fractionalBar and gaugeBar render exact cell widths across ratios", () => {
  assert.equal(fractionalBar(0, 8), "░░░░░░░░")
  assert.equal(fractionalBar(1, 8), "████████")
  const half = fractionalBar(0.5, 8)
  assert.equal([...half].length, 8)
  assert.equal(half, "████░░░░")
  const partial = fractionalBar(0.3, 10)
  assert.equal([...partial].length, 10)

  assert.equal(gaugeBar(0, 6), "●─────")
  assert.equal(gaugeBar(1, 6), "━━━━━●")
  assert.equal([...gaugeBar(0.4, 8)].length, 8)
})

test("classifyToastTone maps status messages to semantic tones", () => {
  assert.equal(classifyToastTone("✓ Updated model for 3 agents"), "success")
  assert.equal(classifyToastTone("✗ Failed to pull source"), "error")
  assert.equal(classifyToastTone("⚠ Read-only git source"), "warning")
  assert.equal(classifyToastTone("Refreshing model catalog..."), "info")
})

test("buildPreviewUnifiedDiff strips terminal escapes and emits valid unified headers", () => {
  const diff = buildPreviewUnifiedDiff("pack/agent\u001b[31m.md", ["model: old"], ["model: new"])
  assert.ok(!diff.includes("\u001b"))
  assert.match(diff, /^--- a\/pack\/agent\.md/m)
  assert.match(diff, /^\+\+\+ b\/pack\/agent\.md/m)
  assert.match(diff, /^-model: old$/m)
  assert.match(diff, /^\+model: new$/m)
})

test("terminalSafeMarkdown strips ANSI/OSC escapes across lines while preserving structure", () => {
  const dirty = "# Heading \u001b[31mred\u001b[0m\n\n- item 1\u001b]52;c;evil\u0007\n\t- nested"
  const clean = terminalSafeMarkdown(dirty)
  assert.equal(clean, "# Heading red\n\n- item 1\n  - nested")
})

test("sanitizeHexColor accepts only strict 3/6-digit hex colors and rejects escape payloads", () => {
  assert.equal(sanitizeHexColor("#ff6b6b"), "#ff6b6b")
  assert.equal(sanitizeHexColor("#ABC"), "#ABC")
  assert.equal(sanitizeHexColor("#\u001b[2J"), THEME.accentBlue)
  assert.equal(sanitizeHexColor("#12345"), THEME.accentBlue)
  assert.equal(sanitizeHexColor("red"), THEME.accentBlue)
})
