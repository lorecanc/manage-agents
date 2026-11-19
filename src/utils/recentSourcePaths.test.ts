import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { tempDir } from "../../test/helpers.js"
import {
  classifyRecentCandidate,
  loadRecentSourcePaths,
  mergeRecentPath,
  recentPathsFile,
  recordRecentSourcePath,
  saveRecentSourcePaths,
  suggestLocalPaths,
  type RecentSourcePath,
  type RecentSourcePaths,
} from "./recentSourcePaths.js"
import type { Source } from "./sources.js"
import { terminalSafeText } from "./terminalText.js"

const envFor = (t: test.TestContext) => {
  const base = tempDir(t)
  return { XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
}

const emptyState = (): RecentSourcePaths => ({ schemaVersion: 1, items: [] })

test("recent paths: credentials and query tokens are rejected and never persisted", (t) => {
  const env = envFor(t)
  const withUser = "https://user:secret@example.com/agents.git"
  const withToken = "https://github.com/org/agents.git?access_token=secret"
  assert.equal(classifyRecentCandidate(withUser), null)
  assert.equal(classifyRecentCandidate(withToken), null)
  assert.deepEqual(classifyRecentCandidate("git@github.com:org/agents.git"), { kind: "spec", spec: "git@github.com:org/agents.git" })

  const source: Source = { name: "remote", kind: "git", url: "https://example.com/agents.git", trusted: false }
  recordRecentSourcePath(source, withUser, env)
  recordRecentSourcePath(source, withToken, env)
  assert.equal(fs.existsSync(recentPathsFile(env)), false)
  assert.deepEqual(loadRecentSourcePaths(env), emptyState())
})

test("recent paths: a symlinked config directory or target file makes saving fail", (t) => {
  const env = envFor(t)
  const configDir = path.join(env.XDG_CONFIG_HOME, "manage-agents")
  const elsewhere = tempDir(t, "recent-target-")
  fs.mkdirSync(configDir, { recursive: true })
  fs.rmSync(configDir, { recursive: true, force: true })
  fs.symlinkSync(elsewhere, configDir, "dir")
  assert.throws(() => saveRecentSourcePaths(emptyState(), env), /symlink/i)

  fs.rmSync(configDir, { recursive: true, force: true })
  fs.mkdirSync(configDir, { recursive: true })
  fs.symlinkSync(path.join(elsewhere, "victim.json"), recentPathsFile(env))
  assert.throws(() => saveRecentSourcePaths(emptyState(), env), /non-regular|symlink/i)
})

test("recent paths: symlinked directories are not suggested and stored symlinks are pruned", (t) => {
  const parent = tempDir(t)
  const real = path.join(parent, "alpha")
  const link = path.join(parent, "beta")
  fs.mkdirSync(real)
  fs.symlinkSync(real, link, "dir")
  const entries = [
    { name: "alpha", isDirectory: true, isSymbolicLink: false },
    { name: "beta", isDirectory: false, isSymbolicLink: true },
  ]
  assert.deepEqual(suggestLocalPaths("", entries), ["alpha"])
  assert.deepEqual(suggestLocalPaths("alp", entries), ["alpha"])
  assert.deepEqual(suggestLocalPaths("BET", entries), [])

  const env = envFor(t)
  const source: Source = { name: "local", kind: "local", path: fs.realpathSync(real), trusted: false }
  recordRecentSourcePath(source, real, env)
  assert.equal(loadRecentSourcePaths(env).items.length, 1)
  fs.rmSync(real, { recursive: true, force: true })
  fs.symlinkSync(tempDir(t, "recent-elsewhere-"), real, "dir")
  assert.deepEqual(loadRecentSourcePaths(env).items, [])
})

test("recent paths: config containment and canonical paths without dot segments", (t) => {
  const env = envFor(t)
  const file = recentPathsFile(env)
  assert.equal(file, path.join(env.XDG_CONFIG_HOME, "manage-agents", "recent-source-paths.json"))
  assert.ok(file.startsWith(path.resolve(env.XDG_CONFIG_HOME) + path.sep))
  saveRecentSourcePaths(emptyState(), env)
  assert.equal(fs.existsSync(file), true)
  const insideCache = { ...env, XDG_CONFIG_HOME: path.join(env.XDG_CACHE_HOME, "manage-agents", "config") }
  assert.throws(() => saveRecentSourcePaths(emptyState(), insideCache), /engine cache/)

  const parent = tempDir(t)
  const child = path.join(parent, "repo")
  fs.mkdirSync(child)
  const withDots = `${parent}${path.sep}..${path.sep}${path.basename(parent)}${path.sep}repo`
  const classified = classifyRecentCandidate(withDots)
  assert.ok(classified && classified.kind === "local")
  assert.equal(classified.path, fs.realpathSync(child))
  assert.ok(!classified.path.split(/[\\/]/).includes(".."))
  assert.equal(classifyRecentCandidate("owner/../repo"), null)
})

test("recent paths: ten insertions keep eight entries, dedup by value, newest first", (t) => {
  const env = envFor(t)
  let state = emptyState()
  for (let index = 0; index < 10; index += 1) {
    state = mergeRecentPath(state, { kind: "spec", spec: `https://example.com/repo-${index}.git` })
  }
  const expected = Array.from({ length: 8 }, (_, index) => `https://example.com/repo-${9 - index}.git`)
  assert.equal(state.items.length, 8)
  assert.deepEqual(state.items.map(item => item.kind === "spec" ? item.spec : item.path), expected)

  const duplicate: RecentSourcePath = { kind: "spec", spec: "https://example.com/repo-7.git" }
  const merged = mergeRecentPath(state, duplicate)
  assert.equal(merged.items.length, 8)
  assert.equal(merged.items[0].kind === "spec" && merged.items[0].spec, duplicate.spec)
  assert.equal(merged.items.filter(item => item.kind === "spec" && item.spec === duplicate.spec).length, 1)

  saveRecentSourcePaths(state, env)
  assert.deepEqual(loadRecentSourcePaths(env).items, state.items)
})

test("recent paths: removing a directory from disk drops the entry on reload", (t) => {
  const env = envFor(t)
  const dir = tempDir(t)
  const source: Source = { name: "local", kind: "local", path: fs.realpathSync(dir), trusted: false }
  recordRecentSourcePath(source, dir, env)
  assert.equal(loadRecentSourcePaths(env).items.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
  assert.deepEqual(loadRecentSourcePaths(env).items, [])
})

test("recent paths: restricted file mode and deterministic invalid-schema handling", (t) => {
  const env = envFor(t)
  const file = recentPathsFile(env)
  saveRecentSourcePaths({ schemaVersion: 1, items: [{ kind: "spec", spec: "https://example.com/x.git" }] }, env)
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, items: [] }))
  assert.deepEqual(loadRecentSourcePaths(env), emptyState())
  fs.writeFileSync(file, "{not json")
  assert.deepEqual(loadRecentSourcePaths(env), emptyState())
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, items: [{ kind: "local", path: "/nonexistent/recent-paths-xyz" }, { kind: "unknown" }] }))
  assert.deepEqual(loadRecentSourcePaths(env), emptyState())

  saveRecentSourcePaths(emptyState(), env)
  assert.deepEqual(loadRecentSourcePaths(env), emptyState())
})

test("recent paths: terminal sequences in directory names appear only through terminalSafeText", (t) => {
  const hostile = "repo\x1b[31m\x07\n\x1b]0;title\x07"
  const clean = "safe-repo"
  const entries = [
    { name: hostile, isDirectory: true, isSymbolicLink: false },
    { name: clean, isDirectory: true, isSymbolicLink: false },
  ]
  const suggested = suggestLocalPaths("", entries)
  assert.ok(suggested.includes(terminalSafeText(hostile)))
  assert.ok(suggested.includes(clean))
  assert.ok(suggested.every(name => name === terminalSafeText(name)))
  assert.ok(suggested.every(name => !name.includes("\x1b")))
  assert.deepEqual(suggestLocalPaths("SAFE", entries), [clean])
})
