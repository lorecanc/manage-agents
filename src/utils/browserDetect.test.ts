import assert from "node:assert/strict"
import test from "node:test"
import { BROWSER_TOKEN, detectBrowserExecutable, expandBrowserToken, stripBrowserToken } from "./browserDetect.js"

function detect(platform: string, files: string[], env: NodeJS.ProcessEnv = { PATH: "/bin" }): string | null {
  const present = new Set(files)
  return detectBrowserExecutable({ platform, env, exists: file => present.has(file) })
}

test("detectBrowserExecutable prefers Chromium over Chrome", () => {
  const chromium = "/bin/chromium"
  const chrome = "/bin/google-chrome"
  assert.equal(detect("linux", [chromium]), chromium)
  assert.equal(detect("linux", [chrome]), chrome)
  assert.equal(detect("linux", [chromium, chrome]), chromium)
  assert.equal(detect("linux", ["/bin/chromium-browser", chromium]), chromium)
})

test("detectBrowserExecutable finds snap and fixed-location browsers off PATH", () => {
  assert.equal(detect("linux", ["/snap/bin/chromium"]), "/snap/bin/chromium")
  assert.equal(detect("linux", ["/usr/bin/google-chrome-stable"]), "/usr/bin/google-chrome-stable")
  assert.equal(detect("linux", ["/usr/bin/google-chrome"]), "/usr/bin/google-chrome")
})

test("detectBrowserExecutable resolves the macOS application bundles", () => {
  const chromiumApp = "/Applications/Chromium.app/Contents/MacOS/Chromium"
  const chromeApp = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  assert.equal(detect("darwin", [chromiumApp]), chromiumApp)
  assert.equal(detect("darwin", [chromeApp]), chromeApp)
  assert.equal(detect("darwin", [chromiumApp, chromeApp]), chromiumApp)
  assert.equal(detect("darwin", ["/bin/chromium"]), "/bin/chromium")
})

test("detectBrowserExecutable resolves Windows install locations", () => {
  const chromium = "C:\\Program Files\\Chromium\\Application\\chrome.exe"
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  const env = { PATH: "C:\\Windows", ProgramFiles: "C:\\Program Files" }
  const present = new Set([chromium, chrome])
  const found = detectBrowserExecutable({ platform: "win32", env, exists: file => present.has(file) })
  assert.equal(found, chromium)
  const presentChrome = new Set([chrome])
  const foundChrome = detectBrowserExecutable({ platform: "win32", env, exists: file => presentChrome.has(file) })
  assert.equal(foundChrome, chrome)
})

test("detectBrowserExecutable returns null without any browser", () => {
  assert.equal(detect("linux", []), null)
  assert.equal(detect("darwin", []), null)
})

test("expandBrowserToken replaces the placeholder inside command elements", () => {
  const command = ["npx", "-y", "chrome-devtools-mcp@latest", `--executable-path=${BROWSER_TOKEN}`]
  assert.deepEqual(expandBrowserToken(command, "/snap/bin/chromium").elements, [
    "npx", "-y", "chrome-devtools-mcp@latest", "--executable-path=/snap/bin/chromium"
  ])
  assert.equal(expandBrowserToken(command, "/snap/bin/chromium").unresolved, false)
  assert.deepEqual(expandBrowserToken(command, null).elements, ["npx", "-y", "chrome-devtools-mcp@latest"])
  assert.equal(expandBrowserToken(command, null).unresolved, true)
  assert.deepEqual(expandBrowserToken(["npx"], null), { elements: ["npx"], unresolved: false })
})

test("stripBrowserToken drops placeholder elements for verbatim-install targets", () => {
  const command = ["npx", "-y", "chrome-devtools-mcp@latest", `--headless`, `--executable-path=${BROWSER_TOKEN}`]
  const stripped = stripBrowserToken(command)
  assert.equal(stripped.dropped, true)
  assert.deepEqual(stripped.elements, ["npx", "-y", "chrome-devtools-mcp@latest", "--headless"])
  assert.deepEqual(stripBrowserToken(["npx", "-y"]), { elements: ["npx", "-y"], dropped: false })
})
