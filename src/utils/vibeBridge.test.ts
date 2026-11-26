import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  bridgeToVibe,
  normalizeVibeAgentName,
  renderVibeAgentProfileToml,
  renderVibeAgentToml,
  resolveVibeModel,
  validateVibePluginName,
  vibeNextSteps,
  vibePluginNameValue,
  writeVibePlugin,
} from "./vibeBridge.js"
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

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-bridge-"))
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return root
}

test("Vibe roles map planning to mistral-large-4 and execution to mistral-medium-3.5", () => {
  const primary = agent("orchestrator.md", "github-copilot/claude-opus-5", { mode: "primary" }, "")
  const opus = agent("reviewer.md", "github-copilot/claude-opus-5", {}, "")
  const luna = agent("explorer.md", "github-copilot/gpt-5.6-luna", {}, "")
  const config = DEFAULT_TRANSLATION_CONFIG
  assert.deepEqual(resolveVibeModel(primary, [primary, opus, luna], config), { model: "mistral-large-4" })
  // The unmapped reviewer inherits the primary's planning tier by model inference.
  assert.deepEqual(resolveVibeModel(opus, [primary, opus, luna], config), { model: "mistral-large-4" })
  assert.deepEqual(resolveVibeModel(luna, [primary, opus, luna], config), { model: "mistral-medium-3.5" })
})

test("Vibe inherit overrides omit activeModel", () => {
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    vibe: { ...DEFAULT_TRANSLATION_CONFIG.vibe, overrides: { orchestrator: { model: "inherit" } } }
  }
  const primary = agent("orchestrator.md", "github-copilot/claude-opus-5", { mode: "primary" }, "")
  assert.deepEqual(resolveVibeModel(primary, [primary], config), { model: null })
})

test("plugin names follow the Agent Plugins 1.0 rule", () => {
  assert.equal(normalizeVibeAgentName("pipeline-fast_lane.md", "pipeline-"), "fast-lane")
  assert.equal(normalizeVibeAgentName("My Agent.md", ""), "my-agent")
  assert.equal(vibePluginNameValue("Decent Pipeline"), "decent-pipeline")
  validateVibePluginName("decent-pipeline")
  validateVibePluginName("a.b2")
  assert.throws(() => validateVibePluginName("bad--name"), /Invalid Vibe plugin name/)
  assert.throws(() => validateVibePluginName("../escape"), /Invalid Vibe plugin name/)
  assert.throws(() => validateVibePluginName("-lead"), /Invalid Vibe plugin name/)
})

test("renderVibeAgentToml emits underscore-spelled subagent profiles with tool narrowing", () => {
  const toml = renderVibeAgentToml({
    name: "explorer",
    filename: "explorer.toml",
    description: "Read-only explorer",
    displayName: "Explorer",
    mode: "subagent",
    safety: "safe",
    model: "mistral-medium-3.5",
    instructions: "Explore read-only.",
    deniedTools: ["bash", "write_file"],
    askTools: ["edit"],
    allowedSubagents: ["pack:helper"]
  }, "pack")
  assert.match(toml, /schema_version = 1/)
  assert.match(toml, /agent_type = "subagent"/)
  assert.match(toml, /display_name = "Explorer"/)
  assert.match(toml, /description = "Read-only explorer"/)
  assert.match(toml, /safety = "safe"/)
  assert.match(toml, /active_model = "mistral-medium-3\.5"/)
  assert.match(toml, /instructions = "Explore read-only\."/)
  assert.match(toml, /\[tools\.bash\]\npermission = "never"/)
  assert.match(toml, /\[tools\.write_file\]\npermission = "never"/)
  assert.match(toml, /\[tools\.edit\]\npermission = "ask"/)
  // The Vibe runtime rejects any camelCase spelling of these keys.
  assert.doesNotMatch(toml, /schemaVersion/)
  assert.doesNotMatch(toml, /agentType/)
  assert.doesNotMatch(toml, /displayName/)
  assert.doesNotMatch(toml, /activeModel/)
  // An inherited model is simply omitted.
  const inherit = renderVibeAgentToml({
    name: "x", filename: "x.toml", description: "d", displayName: "X", mode: "subagent",
    safety: "neutral", model: null, instructions: "", deniedTools: [], askTools: [], allowedSubagents: []
  }, "pack")
  assert.doesNotMatch(inherit, /active_model/)
})

