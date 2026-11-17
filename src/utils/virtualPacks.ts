import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { extractFrontmatter, renderAgentFile } from "./agents.js"
import { initPackManifest, type InitPackOptions, type InitPackResult } from "./packOnboarding.js"
import {
  DISCOVERY_DEPTH,
  MANIFEST_FILE,
  MAX_SCANNED_BYTES,
  PACK_NAME_RE,
  SKIPPED_DIRS,
  type ExecutableSurface,
  type PackAgent,
  type PackIds,
  type PackIssue,
  type PackManifest,
  type PackValidation,
  type ValidatePackOptions,
  type VirtualFileEntry,
} from "./packs.js"
import { detectFrontmatterVersion } from "./v2Compat.js"

export { initPackManifest, type InitPackOptions, type InitPackResult }

export const VIRTUAL_PACK_VERSION = "0.0.0-virtual"

const AGENT_FRONTMATTER_KEYS = new Set([
  "description",
  "mode",
  "model",
  "permissions",
  "permission",
  "tools",
  "steps",
  "max_steps",
  "color",
  "hidden",
  "temperature",
  "top_p",
  "variant",
  "reasoningEffort",
  "options",
  "prompt",
  "disabled",
  "request",
])

const NON_AGENT_MD_RE = /^(?:README|LICENSE|LICENCE|CHANGELOG|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|AGENTS|CLAUDE|GUIDA|SKILL)(?:\.(?:md|txt|rst))?$/i
const VIRTUAL_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".manage-agents",
  "bridges",
  "contract",
  "dist",
  "docs",
  "instructions",
  "plugins",
  "resources",
  "runtime",
  "skills",
  "skill",
  "test",
  "tests",
  "themes",
  "tools",
  "commands",
  "command",
])
const AGENT_CONTAINER_DIRS = new Set(["agents", "agent", "mode", "modes"])
const SCRIPT_RE = /\.(?:sh|bash|zsh|py|rb|pl|ts|mts|js|mjs|cjs)$/

const isPlain = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const foldKey = (rel: string) => rel.normalize("NFC").toLowerCase()

/** Derives a valid contract pack name from a directory or source name. */
export function derivePackSlug(raw: string): string {
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "")
  if (cleaned && PACK_NAME_RE.test(cleaned)) return cleaned
  return "agents-pack"
}

/** True when a Markdown file outside `agents/` has YAML frontmatter with at least one OpenCode agent field. */
export function hasAgentFrontmatter(content: string): boolean {
  const { yamlText } = extractFrontmatter(content)
  if (yamlText === null) return false
  try {
    const parsed = YAML.parse(yamlText)
    return isPlain(parsed) && Object.keys(parsed).some(key => AGENT_FRONTMATTER_KEYS.has(key))
  } catch {
    return false
  }
}

export interface DiscoveredVirtualAgent {
  /** Source-relative path on disk (POSIX slashes), e.g. "architect.md", "agents/architect.md", or ".opencode/agents/architect.md". */
  sourceRel: string
  /** Canonical agent ID without ".md", e.g. "architect" or "team/architect". */
  id: string
  /** Inferred container kind if inside agents/agent/mode/modes, else "loose". */
  containerKind: "agents" | "agent" | "mode" | "modes" | "loose"
}

export interface DiscoveredVirtualCommand {
  sourceRel: string
  id: string
  canonicalRel: string
}

export interface DiscoveredVirtualSkillFile {
  sourceRel: string
  canonicalRel: string
  isScript: boolean
}

export interface DiscoveredVirtualSkill {
  id: string
  sourceSkillRoot: string
  files: DiscoveredVirtualSkillFile[]
}

export interface DiscoveredVirtualExtras {
  commands: DiscoveredVirtualCommand[]
  skills: DiscoveredVirtualSkill[]
  agentsMdSourceRel: string | null
  configSourceRel: string | null
  skippedLinks: string[]
}

export function hasAnyManifestWithinDepth(root: string): boolean {
  const check = (dir: string, depth: number): boolean => {
    if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return true
    if (depth >= DISCOVERY_DEPTH) return false
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRS.has(entry.name)) continue
      if (check(path.join(dir, entry.name), depth + 1)) return true
    }
    return false
  }
  return check(root, 0)
}

/**
 * Scans a manifest-free directory for Markdown agent files without following symlinks.
 * Inside `agents/`, `agent/`, `mode/`, `modes/` (including under `.opencode/`), any `.md` file is an agent;
 * elsewhere, `.md` files must carry recognized agent YAML frontmatter (skipping README, AGENTS.md, SKILL.md, tests, etc.).
 */
