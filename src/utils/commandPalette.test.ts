import test from "node:test"
import assert from "node:assert/strict"
import { buildContextualShortcuts, filterPaletteCommands, type PaletteCommand } from "./commandPalette.js"

const SAMPLE_COMMANDS: PaletteCommand[] = [
  { id: "model", label: "Change Agent Model", category: "Agent", shortcut: "M", keywords: ["llm", "provider"] },
  { id: "flows", label: "Edit Conditional IF/OR Flows", category: "Pack", shortcut: "M", keywords: ["routing", "rules"] },
  { id: "resources", label: "Manage Skills, Tools & MCP", category: "Agent", shortcut: "U", keywords: ["mcp", "permissions"] },
  { id: "disabled", label: "Rename Agent", category: "Agent", shortcut: "R", disabled: true },
  { id: "jump-plan", label: "flow-plan", category: "Jump to Agent", hint: "flow · anthropic/claude-opus-4-6" },
]

test("filterPaletteCommands excludes disabled items and ranks exact and prefix matches first", () => {
  const all = filterPaletteCommands(SAMPLE_COMMANDS, "")
  assert.equal(all.some(cmd => cmd.id === "disabled"), false)
  assert.equal(all.length, 4)

  const byKeyword = filterPaletteCommands(SAMPLE_COMMANDS, "mcp")
  assert.equal(byKeyword[0]?.id, "resources")

  const byAgent = filterPaletteCommands(SAMPLE_COMMANDS, "flow-plan")
  assert.equal(byAgent[0]?.id, "jump-plan")

  const fuzzy = filterPaletteCommands(SAMPLE_COMMANDS, "cifor")
  assert.equal(fuzzy[0]?.id, "flows")
})

test("buildContextualShortcuts adapts actions to workspace tab and focused item type", () => {
  const folderShortcuts = buildContextualShortcuts({
    workspaceTab: "catalog",
    itemType: "folder",
    selectedCount: 0,
    isVirtualPack: true,
    isReadOnlyGitSource: false,
  })
  assert.ok(folderShortcuts.some(chip => chip.actionId === "pack-flows"))
  assert.ok(folderShortcuts.some(chip => chip.actionId === "pack-init" && chip.label === "Onboard Pack"))
  assert.ok(folderShortcuts.some(chip => chip.actionId === "palette"))

  const gitVirtualShortcuts = buildContextualShortcuts({
    workspaceTab: "catalog",
    itemType: "folder",
    selectedCount: 0,
    isVirtualPack: true,
    isReadOnlyGitSource: true,
  })
  assert.ok(gitVirtualShortcuts.some(chip => chip.actionId === "pack-init" && chip.label === "Clone & Onboard"))

  const localPackShortcuts = buildContextualShortcuts({
    workspaceTab: "catalog",
    itemType: "folder",
    selectedCount: 0,
    isVirtualPack: false,
    isReadOnlyGitSource: false,
  })
  assert.ok(localPackShortcuts.some(chip => chip.actionId === "pack-doctor"))
  assert.ok(localPackShortcuts.some(chip => chip.actionId === "pack-scaffold"))

  const agentShortcuts = buildContextualShortcuts({
    workspaceTab: "catalog",
    itemType: "file",
    selectedCount: 2,
    hasInvalidModels: true,
  })
  assert.ok(agentShortcuts.some(chip => chip.label === "Mark (2)"))
  assert.ok(agentShortcuts.some(chip => chip.actionId === "repair-models"))

  const sourcesShortcuts = buildContextualShortcuts({
    workspaceTab: "sources",
    selectedCount: 0,
    showInspector: true,
    activePane: "inspector",
  })
  assert.ok(sourcesShortcuts.some(chip => chip.actionId === "target-reconcile"))
  assert.ok(sourcesShortcuts.some(chip => chip.actionId === "pane-toggle" && chip.key === "⇧←" && chip.label === "Main"))
})
