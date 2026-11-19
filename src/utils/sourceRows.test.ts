import test from "node:test"
import assert from "node:assert/strict"
import type { GhRepoSummary } from "./github.js"
import { buildSourceWorkspaceRows, type SourceWorkspaceRow } from "./sourceRows.js"
import type { Source } from "./sources.js"

const localSource = (name: string, folder = `/tmp/${name}`): Source => ({
  name,
  kind: "local",
  path: folder,
  trusted: false,
})

const gitSource = (name: string, url: string): Source => ({
  name,
  kind: "git",
  url,
  trusted: false,
})

const ghRepo = (nameWithOwner: string, url: string): GhRepoSummary => ({
  nameWithOwner,
  description: "",
  isPrivate: false,
  updatedAt: "",
  url,
})

const connectSpecs = (rows: SourceWorkspaceRow[]): string[] =>
  rows.flatMap(row => (row.kind === "connect-input" ? [row.spec] : []))

test("buildSourceWorkspaceRows puts the connect row first for a path-like query", () => {
  const rows = buildSourceWorkspaceRows({
    query: "/tmp/repo",
    registered: [{ source: localSource("alpha"), revision: null, isActive: false }],
    ghRepos: [],
  })

  assert.equal(rows[0].kind, "connect-input")
  assert.equal(connectSpecs(rows)[0], "/tmp/repo")
  assert.equal(rows[1].kind, "registered")
})

test("buildSourceWorkspaceRows keeps registered first and puts the connect row last for a plain query", () => {
  const rows = buildSourceWorkspaceRows({
    query: "alpha",
    registered: [{ source: localSource("alpha"), revision: "abc123", isActive: true }],
    ghRepos: [],
  })

  assert.equal(rows[0].kind, "registered")
  assert.equal(rows[rows.length - 1].kind, "connect-input")
  assert.deepEqual(connectSpecs(rows), ["alpha"])
})

test("buildSourceWorkspaceRows lists recent suggestions after the main connect row, filtered by query", () => {
  const rows = buildSourceWorkspaceRows({
    query: "/tmp/repo",
    registered: [],
    ghRepos: [],
    recentSuggestions: ["/tmp/repo-a", "/other/path", "/tmp/repo-b", "/tmp/repo-a", " /tmp/repo "],
  })

  assert.deepEqual(connectSpecs(rows), ["/tmp/repo", "/tmp/repo-a", "/tmp/repo-b"])
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
})

test("buildSourceWorkspaceRows excludes gh repos whose url is already registered", () => {
  const rows = buildSourceWorkspaceRows({
    query: "",
    registered: [{ source: gitSource("known", "https://github.com/acme/widget.git"), revision: null, isActive: false }],
    ghRepos: [
      ghRepo("acme/widget", "https://github.com/acme/widget"),
      ghRepo("acme/other", "https://github.com/acme/other"),
    ],
  })

  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, "registered")
  assert.equal(rows[1].kind, "gh-repo")
  assert.equal(rows[1].kind === "gh-repo" ? rows[1].repo.nameWithOwner : null, "acme/other")
})

test("buildSourceWorkspaceRows emits no connect row for an empty query", () => {
  const rows = buildSourceWorkspaceRows({
    query: "   ",
    registered: [{ source: localSource("alpha"), revision: null, isActive: false }],
    ghRepos: [],
    recentSuggestions: ["/tmp/repo"],
  })

  assert.deepEqual(connectSpecs(rows), [])
  assert.deepEqual(rows.map(row => row.kind), ["registered"])
})
