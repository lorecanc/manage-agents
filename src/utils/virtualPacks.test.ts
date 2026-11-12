import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { tempDir } from "../../test/helpers.js"
import { findAgentFiles } from "./agents.js"
import { packDir } from "./catalog.js"
import { changeTarget, installChange, reconcileChange, targetStatus } from "./installer.js"
import { hasErrors, MANIFEST_FILE, validatePack } from "./packs.js"
import {
  describeConfiguredPackFlows,
  loadSourceAgents,
  overrideAgentsModel,
  reconcileTargetIfInstalled,
  saveUserPackCallers,
  saveUserPackFlow,
} from "./sourceCustomization.js"
import { addSource, discoverPacks, pullSource, saveSources, sourceRoot, type SourceRegistry } from "./sources.js"
import { derivePackSlug, initPackManifest, isVirtualPackRoot, validateVirtualPack, VIRTUAL_PACK_VERSION } from "./virtualPacks.js"

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url))
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

test("manifest-free .md folder: discovers loose agents, skips docs & symlinks, installs as virtual pack and routes IF/OR flows", { skip: process.platform === "win32" }, async (t) => {
  const base = tempDir(t, "virtual-pack-")
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const folder = path.join(base, "my-slides")
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, "README.md"), "# Documentation (not an agent)\n")
  fs.writeFileSync(path.join(folder, "notes.md"), "Plain notes without frontmatter.\n")
  fs.writeFileSync(path.join(folder, "slides-lead.md"), "---\ndescription: Lead orchestrator\nmode: primary\n---\nLead body.\n")
  // V1 frontmatter loose agent -> normalized to V2 on virtual install
  fs.writeFileSync(path.join(folder, "slides-writer.md"), "---\ndescription: Writer subagent\nmax_steps: 20\npermission:\n  bash: allow\n---\nWriter body.\n")
  const outside = path.join(base, "outside-secret.md")
  fs.writeFileSync(outside, "---\ndescription: secret\n---\nsecret\n")
  fs.symlinkSync(outside, path.join(folder, "escaped.md"))

  const slug = derivePackSlug("my-slides")
  assert.equal(slug, "my-slides")
  assert.equal(isVirtualPackRoot(folder), true)
  assert.equal(packDir(folder, "my-slides"), folder)

  const discovered = findAgentFiles(folder)
  assert.deepEqual(discovered.map(a => a.filename).sort(), ["slides-lead.md", "slides-writer.md"])
  assert.ok(discovered.every(a => a.category === "my-slides"))

  const validation = validateVirtualPack(folder)
  assert.equal(hasErrors(validation), false)
  assert.equal(validation.manifest?.version, VIRTUAL_PACK_VERSION)
  assert.deepEqual(validation.ids.agents, ["slides-lead", "slides-writer"])

  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  const src = addSource(registry, "my-slides", folder, { trusted: true })
  saveSources(registry, env)
  assert.equal(discoverPacks(src, env).candidates.length, 1)

  const target = fs.realpathSync(fs.mkdirSync(path.join(base, "target"), { recursive: true }) || path.join(base, "target"))
  const installRes = await changeTarget(target, "install", registry, installChange(registry, ["my-slides"], env), {
    env,
    confirm: async () => true,
  })
  assert.equal(installRes.status, "applied")
  const installedWriter = fs.readFileSync(path.join(target, "agents", "slides-writer.md"), "utf8")
  assert.match(installedWriter, /steps: 20/, "V1 max_steps normalized to V2 steps")

  // Configure IF/OR flow on the virtual pack without opencode-pack.json
  saveUserPackFlow(
    folder,
    "my-slides",
    {
      triggers: ["anthropic", "openai/gpt-5.4"],
      roles: { "slides-writer": "google/gemini-4#high" },
      tools: { bash: "deny" },
      permissions: {},
      delegations: { "slides-writer": "allow" },
    },
    { target, env },
  )
  const rec = await changeTarget(target, "reconcile", registry, reconcileChange, { env, confirm: async () => true })
  assert.equal(rec.status, "applied")
  const routerConfig = JSON.parse(fs.readFileSync(path.join(target, "plugins/manage-agents-router/routing.json"), "utf8"))
  assert.deepEqual(routerConfig.archetypes["my-slides"].callers, ["slides-lead"])
  assert.equal(routerConfig.archetypes["my-slides"].rules.length, 1)
  assert.deepEqual(routerConfig.archetypes["my-slides"].rules[0].triggers, ["anthropic", "openai/gpt-5.4"])
  assert.deepEqual(routerConfig.archetypes["my-slides"].rules[0].then.tools, { bash: "deny" })
  assert.deepEqual(targetStatus(target, registry, env).drift, [])
})

