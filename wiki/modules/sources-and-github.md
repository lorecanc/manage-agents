---
title: "Sources & GitHub Integration"
description: "Source registry management, Git cache operations, pack discovery, and GitHub CLI authentication"
category: "modules"
source_files:
  - "src/utils/sources.ts"
  - "src/utils/github.ts"
created: "2026-11-13"
last_updated: "2026-11-17"
---

# Sources & GitHub Integration

## Purpose

The Sources & GitHub Integration module manages where `manage-agents` discovers OpenCode *[packs]* (see [Glossary](../glossary.md)). It maintains the user-level source registry ([`sources.json`](../config/user-and-target-files.md)), manages Git source caches and detached, revision-pinned snapshots in the user cache directory, discovers manifest-backed and [virtual packs](./pack-validation-and-virtual-packs.md) across registered sources, hardens `git` subprocess invocations against [untrusted URLs](../concepts/security-and-trust-model.md) and environment variables, and integrates optionally with the GitHub CLI (`gh`) for shorthand expansion, interactive browser login, repository listing, and transient credential-helper access to private HTTPS repositories.

## Key Files

| File | Role |
|------|------|
| `src/utils/sources.ts` | Source registry schema and persistence, URL/ref validation, managed Git cache operations, revision-pinned snapshots, working-tree clones, and pack discovery. |
| `src/utils/github.ts` | GitHub repository shorthand parser, HTTPS hostname validator, and `gh` CLI wrappers for authentication checks, browser login, and repository listing. |

## Source Registry

Registered pack sources are stored in `$XDG_CONFIG_HOME/manage-agents/sources.json` (defaulting to `~/.config/manage-agents/sources.json` via `engineConfigDir()`).

### Schema & Types

`SourceRegistry` (`schemaVersion: 1`) tracks registered sources, per-pack disambiguation rules, and TUI selection state:

```ts
export type Source =
  | { name: string; kind: "local"; path: string; trusted: boolean }
  | { name: string; kind: "git"; url: string; ref?: string; trusted: boolean }

export interface SourceRegistry {
  schemaVersion: 1
  sources: Source[]
  /** pack name -> source name, used when several sources offer the same pack. */
  prefer: Record<string, string>
  /** Last source selected in the TUI. */
  active?: string
}
```

- **`local` sources** added through `addSource` must point to an existing directory, which is stored through `fs.realpathSync(dir)`; loading a registry checks that its stored path is absolute but does not re-check that the directory still exists. Passing `--ref` for a local directory is rejected.
- **`git` sources** record a clean remote `url` and an optional branch, tag, or commit `ref` validated against `GIT_REF_RE`.
- **`trusted`** controls whether executable pack content from the source requires interactive confirmation (`--yes` in non-interactive CLI flows) during [installation or reconciliation](./target-installer.md).
- **`prefer`** maps a pack name to a preferred source name when multiple sources advertise the same pack.
- **`active`** remembers the currently selected source in the [TUI](../components/workspaces-flows-and-sources.md) and is marked with `*` in [`manage-agents source list`](../api/cli-reference.md).

### Validation, Atomic `0o600` Writes & Registry Operations

