import type { WorkspaceTab } from "./commandPalette.js"

export type HelpTabId = "catalog" | "flows" | "sources" | "global"

export interface HelpTabMeta {
  id: HelpTabId
  index: number
  label: string
  shortLabel: string
  subtitle: string
  accent: "blue" | "amber" | "green" | "purple"
}

export interface HelpContext {
  hasPacks?: boolean
  hasAgents: boolean
  isReadOnlyGitSource?: boolean
  isVirtualPack?: boolean
  hasInvalidModels?: boolean
}

export interface HelpShortcutItem {
  id: string
  keyLabel: string
  title: string
  scope: string
  actionId?: string
  disabled?: boolean
}

export type HelpDisplayRow =
  | { kind: "spacer"; id: string }
  | { kind: "group"; id: string; title: string }
  | { kind: "item"; id: string; itemIndex: number; item: HelpShortcutItem }

export interface HelpTabContent {
  tab: HelpTabMeta
  items: HelpShortcutItem[]
  rows: HelpDisplayRow[]
}

export interface HelpViewport {
  modalWidth: number
  modalHeight: number
  left: number
  top: number
  innerWidth: number
  viewportRows: number
  compactChrome: boolean
}

const TARGET_MAX_LIST_ROWS = 18

export function calculateHelpViewport(termWidth: number, termHeight: number): HelpViewport {
  const safeW = Math.max(1, Math.floor(termWidth))
  const safeH = Math.max(1, Math.floor(termHeight))
  const compactChrome = safeH < 20

  const maxW = safeW > 22 ? safeW - 2 : safeW
  const desiredW = Math.min(88, Math.max(50, safeW - 6))
  const modalWidth = Math.min(maxW, desiredW)

  const chromeRows = compactChrome ? 7 : 9
  const maxH = safeH > 12 ? safeH - 2 : safeH
  const desiredH = Math.min(chromeRows + TARGET_MAX_LIST_ROWS, Math.max(12, safeH - 3))
  const modalHeight = Math.min(maxH, desiredH)

  const viewportRows = Math.max(1, modalHeight - chromeRows)
  const left = Math.max(0, Math.floor((safeW - modalWidth) / 2))
  const top = Math.max(0, Math.floor((safeH - modalHeight) / 2))
  const innerWidth = Math.max(8, modalWidth - 4)

  return {
    modalWidth,
    modalHeight,
    left,
    top,
    innerWidth,
    viewportRows,
    compactChrome,
  }
}

export const HELP_TABS: readonly HelpTabMeta[] = [
  {
    id: "catalog",
    index: 1,
    label: "1 Catalog",
    shortLabel: "1 Cat",
    subtitle: "Edit agents, batch-select & switch Inspector tabs",
    accent: "blue",
  },
  {
    id: "flows",
    index: 2,
    label: "2 Flows & Packs",
    shortLabel: "2 Flows",
    subtitle: "Configure IF/OR pack flows, repair models & bridges",
    accent: "amber",
  },
  {
    id: "sources",
    index: 3,
    label: "3 Sources",
    shortLabel: "3 Src",
    subtitle: "Connect GitHub repos, sync sources & reconcile target",
    accent: "green",
  },
  {
    id: "global",
    index: 4,
    label: "4 Global & Mouse",
    shortLabel: "4 Global",
    subtitle: "Switch workspaces, split layout, motion & mouse",
    accent: "purple",
  },
] as const

export function defaultHelpTabForWorkspace(workspace: WorkspaceTab): HelpTabId {
  if (workspace === "flows") return "flows"
  if (workspace === "sources") return "sources"
  return "catalog"
}

export function cycleHelpTab(current: HelpTabId, direction: 1 | -1): HelpTabId {
  const idx = HELP_TABS.findIndex(tab => tab.id === current)
  const safeIdx = idx === -1 ? 0 : idx
  const nextIdx = (safeIdx + direction + HELP_TABS.length) % HELP_TABS.length
  return HELP_TABS[nextIdx]!.id
}

export function helpTabByNumber(num: number): HelpTabId | null {
  const found = HELP_TABS.find(tab => tab.index === num)
  return found ? found.id : null
}

