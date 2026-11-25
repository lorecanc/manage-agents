import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { tempDir, writePack } from "../../test/helpers.js"
import { addSource, loadSources, saveSources } from "./sources.js"
import { translationConfigPath } from "./translationConfig.js"
import { displayWidth, middleEllipsis, terminalSafeText } from "./terminalText.js"

const repoRoot = fileURLToPath(new URL("../../", import.meta.url))
const indexTsxPath = fileURLToPath(new URL("../index.tsx", import.meta.url))

function isolatedCliEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
  }
  delete env.MANAGE_AGENTS_ALLOW_UNSIGNED
  delete env.MANAGE_AGENTS_RELEASE_PUBLIC_KEY
  delete env.RELEASE_SIGNING_PRIVATE_KEY
  return env
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [
    "--experimental-ffi",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    indexTsxPath,
    ...args,
  ], { cwd: repoRoot, env, encoding: "utf8", input: "" })
}

test("middle ellipsis is cell bounded and grapheme safe", () => {
  for (const [text, budget] of [["abcdef", 0], ["abcdef", 1], ["abcdef", 2], ["a界b", 4], ["a\u0301bc", 2], ["👩‍💻 works", 5], ["你好世界", 5], ["👨‍👩‍👧‍👦 family", 6]] as const) {
    const result = middleEllipsis(text, budget)
    assert.ok(displayWidth(result) <= budget)
  }
  assert.equal(middleEllipsis("abcdef", 0), "")
  assert.equal(middleEllipsis("abcdef", 1), "…")
  assert.equal(middleEllipsis("abcdef", 2), "a…")
  assert.equal(middleEllipsis("a\u0301bc", 2), "á…")
  assert.equal(middleEllipsis("👩‍💻 works", 3), "👩‍💻…")
  assert.equal(middleEllipsis("👩‍💻abc", 3), "👩‍💻…")
  assert.equal(displayWidth(middleEllipsis("你好世界", 5)) <= 5, true)
})

test("middle ellipsis preserves ordered contiguous prefix and suffix", () => {
  const cases = [
    ["abcdef", 3, "a…f"],
    ["abcdef", 4, "a…ef"],
    ["C:\\Users\\Ada\\file.txt", 10, "C:\\U…e.txt"],
    ["prefix-0123456789-suffix", 10, "pref…uffix"],
    ["界界界界", 5, "界…界"],
    ["界界界界", 4, "界…"],
    ["a\u0301bcdef", 4, "a\u0301…ef"],
    ["👩‍💻abc", 4, "👩‍💻…c"],
    ["👩‍💻abc", 3, "👩‍💻…"]
  ] as const

  for (const [text, budget, expected] of cases) {
    const result = middleEllipsis(text, budget)
    assert.equal(result, expected)
    assert.ok(displayWidth(result) <= budget)
    if (result.includes("…")) {
      const [prefix, suffix] = result.split("…")
      assert.ok(text.startsWith(prefix))
      assert.ok(text.endsWith(suffix))
    }
  }
})

test("terminal text removes terminal controls", () => {
  assert.equal(terminalSafeText("normal\x1b[31m red\x1b[0m\x1b]0;title\x07\nline\ttab\x01"), "normal redlinetab")
  assert.equal(middleEllipsis("normal\x1b[31m text", 20), "normal text")
  assert.ok(displayWidth(middleEllipsis("x".repeat(1_000_000), 10)) <= 10)
})

test("terminal text safely normalizes dynamic values and labels", () => {
  assert.equal(terminalSafeText(null), "")
  assert.equal(terminalSafeText(false), "false")
  assert.equal(terminalSafeText(42), "42")
  assert.equal(terminalSafeText({ label: "agent" }), "[object Object]")
  assert.equal(middleEllipsis("agent\x1b[31m-name", 20), "agent-name")
})

test("display width is terminal-cell aware", () => {
  assert.equal(displayWidth("a界"), 3)
  assert.equal(displayWidth("a\u0301"), 1)
  assert.equal(displayWidth("👩‍💻"), 2)
  assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2)
})

test("CLI JSON failures exit 1 while keeping stdout valid JSON", (t) => {
  const root = tempDir(t, "terminal-cli-json-")
  const env = isolatedCliEnv(root)
  const target = path.join(root, "target")
  const failed = runCli(["install", "missing-pack", "--target", target, "--json"], env)
  assert.equal(JSON.parse(failed.stdout).status, "failed")
  assert.equal(failed.status, 1, `failed JSON operation must exit 1; stdout=${failed.stdout}; stderr=${failed.stderr}`)

  const sourceRoot = writePack(path.join(root, "untrusted-source"), {
    "agents/demo-agent.md": "---\ndescription: Demo agent\nmode: subagent\n---\nHelp with the demo.\n",
    "opencode.json": JSON.stringify({ mcp: { servers: { local_cmd: { type: "local", command: ["echo", "hi"] } } } }),
  }, { name: "demo" })
  const registry = loadSources(env)
  addSource(registry, "untrusted", sourceRoot)
  saveSources(registry, env)
  const declined = runCli(["install", "demo", "--target", target, "--json"], env)
  assert.equal(JSON.parse(declined.stdout).status, "declined")
  assert.equal(declined.status, 1, `declined JSON operation must exit 1; stdout=${declined.stdout}; stderr=${declined.stderr}`)
})

