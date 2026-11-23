import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  bridgeToCodex,
  codexNextSteps,
  resolveCodexModel,
  writeCodexPlugin,
} from "./codexBridge.js"
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from "./translationConfig.js"
import type { AgentInfo } from "./agents.js"

function agent(
  filename: string,
  model: string,
  frontmatter: Record<string, any>,
  body: string,
  allowedSubagents: string[] = []
): AgentInfo {
  return {
    filename,
    currentPath: filename,
    targetPath: filename,
    category: "test",
    description: `${filename} description`,
    model,
    rawContent: body,
    frontmatter,
    body,
    allowedSubagents
  }
}

test("Codex roles map planning to Sol/high and execution to Luna/max", () => {
  const primary = agent("orchestrator.md", "github-copilot/claude-opus-5", { mode: "primary" }, "")
  const opus = agent("reviewer.md", "github-copilot/claude-opus-5", {}, "")
  const luna = agent("explorer.md", "github-copilot/gpt-5.6-luna", {}, "")

  assert.deepEqual(resolveCodexModel(primary), { model: "gpt-5.6-sol", reasoningEffort: "high" })
  assert.deepEqual(resolveCodexModel(opus), { model: "gpt-5.6-luna", reasoningEffort: "max" })
  assert.deepEqual(resolveCodexModel(luna), { model: "gpt-5.6-luna", reasoningEffort: "max" })
})

test("bridge emits manifest, Codex agents, skills and translated links", () => {
  const agents = [
    agent(
      "pipeline-orchestrator.md",
      "github-copilot/claude-opus-5",
      { mode: "primary", permission: { task: { "pipeline-fast_lane": "allow" } } },
      "Delegate to @pipeline-fast_lane; do not call @pipeline-missing.",
      ["pipeline-fast_lane"]
    ),
    agent("pipeline-fast_lane.md", "github-copilot/gpt-5.6-luna", {}, "Fast lane")
  ]
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex(agents, "Decent Pipeline", "pipeline-", output, workspace)

  assert.equal(result.plugin.pluginName, "decent-pipeline")
  assert.equal(result.plugin.orchestratorName, "orchestrator")
  assert.equal(result.plugin.agents[0].model, "gpt-5.6-sol")
  assert.equal(result.plugin.agents[0].modelReasoningEffort, "high")
  assert.equal(result.plugin.agents[0].sandboxMode, "read-only")
  assert.equal(result.plugin.agents[1].model, "gpt-5.6-luna")
  assert.equal(result.plugin.agents[1].modelReasoningEffort, "max")
  assert.ok(result.warnings.some(warning => warning.includes("unresolved agent reference @pipeline-missing")))

  const manifestPath = path.join(output, ".codex-plugin", "plugin.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  assert.equal(manifest.name, "decent-pipeline")
  assert.equal(manifest.author.name, "manage-agents")
  assert.equal(manifest.skills, "./.agents/skills/")
  const marketplace = JSON.parse(fs.readFileSync(path.join(output, ".agents", "plugins", "marketplace.json"), "utf8"))
  assert.equal(marketplace.name, "decent-pipeline-local")
  assert.deepEqual(marketplace.plugins[0].source, { source: "local", path: "./" })

  const orchestratorToml = fs.readFileSync(path.join(output, ".codex", "agents", "orchestrator.toml"), "utf8")
  assert.match(orchestratorToml, /model = "gpt-5\.6-sol"/)
  assert.match(orchestratorToml, /model_reasoning_effort = "high"/)
  assert.match(orchestratorToml, /@fast-lane/)
  assert.equal(fs.readFileSync(path.join(output, ".codex", "config.toml"), "utf8"), "[agents]\nmax_depth = 2\n")
  assert.ok(fs.existsSync(path.join(output, manifest.skills, "orchestrator", "SKILL.md")))
  assert.match(codexNextSteps(result)[1], /delegate the task to the orchestrator subagent/)
  assert.equal(codexNextSteps({ ...result, pluginDir: "/my project's bridge" })[0], `  codex -C '/my project'"'"'s bridge'`)
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /Source and configuration/)
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /`bridges\/translation-config\.json`/)
  assert.doesNotMatch(fs.readFileSync(path.join(output, "README.md"), "utf8"), /\.agent-manager|`src\/`|general\//)
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /Do not edit this directory directly/)
})

