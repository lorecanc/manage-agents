import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { tempDir, writePack } from "../../test/helpers.js"
import { addSource, deriveSourceName, discoverPacks, ghCredentialArgs, hasUrlCredentials, isSourceSpecLike, loadSources, pullSource, redactUrlCredentials, removeSource, saveSources, sourceRevision, validateSourceSpec, type SourceRegistry } from "./sources.js"

const emptyRegistry = (): SourceRegistry => ({ schemaVersion: 1, sources: [], prefer: {} })
const envFor = (t: test.TestContext) => {
  const base = tempDir(t)
  return { XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
}

test("registry: add, save, load and remove sources; preferences follow removals", (t) => {
  const env = envFor(t)
  const dir = tempDir(t)
  const registry = emptyRegistry()
  addSource(registry, "catalog", dir, { trusted: true })
  addSource(registry, "remote", "https://example.com/agents.git", { ref: "v2" })
  registry.prefer.flow = "remote"
  saveSources(registry, env)

  const file = path.join(env.XDG_CONFIG_HOME, "manage-agents", "sources.json")
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const loaded = loadSources(env)
  assert.deepEqual(loaded.sources.map(source => [source.name, source.kind, source.trusted]), [["catalog", "local", true], ["remote", "git", false]])
  assert.equal(loaded.sources[0].kind === "local" && loaded.sources[0].path, fs.realpathSync(dir))

  removeSource(loaded, "remote")
  assert.deepEqual(loaded.prefer, {})
})

test("registry: rejects bad names, duplicates, unsupported URLs, file: URLs and refs on local sources", (t) => {
  const registry = emptyRegistry()
  const dir = tempDir(t)
  addSource(registry, "ok", dir)

  assert.throws(() => addSource(registry, "../escape", dir), /invalid source name/)
  assert.throws(() => addSource(registry, "ok", dir), /already exists/)
  assert.throws(() => addSource(registry, "ftp", "ftp://example.com/x"), /unsupported source URL/)
  assert.throws(() => addSource(registry, "file", "file:///tmp/repo"), /unsupported source URL/)
  assert.throws(() => addSource(registry, "dash", "git@host:-oProxyCommand=x"), /unsupported source URL|not a directory/)
  assert.throws(() => addSource(registry, "badref", "https://example.com/x.git", { ref: "--upload-pack=x" }), /invalid git ref/)
  assert.throws(() => addSource(registry, "localref", dir, { ref: "main" }), /only to git sources/)
  assert.throws(() => addSource(registry, "missing", path.join(dir, "nope")), /not a directory/)
  assert.throws(() => addSource(registry, "token", "https://user:secret@example.com/x.git"), /credentials in source URLs/)
  assert.throws(() => addSource(registry, "token2", "https://ghp_token@example.com/x.git"), /credentials in source URLs/)
  assert.throws(() => addSource(registry, "querytoken", "https://github.com/org/x.git?access_token=secret"), /credentials in source URLs/)
  assert.doesNotThrow(() => addSource(registry, "ssh", "ssh://git@example.com/x.git"))
})

test("registry: hand-edited entries are validated on load, so a name cannot escape the cache", (t) => {
  const env = envFor(t)
  const file = path.join(env.XDG_CONFIG_HOME, "manage-agents", "sources.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sources: [{ name: "../../outside", kind: "git", url: "https://example.com/x.git", trusted: false }] }))
  assert.throws(() => loadSources(env), /invalid source entry/)

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sources: [], prefer: { flow: "ghost" } }))
  assert.throws(() => loadSources(env), /invalid "prefer" map/)
})

test("registry: rejects credential-bearing git URLs without echoing credentials", (t) => {
  const env = envFor(t)
  const file = path.join(env.XDG_CONFIG_HOME, "manage-agents", "sources.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    sources: [{ name: "secret", kind: "git", url: "https://secret-token@github.com/org/repo.git", trusted: false }],
    prefer: {},
  }))

  assert.throws(() => loadSources(env), error => {
    assert.match((error as Error).message, /https:\/\/github\.com\/org\/repo\.git/)
    assert.doesNotMatch((error as Error).message, /secret-token/)
    return true
  })
})

