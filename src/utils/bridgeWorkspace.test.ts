import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { bridgeConfirmationsNeeded, bridgePack, prepareBridgeWorkspace, resolveBridgeWorkspaceTrust } from "./bridgeWorkspace.js"
import { defaultTarget } from "./lock.js"
import { realpathThroughExistingAncestor } from "./pathValidation.js"
import { saveConfigOverride } from "./sourceCustomization.js"
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from "./translationConfig.js"

const manifest = (name: string, requires: Record<string, string> = {}) =>
  JSON.stringify({ contract: "1.0", name, version: "1.0.0", description: "x", requires })

const agent = (description: string, mode = "subagent") => `---\ndescription: ${description}\nmode: ${mode}\n---\n\n${description}.\n`

/** A catalog where `app` requires `lib` and `extra`, and `lib` requires `base`. */
const CATALOG: Record<string, string> = {
  "packs/base/opencode-pack.json": manifest("base"),
  "packs/base/opencode.json": JSON.stringify({ mcp: { servers: { shared: { type: "local", command: ["base-mcp"] } } }, lsp: { md: { command: ["marksman"], extensions: [".md"] } } }),
  "packs/base/skills/base-writing/SKILL.md": "---\nname: base-writing\ndescription: Writing rules\n---\n\nWrite well.\n",
  "packs/base/AGENTS.md": "# base\n",
  "packs/lib/opencode-pack.json": manifest("lib", { base: "^1.0.0" }),
  "packs/lib/opencode.jsonc": `{\n  // later packs win\n  "mcp": { "servers": { "shared": { "type": "local", "command": ["lib-mcp"] }, "lib-only": { "type": "local", "command": ["lib-only"] } } },\n}\n`,
  "packs/lib/agents/lib-helper.md": agent("Library helper"),
  "packs/lib/tools/lib/lib_tool.ts": "export default {}\n",
  "packs/lib/tools/lib/lib_tool.test.mjs": "\n",
  "packs/lib/tools/lib/__pycache__/cache.pyc": "\n",
  "packs/lib/README.md": "# lib\n",
  "packs/extra/opencode-pack.json": manifest("extra"),
  "packs/extra/commands/extra-run.md": "---\ndescription: Run extra\n---\nRun $ARGUMENTS.\n",
  "packs/app/opencode-pack.json": manifest("app", { lib: "^1.0.0", extra: "^1.0.0" }),
  "packs/app/agents/app-orchestrator.md": agent("App orchestrator", "primary"),
  "packs/app/agents/app-worker.md": agent("App worker"),
  "packs/app/plugins/app-guard/index.ts": "export default {}\n",
  "packs/unrelated/opencode-pack.json": manifest("unrelated"),
  "packs/unrelated/agents/unrelated-agent.md": agent("Unrelated")
}

function writeCatalog(t: TestContext, files: Record<string, string> = CATALOG): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-workspace-catalog-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), content)
  }
  return root
}

