import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import React from "react"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { tempDir, writePack } from "../../test/helpers.js"
import { loadSources } from "./sources.js"
import { App } from "../App.js"
import { chunkPillsByWidth } from "../ui/ParameterTuningModal.js"
import {
  adjustListShare,
  calculateLayout,
  calculateListColumnBudget,
  calculateModalViewport,
  calculatePanelWidths,
  calculateWorkspaceViewports,
  clampListScroll,
  computeCatalogJumpState,
  resetListShare,
} from "./layout.js"
import { DEFAULT_TRANSLATION_CONFIG, translationConfigPath } from "./translationConfig.js"

test("calculates bounded layouts across terminal sizes and status states", () => {
  const cases = [
    [80, 8, false, "too-small", 0, false],
    [39, 30, true, "too-small", 0, false],
    [40, 12, false, "too-small", 0, false],
    [40, 18, false, "compact", 1, false],
    [80, 20, false, "compact", 3, false],
    [80, 24, false, "compact", 7, false],
    [80, 24, true, "compact", 6, false],
    [120, 20, true, "normal", 2, true],
    [120, 60, false, "normal", 43, true]
  ] as const

  for (const [width, height, status, mode, rows, inspector] of cases) {
    const layout = calculateLayout(width, height, status)
    assert.equal(layout.mode, mode)
    assert.equal(layout.listRows, rows)
    assert.equal(layout.showInspector, inspector)
    assert.ok(layout.listRows >= 0)
    assert.ok(layout.budgetRows <= height)
  }
})

test("reserves exactly one row when the warning is visible and handles mode boundaries", () => {
  const withoutStatus = calculateLayout(120, 20, false)
  const withStatus = calculateLayout(120, 20, true)

  assert.equal(withoutStatus.statusRows, 0)
  assert.equal(withStatus.statusRows, 1)
  assert.equal(withStatus.listRows, withoutStatus.listRows - 1)
  assert.equal(calculateLayout(80, 24, false).listRows, 7)
  assert.equal(calculateLayout(80, 24, true).listRows, 6)
  assert.equal(calculateLayout(40, 12, false).mode, "too-small")
  assert.equal(calculateLayout(40, 12, true).mode, "too-small")
  assert.equal(calculateLayout(40, 17, true).mode, "too-small")
  assert.equal(calculateLayout(40, 19, true).listRows, 1)
  assert.equal(calculateLayout(100, 18, false).mode, "normal")
})

test("list column budgets account for explicit gutters", () => {
  for (const mode of ["normal", "compact"] as const) {
    const budget = calculateListColumnBudget(80, mode)
    assert.equal(budget.widths.length, mode === "normal" ? 5 : 3)
    assert.equal(budget.total, 80)
    assert.ok(budget.widths.every(width => width >= 0))
    assert.equal(budget.total, budget.widths.reduce((a, b) => a + b, 0) + budget.gutters.reduce((a, b) => a + b, 0))
    assert.ok(budget.widths[0] >= 5)
  }
  assert.ok(calculateListColumnBudget(10, "compact").total <= 10)
})

test("panel widths honor the configured share and terminal budget", () => {
  for (const [share, expectedList] of [[2 / 3, 83], [0.60, 75], [0.75, 93]] as const) {
    const widths = calculatePanelWidths(128, "normal", share)
    assert.equal(widths.gutter, 1)
    assert.equal(widths.list, expectedList)
    assert.ok(widths.list + widths.inspector + widths.gutter <= 126)
    assert.ok(widths.list >= 52 && widths.inspector >= 28)
  }
  const wide = calculatePanelWidths(160, "normal", 2 / 3)
  assert.deepEqual(wide, { list: 104, inspector: 53, gutter: 1 })
  assert.deepEqual(calculatePanelWidths(80, "normal", 2 / 3), { list: 51, inspector: 26, gutter: 1 })
  assert.deepEqual(calculatePanelWidths(160, "normal", 0.60), { list: 94, inspector: 63, gutter: 1 })
  assert.deepEqual(calculatePanelWidths(160, "normal", 0.75), { list: 117, inspector: 40, gutter: 1 })
  assert.deepEqual(calculatePanelWidths(80, "compact", 2 / 3), { list: 78, inspector: 0, gutter: 0 })
})

test("adjusts layout shares in one-percent steps, clamps, and resets", () => {
  assert.equal(adjustListShare(0.60, -0.01), 0.60)
  assert.equal(adjustListShare(0.75, 0.01), 0.75)
  assert.equal(adjustListShare(2 / 3, 0.01), 0.68)
  assert.equal(adjustListShare(0.67, -0.01), 0.66)
  assert.equal(resetListShare(), 2 / 3)
})

test("column budgets consume exactly the content width at PTY sizes", () => {
  for (const terminalWidth of [80, 128, 160]) {
    const panel = calculatePanelWidths(terminalWidth, terminalWidth === 80 ? "compact" : "normal", 2 / 3)
    const contentWidth = Math.max(0, panel.list - 4)
    const budget = calculateListColumnBudget(contentWidth, panel.inspector ? "normal" : "compact")
    assert.equal(budget.total, contentWidth)
    assert.equal(budget.widths.length, panel.inspector ? 5 : 3)
    assert.equal(budget.widths.reduce((sum, width) => sum + width, 0) + budget.gutters.reduce((sum, width) => sum + width, 0), contentWidth)
    assert.ok(budget.widths.every(width => width >= 0))
  }
})

