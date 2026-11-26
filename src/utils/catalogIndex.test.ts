import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { findAgentFiles } from "./agents.js"
import {
  buildCatalogIndex,
  buildCatalogTreeItems,
  formatBridgeBadges,
  formatPackAssetBadges,
  sectionKey,
} from "./catalogIndex.js"

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf8")
}

function makeTempCatalog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manage-agents-catalog-index-"))

  // 1. Mixed pack (agent + skill + command + tool + plugin + mcp)
  const mixedDir = path.join(root, "packs", "mixed-kit")
  writeFile(path.join(mixedDir, "opencode-pack.json"), JSON.stringify({
    contract: "1.1",
    name: "mixed-kit",
    version: "1.2.0",
    description: "Mixed pack with every asset type",
    requires: { "skills-only": "^1.0.0" },
  }, null, 2))
  writeFile(path.join(mixedDir, "agents", "mixed-helper.md"), `---\ndescription: Main helper\nmodel: anthropic/claude-sonnet-4\n---\nYou help.\n`)
  writeFile(path.join(mixedDir, "skills", "code-style", "SKILL.md"), `---\nname: code-style\ndescription: Style guide rules\n---\n# Code Style\nFollow conventions.\n`)
  writeFile(path.join(mixedDir, "commands", "release.md"), `---\ndescription: Run release checklist\n---\nCheck git status.\n`)
  writeFile(path.join(mixedDir, "tools", "check.mjs"), `export default function check() { return true }\n`)
  writeFile(path.join(mixedDir, "plugins", "my-plug", "index.mjs"), `export const name = "my-plug"\n`)
  writeFile(path.join(mixedDir, "opencode.json"), JSON.stringify({
    mcp: {
      servers: {
        docs: { type: "local", command: ["npx", "docs-mcp"], enabled: true },
      },
    },
  }, null, 2))

  // 2. Skills-only pack (0 agents)
  const skillsDir = path.join(root, "packs", "skills-only")
  writeFile(path.join(skillsDir, "opencode-pack.json"), JSON.stringify({
    contract: "1.1",
    name: "skills-only",
    version: "1.0.0",
    description: "Pure skills pack",
  }, null, 2))
  writeFile(path.join(skillsDir, "skills", "api-docs", "SKILL.md"), `---\nname: api-docs\ndescription: Document APIs clearly\n---\nWrite OpenAPI specs.\n`)

  // 3. Commands-only pack (0 agents) -> Claude compatible (cmd->skill), Codex NOT compatible
  const cmdsDir = path.join(root, "packs", "cmds-only")
  writeFile(path.join(cmdsDir, "opencode-pack.json"), JSON.stringify({
    contract: "1.1",
    name: "cmds-only",
    version: "1.0.0",
    description: "Pure commands pack",
  }, null, 2))
  writeFile(path.join(cmdsDir, "commands", "deploy.md"), `---\ndescription: Deploy preview\n---\nDeploy to staging.\n`)

  // 4. Tools-only pack (0 agents) -> OpenCode only
  const toolsDir = path.join(root, "packs", "tools-only")
  writeFile(path.join(toolsDir, "opencode-pack.json"), JSON.stringify({
    contract: "1.1",
    name: "tools-only",
    version: "1.0.0",
    description: "Pure tools pack",
  }, null, 2))
  writeFile(path.join(toolsDir, "tools", "lint-helper.js"), `console.log("ok")\n`)

  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test("buildCatalogIndex discovers 0-agent packs and computes accurate counts and bridge compat", () => {
  const { root, cleanup } = makeTempCatalog()
  try {
    const agents = findAgentFiles(root)
    const index = buildCatalogIndex(root, agents)

    assert.deepEqual(index.packs.map(p => p.name), ["cmds-only", "mixed-kit", "skills-only", "tools-only"])

    const mixed = index.byName.get("mixed-kit")!
    assert.equal(mixed.counts.agents, 1)
    assert.equal(mixed.counts.skills, 1)
    assert.equal(mixed.counts.commands, 1)
    assert.equal(mixed.counts.tools, 1)
    assert.equal(mixed.counts.plugins, 1)
    assert.equal(mixed.counts.mcp, 1)
    assert.equal(mixed.bridgeCompat.claude, true)
    assert.equal(mixed.bridgeCompat.codex, true)
    assert.equal(mixed.bridgeCompat.vibe, true)
    assert.equal(formatBridgeBadges(mixed.bridgeCompat), "OC·CC·CX·VB")
    assert.equal(formatPackAssetBadges(mixed.counts), "[A:1 S:1 C:1 T:1 P:1 M:1]")

    const skillsOnly = index.byName.get("skills-only")!
    assert.equal(skillsOnly.counts.agents, 0)
    assert.equal(skillsOnly.counts.skills, 1)
    assert.equal(skillsOnly.bridgeCompat.claude, true)
    assert.equal(skillsOnly.bridgeCompat.codex, true)
    assert.equal(skillsOnly.bridgeCompat.vibe, true)
    assert.equal(skillsOnly.skills[0]?.description, "Document APIs clearly")

    const cmdsOnly = index.byName.get("cmds-only")!
    assert.equal(cmdsOnly.counts.agents, 0)
    assert.equal(cmdsOnly.counts.commands, 1)
    assert.equal(cmdsOnly.bridgeCompat.claude, true)
    assert.equal(cmdsOnly.bridgeCompat.codex, false)
    // Commands translate to Vibe skills, so a commands-only pack is vibe-able.
    assert.equal(cmdsOnly.bridgeCompat.vibe, true)
    assert.equal(formatBridgeBadges(cmdsOnly.bridgeCompat), "OC·CC·VB")

    const toolsOnly = index.byName.get("tools-only")!
    assert.equal(toolsOnly.counts.tools, 1)
    assert.equal(toolsOnly.bridgeCompat.claude, false)
    assert.equal(toolsOnly.bridgeCompat.codex, false)
    assert.equal(formatBridgeBadges(toolsOnly.bridgeCompat), "OC")
  } finally {
    cleanup()
  }
})