test("source URLs: redact credentials and query strings without changing public URLs", () => {
  assert.equal(redactUrlCredentials("https://user:secret@github.com/org/repo.git?token=hidden"), "https://github.com/org/repo.git")
  assert.equal(redactUrlCredentials("ssh://git:secret@github.com/org/repo.git?token=hidden"), "ssh://git@github.com/org/repo.git")
  assert.equal(redactUrlCredentials("user:secret@github.com:org/repo.git"), "user@github.com:org/repo.git")
  assert.equal(redactUrlCredentials("https://github.com/org/repo.git"), "https://github.com/org/repo.git")
  assert.equal(redactUrlCredentials("git@github.com:org/repo.git"), "git@github.com:org/repo.git")
  assert.equal(hasUrlCredentials("https://token@github.com/org/repo.git"), true)
  assert.equal(hasUrlCredentials("ssh://git:secret@github.com/org/repo.git"), true)
  assert.equal(hasUrlCredentials("user:secret@github.com:org/repo.git"), true)
  assert.equal(hasUrlCredentials("ssh://git@github.com/org/repo.git"), false)
  assert.equal(hasUrlCredentials("git@github.com:org/repo.git"), false)
})

test("source specs: validateSourceSpec resolves a local directory and rejects bad specs", (t) => {
  const dir = tempDir(t)
  const env = envFor(t)

  const local = validateSourceSpec(dir, env)
  assert.deepEqual(local, { ok: true, kind: "local", path: fs.realpathSync(dir), spec: dir })

  const missing = validateSourceSpec(path.join(dir, "nope"), env)
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error, /not a directory/)

  const withCredentials = validateSourceSpec("https://user:secret@example.com/x.git", env)
  assert.equal(withCredentials.ok, false)
  if (!withCredentials.ok) {
    assert.match(withCredentials.error, /credentials in source URLs/)
    assert.doesNotMatch(withCredentials.error, /secret/)
  }
})

test("source specs: isSourceSpecLike distinguishes path-like queries from plain filters", () => {
  for (const query of ["/tmp/repo", "~/repo", "./repo", "../repo", "owner/repo", "repo\\sub"]) {
    assert.equal(isSourceSpecLike(query), true, query)
  }
  for (const query of ["alpha", "flow", "my filter query"]) {
    assert.equal(isSourceSpecLike(query), false, query)
  }
})

test("source specs: addSource still registers a local directory through the shared resolver", (t) => {
  const dir = tempDir(t)
  const env = envFor(t)
  const registry = emptyRegistry()
  const source = addSource(registry, "local", dir, { trusted: true })
  assert.deepEqual(source, { name: "local", kind: "local", path: fs.realpathSync(dir), trusted: true })

  saveSources(registry, env)
  const loaded = loadSources(env)
  assert.equal(loaded.sources[0].kind === "local" && loaded.sources[0].path, fs.realpathSync(dir))
})

test("discovery: finds packs, does not descend into a pack, reports broken manifests and unpulled git sources", (t) => {
  const env = envFor(t)
  const root = tempDir(t)
  writePack(path.join(root, "packs", "flow"), {}, { name: "flow" })
  writePack(path.join(root, "packs", "flow", "nested"), {}, { name: "nested" })
  writePack(path.join(root, "packs", "broken"), {}, { name: "Bad Name" })
  writePack(path.join(root, "node_modules", "x"), {}, { name: "hidden" })
  const registry = emptyRegistry()
  const local = addSource(registry, "local", root)
  const remote = addSource(registry, "remote", "https://example.com/x.git")

  const found = discoverPacks(local, env)
  assert.deepEqual(found.candidates.map(candidate => `${candidate.relativeDir} ${candidate.manifest.name}`), ["packs/flow flow"])
  assert.equal(found.problems.length, 1)
  assert.match(found.problems[0], /packs\/broken/)
  assert.match(discoverPacks(remote, env).problems[0], /has not been pulled yet/)
})

