import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { tempDir, writePack } from "../../test/helpers.js"
import { applyPlan, changeTarget, installChange, packContribution, planReconcile, readInstalled, reconcileChange, restoreBackup, rollbackInterrupted, targetStatus, uninstallChange, updateChange, withTargetLock, type ChangeOptions, type LoadedPack } from "./installer.js"
import { readLock } from "./lock.js"
import { MAX_SCANNED_BYTES, parseJsonc } from "./packs.js"
import { addSource, pullSource, type SourceRegistry } from "./sources.js"
import { loadOverrideSettings, removeConfigEntry, saveOverrideSettings, scopeOf, setConfigOverride, unsetConfigOverride } from "./userSettings.js"

const BASE = {
  "tools/base/repo.js": "export const repo = 1\n",
  "plugins/guard/index.ts": `import { repo } from "../../tools/base/repo.js"\nexport default repo\n`,
  "AGENTS.md": "# base\n",
  "skills/base-hello/SKILL.md": "---\ndescription: hello\n---\nhi\n",
  "skills/base-hello/scripts/run.sh": "#!/bin/sh\necho hi\n",
  "opencode.json": JSON.stringify({ mcp: { servers: { db: { type: "local", command: ["db-mcp"] } } }, instructions: ["resources/base/rules.md"] }),
  "resources/base/rules.md": "rules\n",
}
const FLOW = {
  "agents/flow-build.md": "---\nmode: primary\n---\nbuild\n",
  "agents/flow-scout.md": "---\nmode: subagent\n---\nscout\n",
  "commands/flow-go.md": "go\n",
  "opencode.json": JSON.stringify({ plugins: [{ package: "./plugins/guard", options: { strict: true } }] }),
}

function setup(t: test.TestContext, overrides: { flow?: Record<string, string>; trusted?: boolean } = {}) {
  const base = tempDir(t)
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const source = path.join(base, "catalog")
  writePack(path.join(source, "base"), BASE, { name: "base", version: "1.0.0" })
  writePack(path.join(source, "flow"), overrides.flow ?? FLOW, { name: "flow", version: "2.0.0", requires: { base: "^1.0.0" } })
  writePack(path.join(source, "app"), { "agents/app.md": "app\n" }, { name: "app", requires: { base: "^1.0.0" } })
  fs.chmodSync(path.join(source, "base", "skills/base-hello/scripts/run.sh"), 0o755)
  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  addSource(registry, "main", source, { trusted: overrides.trusted ?? true })
  const target = path.join(base, "opencode target")
  fs.mkdirSync(target)
  const options: ChangeOptions = { env, confirm: async () => true }
  const install = (names: string[], extra: Partial<ChangeOptions> = {}) => changeTarget(target, "install", registry, installChange(registry, names, env), { ...options, ...extra })
  return { base, env, source, registry, target, options, install }
}

/** Every file under dir (state and transaction dirs excluded) with its sha256; absolute target paths normalized. */
function snapshot(dir: string, ignoreState = true): Record<string, string> {
  const out: Record<string, string> = {}
  const jsonDir = JSON.stringify(dir).slice(1, -1)
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full).split(path.sep).join("/")
      if (ignoreState && rel === ".manage-agents") continue
      if (entry.isDirectory()) visit(full)
      else out[rel] = crypto.createHash("sha256").update(fs.readFileSync(full, "utf8").replaceAll(jsonDir, "<target>").replaceAll(dir, "<target>")).digest("hex")
    }
  }
  visit(dir)
  return out
}

const config = (target: string) => JSON.parse(fs.readFileSync(path.join(target, "opencode.json"), "utf8"))

test("install: root with dependency, rewritten config, state files, exec bits", async (t) => {
  const { target, install } = setup(t)
  const result = await install(["flow"])

  assert.equal(result.status, "applied", JSON.stringify(result.plan?.conflicts ?? result.change?.problems))
  assert.ok(fs.existsSync(path.join(target, "agents/flow-build.md")))
  assert.ok(fs.existsSync(path.join(target, "tools/base/repo.js")))
  assert.equal(fs.readFileSync(path.join(target, "instructions/base.md"), "utf8"), "# base\n")
  assert.ok(!fs.existsSync(path.join(target, "opencode-pack.json")))
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(target, "skills/base-hello/scripts/run.sh")).mode & 0o111, 0o111)
  assert.deepEqual(config(target), {
    $schema: "https://opencode.ai/config.json",
    plugins: [{ package: "./plugins/guard", options: { strict: true } }],
    instructions: [path.join(target, "resources", "base", "rules.md"), path.join(target, "instructions", "base.md")],
    mcp: { servers: { db: { type: "local", command: ["db-mcp"] } } },
  })
  assert.deepEqual(Object.keys(readLock(target)!.packs), ["base", "flow"])
  assert.equal(readInstalled(target).files["tools/base/repo.js"].owner, "base")
  assert.ok(!fs.existsSync(path.join(target, ".manage-agents", "journal.json")))
  assert.ok(!fs.existsSync(path.join(target, ".manage-agents", "install.lock")))
})

test("determinism: the same desired state and lock give the same tree on two clean targets; reruns change nothing", async (t) => {
  const first = setup(t)
  await first.install(["flow"])
  const second = path.join(first.base, "second target")
  fs.mkdirSync(second)
  fs.mkdirSync(path.join(second, ".manage-agents"))
  for (const file of ["desired.json", "lock.json"]) fs.copyFileSync(path.join(first.target, ".manage-agents", file), path.join(second, ".manage-agents", file))
  const result = await changeTarget(second, "reconcile", first.registry, reconcileChange, first.options)

  assert.equal(result.status, "applied")
  assert.deepEqual(snapshot(second), snapshot(first.target))
  assert.equal((await changeTarget(first.target, "reconcile", first.registry, reconcileChange, first.options)).status, "unchanged")
  assert.equal((await first.install(["flow"])).status, "unchanged")
})

