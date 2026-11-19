import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { tempDir, writePack } from "../../test/helpers.js"
import { applySafetyPreset, inspectTuningTargets, updateAgentParams, updateAgentsColor } from "./agents.js"
import { changeTarget, installChange } from "./installer.js"
import { addSource, pullSource, saveSources, sourceRoot, type SourceRegistry } from "./sources.js"
import {
  describeSourceArchetype,
  loadSourceAgents,
  overrideAgentsModel,
  reconcileTargetIfInstalled,
  runWithOverrideWriter,
  saveSourceArchetypeRouting,
} from "./sourceCustomization.js"
import { loadOverrideSettings, loadRoutingSettings } from "./userSettings.js"

const hasGit = spawnSync("git", ["--version"]).status === 0

function gitIn(cwd: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  )
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test("git source customizations write overrides.json and routing.json, reconcile target, and keep git cache clean", { skip: !hasGit }, async (t) => {
  const base = tempDir(t, "source-custom-")
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const upstream = path.join(base, "upstream")
  fs.mkdirSync(upstream, { recursive: true })
  gitIn(upstream, "init", "--quiet", "--initial-branch=main")
  writePack(
    path.join(upstream, "packs", "flow"),
    {
      "agents/flow-build.md": "---\nmode: primary\nsteps: 25\n---\nbuild\n",
      "agents/flow-explore.md": "---\ndescription: explore\nmode: subagent\npermission:\n  bash: deny\n---\nexplore\n",
    },
    {
      name: "flow",
      archetype: { callers: ["flow-build"], reference: "flow-build" },
      routingDefaults: { mistral: { "flow-explore": "mistral/small" } },
    },
  )
  gitIn(upstream, "add", "-A")
  gitIn(upstream, "commit", "--quiet", "-m", "initial")

  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  const source = addSource(registry, "github-flow", `file://${upstream}`, { trusted: true }, { allowFileUrls: true })
  saveSources(registry, env)
  pullSource(source, env, { allowFileUrls: true, useGhAuth: false })
  const cacheRoot = sourceRoot(source, env)
  const target = fs.realpathSync(fs.mkdirSync(path.join(base, "target"), { recursive: true }) || path.join(base, "target"))

  const installRes = await changeTarget(target, "install", registry, installChange(registry, ["github-flow/flow"], env), {
    env,
    confirm: async () => true,
  })
  assert.equal(installRes.status, "applied")

  // 1. Model, color, params, safety preset via overrides
  const initialAgents = loadSourceAgents(cacheRoot, { target, env })
  const build = initialAgents.find(a => a.filename === "flow-build.md")!
  const explore = initialAgents.find(a => a.filename === "flow-explore.md")!
  overrideAgentsModel(cacheRoot, [build], "anthropic/claude-opus-4-6", ["anthropic/claude-opus-4-6"], { target, env })
  runWithOverrideWriter(cacheRoot, writer => {
    updateAgentsColor([build], "#FF5500", writer)
    updateAgentParams([build], { steps: 60 }, writer)
    applySafetyPreset([build, explore], "safe_builder", writer)
  }, { target, env })

  // Git cache must remain 100% untouched
  assert.equal(gitIn(cacheRoot, "status", "--porcelain"), "")

  // Reloading through loadSourceAgents reflects the overrides (including V1 base agent flow-explore)
  const reloaded = loadSourceAgents(cacheRoot, { target, env })
  const reloadedBuild = reloaded.find(a => a.filename === "flow-build.md")!
  const reloadedExplore = reloaded.find(a => a.filename === "flow-explore.md")!
  assert.equal(reloadedBuild.model, "anthropic/claude-opus-4-6")
  assert.equal(reloadedBuild.frontmatter.color, "#FF5500")
  assert.equal(inspectTuningTargets([reloadedBuild]).steps.value, "60")
  assert.equal(reloadedExplore.frontmatter.permission?.edit, "allow")

  // Reconcile propagates overrides into the installed OpenCode target
  const rec1 = await reconcileTargetIfInstalled("override", { target, env })
  assert.equal(rec1.installed, true)
  assert.equal(rec1.result?.status, "applied")
  const installedBuild = fs.readFileSync(path.join(target, "agents", "flow-build.md"), "utf8")
  assert.match(installedBuild, /model: anthropic\/claude-opus-4-6/)
  assert.match(installedBuild, /steps: 60/)

  // Resetting steps back to pack default (25) removes steps from overrides.json while keeping model & color
  runWithOverrideWriter(cacheRoot, writer => {
    const cleanBuild = loadSourceAgents(cacheRoot, { target, env }).find(a => a.filename === "flow-build.md")!
    updateAgentParams([cleanBuild], { steps: 25 }, writer)
  }, { target, env })
  const storedPatch = loadOverrideSettings(env).targets[target]?.flow?.agents?.["flow-build"]
  assert.equal(storedPatch?.steps, undefined)
  assert.equal(storedPatch?.model, "anthropic/claude-opus-4-6")

  // 2. Archetype routing via routing.json without touching opencode-pack.json
  saveSourceArchetypeRouting(cacheRoot, "flow", "openai", { explore: "openai/gpt-5-mini" }, { target, env })
  assert.equal(gitIn(cacheRoot, "status", "--porcelain"), "")
  const archView = describeSourceArchetype(cacheRoot, "flow", { target, env })
  assert.deepEqual(archView?.configs.openai, { explore: "openai/gpt-5-mini" })
  assert.deepEqual(archView?.configs.mistral, { explore: "mistral/small" })

  const rec2 = await reconcileTargetIfInstalled("models", { target, env })
  assert.equal(rec2.result?.status, "applied")
  const runtimeRouting = JSON.parse(fs.readFileSync(path.join(target, "plugins/manage-agents-router/routing.json"), "utf8"))
  assert.equal(runtimeRouting.archetypes.flow.routes.openai["flow-explore"], "openai/gpt-5-mini")
  assert.ok(loadRoutingSettings(env).targets[target]?.flow?.openai)
})