function tempDir(t: TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeSourceRegistry(
  t: TestContext,
  sources: Array<{ name: string; kind: "local"; path: string; trusted: boolean }>
): NodeJS.ProcessEnv {
  const configHome = tempDir(t, "bridge-workspace-config-")
  const engineConfig = path.join(configHome, "manage-agents")
  fs.mkdirSync(engineConfig, { recursive: true })
  fs.writeFileSync(path.join(engineConfig, "sources.json"), JSON.stringify({ schemaVersion: 1, sources, prefer: {} }))
  return { ...process.env, XDG_CONFIG_HOME: configHome }
}

function listFiles(root: string): string[] {
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .filter(relative => fs.statSync(path.join(root, relative)).isFile())
    .map(relative => relative.split(path.sep).join("/"))
    .sort()
}

const config: TranslationConfig = { ...DEFAULT_TRANSLATION_CONFIG, claude: { ...DEFAULT_TRANSLATION_CONFIG.claude, autoValidate: false, autoRegister: false } }

test("prepareBridgeWorkspace merges the pack closure into one installable tree", (t) => {
  const catalog = writeCatalog(t)
  const workspace = prepareBridgeWorkspace(catalog, "app")
  t.after(workspace.cleanup)

  assert.deepEqual(listFiles(workspace.root), [
    "agents/app-orchestrator.md",
    "agents/app-worker.md",
    "agents/lib-helper.md",
    "commands/extra-run.md",
    "opencode.json",
    "plugins/app-guard/index.ts",
    "skills/base-writing/SKILL.md",
    "tools/lib/lib_tool.ts"
  ])
})

test("prepareBridgeWorkspace merges MCP and LSP declarations with later packs winning", (t) => {
  const catalog = writeCatalog(t)
  const workspace = prepareBridgeWorkspace(catalog, "app")
  t.after(workspace.cleanup)

  const merged = JSON.parse(fs.readFileSync(path.join(workspace.root, "opencode.json"), "utf8"))
  assert.deepEqual(merged, {
    mcp: { servers: { shared: { type: "local", command: ["lib-mcp"] }, "lib-only": { type: "local", command: ["lib-only"] } } },
    lsp: { md: { command: ["marksman"], extensions: [".md"] } }
  })
})

test("prepareBridgeWorkspace applies overrides.json config patches (default scope) to the merged servers", (t) => {
  const catalog = writeCatalog(t)
  const configHome = tempDir(t, "bridge-config-override-")
  const engineConfig = path.join(configHome, "manage-agents")
  fs.mkdirSync(engineConfig, { recursive: true })
  fs.writeFileSync(path.join(engineConfig, "overrides.json"), JSON.stringify({
    version: 1,
    default: {
      lib: { config: {
        "mcp.servers": {
          shared: { disabled: true },
          "lib-only": { command: ["lib-only", "--standalone"] },
        },
      } },
    },
    targets: {},
  }))
  const packScopedEnv = { ...process.env, XDG_CONFIG_HOME: configHome }

  const workspace = prepareBridgeWorkspace(catalog, "app", packScopedEnv)
  t.after(workspace.cleanup)

  const merged = JSON.parse(fs.readFileSync(path.join(workspace.root, "opencode.json"), "utf8"))
  assert.deepEqual(merged.mcp.servers.shared, { type: "local", command: ["lib-mcp"], disabled: true }, "pack entry deep-merged with the override")
  assert.deepEqual(merged.mcp.servers["lib-only"], { type: "local", command: ["lib-only", "--standalone"] }, "command replaced")
})

test("prepareBridgeWorkspace applies target-scope overrides of the default OpenCode target (what `override config-set` writes without --global)", (t) => {
  const catalog = writeCatalog(t)
  const configHome = tempDir(t, "bridge-config-override-target-")
  const engineConfig = path.join(configHome, "manage-agents")
  fs.mkdirSync(engineConfig, { recursive: true })
  fs.writeFileSync(path.join(engineConfig, "overrides.json"), JSON.stringify({
    version: 1,
    default: {},
    targets: {
      // The scope key `override config-set` uses: the realpath-resolved default OpenCode target ($XDG_CONFIG_HOME/opencode).
      [realpathThroughExistingAncestor(path.join(configHome, "opencode"))]: {
        lib: { config: { "mcp.servers": { "lib-only": { disabled: true } } } },
      },
    },
  }))
  const packScopedEnv = { ...process.env, XDG_CONFIG_HOME: configHome }

  const workspace = prepareBridgeWorkspace(catalog, "app", packScopedEnv)
  t.after(workspace.cleanup)

  const merged = JSON.parse(fs.readFileSync(path.join(workspace.root, "opencode.json"), "utf8"))
  assert.deepEqual(merged.mcp.servers["lib-only"], { type: "local", command: ["lib-only"], disabled: true }, "target-scope override reaches the bridge")
})

test("TUI sequence: the MCP toggle (`saveConfigOverride`) is what an exported bridge sees", (t) => {
  const catalog = writeCatalog(t, {
    "packs/demo/opencode-pack.json": manifest("demo"),
    "packs/demo/opencode.json": JSON.stringify({ mcp: { servers: { cupertino: { type: "local", command: ["cupertino-mcp"], disabled: true } } } }),
    "packs/demo/agents/demo-helper.md": agent("Demo helper"),
  })
  const configHome = tempDir(t, "tui-toggle-")
  const env = { ...process.env, XDG_CONFIG_HOME: configHome }
  const outputDir = path.join(catalog, "bridges", "claude-code", "demo-plugin")
  const bridge = () => bridgePack({ workspaceRoot: catalog, pack: "demo", target: "claude", outputDir, config, pluginName: "demo-plugin", prefix: "demo-", trusted: true, env })

  // Before any toggle: the shipped `disabled` server is not required by any agent, so the export omits it.
  bridge()
  assert.equal(fs.existsSync(path.join(outputDir, ".mcp.json")), false, "a disabled, unrequired server produces no .mcp.json")

  // The TUI's `togglePackMcpServer` resolves and writes exactly this target scope (App.tsx).
  const target = realpathThroughExistingAncestor(path.resolve(defaultTarget(env)))
  saveConfigOverride("demo", "mcp.servers", "cupertino", { command: ["cupertino-mcp", "standalone"], disabled: null }, { target, env })

  bridge()
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(outputDir, ".mcp.json"), "utf8")).mcpServers,
    { cupertino: { command: "cupertino-mcp", args: ["standalone"] } },
    "the TUI-written override (with its own command, disabled removed) reaches the re-exported bridge",
  )
})

