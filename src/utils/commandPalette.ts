import { terminalSafeText } from "./terminalText.js"

export type WorkspaceTab = "catalog" | "flows" | "sources"

export interface PaletteCommand {
  id: string
  label: string
  category: "Workspace" | "Agent" | "Pack" | "Target & Bridges" | "View & Motion" | "Jump to Agent"
  shortcut?: string
  keywords?: string[]
  hint?: string
  disabled?: boolean
}

export interface ShortcutChip {
  key: string
  label: string
  actionId: string
  accent?: boolean
}

export interface ShortcutContext {
  workspaceTab: WorkspaceTab
  itemType?: "file" | "folder" | null
  selectedCount: number
  isVirtualPack?: boolean
  isReadOnlyGitSource?: boolean
  hasInvalidModels?: boolean
  activePane?: "list" | "inspector"
  showInspector?: boolean
}

function scoreMatch(text: string, query: string): number {
  if (!query) return 1
  const lower = text.toLowerCase()
  if (lower === query) return 200
  if (lower.startsWith(query)) return 150 - Math.min(30, lower.length - query.length)
  const wordBoundaryIndex = lower.indexOf(` ${query}`)
  if (wordBoundaryIndex !== -1) return 120 - Math.min(25, wordBoundaryIndex)
  const dashBoundaryIndex = lower.indexOf(`-${query}`)
  if (dashBoundaryIndex !== -1) return 115 - Math.min(25, dashBoundaryIndex)
  const substringIndex = lower.indexOf(query)
  if (substringIndex !== -1) return 95 - Math.min(30, substringIndex)

  let qIdx = 0
  let consecutive = 0
  let score = 0
  for (let i = 0; i < lower.length && qIdx < query.length; i++) {
    if (lower[i] === query[qIdx]) {
      qIdx++
      consecutive++
      score += 4 + consecutive * 2
    } else {
      consecutive = 0
    }
  }
  return qIdx === query.length ? score : 0
}

export function filterPaletteCommands(commands: PaletteCommand[], rawQuery: string): PaletteCommand[] {
  const query = terminalSafeText(rawQuery).trim().toLowerCase()
  if (!query) return commands.filter(cmd => !cmd.disabled)

  const scored: { cmd: PaletteCommand; score: number; index: number }[] = []
  commands.forEach((cmd, index) => {
    if (cmd.disabled) return
    const labelScore = scoreMatch(cmd.label, query) * 1.3
    const categoryScore = scoreMatch(cmd.category, query) * 0.7
    const shortcutScore = cmd.shortcut ? scoreMatch(cmd.shortcut, query) * 1.1 : 0
    const keywordScore = (cmd.keywords ?? []).reduce((best, kw) => Math.max(best, scoreMatch(kw, query)), 0)
    const hintScore = cmd.hint ? scoreMatch(cmd.hint, query) * 0.6 : 0
    const best = Math.max(labelScore, categoryScore, shortcutScore, keywordScore, hintScore)
    if (best > 0) scored.push({ cmd, score: best, index })
  })

  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map(entry => entry.cmd)
}

/** Build a slim, context-aware shortcut row instead of a static 20-key wall. */
export function buildContextualShortcuts(ctx: ShortcutContext): ShortcutChip[] {
  const paneChip: ShortcutChip | null = ctx.showInspector
    ? {
        key: ctx.activePane === "inspector" ? "⇧←" : "⇧→",
        label: ctx.activePane === "inspector" ? "Main" : "Sidebar",
        actionId: "pane-toggle",
        accent: ctx.activePane === "inspector",
      }
    : null

  if (ctx.workspaceTab === "sources") {
    const chips: ShortcutChip[] = [
      { key: "Enter", label: "Activate", actionId: "source-activate", accent: true },
      { key: "/", label: "Connect / Filter", actionId: "source-search" },
      { key: "P", label: "Pull / Sync", actionId: "source-pull" },
      { key: "R", label: "Reconcile Target", actionId: "target-reconcile" },
      { key: "Shift+U", label: "Engine Update", actionId: "engine-self-update" },
      { key: "G", label: "GitHub Auth", actionId: "source-gh-auth" },
    ]
    if (paneChip) chips.push(paneChip)
    chips.push({ key: "Ctrl+K", label: "Palette", actionId: "palette", accent: true })
    chips.push({ key: "?", label: "Help", actionId: "help" })
    return chips
  }

  if (ctx.workspaceTab === "flows") {
    const chips: ShortcutChip[] = [
      { key: "M", label: "IF/OR Flows", actionId: "pack-flows", accent: true },
      { key: "G", label: "Delegations", actionId: "agent-delegations" },
      { key: "Enter", label: "Jump / Open", actionId: "flow-jump" },
      { key: "E", label: "Install Pack", actionId: "pack-install" },
    ]
    if (paneChip) chips.push(paneChip)
    chips.push({ key: "Ctrl+K", label: "Palette", actionId: "palette", accent: true })
    chips.push({ key: "?", label: "Help", actionId: "help" })
    return chips
  }

  if (ctx.itemType === "folder") {
    const chips: ShortcutChip[] = [
      { key: "Enter", label: "Toggle Pack", actionId: "folder-toggle" },
      { key: "M", label: "IF/OR Flows", actionId: "pack-flows", accent: true },
      { key: "E", label: "Install / Update", actionId: "pack-install", accent: true },
      { key: "A", label: "Select Pack", actionId: "select-category" },
      { key: "B", label: "Claude Bridge", actionId: "bridge-claude" },
    ]
    if (ctx.isVirtualPack) {
      chips.push({
        key: "I",
        label: ctx.isReadOnlyGitSource ? "Clone & Onboard" : "Onboard Pack",
        actionId: "pack-init",
        accent: true,
      })
    } else if (!ctx.isReadOnlyGitSource) {
      chips.push({ key: "D", label: "Pack Doctor", actionId: "pack-doctor", accent: true })
      chips.push({ key: "N", label: "New Resource", actionId: "pack-scaffold" })
    }
    if (paneChip) chips.push(paneChip)
    chips.push({ key: "Ctrl+K", label: "Palette", actionId: "palette", accent: true })
    chips.push({ key: "?", label: "Help", actionId: "help" })
    return chips
  }

  const selectionLabel = ctx.selectedCount > 0 ? "Mark (" + String(ctx.selectedCount) + ")" : "Mark"
  const chips: ShortcutChip[] = [
    { key: "Space", label: selectionLabel, actionId: "select-toggle" },
    { key: "M", label: "Model", actionId: "agent-model", accent: true },
    { key: "T", label: "Tune", actionId: "agent-tune" },
    { key: "P", label: "Safety", actionId: "agent-permissions" },
    { key: "U", label: "Skills/MCP", actionId: "agent-resources" },
    { key: "E", label: "Install", actionId: "pack-install" },
  ]
  if (ctx.hasInvalidModels) {
    chips.splice(2, 0, { key: "V", label: "Repair Models", actionId: "repair-models", accent: true })
  }
  if (paneChip) chips.push(paneChip)
  chips.push({ key: "Ctrl+K", label: "Palette", actionId: "palette", accent: true })
  chips.push({ key: "?", label: "Help", actionId: "help" })
  return chips
}
