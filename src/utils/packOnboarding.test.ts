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
import { tempDir } from "../../test/helpers.js"
import { changeTarget, installChange } from "./installer.js"
import {
  applyPackOnboarding,
  bumpPackVersion,
  cloneGitSourceForOnboarding,
  fixPackDoctor,
  inspectOnboardingCandidate,
  inspectPackDoctor,
  resolveEditablePackDir,
  scaffoldPackResource,
} from "./packOnboarding.js"
import { hasErrors, MANIFEST_FILE, validatePack } from "./packs.js"
import { addSource, discoverPacks, pullSource, saveSources, sourceRoot, type SourceRegistry } from "./sources.js"
import { isVirtualPackRoot, validateVirtualPack } from "./virtualPacks.js"

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

test("virtual discovery & onboarding: promotes .opencode/, singular dirs, V1 frontmatter, user config keys, non-native files and authoring kit", async (t) => {
  const base = tempDir(t, "onboard-opencode-")
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const repo = path.join(base, "team-review")
  fs.mkdirSync(path.join(repo, ".opencode", "agents"), { recursive: true })
  fs.mkdirSync(path.join(repo, ".opencode", "skills", "style-guide"), { recursive: true })
  fs.mkdirSync(path.join(repo, ".opencode", "plans"), { recursive: true })
  fs.mkdirSync(path.join(repo, "command"), { recursive: true })
  fs.mkdirSync(path.join(repo, "resources"), { recursive: true })

  // Plan file inside .opencode/plans/ must NOT be mistaken for an agent
  fs.writeFileSync(path.join(repo, ".opencode", "plans", "draft.md"), "---\ndescription: Draft plan\n---\nNot an agent.\n")
  fs.writeFileSync(
    path.join(repo, ".opencode", "agents", "review-lead.md"),
    "---\ndescription: Coordinates reviews\nmode: primary\n---\nLead prompt.\n",
  )
  fs.writeFileSync(
    path.join(repo, ".opencode", "agents", "security-auditor.md"),
    "---\ndescription: Checks security\nmode: subagent\nmax_steps: 12\npermission:\n  edit: deny\n---\nAudit prompt.\n",
  )
  fs.writeFileSync(
    path.join(repo, ".opencode", "skills", "style-guide", "SKILL.md"),
    "---\nname: style-guide\ndescription: Team conventions\n---\nFollow conventions.\n",
  )
  fs.writeFileSync(
    path.join(repo, "command", "ship-check.md"),
    "---\ndescription: Run pre-ship checklist\n---\nCheck $ARGUMENTS\n",
  )
  fs.writeFileSync(path.join(repo, "resources", "rubric.md"), "# Rubric\n")
  fs.writeFileSync(
    path.join(repo, ".opencode", "opencode.jsonc"),
    `{
      // Project config with mixed user + pack keys and .opencode skill reference
      "model": "anthropic/claude-sonnet-4-5",
      "default_agent": "review-lead",
      "skills": [".opencode/skills/style-guide"],
      "experimental": { "todo": true }
    }\n`,
  )

  // Virtual pack works before onboarding
  assert.equal(isVirtualPackRoot(repo), true)
  const virtualVal = validateVirtualPack(repo)
  assert.equal(hasErrors(virtualVal), false)
  assert.deepEqual(virtualVal.ids.agents, ["review-lead", "security-auditor"])
  assert.deepEqual(virtualVal.ids.commands, ["ship-check"])
  assert.deepEqual(virtualVal.ids.skills, ["style-guide"])

  const inspection = inspectOnboardingCandidate(repo)
  assert.equal(inspection.recommendedLayout, "root")
  assert.equal(inspection.hasDotOpencode, true)
  assert.equal(inspection.v1AgentCount, 1)
  assert.deepEqual(inspection.configUserKeys.sort(), ["default_agent", "model"])
  assert.deepEqual(inspection.configPackKeys.sort(), ["experimental", "skills"])
  assert.deepEqual(inspection.inferredArchetype, { callers: ["review-lead"], reference: "review-lead" })

  const result = applyPackOnboarding(repo, {
    name: "team-review",
    version: "0.1.0",
    description: "Team review workflow pack",
    layout: "auto",
    authoringKit: true,
  })

  assert.equal(result.layout, "root")
  assert.equal(result.manifest.contract, "1.1")
  assert.deepEqual(result.manifest.archetype, { callers: ["review-lead"], reference: "review-lead" })
  assert.deepEqual(result.strippedConfigKeys.sort(), ["default_agent", "model"])
  assert.equal(hasErrors(result.validation), false)
  assert.equal(result.validation.issues.length, 0)
  const userBackupPath = path.join(repo, ".opencode", "opencode.user-backup.json")
  assert.ok(fs.existsSync(userBackupPath), "mixed config preserves stripped user keys in backup")
  assert.equal(JSON.parse(fs.readFileSync(userBackupPath, "utf8")).model, "anthropic/claude-sonnet-4-5")
  assert.match(fs.readFileSync(path.join(repo, ".opencode", ".gitignore"), "utf8"), /opencode\.user-backup\.json/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, "opencode.json"), "utf8")).skills, ["./skills/style-guide"])

  // Verify organized paths & V2 upgrade
  assert.ok(fs.existsSync(path.join(repo, "agents", "review-lead.md")))
  const auditorText = fs.readFileSync(path.join(repo, "agents", "security-auditor.md"), "utf8")
  assert.match(auditorText, /steps: 12/)
  assert.doesNotMatch(auditorText, /max_steps:/)
  assert.ok(fs.existsSync(path.join(repo, "commands", "ship-check.md")))
  assert.ok(fs.existsSync(path.join(repo, "skills", "style-guide", "SKILL.md")))
  assert.ok(fs.existsSync(path.join(repo, "resources", "team-review", "rubric.md")))
  assert.ok(fs.existsSync(path.join(repo, ".opencode", "skills", "opencode-pack-authoring", "SKILL.md")))
  assert.ok(fs.existsSync(path.join(repo, ".github", "workflows", "validate-pack.yml")))
  assert.ok(fs.existsSync(path.join(repo, "README.md")))

  // Installing the onboarded pack never leaks `.opencode/` or `.github/` into the OpenCode target
  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  addSource(registry, "team-review", repo, { trusted: true })
  saveSources(registry, env)
  const target = fs.realpathSync(fs.mkdirSync(path.join(base, "target"), { recursive: true }) || path.join(base, "target"))
  const installRes = await changeTarget(target, "install", registry, installChange(registry, ["team-review"], env), {
    env,
    confirm: async () => true,
  })
  assert.equal(installRes.status, "applied")
  assert.ok(fs.existsSync(path.join(target, "agents", "review-lead.md")))
  assert.ok(!fs.existsSync(path.join(target, ".opencode")))
  assert.ok(!fs.existsSync(path.join(target, ".github")))
})