test("renderVibeAgentProfileToml emits a main agent profile without subagent keys", () => {
  const toml = renderVibeAgentProfileToml({
    fileName: "pack-lead.toml",
    agent: {
      name: "lead", filename: "lead.toml", description: "Leads the work", displayName: "Lead",
      mode: "primary", safety: "neutral", model: "mistral-large-4",
      instructions: "Lead it.", deniedTools: ["bash"], askTools: ["edit"], allowedSubagents: ["pack:helper"]
    }
  }, "pack")
  assert.match(toml, /Generated by manage-agents — OpenCode to Mistral Vibe agent profile bridge \(pack\)/)
  assert.match(toml, /display_name = "Lead"/)
  assert.match(toml, /description = "Leads the work"/)
  assert.match(toml, /active_model = "mistral-large-4"/)
  assert.match(toml, /instructions = "Lead it\."/)
  assert.match(toml, /\[tools\.bash\]\npermission = "never"/)
  assert.match(toml, /\[tools\.edit\]\npermission = "ask"/)
  // A main agent is not a subagent: no agent_type, and safety is a config issue there.
  assert.doesNotMatch(toml, /agent_type/)
  assert.doesNotMatch(toml, /safety/)
  assert.doesNotMatch(toml, /schema_version/)
  // An inherited model is simply omitted.
  const inherit = renderVibeAgentProfileToml({
    fileName: "pack-x.toml",
    agent: {
      name: "x", filename: "x.toml", description: "d", displayName: "X", mode: "primary",
      safety: "neutral", model: null, instructions: "", deniedTools: [], askTools: [], allowedSubagents: []
    }
  }, "pack")
  assert.doesNotMatch(inherit, /active_model/)
})

const FULL_WORKSPACE_FILES = (): Record<string, string> => ({
  "opencode.json": JSON.stringify({
    mcp: {
      servers: {
        "server-one": { type: "local", command: ["npx", "-y", "server-one@latest"] },
        "server-two": { type: "local", command: ["binary-cli", "mcp"], disabled: true },
        "server-remote": { type: "remote", url: "https://example.com/mcp" }
      }
    }
  }),
  "commands/pipeline-research.md": [
    "---",
    "description: Research only",
    "agent: pipeline-orchestrator",
    "---",
    "",
    "Question (research only): $ARGUMENTS",
    "",
    "- Run `!`git status --short`` first.",
    "- Reference the sibling orchestrator agent."
  ].join("\n"),
  "skills/antipatterns/SKILL.md": "---\nname: antipatterns\ndescription: Catalog of anti-patterns.\n---\n\nAnti-patterns here.\n",
  "skills/antipatterns/references/band-aid-fix.md": "Band-aid fix content.\n"
})

const FULL_AGENTS = (): AgentInfo[] => [
  agent(
    "pipeline-orchestrator.md",
    "github-copilot/claude-opus-5",
    {
      mode: "primary",
      permissions: [
        { action: "read", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "task", resource: "pipeline-explorer", effect: "allow" }
      ]
    },
    "Delegate to @pipeline-explorer; use `todowrite`, `question` and the Task tool when needed.",
    ["pipeline-explorer"]
  ),
  agent(
    "pipeline-explorer.md",
    "github-copilot/gpt-5.6-luna",
    {
      mode: "subagent",
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" }
      ]
    },
    "Fast read-only explorer."
  )
]

