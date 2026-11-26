/**
 * Machine-local browser detection for MCP servers that drive a browser.
 *
 * Packs declare the `{browser}` placeholder inside an MCP command (for example
 * `--executable-path={browser}`); the engine resolves it where it controls the
 * installation (OpenCode target reconcile and the Vibe plugin installer), so
 * committed bridge output stays machine-independent. Targets that install
 * committed files verbatim (Claude Code, Codex) drop the argument instead and
 * the server falls back to its own browser detection.
 *
 * Preference order: the Chromium family over the Chrome family. Running
 * headless is a command flag (`--headless`), not a binary: the pack declares
 * the flag and every machine gets it.
 */

import fs from "node:fs"
import path from "node:path"

/** Placeholder a pack can put in an MCP command element to get the machine's browser. */
export const BROWSER_TOKEN = "{browser}"

export interface BrowserDetectOptions {
  /** Platform to detect for (default: this machine). */
  platform?: string
  /** Environment for PATH lookups (default: this machine's). */
  env?: NodeJS.ProcessEnv
  /** Existence check, injectable for tests (default: fs.existsSync). */
  exists?: (file: string) => boolean
}

// Windows targets must be joined with Windows semantics even when the engine
// itself runs elsewhere, so pick the path module for the detected platform.
function fromPath(name: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean, suffix: string, target: typeof path): string | null {
  for (const dir of (env.PATH ?? "").split(target.delimiter)) {
    if (!dir) continue
    const candidate = target.join(dir, name + suffix)
    if (exists(candidate)) return candidate
  }
  return null
}

function fromPathList(names: string[], env: NodeJS.ProcessEnv, exists: (file: string) => boolean, suffix: string, target: typeof path): string | null {
  for (const name of names) {
    const found = fromPath(name, env, exists, suffix, target)
    if (found) return found
  }
  return null
}

/**
 * Detect the browser executable to hand to an MCP server on this machine.
 * Returns `null` when no known browser is installed.
 */
export function detectBrowserExecutable(options: BrowserDetectOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? ((file: string) => fs.existsSync(file))
  const suffix = platform === "win32" ? ".exe" : ""
  const target = platform === "win32" ? path.win32 : path.posix
  if (platform === "darwin") {
    const apps = [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ]
    const app = apps.find(file => exists(file))
    if (app) return app
    return fromPathList(["chromium", "google-chrome-stable", "google-chrome"], env, exists, suffix, target)
  }
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((dir): dir is string => Boolean(dir))
    const fixed = [
      ...roots.map(root => target.join(root, "Chromium", "Application", `chrome${suffix}`)),
      ...roots.map(root => target.join(root, "Google", "Chrome", "Application", `chrome${suffix}`))
    ]
    const app = fixed.find(file => exists(file))
    if (app) return app
    return fromPathList(["chromium", "google-chrome-stable", "google-chrome"], env, exists, suffix, target)
  }
  // Linux and everything else: PATH first, then the usual fixed locations.
  const chromium = fromPathList(["chromium", "chromium-browser"], env, exists, suffix, target)
  if (chromium) return chromium
  const fixed = [
    "/snap/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome"
  ]
  const app = fixed.find(file => exists(file))
  if (app) return app
  return fromPathList(["google-chrome-stable", "google-chrome", "chrome"], env, exists, suffix, target)
}

/**
 * Replace `{browser}` inside command elements with the detected executable.
 * Without a browser the elements are dropped, so the server keeps whatever
 * detection of its own it has instead of receiving a literal placeholder.
 */
export function expandBrowserToken(elements: string[], executable: string | null): { elements: string[]; unresolved: boolean } {
  if (!elements.some(element => element.includes(BROWSER_TOKEN))) return { elements, unresolved: false }
  if (executable === null) {
    return { elements: elements.filter(element => !element.includes(BROWSER_TOKEN)), unresolved: true }
  }
  return { elements: elements.map(element => element.split(BROWSER_TOKEN).join(executable)), unresolved: false }
}

/**
 * Drop `{browser}` elements from a command translated for a target that
 * installs committed files verbatim (Claude Code, Codex): the placeholder is
 * resolved nowhere on that path, so the server uses its own browser detection.
 */
export function stripBrowserToken(elements: string[]): { elements: string[]; dropped: boolean } {
  if (!elements.some(element => element.includes(BROWSER_TOKEN))) return { elements, dropped: false }
  return { elements: elements.filter(element => !element.includes(BROWSER_TOKEN)), dropped: true }
}
