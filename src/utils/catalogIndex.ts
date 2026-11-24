import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { agentId, extractFrontmatter, type AgentInfo } from "./agents.js"
import { comparePackCategories } from "./bridgePrompt.js"
import { manifestName, packDir, readManifest } from "./catalog.js"
import { readMcpServers } from "./opencodeMcp.js"
import {
  discoverPackDirs,
  parseJsonc,
  validatePack,
  type ExecutableSurface,
  type PackIssue,
  type PackManifest,
  type PackValidation,
} from "./packs.js"
import { derivePackSlug, isVirtualPackRoot, scanVirtualExtras } from "./virtualPacks.js"

const MAX_PREVIEW_READ_BYTES = 256 * 1024

export type CatalogAssetKind = "agent" | "skill" | "command" | "tool" | "plugin" | "theme" | "mcp"
export type AssetTypeFilter = "all" | CatalogAssetKind

export const ASSET_TYPE_FILTERS: readonly { key: AssetTypeFilter; label: string; shortLabel: string; shortcut: string; icon: string }[] = [
  { key: "all", label: "All", shortLabel: "All", shortcut: "1", icon: "📦" },
  { key: "agent", label: "Agents", shortLabel: "Ag", shortcut: "2", icon: "🤖" },
  { key: "skill", label: "Skills", shortLabel: "Sk", shortcut: "3", icon: "📄" },
  { key: "command", label: "Commands", shortLabel: "Cm", shortcut: "4", icon: "💻" },
  { key: "tool", label: "Tools", shortLabel: "Tl", shortcut: "5", icon: "🔧" },
  { key: "plugin", label: "Plugins", shortLabel: "Pl", shortcut: "6", icon: "🧩" },
  { key: "theme", label: "Themes", shortLabel: "Th", shortcut: "7", icon: "🎨" },
  { key: "mcp", label: "MCP", shortLabel: "Mcp", shortcut: "8", icon: "🔌" },
]

export function assetFilterIcon(filter: AssetTypeFilter): string {
  return ASSET_TYPE_FILTERS.find(f => f.key === filter)?.icon ?? "📦"
}

export function packCountForFilter(counts: PackAssetCounts, filter: AssetTypeFilter): number {
  switch (filter) {
    case "all": return counts.total
    case "agent": return counts.agents
    case "skill": return counts.skills
    case "command": return counts.commands
    case "tool": return counts.tools
    case "plugin": return counts.plugins
    case "theme": return counts.themes
    case "mcp": return counts.mcp
  }
}

export const ASSET_SECTION_ORDER: readonly CatalogAssetKind[] = [
  "agent",
  "skill",
  "command",
  "tool",
  "plugin",
  "theme",
  "mcp",
]

export function assetSectionLabel(kind: CatalogAssetKind): string {
  switch (kind) {
    case "agent": return "Agents"
    case "skill": return "Skills"
    case "command": return "Commands"
    case "tool": return "Tools"
    case "plugin": return "Plugins"
    case "theme": return "Themes"
    case "mcp": return "MCP Servers"
  }
}

export interface CatalogAssetItem {
  id: string
  kind: Exclude<CatalogAssetKind, "agent">
  packName: string
  name: string
  relPath: string
  absPath: string | null
  description: string
  frontmatter?: Record<string, any>
  bodyPreview?: string
  executable: boolean
  extra?: {
    serverType?: string
    commandOrUrl?: string
    enabled?: boolean
    fileCount?: number
  }
}

export interface PackBridgeCompat {
  opencode: boolean
  claude: boolean
  codex: boolean
  claudeReason: string
  codexReason: string
}

export interface PackAssetCounts {
  agents: number
  skills: number
  commands: number
  tools: number
  plugins: number
  themes: number
  mcp: number
  total: number
}

