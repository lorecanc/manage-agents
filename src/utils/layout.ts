export type LayoutMode = "normal" | "compact" | "too-small"

export interface AppLayout {
  mode: LayoutMode
  listRows: number
  showInspector: boolean
  statusRows: number
  budgetRows: number
}

export interface ListColumnBudget {
  widths: number[]
  gutters: number[]
  total: number
}

export interface PanelWidths {
  list: number
  inspector: number
  gutter: number
}

export function adjustListShare(value: number, delta: number): number {
  return Math.max(0.60, Math.min(0.75, Math.round((value + delta) * 100) / 100))
}

export function resetListShare(): number {
  return 2 / 3
}

/** Calculate deterministic outer panel widths for the normal two-panel view. */
export function calculatePanelWidths(terminalWidth: number, mode: LayoutMode, listShare: number): PanelWidths {
  if (mode !== "normal") return { list: Math.max(0, Math.floor(terminalWidth) - 2), inspector: 0, gutter: 0 }

  // Root horizontal padding consumes two columns, then one column is reserved
  // between panels. The panel widths include their borders and padding.
  const available = Math.max(0, Math.floor(terminalWidth) - 2)
  const gutter = available > 0 ? 1 : 0
  const panelSpace = Math.max(0, available - gutter)
  const minList = 48 + 4
  const minInspector = 24 + 4
  let list = Math.floor(panelSpace * listShare)
  let inspector = panelSpace - list
  if (panelSpace >= minList + minInspector) {
    list = Math.max(minList, Math.min(panelSpace - minInspector, list))
    inspector = panelSpace - list
  } else {
    list = Math.max(0, Math.min(panelSpace, list))
    inspector = panelSpace - list
  }
  return { list, inspector, gutter }
}

/** Allocate concrete cell widths; gutters are explicit and never consume a column. */
export function calculateListColumnBudget(contentWidth: number, mode: LayoutMode = "normal"): ListColumnBudget {
  const width = Math.max(0, Math.floor(contentWidth))
  const ratios = mode === "compact" || mode === "too-small" ? [0.12, 0.43, 0.45] : [0.12, 0.30, 0.17, 0.14, 0.27]
  const gutters = ratios.slice(0, -1).map(() => 1)
  const available = Math.max(0, width - gutters.reduce((a, b) => a + b, 0))
  const selectionWidth = Math.min(5, available)
  const remaining = available - selectionWidth
  const otherRatioTotal = ratios.slice(1).reduce((a, b) => a + b, 0)
  const widths = [selectionWidth, ...ratios.slice(1).map(ratio => Math.floor(remaining * ratio / otherRatioTotal))]
  let remainder = available - widths.reduce((a, b) => a + b, 0)
  for (let i = 0; remainder > 0; i = (i + 1) % widths.length, remainder--) widths[i]++
  return { widths, gutters, total: widths.reduce((a, b) => a + b, 0) + gutters.reduce((a, b) => a + b, 0) }
}

/** Calculate the fixed terminal budget used by the main screen. */
export function calculateLayout(terminalWidth: number, terminalHeight: number, hasStatus: boolean): AppLayout {
  const width = Math.max(0, Math.floor(terminalWidth))
  const height = Math.max(0, Math.floor(terminalHeight))
  const statusRows = hasStatus ? 1 : 0
  // Outer padding, header, main gap, list header/filter/footer, borders and
  // the breathing room needed by the compact layout and the two-line guide.
  const fixedRows = 17 + statusRows
  const minimumListRows = 1
  const tooSmall = width < 40 || height < fixedRows + minimumListRows
  const mode: LayoutMode = tooSmall ? "too-small" : width < 100 || height < 18 ? "compact" : "normal"
  const listRows = tooSmall ? 0 : Math.max(0, height - fixedRows)
  const budgetRows = Math.min(height, fixedRows + listRows)

  return {
    mode,
    listRows,
    showInspector: mode === "normal",
    statusRows,
    budgetRows
  }
}

export interface WorkspaceViewports {
  catalogRows: number
  flowsRows: number
  sourcesRows: number
  promptRows: number
  securityRows: number
  delegationsInspectorRows: number
  resourcesInspectorRows: number
}

export type ModalViewportKind =
  | "model-selector"
  | "delegation-manager"
  | "resource-manager"
  | "tier-selector"
  | "color-selector"
  | "action-result"
  | "command-palette"
  | "routing"
  | "self-update"

export interface ModalViewport {
  modalWidth: number
  modalHeight: number
  left: number
  top: number
  innerWidth: number
  viewportRows: number
}

/**
 * Deterministic sliding-window scroll clamp shared across all TUI lists.
 */
export function clampListScroll(
  focusedIndex: number,
  totalItems: number,
  currentOffset: number,
  viewportRows: number,
): number {
  const safeRows = Math.max(1, Math.floor(viewportRows))
  if (totalItems <= 0) return 0
  const maxOffset = Math.max(0, totalItems - safeRows)
  const clampedFocus = Math.max(0, Math.min(totalItems - 1, focusedIndex))
  let next = Math.max(0, Math.min(maxOffset, currentOffset))
  if (clampedFocus < next) next = clampedFocus
  else if (clampedFocus >= next + safeRows) next = clampedFocus - safeRows + 1
  return Math.max(0, Math.min(maxOffset, next))
}

