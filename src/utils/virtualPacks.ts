import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import semver from "semver"
import YAML from "yaml"
import { atomicWriteRestrictedFile, extractFrontmatter, renderAgentFile } from "./agents.js"
import { assertInsideRealWorkspace, realpathThroughExistingAncestor } from "./pathValidation.js"
import {
  DISCOVERY_DEPTH,
  hasErrors,
  MANIFEST_FILE,
  MAX_SCANNED_BYTES,
  PACK_NAME_RE,
  SKIPPED_DIRS,
  validatePack,
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
  ".opencode",
  "bridges",
  "contract",
  "dist",
  "docs",
  "instructions",
  "plugins",
  "resources",
  "runtime",
  "skills",
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
  /** Source-relative path on disk (POSIX slashes), e.g. "architect.md" or "agents/architect.md". */
  sourceRel: string
  /** Canonical agent ID without ".md", e.g. "architect" or "team/architect". */
  id: string
  /** Inferred container kind if inside agents/agent/mode/modes, else "loose". */
  containerKind: "agents" | "agent" | "mode" | "modes" | "loose"
}

function hasAnyManifestWithinDepth(root: string): boolean {
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
 * Inside `agents/`, `agent/`, `mode/` or `modes/`, any `.md` file is an agent; elsewhere, `.md` files must carry
 * recognized agent YAML frontmatter (skipping README, AGENTS.md, SKILL.md, tests, etc.).
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
        if (!container && AGENT_CONTAINER_DIRS.has(entry.name)) {
          walk(full, depth + 1, { kind: entry.name as "agents" | "agent" | "mode" | "modes", root: full })
        } else if (container) {
          walk(full, depth + 1, container)
        } else if (!VIRTUAL_IGNORED_DIRS.has(entry.name) && depth < DISCOVERY_DEPTH) {
          // Skip subdirectories that hold their own opencode-pack.json.
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
  for (const link of skippedLinks) {
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

  // Include optional commands/*.md, skills/<id>/** and AGENTS.md if present in the folder without symlinks.
  const agentsMd = path.join(root, "AGENTS.md")
  if (fs.lstatSync(agentsMd, { throwIfNoEntry: false })?.isFile()) {
    registerVirtual("AGENTS.md", { sourceRel: "AGENTS.md" })
  }
  const commandsDir = path.join(root, "commands")
  if (fs.lstatSync(commandsDir, { throwIfNoEntry: false })?.isDirectory()) {
    const walkCommands = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink() || entry.name === ".DS_Store") continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walkCommands(full)
        else if (entry.isFile() && entry.name.endsWith(".md") && !/\.test\.[^/]+$/i.test(entry.name)) {
          const rel = path.relative(root, full).split(path.sep).join("/")
          if (registerVirtual(rel, { sourceRel: rel })) ids.commands.push(rel.slice("commands/".length, -3))
        }
      }
    }
    walkCommands(commandsDir)
  }
  const skillsDir = path.join(root, "skills")
  if (fs.lstatSync(skillsDir, { throwIfNoEntry: false })?.isDirectory()) {
    const skillFiles: string[] = []
    const walkSkills = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink() || entry.name === ".DS_Store" || entry.name === "node_modules") continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walkSkills(full)
        else if (entry.isFile() && !/\.test\.[^/]+$/i.test(entry.name)) skillFiles.push(path.relative(root, full).split(path.sep).join("/"))
      }
    }
    walkSkills(skillsDir)
    const skillRoots = skillFiles.filter(f => f.endsWith("/SKILL.md")).map(f => f.slice(0, -"/SKILL.md".length)).sort((a, b) => b.length - a.length)
    for (const sr of skillRoots) ids.skills.push(sr.slice("skills/".length))
    for (const rel of skillFiles) {
      if (!skillRoots.some(sr => rel.startsWith(`${sr}/`))) continue
      if (!registerVirtual(rel, { sourceRel: rel })) continue
      const full = path.join(root, ...rel.split("/"))
      if (SCRIPT_RE.test(rel) || (fs.statSync(full).mode & 0o111) !== 0) executable.skillScripts.push(rel)
    }
  }

  for (const list of Object.values(ids)) list.sort()
  files.sort()
  return { root, manifest, files, agents: packAgents, ids, executable, unresolved: [], issues, virtualFiles }
}

export interface InitPackOptions {
  name?: string
  version?: string
  description?: string
  /** Moves loose/legacy .md agents into `agents/<id>.md` and normalizes V1 frontmatter to V2 (default: true). */
  organize?: boolean
}

export interface InitPackResult {
  manifestPath: string
  manifest: PackManifest
  movedAgents: Array<{ from: string; to: string }>
  warnings: string[]
}