test("Codex README stays generic for non-Copilot categories", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-category-"))
  const output = path.join(workspace, "bridges", "codex")
  bridgeToCodex([agent("docs-orchestrator.md", "any", { mode: "primary" }, "")], "docs", "docs-", output, workspace)
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /canonical source agents/)
  assert.doesNotMatch(readme, /Copilot pipeline/)
})

test("role targets can be overridden without changing source agents", () => {
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    tiers: { ...DEFAULT_TRANSLATION_CONFIG.tiers,
      planning: { ...DEFAULT_TRANSLATION_CONFIG.tiers.planning, codex: { model: "custom-primary", reasoningEffort: "xhigh" } },
      execution: { ...DEFAULT_TRANSLATION_CONFIG.tiers.execution, codex: { model: "custom-default", reasoningEffort: "low" } } },
    codex: { ...DEFAULT_TRANSLATION_CONFIG.codex, emitSkills: false, emitReadme: false }
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-config-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex([
    agent("orchestrator.md", "any", { mode: "primary" }, ""),
    agent("worker.md", "different", {}, "")
  ], "configured", "", output, workspace, config)

  assert.equal(result.plugin.agents[0].model, "custom-primary")
  assert.equal(result.plugin.agents[1].model, "custom-default")
  assert.equal(result.plugin.skills.length, 0)
  assert.ok(!fs.existsSync(path.join(output, "README.md")))
  assert.ok(!fs.existsSync(path.join(output, ".agents")))
})

test("Codex inherit in a tier, mapping or override leaves model and effort to the caller", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-inherit-"))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const inherited = { model: "inherit", reasoningEffort: "high" }
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    tiers: { ...DEFAULT_TRANSLATION_CONFIG.tiers,
      planning: { ...DEFAULT_TRANSLATION_CONFIG.tiers.planning, codex: inherited } },
    codex: { ...DEFAULT_TRANSLATION_CONFIG.codex,
      overrides: { reviewer: inherited }, modelMap: { "source/light": "inherit" } }
  }
  const agents = [
    agent("planner.md", "", { mode: "primary" }, ""),
    agent("research.md", "source/light", {}, ""),
    agent("reviewer.md", "", {}, ""),
  ]
  const output = path.join(workspace, "generated")
  const result = bridgeToCodex(agents, "test", "", output, workspace, config)
  assert.deepEqual(result.preview.map(({ source, model }) => [source, model]), [
    ["role", "inherit"], ["model-map", "inherit"], ["override", "inherit"],
  ])
  for (const translated of result.plugin.agents) {
    assert.equal(translated.modelReasoningEffort, undefined)
    const toml = fs.readFileSync(path.join(output, ".codex/agents", translated.filename), "utf8")
    assert.doesNotMatch(toml, /^model(?:_reasoning_effort)?\s*=/m)
  }
  assert.equal(fs.readFileSync(path.join(output, ".codex/config.toml"), "utf8"), "[agents]\nmax_depth = 2\n")
})

test("codex.modelMap maps the source model into the emitted TOML without a reasoning effort", () => {
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    codex: {
      ...DEFAULT_TRANSLATION_CONFIG.codex,
      modelMap: { "deepseek-v4.1-flash": "gpt-5.6-luna" },
      emitSkills: false,
      emitReadme: false
    }
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-model-map-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex(
    [agent("executor.md", "deepseek/deepseek-v4.1-flash", {}, "")],
    "mapped", "", output, workspace, config
  )

  assert.equal(result.preview[0].source, "model-map")
  assert.equal(result.plugin.agents[0].model, "gpt-5.6-luna")
  assert.equal(result.plugin.agents[0].modelReasoningEffort, undefined)
  const toml = fs.readFileSync(path.join(output, ".codex", "agents", "executor.toml"), "utf8")
  assert.match(toml, /model = "gpt-5\.6-luna"/)
  assert.doesNotMatch(toml, /model_reasoning_effort/)
  assert.ok(!result.warnings.some(warning => warning.startsWith("[model-map]")))
})