- **Load-time validation (`loadSources`)**: Returns an empty `{ schemaVersion: 1, sources: [], prefer: {} }` registry if `sources.json` does not exist. When loading from disk, it validates every entry even if `sources.json` was hand-edited: source names must be unique and match `PACK_NAME_RE` (`/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/`, preventing path traversal out of the cache root), `local` paths must be absolute, `git` refs must match `GIT_REF_RE`, every `prefer` mapping must pair a valid pack name with an existing source name, and `active` (if defined) must name an existing source.
- **Deterministic atomic writes (`saveSources`)**: Sorts `sources` alphabetically by `name`, sorts `prefer` keys alphabetically, drops `active` if it no longer matches a registered source, and writes the formatted JSON via `atomicWriteRestrictedFile` (from [`src/utils/agents.ts`](./agent-editing-and-v2-compat.md)) with default mode `0o600`. `atomicWriteRestrictedFile` rejects symlinks and non-regular target files via `fs.lstatSync`, writes to a random sibling `.tmp` file opened with `"wx"` and `0o600`, applies `fchmodSync` and `renameSync`, and enforces `chmodSync(filePath, 0o600)`.
- **Name derivation & CRUD**:
  - `deriveSourceName(location, registry)` strips `#ref`, `github:`/`gh:` prefixes, trailing slashes, and `.git`, normalizes the final path segment to lowercase alphanumeric/hyphen characters (up to 56 chars, falling back to `"source"`), and appends `-2`, `-3`, etc. on collision.
  - `addSource(registry, name, location, settings, options)` validates the name, expands GitHub shorthands or inline `#ref` fragments, checks URL/directory validity, and appends the `Source` entry.
  - `removeSource(registry, name)` removes the source, deletes any `registry.prefer[pack]` entries pointing to `name`, and reassigns `registry.active` to `registry.sources[0].name` (or deletes `active` when no sources remain). Any previously cloned checkout in `$XDG_CACHE_HOME` is left untouched on disk.
  - `findSource(registry, name)` looks up a source by name or throws `unknown source "<name>"`.
  - **Trust, preference, and active selection**: Callers in the CLI (`runSourceCLI` in `src/index.tsx`) and TUI mutate `findSource(registry, name).trusted`, `registry.prefer[pack]`, and `registry.active` directly on the in-memory `SourceRegistry` before persisting via `saveSources(registry)`.

## Git Checkout Cache, Revision Snapshots & Pack Discovery

### Cached Git Source Checkouts

`engineCacheDir()` resolves `$XDG_CACHE_HOME/manage-agents` (defaulting to `~/.cache/manage-agents`). `sourceRoot(source, env)` maps `local` sources to `source.path` and `git` sources to `$XDG_CACHE_HOME/manage-agents/sources/<name>`.

Git source directories are managed caches rather than filesystem-protected read-only directories: `pullSource` may fetch and update their detached checkout. `cloneSourceToWorkingTree` is the separate operation for creating an editable working copy.

`pullSource(source, env, options)` synchronizes a `git` source checkout (`local` sources return `null`):

1. **Initial clone**: When `<dir>/.git` is absent, runs `git <protocolArgs> clone --quiet --no-checkout -- <url> <dir>`.
2. **Subsequent fetches**: Updates `origin` first with `git remote set-url origin <url>` (handling cases where a source name was removed and re-added with a different URL), then runs `git <protocolArgs> fetch --quiet --force --tags --prune origin`.
3. **Ref resolution (`fetchedRevision`)**: Without network access, tests candidate refs in order—`refs/remotes/origin/<ref>`, `refs/tags/<ref>`, and `<ref>` when `source.ref` is set, or `refs/remotes/origin/HEAD` otherwise—via `git rev-parse --verify --quiet --end-of-options <candidate>^{commit}`.
4. **Detached checkout**: Checks out the resolved commit SHA with `git checkout --quiet --force --detach <commit>` and returns the commit hash.

Two offline helpers inspect cached state without network calls:
- `lastFetchedRevision(source, env)`: Resolves the commit that `source.ref` (or `origin/HEAD`) pointed to as of the last fetch, or `null` if local or never pulled.
- `sourceRevision(source, env)`: Runs `git rev-parse HEAD` in the cached checkout, returning `null` if local, unpulled, or unborn.

### Deterministic Revision Snapshots

During lockfile-driven [`reconcile`](./target-installer.md), the installer requires the exact commit recorded in the [target lockfile](./resolver-and-lock.md) even if the mutable source cache in `sources/<name>` has since been pulled to a newer commit. `revisionSnapshot(source, revision, env)` provides a detached checkout pinned to that commit at `$XDG_CACHE_HOME/manage-agents/revisions/<name>/<revision>`:

1. Validates that `source.kind === "git"` and `revision` matches `/^[0-9a-f]{40,64}$/`.
2. Returns `<dir>` immediately if `<dir>/.git` already exists.
3. Requires the primary cache repository (`sources/<name>/.git`) to have been pulled already; `revisionSnapshot` does not fetch it.
4. Clones locally with shared Git object storage into a process-unique temporary sibling directory (`<dir>.tmp-<pid>-<timestamp>`):
   ```ts
   git(["clone", "--quiet", "--shared", "--no-checkout", "--", repo, temporary])
   git(["checkout", "--quiet", "--force", "--detach", revision], temporary)
   movePathWithRetry(temporary, dir)
   ```
5. On error, cleans up `temporary` via `removePathWithRetry` and instructs the user to run `manage-agents source pull <name>` if the locked commit is missing locally.

For [local authoring and onboarding workflows](./pack-onboarding-and-doctor.md), `cloneSourceToWorkingTree(source, destDir, env, options)` expands `~` via `expandUserPath`, walks every path component with `fs.lstatSync` to reject symlink traversal (permitting standard macOS root symlinks `/var`, `/tmp`, `/etc`), verifies the destination does not exist or is an empty directory, clones the repository, and checks out `source.ref` if configured.

### Pack Discovery & Virtual Pack Fallback

`discoverPacks(source, env)` (and `discoverAllPacks(registry, env)` across all registered sources) scans `sourceRoot(source, env)` for packs:

- Walks directories recursively in lexicographical order up to `DISCOVERY_DEPTH = 4`, skipping `SKIPPED_DIRS` (`new Set([".git", "node_modules", ".opencode"])`).
- Whenever [`opencode-pack.json`](../api/pack-contract-reference.md) (`MANIFEST_FILE`) is present in a directory, `readPackManifest(dir, { sourceKind: source.kind })` validates the manifest and **stops descending** into subdirectories (packs cannot be nested inside other packs). Valid manifests produce a `PackCandidate` with POSIX-normalized `relativeDir`; invalid manifests append formatted error messages to `problems`.
- **Virtual pack fallback**: If traversal finds zero `opencode-pack.json` manifests and zero manifest errors, `discoverPacks` derives a pack slug (`derivePackSlug(source.name)` for `git` sources, or `derivePackSlug(path.basename(path.resolve(root)))` for `local` sources) and invokes [`validateVirtualPack(root, { name: virtualName, sourceKind: source.kind })`](./pack-validation-and-virtual-packs.md). If valid, the repository root is returned as a virtual `PackCandidate` at `relativeDir: "."`.

## Git Hardening & URL Validation

Because pack sources may point to untrusted third-party repositories (see [Security & Trust Model](../concepts/security-and-trust-model.md)), `src/utils/sources.ts` enforces strict validation before invoking `git`:

- **Allowed transport schemes (`GIT_URL_RE`)**: Accepts only `https://...`, `ssh://...`, and SCP-style `user@host:path` URLs where the remote path does not start with `-` (blocking SSH argument injection such as `git@host:-oProxyCommand=...`). Unencrypted `http://`, `git://`, `ftp://`, and unknown URI schemes are rejected.
- **`file:` protocol lockdown**: `addSource`, `pullSource`, and `cloneSourceToWorkingTree` reject `file:` URLs unless `options.allowFileUrls === true`; `loadSources` allows the syntax during registry validation, but default pull/clone operations still reject it. Both Git operations pass `-c protocol.file.allow=never` whenever `allowFileUrls` is not enabled.
- **Credential-in-URL rejection (`hasUrlCredentials`)**: Rejects URLs containing embedded usernames/tokens (`https://user:secret@...`, `https://ghp_token@...`, `ssh://user:pass@...`) or query strings (`https://github.com/org/repo.git?access_token=...`) so secrets are never written to `sources.json` or echoed by `manage-agents source list`.
- **Safe ref syntax (`GIT_REF_RE`)**: `/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/` forbids leading hyphens (preventing flag injection like `--upload-pack=...`) and `..` sequences. Inline `#<ref>` suffixes on `https://` and `ssh://` URLs are extracted and checked for conflicts with explicit `--ref` arguments.
- **Sanitized subprocess environment**: Every `git` call runs with `stdio: ["ignore", "pipe", "pipe"]`, `windowsHide: true`, and `cleanGitEnvironment({ GIT_TERMINAL_PROMPT: "0" })` (defined in [`src/utils/repositoryTransaction.ts`](./agent-editing-and-v2-compat.md)). Setting `GIT_TERMINAL_PROMPT=0` prevents Git from hanging on interactive password prompts, while `cleanGitEnvironment` strips repository-redirecting and configuration-injecting variables from `process.env`:
  - `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`
  - `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`
  - `GIT_NAMESPACE`, `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_OPTIONAL_LOCKS`
  - `GIT_CONFIG` and all `GIT_CONFIG_*` variables (`/^GIT_CONFIG(?:_|$)/i`)