test("bridge emits a Vibe plugin package: manifest, subagents, skills and MCP", () => {
  const agents = FULL_AGENTS()
  const workspace = makeWorkspace(FULL_WORKSPACE_FILES())
  const output = path.join(workspace, "bridges", "vibe")
  const result = bridgeToVibe(agents, "Decent Pipeline", "pipeline-", output, workspace)

  assert.equal(result.plugin.pluginName, "decent-pipeline")
  assert.equal(result.plugin.orchestratorName, "orchestrator")
  assert.equal(result.plugin.agents.length, 2)
  assert.deepEqual(result.plugin.skills.sort(), ["antipatterns", "pipeline-research"])

  // plugin.json manifest
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "plugin.json"), "utf8"))
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
  assert.equal(manifest.name, "decent-pipeline")
  assert.equal(manifest.extensions["ai.mistral.vibe"].schemaVersion, 1)
  assert.equal(manifest.extensions["ai.mistral.vibe"].displayName, "Decent Pipeline")

  // Agent TOML profiles in ai.mistral.vibe/agents/
  const orchestratorToml = fs.readFileSync(path.join(output, "ai.mistral.vibe", "agents", "orchestrator.toml"), "utf8")
  const explorerToml = fs.readFileSync(path.join(output, "ai.mistral.vibe", "agents", "explorer.toml"), "utf8")
  // Every plugin agent is a spawnable subagent, including the primary.
  assert.match(explorerToml, /agent_type = "subagent"/)
  assert.match(explorerToml, /active_model = "mistral-medium-3\.5"/)
  assert.match(orchestratorToml, /active_model = "mistral-large-4"/)
  assert.match(explorerToml, /display_name = "Explorer"/)
  // The read-only explorer is safe; the orchestrator is neutral.
  assert.match(explorerToml, /safety = "safe"/)
  assert.match(orchestratorToml, /safety = "neutral"/)
  // The catch-all deny narrows the tools the explorer never allows.
  assert.match(explorerToml, /\[tools\.bash\]\npermission = "never"/)
  assert.match(explorerToml, /\[tools\.write_file\]\npermission = "never"/)
  assert.match(explorerToml, /\[tools\.edit\]\npermission = "never"/)
  assert.doesNotMatch(explorerToml, /permission = "ask"/)
  // Body rewrites: plugin-scoped delegation, tool renames.
  assert.match(orchestratorToml, /@decent-pipeline:explorer/)
  assert.match(orchestratorToml, /`todo`/)
  assert.match(orchestratorToml, /`ask_user_question`/)
  assert.match(orchestratorToml, /agents\.spawn/)
  assert.match(orchestratorToml, /## Delegation targets/)
  // Delegation protocol: config_name exactness and the capability contract.
  assert.match(orchestratorToml, /## Native Vibe delegation protocol/)
  assert.match(orchestratorToml, /- `decent-pipeline:explorer`/)
  assert.match(orchestratorToml, /no MCP or connector tools/)
  // The primary is emitted as a subagent and as a main agent profile, not an error.
  assert.ok(result.warnings.some(warning => /mode 'primary' emitted as spawnable subagent/.test(warning) && warning.includes("decent-pipeline:orchestrator") && warning.includes("decent-pipeline-orchestrator")))
  assert.equal(result.plugin.profiles.length, 1)
  assert.equal(result.plugin.profiles[0].fileName, "decent-pipeline-orchestrator.toml")
  const profileToml = fs.readFileSync(path.join(output, "agent-profiles", "decent-pipeline-orchestrator.toml"), "utf8")
  assert.match(profileToml, /display_name = "Orchestrator"/)
  assert.match(profileToml, /active_model = "mistral-large-4"/)
  assert.match(profileToml, /## Native Vibe delegation protocol/)
  assert.doesNotMatch(profileToml, /^agent_type =/m)
  assert.doesNotMatch(profileToml, /^safety =/m)

  // mcp.json: enabled servers only; disabled omitted with a warning.
  const mcp = JSON.parse(fs.readFileSync(path.join(output, "mcp.json"), "utf8"))
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json")
  assert.equal(mcp.mcpServers["server-one"].type, "stdio")
  assert.equal(mcp.mcpServers["server-one"].command, "npx")
  assert.deepEqual(mcp.mcpServers["server-one"].args, ["-y", "server-one@latest"])
  assert.equal(mcp.mcpServers["server-remote"].type, "streamable-http")
  assert.equal(mcp.mcpServers["server-remote"].url, "https://example.com/mcp")
  assert.equal(Object.hasOwn(mcp.mcpServers, "server-two"), false)
  assert.ok(result.warnings.some(warning => warning.includes("omitted disabled server 'server-two'")))

  // Skills: command → user-invocable skill, companion copied with a pinned name.
  const skill = fs.readFileSync(path.join(output, "skills", "pipeline-research", "SKILL.md"), "utf8")
  assert.match(skill, /name: pipeline-research/)
  assert.match(skill, /user-invocable: true/)
  assert.match(skill, /disable-model-invocation: true/)
  assert.match(skill, /description: Research only/)
  assert.match(skill, /\$request/)
  assert.doesNotMatch(skill, /\$ARGUMENTS/)
  assert.match(skill, /```bash\ngit status --short\n```/)
  assert.match(skill, /vibe --agent decent-pipeline-orchestrator/)
  const companion = fs.readFileSync(path.join(output, "skills", "antipatterns", "SKILL.md"), "utf8")
  assert.match(companion, /description: Catalog of anti-patterns\./)
  assert.match(companion, /name: antipatterns/)
  assert.ok(fs.existsSync(path.join(output, "skills", "antipatterns", "references", "band-aid-fix.md")))

  // README documents the install roots
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /# decent-pipeline/)
  assert.match(readme, /~\/\.vibe\/plugins\/decent-pipeline\//)
  assert.match(readme, /`ai\.mistral\.vibe` extension/)
  assert.match(readme, /## Main agent profiles/)
  assert.match(readme, /vibe --agent decent-pipeline-orchestrator/)
  assert.match(readme, /Spawned subagents run with a reduced toolset/)
})

test("catch-all deny with edit allow keeps the write tools available", () => {
  const agents = [
    agent(
      "executor.md",
      "",
      {
        mode: "subagent",
        permission: { "*": "deny", edit: "allow", shell: "allow" }
      },
      "Edits files."
    )
  ]
  const workspace = makeWorkspace({})
  const output = path.join(workspace, "bridges", "vibe")
  bridgeToVibe(agents, "e", "", output, workspace)
  const toml = fs.readFileSync(path.join(output, "ai.mistral.vibe", "agents", "executor.toml"), "utf8")
  assert.doesNotMatch(toml, /safety = "safe"/)
  assert.doesNotMatch(toml, /\[tools\.bash\]/)
  assert.doesNotMatch(toml, /\[tools\.write_file\]/)
  assert.match(toml, /\[tools\.edit\]\npermission = "never"/)
  assert.match(toml, /\[tools\.read_file\]\npermission = "never"/)
})

test("agents without restrictive permissions stay neutral", () => {
  const agents = [agent("a.md", "m", { mode: "subagent" }, "Does everything.")]
  const workspace = makeWorkspace({})
  const output = path.join(workspace, "bridges", "vibe")
  bridgeToVibe(agents, "p", "", output, workspace)
  const toml = fs.readFileSync(path.join(output, "ai.mistral.vibe", "agents", "a.toml"), "utf8")
  assert.match(toml, /safety = "neutral"/)
  assert.match(toml, /agent_type = "subagent"/)
  assert.doesNotMatch(toml, /\[tools\./)
})

test("emit flags control skills, MCP and README", () => {
  const agents = [agent("a.md", "m", { mode: "primary" }, "Body")]
  const workspace = makeWorkspace({
    "opencode.json": JSON.stringify({ mcp: { servers: { s: { type: "local", command: ["x"] } } } }),
    "commands/cmd.md": "---\ndescription: D\n---\n\nBody",
    "skills/thing/SKILL.md": "---\nname: thing\ndescription: Thing skill.\n---\n\nThing."
  })
  const output = path.join(workspace, "bridges", "vibe")
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    vibe: { ...DEFAULT_TRANSLATION_CONFIG.vibe, emitSkills: false, emitMcp: false, emitReadme: false }
  }
  const result = bridgeToVibe(agents, "p", "", output, workspace, config)
  assert.equal(result.plugin.skills.length, 0)
  assert.ok(!fs.existsSync(path.join(output, "skills")))
  assert.ok(!fs.existsSync(path.join(output, "mcp.json")))
  assert.ok(!fs.existsSync(path.join(output, "README.md")))
  assert.ok(fs.existsSync(path.join(output, "plugin.json")))
})

test("emitAgentProfiles: false skips the main agent profiles", () => {
  const agents = [agent("lead.md", "m", { mode: "primary" }, "Leads.")]
  const workspace = makeWorkspace({})
  const output = path.join(workspace, "bridges", "vibe")
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    vibe: { ...DEFAULT_TRANSLATION_CONFIG.vibe, emitAgentProfiles: false }
  }
  const result = bridgeToVibe(agents, "p", "", output, workspace, config)
  assert.deepEqual(result.plugin.profiles, [])
  assert.ok(!fs.existsSync(path.join(output, "agent-profiles")))
  assert.ok(result.warnings.some(warning => /mode 'primary' has no selectable Vibe plugin equivalent/.test(warning)))
})

test("every primary agent gets a main agent profile", () => {
  const agents = [
    agent("flow-build.md", "m", { mode: "primary" }, "Builds."),
    agent("flow-plan.md", "m", { mode: "primary" }, "Plans."),
    agent("flow-explore.md", "m", { mode: "subagent" }, "Explores.")
  ]
  const workspace = makeWorkspace({})
  const output = path.join(workspace, "bridges", "vibe")
  const result = bridgeToVibe(agents, "flow", "flow-", output, workspace)
  assert.deepEqual(result.plugin.profiles.map(profile => profile.fileName).sort(), ["flow-build.toml", "flow-plan.toml"])
  assert.ok(fs.existsSync(path.join(output, "agent-profiles", "flow-build.toml")))
  assert.ok(fs.existsSync(path.join(output, "agent-profiles", "flow-plan.toml")))
  assert.ok(!fs.existsSync(path.join(output, "agent-profiles", "flow-explore.toml")))
})

test("emitHooks: true ships an agents_spawn guard hook and script", () => {
  const agents = [
    agent("lead.md", "m", { mode: "primary" }, "Leads."),
    agent("scout.md", "m", { mode: "subagent" }, "Scouts.")
  ]
  const workspace = makeWorkspace({})
  const output = path.join(workspace, "bridges", "vibe")
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    vibe: { ...DEFAULT_TRANSLATION_CONFIG.vibe, emitHooks: true }
  }
  const result = bridgeToVibe(agents, "p", "", output, workspace, config)
  const hooks = fs.readFileSync(path.join(output, "ai.mistral.vibe", "hooks.toml"), "utf8")
  assert.match(hooks, /type = "pre_tool"/)
  assert.match(hooks, /match = "agents_spawn"/)
  assert.match(hooks, /command = "node ai\.mistral\.vibe\/guard-spawn\.js"/)
  const script = fs.readFileSync(path.join(output, "ai.mistral.vibe", "guard-spawn.js"), "utf8")
  assert.match(script, /"p:lead"/)
  assert.match(script, /"p:scout"/)
  assert.match(script, /decision: "deny"/)
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /## Spawn guard/)
  // Off by default: no hook artifacts without the flag.
  const plain = bridgeToVibe(agents, "q", "", path.join(workspace, "bridges", "vibe-q"), workspace)
  assert.ok(!fs.existsSync(path.join(plain.pluginDir, "ai.mistral.vibe", "hooks.toml")))
  assert.ok(!fs.existsSync(path.join(plain.pluginDir, "ai.mistral.vibe", "guard-spawn.js")))
})

test("a skills-only pack still emits a plugin package", () => {
  const workspace = makeWorkspace({
    "commands/research.md": "---\ndescription: Research\n---\n\nQuestion: $ARGUMENTS"
  })
  const output = path.join(workspace, "bridges", "vibe")
  const result = bridgeToVibe([], "p", "", output, workspace)
  assert.deepEqual(result.plugin.agents, [])
  assert.deepEqual(result.plugin.skills, ["research"])
  assert.ok(!fs.existsSync(path.join(output, "ai.mistral.vibe")))
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "plugin.json"), "utf8"))
  assert.equal(manifest.name, "p")
})