test("codex.modelMap catch-all applies to unmapped models and specific keys win", () => {
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    codex: {
      ...DEFAULT_TRANSLATION_CONFIG.codex,
      modelMap: { "*": "gpt-5.6-sol", "deepseek-v4.1-flash": "gpt-5.6-luna" },
      emitSkills: false,
      emitReadme: false
    }
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-model-map-catch-all-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex([
    agent("planner.md", "unknown/model-x", {}, ""),
    agent("executor.md", "deepseek-v4.1-flash", {}, "")
  ], "mapped", "", output, workspace, config)

  assert.equal(result.plugin.agents[0].model, "gpt-5.6-sol")
  assert.equal(result.plugin.agents[1].model, "gpt-5.6-luna")
  assert.deepEqual(result.preview.map(entry => entry.source), ["model-map", "model-map"])
})

test("codex.modelMap dead keys are reported as translation warnings", () => {
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    codex: {
      ...DEFAULT_TRANSLATION_CONFIG.codex,
      modelMap: { "missing-model": "gpt-5.6-luna" },
      emitSkills: false
    }
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-model-map-dead-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex(
    [agent("orchestrator.md", "deepseek-v4.1-flash", { mode: "primary" }, "")],
    "mapped", "", output, workspace, config
  )

  const expected = '[model-map] entry "missing-model" matches no source agent model'
  assert.ok(result.warnings.includes(expected))
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /\[model-map\] entry "missing-model" matches no source agent model/)
})

test("permissions.shell and permissions.bash produce the same sandbox decision", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-shell-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex([
    agent("bash-agent.md", "any", { permission: { bash: "allow" } }, ""),
    agent("shell-agent.md", "any", { permission: { shell: "allow" } }, ""),
    agent("denied-shell-agent.md", "any", { permission: { shell: "deny" } }, "")
  ], "sandbox", "", output, workspace, {
    ...DEFAULT_TRANSLATION_CONFIG,
    codex: { ...DEFAULT_TRANSLATION_CONFIG.codex, emitSkills: false, emitReadme: false }
  })

  assert.equal(result.plugin.agents[0].sandboxMode, "workspace-write")
  assert.equal(result.plugin.agents[1].sandboxMode, result.plugin.agents[0].sandboxMode)
  assert.equal(result.plugin.agents[2].sandboxMode, "read-only")
})

test("file-manipulation permission aliases enable workspace-write", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-edit-aliases-"))
  const output = path.join(workspace, "bridges", "codex")
  const aliases = ["apply_patch", "patch", "multiedit"]
  const result = bridgeToCodex(
    aliases.map(key => agent(`${key}.md`, "any", { permission: { [key]: "allow" } }, "")),
    "sandbox", "", output, workspace,
    { ...DEFAULT_TRANSLATION_CONFIG, codex: { ...DEFAULT_TRANSLATION_CONFIG.codex, emitSkills: false, emitReadme: false } }
  )

  assert.deepEqual(result.plugin.agents.map(entry => entry.sandboxMode), ["workspace-write", "workspace-write", "workspace-write"])
})

test("V1 spellings inside a V2 permissions array do not flip the sandbox to workspace-write", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-fail-closed-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex([
    agent("legacy-actions.md", "any", { permissions: [
      { action: "bash", resource: "*", effect: "allow" },
      { action: "write", resource: "*", effect: "allow" },
      { action: "execute", resource: "*", effect: "allow" },
      { action: "list", resource: "*", effect: "allow" }
    ] }, "")
  ], "sandbox", "", output, workspace, {
    ...DEFAULT_TRANSLATION_CONFIG,
    codex: { ...DEFAULT_TRANSLATION_CONFIG.codex, emitSkills: false, emitReadme: false }
  })

  assert.equal(result.plugin.agents[0].sandboxMode, "read-only", "a V1 spelling used as a V2 action must grant nothing")
})

