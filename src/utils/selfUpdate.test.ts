import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { writeEngineReleaseManifest } from "./engineVersion.js"
import { cleanGitEnvironment } from "./repositoryTransaction.js"
import {
  applyEngineUpdate,
  checkForEngineUpdate,
  compareReleaseTags,
  createDefaultReleaseTransport,
  generateReleaseSigningKeypair,
  recoverInterruptedSelfUpdate,
  RELEASE_METADATA_ASSET_NAME,
  RELEASE_SIGNATURE_ASSET_NAME,
  releaseArchiveName,
  resolveReleaseTrustPolicy,
  signReleaseAssets,
  type GitHubReleaseAsset,
  type GitHubReleasePayload,
  type ReleaseTransport,
} from "./selfUpdate.js"

function scaffoldEngineRoot(dir: string, version: string, marker = version): void {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true })
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true })
  fs.mkdirSync(path.join(dir, "contract"), { recursive: true })
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true })

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "manage-agents",
        version: version.replace(/^v/, ""),
        repository: { type: "git", url: "git+https://github.com/lorecanc/manage-agents.git" },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "manage-agents", lockfileVersion: 3, version: version.replace(/^v/, "") }))
  fs.writeFileSync(path.join(dir, "manage-agents.mjs"), `#!/usr/bin/env node\n// ${marker}\n`)
  fs.writeFileSync(path.join(dir, "src", "index.tsx"), `export const VERSION = "${marker}"\n`)
  fs.writeFileSync(path.join(dir, "dist", "index.js"), `export const BUILT = "${marker}"\n`)
  fs.writeFileSync(path.join(dir, "assets", "icon.svg"), "<svg/>")
  fs.writeFileSync(path.join(dir, "contract", "CONTRACT.md"), `# Contract ${marker}\n`)
  fs.writeFileSync(path.join(dir, "runtime", "router.mjs"), `export const ROUTER = "${marker}"\n`)
  fs.writeFileSync(path.join(dir, "README.md"), `# manage-agents ${marker}\n`)
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true })
}

function buildReleaseFixture(opts: {
  baseDir: string
  tag: string
  sha: string
  signingEngineRoot?: string
  privateKeyPem?: string
}): { transport: ReleaseTransport; assetsDir: string } {
  const pkgName = `manage-agents-${opts.tag}`
  const stageParent = path.join(opts.baseDir, `stage-${opts.tag}`)
  const pkgStage = path.join(stageParent, pkgName)
  const assetsDir = path.join(opts.baseDir, `assets-${opts.tag}`)
  fs.mkdirSync(pkgStage, { recursive: true })
  fs.mkdirSync(assetsDir, { recursive: true })

  scaffoldEngineRoot(pkgStage, opts.tag, `release-${opts.tag}`)
  writeEngineReleaseManifest(pkgStage, {
    refType: "tag",
    refName: opts.tag,
    sha: opts.sha,
    builtAt: "2026-11-13T10:00:00.000Z",
  })

  const archivePath = path.join(assetsDir, releaseArchiveName(opts.tag))
  const tarRes = spawnSync("tar", ["-czf", archivePath, "-C", stageParent, pkgName], { windowsHide: true })
  assert.equal(tarRes.status, 0)

  const signRoot = opts.signingEngineRoot ?? pkgStage
  signReleaseAssets(signRoot, {
    tag: opts.tag,
    sha: opts.sha,
    assetsDir,
    privateKeyPem: opts.privateKeyPem,
    builtAt: "2026-11-13T10:01:00.000Z",
    allowUnsigned: !opts.privateKeyPem,
  })

  const assetFiles = fs.readdirSync(assetsDir)
  const assets: GitHubReleaseAsset[] = assetFiles.map((name, idx) => ({
    id: idx + 1,
    name,
    size: fs.statSync(path.join(assetsDir, name)).size,
  }))
  const payload: GitHubReleasePayload = {
    tag_name: opts.tag,
    assets,
  }

  const transport: ReleaseTransport = {
    async getLatestRelease() {
      return payload
    },
    async downloadAsset(_repo, asset) {
      return fs.readFileSync(path.join(assetsDir, asset.name))
    },
  }
  return { transport, assetsDir }
}