test("target writes preserve live JSONC comments", async (t) => {
  const { target, install } = setup(t)
  fs.writeFileSync(path.join(target, "opencode.jsonc"), `{
  // mine
  "model": "x/y", // inline model note
  "homepage": "https://example.test/a//b",
  /* retained plugins note */
  "plugins": ["my-npm-plugin",],
}
`)
  const result = await install(["flow"])

  assert.equal(result.status, "applied")
  const text = fs.readFileSync(path.join(target, "opencode.jsonc"), "utf8")
  const next = parseJsonc(text) as Record<string, any>
  assert.equal(next.model, "x/y")
  assert.equal(next.homepage, "https://example.test/a//b")
  assert.deepEqual(next.plugins, ["my-npm-plugin", { package: "./plugins/guard", options: { strict: true } }])
  assert.deepEqual(next.mcp.servers.db, { type: "local", command: ["db-mcp"] })
  assert.match(text, /\/\/ mine/)
  assert.match(text, /\/\/ inline model note/)
  assert.match(text, /\/\* retained plugins note \*\//)
})

test("mixed JSONC writes keep personal MCP comments attached", async (t) => {
  const { target, install } = setup(t)
  const personalDb = { type: "local", command: ["personal-db-mcp"] }
  const personalOther = { type: "remote", url: "https://personal.example/mcp" }
  fs.writeFileSync(path.join(target, "opencode.jsonc"), `{
  "model": "personal/model",
  "mcp": {
    "servers": {
      "db": {
        "type": "local",
        "command": ["personal-db-mcp"]
      }, // keep my personal db
      "personal": { "type": "remote", "url": "https://personal.example/mcp" }
    }
  },
  "plugins": ["my-personal-plugin",],
}
`)

  const result = await install(["flow"])

  assert.equal(result.status, "applied", JSON.stringify(result.plan?.conflicts))
  const text = fs.readFileSync(path.join(target, "opencode.jsonc"), "utf8")
  const next = parseJsonc(text) as Record<string, any>
  assert.deepEqual(next.mcp.servers, { db: personalDb, personal: personalOther })
  assert.deepEqual(next.plugins, ["my-personal-plugin", { package: "./plugins/guard", options: { strict: true } }])
  assert.ok(next.instructions.includes(path.join(target, "instructions", "base.md")))
  assert.ok(fs.existsSync(path.join(target, "agents/flow-build.md")))
  assert.match(text, /"db"\s*:\s*\{[^{}]*\}\s*,\s*\/\/ keep my personal db/)
})

test("JSONC adoption and restore preserve live comments", async (t) => {
  const { target, install } = setup(t)
  const configPath = path.join(target, "opencode.jsonc")
  const personalDb = { type: "local", command: ["personal-db-mcp"] }
  fs.writeFileSync(configPath, `{
  "model": "personal/model", // keep my model note
  "mcp": {
    "servers": {
      "db": {
        "type": "local",
        "command": ["personal-db-mcp"] // keep my command note
      } // keep my db entry note
    }
  },
  "plugins": ["my-personal-plugin",],
}
`)

  const adopted = await install(["flow"], { adopt: true })

  assert.equal(adopted.status, "applied", JSON.stringify(adopted.plan?.conflicts))
  const adoptedText = fs.readFileSync(configPath, "utf8")
  const adoptedConfig = parseJsonc(adoptedText) as Record<string, any>
  assert.deepEqual(adoptedConfig.mcp.servers.db, { type: "local", command: ["db-mcp"] })
  assert.deepEqual(readInstalled(target).config.base?.objects?.["mcp.servers"]?.db, { type: "local", command: ["db-mcp"] })
  assert.match(adoptedText, /\/\/ keep my model note/)
  assert.match(adoptedText, /\/\/ keep my command note/)
  assert.match(adoptedText, /\/\/ keep my db entry note/)

  const afterAdopt = adoptedText.replace("{", "{\n  // added after adopt")
  assert.notEqual(afterAdopt, adoptedText)
  fs.writeFileSync(configPath, afterAdopt)
  const restored = await restoreBackup(target, adopted.backupId!)

  assert.ok(restored.config.some(entry => entry.section === "mcp.servers" && entry.key === "db" && JSON.stringify(entry.value) === JSON.stringify(personalDb)))
  const restoredText = fs.readFileSync(configPath, "utf8")
  const restoredConfig = parseJsonc(restoredText) as Record<string, any>
  assert.deepEqual(restoredConfig.mcp.servers.db, personalDb)
  assert.match(restoredText, /\/\/ keep my model note/)
  assert.match(restoredText, /\/\/ keep my command note/)
  assert.match(restoredText, /\/\/ keep my db entry note/)
  assert.match(restoredText, /\/\/ added after adopt/)
})

test("JSONC uninstall preserves adjacent comments and the identity/order of user array entries", async (t) => {
  const { target, install, registry, options } = setup(t)
  const personalServer = { type: "remote", url: "https://personal.example/mcp" }
  fs.writeFileSync(path.join(target, "opencode.jsonc"), `{
  "plugins": [
    "personal-before", // keep the preceding entry
    "personal-after", // keep the trailing adjacent comment
  ],
  "mcp": { "servers": { "personal": { "type": "remote", "url": "https://personal.example/mcp" } } },
}
`)

  const installed = await install(["flow"])
  assert.equal(installed.status, "applied", JSON.stringify(installed.plan?.conflicts))
  const installedConfig = parseJsonc(fs.readFileSync(path.join(target, "opencode.jsonc"), "utf8")) as Record<string, any>
  assert.deepEqual(installedConfig.plugins, ["personal-before", "personal-after", { package: "./plugins/guard", options: { strict: true } }])

  const removed = await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)
  assert.equal(removed.status, "applied")
  const text = fs.readFileSync(path.join(target, "opencode.jsonc"), "utf8")
  const restored = parseJsonc(text) as Record<string, any>
  assert.deepEqual(restored.plugins, ["personal-before", "personal-after"])
  assert.deepEqual(restored.mcp.servers, { personal: personalServer })
  assert.match(text, /"personal-before"\s*,\s*\/\/ keep the preceding entry/)
  assert.match(text, /"personal-after",?[ \t]*\/\/ keep the trailing adjacent comment/)
})

