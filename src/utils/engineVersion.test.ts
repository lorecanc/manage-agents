import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  computeEngineBundleHash,
  defaultEngineRepository,
  readEngineReleaseManifest,
  resolveEngineRoot,
  resolveEngineVersion,
  stampAppliedEngineManifest,
  writeEngineReleaseManifest,
} from "./engineVersion.js"
import { cleanGitEnvironment } from "./repositoryTransaction.js"

function makeFakeEngineDir(prefix = "ma-engver-"): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "manage-agents",
      version: "1.2.3",
      repository: { type: "git", url: "git+https://github.com/lorecanc/manage-agents.git" },
    }),
  )
  fs.writeFileSync(path.join(root, "manage-agents.mjs"), "#!/usr/bin/env node\n")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "index.tsx"), "export const ok = 1\n")
  fs.writeFileSync(path.join(root, "src", "index.test.ts"), "export const ignored = 2\n")
  fs.mkdirSync(path.join(root, "assets"), { recursive: true })
  fs.writeFileSync(path.join(root, "assets", "logo.svg"), "<svg/>")
  fs.mkdirSync(path.join(root, "contract"), { recursive: true })
  fs.writeFileSync(path.join(root, "contract", "CONTRACT.md"), "# Contract\n")
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true })
  fs.writeFileSync(path.join(root, "runtime", "router.mjs"), "export default {}\n")
  return root
}

test("package files allowlists only the official plugin icon asset", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { files?: string[] }

  assert.ok(Array.isArray(packageJson.files))
  assert.equal(packageJson.files.includes("assets"), false)
  assert.ok(packageJson.files.includes("assets/plugin-icon.png"))
  assert.equal(fs.lstatSync(new URL("../../assets/plugin-icon.png", import.meta.url)).isFile(), true)
})

test("resolveEngineRoot locates this repository and follows symlinked engine roots", () => {
  const currentRoot = resolveEngineRoot()
  assert.equal(fs.existsSync(path.join(currentRoot, "manage-agents.mjs")), true)
  assert.equal(defaultEngineRepository(currentRoot), "lorecanc/manage-agents")

  if (process.platform !== "win32") {
    const realRoot = makeFakeEngineDir("ma-englink-real-")
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "ma-englink-sym-"))
    const symPath = path.join(linkParent, "linked-engine")
    try {
      fs.symlinkSync(realRoot, symPath, "dir")
      assert.equal(resolveEngineRoot(symPath), realRoot)
    } finally {
      fs.rmSync(realRoot, { recursive: true, force: true })
      fs.rmSync(linkParent, { recursive: true, force: true })
    }
  }
})

test("computeEngineBundleHash ignores test files and detects runtime source changes", () => {
  const root = makeFakeEngineDir()
  try {
    const h1 = computeEngineBundleHash(root)
    fs.writeFileSync(path.join(root, "src", "index.test.ts"), "export const ignored = 999\n")
    assert.equal(computeEngineBundleHash(root), h1)

    fs.writeFileSync(path.join(root, "src", "index.tsx"), "export const ok = 2\n")
    const h2 = computeEngineBundleHash(root)
    assert.notEqual(h2, h1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("writeEngineReleaseManifest and resolveEngineVersion report clean release vs modified bundle", () => {
  const root = makeFakeEngineDir()
  try {
    const sha = "a".repeat(40)
    const manifest = writeEngineReleaseManifest(root, {
      refType: "tag",
      refName: "v1.2.3",
      sha,
      builtAt: "2026-11-12T10:00:00.000Z",
    })
    assert.equal(manifest.version, "v1.2.3")
    assert.equal(readEngineReleaseManifest(root)?.bundleHash, manifest.bundleHash)

    const clean = resolveEngineVersion(root)
    assert.equal(clean.channel, "release")
    assert.equal(clean.version, "v1.2.3")
    assert.equal(clean.dirty, false)

    fs.writeFileSync(path.join(root, "manage-agents.mjs"), "#!/usr/bin/env node\n// tampered\n")
    const modified = resolveEngineVersion(root)
    assert.equal(modified.dirty, true)
    assert.equal(modified.version, `sha-${sha.slice(0, 7)}-dirty`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveEngineVersion handles clean git tag, clean git commit, dirty git, and stamped release over git", () => {
  const root = makeFakeEngineDir("ma-enggit-")
  try {
    const git = (args: string[]) =>
      spawnSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        env: cleanGitEnvironment({
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        }),
        windowsHide: true,
      })

    git(["init"])
    git(["add", "."])
    git(["commit", "-m", "init"])
    const head1 = git(["rev-parse", "HEAD"]).stdout.trim()

    const cleanGit = resolveEngineVersion(root)
    assert.equal(cleanGit.channel, "git")
    assert.equal(cleanGit.dirty, false)
    assert.equal(cleanGit.version, `sha-${head1.slice(0, 7)}`)

    git(["tag", "v1.2.3"])
    const taggedGit = resolveEngineVersion(root)
    assert.equal(taggedGit.channel, "git-tag")
    assert.equal(taggedGit.dirty, false)
    assert.equal(taggedGit.version, "v1.2.3")

    // Simulate applying release v1.3.0 over the existing git checkout
    fs.writeFileSync(path.join(root, "src", "index.tsx"), "export const ok = 130\n")
    const manifest = writeEngineReleaseManifest(root, {
      refType: "tag",
      refName: "v1.3.0",
      sha: "b".repeat(40),
      builtAt: "2026-11-12T12:00:00.000Z",
    })
    stampAppliedEngineManifest(root, manifest)

    const stamped = resolveEngineVersion(root)
    assert.equal(stamped.channel, "release")
    assert.equal(stamped.version, "v1.3.0")
    assert.equal(stamped.dirty, false)

    // Subsequent local edit marks worktree dirty again
    fs.writeFileSync(path.join(root, "src", "index.tsx"), "export const ok = 999\n")
    const dirtyAfterEdit = resolveEngineVersion(root)
    assert.equal(dirtyAfterEdit.dirty, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