test("mixed application repository: auto-selects packs/<name>/ without touching app files", (t) => {
  const base = tempDir(t, "onboard-mixed-")
  const appRepo = path.join(base, "webapp")
  fs.mkdirSync(path.join(appRepo, "src"), { recursive: true })
  fs.mkdirSync(path.join(appRepo, ".opencode", "agents"), { recursive: true })
  fs.writeFileSync(path.join(appRepo, "package.json"), '{"name":"webapp","private":true}\n')
  fs.writeFileSync(path.join(appRepo, "src", "main.ts"), "export const ok = true\n")
  fs.writeFileSync(path.join(appRepo, ".opencode", "agents", "ui-critic.md"), "---\ndescription: UI critic\nmode: subagent\n---\nCheck UI.\n")

  const inspection = inspectOnboardingCandidate(appRepo)
  assert.equal(inspection.recommendedLayout, "subpack")
  assert.ok(inspection.mixedProjectFiles.includes("package.json"))
  assert.throws(
    () => applyPackOnboarding(appRepo, { name: "webapp-agents", layout: "root" }),
    /Cannot onboard mixed project repository at root/,
  )
  assert.ok(fs.existsSync(path.join(appRepo, "src", "main.ts")), "root guard fails before touching app files")

  const res = applyPackOnboarding(appRepo, { name: "webapp-agents", layout: "auto", authoringKit: true })
  assert.equal(res.layout, "subpack")
  assert.equal(res.packDir, path.join(fs.realpathSync(appRepo), "packs", "webapp-agents"))
  assert.equal(hasErrors(res.validation), false)
  assert.ok(fs.existsSync(path.join(appRepo, "package.json")))
  assert.ok(fs.existsSync(path.join(appRepo, "src", "main.ts")))
  assert.ok(fs.existsSync(path.join(appRepo, "packs", "webapp-agents", MANIFEST_FILE)))
  assert.ok(fs.existsSync(path.join(appRepo, "packs", "webapp-agents", "agents", "ui-critic.md")))

  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  const src = addSource(registry, "webapp", appRepo, { trusted: true })
  const discovered = discoverPacks(src)
  assert.equal(discovered.candidates.length, 1)
  assert.equal(discovered.candidates[0].manifest.name, "webapp-agents")
  assert.equal(resolveEditablePackDir(appRepo), path.join(fs.realpathSync(appRepo), "packs", "webapp-agents"))

  if (process.platform !== "win32") {
    const outsidePack = path.join(base, "outside-pack")
    fs.mkdirSync(outsidePack, { recursive: true })
    fs.writeFileSync(path.join(outsidePack, MANIFEST_FILE), '{"contract":"1.1","name":"evil","version":"0.1.0","description":"x"}')
    fs.symlinkSync(outsidePack, path.join(appRepo, "packs", "evil"))
    assert.equal(resolveEditablePackDir(appRepo, "evil"), null)
  }
})