test("git source model unpin writes a null model override and keeps the git cache clean", { skip: !hasGit }, async (t) => {
  const base = tempDir(t, "source-unpin-")
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const upstream = path.join(base, "upstream")
  fs.mkdirSync(upstream, { recursive: true })
  gitIn(upstream, "init", "--quiet", "--initial-branch=main")
  writePack(
    path.join(upstream, "packs", "flow"),
    {
      "agents/flow-build.md": "---\nmode: primary\nmodel: old/model\n---\nbuild\n",
    },
    {
      name: "flow",
      archetype: { callers: ["flow-build"], reference: "flow-build" },
    },
  )
  gitIn(upstream, "add", "-A")
  gitIn(upstream, "commit", "--quiet", "-m", "initial")

  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  const source = addSource(registry, "github-flow", `file://${upstream}`, { trusted: true }, { allowFileUrls: true })
  saveSources(registry, env)
  pullSource(source, env, { allowFileUrls: true, useGhAuth: false })
  const cacheRoot = sourceRoot(source, env)
  const target = fs.realpathSync(fs.mkdirSync(path.join(base, "target"), { recursive: true }) || path.join(base, "target"))

  const installRes = await changeTarget(target, "install", registry, installChange(registry, ["github-flow/flow"], env), {
    env,
    confirm: async () => true,
  })
  assert.equal(installRes.status, "applied")

  const build = loadSourceAgents(cacheRoot, { target, env }).find(a => a.filename === "flow-build.md")!
  assert.equal(build.model, "old/model")

  overrideAgentsModel(cacheRoot, [build], "", [], { target, env }, true)

  // Git cache must remain 100% untouched
  assert.equal(gitIn(cacheRoot, "status", "--porcelain"), "")

  // Unpin stores a null model patch in the target-scoped overrides
  const patch = loadOverrideSettings(env).targets[target]?.flow?.agents?.["flow-build"]
  assert.equal(patch?.model, null)

  // Reloading the source agent no longer exposes a model key
  const unpinned = loadSourceAgents(cacheRoot, { target, env }).find(a => a.filename === "flow-build.md")!
  assert.equal(Object.prototype.hasOwnProperty.call(unpinned.frontmatter, "model"), false)

  // Reconcile propagates the unpin into the installed OpenCode target
  const rec = await reconcileTargetIfInstalled("override", { target, env })
  assert.equal(rec.installed, true)
  assert.equal(rec.result?.status, "applied")
  const installedBuild = fs.readFileSync(path.join(target, "agents", "flow-build.md"), "utf8")
  assert.doesNotMatch(installedBuild, /model:/)
})