test("Codex plugin mirrors enabled MCP servers in a valid companion layer", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-mcp-"))
  fs.writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({
    mcp: {
      docs: { command: ["docs-mcp", "--stdio"], enabled: true },
      cupertino: { command: ["cupertino", "serve"], enabled: false }
    }
  }))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex([
    agent("orchestrator.md", "any", {
      mode: "primary",
      permission: { "cupertino_*": "allow" }
    }, "")
  ], "configured", "", output, workspace)
  const manifest = JSON.parse(fs.readFileSync(path.join(output, ".codex-plugin", "plugin.json"), "utf8"))
  assert.equal(manifest.mcpServers, "./.mcp.json")
  const mcp = JSON.parse(fs.readFileSync(path.join(output, ".mcp.json"), "utf8"))
  assert.deepEqual(Object.keys(mcp.mcpServers), ["docs", "cupertino"])
  const projectConfig = fs.readFileSync(path.join(output, ".codex", "config.toml"), "utf8")
  assert.match(projectConfig, /\[mcp_servers\."docs"\]\ncommand = "docs-mcp"\nargs = \["--stdio"\]/)
  assert.match(projectConfig, /\[mcp_servers\."cupertino"\]/)
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /## MCP setup/)
  assert.ok(result.files.some(file => file.split(path.sep).join("/").endsWith("/.mcp.json")))
})