test("mixed-repo onboarding moves .opencode AGENTS.md into the subpack and preserves host instructions", (t) => {
  const base = tempDir(t, "onboard-mixed-agents-")
  const repo = path.join(base, "webapp")
  fs.mkdirSync(path.join(repo, ".opencode", "agents"), { recursive: true })
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"webapp","private":true}\n')
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Host repository instructions\n")
  fs.writeFileSync(path.join(repo, ".opencode", "AGENTS.md"), "# Pack instructions\n")
  fs.writeFileSync(
    path.join(repo, ".opencode", "agents", "demo-helper.md"),
    "---\ndescription: Demo helper\nmode: subagent\n---\nHelp with the demo.\n",
  )
  fs.writeFileSync(
    path.join(repo, ".opencode", "opencode.json"),
    JSON.stringify({ instructions: [".opencode/AGENTS.md", "AGENTS.md"] }, null, 2),
  )

  const inspection = inspectOnboardingCandidate(repo)
  assert.equal(inspection.recommendedLayout, "subpack")
  assert.equal(inspection.agentsMdSourceRel, ".opencode/AGENTS.md")
  assert.equal(inspection.configSourceRel, ".opencode/opencode.json")

  const result = applyPackOnboarding(repo, { name: "webapp-agents", layout: "subpack" })
  const packDir = path.join(repo, "packs", "webapp-agents")
  assert.equal(result.packDir, fs.realpathSync(packDir), "packDir is realpath-resolved like every editable pack dir")
  assert.equal(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), "# Host repository instructions\n")
  assert.equal(fs.readFileSync(path.join(packDir, "AGENTS.md"), "utf8"), "# Pack instructions\n")
  assert.equal(fs.existsSync(path.join(repo, ".opencode", "AGENTS.md")), false)
  assert.deepEqual(result.movedResources.find(item => item.from === ".opencode/AGENTS.md"), {
    from: ".opencode/AGENTS.md",
    to: "packs/webapp-agents/AGENTS.md",
  })

  const packConfig = JSON.parse(fs.readFileSync(path.join(packDir, "opencode.json"), "utf8"))
  assert.deepEqual(packConfig.instructions, ["AGENTS.md", "AGENTS.md"])
  const validation = validatePack(result.packDir)
  assert.equal(validation.issues.filter(issue => issue.level === "error").length, 0)
  assert.equal(hasErrors(validation), false)
})

