import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import React from "react"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { App } from "../App.js"
import type { AgentInfo } from "./agents.js"
import {
  buildPackBridgePreview,
  cloneBridgeTiers,
  collectBridgeablePacks,
  cycleAgentRoleTier,
  deriveBridgePrefix,
  filterBridgePacks,
  initialBridgeModelCatchAll,
  reconcileBridgePackQuery,
  resolveInitialBridgePack,
  stepBridgeField,
  stepBridgePackSelection,
  validateDraftBridgeTiers,
} from "./bridgePrompt.js"
import { DEFAULT_TRANSLATION_CONFIG } from "./translationConfig.js"

const AGENTS = [
  { category: "slides" },
  { category: "flow" },
  { category: "flow" },
  { category: "pipeline" },
  { category: "pipeline" },
  { category: "pipeline" },
  { category: "docs" },
  { category: "unpacked" },
]

function mockAgent(filename: string, category: string, model = "anthropic/claude-sonnet-4-5"): AgentInfo {
  return {
    filename,
    currentPath: `/tmp/${category}/${filename}`,
    targetPath: `/tmp/${category}/${filename}`,
    category,
    description: filename,
    model,
    rawContent: `---\ndescription: ${filename}\nmodel: ${model}\n---\n`,
    frontmatter: { description: filename, model },
    body: "",
    allowedSubagents: [],
  }
}

test("collectBridgeablePacks filters non-pack categories and sorts valid packs with counts", () => {
  const packs = collectBridgeablePacks(AGENTS, pack => pack !== "unpacked")
  assert.deepEqual(packs, [
    { pack: "docs", count: 1 },
    { pack: "flow", count: 2 },
    { pack: "pipeline", count: 3 },
    { pack: "slides", count: 1 },
  ])
})

test("resolveInitialBridgePack suggests focused pack without pre-filling query so all packs stay selectable", () => {
  const packs = collectBridgeablePacks(AGENTS, pack => pack !== "unpacked")
  const initial = resolveInitialBridgePack(packs, "pipeline", 2)

  assert.equal(initial.query, "")
  assert.equal(initial.selectedPack, "pipeline")
  assert.equal(initial.index, 2)
  assert.equal(initial.scrollOffset, 1)
  assert.equal(filterBridgePacks(packs, initial.query).length, 4)
})

test("resolveInitialBridgePack falls back to first pack when focused category is not bridgeable", () => {
  const packs = collectBridgeablePacks(AGENTS, pack => pack !== "unpacked")
  const initial = resolveInitialBridgePack(packs, "unpacked", 5)

  assert.equal(initial.query, "")
  assert.equal(initial.selectedPack, "docs")
  assert.equal(initial.index, 0)
})

test("stepBridgePackSelection cycles freely across all packs with up and down arrows", () => {
  const packs = collectBridgeablePacks(AGENTS, pack => pack !== "unpacked")
  const initial = resolveInitialBridgePack(packs, "flow", 2)

  const down1 = stepBridgePackSelection(packs, initial.index, 1, initial.scrollOffset, 2)
  assert.equal(down1.selectedPack, "pipeline")
  assert.equal(down1.index, 2)
  assert.equal(down1.scrollOffset, 1)

  const down2 = stepBridgePackSelection(packs, down1.index, 1, down1.scrollOffset, 2)
  assert.equal(down2.selectedPack, "slides")
  assert.equal(down2.index, 3)

  const wrapTop = stepBridgePackSelection(packs, down2.index, 1, down2.scrollOffset, 2)
  assert.equal(wrapTop.selectedPack, "docs")
  assert.equal(wrapTop.index, 0)
  assert.equal(wrapTop.scrollOffset, 0)

  const wrapBottom = stepBridgePackSelection(packs, wrapTop.index, -1, wrapTop.scrollOffset, 2)
  assert.equal(wrapBottom.selectedPack, "slides")
  assert.equal(wrapBottom.index, 3)
  assert.equal(wrapBottom.scrollOffset, 2)
})