/** Scaffolds `opencode-pack.json` in a local folder of Markdown agents, optionally organizing `.md` files into `agents/`. */
export function initPackManifest(packRoot: string, options: InitPackOptions = {}): InitPackResult {
  const root = path.resolve(packRoot)
  const stat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${root} is not a regular directory`)
  }
  const manifestPath = path.join(root, MANIFEST_FILE)
  if (fs.existsSync(manifestPath)) {
    throw new Error(`${MANIFEST_FILE} already exists in ${root}`)
  }

  const name = (options.name?.trim() || derivePackSlug(path.basename(root))).toLowerCase()
  if (!PACK_NAME_RE.test(name)) {
    throw new Error(`Invalid pack name "${name}": use lowercase letters, digits and hyphens (max 64)`)
  }
  const version = options.version?.trim() || "0.1.0"
  if (semver.valid(version) !== version) {
    throw new Error(`Invalid version "${version}": use full semver, e.g. "0.1.0"`)
  }
  const description = options.description?.trim() || `Agent pack ${name}`
  const organize = options.organize !== false

  const { agents: discovered } = scanLooseAgentFiles(root)
  if (!discovered.length) {
    throw new Error(`No Markdown agent files found in ${root}`)
  }
  if (!organize) {
    const outsideAgentsDir = discovered.filter(item => item.containerKind !== "agents").map(item => item.sourceRel)
    if (outsideAgentsDir.length > 0) {
      throw new Error(
        `Cannot initialize ${MANIFEST_FILE} with --no-organize while agents sit outside agents/ (${outsideAgentsDir.join(", ")}); omit --no-organize to move them into agents/.`,
      )
    }
  }

  const ensureRealSubdir = (relFile: string) => {
    const parts = relFile.split("/").slice(0, -1)
    let cur = root
    for (const part of parts) {
      cur = path.join(cur, part)
      const st = fs.lstatSync(cur, { throwIfNoEntry: false })
      if (st?.isSymbolicLink()) throw new Error(`Refusing to write through symlinked directory: ${cur}`)
      if (st && !st.isDirectory()) throw new Error(`Cannot create directory "${cur}": a file is in the way`)
      if (!st) fs.mkdirSync(cur)
    }
    assertInsideRealWorkspace(root, realpathThroughExistingAncestor(path.join(root, ...relFile.split("/"))), relFile)
  }

  const foldedTargets = new Map<string, string>()
  for (const item of discovered) {
    const destRel = `agents/${item.id}.md`
    const key = foldKey(destRel)
    const prev = foldedTargets.get(key)
    if (prev && prev !== item.sourceRel) {
      throw new Error(`Cannot organize agents: "${prev}" and "${item.sourceRel}" both map to "${destRel}"`)
    }
    foldedTargets.set(key, item.sourceRel)
  }

  const movedAgents: Array<{ from: string; to: string }> = []
  if (organize) {
    for (const item of discovered) {
      const destRel = `agents/${item.id}.md`
      const srcFull = path.join(root, ...item.sourceRel.split("/"))
      const destFull = path.join(root, ...destRel.split("/"))
      const raw = fs.readFileSync(srcFull, "utf8")
      const { yamlText, body } = extractFrontmatter(raw)
      let fm: Record<string, any> = {}
      if (yamlText !== null) {
        const parsed = YAML.parse(yamlText)
        if (isPlain(parsed)) fm = parsed
      }
      const isMode = item.containerKind === "mode" || item.containerKind === "modes"
      if (isMode && !fm.mode) fm = { ...fm, mode: "primary" }
      const needsV2 = detectFrontmatterVersion(fm) === "v1" || isMode
      const nextBytes = Buffer.from(needsV2 ? renderAgentFile(fm, body, "v2") : raw, "utf8")

      if (item.sourceRel !== destRel) {
        ensureRealSubdir(destRel)
        if (fs.lstatSync(destFull, { throwIfNoEntry: false }) && foldKey(item.sourceRel) !== foldKey(destRel)) {
          throw new Error(`Refusing to overwrite existing file "${destRel}"`)
        }
        atomicWriteRestrictedFile(destFull, nextBytes, 0o644)
        if (path.resolve(srcFull) !== path.resolve(destFull)) fs.unlinkSync(srcFull)
        movedAgents.push({ from: item.sourceRel, to: destRel })
      } else if (needsV2) {
        ensureRealSubdir(destRel)
        atomicWriteRestrictedFile(destFull, nextBytes, 0o644)
      }
    }
    for (const legacyDir of ["agent", "mode", "modes"]) {
      const fullDir = path.join(root, legacyDir)
      if (fs.lstatSync(fullDir, { throwIfNoEntry: false })?.isDirectory()) {
        try {
          if (fs.readdirSync(fullDir).length === 0) fs.rmdirSync(fullDir)
        } catch {
          /* non-empty directory stays */
        }
      }
    }
  }

  const manifest: PackManifest = {
    contract: "1.0",
    name,
    version,
    description,
    requires: {},
  }
  const manifestJson = {
    $schema: "https://github.com/lorecanc/manage-agents/contract/opencode-pack.schema.json",
    contract: manifest.contract,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
  }
  atomicWriteRestrictedFile(manifestPath, Buffer.from(`${JSON.stringify(manifestJson, null, 2)}\n`, "utf8"), 0o644)

  const validation = validatePack(root)
  const warnings = validation.issues.map(issue => `[${issue.level}]${issue.path ? ` ${issue.path}:` : ""} ${issue.message}`)
  if (hasErrors(validation) && !organize) {
    warnings.unshift("Note: run with --organize (or move files under agents/) so the pack passes strict contract validation.")
  }
  return { manifestPath, manifest, movedAgents, warnings }
}
