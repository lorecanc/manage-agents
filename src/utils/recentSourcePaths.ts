import fs from "node:fs"
import path from "node:path"
import { atomicWriteRestrictedFile } from "./agents.js"
import { parseGitHubShorthand } from "./github.js"
import { realpathThroughExistingAncestor } from "./pathValidation.js"
import { engineCacheDir, engineConfigDir, GIT_REF_RE, hasUrlCredentials, type Source } from "./sources.js"
import { terminalSafeText } from "./terminalText.js"

const RECENT_CAP = 8
const RECENT_FILE_NAME = "recent-source-paths.json"

/** Spec URLs riconosciute: HTTPS, SSH e forma scp-like `git@host:path`. */
const SPEC_URL_RE = /^(?:https:\/\/[^\s#]+|ssh:\/\/[^\s#]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s#-][^\s#]*)$/

export type RecentSourcePath =
  | { kind: "local"; path: string }
  | { kind: "spec"; spec: string }

export interface RecentSourcePaths { schemaVersion: 1; items: RecentSourcePath[] }

export function recentPathsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(engineConfigDir(env), RECENT_FILE_NAME)
}

function splitSpec(spec: string): { location: string; ref?: string } {
  const hashIndex = spec.indexOf("#")
  return hashIndex === -1
    ? { location: spec }
    : { location: spec.slice(0, hashIndex), ref: spec.slice(hashIndex + 1) }
}

function isValidSpecValue(spec: unknown): spec is string {
  if (typeof spec !== "string" || !spec || spec.trim() !== spec) return false
  if (hasUrlCredentials(spec)) return false
  if (spec.split(/[\\/]/).includes("..")) return false
  if (/^(?:file|ftp):/i.test(spec)) return false
  const { location, ref } = splitSpec(spec)
  if (ref !== undefined && !GIT_REF_RE.test(ref)) return false
  if (SPEC_URL_RE.test(location)) return true
  return parseGitHubShorthand(spec, { checkLocalExists: candidate => isSafeLocalDirectory(path.resolve(candidate)) }) !== null
}

/** Vetta le directory con lstat: una directory che è un symlink non passa. */
export function isSafeLocalDirectory(value: string): boolean {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) return false
  if (value.split(/[\\/]/).includes("..")) return false
  try {
    const stat = fs.lstatSync(value)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

export function classifyRecentCandidate(rawSpec: string): RecentSourcePath | null {
  if (typeof rawSpec !== "string") return null
  const trimmed = rawSpec.trim()
  if (!trimmed || hasUrlCredentials(trimmed)) return null
  if (isValidSpecValue(trimmed)) return { kind: "spec", spec: trimmed }
  if (!path.isAbsolute(trimmed)) return null
  const resolved = path.resolve(trimmed)
  if (!isSafeLocalDirectory(resolved)) return null
  const canonical = realpathThroughExistingAncestor(resolved)
  return isSafeLocalDirectory(canonical) ? { kind: "local", path: canonical } : null
}

function isRecentSourcePath(value: unknown): value is RecentSourcePath {
  if (typeof value !== "object" || value === null) return false
  const item = value as Record<string, unknown>
  return (item.kind === "local" && typeof item.path === "string")
    || (item.kind === "spec" && typeof item.spec === "string")
}

const keyOf = (item: RecentSourcePath): string => item.kind === "local" ? `local:${item.path}` : `spec:${item.spec}`

export function mergeRecentPath(state: RecentSourcePaths, candidate: RecentSourcePath, cap = RECENT_CAP): RecentSourcePaths {
  const items = Array.isArray(state?.items) ? state.items : []
  const merged = [candidate, ...items.filter(item => isRecentSourcePath(item) && keyOf(item) !== keyOf(candidate))]
  return { schemaVersion: 1, items: merged.slice(0, Math.max(0, cap)) }
}

export function pruneRecentPaths(
  state: RecentSourcePaths,
  deps: { isSafeLocal: (p: string) => boolean; isValidSpec: (s: string) => boolean },
  cap = RECENT_CAP,
): RecentSourcePaths {
  const items = Array.isArray(state?.items) ? state.items : []
  const kept = items.filter(item => {
    if (!isRecentSourcePath(item)) return false
    return item.kind === "local"
      ? isSafeLocalDirectory(item.path) && deps.isSafeLocal(item.path)
      : isValidSpecValue(item.spec) && deps.isValidSpec(item.spec)
  })
  return { schemaVersion: 1, items: kept.slice(0, Math.max(0, cap)) }
}

/** Pura: riceve voci già classificate da lstat e non risolve mai un symlink. */
export function suggestLocalPaths(
  query: string,
  entries: ReadonlyArray<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>,
  cap = RECENT_CAP,
): string[] {
  const needle = terminalSafeText(query).trim().toLowerCase()
  return entries
    .filter(entry => entry.isDirectory && !entry.isSymbolicLink && typeof entry.name === "string")
    .map(entry => terminalSafeText(entry.name))
    .filter(name => name.length > 0 && name.toLowerCase().includes(needle))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .slice(0, Math.max(0, cap))
}

/** Controlla ogni componente della configurazione in stile assertSafeCachePath. */
function assertSafeConfigPath(env: NodeJS.ProcessEnv): void {
  const configDir = path.resolve(engineConfigDir(env))
  const root = path.dirname(configDir)
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    throw new Error(`Refusing symlinked or non-directory config path: ${root}`)
  }
  let current = root
  for (const component of path.relative(root, configDir).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error(`Refusing symlinked or non-directory config path: ${current}`)
    }
  }
}

