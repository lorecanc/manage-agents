import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import React from "react"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { App } from "../App.js"
import { tempDir, writePack } from "../../test/helpers.js"
import { hasErrors, validatePack } from "./packs.js"
import { DEFAULT_TRANSLATION_CONFIG, translationConfigPath } from "./translationConfig.js"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const indexTsxPath = path.join(repoRoot, "src", "index.tsx")

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
  }
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd = repoRoot) {
  return spawnSync(process.execPath, [
    "--experimental-ffi",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    indexTsxPath,
    ...args,
  ], { cwd, env, encoding: "utf8", input: "" })
}

test("T13a — CLI --json returns exit code 1 when a target install fails", (t) => {
  const root = tempDir(t, "wave3-cli-json-failed-")
  const env = isolatedEnv(root)
  const target = path.join(root, "target")
  const result = runCli(["install", "missing-pack", "--target", target, "--json"], env)
  const json = JSON.parse(result.stdout)

  assert.equal(json.status, "failed", `expected a failed operation; got ${JSON.stringify(json)}`)
  assert.equal(result.status, 1, `failed JSON operation must exit 1; stdout=${result.stdout}; stderr=${result.stderr}`)
})

test("T13b — CLI bridge refuses an unregistered workspace pack with executable content", (t) => {
  const root = tempDir(t, "wave3-bridge-untrusted-")
  const env = isolatedEnv(root)
  const workspace = path.join(root, "workspace")
  const outputDir = path.join(workspace, "generated-plugin")
  writePack(path.join(workspace, "packs", "demo"), {
    "agents/demo-agent.md": "---\ndescription: Demo agent\nmode: subagent\n---\nHelp with the demo.\n",
    "opencode.json": JSON.stringify({
      mcp: { servers: { local_cmd: { type: "local", command: ["echo", "hi"] } } },
    }),
  }, { name: "demo" })

  const result = runCli([
    "--workspace", workspace,
    "bridge",
    "--pack", "demo",
    "--output", outputDir,
    "--target", "claude",
    "--no-validate",
    "--no-register",
  ], env)

  assert.notEqual(result.status, 0, `untrusted executable pack must be refused; stdout=${result.stdout}; stderr=${result.stderr}`)
  assert.equal(fs.existsSync(outputDir), false, "refusing an untrusted pack must not create the bridge output")
})

test("T14 — Bridge modal generation preserves the configured Claude catch-all model mapping", async (t) => {
  const workspace = tempDir(t, "wave3-bridge-ui-model-map-")
  const prevXdgConfig = process.env.XDG_CONFIG_HOME
  const prevXdgCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CONFIG_HOME = path.join(workspace, "xdg-config")
  process.env.XDG_CACHE_HOME = path.join(workspace, "xdg-cache")

  writePack(path.join(workspace, "packs", "demo"), {
    "agents/demo-agent.md": "---\ndescription: Demo agent\nmode: subagent\n---\nHelp with the demo.\n",
  }, { name: "demo" })
  const configPath = translationConfigPath(workspace)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    ...DEFAULT_TRANSLATION_CONFIG,
    claude: {
      ...DEFAULT_TRANSLATION_CONFIG.claude,
      modelMap: { "*": "sonnet" },
      autoValidate: false,
      autoRegister: false,
    },
  }))

  const press = async (renderer: any, renderOnce: () => Promise<void>, name: string, sequence = name.length === 1 ? name : "") => {
    renderer.keyInput.emit("keypress", { name, sequence, ctrl: false, meta: false, shift: false })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 14))
    await renderOnce()
  }

  let rendererInstance: any
  try {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 30 })
    rendererInstance = renderer
    createRoot(renderer).render(React.createElement(App, {
      workspaceRoot: workspace,
      listShare: 2 / 3,
      reducedMotion: true,
    }))
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await renderOnce()
      if (captureCharFrame().includes("demo (1)")) break
    }

    await press(renderer, renderOnce, "b", "b")
    for (const char of "wave3-test") await press(renderer, renderOnce, char, char)
    await press(renderer, renderOnce, "tab", "\t") // name -> pack
    await press(renderer, renderOnce, "tab", "\t") // pack -> tiers
    await press(renderer, renderOnce, "return", "\r")

    const savedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"))
    assert.equal(savedConfig.claude.modelMap["*"], "sonnet")
  } finally {
    try { rendererInstance?.destroy() } catch {}
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevXdgCache
  }
})

test("T15 — CLI pack validate accepts the minimal contract example", (t) => {
  const root = tempDir(t, "wave3-pack-validate-")
  const minimalPackPath = path.join(repoRoot, "contract", "examples", "minimal-pack")
  const validation = validatePack(minimalPackPath)
  const result = runCli(["pack", "validate", "contract/examples/minimal-pack"], isolatedEnv(root))

  assert.equal(hasErrors(validation), false, `minimal pack has validation errors: ${JSON.stringify(validation.issues)}`)
  assert.equal(result.status, 0, `minimal pack CLI validation must exit 0; stdout=${result.stdout}; stderr=${result.stderr}`)
})