export function scanLooseAgentFiles(root: string): { agents: DiscoveredVirtualAgent[]; skippedLinks: string[] } {
  const resolvedRoot = path.resolve(root)
  const stat = fs.lstatSync(resolvedRoot, { throwIfNoEntry: false })
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return { agents: [], skippedLinks: [] }
  // Never treat a directory that already has opencode-pack.json (or nested manifest-bearing packs) as virtual.
  if (hasAnyManifestWithinDepth(resolvedRoot)) return { agents: [], skippedLinks: [] }

  const agents: DiscoveredVirtualAgent[] = []
  const skippedLinks: string[] = []

  const walk = (dir: string, depth: number, container: { kind: "agents" | "agent" | "mode" | "modes"; root: string } | null) => {
    if (depth > DISCOVERY_DEPTH + 2) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".git") || entry.name === ".DS_Store") continue
      const full = path.join(dir, entry.name)
      const rel = path.relative(resolvedRoot, full).split(path.sep).join("/")
      if (entry.isSymbolicLink()) {
        skippedLinks.push(rel)
        continue
      }
      if (entry.isDirectory()) {
        if (!container && entry.name === ".opencode" && depth === 0) {
          // Inspect only explicit agent containers inside `.opencode/` (never `.opencode/plans/` or unrelated markdown).
          let dotEntries: fs.Dirent[] = []
          try {
            dotEntries = fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
          } catch {
            dotEntries = []
          }
          for (const sub of dotEntries) {
            const subFull = path.join(full, sub.name)
            const subRel = path.relative(resolvedRoot, subFull).split(path.sep).join("/")
            if (sub.isSymbolicLink()) {
              skippedLinks.push(subRel)
              continue
            }
            if (sub.isDirectory() && AGENT_CONTAINER_DIRS.has(sub.name)) {
              walk(subFull, depth + 2, { kind: sub.name as "agents" | "agent" | "mode" | "modes", root: subFull })
            }
          }
          continue
        }
        if (!container && AGENT_CONTAINER_DIRS.has(entry.name)) {
          walk(full, depth + 1, { kind: entry.name as "agents" | "agent" | "mode" | "modes", root: full })
        } else if (container) {
          walk(full, depth + 1, container)
        } else if (!VIRTUAL_IGNORED_DIRS.has(entry.name) && entry.name !== ".opencode" && depth < DISCOVERY_DEPTH) {
          if (fs.existsSync(path.join(full, MANIFEST_FILE))) continue
          walk(full, depth + 1, null)
        }
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".md") || /\.test\.[^/]+$/i.test(entry.name)) continue
      if (NON_AGENT_MD_RE.test(entry.name)) continue

      if (container) {
        const subRel = path.relative(container.root, full).split(path.sep).join("/")
        agents.push({ sourceRel: rel, id: subRel.slice(0, -3), containerKind: container.kind })
      } else {
        let size = 0
        try {
          size = fs.statSync(full).size
        } catch {
          continue
        }
        if (size > MAX_SCANNED_BYTES) continue
        const content = fs.readFileSync(full, "utf8")
        if (hasAgentFrontmatter(content)) {
          agents.push({ sourceRel: rel, id: rel.slice(0, -3), containerKind: "loose" })
        }
      }
    }
  }

  walk(resolvedRoot, 0, null)
  return { agents, skippedLinks }
}