function depsFor(env: NodeJS.ProcessEnv) {
  const cacheDir = path.resolve(engineCacheDir(env))
  return {
    isSafeLocal: (value: string) => {
      const resolved = path.resolve(value)
      return resolved !== cacheDir && !resolved.startsWith(cacheDir + path.sep)
    },
    isValidSpec: isValidSpecValue,
  }
}

export function loadRecentSourcePaths(env: NodeJS.ProcessEnv = process.env): RecentSourcePaths {
  const empty: RecentSourcePaths = { schemaVersion: 1, items: [] }
  const file = recentPathsFile(env)
  try {
    assertSafeConfigPath(env)
    if (!fs.existsSync(file)) return empty
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    if (raw?.schemaVersion !== 1 || !Array.isArray(raw.items)) return empty
    return pruneRecentPaths({ schemaVersion: 1, items: raw.items }, depsFor(env))
  } catch {
    return empty
  }
}

export function saveRecentSourcePaths(state: RecentSourcePaths, env: NodeJS.ProcessEnv = process.env): void {
  assertSafeConfigPath(env)
  const pruned = pruneRecentPaths(state, depsFor(env))
  const file = recentPathsFile(env)
  const cacheDir = path.resolve(engineCacheDir(env))
  if (file === cacheDir || file.startsWith(cacheDir + path.sep)) {
    throw new Error(`Refusing to write recent paths inside the engine cache: ${file}`)
  }
  atomicWriteRestrictedFile(file, Buffer.from(`${JSON.stringify(pruned, null, 2)}\n`), 0o600)
}

/** Registra solo un Source già accettato da addSource, mai testo digitato. */
export function recordRecentSourcePath(source: Source, rawSpec: string, env: NodeJS.ProcessEnv = process.env): void {
  const classified = classifyRecentCandidate(rawSpec)
  if (!classified) return
  let candidate: RecentSourcePath
  if (source.kind === "local") {
    if (classified.kind !== "local") return
    candidate = { kind: "local", path: source.path }
  } else {
    if (classified.kind !== "spec") return
    const spec = `${source.url}${source.ref ? `#${source.ref}` : ""}`
    if (!isValidSpecValue(spec)) return
    candidate = { kind: "spec", spec }
  }
  if (candidate.kind === "local" && !depsFor(env).isSafeLocal(candidate.path)) return
  saveRecentSourcePaths(mergeRecentPath(loadRecentSourcePaths(env), candidate), env)
}