test("remote MCP Authorization headers stay static; {env:} headers are dropped", () => {
  const agents = [agent("a.md", "m", { mode: "primary" }, "Body")]
  const workspace = makeWorkspace({
    "opencode.json": JSON.stringify({
      mcp: {
        servers: {
          analytics: {
            type: "remote",
            url: "https://api.example.com/mcp",
            headers: { Authorization: "Bearer {env:ANALYTICS_TOKEN}", "X-Static": "yes" }
          }
        }
      }
    })
  })
  const output = path.join(workspace, "bridges", "vibe")
  const result = bridgeToVibe(agents, "p", "", output, workspace)
  const mcp = JSON.parse(fs.readFileSync(path.join(output, "mcp.json"), "utf8"))
  assert.equal(mcp.mcpServers.analytics.type, "streamable-http")
  assert.deepEqual(mcp.mcpServers.analytics.headers, { "X-Static": "yes" })
  assert.ok(result.warnings.some(warning => warning.includes("'analytics' header 'Authorization' references an environment variable")))
})

test("stdio server environments carry over with reserved plugin keys and env refs flagged", () => {
  const agents = [agent("a.md", "m", { mode: "primary" }, "Body")]
  const workspace = makeWorkspace({
    "opencode.json": JSON.stringify({
      mcp: {
        servers: {
          search: {
            type: "local",
            command: ["search-cli", "--serve"],
            environment: { SEARCH_KEY: "{env:SEARCH_KEY}", PLUGIN_ROOT: "/evil", EXTRA: "literal" }
          }
        }
      }
    })
  })
  const output = path.join(workspace, "bridges", "vibe")
  const result = bridgeToVibe(agents, "p", "", output, workspace)
  const mcp = JSON.parse(fs.readFileSync(path.join(output, "mcp.json"), "utf8"))
  assert.deepEqual(mcp.mcpServers.search.env, { SEARCH_KEY: "${SEARCH_KEY}", EXTRA: "literal" })
  assert.ok(result.warnings.some(warning => warning.includes("'PLUGIN_ROOT' is reserved")))
  assert.ok(result.warnings.some(warning => warning.includes("expects the launching environment to provide 'SEARCH_KEY'")))
})