test("JSONC uninstall removes consecutive interior array entries", async (t) => {
  const { source, target, registry, options } = setup(t)
  writePack(path.join(source, "array-pack"), {
    "agents/array-worker.md": "---\ndescription: Array worker\nmode: primary\n---\nWork.\n",
    "opencode.json": JSON.stringify({ plugins: ["npm-first", "npm-second"] }),
  }, { name: "array-pack" })
  const configPath = path.join(target, "opencode.jsonc")
  fs.writeFileSync(configPath, `{
  "plugins": ["personal-before", "personal-after",],
}
`)

  const installed = await changeTarget(target, "install", registry, installChange(registry, ["array-pack"], options.env), options)
  assert.equal(installed.status, "applied", JSON.stringify(installed.plan?.conflicts))
  assert.deepEqual((parseJsonc(fs.readFileSync(configPath, "utf8")) as Record<string, any>).plugins, ["personal-before", "personal-after", "npm-first", "npm-second"])

  fs.writeFileSync(configPath, `{
  "plugins": [
    "personal-before", // keep before
    "npm-first", // managed first
    "npm-second", // managed second
    "personal-after", // keep after
  ],
}
`)
  const beforeRemoval = snapshot(target, false)
  const removed = await changeTarget(target, "uninstall", registry, uninstallChange(["array-pack"]), options)

  assert.equal(removed.status, "applied", removed.plan!.conflicts.join("\n"))
  const text = fs.readFileSync(configPath, "utf8")
  assert.deepEqual((parseJsonc(text) as Record<string, any>).plugins, ["personal-before", "personal-after"])
  assert.match(text, /"personal-before",[ \t]*\/\/ keep before/)
  assert.match(text, /"personal-after",?[ \t]*\/\/ keep after/)
  assert.ok(!fs.existsSync(path.join(target, "agents/array-worker.md")))
  assert.deepEqual(readLock(target)?.roots, [])
  assert.notDeepEqual(snapshot(target, false), beforeRemoval)
})

test("JSONC uninstall removes an interior object entry", async (t) => {
  const { source, target, registry, options } = setup(t)
  const managedServer = { type: "local", command: ["managed-mcp"] }
  const personalBefore = { type: "remote", url: "https://before.example/mcp" }
  const personalAfter = { type: "remote", url: "https://after.example/mcp" }
  writePack(path.join(source, "object-pack"), {
    "agents/object-worker.md": "---\ndescription: Object worker\nmode: primary\n---\nWork.\n",
    "opencode.json": JSON.stringify({ mcp: { servers: { managed: managedServer } } }),
  }, { name: "object-pack" })
  const configPath = path.join(target, "opencode.jsonc")
  fs.writeFileSync(configPath, JSON.stringify({ mcp: { servers: { "personal-before": personalBefore, "personal-after": personalAfter } } }))

  const installed = await changeTarget(target, "install", registry, installChange(registry, ["object-pack"], options.env), options)
  assert.equal(installed.status, "applied", JSON.stringify(installed.plan?.conflicts))
  const installedConfig = parseJsonc(fs.readFileSync(configPath, "utf8")) as Record<string, any>
  assert.deepEqual(installedConfig.mcp.servers.managed, managedServer)
  fs.writeFileSync(configPath, `{
  "mcp": {
    "servers": {
      "personal-before": { "type": "remote", "url": "https://before.example/mcp" },
      "managed": { "type": "local", "command": ["managed-mcp"] },
      "personal-after": { "type": "remote", "url": "https://after.example/mcp" }
    }
  }
}
`)
  const beforeRemoval = snapshot(target, false)

  const removed = await changeTarget(target, "uninstall", registry, uninstallChange(["object-pack"]), options)

  assert.equal(removed.status, "applied", removed.plan!.conflicts.join("\n"))
  assert.deepEqual(parseJsonc(fs.readFileSync(configPath, "utf8")), { mcp: { servers: { "personal-before": personalBefore, "personal-after": personalAfter } } })
  assert.ok(!fs.existsSync(path.join(target, "agents/object-worker.md")))
  assert.deepEqual(readLock(target)?.roots, [])
  assert.notDeepEqual(snapshot(target, false), beforeRemoval)
})

test("JSONC decoded duplicate keys are rejected only when their path is edited", async (t) => {
  const { target, install, registry, options } = setup(t)
  const configPath = path.join(target, "opencode.jsonc")
  fs.writeFileSync(configPath, `{
  "mcp": {
    "servers": {
      "db": { "type": "local", "command": ["personal-db-mcp"] },
      "d\\u0062": { "type": "remote", "url": "https://last.personal.example/mcp" }
    }
  },
  "plugins": ["personal-plugin",],
}
`)

  const installed = await install(["flow"])
  assert.equal(installed.status, "applied", JSON.stringify(installed.plan?.conflicts))
  assert.equal(installed.plan!.skippedMcpServers.filter(server => server.key === "db").length, 1)
  const unchangedDuplicateText = fs.readFileSync(configPath, "utf8")
  assert.ok(unchangedDuplicateText.includes('"d\\u0062"'), "the duplicate spelling survives an unrelated edit path")
  const beforeAdoption = snapshot(target, false)

  const adopted = await changeTarget(target, "reconcile", registry, reconcileChange, { ...options, adopt: true })
  assert.equal(adopted.status, "failed")
  assert.match(adopted.plan!.conflicts.join("\n"), /opencode\.jsonc: comments could not be preserved safely/)
  assert.deepEqual(snapshot(target, false), beforeAdoption, "ambiguous duplicate keys must block without writes when the edited path reaches them")
})

