import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { tempDir, writePack } from "../../test/helpers.js"
import { bridgePack } from "./bridgeWorkspace.js"
import { DEFAULT_TRANSLATION_CONFIG } from "./translationConfig.js"
import { changeTarget, installChange, type ChangeOptions } from "./installer.js"
import { addSource, type SourceRegistry } from "./sources.js"
import { resolveReleaseTrustPolicy } from "./selfUpdate.js"

test("T10 — installer refuses symlinked state and agents directories", async (t) => {
  const root = tempDir(t, "wave2-installer-symlink-")
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  }
  const source = path.join(root, "catalog")
  const packDir = path.join(source, "demo")
  writePack(packDir, {
    "agents/demo-helper.md": "---\ndescription: Demo helper\nmode: subagent\n---\nHelp with the demo.\n",
  }, { name: "demo" })

  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  addSource(registry, "main", source, { trusted: true })
  const options: ChangeOptions = { env, confirm: async () => true }
  const install = async (target: string): Promise<string> => {
    try {
      return (await changeTarget(target, "install", registry, installChange(registry, ["demo"], env), options)).status
    } catch {
      return "threw"
    }
  }

  const target = path.join(root, "target-state-link")
  const outside = path.join(root, "outside-state")
  fs.mkdirSync(target)
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(target, ".manage-agents"), "dir")

  const stateLinkStatus = await install(target)

  const target2 = path.join(root, "target-agents-link")
  const outside2 = path.join(root, "outside-agents")
  fs.mkdirSync(target2)
  fs.mkdirSync(outside2)
  fs.symlinkSync(outside2, path.join(target2, "agents"), "dir")

  const agentsLinkStatus = await install(target2)

  assert.deepEqual([
    stateLinkStatus !== "applied",
    fs.readdirSync(outside),
    agentsLinkStatus !== "applied",
    fs.readdirSync(outside2),
  ], [true, [], true, []], "installer must refuse both symlinked destinations without writing through them")
})

test("T11 — bridgePack refuses an untrusted pack with executable local MCP configuration", (t) => {
  const root = tempDir(t, "wave2-bridge-untrusted-")
  const outputRoot = tempDir(t, "wave2-bridge-output-")
  const outputDir = path.join(outputRoot, "demo-plugin")
  writePack(path.join(root, "packs", "demo"), {
    "agents/demo-agent.md": "---\ndescription: Demo agent\nmode: subagent\n---\nHelp with the demo.\n",
    "opencode.json": JSON.stringify({
      mcp: { servers: { local_cmd: { type: "local", command: ["echo", "run"] } } },
    }),
  }, { name: "demo" })

  let refusesUntrustedPack = false
  try {
    assert.throws(() => bridgePack({
      workspaceRoot: root,
      pack: "demo",
      target: "claude",
      outputDir,
      config: DEFAULT_TRANSLATION_CONFIG,
      pluginName: "demo",
      prefix: "demo-",
      ...({ trusted: false } as Record<string, unknown>),
    }))
    refusesUntrustedPack = true
  } catch {
    // assert.throws reports a failure when bridgePack unexpectedly returns normally.
  }
  assert.deepEqual([refusesUntrustedPack, fs.existsSync(outputDir)], [true, false])
})

test("T12 — release trust policy rejects unsigned releases when no Ed25519 key is configured", (t) => {
  const engineRoot = tempDir(t, "wave2-release-trust-")
  fs.writeFileSync(path.join(engineRoot, "package.json"), JSON.stringify({
    repository: { type: "git", url: "https://github.com/lorecanc/manage-agents.git" },
  }))

  assert.throws(
    () => resolveReleaseTrustPolicy(engineRoot, { env: {} }),
    /signature|Ed25519|unsigned/i,
  )
})
