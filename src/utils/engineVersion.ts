import { createHash, randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { movePathWithRetry } from "./fsWindows.js"
import { cleanGitEnvironment } from "./repositoryTransaction.js"

export const ENGINE_MANIFEST_RELATIVE_PATH = ".manage-agents/release-manifest.json"
export const DEFAULT_ENGINE_REPOSITORY = "lorecanc/manage-agents"

export type EngineVersionChannel = "release" | "ci-snapshot" | "git-tag" | "git" | "package"

export interface EngineReleaseManifest {
  schemaVersion: 1
  version: string
  packageVersion: string
  tag: string | null
  commit: string
  shortCommit: string
  dirty: boolean
  channel: "release" | "ci-snapshot"
  bundleHash: string
  builtAt: string
  appliedOverGitHead?: string
  appliedWorktreeStateHash?: string
}

export interface EngineVersionInfo {
  engineRoot: string
  version: string
  displayVersion: string
  packageVersion: string
  tag: string | null
  commit: string | null
  shortCommit: string | null
  dirty: boolean
  channel: EngineVersionChannel
  bundleHash: string
  manifestPresent: boolean
  manifestValid: boolean
}

export interface EngineManifestInput {
  refType: "tag" | "branch" | string
  refName: string
  sha: string
  builtAt?: string
}

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".manage-agents",
  ".agent-manager",
  ".opencode",
  "artifacts",
  "backups",
  "coverage",
  ".cache",
])

