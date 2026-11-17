---
title: "Pack Lifecycle & Target Safety"
description: "How desired state, lockfiles, ownership tracking, conflict detection, adoption backups, and crash journals protect OpenCode targets"
category: "concepts"
source_files:
  - "contract/CONTRACT.md"
  - "src/utils/installer.ts"
  - "src/utils/lock.ts"
  - "src/utils/resolver.ts"
created: "2026-11-13"
last_updated: "2026-11-13"
---

# Pack Lifecycle & Target Safety

`manage-agents` installs OpenCode *[packs]* (see [Glossary](../glossary.md)) directly into a live [OpenCode configuration directory](../config/user-and-target-files.md) (`$XDG_CONFIG_HOME/opencode` by default, typically `~/.config/opencode`) via the [Transactional Target Installer](../modules/target-installer.md) (see [System Architecture](../architecture.md)). Because packs do not run in isolated sandboxes, the engine enforces strict ownership tracking, pre-flight conflict detection, TOCTOU verification, and crash-safe filesystem transactions so pack operations never corrupt or silently overwrite user-authored files and settings.

## Why Target Safety Matters

An OpenCode target directory is a shared tree where multiple actors coexist:

- **Personal user settings** in `opencode.json` (such as `model`, `default_agent`, `providers`, and `permissions`) that packs are forbidden from setting under the [pack contract](../api/pack-contract-reference.md).
- **Hand-written resources** created directly by the user under `agents/`, `commands/`, `skills/`, `plugins/`, or `themes/`, as well as user-configured `mcp.servers` or `lsp` entries.
- **Multiple external packs** from [local directories or git repositories](../modules/sources-and-github.md), which copy their files into the same shared layout so cross-pack relative imports (such as `../../tools/<pack>/x.js`) work natively.
- **Engine-managed runtime assets**, including `instructions/<pack>.md` (rewritten from a pack's `AGENTS.md`) and [`plugins/manage-agents-router/`](../modules/runtime-router-plugin.md).

Without explicit boundaries, installing, updating, or uninstalling a pack could clobber hand-edited prompts, strip JSONC comments without backup, delete files the user created before installing a pack, or leave a half-written tree if the process crashes mid-operation.

Two additional boundary checks protect the target before any file mutation:

1. **Symlinked configuration protection**: `planConfig` inspects `opencode.json` (or `opencode.jsonc`) with `fs.lstatSync`. If the configuration file is a symlink, planning records a conflict rather than replacing the link or writing through it blindly, prompting the user to pass the symlink's destination via `--target` or use a regular file. Similarly, `isSafeRel` rejects any state-recorded path containing `..`, backslashes, NUL bytes, or absolute prefixes.
2. **Executable surface confirmation**: `confirmationsNeeded` in [`src/utils/lock.ts`](../modules/resolver-and-lock.md) compares the incoming `PackLock` against the previous lock. Installing a pack with executable content (plugins, plugin npm/git specs, `tools/**` modules, skill scripts, MCP servers, or external formatter/LSP/MCP commands) from an untrusted source—or updating any pack whose `executableHash` changed—requires explicit confirmation interactively or via `--yes` (see [Security & Trust Model](./security-and-trust-model.md)).

## Three-File State Model

For each target, `manage-agents` stores three JSON [state files](../config/user-and-target-files.md) inside `<target>/.manage-agents/`:

| File | Type (`src/utils/`) | Purpose |
|---|---|---|
| `desired.json` | `DesiredState` (`installer.ts`) | Records the user's explicit root pack requests (`roots: string[]`, formatted as `[source/]name[@range]`). |
| `lock.json` | `PackLock` (`lock.ts`) | Pins the exact resolved dependency graph: `source`, `sourceKind`, `path`, `version`, git `revision`, `manifestHash`, `contentHash`, `executable`, `executableHash`, `trusted`, and `requires` per pack. |
| `installed.json` | `InstalledState` (`installer.ts`) | Tracks every managed target path (`files[rel] -> { hash, owner }`), each pack's rewritten `opencode.json` contribution (`config[pack]`), and dotted config objects created by the engine (`createdSections`). |

```ts
// src/utils/installer.ts
export interface DesiredState {
  desiredVersion: 1
  roots: string[]
}

export interface InstalledState {
  installedVersion: 1
  files: Record<string, { hash: string; owner: string }>
  config: Record<string, Contribution>
  createdSections?: string[]
}
```

Separating user intent (`desired.json`), exact resolution (`lock.json`), and materialized target ownership (`installed.json`) makes every [lifecycle command](../api/cli-reference.md) (and the [Sources & Target workspace](../components/workspaces-flows-and-sources.md)) deterministic and idempotent:

- **`resolve <pack>...`**: Runs [`resolvePacks`](../modules/resolver-and-lock.md) (`src/utils/resolver.ts`) to reach a constraint fixpoint across `requires` ranges, checks for dependency cycles (`findCycle`) and unresolved cross-pack references (`providesTarget`), orders packs topologically (`orderByRequires`: dependencies first, ties alphabetical), and diffs against the existing `lock.json` without writing anything. The resolver never guesses between ambiguous sources or versions on its own.
- **`install <pack>...`** (`installChange`): Appends or updates the requested root specs in `desired.json` while passing `pinsFrom(lock, name => !requested.has(name))` to the resolver so already-locked packs keep their exact source and version.
- **`uninstall <pack>...`** (`uninstallChange`): Verifies each named pack is a root in `desired.json` (refusing to directly uninstall a transitive dependency still required by an installed root), removes the root from `desired.json`, and calls `pruneLock` to drop unreachable packs without re-resolving remaining dependencies.
- **`update [<pack>...]`** (`updateChange`): Pulls the [git sources](../modules/sources-and-github.md) of the selected packs (or all locked packs when none are named) and re-resolves `desired.roots`. A git source moves as an atomic unit: every pack originating from a pulled git source is unpinned and re-evaluated at the new commit together, while unselected sources stay pinned.
- **`reconcile`** (`reconcileChange`): Rebuilds the target strictly from the existing `desired.json` and `lock.json`, applying current [user model-routing and frontmatter override settings](../modules/routing-and-user-settings.md) (see [Conditional Routing & Archetypes](./conditional-routing-and-archetypes.md)). In `loadLockedPacks`, git packs are read from a snapshot of their locked `revision` (`revisionSnapshot`), and every pack's `manifestHash`, `contentHash`, `executableHash`, and `opencode.json(c)` SHA-256 digest are verified against `lock.json` before planning proceeds.
- **`status`** (`targetStatus`): Performs a read-only check comparing the filesystem and git sources against all three state files. It reports pending crash journals, checked-out or fetched git commits that diverge from `lock.json`, missing or locally edited managed files, conflicts, and pending `reconcile` changes (such as updated global overrides). When `planReconcile` finds zero writes, zero deletes, unchanged config, and identical state files, `changeTarget` returns `status: "unchanged"` without touching disk.

## File & Config Ownership Lifecycle

### Pre-Flight Conflict Detection

`planReconcile` in [`src/utils/installer.ts`](../modules/target-installer.md) computes the entire target transition in memory before `applyPlan` writes a single byte. A conflict aborts the operation whenever:

- **Two packs collide**: Two packs in the lock declare the same resource ID (agent, command, skill, plugin, theme, or MCP server), write to the same NFC-normalized case-folded relative path (`fold(rel)`), or set the same `opencode.json` key to non-equal values.
- **Unmanaged user content is in the way**: A target file or `opencode.json` entry already exists, is not listed in `installed.json`, differs from the pack's content, and `--adopt` was not passed.
- **Managed content was modified locally**: A file in `installed.json` has a current on-disk SHA-256 (`currentHash`) that differs from `owned.hash`, or a managed object entry in `opencode.json` was edited by the user (`changedLocally`), and `--adopt` was not passed.
- **Non-regular filesystem entries block a path**: A directory, socket, or FIFO sits where a pack file needs to be written (`current === "not-a-file"`), or `opencode.json(c)` is a symlink or unparseable JSONC.

As a migration convenience, files and plugins listed in `<target>/.resource-export-manifest.json` (produced by the legacy `manage-agents export` command) are recognized via `readLegacyResources` and replaced without requiring `--adopt`, while still saving a backup when their content differs.

### Adoption Backups and Restore

Passing `--adopt` instructs `planReconcile` and `planConfig` to take ownership of conflicting unmanaged or locally modified files and config keys, recording them in `plan.adopted`:

1. Before mutating the target, `applyPlan` creates `<target>/.manage-agents/backups/<id>/`, copying adopted files (preserving user symlinks verbatim via `fs.readlinkSync` / `fs.symlinkSync` without following them) under `files/` and writing `backup.json` with `{ id, created, configFile, files, config }`.
2. If the target uses `opencode.jsonc` or contains comments or trailing commas (`!isPlainJson(text)`), `planConfig` warns that formatting comments cannot be preserved in serialized JSON and automatically adds `configFile` to `plan.adopted.files` so the original commented file is backed up.
3. Running [`manage-agents restore <backup-id>`](../api/cli-reference.md) invokes `restoreBackup`, which acquires `install.lock`, copies backed-up files and symlinks back into place, restores adopted array or object entries in `opencode.json`, and deletes those paths and config contributions from `installed.json` so the restored items return to unmanaged user ownership.

### Surgical `opencode.json` Merging and `createdSections`

Packs may contribute only to [approved sections of `opencode.json`](../api/pack-contract-reference.md): array sections (`plugins`, `skills`, `instructions`) and object sections (`mcp.servers`, `agents`, `commands`, `formatter`, `lsp`, `experimental`). A dependent pack may also explicitly register a required pack's plugin with `options`, which supersedes the provider pack's implicit `./plugins/<name>` registration (`implicitPlugins` vs. `explicitPlugins`).

During `planConfig`, the engine reconstructs `opencode.json` without disturbing user keys:

1. **Extract unmanaged base**: It clones the current parsed config into `unmanaged` and strips every entry matching `previous.config` (`isDeepStrictEqual`). If a previously managed object key still exists on disk with a different value, it stays in `unmanaged` and is flagged in `changedLocally`.
2. **Claim and merge**: Each pack's `Contribution` (plus `:engine` when [`plugins/manage-agents-router`](../modules/runtime-router-plugin.md) is needed) claims its array items and object keys. Managed entries are appended to `unmanaged` arrays or set on `unmanaged` object paths.
3. **Track and prune `createdSections`**: Whenever the engine materializes a missing dotted object path (for example creating `mcp` and `mcp.servers`), it records each prefix in `createdSections`. When removing a pack leaves a section empty (`emptiedSections`), `planConfig` walks upward from leaf to root (`mcp.servers` -> `mcp`) and deletes empty objects **only** if they appear in `createdSections`. Empty sections originally written by the user are never deleted.

### Identical Unmanaged Content vs. Locally Modified Released Files

`manage-agents` distinguishes between user files that happen to match a pack and managed files that the user customized after installation:

```ts
// src/utils/installer.ts — identical unmanaged files stay the user's
if (current === write.hash) {
  if (owned || legacy.has(write.rel) || options.adopt) files[write.rel] = { hash: write.hash, owner }
  continue
}
```

- **Identical pre-existing content stays unmanaged**: If a target file already has `current === write.hash` and was not previously in `installed.json` (and `--adopt` is not set), `planReconcile` skips writing it and omits it from `installed.files`. Likewise, `claim` in `planConfig` returns `"kept"` when an existing unmanaged config entry is `isDeepStrictEqual` to the pack's value, omitting it from `installed.config`. Uninstalling the pack later leaves both the file and the config entry untouched.
- **Clean vs. modified removal (`released`)**: When an `uninstall` or `update` drops a previously managed path (`previous.files`), `planReconcile` checks its on-disk hash:
  - If `current === owned.hash`, the file is scheduled in `plan.deletes`, removed during `applyPlan`, and any empty parent directories inside `<target>` are cleaned up via `removeEmptyParents`.
  - If `current !== owned.hash`, the user edited the file locally. Rather than deleting user work or blocking `uninstall`, `planReconcile` adds the path to `plan.released`, emits a warning (`"<rel> was changed locally and no pack provides it any more: left in place, no longer managed"`), leaves the file on disk, and removes it from `installed.json`.

## Crash Recovery & Concurrency Invariants

All mutating operations (`install`, `uninstall`, `update`, `reconcile`, `restore`) share `withTargetLock` and `applyPlan` in [`src/utils/installer.ts`](../modules/target-installer.md) to guarantee process exclusion, TOCTOU detection, and atomic rollback.

### Process Exclusion (`install.lock`)

`withTargetLock` creates `<target>/.manage-agents/install.lock` with `flag: "wx"` containing `{ pid, host, command, started }`:

- If `install.lock` already exists, the engine parses the holder metadata. If the holder runs on another host or `pidAlive(holder.pid)` returns `true` (`process.kill(pid, 0)` succeeds or returns `EPERM`), `withTargetLock` aborts immediately with a descriptive error. If the lock file cannot be parsed yet and its `mtimeMs` is newer than `STALE_LOCK_GRACE_MS` (10 seconds), it assumes another process is still writing it and aborts.
- If the holder PID on the same host is dead, `withTargetLock` reclaims the stale lock without race conditions: it atomically renames `install.lock` to a unique sibling `.stale-<pid>-<rand>` file, verifies its contents still match the dead holder read moments earlier (restoring the link via `fs.linkSync` and aborting if a third process acquired a fresh lock in between), deletes the `.stale` file, and retries `wx` creation.

### Same-Filesystem Staging and Expected-Hash TOCTOU Checks

`applyPlan` never writes directly over live target files from pack sources:

1. **Staging (`txn/<id>/new/`)**: Every planned file write, `opencode.json`, and the updated `.manage-agents/{installed,lock,desired}.json` files are written or copied into `<target>/.manage-agents/txn/<id>/new/`. Because `.manage-agents/txn/` lives inside `<target>`, staged files reside on the same filesystem as their final destinations, guaranteeing atomic `rename` semantics. For source-backed files, `stage` hashes the copied staged file and aborts if the source mutated mid-copy (`hash !== expectedHash`).
2. **Pre-journal TOCTOU verification (`plan.expected`)**: During `planReconcile`, the engine records `plan.expected[rel]`—the exact SHA-256 digest (`null` if absent, `symlink:<target>` if a symlink) of every target file and `opencode.json` that the plan will touch. Because an interactive confirmation prompt may sit open between planning and applying, `applyPlan` re-hashes every path in `plan.expected` after staging. If any path changed while waiting, `applyPlan` deletes `txn/<id>/` and aborts before writing `journal.json`.
3. **Swap-time TOCTOU verification**: As existing files are moved out of the live tree into `txn/<id>/prev/`, `applyPlan` checks `currentHash(previous) !== plan.expected[op.rel]`, and before moving a newly created file into place, verifies no file appeared at `full` in the meantime. Any discrepancy triggers an immediate `rollbackInterrupted(target)`.

### Crash Journal (`journal.json`) and Automatic Rollback

Before the first live path in `<target>` is moved or unlinked, `applyPlan` persists [`<target>/.manage-agents/journal.json`](../config/user-and-target-files.md) using `atomicWriteRestrictedFile` (which writes to an exclusive sibling `.journal.json.<pid>.<rand>.tmp` file with restricted permissions per the [Security & Trust Model](./security-and-trust-model.md), flushes, and renames it atomically into place):

```json
{
  "id": "2026-11-13T10-15-30-123Z-a1b2c3d4",
  "ops": [
    { "rel": "agents/reviewer.md", "existed": false, "hash": "9f86d081..." },
    { "rel": "opencode.json", "existed": true, "hash": "4b227777..." }
  ]
}
```

During the commit loop:

1. For each operation where `op.existed` is `true`, the live target file is moved (`movePathWithRetry`) to `<target>/.manage-agents/txn/<id>/prev/<rel>`, preserving its exact pre-image.
2. For each operation with a staged replacement (`op.staged`), the staged file is moved from `txn/<id>/new/<rel>` to `<target>/<rel>`. Planned deletions have `staged: null`, so moving the original into `prev/` completes the removal while retaining its pre-image until commit finishes.
3. Once every operation succeeds, `applyPlan` deletes `journal.json`, removes `txn/<id>/`, and prunes empty parent directories of deleted files.

If an exception, `SIGKILL`, or power loss interrupts step 1 or 2, `journal.json` remains on disk. Both `applyPlan`'s `catch` block and the start of the next mutating `changeTarget` or `restoreBackup` call invoke `rollbackInterrupted(target)`:

- It validates `journal.json` (refusing to auto-delete if damaged so the user can inspect `txn/<id>/`).
- It iterates `journal.ops` **in reverse order**: if a pre-image exists in `txn/<id>/prev/<rel>`, it unlinks any partial destination and moves the `prev` file back; otherwise, if `!op.existed` and the file on disk still matches `op.hash`, it unlinks the newly staged file.
- Finally, it removes `journal.json` and `txn/<id>/`, returning the target to its exact pre-transaction state (`result.recovered = true`).

## Lifecycle Diagram

```mermaid
graph TD
    Lock["1. Acquire install.lock & Rollback Pending journal.json"] --> Resolve["2. Compute DesiredState & PackLock (resolvePacks / pruneLock)"]
    Resolve --> Plan["3. Plan Reconcile & Snapshot Expected Hashes (planReconcile)"]
    Plan --> Gate{"4. Conflicts or Untrusted Executable Surface?"}
    Gate -->|"Conflict (no --adopt) or Declined"| Abort["Abort Without Touching Target"]
    Gate -->|"Clean & Confirmed"| Stage["5. Stage Files & State in .manage-agents/txn/id/new/"]
    Stage --> Touched{"6. TOCTOU Check Against plan.expected"}
    Touched -->|"Mismatch or Mid-Swap Error"| Rollback["Clean Staged Txn / Replay journal.json in Reverse"]
    Touched -->|"Verified"| Commit["7. Save Backup, Write journal.json & Swap prev/ and new/"]
    Commit --> Done["8. Remove journal.json, Clean txn/ & Release install.lock"]
```

Every mutating [CLI command](../api/cli-reference.md) passes through [`changeTarget`](../modules/target-installer.md), ensuring no target file is altered until [resolution](../modules/resolver-and-lock.md), conflict checks, [user confirmations](./security-and-trust-model.md), same-filesystem staging, TOCTOU checks, adoption backups, and crash journaling have all succeeded.

---

## Related Pages

- [Transactional Target Installer](../modules/target-installer.md)
- [Dependency Resolver & Lockfile](../modules/resolver-and-lock.md)
- [Security & Trust Model](./security-and-trust-model.md)
- [Conditional Routing & Archetypes](./conditional-routing-and-archetypes.md)
- [OpenCode Pack Contract 1.1 Reference](../api/pack-contract-reference.md)
- [CLI Command Reference](../api/cli-reference.md)
- [User Settings, Target State & Environment Variables](../config/user-and-target-files.md)
- [Flows & Data Sources Workspaces](../components/workspaces-flows-and-sources.md)
