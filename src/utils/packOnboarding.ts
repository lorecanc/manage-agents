import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import semver from "semver"
import YAML from "yaml"
import { atomicWriteRestrictedFile, extractFrontmatter, renderAgentFile } from "./agents.js"
import { manifestName } from "./catalog.js"
import { assertInsideRealWorkspace, realpathThroughExistingAncestor } from "./pathValidation.js"
import {
  discoverPackDirs,
  CONFIG_KEYS,
  CONTRACT_VERSION,
  hasErrors,
  LEGACY_DIRS,
  MANIFEST_FILE,
  NATIVE_DIRS,
  PACK_NAME_RE,
  parseJsonc,
  RESERVED_DIRS,
  ROOT_FILE_RE,
  validatePack,
  type PackIssue,
  type PackManifest,
  type PackValidation,
} from "./packs.js"
import {
  addSource,
  cloneSourceToWorkingTree,
  deriveSourceName,
  saveSources,
  type GitOptions,
  type Source,
  type SourceRegistry,
} from "./sources.js"
import { detectFrontmatterVersion } from "./v2Compat.js"
import {
  derivePackSlug,
  hasAnyManifestWithinDepth,
  scanLooseAgentFiles,
  scanVirtualExtras,
  type DiscoveredVirtualAgent,
  type DiscoveredVirtualCommand,
  type DiscoveredVirtualSkill,
} from "./virtualPacks.js"

export type OnboardingLayout = "auto" | "root" | "subpack"
export type EffectiveOnboardingLayout = "root" | "subpack"
export type SemverReleaseKind = "patch" | "minor" | "major"
export type ScaffoldResourceKind = "agent" | "skill" | "command"

const APP_PROJECT_MARKERS = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "tsconfig.json",
  "cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gemfile",
  "composer.json",
  "makefile",
  "cmakelists.txt",
  "dockerfile",
  "src",
  "app",
  "apps",
  "packages",
  "lib",
  "cmd",
  "internal",
  "server",
  "client",
  "backend",
  "frontend",
])

const RESOURCE_ID_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?(?:\/[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?)*$/
const currentContract = () => `${CONTRACT_VERSION.major}.${CONTRACT_VERSION.minor}`
const AUTHORING_SKILL_REL = ".opencode/skills/opencode-pack-authoring/SKILL.md"
const CI_WORKFLOW_REL = ".github/workflows/validate-pack.yml"

const isPlain = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const foldKey = (rel: string) => rel.normalize("NFC").toLowerCase()

function resolveBundledAuthoringSkillPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, "../contract/skills/opencode-pack-authoring/SKILL.md"),
    path.resolve(here, "../../contract/skills/opencode-pack-authoring/SKILL.md"),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