test("install preserves an unmanaged same-name MCP server", async (t) => {
  const { target, install, registry, options } = setup(t)
  const personalDb = { type: "local", command: ["personal-db-mcp"], environment: { PROFILE: "personal" } }
  const personalOther = { type: "remote", url: "https://personal.example/mcp" }
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({
    model: "personal/model",
    mcp: { servers: { db: personalDb, personal: personalOther } },
  }))

  const result = await install(["flow"])

  assert.equal(result.status, "applied", JSON.stringify(result.plan?.conflicts))
  assert.deepEqual(config(target).mcp.servers, { db: personalDb, personal: personalOther })
  assert.ok(fs.existsSync(path.join(target, "agents/flow-build.md")))
  assert.ok(config(target).plugins.some((plugin: unknown) => typeof plugin === "object" && plugin !== null && (plugin as { package?: string }).package === "./plugins/guard"))
  assert.ok(config(target).instructions.includes(path.join(target, "instructions", "base.md")))
  assert.equal(readInstalled(target).config.base?.objects?.["mcp.servers"]?.db, undefined, "the colliding entry remains unmanaged")
  assert.ok(result.plan!.warnings.some(warning => /opencode\.json/.test(warning) && /db/.test(warning) && /base/.test(warning)))

  const reconciled = await changeTarget(target, "reconcile", registry, reconcileChange, options)
  assert.equal(reconciled.status, "unchanged")

  const removed = await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)
  assert.equal(removed.status, "applied")
  assert.deepEqual(config(target).mcp.servers, { db: personalDb, personal: personalOther }, "uninstall must leave the skipped server unmanaged")
  assert.equal(readInstalled(target).config.base, undefined)
})

test("config overrides keep an exact personal server silent and leave a differing one for explicit adoption", async (t) => {
  const { env, target, install, registry, options } = setup(t)
  const personalDb = { type: "local", command: ["my-db-mcp", "--port", "1"] }
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ mcp: { servers: { db: personalDb } } }))

  const installed = await install(["flow"])
  assert.equal(installed.status, "applied", JSON.stringify(installed.plan?.conflicts))
  assert.deepEqual(config(target).mcp.servers.db, personalDb)
  assert.equal(readInstalled(target).config.base?.objects?.["mcp.servers"]?.db, undefined)
  assert.ok(installed.plan!.skippedMcpServers.some(server => server.key === "db" && server.pack === "base"))

  const settings = loadOverrideSettings(env)
  setConfigOverride(scopeOf(settings, target), "base", "mcp.servers", "db", { command: personalDb.command })
  saveOverrideSettings(settings, env)

  const result = await install(["flow"])
  assert.equal(result.status, "unchanged")
  assert.deepEqual(config(target).mcp.servers.db, personalDb)
  assert.equal(result.plan!.skippedMcpServers.length, 0, "an exact contribution match is silent")
  assert.equal(readInstalled(target).config.base?.objects?.["mcp.servers"]?.db, undefined, "a kept entry stays the user's")

  assert.equal((await changeTarget(target, "reconcile", registry, reconcileChange, options)).status, "unchanged")

  // Dropping the override exposes the divergence again, as an unmanaged collision.
  const next = loadOverrideSettings(env)
  assert.equal(unsetConfigOverride(scopeOf(next, target), "base", "mcp.servers", "db", []), true)
  saveOverrideSettings(next, env)
  const skipped = await changeTarget(target, "reconcile", registry, reconcileChange, options)
  assert.equal(skipped.status, "unchanged")
  assert.deepEqual(config(target).mcp.servers.db, personalDb)
  assert.ok(skipped.plan!.skippedMcpServers.some(server => server.key === "db" && server.pack === "base"))

  const adopted = await changeTarget(target, "reconcile", registry, reconcileChange, { ...options, adopt: true })
  assert.equal(adopted.status, "applied")
  assert.deepEqual(config(target).mcp.servers.db, { type: "local", command: ["db-mcp"] })
  assert.ok(adopted.backupId)
  assert.deepEqual(adopted.plan!.adopted.config.find(entry => entry.section === "mcp.servers" && entry.key === "db")?.value, personalDb)
  await restoreBackup(target, adopted.backupId!)
  assert.deepEqual(config(target).mcp.servers.db, personalDb)
})

test("a locally changed managed MCP server still blocks reconcile without --adopt", async (t) => {
  const { target, install, registry, options } = setup(t)
  assert.equal((await install(["flow"])).status, "applied")
  const current = config(target)
  current.mcp.servers.db = { type: "local", command: ["changed-after-managed"] }
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify(current))
  const before = snapshot(target, false)

  const blocked = await changeTarget(target, "reconcile", registry, reconcileChange, options)

  assert.equal(blocked.status, "failed")
  assert.match(blocked.plan!.conflicts.join("\n"), /mcp\.servers "db" was changed locally; rerun with --adopt/)
  assert.equal(blocked.plan!.skippedMcpServers.length, 0, "managed local drift is not an unmanaged skip")
  assert.deepEqual(snapshot(target, false), before)
})

test("duplicate MCP claims created by config overrides remain pack conflicts", async (t) => {
  const { target, env, install } = setup(t)
  const settings = loadOverrideSettings(env)
  setConfigOverride(scopeOf(settings, target), "base", "mcp.servers", "shared", { type: "local", command: ["base-shared-mcp"] })
  setConfigOverride(scopeOf(settings, target), "flow", "mcp.servers", "shared", { type: "local", command: ["flow-shared-mcp"] })
  saveOverrideSettings(settings, env)
  const before = snapshot(target, false)

  const result = await install(["flow"])

  assert.equal(result.status, "failed")
  assert.match(result.plan!.conflicts.join("\n"), /mcp\.servers "shared" is set differently by base and flow/)
  assert.equal(result.plan!.skippedMcpServers.length, 0, "pack-to-pack ownership is not an unmanaged personal-server skip")
  assert.deepEqual(snapshot(target, false), before)
})

test("config overrides can remove an entry (null), toggle servers and merge nested fields", async (t) => {
  const { env, target, install, registry, options } = setup(t)
  const settings = loadOverrideSettings(env)
  setConfigOverride(scopeOf(settings, target), "base", "mcp.servers", "db", { disabled: true, environment: { DOCKER_HOST: "tcp://db" } })
  saveOverrideSettings(settings, env)

  assert.equal((await install(["flow"])).status, "applied")
  assert.deepEqual(config(target).mcp.servers.db, { type: "local", command: ["db-mcp"], disabled: true, environment: { DOCKER_HOST: "tcp://db" } })

  const enabling = loadOverrideSettings(env)
  // A null field removes `disabled` from the contributed entry (the `models unpin` semantics); the merge keeps the rest.
  setConfigOverride(scopeOf(enabling, target), "base", "mcp.servers", "db", { disabled: null })
  saveOverrideSettings(enabling, env)
  assert.equal((await changeTarget(target, "reconcile", registry, reconcileChange, options)).status, "applied")
  assert.deepEqual(config(target).mcp.servers.db, { type: "local", command: ["db-mcp"], environment: { DOCKER_HOST: "tcp://db" } })

  const removing = loadOverrideSettings(env)
  assert.equal(unsetConfigOverride(scopeOf(removing, target), "base", "mcp.servers", "db", []), true)
  removeConfigEntry(scopeOf(removing, target), "base", "mcp.servers", "db")
  saveOverrideSettings(removing, env)
  const removed = await changeTarget(target, "reconcile", registry, reconcileChange, options)
  assert.equal(removed.status, "applied")
  assert.equal(config(target).mcp, undefined, "the pack contributes no server any more and the section it created goes too")
})

