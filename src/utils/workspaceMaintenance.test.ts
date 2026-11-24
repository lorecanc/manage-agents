import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { findAgentFiles } from "./agents.js"
import {
  applyFixNames,
  previewFixNames,
  runWorkspaceAudit,
  runWorkspaceLint,
  runWorkspaceValidate,
} from "./workspaceMaintenance.js"

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf8")
}

test("workspaceMaintenance validates packs, lints/fixes names, and audits permissions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manage-agents-maint-"))
  try {
    const packDir = path.join(root, "packs", "demo")
    writeFile(path.join(packDir, "opencode-pack.json"), JSON.stringify({
      contract: "1.1",
      name: "demo",
      version: "1.0.0",
      description: "Demo pack",
    }, null, 2))
    writeFile(
      path.join(packDir, "agents", "demo-bad-role-name.md"),
      `---\ndescription: Needs rename\nmodel: anthropic/claude-sonnet-4\npermission:\n  bash: allow\n---\nHi\n`,
    )
    writeFile(
      path.join(packDir, "agents", "demo-good_worker.md"),
      `---\ndescription: Compliant\nmodel: anthropic/claude-sonnet-4\n---\nHi\n`,
    )

    const val = runWorkspaceValidate(root)
    assert.equal(val.packs.length, 1)
    assert.equal(val.totalErrors, 0)

    const agents = findAgentFiles(root)
    const lint = runWorkspaceLint(agents)
    assert.equal(lint.total, 2)
    assert.equal(lint.nonCompliant.length, 1)
    assert.equal(lint.nonCompliant[0]?.agent.filename, "demo-bad-role-name.md")

    const audit = runWorkspaceAudit(agents)
    assert.equal(audit.highRisk.length, 1)

    const plan = previewFixNames(agents)
    assert.equal(plan.length, 1)
    assert.equal(plan[0]?.fromFilename, "demo-bad-role-name.md")

    const applied = applyFixNames(root, agents, plan)
    assert.equal(applied.renamedCount, 1)

    const after = findAgentFiles(root)
    assert.equal(runWorkspaceLint(after).nonCompliant.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