/** Scans optional commands, skills, AGENTS.md and opencode.json(c) (at root or inside `.opencode/`) without following symlinks. */
export function scanVirtualExtras(
  root: string,
  options: { preferDotOpencode?: boolean } = {},
): DiscoveredVirtualExtras {
  const resolvedRoot = path.resolve(root)
  const commands: DiscoveredVirtualCommand[] = []
  const skills: DiscoveredVirtualSkill[] = []
  const skippedLinks: string[] = []

  const isRealDir = (candidate: string): boolean => {
    const st = fs.lstatSync(candidate, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) {
      skippedLinks.push(path.relative(resolvedRoot, candidate).split(path.sep).join("/"))
      return false
    }
    return Boolean(st?.isDirectory())
  }

  const dotOpencode = path.join(resolvedRoot, ".opencode")
  const hasDotOpencode = isRealDir(dotOpencode)

  let agentsMdSourceRel: string | null = null
  const agentsMdCandidates =
    options.preferDotOpencode && hasDotOpencode
      ? [".opencode/AGENTS.md", "AGENTS.md"]
      : ["AGENTS.md", ...(hasDotOpencode ? [".opencode/AGENTS.md"] : [])]
  for (const rel of agentsMdCandidates) {
    const full = path.join(resolvedRoot, ...rel.split("/"))
    const st = fs.lstatSync(full, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) skippedLinks.push(rel)
    else if (st?.isFile()) {
      agentsMdSourceRel = rel
      break
    }
  }

  let configSourceRel: string | null = null
  const configCandidates =
    options.preferDotOpencode && hasDotOpencode
      ? [".opencode/opencode.json", ".opencode/opencode.jsonc", "opencode.json", "opencode.jsonc"]
      : ["opencode.json", "opencode.jsonc", ...(hasDotOpencode ? [".opencode/opencode.json", ".opencode/opencode.jsonc"] : [])]
  for (const rel of configCandidates) {
    const full = path.join(resolvedRoot, ...rel.split("/"))
    const st = fs.lstatSync(full, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) skippedLinks.push(rel)
    else if (st?.isFile()) {
      configSourceRel = rel
      break
    }
  }

  const commandContainers = ["commands", "command", ...(hasDotOpencode ? [".opencode/commands", ".opencode/command"] : [])]
  for (const containerRel of commandContainers) {
    const containerFull = path.join(resolvedRoot, ...containerRel.split("/"))
    if (!isRealDir(containerFull)) continue
    const walkCommands = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === ".DS_Store") continue
        const full = path.join(dir, entry.name)
        const rel = path.relative(resolvedRoot, full).split(path.sep).join("/")
        if (entry.isSymbolicLink()) {
          skippedLinks.push(rel)
          continue
        }
        if (entry.isDirectory()) walkCommands(full)
        else if (entry.isFile() && entry.name.endsWith(".md") && !/\.test\.[^/]+$/i.test(entry.name)) {
          const id = path.relative(containerFull, full).split(path.sep).join("/").slice(0, -3)
          commands.push({ sourceRel: rel, id, canonicalRel: `commands/${id}.md` })
        }
      }
    }
    walkCommands(containerFull)
  }

  const skillContainers = ["skills", "skill", ...(hasDotOpencode ? [".opencode/skills", ".opencode/skill"] : [])]
  for (const containerRel of skillContainers) {
    const containerFull = path.join(resolvedRoot, ...containerRel.split("/"))
    if (!isRealDir(containerFull)) continue
    const rawFiles: string[] = []
    const walkSkills = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === ".DS_Store" || entry.name === "node_modules") continue
        const full = path.join(dir, entry.name)
        const rel = path.relative(resolvedRoot, full).split(path.sep).join("/")
        if (entry.isSymbolicLink()) {
          skippedLinks.push(rel)
          continue
        }
        if (entry.isDirectory()) walkSkills(full)
        else if (entry.isFile() && !/\.test\.[^/]+$/i.test(entry.name)) rawFiles.push(rel)
      }
    }
    walkSkills(containerFull)
    const skillRoots = rawFiles
      .filter(f => f.endsWith("/SKILL.md"))
      .map(f => f.slice(0, -"/SKILL.md".length))
      .sort((a, b) => b.length - a.length)
    const filesBySkillRoot = new Map<string, string[]>()
    for (const sr of skillRoots) filesBySkillRoot.set(sr, [])
    for (const rel of rawFiles) {
      const nearest = skillRoots.find(candidate => rel.startsWith(`${candidate}/`))
      if (nearest) filesBySkillRoot.get(nearest)!.push(rel)
    }
    for (const sr of [...skillRoots].reverse()) {
      const id = sr.slice(containerRel.length + 1)
      if (!id) continue
      const memberRels = filesBySkillRoot.get(sr) ?? []
      const skillFiles: DiscoveredVirtualSkillFile[] = memberRels.map(sourceRel => {
        const subRel = sourceRel.slice(sr.length + 1)
        const canonicalRel = `skills/${id}/${subRel}`
        const full = path.join(resolvedRoot, ...sourceRel.split("/"))
        const isScript = SCRIPT_RE.test(sourceRel) || (fs.statSync(full).mode & 0o111) !== 0
        return { sourceRel, canonicalRel, isScript }
      })
      skills.push({ id, sourceSkillRoot: sr, files: skillFiles })
    }
  }

  return { commands, skills, agentsMdSourceRel, configSourceRel, skippedLinks }
}

export function isVirtualPackRoot(root: string): boolean {
  return scanLooseAgentFiles(root).agents.length > 0
}

export function virtualManifestHash(manifest: PackManifest): string {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
}