test("reconcileBridgePackQuery filters by typed text and restores full list when cleared", () => {
  const packs = collectBridgeablePacks(AGENTS, pack => pack !== "unpacked")

  const narrowed = reconcileBridgePackQuery(packs, "SLI", "flow", 5)
  assert.equal(narrowed.selectedPack, "slides")
  assert.equal(narrowed.index, 0)

  const cleared = reconcileBridgePackQuery(packs, "", narrowed.selectedPack, 5)
  assert.equal(cleared.selectedPack, "slides")
  assert.equal(cleared.index, 3)

  const empty = reconcileBridgePackQuery(packs, "missing", "slides", 5)
  assert.equal(empty.selectedPack, "")
  assert.equal(empty.index, 0)
})

test("stepBridgeField cycles target-appropriate sections for claude and codex", () => {
  assert.equal(stepBridgeField("name", false, "claude"), "pack")
  assert.equal(stepBridgeField("pack", false, "claude"), "tiers")
  assert.equal(stepBridgeField("tiers", false, "claude"), "agents")
  assert.equal(stepBridgeField("agents", false, "claude"), "model")
  assert.equal(stepBridgeField("model", false, "claude"), "name")
  assert.equal(stepBridgeField("name", true, "claude"), "model")

  assert.equal(stepBridgeField("tiers", false, "codex"), "effort")
  assert.equal(stepBridgeField("effort", false, "codex"), "agents")
})

test("deriveBridgePrefix appends trailing dash for non-empty packs", () => {
  assert.equal(deriveBridgePrefix("flow"), "flow-")
  assert.equal(deriveBridgePrefix("  pipeline  "), "pipeline-")
  assert.equal(deriveBridgePrefix(""), "")
})

test("initialBridgeModelCatchAll reads the target model map wildcard", () => {
  const config = {
    ...DEFAULT_TRANSLATION_CONFIG,
    claude: { ...DEFAULT_TRANSLATION_CONFIG.claude, modelMap: { "*": " sonnet " } },
    codex: { ...DEFAULT_TRANSLATION_CONFIG.codex, modelMap: { "*": " gpt-5.6-sol " } },
  }

  assert.equal(initialBridgeModelCatchAll(config, "claude"), "sonnet")
  assert.equal(initialBridgeModelCatchAll(config, "codex"), "gpt-5.6-sol")
  assert.equal(initialBridgeModelCatchAll(DEFAULT_TRANSLATION_CONFIG, "claude"), "")
  assert.equal(initialBridgeModelCatchAll(undefined, "codex"), "")
})

test("buildPackBridgePreview resolves role, inferred, default and catch-all mappings and reacts to tier edits", () => {
  const agents = [
    mockAgent("flow-planner.md", "flow", "anthropic/claude-opus-4-6"),
    mockAgent("flow-explorer.md", "flow", "anthropic/claude-haiku-4-5"),
    mockAgent("flow-scout.md", "flow", "anthropic/claude-haiku-4-5"),
    mockAgent("flow-build.md", "flow", "openai/gpt-4o"),
    mockAgent("slides-writer.md", "slides", "openai/gpt-4o"),
  ]
  const tiers = cloneBridgeTiers(DEFAULT_TRANSLATION_CONFIG.tiers)
  const roles = { ...DEFAULT_TRANSLATION_CONFIG.roles }

  const initial = buildPackBridgePreview(agents, DEFAULT_TRANSLATION_CONFIG, {
    target: "claude",
    pack: "flow",
    tiers,
    roles,
    modelCatchAll: "",
  })

  assert.deepEqual(
    initial.items.map(i => [i.strippedName, i.tier, i.targetModel, i.source]),
    [
      ["build", "execution", "sonnet", "default"],
      ["explorer", "light", "haiku", "role"],
      ["planner", "planning", "opus", "role"],
      ["scout", "light", "haiku", "inferred"],
    ],
  )
  assert.deepEqual(initial.tierCounts, { execution: 1, light: 2, planning: 1 })

  // Reassign 'build' role to 'planning' and edit 'planning' model -> live preview updates
  const reassigned = cycleAgentRoleTier(roles, "build", Object.keys(tiers), "execution", -1)
  assert.equal(reassigned.nextTier, "planning")
  tiers.planning.claude.model = "claude-opus-4-6"

  const updated = buildPackBridgePreview(agents, DEFAULT_TRANSLATION_CONFIG, {
    target: "claude",
    pack: "flow",
    tiers,
    roles: reassigned.roles,
    modelCatchAll: "",
  })
  assert.deepEqual(updated.items[0].tier, "planning")
  assert.deepEqual(updated.items[0].targetModel, "claude-opus-4-6")
  assert.deepEqual(updated.items[0].source, "role")

  // Catch-all '*' overrides tier models with 'model-map' source
  const catchAll = buildPackBridgePreview(agents, DEFAULT_TRANSLATION_CONFIG, {
    target: "claude",
    pack: "flow",
    tiers,
    roles: reassigned.roles,
    modelCatchAll: "haiku",
  })
  assert.equal(catchAll.items.every(i => i.targetModel === "haiku" && i.source === "model-map"), true)

  // Validation catches invalid Claude model names
  tiers.planning.claude.model = "not-a-claude-model"
  assert.throws(() => validateDraftBridgeTiers(tiers, "claude"), /Invalid Claude model/)
})