function buildGroupsForTab(
  tab: HelpTabId,
  ctx: HelpContext,
): { title: string; items: HelpShortcutItem[] }[] {
  const noPacks = !(ctx.hasPacks ?? ctx.hasAgents)
  const noAgents = !ctx.hasAgents
  const readOnly = Boolean(ctx.isReadOnlyGitSource)

  switch (tab) {
    case "catalog":
      return [
        {
          title: "Agent Configuration",
          items: [
            { id: "cat-model", keyLabel: "M", title: "Assign LLM model (or IF/OR flows on pack)", scope: "Agent/Pack", actionId: "agent-model", disabled: noAgents },
            { id: "cat-tune", keyLabel: "T", title: "Tune max steps, thinking effort, mode & visibility", scope: "Agent", actionId: "agent-tune", disabled: noAgents },
            { id: "cat-safety", keyLabel: "P", title: "Apply security & tool safety preset", scope: "Agent", actionId: "agent-permissions", disabled: noAgents },
            { id: "cat-resources", keyLabel: "U", title: "Manage skills, custom tools & MCP servers", scope: "Agent", actionId: "agent-resources", disabled: noAgents },
            { id: "cat-delegations", keyLabel: "G", title: "Edit authorized @subagent delegations", scope: "Agent", actionId: "agent-delegations", disabled: noAgents },
            { id: "cat-tier", keyLabel: "Shift+T", title: "Assign bridge translation tier", scope: "Agent", actionId: "agent-tier", disabled: noAgents },
            { id: "cat-color", keyLabel: "C", title: "Pick agent badge color", scope: "Agent", actionId: "agent-color", disabled: noAgents },
            { id: "cat-rename", keyLabel: "R", title: "Rename agent file & update references", scope: "Local", actionId: "agent-rename", disabled: noAgents || readOnly },
            { id: "cat-fix-order", keyLabel: "Shift+F", title: "Fix wildcard \"*\": \"deny\" permission order", scope: "Sec Tab", actionId: "fix-permission-order", disabled: noAgents || readOnly },
          ],
        },
        {
          title: "Selection & Inspector",
          items: [
            { id: "cat-mark", keyLabel: "Space", title: "Select focused pack or mark focused agent", scope: "Selection", actionId: "select-toggle", disabled: noAgents },
            { id: "cat-select-all", keyLabel: "Ctrl+A", title: "Select or deselect all matching packs for installation", scope: "Pack", actionId: "select-all-packs", disabled: noPacks },
            { id: "cat-install", keyLabel: "E", title: "Preview installation of selected packs or the focused pack", scope: "Target", actionId: "pack-install", disabled: noPacks },
            { id: "cat-mark-pack", keyLabel: "A", title: "Mark or unmark all agents in focused pack", scope: "Batch", actionId: "select-category", disabled: noAgents },
            { id: "cat-mark-model", keyLabel: "S", title: "Mark agents sharing the same model in pack", scope: "Batch", actionId: "select-same-model", disabled: noAgents },
            { id: "cat-filter", keyLabel: "/", title: "Filter by agent or pack name", scope: "Filter", actionId: "catalog-search", disabled: noPacks },
            { id: "cat-tabs", keyLabel: "1 – 6", title: "Switch Inspector sidebar tabs (or ◀/▶ when focused)", scope: "Sidebar" },
            { id: "cat-panes", keyLabel: "⇧← / ⇧→", title: "Switch focus between Main panel and Sidebar (also [ / ])", scope: "Panes", actionId: "pane-toggle" },
          ],
        },
      ]

    case "flows":
      return [
        {
          title: "Conditional Flows & Call Graph",
          items: [
            { id: "flw-rules", keyLabel: "M", title: "Configure conditional IF/OR pack routing flows", scope: "Pack", actionId: "pack-flows", disabled: noAgents },
            { id: "flw-delegations", keyLabel: "G", title: "Edit @subagent delegations for focused agent", scope: "Agent", actionId: "agent-delegations", disabled: noAgents },
            { id: "flw-jump", keyLabel: "Enter", title: "Open pack flows or jump to focused agent in Catalog", scope: "Flows", actionId: "flow-jump", disabled: noAgents },
            { id: "flw-panes", keyLabel: "⇧← / ⇧→", title: "Switch focus between Call Graph and Topology sidebar", scope: "Panes", actionId: "pane-toggle" },
          ],
        },
        {
          title: "Pack Maintenance & Bridges",
          items: [
            { id: "flw-install", keyLabel: "E", title: "Preview diff & install or update pack into OpenCode", scope: "Target", actionId: "pack-install", disabled: noPacks },
            { id: "flw-repair", keyLabel: "V", title: "Batch-repair invalid or missing models", scope: "Pack", actionId: "repair-models", disabled: !ctx.hasInvalidModels },
            { id: "flw-init", keyLabel: "I", title: "Onboard virtual folder or GitHub repo into Contract 1.1 pack", scope: "Virtual", actionId: "pack-init", disabled: !ctx.isVirtualPack },
            { id: "flw-doctor", keyLabel: "D", title: "Open Pack Doctor (validate, auto-fix V2/namespace, bump semver)", scope: "Pack", actionId: "pack-doctor", disabled: Boolean(ctx.isVirtualPack) || readOnly || noPacks },
            { id: "flw-scaffold", keyLabel: "N", title: "Scaffold compliant agent, skill or command in pack", scope: "Author", actionId: "pack-scaffold", disabled: Boolean(ctx.isVirtualPack) || readOnly || noPacks },
            { id: "flw-claude", keyLabel: "B", title: "Generate Claude Code plugin bridge", scope: "Bridge", actionId: "bridge-claude", disabled: noAgents },
            { id: "flw-codex", keyLabel: "Shift+B", title: "Generate OpenAI Codex bridge", scope: "Bridge", actionId: "bridge-codex", disabled: noAgents },
          ],
        },
      ]

    case "sources":
      return [
        {
          title: "Sources & GitHub Discovery",
          items: [
            { id: "src-open", keyLabel: "O", title: "Jump to Sources & Target from Catalog or Flows", scope: "Cat/Flows", actionId: "ws-sources" },
            { id: "src-activate", keyLabel: "Enter", title: "Connect or activate a source and open its catalog", scope: "Sources", actionId: "source-activate" },
            { id: "src-input", keyLabel: "/ · A", title: "Focus repository URL or owner/repo input box", scope: "Sources", actionId: "source-search" },
            { id: "src-pull", keyLabel: "P", title: "Pull active Git source & refresh GitHub repos", scope: "Git", actionId: "source-pull" },
            { id: "src-gh", keyLabel: "G", title: "Sign in with GitHub CLI (gh auth login)", scope: "GitHub", actionId: "source-gh-auth" },
            { id: "src-trust", keyLabel: "T", title: "Toggle trusted status on registered source", scope: "Security", actionId: "source-trust" },
            { id: "src-remove", keyLabel: "X / Del", title: "Remove registered source from local registry", scope: "Registry", actionId: "source-remove" },
          ],
        },
        {
          title: "OpenCode Target Health",
          items: [
            { id: "src-reconcile", keyLabel: "R", title: "Reconcile installed OpenCode target now", scope: "Target", actionId: "target-reconcile" },
            { id: "src-refresh", keyLabel: "Ctrl+R", title: "Refresh sources & OpenCode target drift status", scope: "Target", actionId: "target-refresh" },
            { id: "src-panes", keyLabel: "⇧← / ⇧→", title: "Focus Target Status sidebar to scroll installed packs", scope: "Panes", actionId: "pane-toggle" },
            { id: "src-self-update", keyLabel: "Shift+U", title: "Check or apply manage-agents release update", scope: "Engine", actionId: "engine-self-update" },
          ],
        },
      ]

    case "global":
      return [
        {
          title: "Global Navigation & View",
          items: [
            { id: "glb-palette", keyLabel: "Ctrl+K", title: "Open fuzzy Command Palette from anywhere", scope: "Global", actionId: "palette" },
            { id: "glb-tab", keyLabel: "Tab / ⇧Tab", title: "Cycle browser tabs (Catalog → Flows → Sources)", scope: "Topbar", actionId: "ws-next" },
            { id: "glb-panes", keyLabel: "⇧← / ⇧→", title: "Switch focus between Main panel and right Sidebar", scope: "Panes", actionId: "pane-toggle" },
            { id: "glb-nav", keyLabel: "↑/↓ j/k", title: "Move focus across rows (or PgUp / PgDn)", scope: "Nav" },
            { id: "glb-tree", keyLabel: "◀/▶ h/l", title: "Collapse/expand folders, or switch Sidebar tabs", scope: "Tree/Tab" },
            { id: "glb-layout", keyLabel: "Shift+L", title: "Adjust Catalog / Inspector split width", scope: "Layout", actionId: "layout-adjust" },
            { id: "glb-motion", keyLabel: "Ctrl+E", title: "Toggle smooth 60fps vs reduced motion", scope: "Motion", actionId: "toggle-motion" },
            { id: "glb-close", keyLabel: "? / Esc", title: "Open or close Keyboard Guide and active modals", scope: "Global" },
          ],
        },
        {
          title: "Mouse Interactions",
          items: [
            { id: "mse-click", keyLabel: "Click", title: "Focus rows, switch tabs or run footer pills", scope: "Mouse" },
            { id: "mse-drag", keyLabel: "Drag │", title: "Drag center divider to resize List / Inspector", scope: "Mouse" },
            { id: "mse-wheel", keyLabel: "Wheel", title: "Scroll Catalog, Inspector, Palette & Guide", scope: "Mouse" },
          ],
        },
      ]
  }
}