test("subpack inspection omits a host-only root AGENTS.md from pack content", (t) => {
  const base = tempDir(t, "onboard-host-agents-")
  const repo = path.join(base, "webapp")
  fs.mkdirSync(path.join(repo, ".opencode", "agents"), { recursive: true })
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"webapp","private":true}\n')
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Host repository instructions\n")
  fs.writeFileSync(
    path.join(repo, ".opencode", "agents", "demo-helper.md"),
    "---\ndescription: Demo helper\nmode: subagent\n---\nHelp with the demo.\n",
  )

  const inspection = inspectOnboardingCandidate(repo)
  assert.equal(inspection.recommendedLayout, "subpack")
  assert.equal(inspection.agentsMdSourceRel, null)
  const result = applyPackOnboarding(repo, { name: "webapp-agents", layout: "subpack" })
  assert.equal(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), "# Host repository instructions\n")
  assert.equal(fs.existsSync(path.join(result.packDir, "AGENTS.md")), false)
})

test("cloneGitSourceForOnboarding: clones remote virtual git repo locally, switches active source and refuses non-empty or symlinked targets", { skip: !hasGit }, (t) => {
  const base = tempDir(t, "onboard-clone-")
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const upstream = path.join(base, "remote-agents")
  fs.mkdirSync(upstream, { recursive: true })
  gitIn(upstream, "init", "--quiet", "--initial-branch=main")
  fs.writeFileSync(path.join(upstream, "architect.md"), "---\ndescription: System architect\nmode: primary\n---\nDesign.\n")
  fs.writeFileSync(path.join(upstream, "scout.md"), "---\ndescription: Fast explorer\nmode: subagent\n---\nExplore.\n")
  gitIn(upstream, "add", "-A")
  gitIn(upstream, "commit", "--quiet", "-m", "initial loose agents")

  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  const gitSource = addSource(registry, "remote-agents", `file://${upstream}`, { trusted: true }, { allowFileUrls: true })
  registry.active = gitSource.name
  saveSources(registry, env)
  pullSource(gitSource, env, { allowFileUrls: true, useGhAuth: false })
  const cacheRoot = sourceRoot(gitSource, env)

  // Non-empty target refused
  const nonEmpty = path.join(base, "occupied")
  fs.mkdirSync(nonEmpty, { recursive: true })
  fs.writeFileSync(path.join(nonEmpty, "existing.txt"), "keep")
  assert.throws(
    () => cloneGitSourceForOnboarding({ source: gitSource, destDir: nonEmpty, registry, env, gitOptions: { allowFileUrls: true, useGhAuth: false } }),
    /already exists and is not empty/,
  )

  if (process.platform !== "win32") {
    const symlinkDest = path.join(base, "sym-parent")
    fs.symlinkSync(nonEmpty, symlinkDest)
    assert.throws(
      () => cloneGitSourceForOnboarding({ source: gitSource, destDir: path.join(symlinkDest, "clone"), registry, env, gitOptions: { allowFileUrls: true, useGhAuth: false } }),
      /symlinked path/,
    )
  }

  const cloneDest = path.join(base, "workspace", "my-agents")
  const { localRoot, localSource } = cloneGitSourceForOnboarding({
    source: gitSource,
    destDir: cloneDest,
    registry,
    env,
    gitOptions: { allowFileUrls: true, useGhAuth: false },
  })
  assert.equal(localSource.kind, "local")
  assert.equal(registry.active, localSource.name)
  assert.equal(gitIn(cacheRoot, "status", "--porcelain"), "", "read-only git cache stays untouched")

  const onboarded = applyPackOnboarding(localRoot, { name: "my-agents", authoringKit: true })
  assert.equal(hasErrors(onboarded.validation), false)
  assert.deepEqual(onboarded.manifest.archetype, { callers: ["architect"], reference: "architect" })
})