function ensureSafeDirWithin(baseRoot: string, relFile: string): string {
  const realBase = fs.realpathSync(baseRoot)
  const parts = relFile.split("/").filter(Boolean)
  let cur = realBase
  for (const part of parts.slice(0, -1)) {
    if (part === "." || part === "..") throw new Error(`Unsafe relative path "${relFile}"`)
    cur = path.join(cur, part)
    const st = fs.lstatSync(cur, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) throw new Error(`Refusing to write through symlinked directory: ${cur}`)
    if (st && !st.isDirectory()) throw new Error(`Cannot create directory "${cur}": a file is in the way`)
    if (!st) fs.mkdirSync(cur)
  }
  const destFull = path.join(realBase, ...parts)
  const existingDest = fs.lstatSync(destFull, { throwIfNoEntry: false })
  if (existingDest?.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink: ${destFull}`)
  assertInsideRealWorkspace(realBase, realpathThroughExistingAncestor(destFull), relFile)
  return destFull
}

function hasCaseFoldCollisionOnDisk(baseRoot: string, relFile: string, allowedSourceRel?: string): boolean {
  const parts = relFile.split("/").filter(Boolean)
  let cur = baseRoot
  for (let i = 0; i < parts.length; i++) {
    const wanted = parts[i]
    const wantedFolded = foldKey(wanted)
    let entries: string[]
    try {
      entries = fs.readdirSync(cur)
    } catch {
      return false
    }
    const match = entries.find(entry => foldKey(entry) === wantedFolded)
    if (!match) return false
    if (i === parts.length - 1) {
      const matchedRel = [...parts.slice(0, -1), match].join("/")
      if (allowedSourceRel && foldKey(matchedRel) === foldKey(allowedSourceRel)) return false
      return true
    }
    cur = path.join(cur, match)
  }
  return false
}

function saveUserConfigBackup(realRepo: string, removed: Record<string, unknown>): string {
  const backupRel = ".opencode/opencode.user-backup.json"
  const safeBackup = ensureSafeDirWithin(realRepo, backupRel)
  let merged: Record<string, unknown> = {}
  if (fs.lstatSync(safeBackup, { throwIfNoEntry: false })?.isFile()) {
    try {
      const existing = JSON.parse(fs.readFileSync(safeBackup, "utf8"))
      if (isPlain(existing)) merged = { ...existing }
    } catch {
      /* replace unreadable JSON */
    }
  }
  Object.assign(merged, removed)
  atomicWriteRestrictedFile(safeBackup, Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8"), 0o600)

  // Ensure `.opencode/.gitignore` ignores `opencode.user-backup.json` so stripped credentials/keys are never committed.
  const gitignoreRel = ".opencode/.gitignore"
  const safeGitignore = ensureSafeDirWithin(realRepo, gitignoreRel)
  const existingIgnore = fs.lstatSync(safeGitignore, { throwIfNoEntry: false })?.isFile()
    ? fs.readFileSync(safeGitignore, "utf8")
    : ""
  if (!existingIgnore.split(/\r?\n/).some(line => line.trim() === "opencode.user-backup.json")) {
    const nextIgnore = `${existingIgnore.trimEnd()}${existingIgnore.trim() ? "\n" : ""}opencode.user-backup.json\n`
    atomicWriteRestrictedFile(safeGitignore, Buffer.from(nextIgnore, "utf8"), 0o644)
  }
  return backupRel
}

function rewriteMovedConfigPaths(packConfig: Record<string, unknown>): Record<string, unknown> {
  const rewriteItem = (item: unknown): unknown => {
    if (typeof item !== "string") return item
    const normalized = item.replace(/^\.\//, "")
    if (normalized.startsWith(".opencode/skills/")) return `./skills/${normalized.slice(".opencode/skills/".length)}`
    if (normalized.startsWith(".opencode/skill/")) return `./skills/${normalized.slice(".opencode/skill/".length)}`
    if (normalized.startsWith("skill/")) return `./skills/${normalized.slice("skill/".length)}`
    if (normalized === ".opencode/AGENTS.md") return "AGENTS.md"
    return item
  }
  const out = { ...packConfig }
  if (Array.isArray(out.skills)) out.skills = out.skills.map(rewriteItem)
  if (Array.isArray(out.instructions)) out.instructions = out.instructions.map(rewriteItem)
  return out
}

function pruneEmptyDirs(root: string, relDirs: string[]) {
  const sorted = [...relDirs].sort((a, b) => b.length - a.length)
  for (const rel of sorted) {
    const full = path.join(root, ...rel.split("/"))
    const st = fs.lstatSync(full, { throwIfNoEntry: false })
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue
    try {
      const remaining = fs.readdirSync(full).filter(entry => entry !== ".DS_Store")
      if (remaining.length === 0) {
        const ds = path.join(full, ".DS_Store")
        if (fs.lstatSync(ds, { throwIfNoEntry: false })?.isFile()) fs.unlinkSync(ds)
        fs.rmdirSync(full)
      }
    } catch {
      /* non-empty directory stays */
    }
  }
}

export interface OnboardingInspection {
  root: string
  suggestedName: string
  recommendedLayout: EffectiveOnboardingLayout
  mixedProjectFiles: string[]
  hasDotOpencode: boolean
  agents: DiscoveredVirtualAgent[]
  v1AgentCount: number
  commands: DiscoveredVirtualCommand[]
  skills: Array<{ id: string; sourceSkillRoot: string; fileCount: number }>
  agentsMdSourceRel: string | null
  configSourceRel: string | null
  configUserKeys: string[]
  configPackKeys: string[]
  inferredArchetype: { callers: string[]; reference: string } | null
}

function inferArchetypeFromAgents(
  agentModes: Array<{ id: string; mode?: string }>,
): { callers: string[]; reference: string } | null {
  const callers = agentModes.filter(a => a.mode !== "subagent").map(a => a.id).sort()
  const subagents = agentModes.filter(a => a.mode === "subagent").map(a => a.id)
  if (callers.length === 0 || subagents.length === 0) return null
  return { callers, reference: callers[0] }
}

/** Inspects a manifest-free folder or cloned repo and builds a non-destructive onboarding preview. */
export function inspectOnboardingCandidate(
  repoRoot: string,
  options: { name?: string } = {},
): OnboardingInspection {
  const root = path.resolve(repoRoot)
  const suggestedName = options.name && PACK_NAME_RE.test(options.name) ? options.name : derivePackSlug(path.basename(root))
  const { agents } = scanLooseAgentFiles(root)

  let v1AgentCount = 0
  const agentModes: Array<{ id: string; mode?: string }> = []
  for (const item of agents) {
    const full = path.join(root, ...item.sourceRel.split("/"))
    let fm: Record<string, any> = {}
    try {
      const raw = fs.readFileSync(full, "utf8")
      const { yamlText } = extractFrontmatter(raw)
      if (yamlText !== null) {
        const parsed = YAML.parse(yamlText)
        if (isPlain(parsed)) fm = parsed
      }
    } catch {
      fm = {}
    }
    if (detectFrontmatterVersion(fm) === "v1") v1AgentCount++
    const effectiveMode =
      typeof fm.mode === "string"
        ? fm.mode
        : item.containerKind === "mode" || item.containerKind === "modes"
          ? "primary"
          : undefined
    agentModes.push({ id: item.id, mode: effectiveMode })
  }

  const looseTopFiles = new Set(
    agents
      .filter(a => !a.sourceRel.includes("/"))
      .map(a => a.sourceRel),
  )
  const mixedProjectFiles: string[] = []
  let hasAppMarker = false
  let hasDotOpencode = false
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store" || entry.name.startsWith(".git")) continue
      if (entry.name === ".opencode") {
        hasDotOpencode = true
        continue
      }
      const lower = entry.name.toLowerCase()
      if (APP_PROJECT_MARKERS.has(lower)) {
        hasAppMarker = true
        mixedProjectFiles.push(entry.name)
        continue
      }
      if (entry.isFile()) {
        if (ROOT_FILE_RE.test(entry.name) || looseTopFiles.has(entry.name)) continue
        mixedProjectFiles.push(entry.name)
      } else if (entry.isDirectory()) {
        if (NATIVE_DIRS.has(entry.name) || LEGACY_DIRS.has(entry.name) || entry.name === "resources" || entry.name === "packs") continue
        // Check if subdirectory only holds loose agents that will be moved into agents/
        const holdsDiscoveredAgents = agents.some(a => a.sourceRel.startsWith(`${entry.name}/`))
        if (!holdsDiscoveredAgents) mixedProjectFiles.push(`${entry.name}/`)
      }
    }
  } catch {
    /* ignore unreadable directory */
  }

  const recommendedLayout: EffectiveOnboardingLayout =
    hasAppMarker || mixedProjectFiles.some(item => !item.endsWith("/")) ? "subpack" : "root"
  const extras = scanVirtualExtras(root, { preferDotOpencode: recommendedLayout === "subpack" })

  let configUserKeys: string[] = []
  let configPackKeys: string[] = []
  if (extras.configSourceRel) {
    try {
      const text = fs.readFileSync(path.join(root, ...extras.configSourceRel.split("/")), "utf8")
      const parsed = parseJsonc(text)
      if (isPlain(parsed)) {
        for (const key of Object.keys(parsed)) {
          if (key === "$schema") continue
          if (CONFIG_KEYS.has(key)) configPackKeys.push(key)
          else configUserKeys.push(key)
        }
      }
    } catch {
      /* reported during apply/validate */
    }
  }

  return {
    root,
    suggestedName,
    recommendedLayout,
    mixedProjectFiles,
    hasDotOpencode: hasDotOpencode || agents.some(a => a.sourceRel.startsWith(".opencode/")) || Boolean(extras.configSourceRel?.startsWith(".opencode/")),
    agents,
    v1AgentCount,
    commands: extras.commands,
    skills: extras.skills.map(s => ({ id: s.id, sourceSkillRoot: s.sourceSkillRoot, fileCount: s.files.length })),
    agentsMdSourceRel:
      recommendedLayout === "subpack" && extras.agentsMdSourceRel === "AGENTS.md" ? null : extras.agentsMdSourceRel,
    configSourceRel: extras.configSourceRel,
    configUserKeys,
    configPackKeys,
    inferredArchetype: inferArchetypeFromAgents(agentModes),
  }
}

export function suggestCloneDestination(source: Source, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || os.homedir()
  if (source.kind === "local") return source.path
  const tail = source.url.replace(/\.git$/i, "").split(/[/:]/).filter(Boolean).pop() ?? source.name
  return path.join(home, "dev", derivePackSlug(tail))
}

/** Clones a remote Git source into a local working directory and switches the source registry to that writable clone. */
export function cloneGitSourceForOnboarding(params: {
  source: Source
  destDir: string
  registry: SourceRegistry
  env?: NodeJS.ProcessEnv
  gitOptions?: GitOptions
}): { localRoot: string; localSource: Source } {
  const { source, destDir, registry, env = process.env, gitOptions = {} } = params
  const localRoot = cloneSourceToWorkingTree(source, destDir, env, gitOptions)
  let localSource = registry.sources.find(
    candidate => candidate.kind === "local" && candidate.path === localRoot,
  )
  if (!localSource) {
    const preferredName = deriveSourceName(`${source.name}-local`, registry)
    localSource = addSource(registry, preferredName, localRoot, { trusted: source.trusted }, gitOptions)
  }
  registry.active = localSource.name
  saveSources(registry, env)
  return { localRoot, localSource }
}

export interface InitPackOptions {
  name?: string
  version?: string
  description?: string
  /** Moves loose/legacy/.opencode .md agents, skills and commands into canonical pack directories and upgrades V1 frontmatter to V2 (default: true). */
  organize?: boolean
  /** Placement of the pack: "root" (./), "subpack" (./packs/<name>/), or "auto" (detect mixed project files). */
  layout?: OnboardingLayout
  /** Populate `archetype` automatically when primary + subagent roles exist (default: true). */
  inferArchetype?: boolean
  /** Install `.opencode/skills/opencode-pack-authoring/SKILL.md`, `.github/workflows/validate-pack.yml` and starter `README.md` (default: false). */
  authoringKit?: boolean
}

export interface InitPackResult {
  manifestPath: string
  packDir: string
  layout: EffectiveOnboardingLayout
  manifest: PackManifest
  movedAgents: Array<{ from: string; to: string }>
  movedResources: Array<{ from: string; to: string }>
  strippedConfigKeys: string[]
  kitFiles: string[]
  warnings: string[]
  validation: PackValidation
}

function buildValidateWorkflowYaml(relativePackDir: string): string {
  const targetArg = relativePackDir === "." || !relativePackDir ? "." : relativePackDir
  return `name: Validate OpenCode Pack

on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  validate-pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "26"
      - name: Validate OpenCode pack contract
        run: npx --yes github:lorecanc/manage-agents pack validate ${targetArg} --git
`
}

function buildStarterReadme(manifest: PackManifest, relativePackDir: string): string {
  const validateTarget = relativePackDir === "." || !relativePackDir ? "." : relativePackDir
  return `# ${manifest.name}

${manifest.description}

## OpenCode Pack (contract ${manifest.contract})

Install this pack with \`manage-agents\`:

\`\`\`bash
npx github:lorecanc/manage-agents source add <owner>/<repo> --pull
npx github:lorecanc/manage-agents install ${manifest.name}
\`\`\`

Validate and maintain the pack locally:

\`\`\`bash
npx github:lorecanc/manage-agents pack doctor ${validateTarget} --fix
npx github:lorecanc/manage-agents pack validate ${validateTarget}
\`\`\`
`
}

/** Installs repo-local authoring helpers (`.opencode` authoring skill, GitHub Actions validation workflow, and starter README if missing). */
export function installPackAuthoringKit(repoRoot: string, packDir: string, manifest: PackManifest): string[] {
  const realRepo = fs.realpathSync(repoRoot)
  const realPack = fs.realpathSync(packDir)
  const written: string[] = []

  const skillSrc = resolveBundledAuthoringSkillPath()
  if (skillSrc) {
    const destFull = ensureSafeDirWithin(realRepo, AUTHORING_SKILL_REL)
    atomicWriteRestrictedFile(destFull, fs.readFileSync(skillSrc), 0o644)
    written.push(AUTHORING_SKILL_REL)
  }

  const workflowFull = path.join(realRepo, ...CI_WORKFLOW_REL.split("/"))
  if (!fs.lstatSync(workflowFull, { throwIfNoEntry: false })) {
    const relPack = path.relative(realRepo, realPack).split(path.sep).join("/") || "."
    const safeWorkflow = ensureSafeDirWithin(realRepo, CI_WORKFLOW_REL)
    atomicWriteRestrictedFile(safeWorkflow, Buffer.from(buildValidateWorkflowYaml(relPack), "utf8"), 0o644)
    written.push(CI_WORKFLOW_REL)
  }

  const hasReadme = ["README.md", "README", "README.txt", "README.rst"].some(name =>
    Boolean(fs.lstatSync(path.join(realPack, name), { throwIfNoEntry: false })),
  )
  if (!hasReadme) {
    const relPack = path.relative(realRepo, realPack).split(path.sep).join("/") || "."
    const safeReadme = ensureSafeDirWithin(realPack, "README.md")
    atomicWriteRestrictedFile(safeReadme, Buffer.from(buildStarterReadme(manifest, relPack), "utf8"), 0o644)
    const repoRelReadme = path.relative(realRepo, safeReadme).split(path.sep).join("/")
    written.push(repoRelReadme)
  }

  return written
}

/** Full pack onboarding: organizes loose / legacy / `.opencode/` resources into a Contract 1.1 pack. */
export function applyPackOnboarding(repoRoot: string, options: InitPackOptions = {}): InitPackResult {
  const root = path.resolve(repoRoot)
  const stat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${root} is not a regular directory`)
  }
  if (hasAnyManifestWithinDepth(root)) {
    const existingRootManifest = path.join(root, MANIFEST_FILE)
    if (fs.existsSync(existingRootManifest)) {
      throw new Error(`${MANIFEST_FILE} already exists in ${root}`)
    }
    throw new Error(`A pack manifest (${MANIFEST_FILE}) already exists inside ${root}`)
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
  const inferArchetype = options.inferArchetype !== false

  const inspection = inspectOnboardingCandidate(root, { name })
  if (!inspection.agents.length) {
    throw new Error(`No Markdown agent files found in ${root}`)
  }

  const layoutChoice: OnboardingLayout = options.layout ?? "auto"
  const effectiveLayout: EffectiveOnboardingLayout =
    layoutChoice === "auto" ? inspection.recommendedLayout : layoutChoice

  if (organize && effectiveLayout === "root") {
    const appCollisions = inspection.mixedProjectFiles.filter(item =>
      APP_PROJECT_MARKERS.has(item.replace(/\/$/, "").toLowerCase()),
    )
    if (appCollisions.length > 0) {
      throw new Error(
        `Cannot onboard mixed project repository at root (${appCollisions.join(", ")}); use --layout subpack (packs/${name}/) so application files stay untouched.`,
      )
    }
  }

  if (!organize) {
    if (effectiveLayout === "subpack") {
      throw new Error(`Cannot initialize subpack layout (packs/${name}) with --no-organize`)
    }
    const outsideAgentsDir = inspection.agents
      .filter(item => item.sourceRel !== `agents/${item.id}.md`)
      .map(item => item.sourceRel)
    if (outsideAgentsDir.length > 0) {
      throw new Error(
        `Cannot initialize ${MANIFEST_FILE} with --no-organize while agents sit outside agents/ (${outsideAgentsDir.join(", ")}); omit --no-organize to move them into agents/.`,
      )
    }
  }

  const realRoot = fs.realpathSync(root)
  const packRelPrefix = effectiveLayout === "subpack" ? `packs/${name}` : ""
  const toRepoRel = (packRel: string) => (packRelPrefix ? `${packRelPrefix}/${packRel}` : packRel)

  if (packRelPrefix) {
    ensureSafeDirWithin(realRoot, `${packRelPrefix}/${MANIFEST_FILE}`)
  }
  const packDir = packRelPrefix ? path.join(realRoot, "packs", name) : realRoot
  const manifestPath = path.join(packDir, MANIFEST_FILE)
  if (fs.existsSync(manifestPath)) {
    throw new Error(`${MANIFEST_FILE} already exists in ${packDir}`)
  }

  const extras = scanVirtualExtras(realRoot, { preferDotOpencode: effectiveLayout === "subpack" })

  // Pre-flight collision check across all target agent, command, skill, and config files (case-fold aware)
  const foldedTargets = new Map<string, string>()
  const checkCollision = (packRel: string, sourceRel: string) => {
    const repoDestRel = toRepoRel(packRel)
    const key = foldKey(repoDestRel)
    const prev = foldedTargets.get(key)
    if (prev && prev !== sourceRel) {
      throw new Error(`Cannot organize pack: "${prev}" and "${sourceRel}" both map to "${repoDestRel}"`)
    }
    foldedTargets.set(key, sourceRel)
    if (organize && foldKey(sourceRel) !== key) {
      const destFull = path.join(realRoot, ...repoDestRel.split("/"))
      if (fs.lstatSync(destFull, { throwIfNoEntry: false }) || hasCaseFoldCollisionOnDisk(realRoot, repoDestRel, sourceRel)) {
        throw new Error(`Refusing to overwrite existing file "${repoDestRel}"`)
      }
    }
  }

  for (const item of inspection.agents) checkCollision(`agents/${item.id}.md`, item.sourceRel)
  if (extras.agentsMdSourceRel === ".opencode/AGENTS.md") {
    checkCollision("AGENTS.md", extras.agentsMdSourceRel)
  }
  for (const cmd of extras.commands) checkCollision(cmd.canonicalRel, cmd.sourceRel)
  for (const skill of extras.skills) {
    for (const sf of skill.files) checkCollision(sf.canonicalRel, sf.sourceRel)
  }
  if (extras.configSourceRel && inspection.configPackKeys.length > 0) {
    checkCollision("opencode.json", extras.configSourceRel)
  }

  const movedAgents: Array<{ from: string; to: string }> = []
  const movedResources: Array<{ from: string; to: string }> = []
  const strippedConfigKeys: string[] = []
  const dirsToPrune = new Set<string>(["agent", "mode", "modes", "command", "skill"])

  const recordDirChain = (sourceRel: string) => {
    const parts = sourceRel.split("/").slice(0, -1)
    for (let i = parts.length; i >= 1; i--) {
      dirsToPrune.add(parts.slice(0, i).join("/"))
    }
  }

  if (organize) {
    for (const item of inspection.agents) {
      const destRepoRel = toRepoRel(`agents/${item.id}.md`)
      const srcFull = path.join(realRoot, ...item.sourceRel.split("/"))
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

      const destFull = ensureSafeDirWithin(realRoot, destRepoRel)
      if (item.sourceRel !== destRepoRel) {
        atomicWriteRestrictedFile(destFull, nextBytes, 0o644)
        if (path.resolve(srcFull) !== path.resolve(destFull)) {
          fs.unlinkSync(srcFull)
          recordDirChain(item.sourceRel)
        }
        movedAgents.push({ from: item.sourceRel, to: destRepoRel })
      } else if (needsV2) {
        atomicWriteRestrictedFile(destFull, nextBytes, 0o644)
      }
    }

    for (const cmd of extras.commands) {
      const destRepoRel = toRepoRel(cmd.canonicalRel)
      if (cmd.sourceRel === destRepoRel) continue
      const srcFull = path.join(realRoot, ...cmd.sourceRel.split("/"))
      const destFull = ensureSafeDirWithin(realRoot, destRepoRel)
      atomicWriteRestrictedFile(destFull, fs.readFileSync(srcFull), 0o644)
      if (path.resolve(srcFull) !== path.resolve(destFull)) {
        fs.unlinkSync(srcFull)
        recordDirChain(cmd.sourceRel)
      }
      movedResources.push({ from: cmd.sourceRel, to: destRepoRel })
    }

    for (const skill of extras.skills) {
      for (const sf of skill.files) {
        const destRepoRel = toRepoRel(sf.canonicalRel)
        if (sf.sourceRel === destRepoRel) continue
        const srcFull = path.join(realRoot, ...sf.sourceRel.split("/"))
        const mode = (fs.statSync(srcFull).mode & 0o111) !== 0 ? 0o755 : 0o644
        const destFull = ensureSafeDirWithin(realRoot, destRepoRel)
        atomicWriteRestrictedFile(destFull, fs.readFileSync(srcFull), mode)
        if (path.resolve(srcFull) !== path.resolve(destFull)) {
          fs.unlinkSync(srcFull)
          recordDirChain(sf.sourceRel)
        }
        movedResources.push({ from: sf.sourceRel, to: destRepoRel })
      }
    }

    if (extras.agentsMdSourceRel === ".opencode/AGENTS.md") {
      const destRepoRel = toRepoRel("AGENTS.md")
      const srcFull = path.join(realRoot, ".opencode", "AGENTS.md")
      const safeDest = ensureSafeDirWithin(realRoot, destRepoRel)
      atomicWriteRestrictedFile(safeDest, fs.readFileSync(srcFull), 0o644)
      fs.unlinkSync(srcFull)
      recordDirChain(extras.agentsMdSourceRel)
      movedResources.push({ from: extras.agentsMdSourceRel, to: destRepoRel })
    }

    if (extras.configSourceRel) {
      const srcFull = path.join(realRoot, ...extras.configSourceRel.split("/"))
      let parsedConfig: unknown = null
      try {
        parsedConfig = parseJsonc(fs.readFileSync(srcFull, "utf8"))
      } catch {
        parsedConfig = null
      }
      if (isPlain(parsedConfig)) {
        const packConfig: Record<string, unknown> = {}
        const userConfig: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(parsedConfig)) {
          if (CONFIG_KEYS.has(key)) packConfig[key] = value
          else {
            strippedConfigKeys.push(key)
            userConfig[key] = value
          }
        }
        const meaningfulPackKeys = Object.keys(packConfig).filter(k => k !== "$schema")
        const isRootAppConfig = effectiveLayout === "subpack" && !extras.configSourceRel.startsWith(".opencode/")

        if (!isRootAppConfig && strippedConfigKeys.length > 0) {
          const backupRel = saveUserConfigBackup(realRoot, userConfig)
          if (meaningfulPackKeys.length === 0) {
            fs.unlinkSync(srcFull)
            recordDirChain(extras.configSourceRel)
            movedResources.push({ from: extras.configSourceRel, to: backupRel })
          }
        }

        if (meaningfulPackKeys.length > 0) {
          const rewrittenPackConfig = rewriteMovedConfigPaths(packConfig)
          const outConfig = {
            $schema: "https://opencode.ai/config.json",
            ...rewrittenPackConfig,
          }
          const destRepoRel = toRepoRel("opencode.json")
          const safeDest = ensureSafeDirWithin(realRoot, destRepoRel)
          atomicWriteRestrictedFile(safeDest, Buffer.from(`${JSON.stringify(outConfig, null, 2)}\n`, "utf8"), 0o644)
          if (!isRootAppConfig && path.resolve(srcFull) !== path.resolve(safeDest)) {
            fs.unlinkSync(srcFull)
            recordDirChain(extras.configSourceRel)
            movedResources.push({ from: extras.configSourceRel, to: destRepoRel })
          }
        }
      }
    }

    // Namespace non-native files at pack root when organizing a root pack (e.g. `resources/guide.md` -> `resources/<name>/guide.md`)
    if (effectiveLayout === "root") {
      namespaceNonNativeDirs(realRoot, name, movedResources, dirsToPrune)
    }

    pruneEmptyDirs(realRoot, [...dirsToPrune])
  }

  const manifest: PackManifest = {
    contract: currentContract(),
    name,
    version,
    description,
    requires: {},
    ...(inferArchetype && inspection.inferredArchetype ? { archetype: inspection.inferredArchetype } : {}),
  }
  const manifestJson: Record<string, unknown> = {
    $schema: "https://github.com/lorecanc/manage-agents/contract/opencode-pack.schema.json",
    contract: manifest.contract,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    ...(manifest.archetype ? { archetype: manifest.archetype } : {}),
  }
  const safeManifestFull = ensureSafeDirWithin(realRoot, toRepoRel(MANIFEST_FILE))
  atomicWriteRestrictedFile(safeManifestFull, Buffer.from(`${JSON.stringify(manifestJson, null, 2)}\n`, "utf8"), 0o644)

  const kitFiles = options.authoringKit ? installPackAuthoringKit(realRoot, packDir, manifest) : []

  const validation = validatePack(packDir)
  const warnings = validation.issues.map(issue => `[${issue.level}]${issue.path ? ` ${issue.path}:` : ""} ${issue.message}`)
  if (hasErrors(validation) && !organize) {
    warnings.unshift("Note: run with --organize (or move files under agents/) so the pack passes strict contract validation.")
  }

  return {
    manifestPath: safeManifestFull,
    packDir,
    layout: effectiveLayout,
    manifest,
    movedAgents,
    movedResources,
    strippedConfigKeys,
    kitFiles,
    warnings,
    validation,
  }
}

function namespaceNonNativeDirs(
  packRoot: string,
  packName: string,
  movedResources: Array<{ from: string; to: string }>,
  dirsToPrune: Set<string>,
) {
  for (const entry of fs.readdirSync(packRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    const top = entry.name
    if (
      top.startsWith(".git") ||
      top === ".DS_Store" ||
      top === "node_modules" ||
      top === ".opencode" ||
      APP_PROJECT_MARKERS.has(top.toLowerCase()) ||
      RESERVED_DIRS.has(top) ||
      LEGACY_DIRS.has(top) ||
      (NATIVE_DIRS.has(top) && top !== "tools")
    ) {
      continue
    }
    const topFull = path.join(packRoot, top)
    const unnamespaced: string[] = []
    const walkDir = (dir: string) => {
      for (const sub of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (sub.isSymbolicLink() || sub.name === ".DS_Store" || sub.name.startsWith(".git") || sub.name === "node_modules") continue
        const full = path.join(dir, sub.name)
        if (sub.isDirectory()) {
          if (dir === topFull && sub.name === packName) continue
          walkDir(full)
        } else if (sub.isFile()) {
          if (top === "tools" && dir === topFull && sub.name.startsWith(`_${packName}_`)) continue
          unnamespaced.push(path.relative(packRoot, full).split(path.sep).join("/"))
        }
      }
    }
    walkDir(topFull)
    for (const rel of unnamespaced) {
      const rest = rel.slice(top.length + 1)
      const destRel = `${top}/${packName}/${rest}`
      const destFull = path.join(packRoot, ...destRel.split("/"))
      if (fs.lstatSync(destFull, { throwIfNoEntry: false })) continue
      const srcFull = path.join(packRoot, ...rel.split("/"))
      const mode = (fs.statSync(srcFull).mode & 0o111) !== 0 ? 0o755 : 0o644
      const safeDest = ensureSafeDirWithin(packRoot, destRel)
      atomicWriteRestrictedFile(safeDest, fs.readFileSync(srcFull), mode)
      fs.unlinkSync(srcFull)
      const parts = rel.split("/").slice(0, -1)
      for (let i = parts.length; i >= 2; i--) dirsToPrune.add(parts.slice(0, i).join("/"))
      movedResources.push({ from: rel, to: destRel })
    }
  }
}

/** Scaffolds `opencode-pack.json` in a local folder of Markdown agents (backward-compatible entry point). */
export function initPackManifest(packRoot: string, options: InitPackOptions = {}): InitPackResult {
  return applyPackOnboarding(packRoot, {
    ...options,
    layout: options.layout ?? "root",
  })
}

export interface DoctorFinding {
  id: string
  level: "error" | "warning" | "suggestion"
  code: string
  path?: string
  message: string
  autoFixable: boolean
}

export interface PackDoctorReport {
  packDir: string
  repoRoot: string
  manifest: PackManifest | null
  validation: PackValidation
  findings: DoctorFinding[]
  autoFixableCount: number
  hasAuthoringSkill: boolean
  hasCiWorkflow: boolean
}

/** Resolves the pack directory to inspect inside `workspaceRoot` (supporting both single-pack repos and `packs/<name>`). */
export function resolveEditablePackDir(workspaceRoot: string, preferredPackName?: string): string | null {
  const root = path.resolve(workspaceRoot)
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return null
  const realRoot = fs.realpathSync(root)
  if (fs.lstatSync(path.join(realRoot, MANIFEST_FILE), { throwIfNoEntry: false })?.isFile()) return realRoot
  for (const dir of discoverPackDirs(realRoot)) {
    if (!fs.lstatSync(path.join(dir, MANIFEST_FILE)).isFile()) continue
    if (!preferredPackName || manifestName(dir) === preferredPackName) return dir
  }
  return null
}

const AUTO_FIXABLE_ISSUE_CODES = new Set([
  "agent-deprecated-key",
  "legacy-directory",
  "namespace",
  "config-key",
  "skill-description",
])

/** Runs contract validation plus authoring ergonomics checks on an initialized pack. */
export function inspectPackDoctor(packDir: string, repoRoot?: string): PackDoctorReport {
  const resolvedPack = path.resolve(packDir)
  const resolvedRepo = path.resolve(repoRoot ?? resolvedPack)
  const validation = validatePack(resolvedPack)
  const findings: DoctorFinding[] = validation.issues.map((issue: PackIssue, idx: number) => ({
    id: `${issue.code}:${issue.path ?? idx}`,
    level: issue.level,
    code: issue.code,
    path: issue.path,
    message: issue.message,
    autoFixable: AUTO_FIXABLE_ISSUE_CODES.has(issue.code),
  }))

  // Also check V1 agent keys not listed in DEPRECATED_AGENT_KEYS (`max_steps`, `prompt`, `options`, etc.)
  for (const agent of validation.agents) {
    const rel = `agents/${agent.id}.md`
    const full = path.join(resolvedPack, ...rel.split("/"))
    if (!fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) continue
    try {
      const { yamlText } = extractFrontmatter(fs.readFileSync(full, "utf8"))
      if (yamlText !== null) {
        const parsed = YAML.parse(yamlText)
        if (
          isPlain(parsed) &&
          detectFrontmatterVersion(parsed) === "v1" &&
          !findings.some(f => f.code === "agent-deprecated-key" && f.path === rel)
        ) {
          findings.push({
            id: `agent-v1-frontmatter:${rel}`,
            level: "warning",
            code: "agent-v1-frontmatter",
            path: rel,
            message: "agent uses legacy V1 frontmatter fields; upgrade to OpenCode V2",
            autoFixable: true,
          })
        }
      }
    } catch {
      /* syntax error already reported by validatePack */
    }
  }

  if (validation.manifest) {
    if (validation.manifest.contract === "1.0") {
      findings.push({
        id: "contract-upgrade:opencode-pack.json",
        level: "suggestion",
        code: "contract-upgrade",
        path: MANIFEST_FILE,
        message: `manifest targets contract 1.0; upgrade to ${currentContract()} for conditional flowDefaults support`,
        autoFixable: true,
      })
    }
    if (!validation.manifest.archetype) {
      const inferred = inferArchetypeFromAgents(validation.agents)
      if (inferred) {
        findings.push({
          id: "archetype-missing:opencode-pack.json",
          level: "suggestion",
          code: "archetype-missing",
          path: MANIFEST_FILE,
          message: `pack has primary (${inferred.callers.join(", ")}) and subagent roles without "archetype" in ${MANIFEST_FILE}`,
          autoFixable: true,
        })
      }
    }
  }

  const hasAuthoringSkill = Boolean(
    fs.lstatSync(path.join(resolvedRepo, ...AUTHORING_SKILL_REL.split("/")), { throwIfNoEntry: false })?.isFile(),
  )
  const hasCiWorkflow = Boolean(
    fs.lstatSync(path.join(resolvedRepo, ...CI_WORKFLOW_REL.split("/")), { throwIfNoEntry: false })?.isFile(),
  )

  return {
    packDir: resolvedPack,
    repoRoot: resolvedRepo,
    manifest: validation.manifest,
    validation,
    findings,
    autoFixableCount: findings.filter(f => f.autoFixable).length,
    hasAuthoringSkill,
    hasCiWorkflow,
  }
}

export interface PackDoctorFixResult {
  appliedFixes: string[]
  kitFiles: string[]
  report: PackDoctorReport
}

/** Automatically repairs fixable contract/authoring issues in `packDir` and optionally installs the authoring kit. */
export function fixPackDoctor(
  packDir: string,
  options: { repoRoot?: string; authoringKit?: boolean } = {},
): PackDoctorFixResult {
  const realPack = fs.realpathSync(path.resolve(packDir))
  const realRepo = fs.realpathSync(path.resolve(options.repoRoot ?? realPack))
  const appliedFixes: string[] = []
  const dirsToPrune = new Set<string>()

  const initial = inspectPackDoctor(realPack, realRepo)
  const packName = initial.manifest?.name

  // 1. Move files out of legacy singular directories (`agent/`, `mode/`, `modes/`, `command/`, `skill/`)
  for (const [legacyDir, nativeDir] of LEGACY_DIRS.entries()) {
    if (nativeDir !== "agents" && nativeDir !== "commands" && nativeDir !== "skills") continue
    const legacyFull = path.join(realPack, legacyDir)
    if (!fs.lstatSync(legacyFull, { throwIfNoEntry: false })?.isDirectory()) continue
    const walkLegacy = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink() || entry.name === ".DS_Store") continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walkLegacy(full)
        else if (entry.isFile()) {
          const subRel = path.relative(legacyFull, full).split(path.sep).join("/")
          const destRel = `${nativeDir}/${subRel}`
          if (fs.lstatSync(path.join(realPack, ...destRel.split("/")), { throwIfNoEntry: false })) continue
          const mode = (fs.statSync(full).mode & 0o111) !== 0 ? 0o755 : 0o644
          let bytes = fs.readFileSync(full)
          if ((legacyDir === "mode" || legacyDir === "modes") && entry.name.endsWith(".md")) {
            const raw = bytes.toString("utf8")
            const { yamlText, body } = extractFrontmatter(raw)
            const parsed = yamlText ? YAML.parse(yamlText) : {}
            const fm = isPlain(parsed) ? parsed : {}
            if (!fm.mode) fm.mode = "primary"
            bytes = Buffer.from(renderAgentFile(fm, body, "v2"), "utf8")
          }
          const safeDest = ensureSafeDirWithin(realPack, destRel)
          atomicWriteRestrictedFile(safeDest, bytes, mode)
          fs.unlinkSync(full)
          const relFromPack = `${legacyDir}/${subRel}`
          const parts = relFromPack.split("/").slice(0, -1)
          for (let i = parts.length; i >= 1; i--) dirsToPrune.add(parts.slice(0, i).join("/"))
          appliedFixes.push(`moved ${relFromPack} -> ${destRel}`)
        }
      }
    }
    walkLegacy(legacyFull)
  }

  // 2. Upgrade V1 frontmatter in `agents/**/*.md`
  const agentsDir = path.join(realPack, "agents")
  if (fs.lstatSync(agentsDir, { throwIfNoEntry: false })?.isDirectory()) {
    const walkAgents = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink() || entry.name === ".DS_Store") continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walkAgents(full)
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          const raw = fs.readFileSync(full, "utf8")
          const { yamlText, body } = extractFrontmatter(raw)
          if (yamlText === null) continue
          let parsed: unknown
          try {
            parsed = YAML.parse(yamlText)
          } catch {
            continue
          }
          if (!isPlain(parsed)) continue
          const hasDeprecated =
            detectFrontmatterVersion(parsed) === "v1" ||
            "tools" in parsed ||
            "permission" in parsed ||
            "name" in parsed
          if (!hasDeprecated) continue
          const fmCopy = { ...parsed }
          delete fmCopy.name
          const next = renderAgentFile(fmCopy, body, "v2")
          const rel = path.relative(realPack, full).split(path.sep).join("/")
          const safeDest = ensureSafeDirWithin(realPack, rel)
          atomicWriteRestrictedFile(safeDest, Buffer.from(next, "utf8"), 0o644)
          appliedFixes.push(`upgraded V1 frontmatter -> V2 in ${rel}`)
        }
      }
    }
    walkAgents(agentsDir)
  }

  // 3. Add missing `description` to `skills/**/SKILL.md`
  const skillsDir = path.join(realPack, "skills")
  if (fs.lstatSync(skillsDir, { throwIfNoEntry: false })?.isDirectory()) {
    const walkSkills = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink() || entry.name === ".DS_Store") continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walkSkills(full)
        else if (entry.isFile() && entry.name === "SKILL.md") {
          const rel = path.relative(realPack, full).split(path.sep).join("/")
          const skillId = rel.slice("skills/".length, -"/SKILL.md".length)
          const raw = fs.readFileSync(full, "utf8")
          const { yamlText, body } = extractFrontmatter(raw)
          let fm: Record<string, any> = {}
          if (yamlText !== null) {
            try {
              const parsed = YAML.parse(yamlText)
              if (!isPlain(parsed)) continue
              fm = { ...parsed }
            } catch {
              continue
            }
          }
          if (typeof fm.description === "string" && fm.description.trim()) continue
          if (!fm.name) fm.name = path.posix.basename(skillId)
          fm.description = `Instructions and workflow for ${skillId}`
          const rendered = `---\n${YAML.stringify(fm).trimEnd()}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`
          const safeDest = ensureSafeDirWithin(realPack, rel)
          atomicWriteRestrictedFile(safeDest, Buffer.from(rendered, "utf8"), 0o644)
          appliedFixes.push(`added starter description in ${rel}`)
        }
      }
    }
    walkSkills(skillsDir)
  }

  // 4. Namespace un-namespaced files in non-native directories
  if (packName) {
    const movedNamespace: Array<{ from: string; to: string }> = []
    namespaceNonNativeDirs(realPack, packName, movedNamespace, dirsToPrune)
    for (const m of movedNamespace) appliedFixes.push(`namespaced ${m.from} -> ${m.to}`)
  }

  // 5. Strip disallowed user keys from `opencode.json(c)`
  for (const cfgName of ["opencode.json", "opencode.jsonc"]) {
    const cfgFull = path.join(realPack, cfgName)
    if (!fs.lstatSync(cfgFull, { throwIfNoEntry: false })?.isFile()) continue
    let parsed: unknown
    try {
      parsed = parseJsonc(fs.readFileSync(cfgFull, "utf8"))
    } catch {
      continue
    }
    if (!isPlain(parsed)) continue
    const disallowed = Object.keys(parsed).filter(k => !CONFIG_KEYS.has(k))
    if (disallowed.length === 0) continue
    const kept: Record<string, unknown> = {}
    const removed: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (CONFIG_KEYS.has(k)) kept[k] = v
      else removed[k] = v
    }
    saveUserConfigBackup(realRepo, removed)
    const meaningfulKept = Object.keys(kept).filter(k => k !== "$schema")
    if (meaningfulKept.length > 0) {
      const safeCfg = ensureSafeDirWithin(realPack, "opencode.json")
      atomicWriteRestrictedFile(safeCfg, Buffer.from(`${JSON.stringify({ $schema: "https://opencode.ai/config.json", ...kept }, null, 2)}\n`, "utf8"), 0o644)
      if (cfgName === "opencode.jsonc") fs.unlinkSync(cfgFull)
    } else {
      fs.unlinkSync(cfgFull)
    }
    appliedFixes.push(`stripped user-only keys (${disallowed.join(", ")}) from ${cfgName}`)
  }

  pruneEmptyDirs(realPack, [...dirsToPrune])

  // 6. Upgrade `contract` to 1.1 and infer missing `archetype` in `opencode-pack.json`
  const manifestFull = path.join(realPack, MANIFEST_FILE)
  if (fs.lstatSync(manifestFull, { throwIfNoEntry: false })?.isFile()) {
    try {
      const rawManifest = JSON.parse(fs.readFileSync(manifestFull, "utf8"))
      if (isPlain(rawManifest)) {
        let changed = false
        if (rawManifest.contract === "1.0") {
          rawManifest.contract = currentContract()
          changed = true
          appliedFixes.push(`upgraded ${MANIFEST_FILE} contract 1.0 -> ${currentContract()}`)
        }
        if (rawManifest.archetype === undefined) {
          const postValidation = validatePack(realPack)
          const inferred = inferArchetypeFromAgents(postValidation.agents)
          if (inferred) {
            rawManifest.archetype = inferred
            changed = true
            appliedFixes.push(`inferred archetype (${inferred.callers.join(", ")}) in ${MANIFEST_FILE}`)
          }
        }
        if (changed) {
          const safeManifest = ensureSafeDirWithin(realPack, MANIFEST_FILE)
          atomicWriteRestrictedFile(safeManifest, Buffer.from(`${JSON.stringify(rawManifest, null, 2)}\n`, "utf8"), 0o644)
        }
      }
    } catch {
      /* invalid JSON reported in report */
    }
  }

  let kitFiles: string[] = []
  const refreshedPreKit = validatePack(realPack)
  if (options.authoringKit && refreshedPreKit.manifest) {
    kitFiles = installPackAuthoringKit(realRepo, realPack, refreshedPreKit.manifest)
  }

  const report = inspectPackDoctor(realPack, realRepo)
  return { appliedFixes, kitFiles, report }
}

/** Increments `version` in `opencode-pack.json` using semver (`patch`, `minor`, or `major`). */
export function bumpPackVersion(
  packDir: string,
  release: SemverReleaseKind,
): { previousVersion: string; nextVersion: string; manifestPath: string } {
  const realPack = fs.realpathSync(path.resolve(packDir))
  const manifestPath = path.join(realPack, MANIFEST_FILE)
  if (!fs.lstatSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${MANIFEST_FILE} not found in ${realPack}`)
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  if (!isPlain(raw) || typeof raw.version !== "string" || semver.valid(raw.version) !== raw.version) {
    throw new Error(`Invalid current semver version in ${manifestPath}`)
  }
  const previousVersion = raw.version
  const nextVersion = semver.inc(previousVersion, release)
  if (!nextVersion) throw new Error(`Could not increment version "${previousVersion}" (${release})`)
  raw.version = nextVersion
  const safeManifest = ensureSafeDirWithin(realPack, MANIFEST_FILE)
  atomicWriteRestrictedFile(safeManifest, Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, "utf8"), 0o644)
  return { previousVersion, nextVersion, manifestPath: safeManifest }
}