test("disabled MCP servers required by agent permissions are emitted with a warning", () => {
  const agents = [
    agent(
      "a.md",
      "m",
      {
        mode: "primary",
        permission: { "analytics_*": "allow", read: "allow" }
      },
      "Uses the analytics_* tools."
    )
  ]
  const workspace = makeWorkspace({
    "opencode.json": JSON.stringify({
      mcp: { servers: { analytics: { type: "local", command: ["analytics-cli"], disabled: true } } }
    })
  })
  const output = path.join(workspace, "bridges", "vibe")
  const result = bridgeToVibe(agents, "p", "", output, workspace)
  const mcp = JSON.parse(fs.readFileSync(path.join(output, "mcp.json"), "utf8"))
  assert.equal(mcp.mcpServers.analytics.type, "stdio")
  assert.ok(result.warnings.some(warning => warning.includes("emitted because translated agents require it")))
})

test("agents that reference MCP servers warn that spawned subagents have no MCP", () => {
  const agents = [
    agent(
      "a.md",
      "m",
      {
        mode: "primary",
        permission: { "analytics_*": "allow", read: "allow" }
      },
      "Uses the analytics_* tools."
    )
  ]
  const workspace = makeWorkspace({
    "opencode.json": JSON.stringify({
      mcp: { servers: { analytics: { type: "local", command: ["analytics-cli"] } } }
    })
  })
  const output = path.join(workspace, "bridges", "vibe")
  const result = bridgeToVibe(agents, "p", "", output, workspace)
  assert.ok(result.warnings.some(warning =>
    warning.includes("references MCP server(s) analytics") &&
    warning.includes("spawned Vibe subagents have no MCP or connector tools")))
})