test("workspace and modal viewport helpers stay positive and fit inside terminal bounds", () => {
  for (const [w, h] of [[80, 24], [100, 26], [120, 34], [140, 42]] as const) {
    const ws = calculateWorkspaceViewports(h, { hasSourcesStatus: false })
    const wsWithStatus = calculateWorkspaceViewports(h, { hasSourcesStatus: true })
    assert.equal(ws.catalogRows, h - 15)
    assert.equal(ws.flowsRows, h - 18)
    assert.equal(ws.sourcesRows, h - 21)
    assert.equal(wsWithStatus.sourcesRows, Math.max(1, h - 23))

    for (const kind of [
      "model-selector",
      "delegation-manager",
      "resource-manager",
      "tier-selector",
      "color-selector",
      "action-result",
      "command-palette",
      "routing",
      "self-update",
    ] as const) {
      const vp = calculateModalViewport(kind, w, h)
      assert.ok(vp.viewportRows >= 1, `${kind} viewportRows >= 1 at ${w}x${h}`)
      assert.ok(vp.top + vp.modalHeight <= h, `${kind} top+height fits ${h}`)
      assert.ok(vp.left + vp.modalWidth <= w, `${kind} left+width fits ${w}`)
    }
  }

  assert.equal(clampListScroll(0, 20, 0, 6), 0)
  assert.equal(clampListScroll(7, 20, 0, 6), 2)
  assert.equal(clampListScroll(19, 20, 10, 6), 14)
  assert.equal(clampListScroll(3, 20, 10, 6), 3)
})

test("computes a catalog jump against the expanded unfiltered item order", () => {
  const agents = [
    ...Array.from({ length: 3 }, (_, index) => ({ currentPath: `alpha/${index}`, category: "alpha" })),
    ...Array.from({ length: 2 }, (_, index) => ({ currentPath: `beta/${index}`, category: "beta" })),
    ...Array.from({ length: 8 }, (_, index) => ({ currentPath: `gamma/${index}`, category: "gamma" })),
  ]
  const jump = computeCatalogJumpState(agents, new Set(["alpha"]), "gamma/7", 0, 5, (a, b) => a.localeCompare(b))

  assert.ok(jump)
  assert.equal(jump.foundIndex, 13)
  assert.equal(jump.totalItems, 14)
  assert.equal(jump.scrollOffset, 9)
  assert.deepEqual([...jump.expandedCategories], ["alpha", "gamma"])
  assert.equal(computeCatalogJumpState(agents, new Set(), "missing", 0, 5, (a, b) => a.localeCompare(b)), null)
})