test("Pack Doctor, semver bump and resource scaffolding maintain Contract 1.1 compliance", (t) => {
  const base = tempDir(t, "pack-doctor-")
  const pack = path.join(base, "ops-pack")
  fs.mkdirSync(path.join(pack, "agents"), { recursive: true })
  fs.mkdirSync(path.join(pack, "command"), { recursive: true })
  fs.mkdirSync(path.join(pack, "skills", "runbook"), { recursive: true })
  fs.mkdirSync(path.join(pack, "resources"), { recursive: true })

  fs.writeFileSync(
    path.join(pack, MANIFEST_FILE),
    JSON.stringify({
      contract: "1.0",
      name: "ops-pack",
      version: "0.1.0",
      description: "Ops pack",
    }, null, 2),
  )
  fs.writeFileSync(
    path.join(pack, "agents", "ops-lead.md"),
    "---\nname: ops-lead\ndescription: Ops lead\nmode: primary\ntools:\n  bash: true\n---\nLead.\n",
  )
  fs.writeFileSync(
    path.join(pack, "agents", "ops-reader.md"),
    "---\ndescription: Log reader\nmode: subagent\nmax_steps: 6\n---\nRead logs.\n",
  )
  fs.writeFileSync(path.join(pack, "command", "incident.md"), "---\ndescription: Triage incident\n---\n$ARGUMENTS\n")
  fs.writeFileSync(path.join(pack, "skills", "runbook", "SKILL.md"), "# Runbook without frontmatter\n")
  fs.writeFileSync(path.join(pack, "resources", "escalation.md"), "# Escalation\n")
  fs.writeFileSync(path.join(pack, "opencode.json"), JSON.stringify({ model: "openai/gpt-5", experimental: { todo: true } }))

  const before = inspectPackDoctor(pack)
  assert.equal(hasErrors(before.validation), true)
  assert.ok(before.autoFixableCount >= 6)
  assert.equal(before.hasAuthoringSkill, false)

  const fixed = fixPackDoctor(pack, { authoringKit: true })
  assert.ok(fixed.appliedFixes.length >= 6)
  assert.equal(hasErrors(fixed.report.validation), false)
  assert.equal(fixed.report.validation.issues.length, 0)
  assert.equal(fixed.report.manifest?.contract, "1.1")
  assert.deepEqual(fixed.report.manifest?.archetype, { callers: ["ops-lead"], reference: "ops-lead" })
  assert.equal(fixed.report.hasAuthoringSkill, true)
  assert.equal(fixed.report.hasCiWorkflow, true)
  assert.ok(fs.existsSync(path.join(pack, "commands", "incident.md")))
  assert.ok(fs.existsSync(path.join(pack, "resources", "ops-pack", "escalation.md")))
  assert.ok(fs.existsSync(path.join(pack, ".opencode", "opencode.user-backup.json")))

  // Scaffold new resources & bump semver
  const newAgent = scaffoldPackResource(pack, { kind: "agent", id: "ops-verifier", description: "Verifies deploys", mode: "subagent" })
  assert.equal(newAgent.relativePath, "agents/ops-verifier.md")
  assert.equal(hasErrors(newAgent.validation), false)

  const newSkill = scaffoldPackResource(pack, { kind: "skill", id: "postmortem", description: "Drafts postmortems" })
  assert.equal(newSkill.relativePath, "skills/postmortem/SKILL.md")
  assert.equal(hasErrors(newSkill.validation), false)

  const newCmd = scaffoldPackResource(pack, { kind: "command", id: "status-page", description: "Updates status page" })
  assert.equal(newCmd.relativePath, "commands/status-page.md")
  assert.equal(hasErrors(newCmd.validation), false)

  assert.throws(() => scaffoldPackResource(pack, { kind: "agent", id: "../escape" }), /Invalid agent ID/)
  assert.throws(() => scaffoldPackResource(pack, { kind: "agent", id: "ops-verifier" }), /Refusing to overwrite/)

  const bumped = bumpPackVersion(pack, "minor")
  assert.equal(bumped.previousVersion, "0.1.0")
  assert.equal(bumped.nextVersion, "0.2.0")
  assert.equal(hasErrors(validatePack(pack)), false)
})