test("a file collision blocks before any write; --adopt backs up, restore puts it back", async (t) => {
  const { target, install, options } = setup(t)
  fs.mkdirSync(path.join(target, "agents"))
  fs.writeFileSync(path.join(target, "agents/flow-build.md"), "mine\n")
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ mcp: { servers: { db: { type: "remote", url: "https://mine" } } } }))
  const before = snapshot(target, false)

  const blocked = await install(["flow"])
  assert.equal(blocked.status, "failed")
  assert.deepEqual(blocked.plan!.conflicts.map(conflict => conflict.split(" ")[0]).sort(), ["agents/flow-build.md"])
  assert.ok(blocked.plan!.skippedMcpServers.some(server => server.key === "db" && server.pack === "base"), "the differing personal server is skipped, not a blocking conflict")
  assert.deepEqual(snapshot(target, false), before)

  const adopted = await install(["flow"], { adopt: true })
  assert.equal(adopted.status, "applied")
  assert.equal(fs.readFileSync(path.join(target, "agents/flow-build.md"), "utf8"), FLOW["agents/flow-build.md"])
  assert.equal(config(target).mcp.servers.db.type, "local")

  await restoreBackup(target, adopted.backupId!)
  assert.equal(fs.readFileSync(path.join(target, "agents/flow-build.md"), "utf8"), "mine\n")
  assert.deepEqual(config(target).mcp.servers.db, { type: "remote", url: "https://mine" })
  assert.equal(readInstalled(target).files["agents/flow-build.md"], undefined)
  assert.ok(targetStatus(target, setup(t).registry, options.env).drift.length > 0)
})

test("locally changed managed files: update conflicts without --adopt, uninstall leaves them in place unmanaged", async (t) => {
  const { target, source, install, registry, options } = setup(t)
  await install(["flow"])
  fs.writeFileSync(path.join(target, "agents/flow-scout.md"), "edited by me\n")
  assert.ok(targetStatus(target, registry, options.env).drift.some(line => line.startsWith("agents/flow-scout.md was changed locally")))

  fs.writeFileSync(path.join(source, "flow", "agents/flow-scout.md"), "---\nmode: subagent\n---\nnew scout\n")
  const update = await changeTarget(target, "update", registry, updateChange(registry, ["flow"], options.env), options)
  assert.equal(update.status, "failed")
  assert.match(update.plan!.conflicts[0], /agents\/flow-scout\.md was changed locally; rerun with --adopt/)

  const removed = await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)
  assert.equal(removed.status, "applied")
  assert.equal(fs.readFileSync(path.join(target, "agents/flow-scout.md"), "utf8"), "edited by me\n")
  assert.ok(!fs.existsSync(path.join(target, "agents/flow-build.md")))
  assert.ok(!fs.existsSync(path.join(target, "tools")), "empty directories are removed")
  assert.deepEqual(config(target), { $schema: "https://opencode.ai/config.json" })
})

test("uninstall keeps a dependency still required and refuses to remove it directly", async (t) => {
  const { target, install, registry, options } = setup(t)
  await install(["flow", "app"])

  const direct = await changeTarget(target, "uninstall", registry, uninstallChange(["base"]), options)
  assert.deepEqual(direct.change!.problems, ["base is installed as a dependency of app, flow; uninstall that instead"])

  assert.equal((await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)).status, "applied")
  assert.deepEqual(Object.keys(readLock(target)!.packs), ["app", "base"])
  assert.ok(fs.existsSync(path.join(target, "tools/base/repo.js")))
})

test("local source edits: reconcile refuses until update, install keeps other packs pinned", async (t) => {
  const { target, source, install, registry, options } = setup(t)
  await install(["flow"])
  writePack(path.join(source, "base"), { ...BASE, "resources/base/rules.md": "new rules\n" }, { name: "base", version: "1.1.0" })

  const reconcile = await changeTarget(target, "reconcile", registry, reconcileChange, options)
  assert.match(reconcile.plan!.conflicts[0], /base: the source changed since the lock; run `manage-agents update base`/)

  const install2 = await install(["app"])
  assert.match(install2.change!.problems[0], /pack "base" is locked at main@1\.0\.0/)

  const update = await changeTarget(target, "update", registry, updateChange(registry, [], options.env), options)
  assert.equal(update.status, "applied")
  assert.deepEqual(update.changes.map(change => `${change.kind} ${change.name}`), ["upgrade base"])
  assert.equal(fs.readFileSync(path.join(target, "resources/base/rules.md"), "utf8"), "new rules\n")
})

test("an unmanaged MCP skip keeps untrusted executable approval scoped to the installed lock", async (t) => {
  const { target, install, registry, options } = setup(t, { trusted: false })
  const personalDb = { type: "local", command: ["personal-db-mcp"] }
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ mcp: { servers: { db: personalDb } } }))
  const asked: string[][] = []

  const accepted = await install(["flow"], { confirm: async reasons => { asked.push(reasons); return true } })

  assert.equal(accepted.status, "applied", JSON.stringify(accepted.plan?.conflicts))
  assert.equal(asked.length, 1)
  assert.ok(asked[0]!.some(reason => /base: source "main" is not trusted and the pack carries executable content/.test(reason)))
  assert.equal(accepted.plan!.skippedMcpServers.length, 1)
  assert.equal(accepted.backupId, null, "skipping an unmanaged personal entry is not adoption")
  assert.deepEqual(config(target).mcp.servers.db, personalDb)
  assert.equal(readInstalled(target).config.base?.objects?.["mcp.servers"]?.db, undefined)
  const approvedLock = readLock(target)

  const unchanged = await changeTarget(target, "reconcile", registry, reconcileChange, {
    ...options,
    confirm: async () => assert.fail("the same installed executable lock must not prompt again"),
  })
  assert.equal(unchanged.status, "unchanged")
  assert.deepEqual(readLock(target), approvedLock)
})

