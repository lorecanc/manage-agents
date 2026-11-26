import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { installVibeAgentProfiles, installVibePlugin, vibeAgentsRoot, vibePluginsRoot } from "./vibePluginInstall.js"

/** Build a minimal plugin source tree inside a temp directory. */
function makePluginSource(parent: string, name: string, agentBody = "Do the work."): string {
  const source = fs.mkdtempSync(path.join(parent, `vibe-install-src-${name}-`))
  fs.writeFileSync(path.join(source, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name }, null, 2))
  fs.mkdirSync(path.join(source, "ai.mistral.vibe", "agents"), { recursive: true })
  fs.writeFileSync(path.join(source, "ai.mistral.vibe", "agents", "worker.toml"), agentBody)
  fs.mkdirSync(path.join(source, "skills", "run"), { recursive: true })
  fs.writeFileSync(path.join(source, "skills", "run", "SKILL.md"), "---\nname: run\ndescription: run it\n---\n\nRun.")
  return source
}

/** A temp VIBE_HOME that isolates the install from the real user config. */
function tempVibeHome(): { env: NodeJS.ProcessEnv; root: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-plugins-home-"))
  return { env: { ...process.env, VIBE_HOME: home }, root: path.join(home, "plugins") }
}

test("vibePluginsRoot prefers VIBE_HOME and falls back to ~/.vibe/plugins", () => {
  assert.equal(vibePluginsRoot({ VIBE_HOME: "/tmp/vibe-home" }), path.join("/tmp/vibe-home", "plugins"))
  const fallback = vibePluginsRoot({})
  assert.equal(fallback, path.join(os.homedir(), ".vibe", "plugins"))
})

test("installVibePlugin mirrors the plugin into the Vibe plugins root", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-install-"))
  const { env, root } = tempVibeHome()
  const source = makePluginSource(parent, "acme-pack")
  const result = installVibePlugin(source, "acme-pack", env)
  assert.equal(result.path, path.join(root, "acme-pack"))
  assert.equal(result.changed, true)
  assert.equal(result.warnings.length, 0)
  assert.equal(fs.readFileSync(path.join(result.path, "plugin.json"), "utf-8"), fs.readFileSync(path.join(source, "plugin.json"), "utf-8"))
  assert.ok(fs.statSync(path.join(result.path, "ai.mistral.vibe", "agents", "worker.toml")).isFile())
  assert.ok(fs.statSync(path.join(result.path, "skills", "run", "SKILL.md")).isFile())
})

test("installVibePlugin is idempotent when the plugin is unchanged", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-install-"))
  const { env } = tempVibeHome()
  const source = makePluginSource(parent, "acme-pack")
  const first = installVibePlugin(source, "acme-pack", env)
  const second = installVibePlugin(source, "acme-pack", env)
  assert.equal(second.changed, false)
  assert.equal(second.path, first.path)
  assert.equal(second.warnings.length, 0)
})

test("installVibePlugin rewrites changed files and prunes stale entries", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-install-"))
  const { env, root } = tempVibeHome()
  const source = makePluginSource(parent, "acme-pack", "Original body.")
  installVibePlugin(source, "acme-pack", env)
  const installed = path.join(root, "acme-pack")
  fs.writeFileSync(path.join(installed, "stale.txt"), "obsolete")
  // Regenerate: the agent changed and the plugin no longer has skills.
  const next = makePluginSource(parent, "acme-pack", "Rewritten body.")
  fs.rmSync(path.join(next, "skills"), { recursive: true })
  const result = installVibePlugin(next, "acme-pack", env)
  assert.equal(result.changed, true)
  assert.match(result.warnings.join("\n"), /pruned stale 'stale\.txt'/)
  assert.match(result.warnings.join("\n"), /pruned stale 'skills'/)
  assert.equal(fs.readFileSync(path.join(installed, "ai.mistral.vibe", "agents", "worker.toml"), "utf-8"), "Rewritten body.")
  assert.equal(fs.existsSync(path.join(installed, "stale.txt")), false)
  assert.equal(fs.existsSync(path.join(installed, "skills")), false)
})