test("Codex exports MCP credentials by environment name and preserves tool denies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-settings-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "opencode.jsonc"), `// MCP settings
  ${JSON.stringify({ mcp: { servers: {
    local_docs: {
      type: "local", command: ["docs-mcp", "two words"], disabled: true,
      environment: { DOCS_KEY: "{env:DOCS_KEY}", ALIAS_KEY: "{env:ORIGINAL_KEY}", LANGUAGE: "en" }
    },
    remote_docs: {
      type: "remote", url: "https://example.test/mcp", timeout: 2500,
      headers: { Authorization: "Bearer {env:DOCS_TOKEN}", "X-Account": "{env:DOCS_ACCOUNT}", Accept: "application/json" }
    }
  } } })}`)
  const worker = agent("worker.md", "any", { permission: {
    "local_docs_*": "allow", local_docs_remove_record: "deny"
  } }, "")
  const output = path.join(root, "codex")
  const result = bridgeToCodex([worker], "test", "", output, root)
  const { mcpServers } = JSON.parse(fs.readFileSync(path.join(output, ".mcp.json"), "utf8"))
  assert.deepEqual(mcpServers.local_docs, {
    command: "docs-mcp", args: ["two words"], env: { LANGUAGE: "en" },
    env_vars: ["DOCS_KEY", "ALIAS_KEY"], disabled_tools: ["remove_record"]
  })
  assert.deepEqual(mcpServers.remote_docs, {
    url: "https://example.test/mcp", bearer_token_env_var: "DOCS_TOKEN",
    env_http_headers: { "X-Account": "DOCS_ACCOUNT" }, http_headers: { Accept: "application/json" }, tool_timeout_sec: 2.5
  })
  const projectConfig = fs.readFileSync(path.join(output, ".codex", "config.toml"), "utf8")
  assert.match(projectConfig, /disabled_tools = \["remove_record"\]/)
  assert.match(projectConfig, /env_http_headers = \{ "X-Account" = "DOCS_ACCOUNT" \}/)
  assert.ok(result.warnings.some(warning => warning.includes("'ALIAS_KEY'")))
  assert.ok(result.warnings.some(warning => warning.includes("entire Codex session")))

  const deny = agent("reviewer.md", "any", { permission: { "local_docs_*": "deny" } }, "")
  assert.throws(() => bridgeToCodex([worker, deny], "test", "", path.join(root, "denied"), root), /deny pattern Codex cannot enforce/)
  const noMcp = path.join(root, "without-mcp")
  bridgeToCodex([worker, deny], "test", "", noMcp, root, {
    ...DEFAULT_TRANSLATION_CONFIG,
    codex: { ...DEFAULT_TRANSLATION_CONFIG.codex, emitMcp: false, emitSkills: false }
  })
  assert.ok(!fs.existsSync(path.join(noMcp, ".mcp.json")))
  assert.ok(!fs.existsSync(path.join(noMcp, ".codex", "config.toml")))
})

test("Codex detects collisions before writing the generated project", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-collision-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const output = path.join(root, "codex")
  assert.throws(() => bridgeToCodex([
    agent("docs-review_code.md", "any", {}, ""),
    agent("docs-review-code.md", "any", {}, "")
  ], "docs", "docs-", output, root), /Multiple agents map to the Codex name 'review-code'/)
  assert.ok(!fs.existsSync(output))
})

test("translates V1 and V2 OpenCode MCP declarations to the same Codex .mcp.json", () => {
  const build = (mcp: Record<string, any>) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-mcp-shape-"))
      fs.writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({ mcp }))
    const output = path.join(workspace, "codex")
    bridgeToCodex([agent("orchestrator.md", "any", { mode: "primary" }, "")], "configured", "", output, workspace)
    return JSON.parse(fs.readFileSync(path.join(output, ".mcp.json"), "utf8"))
  }

  const v1 = build({
    "codebase-memory-mcp": { type: "local", command: ["codebase-memory-mcp"], enabled: true },
    "remote-tool": { type: "remote", url: "https://example.test/mcp", enabled: true }
  })
  const v2 = build({
    servers: {
      "codebase-memory-mcp": { type: "local", command: ["codebase-memory-mcp"] },
      "remote-tool": { type: "remote", url: "https://example.test/mcp" }
    }
  })

  assert.deepEqual(v1, v2)
  assert.deepEqual(Object.keys(v1.mcpServers), ["codebase-memory-mcp", "remote-tool"])
})

test("renderCodexMcpSetup formats remote URL MCP servers without empty command install instructions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mcp-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "opencode.json"), JSON.stringify({
    mcp: { servers: { bigquery: { type: "remote", url: "https://bigquery.googleapis.com/mcp" } } }
  }))
  const orchestrator = agent("orchestrator.md", "any", { mode: "primary", permission: { "bigquery_*": "allow" } }, "")
  const output = path.join(root, "codex")

  bridgeToCodex([orchestrator], "test", "", output, root)

  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.deepEqual({
    includesRemoteUrl: /https:\/\/bigquery\.googleapis\.com\/mcp/.test(readme),
    hasNoLocalInstallInstructions: !/install |command -v /.test(readme)
  }, { includesRemoteUrl: true, hasNoLocalInstallInstructions: true })
})

test("writeCodexPlugin rejects output directories escaping the workspace root", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-ws-"))
  const tmpParent = path.dirname(workspace)
  const escapeTarget = path.join(tmpParent, "codex-bridge-escape-target")
  const escapingOutput = path.join(workspace, "bridges", "..", "..", "codex-bridge-escape-target")
  const agents = [agent("orchestrator.md", "any", { mode: "primary" }, "")]

  assert.throws(
    () => writeCodexPlugin(agents, "decent-pipeline", "", escapingOutput, workspace, DEFAULT_TRANSLATION_CONFIG),
    /outside workspace/i
  )
  // The caller wiring (index.tsx) forwards workspaceRoot through bridgeToCodex.
  assert.throws(
    () => bridgeToCodex(agents, "decent-pipeline", "", escapingOutput, workspace),
    /outside workspace/i
  )
  assert.ok(!fs.existsSync(escapeTarget), "no plugin files may be written outside the workspace")
})

test("writeCodexPlugin still writes the manifest for output inside the workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-ws-"))
  const output = path.join(workspace, "bridges", "codex", "decent-pipeline")
  const result = writeCodexPlugin(
    [agent("orchestrator.md", "any", { mode: "primary" }, "")],
    "decent-pipeline",
    "",
    output,
    workspace,
    DEFAULT_TRANSLATION_CONFIG
  )

  const manifestPath = path.join(output, ".codex-plugin", "plugin.json")
  assert.ok(fs.existsSync(manifestPath))
  // pluginDir is resolved through fs.realpathSync, so compare real paths
  // (os.tmpdir() is a symlink on macOS).
  assert.ok(result.files.includes(fs.realpathSync(manifestPath)))
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).name, "decent-pipeline")
})

test("writeCodexPlugin requires a workspaceRoot", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-legacy-"))
  assert.throws(
    () => (writeCodexPlugin as any)([agent("orchestrator.md", "any", { mode: "primary" }, "")], "legacy-plugin", "", output),
    /workspaceRoot/i
  )
})

test("writeCodexPlugin rejects an empty agent list", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-agents-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () => writeCodexPlugin([], "test", "", path.join(root, "codex"), root),
    /no agents/i
  )
})

test("writeCodexPlugin refuses a symlinked output pointing outside the workspace", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-symlink-ws-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-symlink-out-"))
  fs.symlinkSync(outside, path.join(workspace, "out"), "dir")
  assert.throws(
    () => writeCodexPlugin([agent("orchestrator.md", "any", { mode: "primary" }, "")], "decent-pipeline", "", path.join(workspace, "out"), workspace),
    /outside workspace/i
  )
  assert.equal(fs.readdirSync(outside).length, 0)
})

test("Codex bridge translates OpenCode tool names and flags OpenCode-only tools once", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-tools-"))
  const output = path.join(workspace, "bridges", "codex")
  fs.mkdirSync(path.join(workspace, "tools", "extra"), { recursive: true })
  for (const name of ["pipeline_state", "dev_env"]) fs.writeFileSync(path.join(workspace, "tools", "extra", `${name}.js`), "export default {}")
  const body = "# Orchestrator\n\nUse `todowrite` to track work. Call `pipeline_state` if it is available; otherwise use the fallback.\nAsk the user (use `question`) and launch two Task calls in one turn.\nRun dev_env before smoke tests."
  const orchestrator = agent("pipeline-orchestrator.md", "any", { mode: "primary", permission: { pipeline_state: "allow", pipeline_commit: "deny", todowrite: "allow", bash: { "*": "deny", "git status*": "allow", "rm *": "ask" } } }, body)
  const result = bridgeToCodex([orchestrator], "decent-pipeline", "pipeline-", output, workspace)
  const instructions = result.plugin.agents[0].developerInstructions
  assert.match(instructions, /^# Orchestrator\n\n> \*\*Runtime note \(OpenCode bridge\)\.\*\*/)
  assert.match(instructions, /not available\*\* in this environment: `dev_env`, `pipeline_state`\./)
  assert.doesNotMatch(instructions, /pipeline_commit/)
  assert.match(instructions, /Use `update_plan` to track work/)
  assert.match(instructions, /`question`: ask the user directly/)
  assert.match(instructions, /`task`: delegate to the Codex subagents/)
  assert.equal(instructions.match(/Runtime note \(OpenCode bridge\)/g)?.length, 1)
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /## Per-agent bash allowlists \(not enforced\)/)
  assert.match(readme, /- allow: `git status\*`/)
  assert.match(readme, /- ask: `rm \*`/)
})

test("Codex bridge never treats pipeline tool or built-in permission keys as MCP servers", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-mcp-keys-"))
  fs.writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({ mcp: {
    pipeline: { command: ["fake-pipeline"], enabled: false },
    apply: { command: ["fake-apply"], enabled: false },
    patch: { command: ["fake-patch"], enabled: false },
    multiedit: { command: ["fake-multiedit"], enabled: false },
    list: { command: ["fake-list"], enabled: false },
    external: { command: ["fake-external"], enabled: false },
    "cwe-search": { command: ["cwe"], enabled: false }
  } }))
  const output = path.join(workspace, "bridges", "codex")
  const auditor = agent("pipeline-security_auditor.md", "any", { permission: {
    dev_env: "allow", apply_patch: "allow", patch: "allow", multiedit: "allow", list: "allow",
    external_directory: { "*": "deny" }, "cwe-search_*": "allow"
  } }, "Tools are prefixed: `cwe-search_get_cwe_weakness`.")
  bridgeToCodex([auditor], "decent-pipeline", "pipeline-", output, workspace)
  const mcp = JSON.parse(fs.readFileSync(path.join(output, ".mcp.json"), "utf8")).mcpServers
  assert.deepEqual(Object.keys(mcp).filter(name => mcp[name].enabled !== false), ["cwe-search"])
})

test("Codex bridge never treats known tool permission keys as MCP servers", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-known-keys-"))
  fs.writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({ mcp: {
    opencode: { command: ["fake-opencode"], enabled: false }
  } }))
  const output = path.join(workspace, "bridges", "codex")
  // `isMcpPermissionKey` is internal to codexBridge.ts, so this asserts its
  // classification through the emitted .mcp.json companion layer.
  const executor = agent("pipeline-executor.md", "any", { permission: {
    opencode_session_rename: "allow"
  } }, "")

  bridgeToCodex([executor], "decent-pipeline", "pipeline-", output, workspace)

  const mcpPath = path.join(output, ".mcp.json")
  assert.equal(JSON.parse(fs.readFileSync(mcpPath, "utf8")).mcpServers.opencode.enabled, false)
})
