import { execFile, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { cleanGitEnvironment } from "./repositoryTransaction.js"

export const GITHUB_HOST_RE = /^(?!-)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
export const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})$/
export const GITHUB_REPO_RE = /^(?!\.\.?$)(?!-)[A-Za-z0-9._-]{1,100}$/
const SHORTHAND_REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/

export interface GhRunResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export interface GhRunner {
  run(args: string[], options?: { stdio?: "pipe" | "inherit"; env?: NodeJS.ProcessEnv }): GhRunResult
}

export const defaultGhRunner: GhRunner = {
  run(args, options = {}) {
    const stdio: "inherit" | ["ignore", "pipe", "pipe"] = options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"]
    const result = spawnSync("gh", args, {
      encoding: "utf8",
      env: cleanGitEnvironment(options.env ?? {}),
      stdio,
      windowsHide: true,
    })
    return {
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      ...(result.error ? { error: result.error } : {}),
    }
  },
}

export interface GitHubShorthand {
  owner: string
  repo: string
  url: string
  ref?: string
}

export interface GhAuthStatus {
  available: boolean
  authenticated: boolean
  host: string
  login?: string
  message: string
}

export interface GhRepoSummary {
  nameWithOwner: string
  description: string
  isPrivate: boolean
  updatedAt: string
  url: string
}

/**
 * Parses `github:owner/repo[#ref]`, `gh:owner/repo[#ref]`, or bare `owner/repo[#ref]` when it does not name an
 * existing local directory. Rejects paths starting with `.`, `/`, `~`, `\`, URL schemes, or unsafe segments.
 */
export function parseGitHubShorthand(
  raw: string,
  options: { checkLocalExists?: (candidate: string) => boolean } = {},
): GitHubShorthand | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const prefixed = /^(?:github|gh):(.+)$/i.exec(trimmed)
  const body = prefixed ? prefixed[1] : trimmed
  if (!prefixed) {
    if (
      body.startsWith(".") ||
      body.startsWith("/") ||
      body.startsWith("~") ||
      body.includes("\\") ||
      /^[A-Za-z]:/.test(body) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(body)
    ) {
      return null
    }
  }
  const hashIndex = body.indexOf("#")
  const repoPart = hashIndex === -1 ? body : body.slice(0, hashIndex)
  const ref = hashIndex === -1 ? undefined : body.slice(hashIndex + 1)
  if (ref !== undefined && (!ref || !SHORTHAND_REF_RE.test(ref))) return null

  const parts = repoPart.split("/")
  if (parts.length !== 2) return null
  const [owner, rawRepo] = parts
  const repo = rawRepo.replace(/\.git$/i, "")
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(repo)) return null

  if (!prefixed) {
    const exists = options.checkLocalExists ?? ((candidate: string) => {
      try { return fs.existsSync(path.resolve(candidate)) && fs.statSync(path.resolve(candidate)).isDirectory() } catch { return false }
    })
    if (exists(repoPart) || (hashIndex !== -1 && exists(body))) return null
  }

  return {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}.git`,
    ...(ref ? { ref } : {}),
  }
}

/** Extracts a safe hostname from an `https://<host>/...` URL without embedded credentials. */
export function extractHttpsHost(url: string): string | null {
  if (!url.startsWith("https://") || /^https:\/\/[^/]*@/.test(url)) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null
  const host = parsed.hostname.toLowerCase()
  return GITHUB_HOST_RE.test(host) ? host : null
}

function runGhAsync(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<GhRunResult> {
  return new Promise(resolve => {
    execFile("gh", args, { encoding: "utf8", env: cleanGitEnvironment(env), maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ status: null, stdout: "", stderr: "", error })
        return
      }
      const code = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0
      resolve({ status: code, stdout: stdout ?? "", stderr: stderr ?? "" })
    })
  })
}

function parseGhAuthResult(host: string, result: GhRunResult): GhAuthStatus {
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT"
    return {
      available: !missing,
      authenticated: false,
      host,
      message: missing ? "GitHub CLI (gh) is not installed on PATH." : result.error.message,
    }
  }
  try {
    const parsed = JSON.parse(result.stdout || "{}") as { hosts?: Record<string, Array<Record<string, unknown>>> }
    const accounts = parsed?.hosts?.[host] ?? Object.values(parsed?.hosts ?? {})[0] ?? []
    if (Array.isArray(accounts) && accounts.length > 0) {
      const active = accounts.find(entry => entry?.active === true && entry?.state === "success")
        ?? accounts.find(entry => entry?.state === "success")
      if (active) {
        const login = typeof active.login === "string" && active.login ? active.login : undefined
        return {
          available: true,
          authenticated: true,
          host,
          ...(login ? { login } : {}),
          message: login ? `Authenticated on ${host} as ${login}` : `Authenticated on ${host}`,
        }
      }
      const failed = accounts[0]
      const failedLogin = typeof failed?.login === "string" && failed.login ? ` (${failed.login})` : ""
      return {
        available: true,
        authenticated: false,
        host,
        message: `GitHub CLI session on ${host}${failedLogin} needs re-authentication.`,
      }
    }
  } catch {
    if (result.status === 0) {
      return { available: true, authenticated: true, host, message: `Authenticated on ${host}` }
    }
  }
  return {
    available: true,
    authenticated: false,
    host,
    message: `Not logged in to ${host} via gh.`,
  }
}