test("compareReleaseTags orders semantic versions and prereleases", () => {
  assert.equal(compareReleaseTags("v1.0.0", "v1.0.0"), 0)
  assert.equal(compareReleaseTags("v1.1.0", "v1.0.9"), 1)
  assert.equal(compareReleaseTags("v1.0.0", "v1.2.0"), -1)
  assert.equal(compareReleaseTags("v1.2.0-rc.1", "v1.2.0"), -1)
  assert.equal(compareReleaseTags("v1.2.0-rc.10", "v1.2.0-rc.2"), 1)
  assert.equal(compareReleaseTags("not-semver", "v1.0.0"), null)
})

test("zero-config SHA-256 self-update checks, applies, installs changed deps, and blocks downgrades", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-selfup-sha-")))
  const targetDir = path.join(tmp, "opencode-target")
  try {
    const engineDir = path.join(tmp, "engine")
    scaffoldEngineRoot(engineDir, "v1.0.0")
    writeEngineReleaseManifest(engineDir, {
      refType: "tag",
      refName: "v1.0.0",
      sha: "1".repeat(40),
      builtAt: "2026-11-10T10:00:00.000Z",
    })

    const { transport } = buildReleaseFixture({
      baseDir: tmp,
      tag: "v1.1.0",
      sha: "2".repeat(40),
    })

    const check = await checkForEngineUpdate(engineDir, { transport, target: targetDir, allowUnsigned: true })
    assert.equal(check.verificationMode, "sha256")
    assert.equal(check.updateAvailable, true)
    assert.equal(check.downgrade, false)

    let depInstalls = 0
    const steps: string[] = []
    const applied = await applyEngineUpdate(engineDir, {
      transport,
      target: targetDir,
      allowUnsigned: true,
      dependencyInstaller: () => {
        depInstalls++
      },
      onProgress: msg => steps.push(msg),
    })

    assert.equal(applied.applied, true)
    assert.equal(applied.dependenciesInstalled, true)
    assert.equal(depInstalls, 1)
    assert.equal(applied.versionInfo.version, "v1.1.0")
    assert.equal(applied.versionInfo.channel, "release")
    assert.match(fs.readFileSync(path.join(engineDir, "dist", "index.js"), "utf8"), /release-v1\.1\.0/)
    assert.ok(steps.length >= 3)

    // Subsequent check reports up-to-date
    const afterCheck = await checkForEngineUpdate(engineDir, { transport, target: targetDir, allowUnsigned: true })
    assert.equal(afterCheck.updateAvailable, false)

    // Older release v1.0.5 is flagged as downgrade and refused without --force
    const older = buildReleaseFixture({
      baseDir: tmp,
      tag: "v1.0.5",
      sha: "3".repeat(40),
    })
    const downgradeCheck = await checkForEngineUpdate(engineDir, { transport: older.transport, target: targetDir, allowUnsigned: true })
    assert.equal(downgradeCheck.downgrade, true)
    assert.equal(downgradeCheck.updateAvailable, false)
    await assert.rejects(
      () => applyEngineUpdate(engineDir, { transport: older.transport, target: targetDir, skipDependencyInstall: true, allowUnsigned: true }),
      /older than installed.*--force/,
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("Ed25519 trust policy verifies signed releases, preserves release-signing.json, and blocks signature stripping", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-selfup-sig-")))
  const targetDir = path.join(tmp, "opencode-target")
  try {
    const engineDir = path.join(tmp, "engine")
    scaffoldEngineRoot(engineDir, "v1.0.0")
    const keygen = generateReleaseSigningKeypair(engineDir, {
      outPrivateKeyPath: path.join(tmp, "private.pem"),
      repository: "lorecanc/manage-agents",
    })
    writeEngineReleaseManifest(engineDir, {
      refType: "tag",
      refName: "v1.0.0",
      sha: "a".repeat(40),
      builtAt: "2026-11-10T10:00:00.000Z",
    })

    const signed = buildReleaseFixture({
      baseDir: tmp,
      tag: "v1.2.0",
      sha: "b".repeat(40),
      signingEngineRoot: engineDir,
      privateKeyPem: keygen.privateKeyPem,
    })

    const check = await checkForEngineUpdate(engineDir, { transport: signed.transport, target: targetDir })
    assert.equal(check.verificationMode, "ed25519")
    assert.equal(check.metadata.signed, true)
    assert.equal(check.metadata.keyId, keygen.keyId)

    // Strip signature from release assets: must be rejected because release-signing.json exists!
    const strippedTransport: ReleaseTransport = {
      async getLatestRelease(repo) {
        const rel = await signed.transport.getLatestRelease(repo)
        return { ...rel, assets: rel.assets.filter(a => a.name !== RELEASE_SIGNATURE_ASSET_NAME) }
      },
      downloadAsset: signed.transport.downloadAsset,
    }
    await assert.rejects(
      () => checkForEngineUpdate(engineDir, { transport: strippedTransport, target: targetDir, allowUnsigned: true }),
      /missing 'release-metadata\.json\.sig'/,
    )

    // Apply genuine signed release and ensure local release-signing.json is preserved
    const res = await applyEngineUpdate(engineDir, {
      transport: signed.transport,
      target: targetDir,
      allowUnsigned: true,
      skipDependencyInstall: true,
    })
    assert.equal(res.applied, true)
    assert.equal(res.versionInfo.version, "v1.2.0")
    assert.equal(fs.existsSync(path.join(engineDir, "release-signing.json")), true)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("applyEngineUpdate refuses dirty git worktree without --force and rolls back cleanly on installer failure", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-selfup-rb-")))
  const targetDir = path.join(tmp, "opencode-target")
  try {
    const engineDir = path.join(tmp, "engine")
    scaffoldEngineRoot(engineDir, "v1.0.0", "orig-v1")
    const gitEnv = cleanGitEnvironment({
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    })
    spawnSync("git", ["-C", engineDir, "init"], { env: gitEnv, windowsHide: true })
    fs.writeFileSync(path.join(engineDir, ".gitignore"), ".manage-agents/\nnode_modules/\n")
    spawnSync("git", ["-C", engineDir, "add", "."], { env: gitEnv, windowsHide: true })
    spawnSync("git", ["-C", engineDir, "commit", "-m", "init"], { env: gitEnv, windowsHide: true })

    const { transport } = buildReleaseFixture({
      baseDir: tmp,
      tag: "v1.1.0",
      sha: "c".repeat(40),
    })

    // Dirty worktree blocked
    fs.writeFileSync(path.join(engineDir, "README.md"), "uncommitted local edit\n")
    await assert.rejects(
      () => applyEngineUpdate(engineDir, { transport, target: targetDir, skipDependencyInstall: true, allowUnsigned: true }),
      /uncommitted changes/,
    )

    // Restore clean worktree and simulate dependency installer failure -> full rollback!
    spawnSync("git", ["-C", engineDir, "checkout", "--", "README.md"], { env: gitEnv, windowsHide: true })
    await assert.rejects(
      () =>
        applyEngineUpdate(engineDir, {
          transport,
          target: targetDir,
          allowUnsigned: true,
          dependencyInstaller: () => {
            throw new Error("simulated npm ci failure")
          },
        }),
      /simulated npm ci failure/,
    )
    assert.match(fs.readFileSync(path.join(engineDir, "dist", "index.js"), "utf8"), /orig-v1/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("createDefaultReleaseTransport retries Windows HTTP/2 resets with GODEBUG=http2client=0 and falls back to fetch", async () => {
  const seenGodebug: Array<string | undefined> = []
  let ghCalls = 0
  const transportRetry = createDefaultReleaseTransport({
    env: {},
    spawnImpl: ((_cmd: string, _args: readonly string[], opts: any) => {
      ghCalls++
      seenGodebug.push(opts?.env?.GODEBUG)
      if (ghCalls === 1) {
        return {
          status: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("read tcp: wsarecv: An existing connection was forcibly closed by the remote host."),
        } as any
      }
      return {
        status: 0,
        stdout: Buffer.from(JSON.stringify({ tag_name: "v1.0.0", assets: [{ id: 7, name: RELEASE_METADATA_ASSET_NAME }] })),
        stderr: Buffer.alloc(0),
      } as any
    }) as any,
  })

  const rel = await transportRetry.getLatestRelease("lorecanc/manage-agents")
  assert.equal(rel.tag_name, "v1.0.0")
  assert.equal(ghCalls, 2)
  assert.equal(seenGodebug[0], undefined)
  assert.equal(seenGodebug[1], "http2client=0")

  // Public repository fallback via fetch when gh CLI is unavailable and no token is configured
  const transportPublicFetch = createDefaultReleaseTransport({
    env: {},
    spawnImpl: (() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("gh not installed") }) as any) as any,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ tag_name: "v2.0.0", assets: [] }), { status: 200 })) as any,
  })
  const fetched = await transportPublicFetch.getLatestRelease("lorecanc/manage-agents")
  assert.equal(fetched.tag_name, "v2.0.0")
})

test("release trust is fail-closed by default and allowUnsigned only enables SHA-256 without configured keys", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-selfup-trust-policy-")))
  try {
    const engineDir = path.join(tmp, "engine")
    scaffoldEngineRoot(engineDir, "v1.0.0")
    assert.throws(
      () => resolveReleaseTrustPolicy(engineDir, { env: {} }),
      /Configure release-signing\.json or MANAGE_AGENTS_RELEASE_PUBLIC_KEY.*--allow-unsigned/,
    )
    assert.equal(resolveReleaseTrustPolicy(engineDir, { env: {}, allowUnsigned: true }).requireSignature, false)
    assert.equal(resolveReleaseTrustPolicy(engineDir, { env: { MANAGE_AGENTS_ALLOW_UNSIGNED: "1" } }).requireSignature, false)

    generateReleaseSigningKeypair(engineDir, { repository: "lorecanc/manage-agents" })
    const configuredPolicy = resolveReleaseTrustPolicy(engineDir, { env: {}, allowUnsigned: true })
    assert.equal(configuredPolicy.requireSignature, true)
    assert.equal(configuredPolicy.publicKeys.length, 1)
    assert.equal(resolveReleaseTrustPolicy(engineDir, { env: {}, allowUnsigned: true, requireSignature: false }).requireSignature, true)

    const unsigned = buildReleaseFixture({ baseDir: tmp, tag: "v1.1.0", sha: "d".repeat(40) })
    await assert.rejects(
      () =>
        checkForEngineUpdate(engineDir, {
          transport: unsigned.transport,
          target: path.join(tmp, "opencode-target"),
          allowUnsigned: true,
          requireSignature: false,
        }),
      /missing 'release-metadata\.json\.sig'/,
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("applyEngineUpdate replaces the launcher last with a same-filesystem atomic rename", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-selfup-launcher-atomic-")))
  const engineDir = path.join(tmp, "engine")
  try {
    scaffoldEngineRoot(engineDir, "v1.0.0", "original")
    writeEngineReleaseManifest(engineDir, {
      refType: "tag",
      refName: "v1.0.0",
      sha: "1".repeat(40),
      builtAt: "2026-11-10T10:00:00.000Z",
    })
    const originalLauncher = fs.readFileSync(path.join(engineDir, "manage-agents.mjs"), "utf8")
    const { transport } = buildReleaseFixture({ baseDir: tmp, tag: "v1.1.0", sha: "e".repeat(40) })
    const launcherPath = path.join(engineDir, "manage-agents.mjs")
    const replacementOrder: string[] = []
    let launcherRenameCount = 0
    const originalRenameSync = fs.renameSync
    fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
      const sourcePath = path.resolve(String(source))
      const targetPath = path.resolve(String(target))
      const sourceParts = path.relative(engineDir, sourcePath).split(path.sep)
      if (sourceParts.includes("self-update-backup") && sourceParts.includes("stage")) {
        replacementOrder.push(path.relative(engineDir, targetPath))
        if (targetPath === launcherPath) {
          launcherRenameCount++
          assert.equal(fs.readFileSync(launcherPath, "utf8"), originalLauncher)
          assert.ok(sourcePath.startsWith(path.join(engineDir, ".manage-agents", "self-update-backup")))
        }
      }
      originalRenameSync(source, target)
      if (targetPath === launcherPath && sourceParts.includes("stage")) {
        assert.match(fs.readFileSync(launcherPath, "utf8"), /release-v1\.1\.0/)
      }
    }) as typeof fs.renameSync

    try {
      const result = await applyEngineUpdate(engineDir, {
        transport,
        target: path.join(tmp, "opencode-target"),
        allowUnsigned: true,
        skipDependencyInstall: true,
      })
      assert.equal(result.applied, true)
    } finally {
      fs.renameSync = originalRenameSync
    }

    assert.ok(launcherRenameCount > 0)
    assert.equal(replacementOrder.at(-1), "manage-agents.mjs")
    assert.match(fs.readFileSync(launcherPath, "utf8"), /release-v1\.1\.0/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("self-update journals recover engine targets and the original release manifest", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-selfup-recovery-")))
  const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../manage-agents.mjs")
  const launcher = await import(pathToFileURL(launcherPath).href)
  const simulateInterruptedUpdate = (engineDir: string, id: string) => {
    scaffoldEngineRoot(engineDir, "v1.0.0", "original")
    writeEngineReleaseManifest(engineDir, {
      refType: "tag",
      refName: "v1.0.0",
      sha: "1".repeat(40),
      builtAt: "2026-11-10T10:00:00.000Z",
    })
    const originalDist = fs.readFileSync(path.join(engineDir, "dist", "index.js"), "utf8")
    const manifestPath = path.join(engineDir, ".manage-agents", "release-manifest.json")
    const originalManifest = fs.readFileSync(manifestPath, "utf8")
    const backupRoot = path.join(engineDir, ".manage-agents", "self-update-backup", id)
    const entriesDir = path.join(backupRoot, "entries")
    fs.mkdirSync(entriesDir, { recursive: true })
    fs.cpSync(path.join(engineDir, "dist"), path.join(entriesDir, "0"), { recursive: true, preserveTimestamps: true })
    fs.copyFileSync(manifestPath, path.join(backupRoot, "release-manifest.json"))
    fs.writeFileSync(path.join(engineDir, ".manage-agents", "self-update-journal.json"), JSON.stringify({
      schemaVersion: 1,
      id,
      entries: [{ idx: 0, rel: "dist", existed: true }],
      manifestExisted: true,
    }))
    fs.rmSync(path.join(engineDir, "dist", "index.js"))
    fs.writeFileSync(manifestPath, "corrupt manifest\n")
    return { originalDist, originalManifest, backupRoot }
  }

  try {
    const engineDir = path.join(tmp, "engine-ts")
    const id = "a".repeat(32)
    const expected = simulateInterruptedUpdate(engineDir, id)
    assert.equal(recoverInterruptedSelfUpdate(engineDir), true)
    assert.equal(fs.readFileSync(path.join(engineDir, "dist", "index.js"), "utf8"), expected.originalDist)
    assert.equal(fs.readFileSync(path.join(engineDir, ".manage-agents", "release-manifest.json"), "utf8"), expected.originalManifest)
    assert.equal(fs.existsSync(path.join(engineDir, ".manage-agents", "self-update-journal.json")), false)
    assert.equal(fs.existsSync(expected.backupRoot), false)

    const launcherEngineDir = path.join(tmp, "engine-launcher")
    const launcherExpected = simulateInterruptedUpdate(launcherEngineDir, "b".repeat(32))
    assert.equal(launcher.recoverEngineDirIfInterrupted(launcherEngineDir), true)
    assert.equal(fs.readFileSync(path.join(launcherEngineDir, "dist", "index.js"), "utf8"), launcherExpected.originalDist)
    assert.equal(fs.readFileSync(path.join(launcherEngineDir, ".manage-agents", "release-manifest.json"), "utf8"), launcherExpected.originalManifest)
    assert.equal(fs.existsSync(path.join(launcherEngineDir, ".manage-agents", "self-update-journal.json")), false)
    assert.equal(fs.existsSync(launcherExpected.backupRoot), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("force permits both downgrade and same-version reinstall", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-selfup-force-")))
  try {
    const engineDir = path.join(tmp, "engine")
    const targetDir = path.join(tmp, "opencode-target")
    scaffoldEngineRoot(engineDir, "v1.1.0", "installed-v1.1")
    writeEngineReleaseManifest(engineDir, {
      refType: "tag",
      refName: "v1.1.0",
      sha: "1".repeat(40),
      builtAt: "2026-11-10T10:00:00.000Z",
    })

    const downgrade = buildReleaseFixture({ baseDir: tmp, tag: "v1.0.0", sha: "2".repeat(40) })
    const downgraded = await applyEngineUpdate(engineDir, {
      transport: downgrade.transport,
      target: targetDir,
      allowUnsigned: true,
      force: true,
      skipDependencyInstall: true,
    })
    assert.equal(downgraded.applied, true)
    assert.equal(downgraded.versionInfo.version, "v1.0.0")

    const sameVersion = buildReleaseFixture({ baseDir: tmp, tag: "v1.0.0", sha: "3".repeat(40) })
    const reinstalled = await applyEngineUpdate(engineDir, {
      transport: sameVersion.transport,
      target: targetDir,
      allowUnsigned: true,
      force: true,
      skipDependencyInstall: true,
    })
    assert.equal(reinstalled.checkResult.updateAvailable, false)
    assert.equal(reinstalled.applied, true)
    assert.match(fs.readFileSync(path.join(engineDir, "dist", "index.js"), "utf8"), /release-v1\.0\.0/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("launcher runtime requirements and symlinked direct entrypoint detection", async () => {
  const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../manage-agents.mjs")
  const launcher = await import(pathToFileURL(launcherPath).href)
  assert.deepEqual(launcher.checkRuntimeEngineVersion({ bunVersion: "1.2.9" }), {
    ok: false,
    message: "manage-agents requires Bun >= 1.3.0 (found 1.2.9). Please upgrade Bun to >= 1.3.0.",
  })
  assert.equal(launcher.checkRuntimeEngineVersion({ bunVersion: "1.3.0" }).ok, true)
  assert.equal(launcher.checkRuntimeEngineVersion({ bunVersion: "1.3.5" }).ok, true)
  assert.equal(launcher.checkRuntimeEngineVersion({ bunVersion: undefined, nodeVersion: "24.0.0" }).ok, false)
  assert.equal(launcher.checkRuntimeEngineVersion({ bunVersion: undefined, nodeVersion: "26.4.0" }).ok, true)

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-selfup-entrypoint-")))
  try {
    const wrapper = path.join(tmp, "manage-agents")
    fs.symlinkSync(launcherPath, wrapper)
    assert.equal(launcher.isDirectEntrypoint(wrapper, pathToFileURL(launcherPath).href), true)
    assert.equal(launcher.isDirectEntrypoint(undefined, pathToFileURL(launcherPath).href), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("CLI entrypoints expose version, self-update, update --self, and release commands", () => {
  const require = createRequire(import.meta.url)
  const tsxLoaderUrl = pathToFileURL(require.resolve("tsx")).href
  const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.tsx")
  const runCli = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-ffi", "--no-warnings=ExperimentalWarning", "--import", tsxLoaderUrl, cliEntry, ...args], {
      encoding: "utf8",
      windowsHide: true,
    })

  const ver = runCli(["--version", "--json"])
  assert.equal(ver.status, 0, ver.stderr)
  const parsedVer = JSON.parse(ver.stdout)
  assert.equal(typeof parsedVer.bundleHash, "string")
  assert.match(parsedVer.bundleHash, /^sha256:[0-9a-f]{64}$/)

  const selfHelp = runCli(["self-update", "--help"])
  assert.equal(selfHelp.status, 0, selfHelp.stderr)
  assert.match(selfHelp.stdout, /manage-agents self-update/)

  const aliasHelp = runCli(["update", "--self", "--help"])
  assert.equal(aliasHelp.status, 0, aliasHelp.stderr)
  assert.match(aliasHelp.stdout, /manage-agents self-update/)

  const relHelp = runCli(["release", "--help"])
  assert.equal(relHelp.status, 0, relHelp.stderr)
  assert.match(relHelp.stdout, /manage-agents release keygen/)
})