test("oversized instructions are flagged: Vibe refuses agent files over 64 KiB", () => {
  const agents = [agent("big.md", "m", { mode: "subagent" }, `x`.repeat(70000))]
  const workspace = makeWorkspace({})
  const output = path.join(workspace, "bridges", "vibe")
  const result = bridgeToVibe(agents, "p", "", output, workspace)
  assert.ok(result.warnings.some(warning => /big\.md: instructions are 7\d+ characters/.test(warning)))
})

test("descriptions longer than 300 characters are truncated on a word boundary", () => {
  const verbose = agent("verbose.md", "m", { mode: "subagent" }, "Body")
  verbose.description = `${"word ".repeat(80)}end`
  assert.ok(verbose.description.length > 300)
  const workspace = makeWorkspace({})
  const output = path.join(workspace, "bridges", "vibe")
  const result = bridgeToVibe([verbose], "p", "", output, workspace)
  assert.ok(result.warnings.some(warning => warning.includes("verbose.md: description is ") && warning.includes("truncated")))
  const toml = fs.readFileSync(path.join(output, "ai.mistral.vibe", "agents", "verbose.toml"), "utf8")
  const description = /description = "([^"]*)"/.exec(toml)![1]
  assert.ok(description.length > 0 && description.length <= 300)
  assert.ok(description.endsWith("word"))
})