test("TUI lists never clip focused tail items across Catalog, Flows, Models, Delegations, Palette, Colors, and IF/OR Routing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tui-overflow-"))
  const prevXdgConfig = process.env.XDG_CONFIG_HOME
  const prevXdgCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config")
  process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache")
  const packDir = path.join(tmp, "packs", "demo")
  fs.mkdirSync(path.join(packDir, "agents"), { recursive: true })
  fs.writeFileSync(
    path.join(packDir, "opencode-pack.json"),
    JSON.stringify({
      contract: "1.0",
      name: "demo",
      version: "1.0.0",
      description: "demo pack",
      archetype: { callers: ["demo-agent_01"], reference: "demo-agent_01" },
      routingDefaults: { "*": { "demo-agent_02": "openai/gpt-model-01" } },
    }),
  )
  for (let i = 1; i <= 24; i++) {
    const num = String(i).padStart(2, "0")
    fs.writeFileSync(
      path.join(packDir, "agents", `demo-agent_${num}.md`),
      `---\ndescription: Agent ${num}\nmodel: ${i === 1 ? "openai/gpt-4o" : ""}\nmode: ${i === 1 ? "primary" : "subagent"}\n---\nPrompt ${num}\n`,
    )
  }

  const press = async (renderer: any, renderOnce: () => Promise<void>, name: string, sequence = name.length === 1 ? name : "", opts: any = {}) => {
    renderer.keyInput.emit("keypress", { name, sequence, ctrl: false, meta: false, shift: false, ...opts })
    await new Promise(r => setImmediate(r))
    await new Promise(r => setTimeout(r, 14))
    await renderOnce()
  }

  let rendererInstance: any
  try {
    const mockCatalog = {
      status: "verified" as const,
      models: Array.from({ length: 28 }, (_, i) => `openai/gpt-model-${String(i + 1).padStart(2, "0")}`),
    }
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 25 })
    rendererInstance = renderer
    const root = createRoot(renderer)
    root.render(
      React.createElement(App, {
        workspaceRoot: tmp,
        listShare: 2 / 3,
        reducedMotion: true,
        initialModelCatalog: mockCatalog,
      }),
    )
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 20))
      await renderOnce()
      if (captureCharFrame().includes("demo (24)")) break
    }

    // 1. Expand Catalog pack and scroll to the very last agent (demo-agent_24)
    await press(renderer, renderOnce, "return", "\r")
    for (let i = 1; i <= 24; i++) {
      await press(renderer, renderOnce, "down")
      const frame = captureCharFrame()
      const num = String(i).padStart(2, "0")
      assert.equal(frame.includes(`agent_${num}`), true, `Catalog focused agent_${num} must be visible`)
      assert.equal(frame.includes(`Row ${i + 1}/25`), true, `Catalog footer must stay visible at row ${i + 1}`)
    }

    // 1b. Model Selector on demo-agent_24: expand provider and scroll to the very last model (gpt-model-28)
    await press(renderer, renderOnce, "m", "m")
    await press(renderer, renderOnce, "right")
    for (let i = 1; i <= 28; i++) {
      await press(renderer, renderOnce, "down")
      const frame = captureCharFrame()
      const num = String(i).padStart(2, "0")
      assert.equal(frame.includes(`gpt-model-${num}`), true, `Model Selector focused gpt-model-${num} must be visible`)
      assert.equal(frame.includes("ENTER confirm"), true, "Model Selector footer must remain visible")
    }
    await press(renderer, renderOnce, "escape")

    // 2. Delegation Manager on demo-agent_24: scroll through all 23 candidate subagents
    await press(renderer, renderOnce, "g", "g")
    for (let i = 0; i < 23; i++) {
      if (i > 0) await press(renderer, renderOnce, "down")
      const frame = captureCharFrame()
      const num = String(i + 1).padStart(2, "0")
      assert.equal(frame.includes(`demo-agent_${num}`), true, `Delegation Manager focused demo-agent_${num} must be visible`)
      assert.equal(frame.includes("[ESC] Cancel"), true, "Delegation Manager footer must remain visible")
    }
    await press(renderer, renderOnce, "escape")

    // 3. Color Selector: expand all groups or scroll through items
    await press(renderer, renderOnce, "c", "c")
    await press(renderer, renderOnce, "return", "\r")
    for (let i = 0; i < 12; i++) {
      await press(renderer, renderOnce, "down")
      const frame = captureCharFrame()
      assert.equal(frame.includes("[ESC] Cancel"), true, "Color Selector footer must remain visible")
    }
    await press(renderer, renderOnce, "escape")

    // 4. Flows workspace: scroll through all 25 rows (1 pack + 24 agents)
    await press(renderer, renderOnce, "tab")
    for (let i = 1; i <= 24; i++) {
      await press(renderer, renderOnce, "down")
      const frame = captureCharFrame()
      const num = String(i).padStart(2, "0")
      assert.equal(frame.includes(`agent_${num}`), true, `Flows workspace focused agent_${num} must be visible`)
    }

    // 5. Pack IF/OR Routing Editor (23 subagents + triggers + 3 policy rows = 27 rows!)
    await press(renderer, renderOnce, "m", "m")
    await press(renderer, renderOnce, "return", "\r") // open existing manifest flow in routing-editor (initial focus = 1)
    await press(renderer, renderOnce, "up") // focus = 0 (triggers)
    await press(renderer, renderOnce, "up") // wraps to focus = 26 ('Subagent delegations [G]')
    const routingBottomFrame = captureCharFrame()
    assert.equal(routingBottomFrame.includes("Subagent delegations [G]"), true, "Routing Editor last row 'Subagent delegations [G]' must be visible")
    await press(renderer, renderOnce, "escape")
    await press(renderer, renderOnce, "escape")

    // 6. Command Palette: scroll past the first page
    await press(renderer, renderOnce, "k", "k", { ctrl: true })
    for (let i = 0; i < 18; i++) {
      await press(renderer, renderOnce, "down")
      const frame = captureCharFrame()
      assert.equal(frame.includes("▎ "), true, `Command Palette focused cursor must remain visible at step ${i + 1}`)
    }
  } finally {
    try { rendererInstance?.destroy() } catch {}
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevXdgCache
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("Tune Agent Parameters modal navigates cleanly with Tab, saves V2 steps/mode/hidden, and updates Inspector at 120x36 and 80x24", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tui-tune-"))
  const prevXdgConfig = process.env.XDG_CONFIG_HOME
  const prevXdgCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config")
  process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache")
  const packDir = path.join(tmp, "packs", "demo")
  fs.mkdirSync(path.join(packDir, "agents"), { recursive: true })
  fs.writeFileSync(
    path.join(packDir, "opencode-pack.json"),
    JSON.stringify({ contract: "1.0", name: "demo", version: "1.0.0", description: "demo pack" }),
  )
  const agentFile = path.join(packDir, "agents", "demo-worker.md")
  fs.writeFileSync(
    agentFile,
    "---\ndescription: Worker agent\nmodel: openai/gpt-4o#medium\nmode: subagent\nsteps: 50\n---\n\nWorker body.\n",
  )

  const press = async (renderer: any, renderOnce: () => Promise<void>, name: string, sequence = name.length === 1 ? name : "", opts: any = {}) => {
    renderer.keyInput.emit("keypress", { name, sequence, ctrl: false, meta: false, shift: false, ...opts })
    await new Promise(r => setImmediate(r))
    await new Promise(r => setTimeout(r, 14))
    await renderOnce()
  }

  let wideRenderer: any
  let compactRenderer: any
  let shortRenderer: any
  try {
    const mockCatalog = { status: "verified" as const, models: ["openai/gpt-4o"], variants: { "openai/gpt-4o": ["low", "medium", "high"] } }
    const wide = await createTestRenderer({ width: 120, height: 36 })
    wideRenderer = wide.renderer
    createRoot(wide.renderer).render(
      React.createElement(App, {
        workspaceRoot: tmp,
        listShare: 2 / 3,
        reducedMotion: true,
        initialModelCatalog: mockCatalog,
      }),
    )
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 20))
      await wide.renderOnce()
      if (wide.captureCharFrame().includes("demo (1)")) break
    }

    // Expand pack and focus demo-worker
    await press(wide.renderer, wide.renderOnce, "return", "\r")
    await press(wide.renderer, wide.renderOnce, "down")
    const initialFrame = wide.captureCharFrame()
    assert.equal(initialFrame.includes("Temp"), false, "Inspector Overview should not show removed Temp row")
    assert.equal(initialFrame.includes("Mode [T]"), true, "Inspector Overview should show Mode [T] row")

    // Open Tune Parameters ('t')
    await press(wide.renderer, wide.renderOnce, "t", "t")
    const modalFrame = wide.captureCharFrame()
    assert.equal(modalFrame.includes("Temperature"), false, "Tune modal should not show Temperature field")
    assert.equal(modalFrame.includes("▎ Max Steps"), true)
    assert.equal(modalFrame.includes("● medium"), true, "Segmented variant pills should mark current variant")
    assert.equal(modalFrame.includes("Visibility"), true)

    // Edit Steps from 50 -> 25 -> left arrow (-1) -> 24
    await press(wide.renderer, wide.renderOnce, "backspace", "\x7f")
    await press(wide.renderer, wide.renderOnce, "backspace", "\x7f")
    await press(wide.renderer, wide.renderOnce, "2", "2")
    await press(wide.renderer, wide.renderOnce, "5", "5")
    await press(wide.renderer, wide.renderOnce, "left")

    // Press Tab -> focuses Variant; press Tab again -> focuses Execution Mode WITHOUT mutating Variant ("medium")
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    assert.equal(wide.captureCharFrame().includes("▎ Thinking / Effort"), true)
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    assert.equal(wide.captureCharFrame().includes("▎ Execution Mode"), true)

    // Cycle Mode twice: subagent -> primary -> all
    await press(wide.renderer, wide.renderOnce, "space", " ")
    await press(wide.renderer, wide.renderOnce, "space", " ")
    assert.equal(wide.captureCharFrame().includes("● all"), true)

    // Tab to Visibility and toggle Hidden
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    assert.equal(wide.captureCharFrame().includes("▎ Visibility"), true)
    await press(wide.renderer, wide.renderOnce, "space", " ")
    assert.equal(wide.captureCharFrame().includes("● Hidden"), true)

    // Save with Enter -> Action Result shows updated Steps, untouched Variant, Mode=all, Visibility=hidden
    await press(wide.renderer, wide.renderOnce, "return", "\r")
    const resultFrame = wide.captureCharFrame()
    assert.equal(resultFrame.includes("Parameters Updated Successfully"), true)
    assert.equal(resultFrame.includes("Steps:      24"), true)
    assert.equal(resultFrame.includes("Variant:    unchanged"), true)
    assert.equal(resultFrame.includes("Visibility: hidden"), true)

    // Close Action Result -> Inspector Overview immediately reflects Steps=24 and Mode="all · hidden"
    await press(wide.renderer, wide.renderOnce, "return", "\r")
    const updatedInspectorFrame = wide.captureCharFrame()
    assert.equal(updatedInspectorFrame.includes("all · hidden"), true, "Inspector Overview should display updated mode and hidden state")
    assert.match(updatedInspectorFrame, /Steps\s+\S+\s+24\b/, "Inspector Overview should display updated V2 steps (24), not fallback 50")

    const diskText = fs.readFileSync(agentFile, "utf8")
    assert.match(diskText, /\nmodel: openai\/gpt-4o#medium\n/)
    assert.match(diskText, /\nsteps: 24\n/)
    assert.match(diskText, /\nmode: all\n/)
    assert.match(diskText, /\nhidden: true\n/)

    // Verify chunkPillsByWidth balances 2-row and 3-row splits without trailing orphans
    const nineStandard = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "thinking"].map(label => ({ value: label, label }))
    assert.equal(chunkPillsByWidth(nineStandard, 80).length, 1, "Wide cards keep all 9 pills on one row")
    assert.deepEqual(chunkPillsByWidth(nineStandard, 68).map(r => r.length), [5, 4], "Compact cards split 9 pills evenly (5 + 4)")
    assert.deepEqual(chunkPillsByWidth(nineStandard, 38).map(r => r.length), [3, 3, 3], "Narrow cards split 9 pills evenly (3 + 3 + 3)")

    // Verify 80x24 compact layout + fresh typeahead over an existing variant ("medium" -> type "h" -> Space snaps "high")
    const compact = await createTestRenderer({ width: 80, height: 24 })
    compactRenderer = compact.renderer
    createRoot(compact.renderer).render(
      React.createElement(App, {
        workspaceRoot: tmp,
        listShare: 2 / 3,
        reducedMotion: true,
        initialModelCatalog: { status: "unverified" as const, models: [] },
      }),
    )
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 20))
      await compact.renderOnce()
      if (compact.captureCharFrame().includes("demo (1)")) break
    }
    await press(compact.renderer, compact.renderOnce, "t", "t")
    const compactFrame = compact.captureCharFrame()
    assert.equal(compactFrame.includes("▎ Max Steps"), true)
    assert.equal(compactFrame.includes("Visibility"), true)
    assert.equal(compactFrame.includes("[ENTER] Save"), true)
    assert.equal(compactFrame.includes("[ESC] Cancel"), true)

    await press(compact.renderer, compact.renderOnce, "tab", "\t")
    await press(compact.renderer, compact.renderOnce, "h", "h")
    assert.equal(compact.captureCharFrame().includes("#h▋"), true, "Typing starts fresh prefix instead of appending to 'medium'")
    await press(compact.renderer, compact.renderOnce, "space", " ")
    assert.equal(compact.captureCharFrame().includes("● high"), true, "Space snaps prefix 'h' to first matching pill 'high'")

    // Verify ultra-short 42x18 terminal adapts to borderless compact rows without clipping fields or footer
    const shortTerm = await createTestRenderer({ width: 42, height: 18 })
    shortRenderer = shortTerm.renderer
    createRoot(shortTerm.renderer).render(
      React.createElement(App, {
        workspaceRoot: tmp,
        listShare: 2 / 3,
        reducedMotion: true,
        initialModelCatalog: { status: "unverified" as const, models: [] },
      }),
    )
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 20))
      await shortTerm.renderOnce()
      if (shortTerm.captureCharFrame().includes("demo (1)")) break
    }
    await press(shortTerm.renderer, shortTerm.renderOnce, "t", "t")
    const shortFrame = shortTerm.captureCharFrame()
    assert.equal(shortFrame.includes("▎ Max Steps"), true)
    assert.equal(shortFrame.includes("Visibility"), true)
    assert.equal(shortFrame.includes("[ESC] Cancel"), true)
  } finally {
    try { wideRenderer?.destroy() } catch {}
    try { compactRenderer?.destroy() } catch {}
    try { shortRenderer?.destroy() } catch {}
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevXdgCache
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("Browser topbar tabs, Shift+Left/Right panel switching across workspaces, and Master-Detail PackFlowsModal work without mouse", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tui-flows-nav-"))
  const prevXdgConfig = process.env.XDG_CONFIG_HOME
  const prevXdgCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config")
  process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache")
  const packDir = path.join(tmp, "packs", "flow")
  fs.mkdirSync(path.join(packDir, "agents"), { recursive: true })
  fs.writeFileSync(
    path.join(packDir, "opencode-pack.json"),
    JSON.stringify({
      contract: "1.1",
      name: "flow",
      version: "1.0.0",
      description: "Flow pack with conditional routing",
      archetype: { callers: ["flow-build", "flow-plan"], reference: "flow-build" },
      routingDefaults: {
        mistral: {
          "flow-explore": "mistral/deepseek-v4-1-flash-1017#high",
          "flow-eye": "mistral/zai-glm-5-3-flash#high",
        },
        opencode: {
          "flow-explore": "opencode/deepseek-v4-1-flash-free#high",
          "flow-eye": "opencode/deepseek-v4-1-flash-free#high",
        },
      },
    }),
  )
  for (const [id, mode, subs] of [
    ["flow-build", "primary", ["flow-explore", "flow-eye"]],
    ["flow-plan", "primary", ["flow-explore"]],
    ["flow-explore", "subagent", []],
    ["flow-eye", "subagent", []],
  ] as const) {
    const taskYaml = subs.length ? `\n  task:\n${subs.map(s => `    ${s}: allow`).join("\n")}` : ""
    fs.writeFileSync(
      path.join(packDir, "agents", `${id}.md`),
      `---\ndescription: ${id} agent\nmode: ${mode}\npermission:\n  "*": deny${taskYaml}\n---\nPrompt body for ${id}\n`,
    )
  }

  const press = async (renderer: any, renderOnce: () => Promise<void>, name: string, sequence = name.length === 1 ? name : "", opts: any = {}) => {
    renderer.keyInput.emit("keypress", { name, sequence, ctrl: false, meta: false, shift: false, ...opts })
    await new Promise(r => setImmediate(r))
    await new Promise(r => setTimeout(r, 15))
    await renderOnce()
  }

  let wideRenderer: any
  let compactRenderer: any
  try {
    const wide = await createTestRenderer({ width: 136, height: 34 })
    wideRenderer = wide.renderer
    createRoot(wide.renderer).render(
      React.createElement(App, {
        workspaceRoot: tmp,
        listShare: 2 / 3,
        reducedMotion: true,
        initialModelCatalog: { status: "verified" as const, models: ["mistral/zai-glm-5-3-flash"] },
      }),
    )
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 20))
      await wide.renderOnce()
      if (wide.captureCharFrame().includes("flow (4)")) break
    }

    // 1. Browser topbar has active arch around Catalog and NO numeric prefixes ("1 Catalog", "2 Flows", "3 Sources")
    const catalogFrame = wide.captureCharFrame()
    assert.equal(catalogFrame.includes("│ ● Catalog │"), true)
    assert.equal(catalogFrame.includes("1 Catalog"), false)
    assert.equal(catalogFrame.includes("2 Flows"), false)
    assert.equal(catalogFrame.includes("3 Sources"), false)
    assert.equal(catalogFrame.includes("⇧→ Sidebar"), true)

    // 2. Shift+Right focuses Catalog Sidebar (Inspector); Right arrow switches Inspector tab; Escape returns to Main panel
    await press(wide.renderer, wide.renderOnce, "right", "", { shift: true })
    assert.equal(wide.captureCharFrame().includes("● Inspector · ◀/▶ Tab"), true)
    assert.equal(wide.captureCharFrame().includes("⇧← Main"), true)
    await press(wide.renderer, wide.renderOnce, "escape")
    assert.equal(wide.captureCharFrame().includes("● Catalog (1 packs · 4 agents)"), true)

    // 3. Expand pack, focus flow-build, press 5 (Graph tab in sidebar), Shift+Right into sidebar, Down to @flow-eye, Enter jumps to flow-eye!
    await press(wide.renderer, wide.renderOnce, "return", "\r")
    await press(wide.renderer, wide.renderOnce, "down") // flow-build
    await press(wide.renderer, wide.renderOnce, "5", "5")
    await press(wide.renderer, wide.renderOnce, "right", "", { shift: true })
    await press(wide.renderer, wide.renderOnce, "down") // @flow-eye
    assert.equal(wide.captureCharFrame().includes("▎ ├─▶ @flow-eye [Enter: Jump]"), true)
    await press(wide.renderer, wide.renderOnce, "return", "\r")
    assert.equal(wide.captureCharFrame().includes("Row 4/5"), true, "Enter in Graph sidebar jumped Catalog focus to flow-eye")

    // 4. Tab switches to Flows & Graph browser tab; Shift+Right focuses Topology sidebar; Down selects #2 IF opencode/*; Enter opens PackFlowsModal on branch #2!
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    const flowsFrame = wide.captureCharFrame()
    assert.equal(flowsFrame.includes("│ ● Flows & Graph │"), true)
    await press(wide.renderer, wide.renderOnce, "right", "", { shift: true })
    assert.equal(wide.captureCharFrame().includes("● Topology & IF/OR Rules"), true)
    await press(wide.renderer, wide.renderOnce, "down") // second IF rule: opencode/*
    await press(wide.renderer, wide.renderOnce, "return", "\r")

    const modalFrame = wide.captureCharFrame()
    assert.equal(modalFrame.includes("IF Branches (2)"), true)
    assert.equal(modalFrame.includes("▎ #2 IF opencode/*"), true, "Modal opened pre-focused on branch #2 selected in sidebar")
    assert.equal(modalFrame.includes("◉ CALLERS (OR)"), true)
    assert.equal(modalFrame.includes("SUBAGENT DEPENDENCIES (2)"), true)
    assert.equal(modalFrame.includes("├─ @explore"), true)
    assert.equal(modalFrame.includes("╰─ @eye"), true)
    await press(wide.renderer, wide.renderOnce, "escape")

    // 5. Tab switches to Sources & Target browser tab; Shift+Right focuses OpenCode Target Status sidebar
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    assert.equal(wide.captureCharFrame().includes("│ ● Sources & Target │"), true)
    await press(wide.renderer, wide.renderOnce, "right", "", { shift: true })
    assert.equal(wide.captureCharFrame().includes("● 🎯 OpenCode Target Status"), true)

    // 6. Compact 80x24 PackFlowsModal renders single-column fallback cleanly with spacing intact
    const compact = await createTestRenderer({ width: 80, height: 24 })
    compactRenderer = compact.renderer
    createRoot(compact.renderer).render(
      React.createElement(App, {
        workspaceRoot: tmp,
        listShare: 2 / 3,
        reducedMotion: true,
      }),
    )
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 20))
      await compact.renderOnce()
      if (compact.captureCharFrame().includes("flow (4)")) break
    }
    await press(compact.renderer, compact.renderOnce, "m", "m")
    const compactModalFrame = compact.captureCharFrame()
    assert.equal(compactModalFrame.includes("[C] Edit Callers"), true)
    assert.equal(compactModalFrame.includes("[manifest[C]"), false, "Header badges must never collide at 80x24")
    assert.equal(compactModalFrame.includes("#1 IF mistral/*"), true)
    assert.equal(compactModalFrame.includes("[ESC] Close"), true)
  } finally {
    try { wideRenderer?.destroy() } catch {}
    try { compactRenderer?.destroy() } catch {}
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevXdgCache
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("search mode is cleared when switching workspace tabs and no longer intercepts keys", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tui-search-tab-"))
  const prevXdgConfig = process.env.XDG_CONFIG_HOME
  const prevXdgCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config")
  process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache")
  const packDir = path.join(tmp, "packs", "demo")
  fs.mkdirSync(path.join(packDir, "agents"), { recursive: true })
  fs.writeFileSync(path.join(packDir, "opencode-pack.json"), JSON.stringify({ contract: "1.0", name: "demo", version: "1.0.0", description: "demo pack" }))
  fs.writeFileSync(path.join(packDir, "agents", "demo-agent.md"), "---\ndescription: Demo agent\nmode: subagent\n---\nDemo prompt.\n")

  const press = async (renderer: any, renderOnce: () => Promise<void>, name: string, sequence = name.length === 1 ? name : "") => {
    renderer.keyInput.emit("keypress", { name, sequence, ctrl: false, meta: false, shift: false })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 14))
    await renderOnce()
  }

  let rendererInstance: any
  try {
    const { renderer, mockMouse, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 30 })
    rendererInstance = renderer
    createRoot(renderer).render(React.createElement(App, { workspaceRoot: tmp, listShare: 2 / 3, reducedMotion: true }))
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await renderOnce()
      if (captureCharFrame().includes("demo (1)")) break
    }

    await press(renderer, renderOnce, "/", "/")
    assert.equal(captureCharFrame().includes("/▋"), true)
    const frameRows = captureCharFrame().split("\n")
    const topbarRowIndex = frameRows.findIndex(row => row.includes("manage-agents"))
    await mockMouse.click(frameRows[topbarRowIndex]!.indexOf("Flows") + 2, topbarRowIndex)
    await renderOnce()
    assert.equal(captureCharFrame().includes("Flows"), true)
    await press(renderer, renderOnce, "?", "?")
    assert.equal(captureCharFrame().includes("Keyboard & Mouse Guide"), true, `search mode must not consume keys after leaving Catalog:\n${captureCharFrame()}`)
  } finally {
    try { rendererInstance?.destroy() } catch {}
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevXdgCache
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("Bridge modal generation preserves the configured Claude catch-all model mapping", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tui-bridge-model-map-"))
  const prevXdgConfig = process.env.XDG_CONFIG_HOME
  const prevXdgCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config")
  process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache")
  const packDir = path.join(tmp, "packs", "demo")
  fs.mkdirSync(path.join(packDir, "agents"), { recursive: true })
  fs.writeFileSync(path.join(packDir, "opencode-pack.json"), JSON.stringify({ contract: "1.0", name: "demo", version: "1.0.0", description: "demo pack" }))
  fs.writeFileSync(path.join(packDir, "agents", "demo-agent.md"), "---\ndescription: Demo agent\nmode: subagent\n---\nDemo prompt.\n")
  const configPath = translationConfigPath(tmp)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    ...DEFAULT_TRANSLATION_CONFIG,
    claude: { ...DEFAULT_TRANSLATION_CONFIG.claude, modelMap: { "*": "sonnet" }, autoValidate: false, autoRegister: false },
  }))

  const press = async (renderer: any, renderOnce: () => Promise<void>, name: string, sequence = name.length === 1 ? name : "") => {
    renderer.keyInput.emit("keypress", { name, sequence, ctrl: false, meta: false, shift: false })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 14))
    await renderOnce()
  }

  let rendererInstance: any
  try {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 30 })
    rendererInstance = renderer
    createRoot(renderer).render(React.createElement(App, { workspaceRoot: tmp, listShare: 2 / 3, reducedMotion: true }))
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await renderOnce()
      if (captureCharFrame().includes("demo (1)")) break
    }

    await press(renderer, renderOnce, "b", "b")
    for (const char of "preserve-map") await press(renderer, renderOnce, char, char)
    await press(renderer, renderOnce, "tab", "\t")
    await press(renderer, renderOnce, "tab", "\t")
    await press(renderer, renderOnce, "return", "\r")

    const savedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"))
    assert.equal(savedConfig.claude.modelMap["*"], "sonnet")
  } finally {
    try { rendererInstance?.destroy() } catch {}
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevXdgCache
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("untrusted executable bridge content requires confirmation and cancellation writes nothing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tui-bridge-confirm-"))
  const prevXdgConfig = process.env.XDG_CONFIG_HOME
  const prevXdgCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config")
  process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache")
  const packDir = path.join(tmp, "packs", "demo")
  fs.mkdirSync(path.join(packDir, "agents"), { recursive: true })
  fs.writeFileSync(path.join(packDir, "opencode-pack.json"), JSON.stringify({ contract: "1.0", name: "demo", version: "1.0.0", description: "demo pack" }))
  fs.writeFileSync(path.join(packDir, "agents", "demo-agent.md"), "---\ndescription: Demo agent\nmode: subagent\n---\nDemo prompt.\n")
  fs.writeFileSync(path.join(packDir, "opencode.json"), JSON.stringify({ mcp: { servers: { local_cmd: { type: "local", command: ["echo", "hi"] } } } }))

  const press = async (renderer: any, renderOnce: () => Promise<void>, name: string, sequence = name.length === 1 ? name : "") => {
    renderer.keyInput.emit("keypress", { name, sequence, ctrl: false, meta: false, shift: false })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 14))
    await renderOnce()
  }

  let rendererInstance: any
  try {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 30 })
    rendererInstance = renderer
    createRoot(renderer).render(React.createElement(App, { workspaceRoot: tmp, listShare: 2 / 3, reducedMotion: true }))
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await renderOnce()
      if (captureCharFrame().includes("demo (1)")) break
    }

    await press(renderer, renderOnce, "b", "b")
    for (const char of "untrusted-bridge") await press(renderer, renderOnce, char, char)
    await press(renderer, renderOnce, "tab", "\t")
    await press(renderer, renderOnce, "tab", "\t")
    await press(renderer, renderOnce, "return", "\r")

    const confirmFrame = captureCharFrame()
    assert.equal(confirmFrame.includes("Confirm Executable Bridge Content"), true)
    assert.equal(confirmFrame.includes("contains executable content"), true)
    const outputDir = path.join(tmp, "bridges", "claude-code", "untrusted-bridge")
    assert.equal(fs.existsSync(outputDir), false, "bridge output must not be written before trust confirmation")
    assert.equal(fs.existsSync(translationConfigPath(tmp)), false, "translation config must not be written before trust confirmation")

    await press(renderer, renderOnce, "n", "n")
    assert.equal(captureCharFrame().includes("Bridge to Claude Code"), true)
    assert.equal(fs.existsSync(outputDir), false, "cancelling must leave the bridge output absent")
    assert.equal(fs.existsSync(translationConfigPath(tmp)), false, "cancelling must leave the translation config absent")
  } finally {
    try { rendererInstance?.destroy() } catch {}
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevXdgCache
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("PackFlowsModal MCP toggle writes the target-scope config override and reflects [ON]/[OFF] without mouse", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tui-mcp-toggle-"))
  const prevXdgConfig = process.env.XDG_CONFIG_HOME
  const prevXdgCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config")
  process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache")
  const packDir = path.join(tmp, "packs", "mcppack")
  fs.mkdirSync(path.join(packDir, "agents"), { recursive: true })
  fs.writeFileSync(path.join(packDir, "opencode-pack.json"), JSON.stringify({ contract: "1.0", name: "mcppack", version: "1.0.0", description: "pack with an MCP server" }))
  fs.writeFileSync(path.join(packDir, "opencode.json"), JSON.stringify({ mcp: { servers: { cupertino: { type: "local", command: ["cupertino-mcp"], disabled: true } } } }))
  fs.writeFileSync(path.join(packDir, "agents", "mcppack-helper.md"), "---\ndescription: Helper agent\nmode: primary\n---\nHelp.\n")

  const press = async (renderer: any, renderOnce: () => Promise<void>, name: string, sequence = name.length === 1 ? name : "") => {
    renderer.keyInput.emit("keypress", { name, sequence, ctrl: false, meta: false, shift: false })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 14))
    await renderOnce()
  }
  const waitUntil = async (renderOnce: () => Promise<void>, frame: () => string, predicate: (text: string) => boolean) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await renderOnce()
      if (predicate(frame())) return
    }
  }

  const overridesPath = path.join(process.env.XDG_CONFIG_HOME!, "manage-agents", "overrides.json")
  const readTargetOverride = (): Record<string, unknown> | undefined => {
    if (!fs.existsSync(overridesPath)) return undefined
    const saved = JSON.parse(fs.readFileSync(overridesPath, "utf8"))
    const [scopeKey] = Object.keys(saved.targets ?? {})
    assert.match(scopeKey, /opencode$/, "the toggle writes to the default OpenCode target scope, like the CLI without --global")
    return saved.targets[scopeKey].mcppack.config
  }

  let rendererInstance: any
  try {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 136, height: 34 })
    rendererInstance = renderer
    createRoot(renderer).render(React.createElement(App, {
      workspaceRoot: tmp,
      listShare: 2 / 3,
      reducedMotion: true,
      initialModelCatalog: { status: "unverified" as const, models: [] },
    }))
    await waitUntil(renderOnce, captureCharFrame, frame => frame.includes("mcppack (1)"))

    // Open the pack detail: Tab switches to Flows & Graph; Enter opens PackFlowsModal on the pack row.
    await press(renderer, renderOnce, "tab", "\t")
    await waitUntil(renderOnce, captureCharFrame, frame => frame.includes("Flows & Graph"))
    await press(renderer, renderOnce, "return", "\r")
    await waitUntil(renderOnce, captureCharFrame, frame => frame.includes("MCP cupertino"))
    assert.equal(captureCharFrame().includes("[OFF]"), true, "the pack ships the server disabled and no override exists yet")
    assert.equal(readTargetOverride(), undefined, "nothing written yet")

    // Focus the MCP row with the keyboard and toggle.
    await press(renderer, renderOnce, "down")
    assert.equal(captureCharFrame().includes("▎ ⚡ MCP cupertino"), true, "keyboard focus lands on the MCP toggle row")
    await press(renderer, renderOnce, "t", "t")
    await waitUntil(renderOnce, captureCharFrame, frame => frame.includes("[ON]"))
    assert.deepEqual(readTargetOverride(), { "mcp.servers": { cupertino: { disabled: null } } }, "enabling removes the field from the contributed entry")

    // Toggle back off from the same row.
    await press(renderer, renderOnce, "t", "t")
    await waitUntil(renderOnce, captureCharFrame, frame => frame.includes("[OFF]"))
    assert.deepEqual(readTargetOverride(), { "mcp.servers": { cupertino: { disabled: true } } }, "disabling writes disabled: true into the target-scope override")

    // Escape closes the modal; the override stays saved for the next reconcile/bridge export.
    await press(renderer, renderOnce, "escape")
    await waitUntil(renderOnce, captureCharFrame, frame => !frame.includes("MCP cupertino"))
    assert.equal(fs.existsSync(overridesPath), true)
  } finally {
    try { rendererInstance?.destroy() } catch {}
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevXdgCache
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})