test("confirmation: untrusted executable content is declined without writing; accepted once, not asked again", async (t) => {
  const { target, install, registry, options } = setup(t, { trusted: false })
  const asked: string[][] = []
  const declined = await install(["flow"], { confirm: async reasons => { asked.push(reasons); return false } })

  assert.equal(declined.status, "declined")
  assert.ok(asked[0].some(reason => /base: source "main" is not trusted/.test(reason)))
  assert.deepEqual(fs.readdirSync(target).filter(name => name !== ".manage-agents"), [])

  assert.equal((await install(["flow"])).status, "applied")
  const reconcile = await changeTarget(target, "reconcile", registry, reconcileChange, { ...options, confirm: async () => assert.fail("must not ask again") })
  assert.equal(reconcile.status, "unchanged")
})

test("legacy export files and plugin entries are replaced without --adopt", async (t) => {
  const { target, install } = setup(t)
  fs.mkdirSync(path.join(target, "agents"))
  fs.writeFileSync(path.join(target, "agents/flow-build.md"), "old export\n")
  fs.writeFileSync(path.join(target, ".resource-export-manifest.json"), JSON.stringify({ owner: "manage-agents", version: 1, resources: ["agents/flow-build.md", "plugins/guard/index.ts"] }))
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ plugins: ["./plugins/guard", "./plugins/other"] }))
  const result = await install(["flow"])

  assert.equal(result.status, "applied", JSON.stringify(result.plan?.conflicts))
  assert.deepEqual(config(target).plugins, ["./plugins/other", { package: "./plugins/guard", options: { strict: true } }])
})

test("interrupted apply rolls back to the exact previous tree", async (t) => {
  const { target, source, install, registry, options } = setup(t)
  await install(["flow"])
  writePack(path.join(source, "flow"), { ...FLOW, "agents/flow-scout.md": "---\nmode: subagent\n---\nv2\n", "commands/flow-new.md": "new\n" }, { name: "flow", version: "2.1.0", requires: { base: "^1.0.0" } })
  const before = snapshot(target, false)
  const rename = fs.renameSync
  let calls = 0
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (++calls === 4) throw new Error("disk full")
    return rename(from, to)
  })

  await assert.rejects(changeTarget(target, "update", registry, updateChange(registry, ["flow"], options.env), options), /disk full/)
  t.mock.restoreAll()
  assert.deepEqual(snapshot(target, false), before)
})

test("a crash mid-transaction is rolled back by the next operation", (t) => {
  const target = tempDir(t)
  const txn = path.join(target, ".manage-agents", "txn", "crash")
  fs.mkdirSync(path.join(txn, "prev"), { recursive: true })
  fs.writeFileSync(path.join(txn, "prev", "a.md"), "old a\n")
  fs.writeFileSync(path.join(target, "a.md"), "new a\n")
  fs.writeFileSync(path.join(target, "b.md"), "new b\n")
  fs.writeFileSync(path.join(target, "c.md"), "untouched c\n")
  fs.writeFileSync(path.join(target, "d.md"), "user file that appeared\n")
  const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex")
  fs.writeFileSync(path.join(target, ".manage-agents", "journal.json"), JSON.stringify({ id: "crash", ops: [
    { rel: "a.md", existed: true, hash: sha("new a\n") },
    { rel: "b.md", existed: false, hash: sha("new b\n") },
    { rel: "c.md", existed: true },
    { rel: "d.md", existed: false, hash: sha("what the transaction would have written\n") },
  ] }))

  assert.equal(rollbackInterrupted(target), true)
  assert.equal(fs.readFileSync(path.join(target, "a.md"), "utf8"), "old a\n")
  assert.ok(!fs.existsSync(path.join(target, "b.md")))
  assert.equal(fs.readFileSync(path.join(target, "c.md"), "utf8"), "untouched c\n")
  assert.equal(fs.readFileSync(path.join(target, "d.md"), "utf8"), "user file that appeared\n", "only bytes the transaction wrote are removed")
  assert.ok(!fs.existsSync(txn))

  fs.writeFileSync(path.join(target, ".manage-agents", "journal.json"), JSON.stringify({ id: "x", ops: [{ rel: "../escape", existed: false }] }))
  assert.throws(() => rollbackInterrupted(target), /damaged/)
})

test("target lock: a live holder blocks, a dead or unreadable one is reclaimed", async (t) => {
  const target = tempDir(t)
  const file = path.join(target, ".manage-agents", "install.lock")
  fs.mkdirSync(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), command: "install", started: "now" }))
  await assert.rejects(withTargetLock(target, "test", () => 1), /locked by install \(pid/)

  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), command: "install", started: "then" }))
  assert.equal(await withTargetLock(target, "test", () => 7), 7)
  assert.ok(!fs.existsSync(file))

  fs.writeFileSync(file, JSON.stringify({ pid: 1, host: "other-host", command: "install", started: "now" }))
  await assert.rejects(withTargetLock(target, "test", () => 1), /other-host/)

  fs.writeFileSync(file, "{broken")
  fs.utimesSync(file, new Date(0), new Date(0))
  assert.equal(await withTargetLock(target, "test", () => 3), 3)
})

test("conflicting packs: the same agent ID from two packs blocks the install", async (t) => {
  const { source, install, registry } = setup(t)
  writePack(path.join(source, "clone"), { "agents/flow-build.md": "other\n" }, { name: "clone" })
  const result = await install(["flow", "clone"])

  assert.equal(result.status, "failed")
  assert.match(result.plan!.conflicts.join("\n"), /agent "flow-build" is provided by both (clone and flow|flow and clone)/)
  assert.equal(registry.sources.length, 1)
})

