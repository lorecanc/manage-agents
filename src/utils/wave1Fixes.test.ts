import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { tempDir, writePack } from "../../test/helpers.js"
import { describePackFlows } from "./archetypes.js"
import { bridgePack } from "./bridgeWorkspace.js"
import { DEFAULT_TRANSLATION_CONFIG } from "./translationConfig.js"
import { parseTuneCliArgs } from "./agents.js"
import { movePathWithRetry } from "./fsWindows.js"
import { layoutMarkdownDocument } from "./markdownLayout.js"
import { applyPackOnboarding } from "./packOnboarding.js"
import { hasErrors, validatePack } from "./packs.js"
import { loadSources } from "./sources.js"
import { displayWidth } from "./terminalText.js"

const plainLine = (line: { spans: Array<{ text: string }> }) => line.spans.map(span => span.text).join("")

test("T1 — movePathWithRetry restores original target when fallback copy partially writes target before failing", (t) => {
  const root = tempDir(t, "wave1-move-partial-")
  const source = path.join(root, "source")
  const target = path.join(root, "target")
  fs.writeFileSync(source, "new-bytes")
  fs.writeFileSync(target, "original-bytes")

  assert.throws(
    () => movePathWithRetry(source, target, {
      renameSync: () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }) },
      cpSync: (src, dst, options) => {
        if (dst === target && !String(src).includes(".bak-")) {
          fs.writeFileSync(target, "partial-corrupt")
          throw new Error("ENOSPC mid-copy")
        }
        fs.cpSync(src, dst, options)
      },
    }),
    /ENOSPC mid-copy/,
  )
  assert.equal(fs.readFileSync(target, "utf8"), "original-bytes")
})

test("T2 — validatePack treats oversized opencode.json and control characters in paths/IDs as errors", (t) => {
  const root = tempDir(t, "wave1-pack-validation-")
  const packDir = path.join(root, "pack")
  const badAgentId = "bad\u0001agent"
  const badServerId = "local\u0001cmd"
  writePack(packDir, {
    [`agents/${badAgentId}.md`]: "---\ndescription: Helper\nmode: subagent\n---\nHelp.\n",
    "opencode.json": JSON.stringify({
      mcp: { servers: { [badServerId]: { type: "local", command: ["echo", "hi"] } } },
      padding: "x".repeat(2 * 1024 * 1024 + 128),
    }),
  }, { name: "validation-pack" })

  const validation = validatePack(packDir)
  assert.equal(hasErrors(validation), true, JSON.stringify(validation.issues))
  assert.ok(
    validation.issues.some(issue => issue.level === "error" && issue.code === "file-too-large"),
    JSON.stringify(validation.issues),
  )
  assert.ok(
    validation.issues.some(issue => issue.level === "error" && (
      issue.path?.includes(badAgentId) || issue.message.includes(badAgentId) || issue.message.includes(badServerId)
    )),
    "control characters in resource paths or IDs must be reported as errors",
  )
})

test("T3 — loadSources rejects credential-bearing Git URLs from sources.json", (t) => {
  const root = tempDir(t, "wave1-source-credentials-")
  const configHome = path.join(root, "xdg")
  const sourceDir = path.join(configHome, "manage-agents")
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.writeFileSync(path.join(sourceDir, "sources.json"), JSON.stringify({
    schemaVersion: 1,
    prefer: {},
    sources: [{ name: "cred-leak", kind: "git", url: "https://secret-token@github.com/org/repo.git", trusted: false }],
  }))

  const env = { ...process.env, XDG_CONFIG_HOME: configHome }
  let thrownMessage = ""
  assert.throws(() => {
    try {
      loadSources(env)
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error)
      throw error
    }
  }, /invalid source entry|credentials/i)
  assert.doesNotMatch(thrownMessage, /secret-token/)
})