test("prepareBridgeWorkspace returns only the requested pack's agents, parsed from the temp tree", (t) => {
  const catalog = writeCatalog(t)
  const workspace = prepareBridgeWorkspace(catalog, "app")
  t.after(workspace.cleanup)

  assert.deepEqual(workspace.agents.map(agent => agent.filename), ["app-orchestrator.md", "app-worker.md"])
  for (const agent of workspace.agents) {
    assert.equal(agent.category, "app")
    assert.ok(agent.currentPath.startsWith(`${workspace.root}${path.sep}`), agent.currentPath)
  }
  assert.equal(workspace.agents[0].frontmatter.mode, "primary")
})

test("prepareBridgeWorkspace cleanup removes the temp tree", (t) => {
  const catalog = writeCatalog(t)
  const workspace = prepareBridgeWorkspace(catalog, "app")
  workspace.cleanup()
  assert.equal(fs.existsSync(workspace.root), false)
})

test("prepareBridgeWorkspace rejects a missing requirement and files provided by two packs", (t) => {
  const missing = writeCatalog(t, { ...CATALOG, "packs/app/opencode-pack.json": manifest("app", { ghost: "^1.0.0" }) })
  assert.throws(() => prepareBridgeWorkspace(missing, "app"), /ghost/)
  assert.throws(() => prepareBridgeWorkspace(missing, "nope"), /nope/)

  const clash = writeCatalog(t, { ...CATALOG, "packs/extra/skills/base-writing/SKILL.md": "---\ndescription: Clash\n---\n" })
  assert.throws(() => prepareBridgeWorkspace(clash, "app"), /Packs '(base|extra)' and '(base|extra)' both provide 'skills\/base-writing\/SKILL\.md'/)
})