## GitHub Shorthand & `gh` CLI Integration

`src/utils/github.ts` provides shorthand resolution and optional GitHub CLI integration without ever reading or storing raw OAuth/PAT tokens.

### Shorthand Expansion & Host Extraction

`parseGitHubShorthand(raw, options)` parses:
- Explicit prefixes: `github:owner/repo[#ref]` and `gh:owner/repo[#ref]` (case-insensitive, stripping optional `.git`).
- Bare specs: `owner/repo[#ref]`, provided the input does not start with `.`, `/`, `~`, include `\`, or carry a URL/drive prefix, and does **not** match an existing local directory on disk (`checkLocalExists`).

Owner, repository, and optional `#ref` segments are validated against `GITHUB_OWNER_RE`, `GITHUB_REPO_RE` (rejecting `.`, `..`, and leading `-`), and `SHORTHAND_REF_RE`, expanding to `https://github.com/<owner>/<repo>.git`. Full GitHub HTTPS/SSH URLs bypass `parseGitHubShorthand` and are handled directly by `addSource` (including inline `#ref` extraction on `https://` and `ssh://` URLs).

`extractHttpsHost(url)` parses `https://` URLs via `new URL(url)`, returning `null` if the URL has embedded credentials, a non-default port, or a non-HTTPS scheme, and validates the lowercase hostname against `GITHUB_HOST_RE` (`/^(?!-)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/`).

### Authentication, Web Login & Repository Listing

All `gh` subprocesses run under `cleanGitEnvironment`:

- **`inspectGhAuth` / `inspectGhAuthAsync`**: Validates `hostname` against `GITHUB_HOST_RE` and executes `gh auth status --hostname <host> --json hosts` (never passing `--show-token`). It reads the requested `hosts[host]` entry, falling back to the first host entry if that key is absent. An active account with `state === "success"` is preferred, then any successful account; accounts with no successful entry are reported as needing re-authentication. Missing `gh` (`ENOENT`) produces `available: false`; no account is reported as unauthenticated. If the output is not valid JSON but `gh` exits successfully, the parser treats the host as authenticated.
- **`runGhWebLogin`**: Runs `gh auth login --hostname <host> --git-protocol https --web` with `stdio: "inherit"` so the user can complete browser OAuth interactively, then re-verifies status with `inspectGhAuth`.
- **`listGhRepos` / `listGhReposAsync`**: Validates `owner` (`GITHUB_OWNER_RE`) and `hostname` (`GITHUB_HOST_RE`), clamps the numeric `limit` to `1..200` (default `100`), and sets `GH_HOST` for non-`github.com` hosts, then runs:
  ```text
  gh repo list [<owner>] --limit <limit> --no-archived --json nameWithOwner,description,isPrivate,updatedAt,url
  ```
  Each returned `nameWithOwner` is re-validated via `parseGitHubShorthand` before constructing `GhRepoSummary` items. An HTTPS `url` from `gh` is normalized to end in `.git`; otherwise a URL is synthesized using the selected host.

### Transparent Credential Helper Injection

When `pullSource` or `cloneSourceToWorkingTree` operates on an HTTPS URL and `options.useGhAuth !== false`, `ghCredentialArgs(url, env, options)` checks `extractHttpsHost(url)` and `inspectGhAuth(host)`. When authenticated, it returns transient `-c` flags prepended only to that `git` command:

```ts
return [
  "-c",
  `credential.https://${host}.helper=`,
  "-c",
  `credential.https://${host}.helper=!gh auth git-credential`,
]
```

The first `-c` resets any preconfigured credential helpers for `<host>` during that invocation, and the second delegates credential retrieval directly to `gh auth git-credential`, enabling seamless private HTTPS repository access without persisting credentials in `sources.json` or `.git/config`.

## Public API

### `src/utils/sources.ts`

| Export | Kind | Description |
|--------|------|-------------|
| `Source`, `SourceRegistry`, `PackCandidate`, `GitOptions` | Types | Core data structures for sources, `sources.json`, discovered packs, and Git auth/protocol options. |
| `GIT_REF_RE`, `DISCOVERY_DEPTH`, `SKIPPED_DIRS` | Constants | Safe Git ref pattern and pack discovery bounds (`DISCOVERY_DEPTH = 4`). |
| `assertSafeCachePath(cacheRoot, targetPath)` | Function | Reject a cache path outside the cache root or through existing symlinked/non-directory components. |
| `engineConfigDir(env?)`, `engineCacheDir(env?)` | Functions | Resolve `$XDG_CONFIG_HOME/manage-agents` and `$XDG_CACHE_HOME/manage-agents`. |
| `loadSources(env?)`, `saveSources(registry, env?)` | Functions | Read/validate and atomically persist `sources.json` (`0o600`). |
| `deriveSourceName(location, registry)` | Function | Generate a unique valid `PACK_NAME_RE` slug from a path, URL, or shorthand. |
| `addSource(registry, name, location, settings?, options?)` | Function | Validate and register a `local` or `git` source in `registry`. |
| `removeSource(registry, name)`, `findSource(registry, name)` | Functions | Remove (with `prefer`/`active` cleanup) or look up a source by name. |
| `hasUrlCredentials(location)`, `redactUrlCredentials(location)` | Functions | Detect embedded URL credentials/query tokens and redact them for diagnostics. |
| `sourceRoot(source, env?)`, `expandUserPath(rawPath, env?)` | Functions | Resolve a source's filesystem path or expand `~` user paths. |
| `ghCredentialArgs(url, env?, options?)` | Function | Build transient `-c credential.https://<host>.helper=...` flags when `gh` is authenticated. |
| `pullSource(source, env?, options?)` | Function | Clone or fetch a `git` source into the cache and check out its resolved commit detached. |
| `cloneSourceToWorkingTree(source, destDir, env?, options?)` | Function | Clone a `git` source into a symlink-checked writable directory for local authoring. |
| `lastFetchedRevision(source, env?)`, `sourceRevision(source, env?)` | Functions | Inspect the cached ref commit or checked-out `HEAD` commit without network access. |
| `revisionSnapshot(source, revision, env?)` | Function | Create or reuse a `--shared` detached checkout pinned to a specific commit SHA. |
| `discoverPacks(source, env?)`, `discoverAllPacks(registry, env?)` | Functions | Discover manifest-backed and virtual packs across one or all sources. |

### `src/utils/github.ts`

| Export | Kind | Description |
|--------|------|-------------|
| `GhRunResult`, `GhRunner`, `GitHubShorthand`, `GhAuthStatus`, `GhRepoSummary` | Types | Runner abstraction and structured return types for shorthand parsing and `gh` queries. |
| `GITHUB_HOST_RE`, `GITHUB_OWNER_RE`, `GITHUB_REPO_RE`, `defaultGhRunner` | Constants | Input validation regexes and default `spawnSync("gh", ...)` runner. |
| `parseGitHubShorthand(raw, options?)` | Function | Parse `[github:|gh:]owner/repo[#ref]` into `{ owner, repo, url, ref? }` while respecting local directories. |
| `extractHttpsHost(url)` | Function | Validate and extract a lowercase hostname from a credential-free `https://` URL. |
| `inspectGhAuth(hostname?, runner?, env?)`, `inspectGhAuthAsync(hostname?, env?)` | Functions | Query `gh auth status --hostname <host> --json hosts` synchronously or asynchronously. |
| `listGhRepos(options?, runner?, env?)`, `listGhReposAsync(options?, env?)` | Functions | List non-archived repositories via `gh repo list --json ...`. |
| `runGhWebLogin(hostname?, runner?, env?)` | Function | Launch interactive `gh auth login --git-protocol https --web` and verify resulting auth state. |