test("T4 — Claude bridge honors V2 global deny without granting tools or omitting tools", (t) => {
  const root = tempDir(t, "wave1-bridge-global-deny-")
  const packDir = path.join(root, "packs", "demo")
  const outputDir = path.join(root, "bridge")
  writePack(packDir, {
    "agents/demo-agent.md": [
      "---",
      "description: Restricted agent",
      "mode: primary",
      "permissions:",
      "  - action: \"*\"",
      "    resource: \"*\"",
      "    effect: deny",
      "---",
      "Use codebase-memory-mcp for context.",
      "",
    ].join("\n"),
    "opencode.json": JSON.stringify({
      mcp: { servers: { "codebase-memory-mcp": { type: "local", command: ["codebase-memory-mcp"] } } },
    }),
  }, { name: "demo" })

  bridgePack({
    workspaceRoot: root,
    pack: "demo",
    target: "claude",
    outputDir,
    config: DEFAULT_TRANSLATION_CONFIG,
    pluginName: "demo",
    prefix: "demo-",
  })

  const generated = fs.readFileSync(path.join(outputDir, "agents", "agent.md"), "utf8")
  assert.doesNotMatch(generated, /\b(?:Read|Grep|Glob)\b|mcp__codebase-memory-mcp__\*/)
  assert.match(generated, /^tools: \[\]$/m)
})

test("T5 — parseTuneCliArgs accepts custom provider-specific variant syntax", () => {
  const parsed = parseTuneCliArgs(["--variant", "provider-custom-tier", "--all"])
  assert.equal(parsed.kind, "ok")
})

test("T6 — applyPackOnboarding moves .opencode/AGENTS.md into a subpack while preserving root AGENTS.md", (t) => {
  const repoDir = tempDir(t, "wave1-onboard-mixed-")
  fs.mkdirSync(path.join(repoDir, ".opencode", "agents"), { recursive: true })
  fs.writeFileSync(path.join(repoDir, "package.json"), '{"name":"demo-app"}\n')
  fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "host-root-instructions")
  fs.writeFileSync(path.join(repoDir, ".opencode", "AGENTS.md"), "pack-instructions")
  fs.writeFileSync(
    path.join(repoDir, ".opencode", "agents", "demo-helper.md"),
    "---\ndescription: Demo helper\nmode: subagent\n---\nHelp with the demo.\n",
  )

  const result = applyPackOnboarding(repoDir, { name: "demo-pack", layout: "subpack" })
  const subpackAgents = path.join(result.packDir, "AGENTS.md")
  assert.ok(fs.existsSync(subpackAgents))
  assert.equal(fs.readFileSync(subpackAgents, "utf8"), "pack-instructions")
  assert.equal(fs.readFileSync(path.join(repoDir, "AGENTS.md"), "utf8"), "host-root-instructions")
})

test("T7 — describePackFlows marks write statically denied when caller denies edit", (t) => {
  const root = tempDir(t, "wave1-static-write-deny-")
  writePack(path.join(root, "packs", "flow"), {
    "agents/flow-lead.md": [
      "---",
      "description: Flow lead",
      "mode: primary",
      "permissions:",
      "  - action: edit",
      "    resource: \"*\"",
      "    effect: deny",
      "  - action: subagent",
      "    resource: flow-helper",
      "    effect: allow",
      "---",
      "Delegate to @flow-helper.",
      "",
    ].join("\n"),
    "agents/flow-helper.md": "---\ndescription: Flow helper\nmode: subagent\n---\nHelp.\n",
  }, { name: "flow" })

  const view = describePackFlows(root, "flow")
  assert.ok(view)
  assert.equal(view.availableTools.find(tool => tool.key === "write")?.staticallyDeniedByCaller, true)
})

test("T8 — layoutMarkdownDocument never exceeds requested width on narrow multi-column GFM tables", () => {
  const lines = layoutMarkdownDocument(
    "| a | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |",
    16,
  ).map(plainLine)

  for (const line of lines) {
    assert.ok(displayWidth(line) <= 16, `line exceeded width 16 (${displayWidth(line)}): ${line}`)
  }
})

test("T9 — package.json files pins assets/plugin-icon.png instead of the broad assets directory", () => {
  const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url))
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { files: string[] }
  assert.ok(!pkg.files.includes("assets") && pkg.files.includes("assets/plugin-icon.png"))
})