test("source auth --json exits 1 when gh is unauthenticated", (t) => {
  const root = tempDir(t, "terminal-source-auth-")
  const fakeBin = path.join(root, "bin")
  fs.mkdirSync(fakeBin)
  const fakeGh = path.join(fakeBin, "gh")
  fs.writeFileSync(fakeGh, "#!/bin/sh\nexit 1\n")
  fs.chmodSync(fakeGh, 0o755)
  const env = isolatedCliEnv(root)
  env.PATH = fakeBin

  const result = runCli(["source", "auth", "--json"], env)
  const status = JSON.parse(result.stdout)
  assert.equal(status.authenticated, false)
  assert.equal(result.status, 1, `unauthenticated JSON status must exit 1; stdout=${result.stdout}; stderr=${result.stderr}`)
})

test("bridge confirms untrusted executable content before writing and sanitizes output", (t) => {
  const root = tempDir(t, "terminal-bridge-trust-")
  const env = isolatedCliEnv(root)
  const workspace = path.join(root, "workspace")
  const control = process.platform === "win32" ? "\u007f" : "\u001b[31m"
  const outputDir = path.join(workspace, `generated${control}-plugin`)
  writePack(path.join(workspace, "packs", "demo"), {
    "agents/demo-agent.md": "---\ndescription: Demo agent\nmode: subagent\n---\nHelp with the demo.\n",
    "opencode.json": JSON.stringify({ mcp: { servers: { local_cmd: { type: "local", command: ["echo", "hi"] } } } }),
  }, { name: "demo" })

  const args = ["--workspace", workspace, "bridge", "--pack", "demo", "--output", outputDir, "--target", "claude", "--no-validate", "--no-register"]
  const declined = runCli(args, env)
  assert.equal(declined.status, 1, `untrusted executable bridge must require confirmation; stdout=${declined.stdout}; stderr=${declined.stderr}`)
  assert.equal(fs.existsSync(outputDir), false)
  assert.equal(fs.existsSync(translationConfigPath(workspace)), false)

  const accepted = runCli([...args, "--yes"], env)
  assert.equal(accepted.status, 0, `--yes should permit bridge generation; stdout=${accepted.stdout}; stderr=${accepted.stderr}`)
  assert.equal(fs.existsSync(outputDir), true)
  assert.match(accepted.stdout, /generated-plugin/)
  assert.equal(accepted.stdout.includes(control[0]), false, "bridge output must not contain the terminal control character")
})

test("bridge does not trust an unrelated workspace from --source", (t) => {
  const root = tempDir(t, "terminal-bridge-source-trust-")
  const env: NodeJS.ProcessEnv = isolatedCliEnv(root)
  const trustedSourceRoot = path.join(root, "dirA")
  fs.mkdirSync(trustedSourceRoot)
  const registry = loadSources(env)
  addSource(registry, "trusted-src", trustedSourceRoot, { trusted: true })
  saveSources(registry, env)

  const workspace = path.join(root, "dirB")
  writePack(path.join(workspace, "packs", "demo"), {
    "agents/demo-agent.md": "---\ndescription: Demo agent\nmode: subagent\n---\nHelp with the demo.\n",
    "opencode.json": JSON.stringify({ mcp: { servers: { local_cmd: { type: "local", command: ["echo", "hi"] } } } }),
  }, { name: "demo" })
  const outputDir = path.join(root, "out")
  const result = runCli([
    "bridge", "--source", "trusted-src", "--workspace", workspace,
    "--pack", "demo", "--target", "claude", "--output", outputDir, "--no-register",
  ], env)

  assert.equal(result.status, 1, `unrelated workspace must require confirmation; stdout=${result.stdout}; stderr=${result.stderr}`)
  assert.equal(fs.existsSync(outputDir), false)
})

test("self-update --check fails closed without --allow-unsigned", (t) => {
  const root = tempDir(t, "terminal-self-update-trust-")
  const env = isolatedCliEnv(root)
  const engineRoot = path.join(root, "engine")
  fs.mkdirSync(engineRoot)

  const result = runCli(["self-update", "--check", "--engine-root", engineRoot], env)
  assert.equal(result.status, 1, `self-update must require configured signature trust; stdout=${result.stdout}; stderr=${result.stderr}`)
  assert.match(result.stderr, /Signature verification is required/)
})
