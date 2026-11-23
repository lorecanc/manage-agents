import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { installCodexPacks } from "./codexInstall.js"
import type { CliRunner } from "./claudePluginCli.js"
import { saveSources } from "./sources.js"

test("personal Codex installation resolves across sources, retries and preserves edited roles", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-install-"))
  const profile = path.join(root, "profile")
  const env = { ...process.env, CODEX_HOME: profile, XDG_CONFIG_HOME: path.join(root, "config") }
  t.mock.property(process, "env", env)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const put = (rel: string, text: string) => {
    const dest = path.join(root, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, text)
  }
  for (const [name, requires] of [["docs", { shared: "^1.0.0" }], ["shared", {}]] as const) {
    put(`${name}/opencode-pack.json`, JSON.stringify({ contract: "1.0", name, version: "1.0.0", requires, description: name }))
  }
  put("docs/agents/docs-editor.md", "---\ndescription: Edit documents\nmode: primary\n---\nDelegate to @docs-helper\n")
  put("docs/agents/docs-helper.md", "---\ndescription: Help\nmode: subagent\n---\nHelp\n")
  put("shared/skills/sort/SKILL.md", "---\nname: sort\ndescription: Sort\n---\nSort records.\n")
  put("shared/skills/sort/scripts/sort.sh", "echo sorted\n")
  saveSources({ schemaVersion: 1, sources: ["docs","shared"].map(name =>
    ({ name, kind: "local", path: path.join(root,name), trusted: false })), prefer: {} })
  const calls: string[][] = []
  let failAdd = false
  const runner: CliRunner = (_cmd, args) => {
    calls.push(args)
    return { status: failAdd && args[1] === "add" ? 1 : 0, stdout: '{"marketplaces":[]}', stderr: "plugin unavailable" }
  }
  const install = (dryRun = false, allow = false) => installCodexPacks(["docs/docs@1.x"], { dryRun, runner, confirm: async () => allow })
  const preview = await install(true)
  assert.equal(preview.packs[0].roles, 2)
  assert.equal(preview.packs[0].skills, 3)
  assert.equal(fs.existsSync(profile), false)
  assert.equal(calls.length, 0)
  await assert.rejects(install(), /confirmation/)
  assert.equal(calls.length, 0)
  failAdd = true
  await assert.rejects(install(false,true), /plugin unavailable/)
  assert.equal(fs.existsSync(path.join(profile,"agents/docs-editor.toml")), false)
  failAdd = false
  await install(false,true)
  const editor = path.join(profile,"agents/docs-editor.toml")
  assert.match(fs.readFileSync(editor,"utf8"), /@docs-helper/)
  assert.deepEqual((await install()).confirmations, [])
  put("shared/skills/sort/scripts/sort.sh", "echo changed\n")
  await assert.rejects(install(), /confirmation/)
  await install(false,true)
  fs.appendFileSync(editor,"# local edit\n")
  const before = calls.length
  await assert.rejects(install(), /Preserving edited or unmanaged/)
  assert.equal(calls.length,before)
})