test("a target reached through a symlink installs into the real directory", { skip: process.platform === "win32" }, async (t) => {
  const { base, registry, options, target } = setup(t)
  const link = path.join(base, "link")
  fs.symlinkSync(target, link)
  const real = fs.realpathSync(link)
  const result = await changeTarget(real, "install", registry, installChange(registry, ["flow"], options.env), options)

  assert.equal(result.status, "applied")
  assert.ok(fs.existsSync(path.join(target, "agents/flow-build.md")))
  assert.ok(config(target).instructions.every((entry: string) => entry.startsWith(fs.realpathSync(target))))
})

test("identical content the user already had stays theirs and survives uninstall", async (t) => {
  const { target, install, registry, options } = setup(t)
  fs.mkdirSync(path.join(target, "commands"))
  fs.writeFileSync(path.join(target, "commands/flow-go.md"), FLOW["commands/flow-go.md"])
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ mcp: { servers: { db: { type: "local", command: ["db-mcp"] } } } }))
  assert.equal((await install(["flow"])).status, "applied")
  assert.equal(readInstalled(target).files["commands/flow-go.md"], undefined)

  assert.equal((await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)).status, "applied")
  assert.ok(fs.existsSync(path.join(target, "commands/flow-go.md")))
  assert.deepEqual(config(target).mcp.servers.db, { type: "local", command: ["db-mcp"] })
})

test("uninstall drops the config sections it emptied but keeps the user's empty ones", async (t) => {
  const { target, install, registry, options } = setup(t)
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ model: "a/b", lsp: {} }))
  assert.equal((await install(["flow"])).status, "applied")
  assert.ok(config(target).mcp.servers.db)

  assert.equal((await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)).status, "applied")
  assert.deepEqual(config(target), { model: "a/b", lsp: {} })
})

test("an empty section the user wrote stays after a pack filled it and was uninstalled", async (t) => {
  const { target, install, registry, options } = setup(t)
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ mcp: { servers: {} } }))
  assert.equal((await install(["flow"])).status, "applied")
  assert.ok(config(target).mcp.servers.db)

  assert.equal((await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)).status, "applied")
  assert.deepEqual(config(target), { mcp: { servers: {} } })
})

test("a manifest-only change in a local source is caught as a change since the lock", async (t) => {
  const { target, source, install, registry, options } = setup(t)
  await install(["flow"])
  const manifest = path.join(source, "flow", "opencode-pack.json")
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, "utf8")), description: "changed" }))

  const reconcile = await changeTarget(target, "reconcile", registry, reconcileChange, options)
  assert.match(reconcile.plan!.conflicts[0], /flow: the source changed since the lock/)
})

test("the target changing between planning and apply aborts without writing", async (t) => {
  const { target, install } = setup(t)
  const raced = await install(["flow"], {
    confirm: async () => {
      fs.mkdirSync(path.join(target, "agents"), { recursive: true })
      fs.writeFileSync(path.join(target, "agents/flow-build.md"), "typed while the prompt was open\n")
      return true
    },
  }).catch((error: Error) => error)

  assert.ok(raced instanceof Error && /agents\/flow-build\.md changed while installing/.test(raced.message), String(raced))
  assert.equal(fs.readFileSync(path.join(target, "agents/flow-build.md"), "utf8"), "typed while the prompt was open\n")
  assert.ok(!fs.existsSync(path.join(target, "commands")))
  assert.ok(!fs.existsSync(path.join(target, ".manage-agents", "txn")) || !fs.readdirSync(path.join(target, ".manage-agents", "txn")).length)
})

test("a JSONC preimage changing during confirmation aborts without applying config or files", async (t) => {
  const { target, install } = setup(t, { trusted: false })
  const configPath = path.join(target, "opencode.jsonc")
  fs.writeFileSync(configPath, `{
  // original live comment
  "model": "before",
}
`)
  const changedText = `{
  // edited while the confirmation prompt was open
  "model": "changed by user",
}
`

  const raced = await install(["flow"], {
    confirm: async reasons => {
      assert.ok(reasons.some(reason => /base: source "main" is not trusted/.test(reason)))
      fs.writeFileSync(configPath, changedText)
      return true
    },
  }).catch((error: Error) => error)

  assert.ok(raced instanceof Error && /opencode\.jsonc changed while installing; nothing was written/.test(raced.message), String(raced))
  assert.equal(fs.readFileSync(configPath, "utf8"), changedText)
  assert.ok(!fs.existsSync(path.join(target, "agents/flow-build.md")))
  assert.equal(readLock(target), null)
})

test("a symlinked opencode.json is reported, never replaced", { skip: process.platform === "win32" }, async (t) => {
  const { base, target, install } = setup(t)
  const dotfile = path.join(base, "dotfiles.json")
  fs.writeFileSync(dotfile, "{}")
  fs.symlinkSync(dotfile, path.join(target, "opencode.json"))
  const result = await install(["flow"])

  assert.equal(result.status, "failed")
  assert.match(result.plan!.conflicts.join("\n"), /opencode\.json is a symlink/)
  assert.ok(fs.lstatSync(path.join(target, "opencode.json")).isSymbolicLink())
})

test("symlinked state and resource directories are refused without writes through them", { skip: process.platform === "win32" }, async (t) => {
  const { base, target, install, env, registry, options } = setup(t)
  const outsideState = path.join(base, "outside-state")
  fs.mkdirSync(outsideState)
  fs.symlinkSync(outsideState, path.join(target, ".manage-agents"), "dir")
  await assert.rejects(install(["flow"]), /Refusing symlink or non-directory path inside target/)
  assert.deepEqual(fs.readdirSync(outsideState), [])

  const target2 = path.join(base, "target-agents-link")
  const outsideAgents = path.join(base, "outside-agents")
  fs.mkdirSync(target2)
  fs.mkdirSync(outsideAgents)
  fs.symlinkSync(outsideAgents, path.join(target2, "agents"), "dir")
  const blocked = await changeTarget(target2, "install", registry, installChange(registry, ["flow"], env), options).catch(error => error)
  assert.ok(blocked instanceof Error, String(blocked))
  assert.deepEqual(fs.readdirSync(outsideAgents), [])
})

