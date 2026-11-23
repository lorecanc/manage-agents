#!/usr/bin/env node
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { constants as osConstants } from "node:os"

export function isDirectEntrypoint(argv1 = process.argv[1], metaUrl = import.meta.url) {
  try {
    return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}

export function checkRuntimeEngineVersion({ bunVersion = process.versions.bun, nodeVersion = process.versions.node } = {}) {
  const parseVersion = (version) => {
    const text = String(version ?? "")
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(text)) return null
    const parsed = parseCoreSemver(text)
    return parsed ? { major: parsed.major, minor: parsed.minor, patch: parsed.patch, pre: parsed.pre } : null
  }
  const compare = (left, right) => {
    if (left.major !== right.major) return left.major - right.major
    if (left.minor !== right.minor) return left.minor - right.minor
    if (left.patch !== right.patch) return left.patch - right.patch
    if (left.pre === right.pre) return 0
    if (left.pre === null) return 1
    if (right.pre === null) return -1
    return left.pre < right.pre ? -1 : 1
  }

  if (bunVersion !== undefined) {
    const parsed = parseVersion(bunVersion)
    if (!parsed || compare(parsed, { major: 1, minor: 3, patch: 0, pre: null }) < 0) {
      return { ok: false, message: `manage-agents requires Bun >= 1.3.0 (found ${bunVersion}). Please upgrade Bun to >= 1.3.0.` }
    }
    return { ok: true }
  }

  const parsed = parseVersion(nodeVersion)
  if (!parsed || compare(parsed, { major: 26, minor: 4, patch: 0, pre: null }) < 0) {
    return {
      ok: false,
      message: `manage-agents requires Node.js >= 26.4.0 (found ${nodeVersion}). OpenTUI uses FFI; install Bun, or upgrade Node to >= 26.4.0.`,
    }
  }
  return { ok: true }
}

const SELF_UPDATE_JOURNAL_REL = ".manage-agents/self-update-journal.json"
const SELF_UPDATE_BACKUP_DIR_REL = ".manage-agents/self-update-backup"
const SELF_UPDATE_ALLOWED_TARGETS = new Set([
  "manage-agents.mjs", "package.json", "dist", "assets", "contract", "runtime",
  "package-lock.json", "bun.lock", "src", "README.md", "GUIDA.md", "LICENSE", ".gitignore", "node_modules",
])

