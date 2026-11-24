import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { listTargetBackups, runTargetLifecycleOperation } from "./targetActions.js"
import type { SourceRegistry } from "./sources.js"

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf8")
}

test("listTargetBackups returns sorted valid backups and ignores symlinks", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "manage-agents-backups-"))
  try {
    writeFile(path.join(target, ".manage-agents/backups/2026-01-01-a/backup.json"), JSON.stringify({
      createdAt: "2026-01-01T10:00:00Z",
      files: ["agents/a.md"],
      config: [],
    }))
    writeFile(path.join(target, ".manage-agents/backups/2026-02-01-b/backup.json"), JSON.stringify({
      createdAt: "2026-02-01T10:00:00Z",
      files: ["agents/a.md", "skills/s/SKILL.md"],
      config: [{ key: "mcp" }],
    }))
    // Invalid backup entry (missing backup.json)
    fs.mkdirSync(path.join(target, ".manage-agents/backups/empty-dir"), { recursive: true })
    // Symlink entry should be skipped
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "manage-agents-outside-"))
    writeFile(path.join(outside, "backup.json"), JSON.stringify({ files: ["evil"], config: [] }))
    fs.symlinkSync(outside, path.join(target, ".manage-agents/backups/2099-symlink"))

    const backups = listTargetBackups(target)
    assert.deepEqual(backups.map(b => b.id), ["2026-02-01-b", "2026-01-01-a"])
    assert.equal(backups[0]?.fileCount, 2)
    assert.equal(backups[0]?.configCount, 1)

    fs.rmSync(outside, { recursive: true, force: true })
  } finally {
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test("runTargetLifecycleOperation supports install, update, reconcile, and uninstall on skills-only pack", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manage-agents-lifecycle-"))
  const target = path.join(root, "target")
  const sourceDir = path.join(root, "catalog")
  fs.mkdirSync(target, { recursive: true })
  try {
    const packDir = path.join(sourceDir, "packs", "docs-kit")
    writeFile(path.join(packDir, "opencode-pack.json"), JSON.stringify({
      contract: "1.1",
      name: "docs-kit",
      version: "1.0.0",
      description: "Skills-only pack",
    }, null, 2))
    writeFile(path.join(packDir, "skills", "guide", "SKILL.md"), "---\nname: guide\ndescription: Guide\n---\nHello.\n")

    const registry: SourceRegistry = {
      schemaVersion: 1,
      active: "local-test",
      prefer: {},
      sources: [{ name: "local-test", kind: "local", path: sourceDir, trusted: true }],
    }

    const installDry = await runTargetLifecycleOperation(target, "install", registry, ["docs-kit"], { dryRun: true })
    assert.equal(installDry.status, "dry-run")

    const installed = await runTargetLifecycleOperation(target, "install", registry, ["docs-kit"], { yes: true })
    assert.equal(installed.status, "applied")
    assert.ok(fs.existsSync(path.join(target, "skills/guide/SKILL.md")))

    const updated = await runTargetLifecycleOperation(target, "update", registry, ["docs-kit"], { yes: true })
    assert.ok(updated.status === "applied" || updated.status === "unchanged")

    const reconciled = await runTargetLifecycleOperation(target, "reconcile", registry, [], { yes: true })
    assert.ok(reconciled.status === "applied" || reconciled.status === "unchanged")

    const uninstallDry = await runTargetLifecycleOperation(target, "uninstall", registry, ["docs-kit"], { dryRun: true })
    assert.equal(uninstallDry.status, "dry-run")

    const uninstalled = await runTargetLifecycleOperation(target, "uninstall", registry, ["docs-kit"], { yes: true })
    assert.equal(uninstalled.status, "applied")
    assert.ok(!fs.existsSync(path.join(target, "skills/guide/SKILL.md")))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