test("Sources opens a mixed-layout catalog and installs a command-only pack by manifest name", async t => {
  const tmp = tempDir(t, "ma-catalog-ui-")
  const previousConfig = process.env.XDG_CONFIG_HOME
  const previousCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CONFIG_HOME = path.join(tmp, "config")
  process.env.XDG_CACHE_HOME = path.join(tmp, "cache")
  t.after(() => {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfig
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
  })
  const catalog = path.join(tmp, "notebook")
  const command = "---\ndescription: Index a volume\n---\nIndex $ARGUMENTS.\n"
  writePack(path.join(catalog, "library", "volumes"), { "commands/index.md": command }, { name: "archive" })
  writePack(path.join(catalog, "packs", "team"), { "agents/editor.md": "---\ndescription: Editor\nmode: primary\n---\nEdit.\n" }, { name: "editors" })
  const ui = await createTestRenderer({ width: 130, height: 36 })
  t.after(() => ui.renderer.destroy())
  createRoot(ui.renderer).render(React.createElement(App, { reducedMotion: true, initialModelCatalog: { status: "verified", models: [] } }))
  const waitFor = async (label: string) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 15))
      await ui.renderOnce()
      if (ui.captureCharFrame().includes(label)) return
    }
    assert.fail(`Missing ${label} in frame:\n${ui.captureCharFrame()}`)
  }
  const press = async (name: string) => {
    ui.renderer.keyInput.emit("keypress", { name, sequence: name === "return" ? "\r" : name.length === 1 ? name : "", ctrl: false, meta: false, shift: false } as any)
    await new Promise(resolve => setTimeout(resolve, 20))
    await ui.renderOnce()
  }
  await waitFor("GitHub Discovery")
  await new Promise(resolve => setTimeout(resolve, 30))
  await press("/")
  await ui.mockInput.pasteBracketedText(catalog)
  await waitFor("notebook")
  await press("return")
  await waitFor("archive (0)")
  assert.equal(loadSources().active, "notebook")
  assert.ok(ui.captureCharFrame().includes("editors (1)"))
  await press("d")
  await waitFor("Pack Doctor & Authoring · archive@1.0.0")
  assert.ok(ui.captureCharFrame().includes("archive"))
  await press("escape")
  await press("e")
  await waitFor("Install 'archive'")
  const installed = path.join(process.env.XDG_CONFIG_HOME, "opencode", "commands", "index.md")
  await press("escape")
  assert.equal(fs.existsSync(installed), false)
  await press("e")
  await waitFor("Install 'archive'")
  await press("y")
  await waitFor("Install Complete")
  assert.equal(fs.readFileSync(installed, "utf8"), command)
})