test("Bridge modal renders HTML-style placeholders, live pack mapping, inline tier editing, Ctrl+S save, and fits 80x24", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tui-bridge-"))
  const prevXdgConfig = process.env.XDG_CONFIG_HOME
  const prevXdgCache = process.env.XDG_CACHE_HOME

  const press = async (renderer: any, renderOnce: () => Promise<void>, name: string, sequence = name.length === 1 ? name : "", opts: any = {}) => {
    renderer.keyInput.emit("keypress", { name, sequence, ctrl: false, meta: false, shift: false, ...opts })
    await new Promise(r => setImmediate(r))
    await new Promise(r => setTimeout(r, 14))
    await renderOnce()
  }

  let wideRenderer: any
  let compactRenderer: any
  try {
    process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config")
    process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache")

    for (const [pack, role] of [["alpha", "lead"], ["flow", "build"], ["slides", "writer"]] as const) {
      const dir = path.join(tmp, "packs", pack)
      fs.mkdirSync(path.join(dir, "agents"), { recursive: true })
      fs.writeFileSync(
        path.join(dir, "opencode-pack.json"),
        JSON.stringify({ contract: "1.0", name: pack, version: "1.0.0", description: `${pack} pack` }),
      )
      fs.writeFileSync(
        path.join(dir, "agents", `${pack}-${role}.md`),
        `---\ndescription: ${pack} ${role}\nmodel: openai/gpt-4o\nmode: primary\n---\n\n${pack} prompt.\n`,
      )
    }

    const mockCatalog = { status: "verified" as const, models: ["openai/gpt-4o"], variants: {} }
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
      if (wide.captureCharFrame().includes("Row 1/3")) break
    }

    // Focus second pack ('flow') and open Codex Bridge (Shift+B)
    await press(wide.renderer, wide.renderOnce, "down")
    await press(wide.renderer, wide.renderOnce, "b", "B", { shift: true })
    const openFrame = wide.captureCharFrame()

    assert.equal(openFrame.includes("decent-pipeline"), false, "Bridge modal must not pre-insert decent-pipeline")
    assert.equal(openFrame.includes("pipeline-"), false, "Bridge modal must not pre-insert pipeline- prefix")
    assert.equal(openFrame.includes("▎ Plugin Name:  insert name"), true, "HTML-style placeholder must sit inside the Plugin Name input line")
    assert.equal(openFrame.includes("flow  (1 agents) · current"), true, "Pack field should suggest the pack under the user's cursor")
    assert.equal(openFrame.includes("Pack 'flow' Mapping (1)"), true, "Live mapping panel should show the focused pack's agents")
    assert.equal(openFrame.includes("[execution] → gpt-5.6-luna:max"), true, "Live mapping should show resolved tier and Codex model+effort")

    // Tab to Pack -> all packs are visible and ↓ selects 'slides', immediately updating the right-hand mapping preview
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    const packFocusFrame = wide.captureCharFrame()
    assert.equal(packFocusFrame.includes("alpha  (1 agents)"), true)
    assert.equal(packFocusFrame.includes("▎ flow  (1 agents) · current"), true)
    assert.equal(packFocusFrame.includes("slides  (1 agents)"), true)

    await press(wide.renderer, wide.renderOnce, "down")
    const movedPackFrame = wide.captureCharFrame()
    assert.equal(movedPackFrame.includes("▎ slides  (1 agents)"), true)
    assert.equal(movedPackFrame.includes("Pack 'slides' Mapping (1)"), true, "Right-hand mapping preview must follow selected pack live")
    assert.equal(movedPackFrame.includes("writer"), true, "Stripped agent 'writer' from slides-writer.md must appear in preview")

    // Tab -> Tiers (Codex model), Tab -> Effort: change 'planning' effort from 'high' to 'xhigh'
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    await press(wide.renderer, wide.renderOnce, "right")
    assert.equal(wide.captureCharFrame().includes("xhigh"), true, "Codex effort for planning should cycle to xhigh")

    // Tab -> Agents (live mapping): press Left to cycle 'writer' from 'execution' -> 'planning'
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    await press(wide.renderer, wide.renderOnce, "left")
    const reassignedFrame = wide.captureCharFrame()
    assert.equal(reassignedFrame.includes("[planning] → gpt-5.6-sol:xhigh role"), true, "Reassigned agent must immediately show planning tier + updated xhigh effort")

    // Save tiers standalone via Ctrl+S
    await press(wide.renderer, wide.renderOnce, "s", "\x13", { ctrl: true })
    const savedCfg = JSON.parse(fs.readFileSync(path.join(tmp, "bridges", "translation-config.json"), "utf8"))
    assert.equal(savedCfg.roles.writer, "planning")
    assert.equal(savedCfg.tiers.planning.codex.reasoningEffort, "xhigh")

    // Tab -> Map all to -> Tab -> Plugin Name: typing replaces placeholder 'insert name', Enter generates Codex bridge
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    await press(wide.renderer, wide.renderOnce, "tab", "\t")
    for (const ch of "slides-layer") {
      await press(wide.renderer, wide.renderOnce, ch, ch)
    }
    assert.equal(wide.captureCharFrame().includes("insert name"), false, "HTML-style placeholder must vanish once text is typed")
    await press(wide.renderer, wide.renderOnce, "return", "\r")

    const doneFrame = wide.captureCharFrame()
    assert.equal(doneFrame.includes("Bridge to Codex Complete"), true, doneFrame)
    const writerToml = fs.readFileSync(path.join(tmp, "bridges", "codex", "slides-layer", ".codex", "agents", "writer.toml"), "utf8")
    assert.match(writerToml, /model = "gpt-5\.6-sol"/)
    assert.match(writerToml, /model_reasoning_effort = "xhigh"/)

    // Verify 80x24 compact viewport with Claude bridge ('b') shows inline placeholders, tiers, mapping, and footer without clipping
    const compact = await createTestRenderer({ width: 80, height: 24 })
    compactRenderer = compact.renderer
    createRoot(compact.renderer).render(
      React.createElement(App, {
        workspaceRoot: tmp,
        listShare: 2 / 3,
        reducedMotion: true,
        initialModelCatalog: mockCatalog,
      }),
    )
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 20))
      await compact.renderOnce()
      if (compact.captureCharFrame().includes("Row 1/3")) break
    }
    await press(compact.renderer, compact.renderOnce, "b", "b")
    await press(compact.renderer, compact.renderOnce, "tab", "\t")
    const compactFrame = compact.captureCharFrame()
    assert.equal(compactFrame.includes("insert name"), true, "80x24 must show inline Plugin Name placeholder")
    assert.equal(compactFrame.includes("▎ Pack:"), true, "80x24 must keep Pack selector visible")
    assert.equal(compactFrame.includes("Tiers (claude):"), true, "80x24 must keep Tiers editor visible")
    assert.equal(compactFrame.includes("empty = tier mapping"), true, "80x24 must show inline Map-all placeholder")
    assert.equal(compactFrame.includes("Mapping 'alpha'"), true, "80x24 must keep live pack mapping visible")
    assert.equal(compactFrame.includes("[ESC] Cancel"), true, "80x24 must keep modal footer visible without clipping")
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