export interface ScaffoldResourceSpec {
  kind: ScaffoldResourceKind
  id: string
  description?: string
  mode?: "primary" | "subagent" | "all"
}

export interface ScaffoldResourceResult {
  kind: ScaffoldResourceKind
  id: string
  relativePath: string
  fullPath: string
  validation: PackValidation
}

/** Scaffolds a contract-compliant OpenCode V2 agent, skill, or slash command inside `packDir`. */
export function scaffoldPackResource(packDir: string, spec: ScaffoldResourceSpec): ScaffoldResourceResult {
  const realPack = fs.realpathSync(path.resolve(packDir))
  if (!fs.lstatSync(path.join(realPack, MANIFEST_FILE), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${realPack} does not contain ${MANIFEST_FILE}; onboard the pack first`)
  }
  const cleanId = spec.id.trim().replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "")
  if (!cleanId || !RESOURCE_ID_RE.test(cleanId) || cleanId.includes("..")) {
    throw new Error(`Invalid ${spec.kind} ID "${spec.id}": use letters, digits, hyphens and optional "/" namespaces`)
  }
  const desc = spec.description?.trim() || `${spec.kind[0].toUpperCase()}${spec.kind.slice(1)} ${cleanId}`

  let relativePath: string
  let content: string
  if (spec.kind === "agent") {
    const mode = spec.mode ?? "subagent"
    if (mode !== "primary" && mode !== "subagent" && mode !== "all") {
      throw new Error(`Invalid agent mode "${String(mode)}"`)
    }
    relativePath = `agents/${cleanId}.md`
    content = renderAgentFile(
      { description: desc, mode },
      `\nYou are **${cleanId}**. Describe your responsibilities, constraints, and output format here.\n`,
      "v2",
    )
  } else if (spec.kind === "skill") {
    relativePath = `skills/${cleanId}/SKILL.md`
    const leafName = path.posix.basename(cleanId)
    content = `---\n${YAML.stringify({ name: leafName, description: desc }).trimEnd()}\n---\n\n# ${leafName}\n\nDescribe when to load this skill and the step-by-step workflow to follow.\n`
  } else {
    relativePath = `commands/${cleanId}.md`
    content = `---\n${YAML.stringify({ description: desc }).trimEnd()}\n---\n\nExecute the **${cleanId}** workflow for:\n\n$ARGUMENTS\n`
  }

  const destCandidate = path.join(realPack, ...relativePath.split("/"))
  if (fs.lstatSync(destCandidate, { throwIfNoEntry: false }) || hasCaseFoldCollisionOnDisk(realPack, relativePath)) {
    throw new Error(`Refusing to overwrite existing resource "${relativePath}"`)
  }
  const fullPath = ensureSafeDirWithin(realPack, relativePath)
  atomicWriteRestrictedFile(fullPath, Buffer.from(content, "utf8"), 0o644)
  const validation = validatePack(realPack)
  return { kind: spec.kind, id: cleanId, relativePath, fullPath, validation }
}