export function buildHelpSections(tabId: HelpTabId, ctx: HelpContext): HelpTabContent {
  const tab = HELP_TABS.find(entry => entry.id === tabId) ?? HELP_TABS[0]!
  const groups = buildGroupsForTab(tab.id, ctx)
  const items: HelpShortcutItem[] = []
  const rows: HelpDisplayRow[] = []

  groups.forEach((group, groupIdx) => {
    if (groupIdx > 0) {
      rows.push({ kind: "spacer", id: `${tab.id}:spacer:${groupIdx}` })
    }
    rows.push({ kind: "group", id: `${tab.id}:group:${groupIdx}`, title: group.title })
    for (const item of group.items) {
      const itemIndex = items.length
      items.push(item)
      rows.push({ kind: "item", id: item.id, itemIndex, item })
    }
  })

  return { tab, items, rows }
}

/** Keep the focused shortcut row (and its group heading when possible) inside the scroll window. */
export function clampHelpScroll(
  focusedItemIndex: number,
  rows: HelpDisplayRow[],
  currentOffset: number,
  viewportRows: number,
): number {
  const budget = Math.max(1, Math.floor(viewportRows))
  const maxOffset = Math.max(0, rows.length - budget)
  if (rows.length <= budget) return 0

  const rowIndex = rows.findIndex(r => r.kind === "item" && r.itemIndex === focusedItemIndex)
  if (rowIndex < 0) {
    return Math.max(0, Math.min(currentOffset, maxOffset))
  }

  const hasGroupAbove = rowIndex > 0 && rows[rowIndex - 1]?.kind === "group"
  const headerAnchor = hasGroupAbove && budget >= 2 ? rowIndex - 1 : rowIndex

  let next = currentOffset
  if (headerAnchor < next) {
    next = headerAnchor
  } else if (rowIndex >= next + budget) {
    next = rowIndex - budget + 1
  }

  return Math.max(0, Math.min(next, maxOffset))
}

/** Keep focusedItemIndex inside the currently visible slice when wheel-scrolling or resizing. */
export function clampFocusIntoHelpSlice(
  focusedItemIndex: number,
  rows: HelpDisplayRow[],
  scrollOffset: number,
  viewportRows: number,
): number {
  const budget = Math.max(1, Math.floor(viewportRows))
  const safeOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, rows.length - budget)))
  const visibleItems = rows
    .slice(safeOffset, safeOffset + budget)
    .filter((r): r is Extract<HelpDisplayRow, { kind: "item" }> => r.kind === "item")
  if (visibleItems.length === 0) return Math.max(0, focusedItemIndex)
  if (visibleItems.some(r => r.itemIndex === focusedItemIndex)) return focusedItemIndex
  return focusedItemIndex < visibleItems[0]!.itemIndex
    ? visibleItems[0]!.itemIndex
    : visibleItems[visibleItems.length - 1]!.itemIndex
}