test("git source of plain .md files without opencode-pack.json supports overrides, IF/OR flows and install while keeping git cache clean", { skip: !hasGit }, async (t) => {
  const base = tempDir(t, "virtual-git-")
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const upstream = path.join(base, "raw-agents")
  fs.mkdirSync(upstream, { recursive: true })
  gitIn(upstream, "init", "--quiet", "--initial-branch=main")
  fs.writeFileSync(path.join(upstream, "orchestrator.md"), "---\ndescription: Primary orchestrator\nmode: primary\n---\nOrchestrator.\n")
  fs.writeFileSync(path.join(upstream, "helper.md"), "---\ndescription: Subagent helper\nmode: subagent\n---\nHelper.\n")
  gitIn(upstream, "add", "-A")
  gitIn(upstream, "commit", "--quiet", "-m", "init raw md repo")

  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  const source = addSource(registry, "user-raw-agents", `file://${upstream}`, { trusted: true }, { allowFileUrls: true })
  saveSources(registry, env)
  pullSource(source, env, { allowFileUrls: true, useGhAuth: false })
  const cacheRoot = sourceRoot(source, env)
  const target = fs.realpathSync(fs.mkdirSync(path.join(base, "target"), { recursive: true }) || path.join(base, "target"))

  const agents = loadSourceAgents(cacheRoot, { target, env })
  assert.equal(agents.length, 2)
  const lead = agents.find(a => a.filename === "orchestrator.md")!
  overrideAgentsModel(cacheRoot, [lead], "anthropic/claude-sonnet-4-5", ["anthropic/claude-sonnet-4-5"], { target, env })
  saveUserPackCallers(cacheRoot, "user-raw-agents", ["orchestrator"], { target, env, applySourceOverrides: true })
  saveUserPackFlow(
    cacheRoot,
    "user-raw-agents",
    {
      triggers: ["*"],
      roles: { helper: "openai/gpt-5-mini" },
      tools: { webfetch: "ask" },
      permissions: {},
      delegations: {},
    },
    { target, env, applySourceOverrides: true },
  )
  assert.equal(gitIn(cacheRoot, "status", "--porcelain"), "", "git cache stays completely untouched")

  const installRes = await changeTarget(target, "install", registry, installChange(registry, ["user-raw-agents"], env), {
    env,
    confirm: async () => true,
  })
  assert.equal(installRes.status, "applied")
  assert.match(fs.readFileSync(path.join(target, "agents", "orchestrator.md"), "utf8"), /model: anthropic\/claude-sonnet-4-5/)
  const flowView = describeConfiguredPackFlows(cacheRoot, "user-raw-agents", { target, env, applySourceOverrides: true })
  assert.equal(flowView?.flows.length, 1)
  const recOutcome = await reconcileTargetIfInstalled("models", { target, env })
  assert.equal(recOutcome.installed, true)
})

test("initPackManifest (and CLI pack init / models rule-set) turns a loose .md folder into a valid contract pack", (t) => {
  const base = tempDir(t, "pack-init-")
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const folder = path.join(base, "custom-pack")
  fs.mkdirSync(path.join(folder, "mode"), { recursive: true })
  fs.writeFileSync(path.join(folder, "mode", "planner.md"), "---\ndescription: Planner\n---\nPlan.\n")
  fs.writeFileSync(path.join(folder, "worker.md"), "---\ndescription: Worker\nmode: subagent\n---\nWork.\n")

  const res = initPackManifest(folder, { name: "custom-pack", version: "0.2.0", description: "Custom pack", organize: true })
  assert.equal(res.manifest.name, "custom-pack")
  assert.equal(res.movedAgents.length, 2)
  assert.ok(fs.existsSync(path.join(folder, MANIFEST_FILE)))
  assert.ok(fs.existsSync(path.join(folder, "agents", "planner.md")))
  assert.ok(fs.existsSync(path.join(folder, "agents", "worker.md")))
  assert.ok(!fs.existsSync(path.join(folder, "worker.md")))
  assert.equal(hasErrors(validatePack(folder)), false)
  assert.throws(() => initPackManifest(folder), /already exists/)

  // Exercise CLI `models callers` and `models rule-set`
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", path.join(REPO_ROOT, "src/index.tsx"), ...args], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    })
  const c1 = cli(["models", "callers", "custom-pack", "planner", "--no-reconcile"])
  assert.equal(c1.status, 0, c1.stderr)
  const c2 = cli([
    "models",
    "rule-set",
    "custom-pack",
    "anthropic,openai/gpt-5.4",
    "--model",
    "worker=google/gemini-4#high",
    "--tool",
    "bash=deny",
    "--delegate",
    "worker=allow",
    "--no-reconcile",
  ])
  assert.equal(c2.status, 0, c2.stderr)
  const c3 = cli(["models", "export-pack", "custom-pack", "--dir", folder])
  assert.equal(c3.status, 0, c3.stderr)
  assert.equal(hasErrors(validatePack(folder)), false)
})

test("security & contract guards: rejects flowDefaults on contract 1.0, --no-organize with loose agents, and symlinked agents/ or manifest", { skip: process.platform === "win32" }, (t) => {
  const base = tempDir(t, "virtual-guards-")
  const looseFolder = path.join(base, "loose")
  fs.mkdirSync(looseFolder, { recursive: true })
  fs.writeFileSync(path.join(looseFolder, "lead.md"), "---\ndescription: Lead\nmode: primary\n---\nLead.\n")

  assert.throws(() => initPackManifest(looseFolder, { organize: false }), /Cannot initialize opencode-pack\.json with --no-organize/)

  const escapeDir = path.join(base, "outside")
  fs.mkdirSync(escapeDir, { recursive: true })
  fs.symlinkSync(escapeDir, path.join(looseFolder, "agents"))
  assert.throws(() => initPackManifest(looseFolder, { organize: true }), /Refusing to write through symlinked directory/)
  fs.unlinkSync(path.join(looseFolder, "agents"))

  initPackManifest(looseFolder, { organize: true })
  // Contract 1.0 rejects flowDefaults
  const manifestFile = path.join(looseFolder, MANIFEST_FILE)
  const rawManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
  fs.writeFileSync(manifestFile, JSON.stringify({
    ...rawManifest,
    contract: "1.0",
    archetype: { callers: ["lead"], reference: "lead" },
    flowDefaults: [{ triggers: ["*"], then: { tools: { bash: "deny" } } }],
  }))
  assert.ok(validatePack(looseFolder).issues.some(issue => /"flowDefaults" requires contract "1\.1"/.test(issue.message)))
})
