---
title: "Launcher, Build & Self-Update"
description: "Node/Bun FFI bootstrap, auto-build pipeline, engine versioning, release verification, and journaled self-update"
category: "modules"
source_files:
  - "manage-agents.mjs"
  - "src/build.mjs"
  - "src/utils/engineVersion.ts"
  - "src/utils/selfUpdate.ts"
  - "src/utils/fsWindows.ts"
  - "package.json"
  - ".github/workflows/ci.yml"
created: "2026-11-13"
last_updated: "2026-11-17"
---

# Launcher, Build & Self-Update

## Purpose

This module group owns the execution lifecycle of the [`manage-agents` engine](../architecture.md) itself—independent of any external *[pack]* (see [Glossary](../glossary.md)) catalog or managed OpenCode target. It bootstraps a supported Node.js or Bun runtime with Foreign Function Interface (FFI) support required by [OpenTUI](../dependencies/runtime-and-tooling-stack.md), automatically installs dependencies and rebuilds the TypeScript/JSX bundle when running from a source checkout, computes deterministic cryptographic hashes of the engine surface, signs and verifies GitHub release metadata with [Ed25519](../concepts/security-and-trust-model.md), and applies releases through a staged, journaled update with rollback and Windows file-lock resilience. The update is recoverable, but replacing the engine's multiple files is not one atomic whole-install swap.

## Key Files

| File | Role |
|------|------|
| `manage-agents.mjs` | Executable CLI launcher (`bin`); enforces runtime prerequisites, re-execs Node with FFI flags, auto-installs missing dependencies, triggers stale bundle rebuilds, and imports `dist/index.js`. |
| `src/build.mjs` | Programmatic `esbuild` bundler that compiles `src/index.tsx` into the ESM bundle `dist/index.js`. |
| `src/utils/engineVersion.ts` | Resolves the engine root, computes deterministic `sha256` bundle and git worktree hashes, reads/writes `.manage-agents/release-manifest.json`, and determines the active version channel. |
| `src/utils/selfUpdate.ts` | Implements Ed25519 key generation, release asset signing, trust policy resolution, GitHub Release transport, update checks, and staged, journaled self-updates with rollback. |
| `src/utils/fsWindows.ts` | Provides retry-backed filesystem removal and cross-device/lock-tolerant path moves for Windows indexer and antivirus locks. |
| `package.json` | Defines package version `1.0.0`, the CLI `bin`, Node/Bun engine floors, build scripts, runtime dependencies, and the published npm file set. |
| `.github/workflows/ci.yml` | Runs the Node/Bun CI matrix and, for eligible `v*` tags, builds, manifests, signs, and publishes GitHub release assets. |

## Bootstrap Sequence (`manage-agents.mjs`)

`manage-agents.mjs` is the package `bin` entrypoint (`#!/usr/bin/env node`). Before loading any compiled application code, it executes a six-stage bootstrap sequence:

### 1. Windows UTF-8 Codepage Pin

On `win32`, the launcher runs `chcp 65001` via `spawnSync("chcp", ["65001"], { shell: true, stdio: "ignore", windowsHide: true })` inside a `try/catch` block. While OpenTUI `>= 0.5.0` writes directly via `WriteConsoleW`, pinning codepage `65001` protects older or fallback standard-stream paths without failing startup if `chcp` is unavailable.

### 2. Runtime Verification and FFI Self-Re-Exec

OpenTUI relies on native FFI bindings. `checkRuntimeEngineVersion()` enforces **[Node.js `>= 26.4.0`](../getting-started.md)** or **Bun `>= 1.3.0`**, matching `engines` in `package.json`. Unsupported or malformed runtime versions exit immediately with status `1`. Bun is checked directly and is not re-executed with Node flags.

On supported Node.js versions, `manage-agents.mjs` inspects `process.execArgv` for two flags:
- `--experimental-ffi`
- `--no-warnings` or `--no-warnings=ExperimentalWarning`