function safeRecoveryPath(engineDir, target) {
  const root = resolve(engineDir)
  const candidate = resolve(target)
  const rel = relative(root, candidate)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Refusing a path outside the engine directory.")
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Refusing a symlink or non-directory engine root.")
  let current = root
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (error?.code === "ENOENT") return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing a symlink path inside engine directory: ${component}`)
    if (current !== candidate && !stat.isDirectory()) throw new Error(`Refusing a non-directory path component: ${component}`)
  }
}

function samePathContents(left, right) {
  let leftStat
  let rightStat
  try {
    leftStat = lstatSync(left)
    rightStat = lstatSync(right)
  } catch {
    return false
  }
  if (leftStat.mode !== rightStat.mode || leftStat.isSymbolicLink() !== rightStat.isSymbolicLink()) return false
  if (leftStat.isSymbolicLink()) return readlinkSync(left) === readlinkSync(right)
  if (leftStat.isFile()) return rightStat.isFile() && readFileSync(left).equals(readFileSync(right))
  if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false
  const leftNames = readdirSync(left).sort()
  const rightNames = readdirSync(right).sort()
  return leftNames.length === rightNames.length && leftNames.every((name, index) => name === rightNames[index] && samePathContents(join(left, name), join(right, name)))
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return
  const fd = openSync(directory, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function recoverEngineDirIfInterrupted(engineDir) {
  const root = resolve(engineDir)
  const journalPath = join(root, ...SELF_UPDATE_JOURNAL_REL.split("/"))
  const stateDir = dirname(journalPath)
  const backupBase = join(root, ...SELF_UPDATE_BACKUP_DIR_REL.split("/"))
  safeRecoveryPath(root, stateDir)
  safeRecoveryPath(root, journalPath)
  safeRecoveryPath(root, backupBase)
  const journalStat = lstatSync(journalPath, { throwIfNoEntry: false })
  if (!journalStat) return false
  if (!journalStat.isFile() || journalStat.isSymbolicLink()) throw new Error("Self-update recovery journal must be a regular file.")

  let journal
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8"))
  } catch {
    throw new Error("Self-update recovery journal is invalid.")
  }
  if (
    !journal || typeof journal !== "object" || Array.isArray(journal) || journal.schemaVersion !== 1 ||
    typeof journal.id !== "string" || !/^[a-f0-9]{32}$/.test(journal.id) ||
    !Array.isArray(journal.entries) || typeof journal.manifestExisted !== "boolean"
  ) throw new Error("Self-update recovery journal is invalid.")
  const seenIndexes = new Set()
  const seenTargets = new Set()
  for (const entry of journal.entries) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) || !Number.isSafeInteger(entry.idx) || entry.idx < 0 ||
      typeof entry.rel !== "string" || !SELF_UPDATE_ALLOWED_TARGETS.has(entry.rel) || typeof entry.existed !== "boolean" ||
      seenIndexes.has(entry.idx) || seenTargets.has(entry.rel)
    ) throw new Error("Self-update recovery journal contains an invalid engine target.")
    seenIndexes.add(entry.idx)
    seenTargets.add(entry.rel)
  }

  const backupRoot = join(backupBase, journal.id)
  const backupEntries = join(backupRoot, "entries")
  const manifestPath = join(stateDir, "release-manifest.json")
  const manifestBackup = join(backupRoot, "release-manifest.json")
  try {
    safeRecoveryPath(root, backupRoot)
    safeRecoveryPath(root, backupEntries)
    safeRecoveryPath(root, manifestPath)
    safeRecoveryPath(root, manifestBackup)
    const backupStat = lstatSync(backupRoot, { throwIfNoEntry: false })
    if (!backupStat?.isDirectory() || backupStat.isSymbolicLink()) throw new Error("Self-update backup directory is missing or invalid.")

    for (const entry of [...journal.entries].reverse()) {
      const target = join(root, ...entry.rel.split("/"))
      const backup = join(backupEntries, String(entry.idx))
      safeRecoveryPath(root, target)
      safeRecoveryPath(root, backup)
      const backupStat = lstatSync(backup, { throwIfNoEntry: false })
      if (entry.existed && !backupStat) throw new Error(`Missing backup for engine target '${entry.rel}'.`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      if (entry.existed) {
        mkdirSync(dirname(target), { recursive: true })
        cpSync(backup, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
        if (!samePathContents(backup, target)) throw new Error(`Unable to verify restored engine target '${entry.rel}'.`)
      } else if (lstatSync(target, { throwIfNoEntry: false })) {
        throw new Error(`Unable to verify removal of engine target '${entry.rel}'.`)
      }
    }

    const manifestStat = lstatSync(manifestPath, { throwIfNoEntry: false })
    if (manifestStat?.isSymbolicLink()) throw new Error("Refusing a symlink release manifest during recovery.")
    rmSync(manifestPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    if (journal.manifestExisted) {
      const manifestBackupStat = lstatSync(manifestBackup, { throwIfNoEntry: false })
      if (!manifestBackupStat?.isFile() || manifestBackupStat.isSymbolicLink()) throw new Error("Release manifest backup is missing or invalid.")
      mkdirSync(dirname(manifestPath), { recursive: true })
      cpSync(manifestBackup, manifestPath, { preserveTimestamps: true })
      if (!samePathContents(manifestBackup, manifestPath)) throw new Error("Unable to verify restored release manifest.")
    } else if (lstatSync(manifestPath, { throwIfNoEntry: false })) {
      throw new Error("Unable to verify removal of release manifest.")
    }

    unlinkSync(journalPath)
    fsyncDirectory(stateDir)
    rmSync(backupRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    try {
      if (readdirSync(backupBase).length === 0) rmdirSync(backupBase)
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error
    }
    return true
  } catch (error) {
    throw new Error(`Unable to recover interrupted self-update; backup retained at ${backupRoot}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const distPath = join(scriptDir, "dist", "index.js")
const srcDir = join(scriptDir, "src")
const packageJsonPath = join(scriptDir, "package.json")

function newestSourceMtime(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce((latest, entry) => {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) return Math.max(latest, newestSourceMtime(entryPath))
    return Math.max(latest, statSync(entryPath).mtimeMs)
  }, 0)
}

function parseCoreSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version).trim())
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? null } : null
}

function cmpCoreSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : 1
}

function satisfiesSimpleSpec(installedVersion, rawSpec) {
  const installed = parseCoreSemver(installedVersion)
  if (!installed) return false
  const spec = String(rawSpec).trim()
  if (spec === "*" || spec === "") return true
  const caret = spec.startsWith("^")
  const tilde = spec.startsWith("~")
  const gte = spec.startsWith(">=")
  const base = parseCoreSemver(caret || tilde ? spec.slice(1) : gte ? spec.slice(2) : spec)
  if (!base) return true
  if (gte) return cmpCoreSemver(installed, base) >= 0
  if (tilde) return installed.major === base.major && installed.minor === base.minor && cmpCoreSemver(installed, base) >= 0
  if (caret) {
    if (cmpCoreSemver(installed, base) < 0) return false
    if (base.major > 0) return installed.major === base.major
    if (base.minor > 0) return installed.major === 0 && installed.minor === base.minor
    return installed.major === 0 && installed.minor === 0 && installed.patch === base.patch
  }
  return installed.major === base.major && installed.minor === base.minor && installed.patch === base.patch && installed.pre === base.pre
}