const hasGit = spawnSync("git", ["--version"]).status === 0

function gitIn(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test("git sources: reject credential-bearing source objects", (t) => {
  const env = envFor(t)
  const source = { name: "secret", kind: "git" as const, url: "https://secret-token@github.com/org/repo.git", trusted: false }
  assert.throws(() => pullSource(source, env), error => {
    assert.match((error as Error).message, /credentials in source URLs/)
    assert.doesNotMatch((error as Error).message, /secret-token/)
    return true
  })
})

test("git sources: refuse a symlinked cache entry without mutating its external repository", { skip: !hasGit || process.platform === "win32" }, (t) => {
  const env = envFor(t)
  const external = tempDir(t)
  gitIn(external, "init", "--quiet", "--initial-branch=main")
  writePack(path.join(external, "packs", "flow"), {}, { name: "flow" })
  gitIn(external, "add", "-A")
  gitIn(external, "commit", "--quiet", "-m", "initial")
  gitIn(external, "remote", "add", "origin", "https://example.com/original.git")
  const originalRevision = gitIn(external, "rev-parse", "HEAD")
  const originalRemote = gitIn(external, "remote", "get-url", "origin")

  const cached = path.join(env.XDG_CACHE_HOME, "manage-agents", "sources", "linked")
  fs.mkdirSync(path.dirname(cached), { recursive: true })
  fs.symlinkSync(external, cached, "dir")
  const source = { name: "linked", kind: "git" as const, url: `file://${external}`, trusted: false }

  assert.throws(() => pullSource(source, env, { allowFileUrls: true }), /symlink/)
  assert.equal(gitIn(external, "remote", "get-url", "origin"), originalRemote)
  assert.equal(gitIn(external, "rev-parse", "HEAD"), originalRevision)
})

test("git sources: clone, follow a moving branch, pin a tag, reject unknown refs", { skip: !hasGit }, (t) => {
  const env = envFor(t)
  const work = tempDir(t)
  gitIn(work, "init", "--quiet", "--initial-branch=main")
  writePack(path.join(work, "packs", "flow"), {}, { name: "flow", version: "1.0.0" })
  gitIn(work, "add", "-A")
  gitIn(work, "commit", "--quiet", "-m", "v1")
  gitIn(work, "tag", "v1")
  const first = gitIn(work, "rev-parse", "HEAD")

  const registry = emptyRegistry()
  const url = `file://${work}`
  const branch = addSource(registry, "branch", url, { ref: "main" }, { allowFileUrls: true })
  const tag = addSource(registry, "tag", url, { ref: "v1" }, { allowFileUrls: true })
  const missing = addSource(registry, "missing", url, { ref: "nope" }, { allowFileUrls: true })

  assert.equal(pullSource(branch, env, { allowFileUrls: true }), first)
  assert.equal(sourceRevision(branch, env), first)
  assert.equal(discoverPacks(branch, env).candidates[0].manifest.version, "1.0.0")

  writePack(path.join(work, "packs", "flow"), {}, { name: "flow", version: "1.1.0" })
  gitIn(work, "commit", "--quiet", "-am", "v1.1")
  const second = gitIn(work, "rev-parse", "HEAD")
  assert.equal(pullSource(branch, env, { allowFileUrls: true }), second)
  assert.equal(discoverPacks(branch, env).candidates[0].manifest.version, "1.1.0")

  assert.equal(pullSource(tag, env, { allowFileUrls: true }), first)
  assert.throws(() => pullSource(missing, env, { allowFileUrls: true }), /ref "nope" not found/)
  assert.throws(() => pullSource(branch, env), /refusing git URL/)

  const other = tempDir(t)
  gitIn(other, "init", "--quiet", "--initial-branch=main")
  writePack(path.join(other, "packs", "other"), {}, { name: "other" })
  gitIn(other, "add", "-A")
  gitIn(other, "commit", "--quiet", "-m", "other")
  removeSource(registry, "branch")
  const readded = addSource(registry, "branch", `file://${other}`, { ref: "main" }, { allowFileUrls: true })
  assert.equal(pullSource(readded, env, { allowFileUrls: true }), gitIn(other, "rev-parse", "HEAD"))
  assert.deepEqual(discoverPacks(readded, env).candidates.map(candidate => candidate.manifest.name), ["other"])
})

test("GitHub shorthand, derived source names, active source persistence and gh credential helper args", (t) => {
  const env = envFor(t)
  const registry = emptyRegistry()

  const firstName = deriveSourceName("lorecanc/agents", registry)
  assert.equal(firstName, "agents")
  const ghSource = addSource(registry, firstName, "lorecanc/agents#main")
  assert.deepEqual(ghSource, {
    name: "agents",
    kind: "git",
    url: "https://github.com/lorecanc/agents.git",
    ref: "main",
    trusted: false,
  })

  const secondName = deriveSourceName("github:other-org/agents.git", registry)
  assert.equal(secondName, "agents-2")
  const second = addSource(registry, secondName, "github:other-org/agents.git")
  assert.equal(second.kind === "git" && second.url, "https://github.com/other-org/agents.git")

  assert.throws(() => addSource(registry, "conflict", "lorecanc/agents#v1", { ref: "v2" }), /conflicting git refs/)
  assert.throws(() => addSource(registry, "badgh", "github:../escape"), /invalid GitHub repository/)

  registry.active = "agents-2"
  saveSources(registry, env)
  const loaded = loadSources(env)
  assert.equal(loaded.active, "agents-2")

  removeSource(loaded, "agents-2")
  assert.equal(loaded.active, "agents")
  removeSource(loaded, "agents")
  assert.equal(loaded.active, undefined)

  const authedGh = {
    run: () => ({
      status: 0,
      stdout: JSON.stringify({ hosts: { "github.com": [{ login: "lorecanc", active: true, state: "success" }] } }),
      stderr: "",
    }),
  }
  const unauthedGh = {
    run: () => ({ status: 1, stdout: "{}", stderr: "not logged in" }),
  }
  assert.deepEqual(ghCredentialArgs("https://github.com/lorecanc/agents.git", env, { ghRunner: authedGh }), [
    "-c",
    "credential.https://github.com.helper=",
    "-c",
    "credential.https://github.com.helper=!gh auth git-credential",
  ])
  assert.deepEqual(ghCredentialArgs("https://github.com/lorecanc/agents.git", env, { ghRunner: unauthedGh }), [])
  assert.deepEqual(ghCredentialArgs("ssh://git@github.com/lorecanc/agents.git", env, { ghRunner: authedGh }), [])
})

test("CLI source add <owner/repo> auto-names source and source auth --json reports gh status", { skip: process.platform === "win32" }, (t) => {
  const env = envFor(t)
  const binDir = path.join(tempDir(t), "bin")
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/bin/sh\necho '{"hosts":{"github.com":[{"login":"lorecanc","active":true,"state":"success"}]}}'\n`,
    { mode: 0o755 },
  )
  const cliEnv = { ...process.env, ...env, PATH: `${binDir}:${process.env.PATH}` }
  const launcher = path.resolve("manage-agents.mjs")

  const addRes = spawnSync(process.execPath, [launcher, "source", "add", "lorecanc/agents#main"], {
    encoding: "utf8",
    env: cliEnv,
  })
  assert.equal(addRes.status, 0, addRes.stderr)
  assert.match(addRes.stdout, /Added git source agents/)

  const listRes = spawnSync(process.execPath, [launcher, "source", "list"], { encoding: "utf8", env: cliEnv })
  assert.equal(listRes.status, 0, listRes.stderr)
  assert.match(listRes.stdout, /\* agents\s+git\s+untrusted\s+https:\/\/github\.com\/lorecanc\/agents\.git#main/)

  const authRes = spawnSync(process.execPath, [launcher, "source", "auth", "--json"], { encoding: "utf8", env: cliEnv })
  assert.equal(authRes.status, 0, authRes.stderr)
  const authJson = JSON.parse(authRes.stdout)
  assert.equal(authJson.authenticated, true)
  assert.equal(authJson.login, "lorecanc")
})