test("agents that normalize to the same Vibe name fail the bridge", () => {
  const agents = [
    agent("fast_lane.md", "m", { mode: "subagent" }, "One."),
    agent("pipeline-fast_lane.md", "m", { mode: "subagent" }, "Two.")
  ]
  const workspace = makeWorkspace({})
  const output = path.join(workspace, "bridges", "vibe")
  assert.throws(() => bridgeToVibe(agents, "p", "pipeline-", output, workspace), /Multiple agents map to the Vibe name 'fast-lane'/)
})

test("bridge fails when there is nothing to export", () => {
  const workspace = makeWorkspace({})
  const output = path.join(workspace, "bridges", "vibe")
  assert.throws(
    () => bridgeToVibe([], "p", "", output, workspace),
    /no agents, skills or MCP servers to export/
  )
})

test("vibeNextSteps adapt to whether the plugin was installed", () => {
  const workspace = makeWorkspace({})
  const result = {
    pluginDir: path.join(workspace, "out"),
    files: [],
    warnings: [],
    plugin: { pluginName: "p", agents: [], skills: [], orchestratorName: "orchestrator" },
    preview: []
  }
  const manual = vibeNextSteps(result as any)
  assert.ok(manual.some(line => line.includes("cp -r") && line.includes(".vibe/plugins/p/")))
  assert.ok(manual.some(line => line.includes("/plugins")))
  assert.ok(manual.some(line => line.includes("p:orchestrator")))
  const installed = vibeNextSteps(result as any, { path: "/home/u/.vibe/plugins/p", changed: true })
  assert.ok(installed.some(line => line.includes("Installed in /home/u/.vibe/plugins/p")))
  assert.ok(!installed.some(line => line.includes("cp -r")))
  const fresh = vibeNextSteps(result as any, { path: "/home/u/.vibe/plugins/p", changed: false })
  assert.ok(fresh.some(line => line.includes("(already up to date)")))
  // Main agent profiles add their own install hints and run commands.
  const withProfiles = {
    ...result,
    plugin: { ...result.plugin, profiles: [{ fileName: "p-orchestrator.toml", agent: {} as never }] }
  }
  const manualProfiles = vibeNextSteps(withProfiles as any)
  assert.ok(manualProfiles.some(line => line.includes("agent-profiles/*.toml") && line.includes("$HOME/.vibe/agents/")))
  assert.ok(manualProfiles.some(line => line.includes("vibe --agent p-orchestrator")))
  const installedProfiles = vibeNextSteps(withProfiles as any, { path: "/home/u/.vibe/plugins/p", changed: true }, { path: "/home/u/.vibe/agents", changed: false })
  assert.ok(installedProfiles.some(line => line.includes("Agent profiles installed in /home/u/.vibe/agents (already up to date)")))
})

test("writeVibePlugin refuses symlinked companion sources", () => {
  const workspaceRoot = makeWorkspace({
    "skills/real/SKILL.md": "---\nname: real\ndescription: Real skill.\n---\n\nReal body.\n"
  })
  fs.mkdirSync(path.join(workspaceRoot, "skills", "linked"), { recursive: true })
  fs.symlinkSync(
    path.join(workspaceRoot, "skills", "real", "SKILL.md"),
    path.join(workspaceRoot, "skills", "linked", "SKILL.md")
  )
  const agents = [agent("a.md", "m", { mode: "primary" }, "Body")]
  const output = path.join(workspaceRoot, "bridges", "vibe")
  assert.throws(
    () => writeVibePlugin(agents, "p", "", output, workspaceRoot),
    /must not be a symlink/
  )
})

test("companion skills without a description fall back to their name with a warning", () => {
  const agents = [agent("a.md", "m", { mode: "primary" }, "Body")]
  const workspace = makeWorkspace({
    "skills/words/SKILL.md": "---\nname: words\n---\n\nWords."
  })
  const output = path.join(workspace, "bridges", "vibe")
  const result = bridgeToVibe(agents, "p", "a-", output, workspace)
  const skill = fs.readFileSync(path.join(output, "skills", "words", "SKILL.md"), "utf8")
  assert.match(skill, /description: words/)
  assert.ok(result.warnings.some(warning => warning.includes("Skill 'words' has no description")))
})