export interface PackCatalogEntry {
  name: string
  dir: string | null
  manifest: PackManifest | null
  version: string
  description: string
  requires: Record<string, string>
  isVirtual: boolean
  agents: AgentInfo[]
  skills: CatalogAssetItem[]
  commands: CatalogAssetItem[]
  tools: CatalogAssetItem[]
  plugins: CatalogAssetItem[]
  themes: CatalogAssetItem[]
  mcpServers: CatalogAssetItem[]
  counts: PackAssetCounts
  validation: PackValidation | null
  issues: PackIssue[]
  errorCount: number
  warningCount: number
  executable: ExecutableSurface
  bridgeCompat: PackBridgeCompat
}

export interface CatalogIndex {
  packs: PackCatalogEntry[]
  byName: Map<string, PackCatalogEntry>
  totals: PackAssetCounts
}

export type CatalogTreeItem =
  | {
      type: "folder"
      id: string
      category: string
      pack: PackCatalogEntry
      label: string
    }
  | {
      type: "section"
      id: string
      category: string
      assetKind: CatalogAssetKind
      count: number
      label: string
    }
  | {
      type: "file"
      id: string
      category: string
      agent: AgentInfo
      label: string
    }
  | {
      type: "asset"
      id: string
      category: string
      assetKind: Exclude<CatalogAssetKind, "agent">
      asset: CatalogAssetItem
      label: string
    }

const EMPTY_EXECUTABLE: ExecutableSurface = {
  plugins: [],
  pluginPackages: [],
  toolModules: [],
  skillScripts: [],
  mcpServers: [],
  externalCommands: [],
}

function readMarkdownSummary(absPath: string): { description: string; frontmatter?: Record<string, any>; bodyPreview?: string } {
  try {
    const stat = fs.lstatSync(absPath, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.size > MAX_PREVIEW_READ_BYTES) return { description: stat?.isFile() ? "(file too large to preview)" : "" }
    const raw = fs.readFileSync(absPath, "utf8")
    const { yamlText, body } = extractFrontmatter(raw)
    let frontmatter: Record<string, any> | undefined
    if (yamlText !== null) {
      try {
        const parsed = YAML.parse(yamlText)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          frontmatter = parsed as Record<string, any>
        }
      } catch {
        // Invalid YAML is surfaced by validatePack issues; keep inspector resilient.
      }
    }
    const fmDesc = typeof frontmatter?.description === "string" ? frontmatter.description.trim() : ""
    const firstBodyLine = body
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.length > 0 && !line.startsWith("#")) ?? ""
    const description = fmDesc || firstBodyLine.slice(0, 140)
    const bodyPreview = body.trim().slice(0, 4000)
    return { description, frontmatter, bodyPreview }
  } catch {
    return { description: "" }
  }
}

function readTextPreview(absPath: string, maxChars = 4000): string {
  try {
    const stat = fs.lstatSync(absPath, { throwIfNoEntry: false })
    if (!stat?.isFile()) return ""
    if (stat.size > MAX_PREVIEW_READ_BYTES) return "(file too large to preview)"
    return fs.readFileSync(absPath, "utf8").slice(0, maxChars)
  } catch {
    return ""
  }
}