test("bridgePack mirrors the Claude plugin into an output directory outside the catalog", (t) => {
  const catalog = writeCatalog(t)
  const outputDir = path.join(tempDir(t, "bridge-workspace-out-"), "app-plugin")
  fs.mkdirSync(path.join(outputDir, "agents"), { recursive: true })
  fs.writeFileSync(path.join(outputDir, "agents", "stale.md"), "stale\n")
  fs.writeFileSync(path.join(outputDir, "notes.txt"), "stale\n")

  const result = bridgePack({ workspaceRoot: catalog, pack: "app", target: "claude", outputDir, config, pluginName: "app-plugin", prefix: "app-" })

  assert.equal(result.pluginDir, outputDir)
  assert.equal(result.orchestratorName, "orchestrator")
  assert.deepEqual([...result.files].sort(), listFiles(outputDir))
  assert.deepEqual(fs.readdirSync(path.join(outputDir, "agents")).sort(), ["orchestrator.md", "worker.md"])
  assert.equal(fs.existsSync(path.join(outputDir, "notes.txt")), false)
  assert.ok(fs.existsSync(path.join(outputDir, "skills", "extra-run", "SKILL.md")), "commands of required packs become skills")
  assert.ok(fs.existsSync(path.join(outputDir, "skills", "base-writing", "SKILL.md")), "skills of required packs are copied")
  const readme = fs.readFileSync(path.join(outputDir, "README.md"), "utf8")
  assert.match(readme, /plugins\/app-guard/)
  assert.match(readme, /tools\/lib\/lib_tool\.ts/)
  assert.match(readme, /claude plugin validate '\.\/app-plugin' --strict/)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(outputDir, ".mcp.json"), "utf8")).mcpServers), ["shared", "lib-only"])
})

test("bridgePack refuses untrusted executable packs without creating the output directory", (t) => {
  const catalog = writeCatalog(t)
  const outputDir = path.join(tempDir(t, "bridge-workspace-untrusted-out-"), "app-plugin")

  assert.throws(() => bridgePack({ workspaceRoot: catalog, pack: "app", target: "claude", outputDir, config, pluginName: "app-plugin", prefix: "app-", trusted: false }), /Refusing to bridge untrusted pack 'app' with executable content without confirmation \(--yes\)/)
  assert.equal(fs.existsSync(outputDir), false)
})

test("bridgePack allows untrusted executable packs after explicit confirmation", (t) => {
  const catalog = writeCatalog(t)
  const outputDir = path.join(tempDir(t, "bridge-workspace-confirmed-out-"), "app-plugin")

  bridgePack({ workspaceRoot: catalog, pack: "app", target: "claude", outputDir, config, pluginName: "app-plugin", prefix: "app-", trusted: false, allowUntrustedExecutable: true })

  assert.ok(fs.existsSync(path.join(outputDir, "README.md")))
})

test("bridgePack does not require confirmation for an untrusted markdown-only pack", (t) => {
  const catalog = writeCatalog(t, {
    "packs/docs/opencode-pack.json": manifest("docs"),
    "packs/docs/agents/docs-agent.md": agent("Documentation helper"),
    "packs/docs/README.md": "# docs\n"
  })
  const outputDir = path.join(tempDir(t, "bridge-workspace-markdown-out-"), "docs-plugin")

  bridgePack({ workspaceRoot: catalog, pack: "docs", target: "claude", outputDir, config, pluginName: "docs-plugin", prefix: "docs-", trusted: false })

  assert.ok(fs.existsSync(path.join(outputDir, "README.md")))
})

test("resolveBridgeWorkspaceTrust defaults unknown workspaces to untrusted and matches registered source roots", (t) => {
  const unregistered = writeCatalog(t)
  const untrusted = writeCatalog(t)
  const trusted = writeCatalog(t)
  const env = writeSourceRegistry(t, [
    { name: "untrusted-local", kind: "local", path: untrusted, trusted: false },
    { name: "trusted-local", kind: "local", path: trusted, trusted: true }
  ])

  assert.deepEqual(resolveBridgeWorkspaceTrust(unregistered, env), { trusted: false })
  assert.deepEqual(resolveBridgeWorkspaceTrust(untrusted, env), { trusted: false, sourceName: "untrusted-local" })
  assert.deepEqual(resolveBridgeWorkspaceTrust(path.join(trusted, "packs", "app"), env), { trusted: true, sourceName: "trusted-local" })
  const confirmations = bridgeConfirmationsNeeded(untrusted, "app", false, "untrusted-local")
  assert.ok(confirmations.length > 0)
  assert.ok(confirmations.every(reason => /untrusted source 'untrusted-local' pack '.*' contains executable content/.test(reason)))
})