test("CLI pack onboard, pack add and pack doctor work end-to-end", (t) => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
  const base = tempDir(t, "pack-cli-")
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const folder = path.join(base, "cli-pack")
  fs.mkdirSync(path.join(folder, ".opencode", "agents"), { recursive: true })
  fs.writeFileSync(path.join(folder, ".opencode", "agents", "planner.md"), "---\ndescription: Planner\nmode: primary\n---\nPlan.\n")

  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-ffi", "--no-warnings=ExperimentalWarning", "--import", "tsx", path.join(repoRoot, "src/index.tsx"), ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    })

  const r1 = cli(["pack", "onboard", folder, "--authoring-kit", "--json"])
  assert.equal(r1.status, 0, r1.stderr)
  const onboardJson = JSON.parse(r1.stdout)
  assert.equal(onboardJson.manifest.contract, "1.1")
  assert.equal(onboardJson.layout, "root")

  const r2 = cli(["pack", "add", "agent", "reviewer", "--dir", folder, "--description", "Code reviewer", "--mode", "subagent"])
  assert.equal(r2.status, 0, r2.stderr)
  assert.ok(fs.existsSync(path.join(folder, "agents", "reviewer.md")))

  const r3 = cli(["pack", "doctor", folder, "--fix", "--bump", "minor", "--json"])
  assert.equal(r3.status, 0, r3.stderr)
  const docJson = JSON.parse(r3.stdout)
  assert.equal(docJson.bumped.nextVersion, "0.2.0")
  assert.deepEqual(docJson.report.manifest.archetype, { callers: ["planner"], reference: "planner" })
  assert.equal(docJson.report.findings.length, 0)
})