## Dependencies

```mermaid
graph LR
    Sources["src/utils/sources.ts"] --> GitHub["src/utils/github.ts"]
    Sources --> Packs["src/utils/packs.ts"]
    Sources --> VirtualPacks["src/utils/virtualPacks.ts"]
    Sources --> Agents["src/utils/agents.ts"]
    Sources --> FsWin["src/utils/fsWindows.ts"]
    Sources --> RepoTx["src/utils/repositoryTransaction.ts"]
    GitHub --> RepoTx
    Sources --> GitCLI["git CLI"]
    GitHub --> GhCLI["gh CLI"]
```

- **Internal**:
  - [`src/utils/packs.ts`](./pack-validation-and-virtual-packs.md) (`DISCOVERY_DEPTH`, `SKIPPED_DIRS`, `MANIFEST_FILE`, `PACK_NAME_RE`, `readPackManifest`)
  - `src/utils/virtualPacks.ts` (`derivePackSlug`, `validateVirtualPack`)
  - [`src/utils/agents.ts`](./agent-editing-and-v2-compat.md) (`atomicWriteRestrictedFile`)
  - `src/utils/repositoryTransaction.ts` (`cleanGitEnvironment`)
  - [`src/utils/fsWindows.ts`](./target-installer.md) (`movePathWithRetry`, `removePathWithRetry`)
- **External** (see [Runtime & Tooling Dependencies](../dependencies/runtime-and-tooling-stack.md)):
  - Node.js built-ins: `node:child_process`, `node:fs`, `node:os`, `node:path`
  - External CLIs: `git` (required for `git` sources) and `gh` (optional, for GitHub CLI integration)

## Usage Example

Registering a GitHub shorthand source, persisting `sources.json`, pulling its Git cache, discovering packs, and creating a locked commit snapshot (adapted from `src/index.tsx` and `src/utils/sources.test.ts`):

```ts
import {
  addSource,
  deriveSourceName,
  discoverPacks,
  loadSources,
  pullSource,
  revisionSnapshot,
  saveSources,
} from "./utils/sources.js"

const registry = loadSources()
const spec = "lorecanc/agents#main"
const name = deriveSourceName(spec, registry)

const source = addSource(registry, name, spec, { trusted: true })
if (!registry.active) registry.active = source.name
saveSources(registry)

const commit = pullSource(source)
const { candidates, problems } = discoverPacks(source)

if (commit) {
  const snapshotDir = revisionSnapshot(source, commit)
  // snapshotDir points to $XDG_CACHE_HOME/manage-agents/revisions/<name>/<commit>
}
```

## Related Pages

- [Dependency Resolver & Lockfile](./resolver-and-lock.md) — Consumes discovered `PackCandidate` entries, `prefer` mappings, and Git revision SHAs.
- [Transactional Target Installer](./target-installer.md) — Pulls Git sources during `update` and checks out revision-pinned `revisionSnapshot` directories during `reconcile`.
- [Pack Validation, Catalog & Virtual Packs](./pack-validation-and-virtual-packs.md) — Manifest reading and virtual `0.0.0-virtual` pack synthesis invoked during `discoverPacks`.
- [Pack Onboarding, Doctor & Scaffolding](./pack-onboarding-and-doctor.md) — Uses `cloneSourceToWorkingTree` to turn a Git source into an editable local pack repository.
- [Flows & Data Sources Workspaces](../components/workspaces-flows-and-sources.md) — Interactive TUI workspace for managing sources, GitHub authentication, and repository browsing.
- [Security & Trust Model](../concepts/security-and-trust-model.md) — Threat model for untrusted Git URLs, credential rejection, subprocess hardening, and source `trusted` flags.
- [User Settings, Target State & Environment Variables](../config/user-and-target-files.md) — File layout reference for `sources.json` and `$XDG_CACHE_HOME/manage-agents/`.