/** Checks `gh` CLI availability and authentication state without ever requesting `--show-token`. */
export function inspectGhAuth(
  hostname = "github.com",
  runner: GhRunner = defaultGhRunner,
  env: NodeJS.ProcessEnv = process.env,
): GhAuthStatus {
  const host = hostname.trim().toLowerCase()
  if (!GITHUB_HOST_RE.test(host)) throw new Error(`invalid GitHub hostname "${hostname}"`)
  return parseGhAuthResult(host, runner.run(["auth", "status", "--hostname", host, "--json", "hosts"], { env }))
}

export async function inspectGhAuthAsync(
  hostname = "github.com",
  env: NodeJS.ProcessEnv = process.env,
): Promise<GhAuthStatus> {
  const host = hostname.trim().toLowerCase()
  if (!GITHUB_HOST_RE.test(host)) throw new Error(`invalid GitHub hostname "${hostname}"`)
  return parseGhAuthResult(host, await runGhAsync(["auth", "status", "--hostname", host, "--json", "hosts"], env))
}

function buildGhRepoListArgs(options: { owner?: string; limit?: number; hostname?: string }, env: NodeJS.ProcessEnv) {
  const owner = options.owner?.trim()
  if (owner && !GITHUB_OWNER_RE.test(owner)) throw new Error(`invalid GitHub owner "${owner}"`)
  const host = (options.hostname ?? "github.com").trim().toLowerCase()
  if (!GITHUB_HOST_RE.test(host)) throw new Error(`invalid GitHub hostname "${options.hostname}"`)
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)))
  const args = [
    "repo",
    "list",
    ...(owner ? [owner] : []),
    "--limit",
    String(limit),
    "--no-archived",
    "--json",
    "nameWithOwner,description,isPrivate,updatedAt,url",
  ]
  const runEnv = host === "github.com" ? env : { ...env, GH_HOST: host }
  return { args, host, runEnv }
}

function parseGhRepoListResult(host: string, result: GhRunResult): GhRepoSummary[] {
  if (result.error) {
    throw new Error((result.error as NodeJS.ErrnoException).code === "ENOENT" ? "gh CLI is not installed" : result.error.message)
  }
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim().split("\n").slice(-1)[0] || `exit ${result.status}`
    throw new Error(`gh repo list failed: ${detail}`)
  }
  const raw = JSON.parse(result.stdout || "[]")
  if (!Array.isArray(raw)) return []
  const repos: GhRepoSummary[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const nameWithOwner = typeof item.nameWithOwner === "string" ? item.nameWithOwner.trim() : ""
    if (!nameWithOwner || !parseGitHubShorthand(`github:${nameWithOwner}`)) continue
    const url = typeof item.url === "string" && item.url.startsWith("https://")
      ? `${item.url.replace(/\/+$/, "").replace(/\.git$/i, "")}.git`
      : `https://${host}/${nameWithOwner}.git`
    repos.push({
      nameWithOwner,
      description: typeof item.description === "string" ? item.description : "",
      isPrivate: item.isPrivate === true,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      url,
    })
  }
  return repos
}

/** Lists non-archived repositories accessible via `gh repo list`. */
export function listGhRepos(
  options: { owner?: string; limit?: number; hostname?: string } = {},
  runner: GhRunner = defaultGhRunner,
  env: NodeJS.ProcessEnv = process.env,
): GhRepoSummary[] {
  const { args, host, runEnv } = buildGhRepoListArgs(options, env)
  return parseGhRepoListResult(host, runner.run(args, { env: runEnv }))
}

export async function listGhReposAsync(
  options: { owner?: string; limit?: number; hostname?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<GhRepoSummary[]> {
  const { args, host, runEnv } = buildGhRepoListArgs(options, env)
  return parseGhRepoListResult(host, await runGhAsync(args, runEnv))
}

/** Runs interactive browser-based `gh auth login` attached to the user's terminal. */
export function runGhWebLogin(
  hostname = "github.com",
  runner: GhRunner = defaultGhRunner,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; message: string } {
  const host = hostname.trim().toLowerCase()
  if (!GITHUB_HOST_RE.test(host)) throw new Error(`invalid GitHub hostname "${hostname}"`)
  const result = runner.run(["auth", "login", "--hostname", host, "--git-protocol", "https", "--web"], { stdio: "inherit", env })
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT"
    return { ok: false, message: missing ? "GitHub CLI (gh) is not installed on PATH." : result.error.message }
  }
  if (result.status !== 0) {
    return { ok: false, message: `gh auth login exited with code ${result.status ?? 1}.` }
  }
  const status = inspectGhAuth(host, runner, env)
  return { ok: status.authenticated, message: status.message }
}