/** Synthesizes and validates a virtual pack from a manifest-free folder of Markdown agents (plus optional commands/skills). */
export function validateVirtualPack(
  packRoot: string,
  options: ValidatePackOptions & { name?: string } = {},
): PackValidation {
  const root = path.resolve(packRoot)
  const issues: PackIssue[] = []
  const ids: PackIds = { agents: [], commands: [], skills: [], plugins: [], themes: [], mcpServers: [] }
  const executable: ExecutableSurface = { plugins: [], pluginPackages: [], toolModules: [], skillScripts: [], mcpServers: [], externalCommands: [] }
  const virtualFiles: Record<string, VirtualFileEntry> = {}
  const files: string[] = []
  const packAgents: PackAgent[] = []

  const name = options.name && PACK_NAME_RE.test(options.name) ? options.name : derivePackSlug(path.basename(root))
  const { agents: discovered, skippedLinks } = scanLooseAgentFiles(root)
  const extras = discovered.length > 0 ? scanVirtualExtras(root) : { commands: [], skills: [], agentsMdSourceRel: null, configSourceRel: null, skippedLinks: [] }
  for (const link of new Set([...skippedLinks, ...extras.skippedLinks])) {
    issues.push({ level: "warning", code: "symlink-skipped", path: link, message: "symlink skipped in virtual pack" })
  }
  if (!discovered.length) {
    issues.push({ level: "error", code: "virtual-empty", message: `${root} contains no Markdown agent files` })
    return { root, manifest: null, files, agents: packAgents, ids, executable, unresolved: [], issues }
  }

  const manifest: PackManifest = {
    contract: "1.1",
    name,
    version: VIRTUAL_PACK_VERSION,
    description: `Virtual agent pack (${name})`,
    requires: {},
  }

  const seenFolded = new Map<string, string>()
  const registerVirtual = (canonicalRel: string, entry: VirtualFileEntry) => {
    const key = foldKey(canonicalRel)
    const previous = seenFolded.get(key)
    if (previous) {
      issues.push({ level: "error", code: "case-collision", path: entry.sourceRel, message: `maps to "${canonicalRel}", colliding with "${previous}"` })
      return false
    }
    seenFolded.set(key, entry.sourceRel)
    files.push(canonicalRel)
    virtualFiles[canonicalRel] = entry
    return true
  }

  for (const item of discovered) {
    const canonicalRel = `agents/${item.id}.md`
    const full = path.join(root, ...item.sourceRel.split("/"))
    const raw = fs.readFileSync(full, "utf8")
    const { yamlText, body } = extractFrontmatter(raw)
    let frontmatter: Record<string, any> = {}
    if (yamlText !== null) {
      try {
        const parsed = YAML.parse(yamlText)
        if (parsed !== null && !isPlain(parsed)) {
          issues.push({ level: "error", code: "agent-frontmatter", path: item.sourceRel, message: "frontmatter must be a YAML mapping" })
          continue
        }
        frontmatter = (parsed as Record<string, any>) ?? {}
      } catch (err) {
        issues.push({ level: "error", code: "agent-frontmatter", path: item.sourceRel, message: `invalid YAML frontmatter: ${(err as Error).message}` })
        continue
      }
    }

    let needsRewrite = false
    const version = detectFrontmatterVersion(frontmatter)
    if ((item.containerKind === "mode" || item.containerKind === "modes") && !frontmatter.mode) {
      frontmatter = { ...frontmatter, mode: "primary" }
      needsRewrite = true
    }
    const rendered = version === "v1" || needsRewrite ? renderAgentFile(frontmatter, body, "v2") : null
    const effectiveFm = rendered ? (YAML.parse(extractFrontmatter(rendered).yamlText ?? "{}") as Record<string, any>) : frontmatter
    if (effectiveFm.mode !== undefined && effectiveFm.mode !== "primary" && effectiveFm.mode !== "subagent" && effectiveFm.mode !== "all") {
      issues.push({ level: "error", code: "agent-mode", path: item.sourceRel, message: `invalid agent mode "${String(effectiveFm.mode)}"` })
    }
    if (!registerVirtual(canonicalRel, { sourceRel: item.sourceRel, ...(rendered ? { content: Buffer.from(rendered, "utf8") } : {}) })) continue
    ids.agents.push(item.id)
    packAgents.push({
      id: item.id,
      ...(typeof effectiveFm.mode === "string" ? { mode: effectiveFm.mode } : {}),
      ...(typeof effectiveFm.model === "string" ? { model: effectiveFm.model } : {}),
    })
  }

  if (extras.agentsMdSourceRel) {
    registerVirtual("AGENTS.md", { sourceRel: extras.agentsMdSourceRel })
  }
  for (const cmd of extras.commands) {
    if (registerVirtual(cmd.canonicalRel, { sourceRel: cmd.sourceRel })) {
      ids.commands.push(cmd.id)
    }
  }
  for (const skill of extras.skills) {
    let registeredAny = false
    for (const sf of skill.files) {
      if (!registerVirtual(sf.canonicalRel, { sourceRel: sf.sourceRel })) continue
      registeredAny = true
      if (sf.isScript) executable.skillScripts.push(sf.canonicalRel)
    }
    if (registeredAny) ids.skills.push(skill.id)
  }

  for (const list of Object.values(ids)) list.sort()
  files.sort()
  return { root, manifest, files, agents: packAgents, ids, executable, unresolved: [], issues, virtualFiles }
}