If either flag is missing, the launcher synchronously spawns a child Node process (`process.execPath`) with the missing flags prepended to `process.argv.slice(1)` and `stdio: "inherit"`, forwarding signals as `128 + signalNumber` and exiting with the child's status code:

```js
const hasExperimentalFfi = process.execArgv.includes("--experimental-ffi")
const hasExperimentalWarningSuppression = process.execArgv.some(
  (arg) => arg === "--no-warnings" || arg === "--no-warnings=ExperimentalWarning",
)
if (!hasExperimentalFfi || !hasExperimentalWarningSuppression) {
  const execArgs = [...process.execArgv]
  if (!hasExperimentalFfi) execArgs.push("--experimental-ffi")
  if (!hasExperimentalWarningSuppression) execArgs.push("--no-warnings=ExperimentalWarning")
  const result = spawnSync(process.execPath, [...execArgs, ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true })
  // ... signal & exit propagation
}
```

### 3. Interrupted Self-Update Recovery

After the runtime re-exec, the launcher calls `recoverEngineDirIfInterrupted(scriptDir)` before checking dependencies, rebuilding, or importing the bundle. If `.manage-agents/self-update-journal.json` exists, it validates the journal and engine-relative paths, restores backed-up targets and the release manifest, verifies restored contents, then removes the journal and backup. A failed recovery aborts startup and retains the backup for diagnosis or another recovery attempt.

### 4. Semver Dependency Verification and Auto-Install

Before importing external packages, `dependenciesMatch(managerDir, includeDevDependencies)` reads `package.json` using lightweight built-in helpers (`parseCoreSemver()`, `cmpCoreSemver()`, and `satisfiesSimpleSpec()` supporting exact, `^`, `~`, `>=`, and `*` ranges) and checks every required `node_modules/<pkg>/package.json`. `devDependencies` (such as `esbuild`) are checked only when `src/` exists and a rebuild is needed (`hasSources && needsBuild`).

When [`MANAGE_AGENTS_SKIP_AUTO_INSTALL`](../config/user-and-target-files.md) `!== "1"`, `(hasSources || existsSync(package-lock.json))` holds, and `dependenciesMatch()` returns `false`, the launcher automatically installs dependencies with lifecycle scripts disabled:
- **Bun with `bun.lock`**: `bun install --frozen-lockfile --ignore-scripts`
- **Bun without `bun.lock`**: `bun install --ignore-scripts`
- **Node with `package-lock.json`**: `npm ci --ignore-scripts --no-audit --no-fund`
- **Node without `package-lock.json`**: `npm install --ignore-scripts --no-audit --no-fund`

### 5. Source Mtime Comparison and Auto-Build