function readPackConfigObject(dir: string): { relPath: string; config: Record<string, any> } | null {
  for (const filename of ["opencode.json", "opencode.jsonc"]) {
    const full = path.join(dir, filename)
    const stat = fs.lstatSync(full, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.size > MAX_PREVIEW_READ_BYTES) continue
    try {
      const parsed = parseJsonc(fs.readFileSync(full, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { relPath: filename, config: parsed as Record<string, any> }
      }
    } catch {
      return null
    }
  }
  return null
}

function computeBridgeCompat(counts: PackAssetCounts): PackBridgeCompat {
  const claudeParts: string[] = []
  if (counts.agents > 0) claudeParts.push(`${counts.agents} agent${counts.agents === 1 ? "" : "s"}`)
  if (counts.skills > 0) claudeParts.push(`${counts.skills} skill${counts.skills === 1 ? "" : "s"}`)
  if (counts.commands > 0) claudeParts.push(`${counts.commands} cmd→skill`)
  if (counts.mcp > 0) claudeParts.push(`${counts.mcp} mcp`)

  const codexParts: string[] = []
  if (counts.agents > 0) codexParts.push(`${counts.agents} agent${counts.agents === 1 ? "" : "s"}`)
  if (counts.skills > 0) codexParts.push(`${counts.skills} skill${counts.skills === 1 ? "" : "s"}`)
  if (counts.mcp > 0) codexParts.push(`${counts.mcp} mcp`)

  const unbridged: string[] = []
  if (counts.plugins > 0) unbridged.push("plugins")
  if (counts.tools > 0) unbridged.push("tools")
  const unbridgedNote = unbridged.length > 0 ? ` (${unbridged.join("/")} OC-only)` : ""

  const claude = claudeParts.length > 0
  const codex = codexParts.length > 0

  return {
    opencode: true,
    claude,
    codex,
    claudeReason: claude ? `${claudeParts.join(", ")}${unbridgedNote}` : "No agents, skills, commands, or MCP",
    codexReason: codex
      ? `${codexParts.join(", ")}${counts.commands > 0 ? " (cmds ignored)" : ""}${unbridgedNote}`
      : counts.commands > 0
        ? "Commands-only (Codex requires agents, skills, or MCP)"
        : "No agents, skills, or MCP",
  }
}

export function formatPackAssetBadges(counts: PackAssetCounts): string {
  const parts: string[] = []
  if (counts.agents > 0) parts.push(`A:${counts.agents}`)
  if (counts.skills > 0) parts.push(`S:${counts.skills}`)
  if (counts.commands > 0) parts.push(`C:${counts.commands}`)
  if (counts.tools > 0) parts.push(`T:${counts.tools}`)
  if (counts.plugins > 0) parts.push(`P:${counts.plugins}`)
  if (counts.themes > 0) parts.push(`Th:${counts.themes}`)
  if (counts.mcp > 0) parts.push(`M:${counts.mcp}`)
  return parts.length > 0 ? `[${parts.join(" ")}]` : "[empty]"
}

export function formatBridgeBadges(compat: PackBridgeCompat): string {
  const targets = ["OC"]
  if (compat.claude) targets.push("CC")
  if (compat.codex) targets.push("CX")
  return targets.join("·")
}

/**
 * Discovers every pack in the workspace (including 0-agent packs with skills, commands,
 * tools, plugins, themes, or MCP) and builds a unified asset index.
 */
export function buildCatalogIndex(
  workspaceRoot: string | null,
  agents: ReadonlyArray<AgentInfo> & { packNames?: string[] },
): CatalogIndex {
  const packNames = new Set<string>()
  for (const agent of agents) {
    if (agent.category) packNames.add(agent.category)
  }
  for (const name of agents.packNames ?? []) {
    if (name) packNames.add(name)
  }
  if (workspaceRoot && fs.existsSync(workspaceRoot)) {
    for (const dir of discoverPackDirs(workspaceRoot)) {
      const name = manifestName(dir)
      if (name) packNames.add(name)
    }
    if (packNames.size === 0 && isVirtualPackRoot(workspaceRoot)) {
      packNames.add(derivePackSlug(path.basename(path.resolve(workspaceRoot))))
    }
  }

  const agentsByPack = new Map<string, AgentInfo[]>()
  for (const agent of agents) {
    const list = agentsByPack.get(agent.category) ?? []
    list.push(agent)
    agentsByPack.set(agent.category, list)
  }

  const sortedNames = [...packNames].sort(comparePackCategories)
  const packs: PackCatalogEntry[] = []
  const byName = new Map<string, PackCatalogEntry>()
  const totals: PackAssetCounts = { agents: 0, skills: 0, commands: 0, tools: 0, plugins: 0, themes: 0, mcp: 0, total: 0 }

  for (const name of sortedNames) {
    const dir = workspaceRoot ? packDir(workspaceRoot, name) : null
    const packAgents = agentsByPack.get(name) ?? []
    const isVirtual = Boolean(dir && !fs.existsSync(path.join(dir, "opencode-pack.json")) && isVirtualPackRoot(dir))

    let validation: PackValidation | null = null
    let manifest: PackManifest | null = null
    if (dir && !isVirtual) {
      try {
        validation = validatePack(dir)
        manifest = validation.manifest
      } catch {
        validation = null
      }
    } else if (dir && isVirtual) {
      try {
        manifest = readManifest(dir) as PackManifest
      } catch {
        manifest = null
      }
    }

    const files = validation?.files ?? []
    const executable = validation?.executable ?? EMPTY_EXECUTABLE

    const virtualExtras = !validation && dir && isVirtual ? scanVirtualExtras(dir) : null

    // Skills
    const skills: CatalogAssetItem[] = validation
      ? validation.ids.skills.map(id => {
          const relPath = `skills/${id}/SKILL.md`
          const absPath = dir ? path.join(dir, relPath) : null
          const summary = absPath ? readMarkdownSummary(absPath) : { description: "" }
          const skillPrefix = `skills/${id}/`
          const hasScript = executable.skillScripts.some(file => file.startsWith(skillPrefix))
          const fileCount = files.filter(file => file.startsWith(skillPrefix)).length
          return {
            id: `${name}:skill:${id}`,
            kind: "skill",
            packName: name,
            name: id,
            relPath,
            absPath,
            description: summary.description,
            frontmatter: summary.frontmatter,
            bodyPreview: summary.bodyPreview,
            executable: hasScript,
            extra: { fileCount: fileCount || 1 },
          }
        })
      : (virtualExtras?.skills ?? []).map(skill => {
          const absPath = dir ? path.join(dir, skill.sourceSkillRoot, "SKILL.md") : null
          const summary = absPath ? readMarkdownSummary(absPath) : { description: "" }
          return {
            id: `${name}:skill:${skill.id}`,
            kind: "skill",
            packName: name,
            name: skill.id,
            relPath: `${skill.sourceSkillRoot}/SKILL.md`,
            absPath,
            description: summary.description,
            frontmatter: summary.frontmatter,
            bodyPreview: summary.bodyPreview,
            executable: skill.files.some(f => f.isScript),
            extra: { fileCount: skill.files.length || 1 },
          }
        })

    // Commands
    const commands: CatalogAssetItem[] = validation
      ? validation.ids.commands.map(id => {
          const relPath = `commands/${id}.md`
          const absPath = dir ? path.join(dir, relPath) : null
          const summary = absPath ? readMarkdownSummary(absPath) : { description: "" }
          return {
            id: `${name}:command:${id}`,
            kind: "command",
            packName: name,
            name: id,
            relPath,
            absPath,
            description: summary.description,
            frontmatter: summary.frontmatter,
            bodyPreview: summary.bodyPreview,
            executable: false,
          }
        })
      : (virtualExtras?.commands ?? []).map(cmd => {
          const absPath = dir ? path.join(dir, cmd.sourceRel) : null
          const summary = absPath ? readMarkdownSummary(absPath) : { description: "" }
          return {
            id: `${name}:command:${cmd.id}`,
            kind: "command",
            packName: name,
            name: cmd.id,
            relPath: cmd.sourceRel,
            absPath,
            description: summary.description,
            frontmatter: summary.frontmatter,
            bodyPreview: summary.bodyPreview,
            executable: false,
          }
        })

    // Tools (helper scripts/modules under tools/)
    const toolFiles = files.filter(file => file.startsWith("tools/"))
    const toolModuleSet = new Set(executable.toolModules)
    const tools: CatalogAssetItem[] = toolFiles.map(relPath => {
      const toolName = relPath.slice("tools/".length)
      const absPath = dir ? path.join(dir, relPath) : null
      const isExec = toolModuleSet.has(relPath)
      return {
        id: `${name}:tool:${toolName}`,
        kind: "tool",
        packName: name,
        name: toolName,
        relPath,
        absPath,
        description: isExec ? "Executable tool module" : "Tool helper file",
        bodyPreview: absPath ? readTextPreview(absPath) : "",
        executable: isExec,
      }
    })

    // Plugins
    const pluginIds = validation?.ids.plugins ?? []
    const plugins: CatalogAssetItem[] = pluginIds.map(id => {
      const prefix = `plugins/${id}/`
      const pluginFiles = files.filter(file => file.startsWith(prefix))
      const entryRel = pluginFiles.find(file => /index\.(m?[jt]s|tsx)$/.test(file)) ?? pluginFiles[0] ?? `plugins/${id}`
      const absPath = dir ? path.join(dir, entryRel) : null
      return {
        id: `${name}:plugin:${id}`,
        kind: "plugin",
        packName: name,
        name: id,
        relPath: `plugins/${id}`,
        absPath,
        description: `OpenCode plugin (${pluginFiles.length} file${pluginFiles.length === 1 ? "" : "s"})`,
        bodyPreview: absPath ? readTextPreview(absPath) : "",
        executable: true,
        extra: { fileCount: pluginFiles.length },
      }
    })

    // Themes
    const themeIds = validation?.ids.themes ?? []
    const themes: CatalogAssetItem[] = themeIds.map(id => {
      const relPath = `themes/${id}.json`
      const absPath = dir ? path.join(dir, relPath) : null
      return {
        id: `${name}:theme:${id}`,
        kind: "theme",
        packName: name,
        name: id,
        relPath,
        absPath,
        description: "OpenCode theme",
        bodyPreview: absPath ? readTextPreview(absPath) : "",
        executable: false,
      }
    })

    // MCP servers
    const mcpServers: CatalogAssetItem[] = []
    if (dir) {
      const configInfo = readPackConfigObject(dir)
      if (configInfo) {
        const servers = readMcpServers(configInfo.config) ?? {}
        for (const [serverName, rawCfg] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
          const cfg = (rawCfg && typeof rawCfg === "object" ? rawCfg : {}) as Record<string, any>
          const serverType = typeof cfg.type === "string" ? cfg.type : Array.isArray(cfg.command) ? "local" : typeof cfg.url === "string" ? "remote" : "mcp"
          const commandOrUrl = Array.isArray(cfg.command)
            ? cfg.command.join(" ")
            : typeof cfg.url === "string"
              ? cfg.url
              : ""
          const enabled = cfg.enabled !== false
          mcpServers.push({
            id: `${name}:mcp:${serverName}`,
            kind: "mcp",
            packName: name,
            name: serverName,
            relPath: configInfo.relPath,
            absPath: path.join(dir, configInfo.relPath),
            description: commandOrUrl ? `${serverType}: ${commandOrUrl}` : `${serverType} MCP server`,
            bodyPreview: JSON.stringify(cfg, null, 2),
            executable: true,
            extra: { serverType, commandOrUrl, enabled },
          })
        }
      }
    }

    const counts: PackAssetCounts = {
      agents: packAgents.length,
      skills: skills.length,
      commands: commands.length,
      tools: tools.length,
      plugins: plugins.length,
      themes: themes.length,
      mcp: mcpServers.length,
      total: packAgents.length + skills.length + commands.length + tools.length + plugins.length + themes.length + mcpServers.length,
    }

    const issues = validation?.issues ?? []
    const errorCount = issues.filter(i => i.level === "error").length
    const warningCount = issues.filter(i => i.level === "warning").length

    const entry: PackCatalogEntry = {
      name,
      dir,
      manifest,
      version: manifest?.version ?? "0.0.0",
      description: manifest?.description ?? "",
      requires: manifest?.requires ?? {},
      isVirtual,
      agents: packAgents,
      skills,
      commands,
      tools,
      plugins,
      themes,
      mcpServers,
      counts,
      validation,
      issues,
      errorCount,
      warningCount,
      executable,
      bridgeCompat: computeBridgeCompat(counts),
    }

    packs.push(entry)
    byName.set(name, entry)

    totals.agents += counts.agents
    totals.skills += counts.skills
    totals.commands += counts.commands
    totals.tools += counts.tools
    totals.plugins += counts.plugins
    totals.themes += counts.themes
    totals.mcp += counts.mcp
    totals.total += counts.total
  }

  return { packs, byName, totals }
}

export interface BuildCatalogTreeOptions {
  searchQuery: string
  assetFilter: AssetTypeFilter
  expandedCategories: ReadonlySet<string>
  expandedSections: ReadonlySet<string>
}

export function sectionKey(packName: string, kind: CatalogAssetKind): string {
  return `${packName}::${kind}`
}

/**
 * Builds the flat navigable Catalog tree: Pack -> Asset Type Section -> Asset Item.
 * When a search query is active, matching packs & sections auto-expand.
 * When filtering by a specific asset type without a search query, unopened packs stay collapsed.
 */
export function buildCatalogTreeItems(
  index: CatalogIndex,
  options: BuildCatalogTreeOptions,
): CatalogTreeItem[] {
  const query = options.searchQuery.trim().toLowerCase()
  const filter = options.assetFilter
  const autoExpand = query !== ""
  const items: CatalogTreeItem[] = []

  for (const pack of index.packs) {
    const matchesPackName = query !== "" && (
      pack.name.toLowerCase().includes(query) ||
      pack.description.toLowerCase().includes(query)
    )

    const matchingSections: Array<{
      kind: CatalogAssetKind
      agents?: AgentInfo[]
      assets?: CatalogAssetItem[]
    }> = []

    for (const kind of ASSET_SECTION_ORDER) {
      if (filter !== "all" && filter !== kind) continue

      if (kind === "agent") {
        const matched = pack.agents.filter(a =>
          !query ||
          matchesPackName ||
          agentId(a).toLowerCase().includes(query) ||
          a.filename.toLowerCase().includes(query),
        )
        if (matched.length > 0) matchingSections.push({ kind, agents: matched })
      } else {
        const list = getPackAssetsByKind(pack, kind)
        const matched = list.filter(asset =>
          !query ||
          matchesPackName ||
          asset.name.toLowerCase().includes(query) ||
          asset.description.toLowerCase().includes(query) ||
          asset.relPath.toLowerCase().includes(query),
        )
        if (matched.length > 0) matchingSections.push({ kind, assets: matched })
      }
    }

    // If filtering by a specific asset type, hide packs that have zero assets of that type.
    if (filter !== "all" && matchingSections.length === 0) continue
    // If searching by text, hide packs that match neither pack name nor any asset.
    if (query !== "" && !matchesPackName && matchingSections.length === 0) continue

    const isPackExpanded = autoExpand || options.expandedCategories.has(pack.name)
    const badges = formatPackAssetBadges(pack.counts)
    items.push({
      type: "folder",
      id: pack.name,
      category: pack.name,
      pack,
      label: `${isPackExpanded ? "▼" : "▶"} ${pack.name.toUpperCase()} ${badges}`,
    })

    if (!isPackExpanded) continue

    const omitSection = filter !== "all" || (matchingSections.length === 1 && matchingSections[0]!.kind === "agent")

    for (const sec of matchingSections) {
      const count = sec.agents ? sec.agents.length : (sec.assets?.length ?? 0)
      const secId = sectionKey(pack.name, sec.kind)
      const isSectionExpanded = omitSection || autoExpand || options.expandedSections.has(secId)
      if (!omitSection) {
        items.push({
          type: "section",
          id: secId,
          category: pack.name,
          assetKind: sec.kind,
          count,
          label: `  ${isSectionExpanded ? "▾" : "▸"} ${assetSectionLabel(sec.kind)} (${count})`,
        })
      }

      if (!isSectionExpanded) continue

      if (sec.agents) {
        for (const agent of sec.agents) {
          items.push({
            type: "file",
            id: agent.currentPath,
            category: pack.name,
            agent,
            label: omitSection ? `  ${agent.filename}` : `    ${agent.filename}`,
          })
        }
      } else if (sec.assets) {
        for (const asset of sec.assets) {
          items.push({
            type: "asset",
            id: asset.id,
            category: pack.name,
            assetKind: asset.kind,
            asset,
            label: omitSection ? `  ${asset.name}` : `    ${asset.name}`,
          })
        }
      }
    }
  }

  return items
}

export function getPackAssetsByKind(
  pack: PackCatalogEntry,
  kind: Exclude<CatalogAssetKind, "agent">,
): CatalogAssetItem[] {
  switch (kind) {
    case "skill": return pack.skills
    case "command": return pack.commands
    case "tool": return pack.tools
    case "plugin": return pack.plugins
    case "theme": return pack.themes
    case "mcp": return pack.mcpServers
  }
}