function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !hasControlChars(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

function isTag(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^v?[0-9A-Za-z._-]+$/.test(value) && !hasControlChars(value)
}

function isBundleHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * Resolves the installation directory of the running `manage-agents` package (following outer `npm link` symlinks
 * to the real package root). Completely independent of the user's pack catalog workspace.
 */
export function resolveEngineRoot(overrideRoot?: string): string {
  if (overrideRoot) {
    const resolved = path.resolve(overrideRoot)
    try {
      return fs.realpathSync(resolved)
    } catch {
      return resolved
    }
  }
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    if (fs.existsSync(path.join(dir, "manage-agents.mjs")) && fs.existsSync(path.join(dir, "package.json"))) {
      try {
        return fs.realpathSync(dir)
      } catch {
        return path.resolve(dir)
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error("Unable to locate the manage-agents engine installation directory.")
}

export function assertSafeEnginePath(engineRoot: string, target: string): void {
  const resolvedRoot = path.resolve(engineRoot)
  const resolvedTarget = path.resolve(target)
  if (!isWithinRoot(resolvedRoot, resolvedTarget)) throw new Error("Refusing a path outside the engine directory.")
  const rootStat = fs.lstatSync(resolvedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Refusing a symlink or non-directory engine root.")
  }
  let current = resolvedRoot
  const components = path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean)
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]!)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error: any) {
      if (error?.code === "ENOENT") return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing a symlink path inside engine directory: ${components[index]}`)
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw new Error(`Refusing a non-directory path component: ${components[index]}`)
    }
  }
}

export function packageVersionForEngine(engineRoot: string): string {
  try {
    const pkgPath = path.join(engineRoot, "package.json")
    const stat = fs.lstatSync(pkgPath)
    if (stat.isFile() && !stat.isSymbolicLink()) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>
      if (typeof parsed.version === "string" && parsed.version.trim() && !hasControlChars(parsed.version)) {
        return parsed.version.trim()
      }
    }
  } catch {
    // Fall back when package.json cannot be parsed.
  }
  return "0.0.0"
}

export function defaultEngineRepository(engineRoot?: string): string {
  try {
    const root = resolveEngineRoot(engineRoot)
    const pkgPath = path.join(root, "package.json")
    const stat = fs.lstatSync(pkgPath, { throwIfNoEntry: false })
    if (stat?.isFile() && !stat.isSymbolicLink()) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>
      const repoField = parsed.repository
      const rawUrl =
        typeof repoField === "string"
          ? repoField
          : isObject(repoField) && typeof repoField.url === "string"
            ? repoField.url
            : ""
      const match = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(rawUrl.trim())
      if (match?.[1]) return match[1]
    }
  } catch {
    // Fall back to default repository.
  }
  return DEFAULT_ENGINE_REPOSITORY
}

function addRegularFile(root: string, filePath: string, relativePath: string, files: Map<string, string>): void {
  const resolvedRoot = path.resolve(root)
  const resolvedFile = path.resolve(filePath)
  if (!isWithinRoot(resolvedRoot, resolvedFile)) return
  try {
    assertSafeEnginePath(resolvedRoot, resolvedFile)
    const stat = fs.lstatSync(resolvedFile, { throwIfNoEntry: false })
    if (stat?.isFile() && !stat.isSymbolicLink()) {
      files.set(relativePath.split(path.sep).join("/"), resolvedFile)
    }
  } catch {
    // Skip unreadable or unsafe entries.
  }
}

function addDirectoryFiles(
  root: string,
  directory: string,
  relativeDirectory: string,
  files: Map<string, string>,
  exclude?: (relativePosix: string) => boolean,
): void {
  let directoryStat: fs.Stats | undefined
  try {
    assertSafeEnginePath(root, directory)
    directoryStat = fs.lstatSync(directory, { throwIfNoEntry: false })
  } catch {
    return
  }
  if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = path.join(directory, entry.name)
    const rel = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    let stat: fs.Stats | undefined
    try {
      stat = fs.lstatSync(abs, { throwIfNoEntry: false })
    } catch {
      continue
    }
    if (!stat || stat.isSymbolicLink()) continue
    if (stat.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
      addDirectoryFiles(root, abs, rel, files, exclude)
    } else if (
      stat.isFile() &&
      !entry.name.endsWith(".log") &&
      entry.name !== ".DS_Store" &&
      entry.name !== "Thumbs.db" &&
      !exclude?.(rel)
    ) {
      files.set(rel, abs)
    }
  }
}

/**
 * Computes a deterministic SHA-256 bundle hash over the engine's runtime and contract surface.
 */
export function computeEngineBundleHash(overrideRoot?: string): string {
  const root = resolveEngineRoot(overrideRoot)
  const files = new Map<string, string>()

  addRegularFile(root, path.join(root, "package.json"), "package.json", files)
  addRegularFile(root, path.join(root, "package-lock.json"), "package-lock.json", files)
  addRegularFile(root, path.join(root, "bun.lock"), "bun.lock", files)
  addRegularFile(root, path.join(root, "manage-agents.mjs"), "manage-agents.mjs", files)
  addRegularFile(root, path.join(root, "README.md"), "README.md", files)
  addRegularFile(root, path.join(root, "GUIDA.md"), "GUIDA.md", files)
  addRegularFile(root, path.join(root, "LICENSE"), "LICENSE", files)
  addRegularFile(root, path.join(root, ".gitignore"), ".gitignore", files)
  addRegularFile(root, path.join(root, "dist", "index.js"), "dist/index.js", files)
  addDirectoryFiles(root, path.join(root, "assets"), "assets", files)
  addDirectoryFiles(root, path.join(root, "contract"), "contract", files)
  addDirectoryFiles(root, path.join(root, "runtime"), "runtime", files, rel => /\.test\.[cm]?[jt]s$/.test(rel))
  if (fs.existsSync(path.join(root, "src"))) {
    addDirectoryFiles(root, path.join(root, "src"), "src", files, rel => /\.test\.[cm]?[jt]sx?$/.test(rel))
  }

  const hash = createHash("sha256")
  for (const [relPath, absPath] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const relBytes = Buffer.from(relPath, "utf8")
    const content = fs.readFileSync(absPath)
    hash.update(Buffer.from(`${relBytes.length}:`))
    hash.update(relBytes)
    hash.update(Buffer.from(`:${content.length}:`))
    hash.update(content)
  }
  return `sha256:${hash.digest("hex")}`
}

export function isEngineReleaseManifest(value: unknown): value is EngineReleaseManifest {
  if (!isObject(value)) return false
  if (
    value.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    !value.version ||
    hasControlChars(value.version) ||
    typeof value.packageVersion !== "string" ||
    !value.packageVersion ||
    hasControlChars(value.packageVersion) ||
    (value.tag !== null && (typeof value.tag !== "string" || hasControlChars(value.tag))) ||
    typeof value.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.commit) ||
    value.shortCommit !== value.commit.slice(0, 7) ||
    !isBundleHash(value.bundleHash) ||
    !isIsoTimestamp(value.builtAt) ||
    (value.appliedOverGitHead !== undefined &&
      (typeof value.appliedOverGitHead !== "string" || !/^[0-9a-f]{40}$/.test(value.appliedOverGitHead))) ||
    (value.appliedWorktreeStateHash !== undefined && !isBundleHash(value.appliedWorktreeStateHash))
  ) {
    return false
  }
  if (value.channel === "release") {
    return isTag(value.tag) && value.dirty === false && value.version === value.tag
  }
  if (value.channel === "ci-snapshot") {
    return value.tag === null && value.dirty === true && value.version === `sha-${value.shortCommit}-dirty`
  }
  return false
}

function manifestPathFor(engineRoot: string): string {
  return path.join(engineRoot, ...ENGINE_MANIFEST_RELATIVE_PATH.split("/"))
}

function atomicWriteInsideEngine(engineRoot: string, target: string, content: string, mode: number): void {
  const parent = path.dirname(target)
  assertSafeEnginePath(engineRoot, parent)
  fs.mkdirSync(parent, { recursive: true })
  assertSafeEnginePath(engineRoot, target)
  const existing = fs.lstatSync(target, { throwIfNoEntry: false })
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error("Refusing to overwrite a symlink or non-file manifest target.")
  }
  const temp = path.join(parent, `${path.basename(target)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`)
  let fd: number | undefined
  try {
    fd = fs.openSync(temp, "wx", mode)
    fs.writeFileSync(fd, content, "utf8")
    fs.fchmodSync(fd, mode)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    assertSafeEnginePath(engineRoot, target)
    movePathWithRetry(temp, target)
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    try {
      fs.unlinkSync(temp)
    } catch {}
    throw error
  }
}

function gitOutput(engineRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: engineRoot,
      env: cleanGitEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      windowsHide: true,
    })
      .toString("utf8")
      .trim()
  } catch {
    return null
  }
}

function resolveFullCommit(engineRoot: string, sha: string): string {
  if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) throw new Error("Commit SHA must contain 7 to 40 hexadecimal characters.")
  const normalized = sha.toLowerCase()
  if (normalized.length === 40) return normalized
  if (fs.existsSync(path.join(engineRoot, ".git"))) {
    const resolved = gitOutput(engineRoot, ["rev-parse", "--verify", `${normalized}^{commit}`])?.toLowerCase()
    if (resolved && /^[0-9a-f]{40}$/.test(resolved) && resolved.startsWith(normalized)) return resolved
  }
  throw new Error("Commit SHA must resolve to a full 40-character commit SHA.")
}

export function writeEngineReleaseManifest(overrideRoot: string | undefined, input: EngineManifestInput): EngineReleaseManifest {
  const engineRoot = resolveEngineRoot(overrideRoot)
  const commit = resolveFullCommit(engineRoot, input.sha)
  const shortCommit = commit.slice(0, 7)
  const isTagRef = input.refType === "tag"
  if (isTagRef && !isTag(input.refName)) throw new Error("Release tag must be a non-empty safe tag string.")
  const packageVersion = packageVersionForEngine(engineRoot)
  const builtAt = input.builtAt ?? new Date().toISOString()
  if (!isIsoTimestamp(builtAt)) throw new Error("Build timestamp must be an ISO timestamp.")

  const manifest: EngineReleaseManifest = {
    schemaVersion: 1,
    version: isTagRef ? input.refName : `sha-${shortCommit}-dirty`,
    packageVersion,
    tag: isTagRef ? input.refName : null,
    commit,
    shortCommit,
    dirty: !isTagRef,
    channel: isTagRef ? "release" : "ci-snapshot",
    bundleHash: computeEngineBundleHash(engineRoot),
    builtAt,
  }
  atomicWriteInsideEngine(engineRoot, manifestPathFor(engineRoot), `${JSON.stringify(manifest, null, 2)}\n`, 0o644)
  return manifest
}

export function readEngineReleaseManifest(overrideRoot?: string): EngineReleaseManifest | null {
  try {
    const engineRoot = resolveEngineRoot(overrideRoot)
    const target = manifestPathFor(engineRoot)
    assertSafeEnginePath(engineRoot, target)
    const stat = fs.lstatSync(target, { throwIfNoEntry: false })
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown
    return isEngineReleaseManifest(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function computeEngineGitWorktreeHash(overrideRoot?: string): string | null {
  const engineRoot = resolveEngineRoot(overrideRoot)
  if (!fs.existsSync(path.join(engineRoot, ".git"))) return null

  let output: Buffer
  try {
    output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
      cwd: engineRoot,
      env: cleanGitEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      encoding: "buffer",
      windowsHide: true,
    }) as Buffer
  } catch {
    return null
  }

  const entries: Array<{ status: string; path: string }> = []
  const fields = output.toString("utf8").split("\0")
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index]
    if (!record) continue
    const status = record.slice(0, 2)
    const filePath = record.slice(3)
    if (filePath === ".manage-agents" || filePath.startsWith(".manage-agents/")) {
      if (/[RC]/.test(status)) index++
      continue
    }
    entries.push({ status, path: filePath })
    if (status === "??") {
      const dirPath = path.resolve(engineRoot, ...filePath.split("/"))
      try {
        if (isWithinRoot(engineRoot, dirPath) && fs.lstatSync(dirPath).isDirectory()) {
          const walk = (dir: string, relDir: string) => {
            for (const name of fs.readdirSync(dir)) {
              const rel = `${relDir.replace(/\/$/, "")}/${name}`
              entries.push({ status, path: rel })
              const child = path.join(dir, name)
              try {
                const st = fs.lstatSync(child)
                if (st.isDirectory() && !st.isSymbolicLink()) walk(child, rel)
              } catch {}
            }
          }
          walk(dirPath, filePath)
        }
      } catch {}
    }
    if (/[RC]/.test(status)) {
      const peerPath = fields[++index]
      if (peerPath) entries.push({ status, path: peerPath })
    }
  }

  const hash = createHash("sha256")
  for (const entry of entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.status.localeCompare(b.status)))) {
    let contentHash = "missing"
    try {
      const abs = path.resolve(engineRoot, ...entry.path.split("/"))
      if (isWithinRoot(engineRoot, abs)) {
        const st = fs.lstatSync(abs, { throwIfNoEntry: false })
        if (st?.isFile() && !st.isSymbolicLink()) {
          contentHash = createHash("sha256").update(fs.readFileSync(abs)).digest("hex")
        }
      }
    } catch {}
    const pathBytes = Buffer.from(entry.path, "utf8")
    hash.update(Buffer.from(`${entry.status.length}:${entry.status}:${pathBytes.length}:`))
    hash.update(pathBytes)
    hash.update(Buffer.from(`:${contentHash.length}:${contentHash}\n`))
  }
  return `sha256:${hash.digest("hex")}`
}

export function stampAppliedEngineManifest(overrideRoot: string | undefined, manifest: EngineReleaseManifest): EngineReleaseManifest {
  if (!isEngineReleaseManifest(manifest)) throw new Error("Cannot stamp an invalid engine release manifest.")
  const engineRoot = resolveEngineRoot(overrideRoot)
  const target = manifestPathFor(engineRoot)
  let gitHead: string | null = null
  if (fs.existsSync(path.join(engineRoot, ".git"))) {
    const head = gitOutput(engineRoot, ["rev-parse", "--verify", "HEAD"])
    if (head && /^[0-9a-fA-F]{40}$/.test(head)) gitHead = head.toLowerCase()
  }
  if (!gitHead) {
    atomicWriteInsideEngine(engineRoot, target, `${JSON.stringify(manifest, null, 2)}\n`, 0o644)
    return manifest
  }
  const stamped: EngineReleaseManifest = { ...manifest, appliedOverGitHead: gitHead, appliedWorktreeStateHash: undefined }
  atomicWriteInsideEngine(engineRoot, target, `${JSON.stringify(stamped, null, 2)}\n`, 0o644)
  stamped.appliedWorktreeStateHash = computeEngineGitWorktreeHash(engineRoot) ?? undefined
  atomicWriteInsideEngine(engineRoot, target, `${JSON.stringify(stamped, null, 2)}\n`, 0o644)
  return stamped
}

export function resolveEngineVersion(overrideRoot?: string): EngineVersionInfo {
  const engineRoot = resolveEngineRoot(overrideRoot)
  const bundleHash = computeEngineBundleHash(engineRoot)
  const packageVersion = packageVersionForEngine(engineRoot)
  const manifestFile = manifestPathFor(engineRoot)
  const manifestPresent = Boolean(fs.lstatSync(manifestFile, { throwIfNoEntry: false }))
  const manifest = readEngineReleaseManifest(engineRoot)
  const manifestValid = manifest !== null
  const gitPresent = fs.existsSync(path.join(engineRoot, ".git"))

  let gitHead: string | null = null
  let gitDirty = false
  let exactGitTag: string | null = null
  if (gitPresent) {
    const head = gitOutput(engineRoot, ["rev-parse", "--verify", "HEAD"])
    if (head && /^[0-9a-fA-F]{40}$/.test(head)) gitHead = head.toLowerCase()
    const status = gitOutput(engineRoot, ["status", "--porcelain", "--untracked-files=normal"])
    gitDirty = status === null || status.trim().length > 0
    if (!gitDirty) {
      const candidateTag = gitOutput(engineRoot, ["describe", "--tags", "--exact-match", "HEAD"])
      if (candidateTag && isTag(candidateTag)) exactGitTag = candidateTag
    }
  }

  if (manifest && manifest.bundleHash === bundleHash) {
    if (!gitPresent) {
      if (manifest.channel === "release" && manifest.tag && !manifest.dirty) {
        return {
          engineRoot,
          version: manifest.tag,
          displayVersion: `${manifest.tag} (${manifest.shortCommit})`,
          packageVersion,
          tag: manifest.tag,
          commit: manifest.commit,
          shortCommit: manifest.shortCommit,
          dirty: false,
          channel: "release",
          bundleHash,
          manifestPresent,
          manifestValid,
        }
      }
      return {
        engineRoot,
        version: `sha-${manifest.shortCommit}-dirty`,
        displayVersion: `sha-${manifest.shortCommit}-dirty`,
        packageVersion,
        tag: null,
        commit: manifest.commit,
        shortCommit: manifest.shortCommit,
        dirty: true,
        channel: "ci-snapshot",
        bundleHash,
        manifestPresent,
        manifestValid,
      }
    }

    const releaseManifest = manifest.channel === "release" && Boolean(manifest.tag) && !manifest.dirty
    const exactCleanGitCommit = gitHead !== null && gitHead === manifest.commit && !gitDirty
    const appliedOverCurrentGit =
      gitHead !== null &&
      manifest.appliedOverGitHead === gitHead &&
      typeof manifest.appliedWorktreeStateHash === "string" &&
      computeEngineGitWorktreeHash(engineRoot) === manifest.appliedWorktreeStateHash
    if (releaseManifest && manifest.tag && (exactCleanGitCommit || appliedOverCurrentGit)) {
      return {
        engineRoot,
        version: manifest.tag,
        displayVersion: `${manifest.tag} (${manifest.shortCommit})`,
        packageVersion,
        tag: manifest.tag,
        commit: manifest.commit,
        shortCommit: manifest.shortCommit,
        dirty: false,
        channel: "release",
        bundleHash,
        manifestPresent,
        manifestValid,
      }
    }
  }

  if (gitPresent && gitHead) {
    const shortCommit = gitHead.slice(0, 7)
    if (!gitDirty && exactGitTag) {
      return {
        engineRoot,
        version: exactGitTag,
        displayVersion: `${exactGitTag} (${shortCommit})`,
        packageVersion,
        tag: exactGitTag,
        commit: gitHead,
        shortCommit,
        dirty: false,
        channel: "git-tag",
        bundleHash,
        manifestPresent,
        manifestValid,
      }
    }
    const version = gitDirty ? `sha-${shortCommit}-dirty` : `sha-${shortCommit}`
    return {
      engineRoot,
      version,
      displayVersion: version,
      packageVersion,
      tag: null,
      commit: gitHead,
      shortCommit,
      dirty: gitDirty,
      channel: "git",
      bundleHash,
      manifestPresent,
      manifestValid,
    }
  }

  if (!gitPresent && manifest && manifest.bundleHash !== bundleHash) {
    const version = `sha-${manifest.shortCommit}-dirty`
    return {
      engineRoot,
      version,
      displayVersion: version,
      packageVersion,
      tag: null,
      commit: manifest.commit,
      shortCommit: manifest.shortCommit,
      dirty: true,
      channel: manifest.channel,
      bundleHash,
      manifestPresent,
      manifestValid,
    }
  }

  const tagLike = packageVersion.startsWith("v") ? packageVersion : `v${packageVersion}`
  return {
    engineRoot,
    version: tagLike,
    displayVersion: `${tagLike} (package)`,
    packageVersion,
    tag: tagLike,
    commit: null,
    shortCommit: null,
    dirty: false,
    channel: "package",
    bundleHash,
    manifestPresent,
    manifestValid,
  }
}