test("TUI proactive PackOnboardingModal and PackDoctorModal render cleanly at 80x24, 120x34 and 160x45 without clipping", async (t) => {
  const base = tempDir(t, "tui-onboard-")
  const prevXdgConfig = process.env.XDG_CONFIG_HOME
  const prevXdgCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CONFIG_HOME = path.join(base, "xdg-config")
  process.env.XDG_CACHE_HOME = path.join(base, "xdg-cache")

  const press = async (renderer: any, renderOnce: () => Promise<void>, name: string, sequence = name.length === 1 ? name : "", opts: any = {}) => {
    renderer.keyInput.emit("keypress", { name, sequence, ctrl: false, meta: false, shift: false, ...opts })
    await new Promise(r => setImmediate(r))
    await new Promise(r => setTimeout(r, 14))
    await renderOnce()
  }

  const renderers: any[] = []
  try {
    // 1. Check 80x24 compact viewport on a virtual .opencode/agents folder
    const compactWs = path.join(base, "compact-agents")
    fs.mkdirSync(path.join(compactWs, ".opencode", "agents"), { recursive: true })
    fs.writeFileSync(path.join(compactWs, ".opencode", "agents", "lead.md"), "---\ndescription: Lead\nmode: primary\n---\nLead.\n")
    fs.writeFileSync(path.join(compactWs, ".opencode", "agents", "helper.md"), "---\ndescription: Helper\nmode: subagent\nmax_steps: 10\n---\nHelp.\n")

    const r80 = await createTestRenderer({ width: 80, height: 24 })
    renderers.push(r80.renderer)
    createRoot(r80.renderer).render(
      React.createElement(App, {
        workspaceRoot: compactWs,
        listShare: 2 / 3,
        reducedMotion: true,
        initialModelCatalog: { status: "unverified" as const, models: [] },
      }),
    )
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 20))
      await r80.renderOnce()
      if (r80.captureCharFrame().includes("Onboard OpenCode Pack")) break
    }
    const frame80 = r80.captureCharFrame()
    assert.equal(frame80.includes("Onboard OpenCode Pack"), true, "Proactive onboarding wizard opens automatically on virtual folder")
    assert.equal(frame80.includes("2 agents (1 V1->V2)"), true, "Discovery summary reports agents and V1->V2 count")
    assert.equal(frame80.includes("Author Kit:"), true, "Author Kit row fits at 80x24 without clipping")
    assert.equal(frame80.includes("[ENTER] Onboard Pack"), true, "Footer CTA fits at 80x24 without clipping")

    // Dismiss with ESC -> returns to main view; press 'i' -> reopens onboarding wizard; press Enter -> onboards!
    await press(r80.renderer, r80.renderOnce, "escape")
    await press(r80.renderer, r80.renderOnce, "i", "i")
    assert.equal(r80.captureCharFrame().includes("Onboard OpenCode Pack"), true)
    await press(r80.renderer, r80.renderOnce, "return", "\r")
    const resultFrame80 = r80.captureCharFrame()
    assert.equal(resultFrame80.includes("OpenCode Pack Onboarded"), true)
    assert.equal(hasErrors(validatePack(compactWs)), false)

    // 2. Check 120x34 and 160x45 viewports for Pack Doctor ([D]) & New Resource ([N])
    for (const [w, h] of [[120, 34], [160, 45]] as const) {
      const rv = await createTestRenderer({ width: w, height: h })
      renderers.push(rv.renderer)
      createRoot(rv.renderer).render(
        React.createElement(App, {
          workspaceRoot: compactWs,
          listShare: 2 / 3,
          reducedMotion: true,
          initialModelCatalog: { status: "unverified" as const, models: [] },
        }),
      )
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise(r => setTimeout(r, 20))
        await rv.renderOnce()
        if (rv.captureCharFrame().includes("compact-agents (2)")) break
      }
      if (w === 120) {
        // Open Pack Doctor with 'd', bump patch with '1', switch to New Resource with 'n', create skill
        await press(rv.renderer, rv.renderOnce, "d", "d")
        const docFrame = rv.captureCharFrame()
        assert.equal(docFrame.includes("Pack Doctor & Authoring"), true)
        assert.equal(docFrame.includes("[F] Auto-Fix"), true)
        assert.equal(docFrame.includes("[A] Authoring Kit"), true)

        await press(rv.renderer, rv.renderOnce, "1", "1")
        assert.equal(rv.captureCharFrame().includes("0.1.1"), true, "Semver patch bump updates version in modal")

        await press(rv.renderer, rv.renderOnce, "n", "n")
        assert.equal(rv.captureCharFrame().includes("▎ID / Slug:"), true)
        for (const ch of "scout") await press(rv.renderer, rv.renderOnce, ch, ch)
        await press(rv.renderer, rv.renderOnce, "return", "\r")
        assert.equal(rv.captureCharFrame().includes("Created agents/scout.md"), true)
        assert.ok(fs.existsSync(path.join(compactWs, "agents", "scout.md")))
      } else {
        await press(rv.renderer, rv.renderOnce, "n", "n")
        const wideFrame = rv.captureCharFrame()
        assert.equal(wideFrame.includes("[N] New Agent / Skill / Cmd"), true)
        assert.equal(wideFrame.includes("[ENTER] Create"), true)
      }
    }
  } finally {
    for (const inst of renderers) {
      try { inst?.destroy() } catch {}
    }
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevXdgCache
  }
})