test("bridgePack leaves unchanged files untouched on regeneration", (t) => {
  const catalog = writeCatalog(t)
  const outputDir = path.join(catalog, "bridges", "claude-code", "app-plugin")
  const options = { workspaceRoot: catalog, pack: "app", target: "claude", outputDir, config, pluginName: "app-plugin", prefix: "app-" } as const
  bridgePack(options)
  const agentPath = path.join(outputDir, "agents", "worker.md")
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(agentPath, past, past)

  bridgePack(options)

  assert.equal(fs.statSync(agentPath).mtimeMs, past.getTime())
  assert.match(fs.readFileSync(path.join(outputDir, "README.md"), "utf8"), /'\.\/bridges\/claude-code\/app-plugin'/)
})

test("bridgePack reports Codex files at the final output directory", (t) => {
  const catalog = writeCatalog(t)
  const outputDir = path.join(tempDir(t, "bridge-workspace-codex-"), "codex")

  const result = bridgePack({ workspaceRoot: catalog, pack: "app", target: "codex", outputDir, config, pluginName: "app-plugin", prefix: "app-" })

  assert.equal(result.pluginDir, outputDir)
  assert.deepEqual(result.files.map(file => path.relative(outputDir, file).split(path.sep).join("/")).sort(), listFiles(outputDir))
  assert.ok(fs.existsSync(path.join(outputDir, ".codex", "agents", "orchestrator.toml")))
})

test("bridgePack refuses output directories that contain the catalog or sit inside a pack", (t) => {
  const catalog = writeCatalog(t)
  const options = { workspaceRoot: catalog, pack: "app", target: "claude", config, pluginName: "app-plugin", prefix: "app-" } as const
  assert.throws(() => bridgePack({ ...options, outputDir: catalog }), /must not contain the catalog/)
  assert.throws(() => bridgePack({ ...options, outputDir: path.dirname(catalog) }), /must not contain the catalog/)
  assert.throws(() => bridgePack({ ...options, outputDir: path.join(catalog, "packs", "app", "out") }), /inside a pack/)
  assert.ok(fs.existsSync(path.join(catalog, "packs", "app", "agents", "app-worker.md")))
})

test("bridgePack refuses an output inside the catalog reached through a symlink", { skip: process.platform === "win32" }, (t) => {
  const catalog = writeCatalog(t)
  const outside = tempDir(t, "bridge-link-target-")
  fs.symlinkSync(outside, path.join(catalog, "bridges"))

  assert.throws(() => bridgePack({ workspaceRoot: catalog, pack: "app", target: "claude", config, pluginName: "app-plugin", prefix: "app-", outputDir: path.join(catalog, "bridges", "claude-code", "app-plugin") }), /goes through the symlink/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test("nested agent identities, custom tools and the declared primary survive both bridges", t => {
  const catalog = writeCatalog(t, {
    "collection/team/opencode-pack.json": manifest("editorial"),
    "collection/team/agents/desk.md": "---\ndescription: Desk editor\nmode: primary\n---\nDelegate to @news/review and use `edition_proof`.\n",
    "collection/team/agents/news/review.md": agent("News review"),
    "collection/team/agents/books/review.md": agent("Book review"),
    "collection/team/tools/editorial/edition_proof.mjs": "export default {}\n",
  })
  for (const target of ["claude", "codex"] as const) {
    const outputDir = path.join(catalog, "bridges", target, "press")
    const result = bridgePack({ workspaceRoot: catalog, pack: "editorial", target, outputDir, config, pluginName: "press", prefix: "", trusted: true })
    const agentsDir = target === "claude" ? path.join(outputDir, "agents") : path.join(outputDir, ".codex", "agents")
    const ext = target === "claude" ? ".md" : ".toml"
    for (const name of ["news-review", "books-review"]) assert.ok(fs.existsSync(path.join(agentsDir, name + ext)), name)
    const desk = fs.readFileSync(path.join(agentsDir, "desk" + ext), "utf8")
    assert.ok(desk.includes(target === "claude" ? "@press:news-review" : "@news-review"))
    assert.ok(desk.includes("**not available** in this environment: `edition_proof`"))
    assert.equal("plugin" in result ? result.plugin.orchestratorName : result.orchestratorName, "desk")
  }
})