test("dangling opencode.jsonc symlink is reported as a config conflict", { skip: process.platform === "win32" }, async (t) => {
  const { target, install } = setup(t)
  fs.symlinkSync("missing.json", path.join(target, "opencode.jsonc"))
  const result = await install(["flow"])

  assert.equal(result.status, "failed")
  assert.equal(result.plan!.configFile, "opencode.jsonc")
  assert.match(result.plan!.conflicts.join("\n"), /opencode\.jsonc is a symlink/)
})

test("oversized locked opencode config is rejected before it is read", async (t) => {
  const { target, source, install, registry, options } = setup(t)
  assert.equal((await install(["flow"])).status, "applied")
  fs.writeFileSync(path.join(source, "flow", "opencode.json"), " ".repeat(MAX_SCANNED_BYTES + 1))

  const result = await changeTarget(target, "reconcile", registry, reconcileChange, options)
  assert.equal(result.status, "failed")
  assert.ok(result.plan!.conflicts.includes(`flow: opencode.json exceeds maximum scanned size (${MAX_SCANNED_BYTES} bytes)`))
})

test("restore recreates an adopted symlink as a link", { skip: process.platform === "win32" }, async (t) => {
  const { target, install } = setup(t)
  fs.mkdirSync(path.join(target, "agents"))
  fs.symlinkSync("../elsewhere/flow-build.md", path.join(target, "agents/flow-build.md"))
  const adopted = await install(["flow"], { adopt: true })
  assert.equal(adopted.status, "applied")

  await restoreBackup(target, adopted.backupId!)
  assert.equal(fs.readlinkSync(path.join(target, "agents/flow-build.md")), "../elsewhere/flow-build.md")
})

test("config keys named __proto__ are kept as plain entries", async (t) => {
  const { target, install } = setup(t, { flow: { ...FLOW, "opencode.json": `{"plugins":[{"package":"./plugins/guard","options":{"strict":true}}],"agents":{"__proto__":{"mode":"primary"}}}` } })
  const result = await install(["flow"])

  assert.equal(result.status, "applied", JSON.stringify(result.plan?.conflicts))
  const written = JSON.parse(fs.readFileSync(path.join(target, "opencode.json"), "utf8"))
  assert.ok(Object.hasOwn(written.agents, "__proto__"))
  assert.deepEqual(written.agents["__proto__"], { mode: "primary" })
})

test("planReconcile writes nothing", (t) => {
  const { target, registry, options } = setup(t)
  const before = snapshot(target, false)
  planReconcile(target, { lockVersion: 1, contract: "1.0", roots: [], packs: {} }, registry, options)
  assert.deepEqual(snapshot(target, false), before)
  assert.throws(() => applyPlan({ ...planReconcile(target, { lockVersion: 1, contract: "1.0", roots: [], packs: {} }, registry, options), conflicts: ["x"] }, { desired: { desiredVersion: 1, roots: [] }, lock: { lockVersion: 1, contract: "1.0", roots: [], packs: {} } }), /refusing/)
})

const hasGit = spawnSync("git", ["--version"]).status === 0
function gitIn(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test("git sources: reconcile installs the locked revision after a pull; update moves to the new one", { skip: !hasGit }, async (t) => {
  const base = tempDir(t)
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const repo = path.join(base, "repo")
  fs.mkdirSync(repo)
  gitIn(repo, "init", "--quiet", "--initial-branch=main")
  fs.writeFileSync(path.join(repo, ".gitattributes"), "*.md text eol=lf\n")
  writePack(path.join(repo, "packs", "notes"), { "agents/notes.md": "v1\n" }, { name: "notes", version: "1.0.0" })
  gitIn(repo, "add", "-A")
  gitIn(repo, "commit", "--quiet", "-m", "v1")
  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  const source = addSource(registry, "remote", `file://${repo}`, { ref: "main", trusted: true }, { allowFileUrls: true })
  pullSource(source, env, { allowFileUrls: true })
  const target = path.join(base, "target")
  const options: ChangeOptions = { env, confirm: async () => true }
  assert.equal((await changeTarget(target, "install", registry, installChange(registry, ["notes"], env), options)).status, "applied")

  writePack(path.join(repo, "packs", "notes"), { "agents/notes.md": "v2\n" }, { name: "notes", version: "1.1.0" })
  gitIn(repo, "commit", "--quiet", "-am", "v2")
  pullSource(source, env, { allowFileUrls: true })
  fs.rmSync(path.join(target, "agents", "notes.md"))

  assert.equal((await changeTarget(target, "reconcile", registry, reconcileChange, options)).status, "applied")
  assert.equal(fs.readFileSync(path.join(target, "agents/notes.md"), "utf8"), "v1\n")
  assert.ok(targetStatus(target, registry, env).drift.some(line => /source remote is checked out at/.test(line)))

  const update = await changeTarget(target, "update", registry, updateChange(registry, ["notes"], env, { allowFileUrls: true }), options)
  assert.equal(update.status, "applied")
  assert.equal(fs.readFileSync(path.join(target, "agents/notes.md"), "utf8"), "v2\n")
  assert.deepEqual(targetStatus(target, registry, env).drift, [])
})

test("packContribution skips MCP servers gated to another platform", () => {
  const pack = {
    name: "acme",
    locked: {},
    dir: "/tmp/acme",
    validation: { ids: { plugins: [] }, files: [] },
    fileHashes: {},
    configText: JSON.stringify({
      mcp: {
        servers: {
          cupertino: { type: "local", command: ["cupertino", "serve"], disabled: true, platform: "darwin" },
          shadcn: { type: "local", command: ["npx", "-y", "shadcn@latest", "mcp"] }
        }
      }
    })
  } as unknown as LoadedPack
  const linux = packContribution(pack, "/targets/demo", undefined, "linux")
  assert.deepEqual(linux.contribution.objects["mcp.servers"], { shadcn: { type: "local", command: ["npx", "-y", "shadcn@latest", "mcp"] } })
  assert.deepEqual(linux.skippedMcpServers, ["cupertino"])
  const mac = packContribution(pack, "/targets/demo", undefined, "darwin")
  assert.ok((mac.contribution.objects["mcp.servers"] as Record<string, any>).cupertino)
  assert.deepEqual(mac.skippedMcpServers, [])
})