export function computeCatalogJumpState<T extends { currentPath: string; category: string }>(
  agents: ReadonlyArray<T>,
  previouslyExpanded: ReadonlySet<string>,
  agentPath: string,
  currentScrollOffset: number,
  maxVisibleItems: number,
  compareCategories: (a: string, b: string) => number,
): { foundIndex: number; scrollOffset: number; expandedCategories: Set<string>; totalItems: number } | null {
  const targetAgent = agents.find(agent => agent.currentPath === agentPath)
  if (!targetAgent) return null

  const expandedCategories = new Set(previouslyExpanded)
  expandedCategories.add(targetAgent.category)
  const categories = [...new Set(agents.map(agent => agent.category))].sort(compareCategories)
  let foundIndex = -1
  let totalItems = 0

  for (const category of categories) {
    const categoryAgents = agents.filter(agent => agent.category === category)
    if (category === targetAgent.category) {
      const agentIndex = categoryAgents.findIndex(agent => agent.currentPath === agentPath)
      foundIndex = totalItems + 1 + agentIndex
    }
    totalItems += 1
    if (expandedCategories.has(category)) totalItems += categoryAgents.length
  }

  return {
    foundIndex,
    scrollOffset: clampListScroll(foundIndex, totalItems, currentScrollOffset, maxVisibleItems),
    expandedCategories,
    totalItems,
  }
}

/**
 * Compute exact visible row capacities for each main workspace and inspector tab
 * from the rendered outer chrome (root padding 2 + header 3 + gap 1 + footer 3 = 9).
 */
export function calculateWorkspaceViewports(
  terminalHeight: number,
  options: { hasSourcesStatus?: boolean; hasSecurityOrderError?: boolean } = {},
): WorkspaceViewports {
  const h = Math.max(0, Math.floor(terminalHeight))
  return {
    catalogRows: Math.max(1, h - 15),
    flowsRows: Math.max(1, h - 18),
    sourcesRows: Math.max(1, h - 21 - (options.hasSourcesStatus ? 2 : 0)),
    promptRows: Math.max(2, h - 18),
    securityRows: Math.max(1, h - 23 - (options.hasSecurityOrderError ? 3 : 0)),
    delegationsInspectorRows: Math.max(1, h - 23),
    resourcesInspectorRows: Math.max(1, h - 19),
  }
}

/**
 * Compute explicit integer modal geometry and exact inner list viewport rows
 * so list slicing never overflows borders, padding, headers, or footers.
 */
export function calculateModalViewport(
  kind: ModalViewportKind,
  terminalWidth: number,
  terminalHeight: number,
  extraChromeRows = 0,
): ModalViewport {
  const safeW = Math.max(20, Math.floor(terminalWidth))
  const safeH = Math.max(10, Math.floor(terminalHeight))
  const maxW = Math.max(20, safeW - 4)
  const maxH = Math.max(10, safeH - 2)
  const extra = Math.max(0, Math.floor(extraChromeRows))

  if (kind === "command-palette") {
    const modalWidth = Math.min(maxW, Math.min(86, Math.max(44, Math.floor(safeW * 0.68))))
    const desiredRows = Math.max(3, Math.min(14, safeH - 12))
    const chrome = 8 + extra
    const modalHeight = Math.min(Math.max(10, safeH - 4), Math.max(10, desiredRows + chrome))
    const left = Math.max(0, Math.floor((safeW - modalWidth) / 2))
    const top = Math.max(0, Math.floor((safeH - modalHeight) / 3))
    return {
      modalWidth,
      modalHeight,
      left,
      top,
      innerWidth: Math.max(16, modalWidth - 4),
      viewportRows: Math.max(1, modalHeight - chrome),
    }
  }

  const spec: Record<Exclude<ModalViewportKind, "command-palette">, { widthRatio: number; minW: number; heightRatio: number; minH: number; chrome: number }> = {
    "model-selector": { widthRatio: 0.72, minW: 44, heightRatio: 0.76, minH: 13, chrome: 11 },
    "delegation-manager": { widthRatio: 0.76, minW: 48, heightRatio: 0.76, minH: 12, chrome: 9 },
    "resource-manager": { widthRatio: 0.80, minW: 50, heightRatio: 0.84, minH: 12, chrome: 9 },
    "tier-selector": { widthRatio: 0.70, minW: 48, heightRatio: 0.84, minH: 13, chrome: 11 },
    "color-selector": { widthRatio: 0.70, minW: 44, heightRatio: 0.72, minH: 12, chrome: 10 },
    "action-result": { widthRatio: 0.76, minW: 48, heightRatio: 0.72, minH: 11, chrome: 8 },
    routing: { widthRatio: 0.80, minW: 52, heightRatio: 0.84, minH: 13, chrome: 8 },
    "self-update": { widthRatio: 0.68, minW: 50, heightRatio: 0.58, minH: 13, chrome: 8 },
  }

  const cfg = spec[kind]
  const modalWidth = Math.min(maxW, Math.max(cfg.minW, Math.floor(safeW * cfg.widthRatio)))
  const modalHeight = Math.min(maxH, Math.max(cfg.minH, Math.floor(safeH * cfg.heightRatio)))
  const left = Math.max(0, Math.floor((safeW - modalWidth) / 2))
  const top = Math.max(0, Math.floor((safeH - modalHeight) / 2))
  const innerWidth = Math.max(16, modalWidth - 6)
  const viewportRows = Math.max(1, modalHeight - (cfg.chrome + extra))

  return {
    modalWidth,
    modalHeight,
    left,
    top,
    innerWidth,
    viewportRows,
  }
}