test("installVibePlugin prunes a symlink planted in the plugins root", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-install-"))
  const { env, root } = tempVibeHome()
  const source = makePluginSource(parent, "acme-pack")
  fs.mkdirSync(root, { recursive: true })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-outside-"))
  try {
    fs.symlinkSync(outside, path.join(root, "acme-pack"), "dir")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return // no symlink support here
    throw error
  }
  const result = installVibePlugin(source, "acme-pack", env)
  assert.equal(result.changed, true)
  assert.equal(fs.lstatSync(path.join(root, "acme-pack")).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(path.join(root, "acme-pack", "skills", "run", "SKILL.md"), "utf-8").includes("Run."), true)
})

test("installVibePlugin refuses a symlinked source tree", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-install-"))
  const { env } = tempVibeHome()
  const source = makePluginSource(parent, "acme-pack")
  const link = path.join(parent, "acme-link")
  try {
    fs.symlinkSync(source, link, "dir")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return // no symlink support here
    throw error
  }
  assert.throws(() => installVibePlugin(link, "acme-pack", env), /must be a real directory/)
})

test("installVibePlugin refuses a source without a plugin.json manifest", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-install-"))
  const { env } = tempVibeHome()
  const source = fs.mkdtempSync(path.join(parent, "vibe-install-src-plain-"))
  assert.throws(() => installVibePlugin(source, "acme-pack", env), /must contain a plugin\.json manifest/)
})

test("installVibePlugin refuses a manifest whose name does not match the install name", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-install-"))
  const { env } = tempVibeHome()
  const source = makePluginSource(parent, "acme-pack")
  assert.throws(() => installVibePlugin(source, "other-pack", env), /declares name "acme-pack" but the install name is "other-pack"/)
})

/** A generated main agent profile body, as the bridge writes it. */
function profileBody(pluginName: string, agentName: string, instructions = "Lead the work."): string {
  return [
    `# Generated by manage-agents — OpenCode to Mistral Vibe agent profile bridge (${pluginName}). Do not edit.`,
    `display_name = "${agentName}"`,
    `description = "Translated agent ${agentName}"`,
    `instructions = ${JSON.stringify(instructions)}`,
    ""
  ].join("\n")
}

/** The agents root that belongs to a tempVibeHome env. */
function agentsRootOf(home: string): string {
  return path.join(home, "agents")
}

test("installVibePlugin refuses an invalid plugin name", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-install-"))
  const { env } = tempVibeHome()
  const source = makePluginSource(parent, "acme-pack")
  assert.throws(() => installVibePlugin(source, "../escape", env), /Invalid Vibe plugin name/)
})

test("vibeAgentsRoot prefers VIBE_HOME and falls back to ~/.vibe/agents", () => {
  assert.equal(vibeAgentsRoot({ VIBE_HOME: "/tmp/vibe-home" }), path.join("/tmp/vibe-home", "agents"))
  const fallback = vibeAgentsRoot({})
  assert.equal(fallback, path.join(os.homedir(), ".vibe", "agents"))
})

test("installVibeAgentProfiles mirrors generated profiles into the agents root", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-"))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-home-"))
  const env = { ...process.env, VIBE_HOME: home }
  const plugin = makePluginSource(parent, "acme-pack")
  fs.mkdirSync(path.join(plugin, "agent-profiles"))
  fs.writeFileSync(path.join(plugin, "agent-profiles", "acme-pack-lead.toml"), profileBody("acme-pack", "Lead"))
  const result = installVibeAgentProfiles(plugin, "acme-pack", env)
  assert.equal(result.path, agentsRootOf(home))
  assert.deepEqual(result.installed, ["acme-pack-lead.toml"])
  assert.equal(result.changed, true)
  assert.equal(result.warnings.length, 0)
  assert.equal(fs.readFileSync(path.join(agentsRootOf(home), "acme-pack-lead.toml"), "utf-8"), profileBody("acme-pack", "Lead"))
})