test("buildCatalogTreeItems builds Pack -> Section -> Asset hierarchy and supports filtering", () => {
  const { root, cleanup } = makeTempCatalog()
  try {
    const agents = findAgentFiles(root)
    const index = buildCatalogIndex(root, agents)

    // Collapsed by default
    const collapsed = buildCatalogTreeItems(index, {
      searchQuery: "",
      assetFilter: "all",
      expandedCategories: new Set(),
      expandedSections: new Set(),
    })
    assert.equal(collapsed.length, 4)
    assert.ok(collapsed.every(item => item.type === "folder"))

    // Expanding mixed-kit shows sections closed by default; only explicitly expanded sections reveal their assets
    const expanded = buildCatalogTreeItems(index, {
      searchQuery: "",
      assetFilter: "all",
      expandedCategories: new Set(["mixed-kit"]),
      expandedSections: new Set([sectionKey("mixed-kit", "skill"), sectionKey("mixed-kit", "mcp")]),
    })
    assert.ok(expanded.some(item => item.type === "section" && item.assetKind === "skill"))
    assert.ok(expanded.some(item => item.type === "asset" && item.asset.name === "code-style"))
    assert.ok(expanded.some(item => item.type === "asset" && item.asset.kind === "mcp" && item.asset.name === "docs"))
    // Tool section was not expanded so its asset child should remain hidden
    assert.ok(!expanded.some(item => item.type === "asset" && item.assetKind === "tool"))

    // Filtering by skill shows only packs with skills and keeps unopened packs collapsed
    const skillsFiltered = buildCatalogTreeItems(index, {
      searchQuery: "",
      assetFilter: "skill",
      expandedCategories: new Set(),
      expandedSections: new Set(),
    })
    const folderNames = skillsFiltered.filter(i => i.type === "folder").map(i => i.category)
    assert.deepEqual(folderNames, ["mixed-kit", "skills-only"])
    assert.ok(skillsFiltered.every(i => i.type === "folder"))

    // Opening one pack while filtered by skill reveals its skills directly without opening other packs
    const skillsOneExpanded = buildCatalogTreeItems(index, {
      searchQuery: "",
      assetFilter: "skill",
      expandedCategories: new Set(["skills-only"]),
      expandedSections: new Set(),
    })
    assert.ok(skillsOneExpanded.some(i => i.type === "asset" && i.asset.name === "api-docs"))
    assert.ok(!skillsOneExpanded.some(i => i.type === "asset" && i.asset.name === "code-style"))
    assert.ok(!skillsOneExpanded.some(i => i.type === "section"))

    // Searching by command description finds cmds-only and auto-expands it
    const searchFiltered = buildCatalogTreeItems(index, {
      searchQuery: "deploy preview",
      assetFilter: "all",
      expandedCategories: new Set(),
      expandedSections: new Set(),
    })
    assert.deepEqual(searchFiltered.filter(i => i.type === "folder").map(i => i.category), ["cmds-only"])
    assert.ok(searchFiltered.some(i => i.type === "asset" && i.asset.name === "deploy"))
  } finally {
    cleanup()
  }
})
