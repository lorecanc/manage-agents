import test from "node:test"
import assert from "node:assert/strict"
import {
  buildHelpSections,
  calculateHelpViewport,
  clampFocusIntoHelpSlice,
  clampHelpScroll,
  cycleHelpTab,
  defaultHelpTabForWorkspace,
  HELP_TABS,
  helpTabByNumber,
} from "./helpGuide.js"

test("defaultHelpTabForWorkspace maps active workspace directly to matching help tab", () => {
  assert.equal(defaultHelpTabForWorkspace("catalog"), "catalog")
  assert.equal(defaultHelpTabForWorkspace("target"), "target")
  assert.equal(defaultHelpTabForWorkspace("flows"), "flows")
  assert.equal(defaultHelpTabForWorkspace("sources"), "sources")
})

test("cycleHelpTab and helpTabByNumber navigate across all five guide tabs", () => {
  assert.equal(HELP_TABS.length, 5)
  assert.equal(cycleHelpTab("catalog", 1), "target")
  assert.equal(cycleHelpTab("target", 1), "flows")
  assert.equal(cycleHelpTab("catalog", -1), "global")
  assert.equal(cycleHelpTab("global", 1), "catalog")
  assert.equal(helpTabByNumber(1), "catalog")
  assert.equal(helpTabByNumber(2), "target")
  assert.equal(helpTabByNumber(4), "sources")
  assert.equal(helpTabByNumber(9), null)
})

test("buildHelpSections gives each distinct command its own row and respects context flags", () => {
  const readOnlyGit = buildHelpSections("catalog", {
    hasAgents: true,
    isReadOnlyGitSource: true,
  })
  const keys = readOnlyGit.items.map(i => i.keyLabel)
  // Previously merged pairs (C / R, G / U, T / Shift+T, P / Shift+F, A / S) are now separate rows.
  for (const distinctKey of ["M", "T", "Shift+T", "P", "Shift+F", "U", "G", "C", "R", "A", "S"]) {
    assert.ok(keys.includes(distinctKey), `expected standalone key row for ${distinctKey}`)
  }
  const renameItem = readOnlyGit.items.find(i => i.id === "cat-rename")
  assert.equal(renameItem?.disabled, true)

  const flowsReady = buildHelpSections("flows", {
    hasAgents: true,
    isVirtualPack: true,
    isReadOnlyGitSource: true,
    hasInvalidModels: true,
  })
  assert.equal(flowsReady.items.find(i => i.id === "flw-init")?.disabled, false)
  assert.equal(flowsReady.items.find(i => i.id === "flw-doctor")?.disabled, true)
  assert.equal(flowsReady.items.find(i => i.id === "flw-repair")?.disabled, false)

  const localPackFlows = buildHelpSections("flows", {
    hasAgents: true,
    isVirtualPack: false,
    isReadOnlyGitSource: false,
  })
  assert.equal(localPackFlows.items.find(i => i.id === "flw-doctor")?.disabled, false)
  assert.equal(localPackFlows.items.find(i => i.id === "flw-scaffold")?.disabled, false)

  const sourcesTab = buildHelpSections("sources", { hasAgents: false })
  assert.ok(sourcesTab.items.some(i => i.actionId === "target-reconcile"))
  assert.ok(sourcesTab.items.some(i => i.actionId === "source-gh-auth"))
  assert.ok(sourcesTab.items.some(i => i.actionId === "source-trust"))
  assert.ok(sourcesTab.items.some(i => i.actionId === "source-remove"))
  assert.ok(sourcesTab.items.some(i => i.actionId === "pane-toggle"))
})

test("clampHelpScroll keeps both focused item and group header visible in tight viewports", () => {
  const { rows, items } = buildHelpSections("catalog", { hasAgents: true })
  const viewport = 6

  // Initial focus at index 0 keeps top group header at row 0 visible.
  assert.equal(clampHelpScroll(0, rows, 0, viewport), 0)

  // Scrolling down to the last item advances offset so the last row fits inside the viewport.
  const lastIdx = items.length - 1
  const bottomOffset = clampHelpScroll(lastIdx, rows, 0, viewport)
  const lastRowPos = rows.findIndex(r => r.kind === "item" && r.itemIndex === lastIdx)
  assert.ok(lastRowPos >= bottomOffset && lastRowPos < bottomOffset + viewport)

  // Wrapping back to item 0 snaps offset back to 0 so the group title is visible too.
  assert.equal(clampHelpScroll(0, rows, bottomOffset, viewport), 0)

  // Extreme 1-row viewport still lands directly on the focused item row.
  assert.equal(clampHelpScroll(0, rows, 5, 1), 1)
})

test("calculateHelpViewport fits inside wide, 80x24 and compact terminals without overflow", () => {
  const wide = calculateHelpViewport(120, 34)
  assert.equal(wide.modalWidth, 88)
  assert.equal(wide.viewportRows, 18)
  assert.ok(wide.left + wide.modalWidth <= 120)
  assert.ok(wide.top + wide.modalHeight <= 34)

  const standard = calculateHelpViewport(80, 24)
  assert.equal(standard.modalWidth, 74)
  assert.ok(standard.viewportRows >= 10)
  assert.ok(standard.left + standard.modalWidth <= 80)
  assert.ok(standard.top + standard.modalHeight <= 24)

  const compact = calculateHelpViewport(58, 18)
  assert.equal(compact.compactChrome, true)
  assert.ok(compact.modalWidth <= 56)
  assert.ok(compact.modalHeight <= 16)
  assert.ok(compact.viewportRows >= 7)

  const tiny = calculateHelpViewport(20, 12)
  assert.ok(tiny.left + tiny.modalWidth <= 20)
  assert.ok(tiny.top + tiny.modalHeight <= 12)
})

test("clampFocusIntoHelpSlice snaps off-screen focus into visible window on wheel scroll", () => {
  const { rows } = buildHelpSections("catalog", { hasAgents: true })
  const viewport = 6
  // Scrolling down past item 0 snaps focus to the first visible item in the slice.
  const snappedDown = clampFocusIntoHelpSlice(0, rows, 6, viewport)
  assert.ok(snappedDown > 0)
  // Keeping focus inside the slice leaves it unchanged.
  assert.equal(clampFocusIntoHelpSlice(snappedDown, rows, 6, viewport), snappedDown)
  // Scrolling back to top while focused at the bottom snaps focus to the last visible item in top slice.
  const snappedUp = clampFocusIntoHelpSlice(14, rows, 0, viewport)
  assert.ok(snappedUp < 6)
})