test("installVibeAgentProfiles is idempotent and prunes only its own stale profiles", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-"))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-home-"))
  const env = { ...process.env, VIBE_HOME: home }
  const plugin = makePluginSource(parent, "acme-pack")
  fs.mkdirSync(path.join(plugin, "agent-profiles"))
  fs.writeFileSync(path.join(plugin, "agent-profiles", "acme-pack-lead.toml"), profileBody("acme-pack", "Lead"))
  installVibeAgentProfiles(plugin, "acme-pack", env)
  const root = agentsRootOf(home)
  // A stale generated profile, a hand-edited file that only looks generated, a user profile and another plugin's profile.
  fs.writeFileSync(path.join(root, "acme-pack-old.toml"), profileBody("acme-pack", "Old"))
  fs.writeFileSync(path.join(root, "acme-pack-fake.toml"), "# Generated by manage-agents lookalike\ninstructions = \"not ours\"\n")
  fs.writeFileSync(path.join(root, "my-own.toml"), "instructions = \"mine\"\n")
  fs.writeFileSync(path.join(root, "other-pack-lead.toml"), profileBody("other-pack", "Lead"))
  const second = installVibeAgentProfiles(plugin, "acme-pack", env)
  assert.equal(second.changed, true)
  assert.match(second.warnings.join("\n"), /pruned stale agent profile 'acme-pack-old\.toml'/)
  assert.equal(fs.existsSync(path.join(root, "acme-pack-old.toml")), false)
  assert.equal(fs.existsSync(path.join(root, "acme-pack-fake.toml")), true)
  assert.equal(fs.existsSync(path.join(root, "my-own.toml")), true)
  assert.equal(fs.existsSync(path.join(root, "other-pack-lead.toml")), true)
  const third = installVibeAgentProfiles(plugin, "acme-pack", env)
  assert.equal(third.changed, false)
  assert.deepEqual(third.installed, ["acme-pack-lead.toml"])
})

test("installVibeAgentProfiles replaces a symlinked target and refuses symlinked sources", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-"))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-home-"))
  const env = { ...process.env, VIBE_HOME: home }
  const plugin = makePluginSource(parent, "acme-pack")
  fs.mkdirSync(path.join(plugin, "agent-profiles"))
  fs.writeFileSync(path.join(plugin, "agent-profiles", "acme-pack-lead.toml"), profileBody("acme-pack", "Lead"))
  fs.mkdirSync(agentsRootOf(home), { recursive: true })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-outside-"))
  try {
    fs.symlinkSync(path.join(outside, "lead.toml"), path.join(agentsRootOf(home), "acme-pack-lead.toml"), "file")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return // no symlink support here
    throw error
  }
  const result = installVibeAgentProfiles(plugin, "acme-pack", env)
  assert.equal(result.changed, true)
  assert.equal(fs.lstatSync(path.join(agentsRootOf(home), "acme-pack-lead.toml")).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(path.join(agentsRootOf(home), "acme-pack-lead.toml"), "utf-8"), profileBody("acme-pack", "Lead"))
  // A symlinked source profile is refused outright.
  const linked = makePluginSource(parent, "acme-pack")
  fs.mkdirSync(path.join(linked, "agent-profiles"))
  fs.symlinkSync(path.join(plugin, "agent-profiles", "acme-pack-lead.toml"), path.join(linked, "agent-profiles", "acme-pack-lead.toml"), "file")
  assert.throws(() => installVibeAgentProfiles(linked, "acme-pack", env), /must not be a symlink/)
})

test("installVibeAgentProfiles without an agent-profiles directory is a no-op", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-"))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-home-"))
  const env = { ...process.env, VIBE_HOME: home }
  const plugin = makePluginSource(parent, "acme-pack")
  const result = installVibeAgentProfiles(plugin, "acme-pack", env)
  assert.equal(result.path, agentsRootOf(home))
  assert.equal(result.changed, false)
  assert.deepEqual(result.installed, [])
  assert.equal(fs.existsSync(agentsRootOf(home)), false)
})

test("installVibeAgentProfiles refuses an invalid plugin name", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-"))
  const { env } = (() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-profiles-home-"))
    return { env: { ...process.env, VIBE_HOME: home } }
  })()
  const plugin = makePluginSource(parent, "acme-pack")
  assert.throws(() => installVibeAgentProfiles(plugin, "../escape", env), /Invalid Vibe plugin name/)
})