function dependenciesMatch(managerDir, includeDevDependencies) {
  if (!existsSync(packageJsonPath)) return true
  let pkg
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"))
  } catch {
    return false
  }
  const required = {
    ...(pkg.dependencies ?? {}),
    ...(includeDevDependencies ? (pkg.devDependencies ?? {}) : {}),
  }
  for (const [name, spec] of Object.entries(required)) {
    const installedPkgPath = join(managerDir, "node_modules", ...name.split("/"), "package.json")
    if (!existsSync(installedPkgPath)) return false
    try {
      const installed = JSON.parse(readFileSync(installedPkgPath, "utf8"))
      if (typeof installed.version !== "string" || !satisfiesSimpleSpec(installed.version, spec)) return false
    } catch {
      return false
    }
  }
  return true
}

if (isDirectEntrypoint()) {
  // Defensive UTF-8 codepage pin; openTUI >= 0.5.0 writes via WriteConsoleW so this is belt-and-suspenders for older/fallback paths.
  if (process.platform === "win32") {
    try {
      spawnSync("chcp", ["65001"], { shell: true, stdio: "ignore", windowsHide: true })
    } catch {
      // non-fatal
    }
  }

  const runtime = checkRuntimeEngineVersion()
  if (!runtime.ok) {
    console.error(runtime.message)
    process.exit(1)
  }

  if (!process.versions.bun) {
    const hasExperimentalFfi = process.execArgv.includes("--experimental-ffi")
    const hasExperimentalWarningSuppression = process.execArgv.some(arg => arg === "--no-warnings" || arg === "--no-warnings=ExperimentalWarning")
    if (!hasExperimentalFfi || !hasExperimentalWarningSuppression) {
      const execArgs = [...process.execArgv]
      if (!hasExperimentalFfi) execArgs.push("--experimental-ffi")
      if (!hasExperimentalWarningSuppression) execArgs.push("--no-warnings=ExperimentalWarning")
      const result = spawnSync(process.execPath, [...execArgs, ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true })
      if (result.error) {
        console.error(`Failed to re-exec with --experimental-ffi: ${result.error.message}`)
        process.exit(1)
      }
      if (result.signal) process.exit(128 + (osConstants.signals[result.signal] ?? 1))
      process.exit(result.status ?? 1)
    }
  }

  recoverEngineDirIfInterrupted(scriptDir)

  const hasSources = existsSync(srcDir)
  const newestSource = hasSources
    ? Math.max(newestSourceMtime(srcDir), existsSync(packageJsonPath) ? statSync(packageJsonPath).mtimeMs : 0)
    : 0
  const needsBuild = hasSources ? !existsSync(distPath) || statSync(distPath).mtimeMs < newestSource : !existsSync(distPath)

  if (process.env.MANAGE_AGENTS_SKIP_AUTO_INSTALL !== "1" && (hasSources || existsSync(join(scriptDir, "package-lock.json"))) && !dependenciesMatch(scriptDir, hasSources && needsBuild)) {
    const installCommand = process.versions.bun
      ? (existsSync(join(scriptDir, "bun.lock")) ? "bun install --frozen-lockfile --ignore-scripts" : "bun install --ignore-scripts")
      : (existsSync(join(scriptDir, "package-lock.json")) ? "npm ci --ignore-scripts --no-audit --no-fund" : "npm install --ignore-scripts --no-audit --no-fund")
    const installResult = spawnSync(installCommand, { cwd: scriptDir, shell: true, stdio: ["inherit", 2, 2], windowsHide: true })
    if (installResult.status !== 0) process.exit(installResult.status ?? 1)
  }

  // A published package ships dist/ without src/: rebuild only from a checkout.
  if (needsBuild) {
    const result = spawnSync(process.versions.bun ? "bun run build" : "npm run build", { cwd: scriptDir, shell: true, stdio: ["inherit", 2, 2], windowsHide: true })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }

  // npm and user-local bin links can invoke this launcher under an extensionless name.
  process.argv[1] = fileURLToPath(import.meta.url)
  await import(pathToFileURL(distPath).href)
}