`newestSourceMtime(directory)` recursively scans `src/` and compares the newest file `mtimeMs` (along with `package.json`'s `mtimeMs`) against `dist/index.js`:

```js
const hasSources = existsSync(srcDir)
const newestSource = hasSources
  ? Math.max(newestSourceMtime(srcDir), existsSync(packageJsonPath) ? statSync(packageJsonPath).mtimeMs : 0)
  : 0
const needsBuild = hasSources ? !existsSync(distPath) || statSync(distPath).mtimeMs < newestSource : !existsSync(distPath)
```

Published npm packages distribute `dist/` without `src/` (per `package.json` `"files"`), so `needsBuild` evaluates to `false` in production installs. In git checkouts where `needsBuild` is `true`, the launcher runs `bun run build` or `npm run build` (executing `node src/build.mjs`).

### 6. Bundle Execution

Once `dist/index.js` is up to date, `manage-agents.mjs` transfers control via dynamic ESM import:

```js
await import(pathToFileURL(distPath).href)
```

## Bundling Pipeline (`src/build.mjs`)

`src/build.mjs` invokes `esbuild` from the resolved repository root (`managerRoot`) so builds succeed regardless of the caller's current working directory:

```js
const managerRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
await build({
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["@opentui/core", "yaml"],
  absWorkingDir: managerRoot,
  logLevel: "info",
  entryPoints: ["src/index.tsx"],
  outfile: "dist/index.js",
})
```

`esbuild` automatically reads `tsconfig.json` from `absWorkingDir`, inheriting `"target": "ES2022"` and `"jsx": "react-jsx"` while bundling React, `react-reconciler`, `@opentui/react`, `semver`, and internal TypeScript modules into a single ESM file.

Two runtime dependencies are intentionally kept in `external`:
- **[`@opentui/core`](../dependencies/runtime-and-tooling-stack.md)**: Loads platform-specific optional native FFI packages (`@opentui/core-darwin-arm64`, `@opentui/core-linux-x64`, `@opentui/core-win32-x64`, etc.) relative to `node_modules` at runtime and maintains singleton terminal renderer state shared across modules.
- **`yaml`**: Ships its Node entrypoint (`./dist/index.js`) as CommonJS (`"type": "commonjs"`). Keeping `yaml` external lets Node's native ESM-to-CJS loader resolve it cleanly rather than emitting broken dynamic `require()` shims inside an ESM bundle.

## Package and CI Release Flow

`package.json` currently declares package version `1.0.0`, exposes `manage-agents.mjs` as the `manage-agents` executable, and requires Node `>= 26.4.0` or Bun `>= 1.3.0`. Its npm `files` list includes the launcher and `dist/` but not `src/`, so a published package runs the shipped bundle; checkout builds use `npm run build` (`node src/build.mjs`) or `bun run build`.

The `test` job in `.github/workflows/ci.yml` runs on Ubuntu, macOS, and Windows. It installs with `npm ci --ignore-scripts`, runs `npm run validate` (typecheck/tests, build, and minimal-pack validation), checks CLI help/version, then installs Bun and checks Bun typecheck/build/help. A `release` job runs only after that matrix passes and only for a pushed `v*` tag. It verifies the tag commit is an ancestor of `origin/main`, builds the bundle, stages a `git archive` plus `dist/`, and writes a release manifest with the tag and commit SHA. It touches `dist/index.js` before archiving so the launcher does not rebuild over newer source mtimes. The archive is named `manage-agents-<tag>.tar.gz`; the job runs `release sign` using the `RELEASE_SIGNING_PRIVATE_KEY` GitHub secret, then publishes the archive and `release-metadata.json` with `gh release create --verify-tag --generate-notes`. It adds `release-metadata.json.sig` only when the signing command produced that file.

## Engine Version & Bundle Hashing (`src/utils/engineVersion.ts`)

### Path Isolation and Root Discovery

`resolveEngineRoot(overrideRoot?)` walks up to 6 parent directories from `import.meta.url` to locate the directory containing both `manage-agents.mjs` and `package.json`, resolving outer `npm link` symlinks via `fs.realpathSync()`. All subsequent reads and writes inside the engine root pass through `assertSafeEnginePath(engineRoot, target)`, which rejects paths outside `engineRoot`, symlinked engine roots, and any symlink or non-directory intermediate path component.

### Deterministic Bundle Hashing

`computeEngineBundleHash(overrideRoot?)` calculates a deterministic `sha256:<64-hex>` digest across the engine's published runtime and contract surface:
- Root files: `package.json`, `package-lock.json`, `bun.lock`, `manage-agents.mjs`, `README.md`, `GUIDA.md`, `LICENSE`, `.gitignore`, and `dist/index.js`.
- Directories: `assets/`, `contract/`, `runtime/` (excluding `*.test.{c,m}{j,t}s`), and `src/` when present (excluding `*.test.{c,m}{j,t}sx?`).
- Exclusions: `EXCLUDED_DIRS` (`node_modules`, `.git`, `dist`, `build`, `.manage-agents`, `.agent-manager`, `.opencode`, `artifacts`, `backups`, `coverage`, `.cache`), symlinks, `*.log`, `.DS_Store`, and `Thumbs.db`.

Files are sorted lexicographically by normalized POSIX relative path and fed into SHA-256 with length-prefixed framing (`<pathByteLen>:<posixPath>:<contentByteLen>:<rawBytes>`) to prevent boundary-collision ambiguities.

### Release Manifest (`.manage-agents/release-manifest.json`)

CI builds stamp `.manage-agents/release-manifest.json` (`ENGINE_MANIFEST_RELATIVE_PATH`) via `writeEngineReleaseManifest()` ([`manage-agents version --write-manifest`](../api/cli-reference.md)). Validated by `isEngineReleaseManifest()`, the schema (`schemaVersion: 1`) records:
- `version`, `packageVersion`, `tag` (`string | null`), `commit` (40-hex SHA), `shortCommit` (7-char prefix), `dirty`, `channel` (`"release"` or `"ci-snapshot"`), `bundleHash`, and ISO-8601 `builtAt`.
- Optional git overlay stamps (`appliedOverGitHead` and `appliedWorktreeStateHash`) populated by `stampAppliedEngineManifest()` when `applyEngineUpdate()` installs a release over a local git checkout. `computeEngineGitWorktreeHash()` hashes `git status --porcelain=v1 -z --untracked-files=normal` (ignoring `.manage-agents/`) together with file SHA-256 contents so subsequent modifications to tracked or untracked files are immediately detected.

### Version Resolution Channels

`resolveEngineVersion(overrideRoot?)` inspects the current `bundleHash`, `.manage-agents/release-manifest.json`, `.git` state, and `package.json`, returning an `EngineVersionInfo` object classified into one of five `EngineVersionChannel` values:

| Channel | Condition | Resulting `version` / `dirty` |
|---------|-----------|-------------------------------|
| `release` | Matching release manifest and bundle hash in a non-git install, a clean checkout whose `HEAD` equals `manifest.commit`, or a checkout whose current `HEAD` and worktree hash match the manifest's applied-release stamps. | `<tag>` (e.g. `v1.2.0`), `dirty: false` |
| `ci-snapshot` | Non-git install with a matching valid `ci-snapshot` manifest. | `sha-<shortCommit>-dirty`, `dirty: true` |
| `git-tag` | No qualifying release manifest; clean `.git` checkout whose `HEAD` has an exact tag (`git describe --tags --exact-match HEAD`). | `<exactGitTag>`, `dirty: false` |
| `git` | `.git` checkout not recognized as a matching release or exact clean tag. | `sha-<shortCommit>` or `sha-<shortCommit>-dirty` |
| `package` | Fallback when no usable git version or matching release manifest applies. | `v<packageVersion>` (currently `v1.0.0`), `dirty: false` |

In a non-git installation, a valid manifest whose `bundleHash` no longer matches disk still yields `sha-<shortCommit>-dirty`; the returned channel retains the manifest's channel. A manifest is therefore not treated as proof that the installed bundle is unchanged.

## Release Signing & Self-Update (`src/utils/selfUpdate.ts`)

### Ed25519 Key Management and Release Signing

Cryptographic authenticity is governed by [`release-signing.json`](../config/translation-and-release-config.md) (`RELEASE_SIGNING_CONFIG_FILENAME`) at the engine root, plus optional environment overrides:
- **`generateReleaseSigningKeypair()`** ([`manage-agents release keygen`](../api/cli-reference.md)): Generates an Ed25519 keypair via `crypto.generateKeyPairSync("ed25519")`, derives a deterministic key identifier `ed25519-<12-hex>` from the first 12 hex characters of the SPKI DER SHA-256 (`computePublicKeyId()`), atomically updates `release-signing.json` (`0o644`), and optionally writes the PKCS#8 private key PEM with `0o600` permissions.
- **`signReleaseAssets()`** (`manage-agents release sign`): Verifies `manage-agents-<tag>.tar.gz` (`releaseArchiveName(tag)`), computes its byte size and `sha256:<hex>` digest, and writes `release-metadata.json` (`RELEASE_METADATA_ASSET_NAME`). When an Ed25519 private key is provided (`options.privateKeyPem` or `RELEASE_SIGNING_PRIVATE_KEY`), it verifies the key matches a configured trusted public key when keys exist, signs the exact `release-metadata.json` bytes using `crypto.sign(null, metadataBytes, privateKey)`, and writes base64 `release-metadata.json.sig` (`RELEASE_SIGNATURE_ASSET_NAME`).
- **`resolveReleaseTrustPolicy()` & `verifyEngineReleaseMetadata()`**: Combine public keys in `release-signing.json` with optional [`MANAGE_AGENTS_RELEASE_PUBLIC_KEY`](../config/user-and-target-files.md) (PEM or base64 SPKI DER; key-ID collisions are rejected). Any configured public key makes a signature mandatory. With no keys, signatures are still required by default; SHA-256-only mode can be enabled through `allowUnsigned` / `MANAGE_AGENTS_ALLOW_UNSIGNED=1` (the API also honors `requireSignature: false` when no keys are configured). In Ed25519 mode, the verifier checks a base64-encoded 64-byte signature over the exact downloaded metadata bytes against the trusted key(s). In SHA-256 mode, it validates repository/tag metadata and the metadata's digest field but does not establish signer authenticity; application separately checks the actual archive against that digest.

The CI release job passes `secrets.RELEASE_SIGNING_PRIVATE_KEY` to `release sign`; under the default policy, signing without that key fails unless unsigned mode has explicitly been enabled. The workflow does not set unsigned mode, so an ordinary release run needs the secret. If a trusted key is configured, the signing private key must match it. The workflow uploads the signature asset only when it was produced.

### GitHub Release Transport

`createDefaultReleaseTransport()` validates repository slugs strictly against `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$` (`validReleaseRepository()`) and fetches `releases/latest` and `releases/assets/<id>` using a two-tier strategy:
1. **GitHub CLI (`gh api`)**: Runs inside [`cleanGitEnvironment(env)`](./agent-editing-and-v2-compat.md) with a 120s timeout and 128 MiB max buffer, retrying up to 3 times (`GH_MAX_ATTEMPTS`) on transient network errors (`isTransientTransportError()`). Retries inject `GODEBUG=http2client=0` via `withHttp1Godebug()` to work around Go HTTP/2 connection resets.
2. **Direct HTTPS Fallback**: If `gh` is unavailable or fails, issues HTTPS requests directly to `https://api.github.com/repos/<repository>/<resource>` using `GITHUB_TOKEN`, `GH_TOKEN`, or a cached token from [`gh auth token`](./sources-and-github.md).

### Update Discovery (`checkForEngineUpdate`)

`checkForEngineUpdate()` downloads `release-metadata.json` and the signature asset when present or required, applies the resolved trust policy, binds metadata to the selected repository and GitHub release tag, ensures the release contains one archive asset matching `metadata.archive.name`, and compares versions with `compareReleaseTags()` (via `semver`). It returns `EngineUpdateCheckResult` containing `updateAvailable`, `downgrade`, `localGitDirty` (`hasUncommittedEngineChanges()`), and `targetReconcileNeeded` (true when the [target lockfile](./resolver-and-lock.md) tracks at least one installed pack). The archive itself is downloaded and checked during application, not during discovery.

`applyEngineUpdate()` performs this check itself unless the caller supplies `options.checkResult`. That override is reused without re-verifying the release metadata signature, so callers must supply a result already checked under the intended trust policy. The archive's actual size and SHA-256 are still checked during application.

### Journaled Self-Update & Rollback (`applyEngineUpdate`)

`applyEngineUpdate()` (`manage-agents self-update` or `manage-agents update --self`) executes a multi-stage transactional update:

1. **Dirty Checkout & Downgrade Guards**: Calls `hasUncommittedEngineChanges(engineRoot)` and refuses to overwrite uncommitted engine changes unless `options.force` (`--force`) is set. Similarly refuses version downgrades (`checkResult.downgrade`) without `options.force`.
2. **Archive Digest Verification**: Downloads the archive and compares its byte length and SHA-256 digest with `release-metadata.json` before extraction. Authenticity comes from verifying the signed metadata under an Ed25519 trust policy; the metadata binds the archive name, size, and digest.
3. **Isolated Staging & Symlink Audit**: Creates a `0o700` temporary directory (`manage-agents-self-update-*`), extracts the tarball via `tar -xzf`, and walks the extracted tree with [`assertNoSymlinkTree()`](../concepts/security-and-trust-model.md), rejecting symlinks, non-regular entries, or paths outside the extraction root.
4. **Manifest & Bundle Hash Verification**: Resolves the extracted package root (`resolveExtractedEngineDir()`), verifies all required targets (`manage-agents.mjs`, `package.json`, `dist`, `assets`, `contract`, `runtime`), and runs `validateStagedEngineManifest()`. The release manifest must match the metadata tag and commit, use the `"release"` channel, be clean, and match `computeEngineBundleHash(stagedRoot)`.
5. **Staged Dependency Installation**: Compares SHA-256 digests of `package.json`, `package-lock.json`, and `bun.lock` between the installed and staged engine. If any differ or installed `node_modules` is absent, dependencies are installed inside staging with lifecycle scripts disabled (`npm ci`/`npm install` or `bun install`); the live installation is not touched yet.
6. **Durable Backup and Journal**: Copies existing required and optional engine targets (plus `node_modules` when the staged install is being applied) under `.manage-agents/self-update-backup/<id>`. It also copies staged replacements to this same-filesystem area, fsyncs the backup tree, and atomically writes a mode-`0o600` `.manage-agents/self-update-journal.json` before replacing live targets. The release manifest is backed up separately.
7. **Per-Target Replacement and Verification**: Revalidates engine paths and rejects live target symlinks. Staged regular files are moved into place; directory targets are removed before their staged replacement is moved. This is a multi-target transaction, not one atomic whole-install swap. The updater touches `dist/index.js` to keep its mtime newer than extracted source, stamps the applied release manifest, and requires `resolveEngineVersion(engineRoot)` to report the staged tag as a clean `release` before deleting the journal and backups.
8. **Rollback and Reconciliation**: If replacement or post-swap verification fails while the journal is present, `recoverInterruptedSelfUpdate()` restores and verifies targets from the backup; if recovery fails, the backup remains. An interrupted update is recovered on the next launcher startup. Reconciliation follows the committed engine swap, so a later reconciliation error does not roll the engine back. The updater reconciles the managed OpenCode [router plugin](./runtime-router-plugin.md) when `options.reconcile !== false` and installed packs make reconciliation necessary, using [`changeTarget(..., "reconcile", ...)`](./target-installer.md).

## Windows File-Lock Resilience (`src/utils/fsWindows.ts`)

Windows file indexers and antivirus scanners transiently lock files during rapid rename or delete operations. `src/utils/fsWindows.ts` centralizes synchronous retry and fallback primitives used across manifest writes, staging cleanup, and engine swaps:

- **`TRANSIENT_WINDOWS_LOCK_CODES`**: `Set(["EPERM", "EACCES", "EBUSY"])`, checked via `isTransientWindowsLockError(error)`.
- **`removePathWithRetry(target, rmImpl?, sleep?)`**: Calls `fs.rmSync` with `WINDOWS_SAFE_RM_OPTIONS` (`{ recursive: true, force: true, maxRetries: 5, retryDelay: 50 }`), plus outer backoff retries across `MOVE_RETRY_DELAYS_MS` (`[10, 25, 50, 100]` ms) using `Atomics.wait` (falling back to a bounded spin loop if `SharedArrayBuffer` is unavailable).
- **`movePathWithRetry(source, target, ops?)`**:
  1. Retries `fs.renameSync(source, target)` across `MOVE_RETRY_DELAYS_MS` when `isTransientWindowsLockError()` matches.
  2. Breaks immediately to the copy-and-swap fallback on `EXDEV` (cross-filesystem/cross-drive move) or when rename retries are exhausted.
  3. Copies `source` to `<target>.stage-<pid>-<hex>` first so an existing `target` is never deleted before the copy succeeds, backs up any existing `target` to `<target>.bak-<pid>-<hex>`, removes `target`, moves/copies staged content into `target` (restoring from `.bak` if replacement fails), and cleans up `.bak` and `source`.

## Public API

| Symbol | Source File | Description |
|--------|-------------|-------------|
| `checkRuntimeEngineVersion({ bunVersion?, nodeVersion? })` | `manage-agents.mjs` | Validates the active Bun or Node.js runtime against the engine minimums. |
| `recoverEngineDirIfInterrupted(engineDir)` | `manage-agents.mjs` | Restores an interrupted self-update before dependency checks or bundle loading. |
| `resolveEngineRoot(overrideRoot?)` | `src/utils/engineVersion.ts` | Locates the real filesystem root of the running `manage-agents` engine. |
| `assertSafeEnginePath(engineRoot, target)` | `src/utils/engineVersion.ts` | Asserts `target` stays within `engineRoot` and traverses no symlink components. |
| `computeEngineBundleHash(overrideRoot?)` | `src/utils/engineVersion.ts` | Computes deterministic `sha256:<hex>` over the engine's published runtime and contract files. |
| `writeEngineReleaseManifest(overrideRoot, input)` | `src/utils/engineVersion.ts` | Atomically writes `.manage-agents/release-manifest.json` for a tag or CI commit. |
| `readEngineReleaseManifest(overrideRoot?)` | `src/utils/engineVersion.ts` | Reads and validates `.manage-agents/release-manifest.json`, returning `null` if absent or invalid. |
| `stampAppliedEngineManifest(overrideRoot, manifest)` | `src/utils/engineVersion.ts` | Records `appliedOverGitHead` and `appliedWorktreeStateHash` after applying a release over git. |
| `resolveEngineVersion(overrideRoot?)` | `src/utils/engineVersion.ts` | Resolves `EngineVersionInfo` (`release`, `ci-snapshot`, `git-tag`, `git`, or `package`). |
| `generateReleaseSigningKeypair(overrideEngineRoot?, options?)` | `src/utils/selfUpdate.ts` | Generates an Ed25519 keypair and updates `release-signing.json`. |
| `signReleaseAssets(overrideEngineRoot, options)` | `src/utils/selfUpdate.ts` | Produces `release-metadata.json` and optional Ed25519 `release-metadata.json.sig`. |
| `resolveReleaseTrustPolicy(overrideEngineRoot?, options?)` | `src/utils/selfUpdate.ts` | Loads repository and Ed25519 public-key policy from `release-signing.json` and environment variables. |
| `verifyEngineReleaseMetadata(rawBytes, rawSig, policy, tag?)` | `src/utils/selfUpdate.ts` | Validates metadata and either verifies a required Ed25519 signature or returns SHA-256-only mode under explicit unsigned policy. |
| `checkForEngineUpdate(overrideEngineRoot?, options?)` | `src/utils/selfUpdate.ts` | Queries GitHub Releases, applies the metadata trust policy, and reports update/downgrade/dirty status. |
| `applyEngineUpdate(overrideEngineRoot?, options?)` | `src/utils/selfUpdate.ts` | Obtains or accepts a checked update result, digest-checks and stages the archive, applies the journaled multi-target update, recovers on failure, and reconciles target state. |
| `recoverInterruptedSelfUpdate(overrideEngineRoot?)` | `src/utils/selfUpdate.ts` | Restores and verifies backed-up engine targets when an update journal remains. |
| `movePathWithRetry(source, target, ops?)` | `src/utils/fsWindows.ts` | Moves paths with Windows lock retries and staged cross-device (`EXDEV`) fallback. |
| `removePathWithRetry(target, rmImpl?, sleep?)` | `src/utils/fsWindows.ts` | Removes files or trees with transient Windows lock retries. |

## Dependencies

```mermaid
graph LR
    Launcher["manage-agents.mjs"] --> Build["src/build.mjs (esbuild)"]
    Launcher --> Dist["dist/index.js"]
    Build --> Dist
    SelfUpdate["src/utils/selfUpdate.ts"] --> EngineVer["src/utils/engineVersion.ts"]
    SelfUpdate --> FsWin["src/utils/fsWindows.ts"]
    SelfUpdate --> Installer["src/utils/installer.ts"]
    SelfUpdate --> GitHub["GitHub Releases (gh / HTTPS)"]
    EngineVer --> FsWin
    EngineVer --> RepoTx["src/utils/repositoryTransaction.ts"]
```

- **Internal**: [`src/utils/installer.ts`](./target-installer.md) (`changeTarget`, `reconcileChange`), [`src/utils/lock.ts`](./resolver-and-lock.md) (`defaultTarget`, `readLock`), [`src/utils/pathValidation.ts`](./pack-validation-and-virtual-packs.md) (`realpathThroughExistingAncestor`), [`src/utils/repositoryTransaction.ts`](./agent-editing-and-v2-compat.md) (`cleanGitEnvironment`), [`src/utils/sources.ts`](./sources-and-github.md) (`loadSources`), and `src/utils/terminalText.ts` (`terminalSafeText`).
- **External**: [`esbuild`](../dependencies/runtime-and-tooling-stack.md) (dev/source-checkout bundler), `semver` (release tag comparison), Node built-in `node:crypto` (SHA-256 and Ed25519 signing/verification), external `gh` CLI / GitHub REST API, and `tar` (release archive extraction).

## Usage Examples

### CLI Release Signing and Self-Update

From `src/index.tsx`, release maintainers generate signing keys, stamp manifests, sign release tarballs, and users check or apply updates:

```bash
# Generate Ed25519 keypair (writes public key to release-signing.json and private key to .release-key.pem)
manage-agents release keygen --out .release-key.pem

# Stamp .manage-agents/release-manifest.json inside the built package root
manage-agents version --write-manifest --ref-type tag --ref-name v1.2.0 --sha 0123456789abcdef0123456789abcdef01234567

# Generate release-metadata.json and Ed25519 release-metadata.json.sig
manage-agents release sign --tag v1.2.0 --sha 0123456789abcdef0123456789abcdef01234567 --assets-dir ./release-assets

# Check for updates or apply the latest verified release non-interactively
manage-agents self-update --check
manage-agents self-update --yes
```

### Programmatic Version Resolution and Update Check

```ts
import { resolveEngineVersion } from "./utils/engineVersion.js"
import { checkForEngineUpdate, applyEngineUpdate } from "./utils/selfUpdate.js"

const current = resolveEngineVersion()
// e.g. { version: "v1.0.0", channel: "release", bundleHash: "sha256:...", dirty: false, ... }

const checkResult = await checkForEngineUpdate(current.engineRoot)
if (checkResult.updateAvailable && !checkResult.localGitDirty) {
  await applyEngineUpdate(current.engineRoot, { checkResult, reconcile: true })
}
```

## Related Pages

- [System Architecture](../architecture.md) — Bootstrap layer placement and end-to-end engine lifecycle
- [Getting Started](../getting-started.md) — Runtime prerequisites, auto-build behavior, and `self-update` usage
- [Bridge Translation & Release Config Reference](../config/translation-and-release-config.md) — Configuration schema for `release-signing.json` and `release-metadata.json`
- [Security & Trust Model](../concepts/security-and-trust-model.md) — Ed25519 signature verification, symlink rejection, and bundle integrity checks
- [Transactional Target Installer](./target-installer.md) — Target router reconciliation triggered after engine updates
- [Runtime & Tooling Dependencies](../dependencies/runtime-and-tooling-stack.md) — Details on `@opentui/core` FFI requirements, `esbuild`, and `semver`
