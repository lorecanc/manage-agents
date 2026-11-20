---
title: "User Settings, Target State & Environment Variables"
description: "Schema and file location reference for XDG user configs, Git source cache, target .manage-agents state files, and environment variables"
category: "config"
source_files:
  - "src/utils/sources.ts"
  - "src/utils/userSettings.ts"
  - "src/utils/uiConfig.ts"
  - "src/utils/lock.ts"
  - "src/utils/installer.ts"
  - "src/utils/fsWindows.ts"
  - "manage-agents.mjs"
  - "runtime/plugins/manage-agents-router/index.ts"
created: "2026-11-13"
last_updated: "2026-11-18"
---

# User Settings, Target State & Environment Variables

`manage-agents` separates its persistent filesystem footprint into three distinct scopes so that *[pack]* (see [Glossary](../glossary.md)) repositories remain catalog-agnostic and read-only, user preferences survive pack updates, and OpenCode target directories can be [reconciled transactionally](../concepts/pack-lifecycle-and-target-safety.md):

| Scope | Default Directory | Overridden By | Primary Owner Modules |
|---|---|---|---|
| **User Configuration** | `~/.config/manage-agents/` | `$XDG_CONFIG_HOME` (`$AGENT_MANAGER_UI_CONFIG` for `ui.json`) | `src/utils/sources.ts`, `src/utils/userSettings.ts`, `src/utils/uiConfig.ts`, `src/utils/sourceCustomization.ts` |
| **Source & Bridge Cache** | `~/.cache/manage-agents/` | `$XDG_CACHE_HOME` | `src/utils/sources.ts`, `src/utils/sourceCustomization.ts` |
| **OpenCode Target State** | `~/.config/opencode/.manage-agents/` | `--target <dir>` or `$XDG_CONFIG_HOME` | `src/utils/lock.ts`, `src/utils/installer.ts` |

Persistent JSON files use atomic replacement (`atomicWriteRestrictedFile`, the UI config's temporary-file/rename protocol, or staged target transactions); ephemeral locks use exclusive creation. Target roots and intermediate managed paths are checked for symlinks; `.manage-agents` state paths also reject symlink leaves, while user file leaves can be backed up as symlinks without following them when replaced under `--adopt` (see [Transactional Target Installer](../modules/target-installer.md)).

---

## 1. XDG User Configuration Directory

Resolved by `engineConfigDir(env)` in `src/utils/sources.ts` as:

```text
${XDG_CONFIG_HOME:-~/.config}/manage-agents/
├── sources.json
├── routing.json
├── overrides.json
├── .settings.lock
├── ui.json
├── ui.lock
└── translations/
    └── <source-name>/
        └── translation.json
```

### `sources.json` — Registered Pack Sources

Managed by `loadSources` and `saveSources` (`src/utils/sources.ts`; see [Sources & GitHub Integration](../modules/sources-and-github.md)). Written with mode `0o600` (`atomicWriteRestrictedFile` default) with `sources` and `prefer` sorted lexicographically by key.

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "name": "decent-agents",
      "kind": "git",
      "url": "https://github.com/lorecanc/agents.git",
      "ref": "main",
      "trusted": true
    },
    {
      "name": "local-dev",
      "kind": "local",
      "path": "/Users/dev/opencode-packs",
      "trusted": true
    }
  ],
  "prefer": {
    "pipeline": "local-dev"
  },
  "active": "decent-agents"
}
```

#### Schema & Validation Rules (`SourceRegistry`)

| Field | Type | Required | Constraints & Semantics |
|---|---|---|---|
| `schemaVersion` | `1` | Yes | Must equal `1`. |
| `sources` | `Source[]` | Yes | Unique `name` entries matching `PACK_NAME_RE` (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). |
| `sources[].kind` | `"local" \| "git"` | Yes | Discriminates local filesystem roots vs. remote Git repositories. |
| `sources[].path` | `string` | When `kind === "local"` | Canonicalized absolute path (`fs.realpathSync` at registration time). |
| `sources[].url` | `string` | When `kind === "git"` | `https://`, `ssh://`, or `user@host:path` Git URL. URLs containing embedded credentials (user-info on HTTPS, non-`git` user-info or a password on `ssh://`, or passwords in scp-style URLs) are rejected; query strings (`?...`) are rejected on `https://` and `ssh://` URLs to prevent secret leakage. GitHub shorthand (`[github:]owner/repo[#ref]`) is normalized to `https://github.com/<owner>/<repo>.git`. |
| `sources[].ref` | `string` | Optional (`git` only) | Branch, tag, or commit ref matching `^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$`. When omitted, `pullSource` resolves `refs/remotes/origin/HEAD`. |
| `sources[].trusted` | `boolean` | Yes | Defaults to `false` unless `--trust` or `source trust <name>` is used. Packs from untrusted sources carrying executable surfaces (`plugins`, `mcp.servers`, command overrides) require interactive confirmation or `--yes` during install/update (see [Security & Trust Model](../concepts/security-and-trust-model.md)). |
| `prefer` | `Record<string, string>` | Yes | Maps `<pack-name>` to `<source-name>` when multiple registered sources offer the same pack. Every value must reference an existing entry in `sources`. |
| `active` | `string` | Optional | Last source selected in the TUI. Must match an existing source `name`; pruned or reassigned when that source is removed. |

---

### `routing.json` — Scoped Model Routing & Conditional Flows

Managed by `loadRoutingSettings` and `saveRoutingSettings` (`src/utils/userSettings.ts`; see [Archetypes, Conditional Flows & User Settings](../modules/routing-and-user-settings.md) and [Conditional Routing & Archetypes](../concepts/conditional-routing-and-archetypes.md)). Written with mode `0o644`; empty nested objects and empty arrays are pruned automatically on save (`saveScoped`). `loadScoped` accepts `version: 1` or `2` on disk and normalizes saved output to `version: 1`.

Settings are split into two scopes:
- `default`: Global user defaults (`manage-agents models ... --global`), applied to every OpenCode target.
- `targets.<realpath>`: Per-target rules keyed by the resolved absolute path of the OpenCode target directory (`realpathThroughExistingAncestor(path.resolve(target))`). Target entries layer on top of `default`.

```json
{
  "version": 1,
  "default": {
    "pipeline": {
      "$callers": ["pipeline", "orchestrator"],
      "$reference": "pipeline",
      "anthropic": {
        "pipeline-explorer": "anthropic/claude-haiku-4-5",
        "pipeline-executor": "inherit"
      },
      "$rules": [
        {
          "callers": ["pipeline"],
          "triggers": ["openai/gpt-5.4", "github-copilot"],
          "then": {
            "models": {
              "pipeline-planner": "openai/gpt-5.4#high",
              "pipeline-tester": "inherit"
            },
            "tools": {
              "bash": "ask",
              "webfetch": "allow"
            },
            "permissions": {
              "edit": "allow"
            },
            "delegations": {
              "pipeline-fast_lane": "deny"
            }
          }
        }
      ]
    }
  },
  "targets": {
    "/Users/dev/.config/opencode": {
      "pipeline": {
        "anthropic": {
          "pipeline-executor": "anthropic/claude-sonnet-4-5"
        }
      }
    }
  }
}
```

#### Schema & Validation Rules (`RoutingSettings` / `PackFlowEntry`)

Within `default.<pack>` and `targets["<abs-path>"].<pack>`:

| Key | Type | Constraints & Semantics |
|---|---|---|
| `$callers` | `string[]` (optional) | Non-empty, duplicate-free list of caller agent IDs evaluated in `OR`. Overrides `manifest.archetype.callers` and enables routing even for packs without an `archetype` block in `opencode-pack.json` (see [OpenCode Pack Contract 1.1 Reference](../api/pack-contract-reference.md)). Filtered at reconcile time to agents present in the pack whose `mode !== "subagent"`. |
| `$reference` | `string` (optional) | Primary caller ID used by the TUI as the reference baseline. Must be included in `$callers` when both are set. |
| `$rules` | `ConditionalRule[]` (optional) | Ordered array of `IF / OR` policy rules validated by `validateConditionalRule` (`src/utils/values.ts`). Each rule requires `triggers: string[]` (`"*"`, `<provider>`, or `<provider>/<model>`), optional rule-specific `callers: string[]`, and a `then` object declaring at least one of: `models` (`Record<subagentId, "inherit" \| "provider/model[#variant]">`), `tools` (`Record<key, "allow" \| "ask" \| "deny">`), `permissions` (`Record<action, "allow" \| "ask" \| "deny">`), or `delegations` (`Record<subagentId \| "*", "allow" \| "deny">`). |
| `<trigger>` | `Record<string, string>` | Any non-reserved key (cannot start with `$`) matching `"*"`, `<provider>`, or `<provider>/<model>`. Maps subagent IDs to `"inherit"` or `"provider/model[#variant]"`. |

---

### `overrides.json` — Scoped Frontmatter & Config Overrides

Managed by `loadOverrideSettings` and `saveOverrideSettings` (`src/utils/userSettings.ts`). Written with mode `0o644` using the same `{ version: 1, default, targets }` scoped envelope as `routing.json`. During `reconcile`, `effectiveOverrides` merges `default.<pack>` and `targets["<abs-path>"].<pack>` field by field, rewriting both installed `agents/*.md` / `commands/*.md` YAML frontmatter (via [Agent Editing, V2 Compatibility & Git Transactions](../modules/agent-editing-and-v2-compat.md), leaving the Markdown body untouched byte-for-byte) and corresponding `agents` / `commands` object entries in `<target>/opencode.json`.

The `config` kind patches the object sections a pack **contributes** to `opencode.json` — `mcp.servers`, `lsp`, `formatter`, `experimental` — without touching the pack or its lock: `patchedConfigSections()` deep-merges each patched entry (nested objects merge, arrays and scalars replace, `null` removes a field; `patchedConfigSections` throws when a patched `mcp.servers` entry stops satisfying the minimal server schema), a key of `null` makes the pack contribute no such entry, and a patch on a key the pack does not have creates the entry. Because the override acts on the contribution, an entry patched to match what the user already has in `opencode.json` is claimed `"kept"` by the installer: no conflict, no `--adopt`, and the entry stays the user's — it is never updated or removed by the pack again. The same patches apply to bridge workspaces (`prepareBridgeWorkspace` layers the `default` scope plus the default OpenCode target's scope, i.e. exactly what `override config-set` writes without `--global`, so a re-exported Claude Code / Codex bridge shows the patched MCP servers).

```json
{
  "version": 1,
  "default": {
    "pipeline": {
      "agents": {
        "pipeline-explorer": {
          "model": null,
          "steps": 25
        },
        "pipeline-security_auditor": {
          "model": "anthropic/claude-opus-4-6#max",
          "temperature": 0.1
        }
      },
      "commands": {
        "review": {
          "agent": "pipeline",
          "subagent": true
        }
      },
      "config": {
        "mcp.servers": {
          "cupertino": { "command": ["cupertino-mcp", "standalone"] },
          "docs": { "disabled": true },
          "old-server": null
        }
      }
    }
  },
  "targets": {}
}
```

Edited through `manage-agents override config-set <pack>/<section>/<key> <field>=<value>...` (dotted field names such as `environment.FOO=x` nest; value is YAML, `null` removes the field), `override config-unset <pack>/<section>/<key> [<field>...]`, and `override config-remove <pack>/<section>/<key>` (the pack no longer contributes the entry). The TUI pack detail (conditional flows modal) lists the pack's MCP servers with an `[ON]/[OFF]` toggle that writes `{ "disabled": true }` / `{ "disabled": null }`.

#### Allowed Override Fields & `null` Unpin Sentinel

- **Allowed `agents.<id>` fields (`AGENT_FIELDS`)**: `description`, `mode`, `model`, `permissions`, `hidden`, `color`, `steps`, `disabled`, `request`, `temperature`, `top_p`.
- **Allowed `commands.<id>` fields (`COMMAND_FIELDS`)**: `description`, `agent`, `model`, `subagent`.
- **`model` validation**: Must be `"provider/model[#variant]"` or `null`.
- **`config` sections (`CONFIG_SECTIONS`)**: `mcp.servers`, `lsp`, `formatter`, `experimental`. For `mcp.servers`, well-known fields (`type`, `command`, `url`, `disabled`, `enabled`) are shape-checked (`type` must be `local`/`remote`, `command` a non-empty string or list of strings); keys and string values must be control-character free.
- **`null` deletion / unpin sentinel**: Setting any field to `null` removes that key from the installed frontmatter (`patchFrontmatter`) and target `opencode.json` (`packContribution`). Running `manage-agents models unpin <pack>/<agent>` writes `{ "model": null }`, stripping even a model hardcoded in the pack's own Markdown file so the subagent follows dynamic routing instead of remaining pinned. In `config` patches the same sentinel removes the field from the contributed entry (a nested deletion that empties a plain object removes the object too), and `null` **at the key** removes the entry from the contribution entirely.
- **Divergence is deliberate**: overriden/kept entries are the user's. The pack will never update or remove them again — overrides exist to diverge consciously, not to keep managing those entries.

---

### `.settings.lock` — User Settings Mutation Lock

Created by `withSettingsLock` (`src/utils/sourceCustomization.ts`) at `<engineConfigDir>/.settings.lock` when the TUI or source customization helpers batch-update `routing.json` or `overrides.json`.

- Opened exclusively (`wx`, mode `0o600`) containing `<pid>\n`.
- If `.settings.lock` already exists, `withSettingsLock` parses the PID and probes `process.kill(ownerPid, 0)`; if the PID is invalid or `ESRCH` indicates a dead process, the stale lock is unlinked and acquisition retries once before throwing `Another manage-agents process is updating settings`.

---

### `ui.json` & `ui.lock` — TUI Layout & Motion Preferences

Managed by `loadUiConfig` and `saveUiConfig` (`src/utils/uiConfig.ts`). Stores interactive terminal split-pane proportions and motion settings for the [TUI Shell, Catalog Tree & Inspector](../components/tui-shell-and-catalog.md).

```json
{
  "version": 1,
  "listShare": 0.6666666666666666,
  "reducedMotion": true
}
```

| Field | Type | Default | Constraints & Semantics |
|---|---|---|---|
| `version` | `1` | `1` | Must equal `1`. |
| `listShare` | `number` | `2 / 3` (`0.6667`) | Finite number in `[0.60, 0.75]` controlling the horizontal width ratio of the primary list pane in the TUI. |
| `reducedMotion` | `boolean` (optional) | Omitted (`false`) | Persisted only when `true`; disables OpenTUI timeline animations and spinners. |

#### File Integrity & Concurrency Controls

- **Bounded descriptor reads**: `readConfigBytes` rejects files larger than `64 KiB` (`65536` bytes), opens with `O_RDONLY | O_NOFOLLOW` where supported, compares device/inode identity between `lstatSync` and `fstatSync` where available, and returns a SHA-256 `revision` digest (or `"missing"` when absent). Invalid or unreadable files fall back to `DEFAULT_UI_CONFIG` with a non-fatal warning.
- **Exclusive write lock (`ui.lock`)**: `saveUiConfig` ensures `<engineConfigDir>` exists (mode `0o700`) and is not a symlink, creates `ui.lock` with `O_WRONLY | O_CREAT | O_EXCL` (`0o600`), writes a 32-byte random token, `fsync`s it, verifies `expectedRevision` for optimistic concurrency, writes `.ui.json.tmp-<pid>-<timestamp>-<rand>`, `fsync`s the file and best-effort `fsync`s the directory, atomically renames into `ui.json`, and removes `ui.lock` only after verifying inode/token ownership.

---

### `translations/<source>/translation.json` — Read-Only Source Bridge Configs

Managed by `sourceTranslationConfigLocation` (`src/utils/sourceCustomization.ts`) and `loadTranslationConfig` / `saveTranslationConfig` (`src/utils/translationConfig.ts`).

When bridging a registered Git source to [Claude Code or Codex](../modules/bridges.md) from the TUI, `manage-agents` stores the `TranslationConfig` (`version: 2`, documented in [Bridge Translation & Release Config Reference](./translation-and-release-config.md)) under `<engineConfigDir>/translations/<source-name>/translation.json` instead of mutating the read-only Git checkout. Reads resolve in order:
1. `<engineConfigDir>/translations/<source-name>/translation.json`
2. `<workspaceRoot>/.agent-manager/translation.json` (legacy repository default, if present)
3. Built-in `DEFAULT_TRANSLATION_CONFIG` (`version: 2`, with `planning`, `execution`, and `light` model tiers).

*(For writable local workspaces and catalogs, bridge configuration lives inside the workspace at `<workspaceRoot>/bridges/translation-config.json`, migrating `version: 1` files to `version: 2` automatically.)*

---

## 2. XDG Cache Directory

Resolved by `engineCacheDir(env)` in `src/utils/sources.ts` as:

```text
${XDG_CACHE_HOME:-~/.cache}/manage-agents/
├── sources/
│   └── <source-name>/          # Detached Git checkout at latest pulled ref
├── revisions/
│   └── <source-name>/
│       └── <commit-sha>/       # Immutable commit-pinned snapshot for reconcile
└── bridges/
    └── <source-name>/
        ├── claude-code/
        │   └── <plugin-name>/  # Generated Claude Code plugin from Git source
        └── codex/
            └── <plugin-name>/  # Generated Codex translation layer from Git source
```

### `sources/<name>/` — Detached Git Source Checkouts

Created and updated by `pullSource` (`src/utils/sources.ts`; see [Sources & GitHub Integration](../modules/sources-and-github.md)) for sources with `kind: "git"`:
- Initialized via `git clone --quiet --no-checkout -- <url> <dir>` with `-c protocol.file.allow=never` (and `-c credential.https://<host>.helper=!gh auth git-credential` when GitHub CLI is authenticated for that HTTPS host).
- Subsequent pulls update `origin` (`git remote set-url origin <url>`), run `git fetch --quiet --force --tags --prune origin`, resolve `refs/remotes/origin/<ref>`, `refs/tags/<ref>`, `<ref>`, or `refs/remotes/origin/HEAD`, and check out the resolved commit in detached HEAD mode (`git checkout --quiet --force --detach <commit>`).
- Running `manage-agents source remove <name>` removes the entry from `sources.json` while leaving `sources/<name>/` intact in the cache directory.

### `revisions/<name>/<commit>/` — Commit-Pinned Snapshots

Created on demand by `revisionSnapshot` (`src/utils/sources.ts`) and consumed by `loadLockedPacks` (`src/utils/installer.ts`):
- Validated against `/^[0-9a-f]{40,64}$/`.
- Cloned locally from `sources/<name>/` using `git clone --quiet --shared --no-checkout` into `<dir>.tmp-<pid>-<timestamp>`, checked out with `git checkout --quiet --force --detach <commit>`, and moved into `revisions/<name>/<commit>/` with `movePathWithRetry` (`src/utils/fsWindows.ts`).
- Guarantees that `manage-agents reconcile` and `override`/`models` re-renders always materialize the exact commit SHA recorded in `<target>/.manage-agents/lock.json` (see [Dependency Resolver & Lockfile](../modules/resolver-and-lock.md)), even if `sources/<name>/` has already been pulled to newer commits.

### `bridges/<source>/<claude-code|codex>/<plugin>/` — Cached Bridge Artifacts

Resolved by `sourceBridgeOutputDir` (`src/utils/sourceCustomization.ts`). Holds generated Claude Code plugins (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, agents, skills, commands) or Codex project plugins (`.codex-plugin/plugin.json`, `.codex/`, `AGENTS.md`, `README.md`) when [translating packs across harnesses](../concepts/cross-harness-translation.md) directly from a cached Git source.

---

## 3. OpenCode Target Directory & `.manage-agents/` State

Resolved by `defaultTarget(env)` (`src/utils/lock.ts`, backed by `getExportDestination` in `src/utils/agents.ts`) as `${XDG_CONFIG_HOME:-~/.config}/opencode`, or any custom directory passed via `--target <dir>`.

```text
<target>/                                      # Default: ~/.config/opencode/
├── opencode.json                              # (or opencode.jsonc) Merged OpenCode config
├── .resource-export-manifest.json             # Optional legacy pre-pack export manifest (read-only)
├── instructions/
│   └── <pack>.md                              # Synthesized from <pack>/AGENTS.md
├── plugins/
│   └── manage-agents-router/                  # Installed when any pack uses routing/flows
│       ├── index.ts
│       ├── router.js
│       └── routing.json
└── .manage-agents/                            # Engine target state directory
    ├── desired.json
    ├── lock.json
    ├── installed.json
    ├── install.lock                           # Present only while a target mutation runs
    ├── journal.json                           # Present only during swap phase / crash recovery
    ├── txn/
    │   └── <id>/                              # Ephemeral staging (new/) and displaced files (prev/)
    └── backups/
        └── <id>/                              # Created when --adopt replaces unmanaged/edited content
            ├── backup.json
            └── files/...
```

### Target State Files (`<target>/.manage-agents/`)

#### `desired.json` (`DesiredState`)

Read by `readDesired` and staged by `applyPlan` (`src/utils/installer.ts`, mode `0o644`). Records sorted top-level pack requests explicitly installed by the user (excluding transitive dependencies):

```json
{
  "desiredVersion": 1,
  "roots": [
    "decent-agents/pipeline@^1.2.0",
    "flow"
  ]
}
```

#### `lock.json` (`PackLock`)

Built by `buildLock` and validated by `readLock` (`src/utils/lock.ts`, mode `0o644`; see [Dependency Resolver & Lockfile](../modules/resolver-and-lock.md)). Pins the complete resolved dependency graph, Git revisions, SHA-256 integrity hashes, and executable surface descriptions:

```json
{
  "lockVersion": 1,
  "contract": "1.1",
  "roots": [
    "decent-agents/pipeline@^1.2.0"
  ],
  "packs": {
    "pipeline": {
      "source": "decent-agents",
      "sourceKind": "git",
      "path": "packs/pipeline",
      "version": "1.2.0",
      "revision": "0123456789abcdef0123456789abcdef01234567",
      "manifestHash": "a3f1...64-hex-chars",
      "contentHash": "b9c2...64-hex-chars",
      "trusted": true,
      "requires": {},
      "executable": [
        "plugin ./plugins/pipeline-tools"
      ],
      "executableHash": "e4d8...64-hex-chars"
    }
  }
}
```

- Every hash (`manifestHash`, `contentHash`, `executableHash`) is a 64-character lowercase SHA-256 hex digest verified by `loadLockedPacks` before any file is staged. [Virtual packs](../modules/pack-validation-and-virtual-packs.md) (loose `.md` directories without `opencode-pack.json`) lock at `version: "0.0.0-virtual"` with `virtualManifestHash`.
- `confirmationsNeeded` compares the incoming `PackLock` against the previous `lock.json` and requires user confirmation whenever an untrusted pack introduces executable items or when any pack's `executableHash` changes.

#### `installed.json` (`InstalledState`)

Read by `readInstalled` and written by `applyPlan` (`src/utils/installer.ts`, mode `0o644`; see [Transactional Target Installer](../modules/target-installer.md)). Tracks exact ownership of installed files and `opencode.json(c)` contributions so `manage-agents` can distinguish untouched managed files, user-modified files, and unmanaged user files:

```json
{
  "installedVersion": 1,
  "files": {
    "agents/pipeline.md": {
      "hash": "9f86...64-hex-chars",
      "owner": "pipeline"
    },
    "instructions/pipeline.md": {
      "hash": "4b22...64-hex-chars",
      "owner": "pipeline"
    },
    "plugins/manage-agents-router/index.ts": {
      "hash": "7c11...64-hex-chars",
      "owner": ":engine"
    }
  },
  "config": {
    "pipeline": {
      "plugins": ["./plugins/pipeline-tools"],
      "skills": [],
      "instructions": ["/Users/dev/.config/opencode/instructions/pipeline.md"],
      "objects": {
        "mcp.servers": {
          "codebase-memory": { "type": "local", "command": ["codebase-memory-mcp"] }
        }
      }
    },
    ":engine": {
      "plugins": ["./plugins/manage-agents-router"],
      "skills": [],
      "instructions": [],
      "objects": {}
    }
  },
  "createdSections": ["mcp", "mcp.servers"]
}
```

- All keys in `files` must pass `isSafeRel` (non-empty, relative POSIX-style paths; no empty/`.`/`..` segments, backslashes, NUL bytes, or POSIX/Windows absolute paths).
- `:engine` (`ENGINE_OWNER`) marks files and `plugins` entries synthesized by `manage-agents` itself rather than a pack.
- `createdSections` records dotted object paths in `opencode.json` (e.g., `"mcp"`, `"mcp.servers"`) that did not exist before `manage-agents` created them; when uninstalling leaves those sections empty, `planConfig` deletes them while preserving empty sections originally authored by the user.
- If a managed file is modified locally by the user and later dropped by pack uninstallation/update, `planReconcile` releases ownership (`released`) and leaves the user's edited file in place with a warning rather than deleting it.

#### `install.lock` — Target Concurrency Lock

Managed by `withTargetLock` (`src/utils/installer.ts`). Serializes `install`, `uninstall`, `update`, `reconcile`, and `restore` operations per target across CLI and TUI processes.

```json
{
  "pid": 48210,
  "host": "workstation.local",
  "command": "reconcile",
  "started": "2026-11-13T10:15:30.000Z"
}
```

- Created exclusively with `{ flag: "wx" }`.
- If `install.lock` already exists:
  - Unparseable locks younger than `STALE_LOCK_GRACE_MS` (`10,000` ms) abort immediately to avoid racing a concurrent writer mid-write.
  - Locks from another `host` or a live `pid` (`process.kill(pid, 0)` succeeds or fails with `EPERM`) abort with a descriptive error naming the holder command, PID, host, and timestamp.
  - Dead same-host locks are moved aside atomically (`install.lock.stale-<pid>-<hex>`), verified byte-for-byte against the inspected payload (restoring via hard link if a third process acquired a fresh lock in between), and cleaned up.

#### `journal.json` & `txn/<id>/` — Atomic Staging & Crash Recovery

Managed by `applyPlan` and `rollbackInterrupted` (`src/utils/installer.ts`), where `<id>` has the format `<ISO-timestamp-with-hyphens>-<8-hex>`:

1. **Stage (`txn/<id>/new/<rel>`)**: Planned file writes, rewritten `opencode.json(c)`, and updated `.manage-agents/{installed,lock,desired}.json` are written inside `<target>/.manage-agents/txn/<id>/new/` (on the same filesystem as `<target>`); writes carrying a planned hash are checked against it.
2. **Pre-commit drift check**: Every target path in `plan.expected` is re-hashed (`symlink:<target>` for symlinks, SHA-256 for files, `null` for absent paths) to ensure nothing changed on disk while waiting for user confirmation.
3. **Write journal (`journal.json`)**: Written atomically (`0o644`) with `{ "id": "<id>", "ops": [{ "rel": "...", "existed": true, "hash": "..." }] }`.
4. **Swap (`txn/<id>/prev/<rel>`)**: Existing files are moved into `txn/<id>/prev/<rel>` (verifying their hash matches `plan.expected`), and staged files from `txn/<id>/new/<rel>` are moved into `<target>/<rel>` using `movePathWithRetry`.
5. **Cleanup or Rollback**: On success, `journal.json` and `txn/<id>/` are deleted and empty parent directories of deleted files are pruned. If an error or process crash interrupts step 4, `rollbackInterrupted` runs automatically at the start of the next mutating command, replaying `journal.ops` in reverse order to restore `txn/<id>/prev/<rel>` and remove newly created files matching `op.hash`.

`movePathWithRetry` (`src/utils/fsWindows.ts`) retries transient Windows `EPERM`, `EACCES`, and `EBUSY` errors. For `EXDEV` or a persistent transient lock, it falls back to a staged copy and removal, preserving an existing destination for restoration if replacement fails. Retry-aware removal is also used to clean up transaction and snapshot paths.

#### `backups/<id>/` — Adopted Content Backups

Created by `applyPlan` whenever `plan.adopted.files` or `plan.adopted.config` is non-empty (triggered by `--adopt` on unmanaged/locally edited files or config keys, or automatically when rewriting an `opencode.jsonc` file containing comments or trailing commas):

- `backups/<id>/backup.json` (`0o644`):
  ```json
  {
    "id": "2026-11-13T10-15-30-000Z-1a2b3c4d",
    "created": "2026-11-13T10:15:30.000Z",
    "configFile": "opencode.jsonc",
    "files": ["opencode.jsonc", "agents/custom.md"],
    "config": [
      { "section": "mcp.servers", "key": "local-tool", "value": { "type": "local", "command": ["tool"] } }
    ]
  }
  ```
- `backups/<id>/files/<rel>`: Exact copies of replaced files; user symlinks are recreated as symlinks (`fs.readlinkSync` / `fs.symlinkSync`) and never followed.
- Restored via `manage-agents restore <backup-id>` (`restoreBackup`; see [CLI Command Reference](../api/cli-reference.md)), which puts the backed-up files and config entries back into `<target>` and removes them from `installed.json` so they become unmanaged again.

---

### Synthesized Target Runtime & Config Files

- **`<target>/opencode.json` (or `opencode.jsonc`)**: If `opencode.jsonc` exists in `<target>`, `planReconcile` targets it instead of `opencode.json` (backing up the original text if JSONC comments or trailing commas are stripped when serializing JSON). Managed array sections (`plugins`, `skills`, `instructions`) and object sections (`mcp.servers`, `agents`, `commands`, `formatter`, `lsp`, `experimental`) are merged alongside unmanaged user keys.
- **`<target>/instructions/<pack>.md`**: Any pack shipping a root `AGENTS.md` has its file installed at `<target>/instructions/<pack>.md` and its absolute path appended to `instructions` in `<target>/opencode.json`.
- **`<target>/.resource-export-manifest.json`**: Optional legacy manifest (`{ "owner": "manage-agents", "resources": string[] }`) produced by pre-pack `manage-agents export`. Read by `readLegacyResources` (`src/utils/installer.ts`) so legacy exported files and `./plugins/*` entries are adopted cleanly without requiring `--adopt`.
- **`<target>/plugins/manage-agents-router/{index.ts, router.js, routing.json}`**: Installed under owner `":engine"` (and registered as `"./plugins/manage-agents-router"` in `opencode.json`) whenever `buildRuntimeRouting` (`src/utils/userSettings.ts`) produces at least one active pack entry.
  - `index.ts` and `router.js` are copied verbatim from the engine's `runtime/plugins/manage-agents-router/` directory (see [Runtime Router Plugin](../modules/runtime-router-plugin.md)).
  - `routing.json` (`RuntimeRouting`, `version: 2`) compiles pack defaults (`manifest.routingDefaults` and `manifest.flowDefaults`, `layer: 0`), global user settings (`default`, `layer: 1`), and per-target user settings (`targets.<realpath>`, `layer: 2`):
    ```json
    {
      "version": 2,
      "generatedBy": "manage-agents reconcile; edit with `manage-agents models`",
      "archetypes": {
        "pipeline": {
          "callers": ["pipeline"],
          "pinned": ["pipeline-security_auditor"],
          "routes": {
            "anthropic": {
              "pipeline-executor": "anthropic/claude-sonnet-4-5"
            }
          },
          "rules": [
            {
              "triggers": ["*"],
              "then": { "tools": { "webfetch": "allow" } },
              "layer": 0
            }
          ]
        }
      }
    }
    ```
  - At runtime in OpenCode, `index.ts` re-reads `routing.json` on hook evaluations and re-parses it only when its text changes, failing open on unexpected internal errors while enforcing explicit `"deny"` decisions on tools, permissions, and subagent delegations.

---

## 4. Environment Variables Reference

Every environment variable inspected or sanitized by the [launcher](../modules/launcher-and-build.md), [CLI](../api/cli-reference.md), TUI, Git/GitHub runners, release signer/updater, and [OpenCode router plugin](../modules/runtime-router-plugin.md):

| Variable | Default | Consumer Module(s) | Exact Effect |
|---|---|---|---|
| `XDG_CONFIG_HOME` | `~/.config` | `src/utils/sources.ts` (`engineConfigDir`), `src/utils/agents.ts` (`getExportDestination`), `src/utils/lock.ts` (`defaultTarget`) | Relocates both the user configuration directory (`$XDG_CONFIG_HOME/manage-agents`) and the default OpenCode target directory (`$XDG_CONFIG_HOME/opencode`). |
| `XDG_CACHE_HOME` | `~/.cache` | `src/utils/sources.ts` (`engineCacheDir`), `src/utils/sourceCustomization.ts` (`sourceBridgeOutputDir`) | Relocates the cache directory (`$XDG_CACHE_HOME/manage-agents`) used for detached Git checkouts (`sources/`), commit snapshots (`revisions/`), and Git-source bridge outputs (`bridges/`). |
| `HOME` / `USERPROFILE` | `os.homedir()` | `src/utils/sources.ts` (`expandUserPath`), `src/utils/packOnboarding.ts` (`defaultOnboardingCloneRoot`) | Resolves leading `~`, `~/`, or `~\` user paths (`HOME` checked first, then `USERPROFILE`, then `os.homedir()`) when cloning sources into working trees or suggesting `~/opencode-packs/<name>` during [pack onboarding](../modules/pack-onboarding-and-doctor.md). |
| `MANAGE_AGENTS_SKIP_AUTO_INSTALL` | Unset (auto-install enabled) | `manage-agents.mjs` | Setting `MANAGE_AGENTS_SKIP_AUTO_INSTALL=1` skips automatic `npm ci` / `npm install` / `bun install` checks in the launcher when `node_modules` is missing or out of sync with `package.json`. |
| `MANAGE_AGENTS_WORKSPACE` | Unset (auto-discover from `cwd`) | `src/index.tsx` (`run`) | Selects the pack catalog or single-pack directory for workspace commands (`create`, `lint`, `fix-names`, `audit`, `tune`, `bridge`) and TUI startup when `--workspace <dir>` is not passed on the CLI. |
| `AGENT_MANAGER_AUTO_COMMIT` | `"0"` | `src/utils/repositoryTransaction.ts` (`parseAutoCommitArgs`, `autoCommitEnabled`), `src/index.tsx` (`run`) | Must be `"0"` or `"1"` if set (throws an error otherwise). When `"1"` (unless overridden by `--no-auto-commit`), wraps local workspace mutations in an atomic [Git commit transaction](../modules/agent-editing-and-v2-compat.md) using `.git/agent-manager.lock` when the repository is clean and on a branch. |
| `AGENT_MANAGER_UI_CONFIG` | Unset (`<engineConfigDir>/ui.json`) | `src/utils/uiConfig.ts` (`loadUiConfig`, `saveUiConfig`) | Redirects the TUI layout/motion config path to the specified regular file and marks UI settings read-only (`saveUiConfig` throws if invoked while set). |
| `AGENT_MANAGER_REDUCED_MOTION` | Unset (`false` unless set in `ui.json`) | `src/ui/animations.ts` (`isReducedMotionPreferred`) | Setting `"1"` or `"true"` disables OpenTUI smooth number transitions, flash decays, toast progress timelines, and animated spinners (rendering a static `◌` indicator instead). |
| `AGENT_AUTHOR_NAME` | `"manage-agents"` | `src/utils/translationConfig.ts` (`authorName`) | Overrides the author name written into generated Claude Code and Codex plugin manifests and READMEs. Must match `/^[\p{L}\p{N} '’.\-]{1,100}$/u`; invalid values log a warning to `stderr` and fall back to the default. |
| `MANAGE_AGENTS_REPO` | Repository from `release-signing.json` or `package.json` (`lorecanc/manage-agents`) | `src/utils/selfUpdate.ts` (`resolveReleaseTrustPolicy`) | Overrides the `<owner>/<repo>` GitHub repository used by `manage-agents self-update` (`update --self`) and `manage-agents release sign` when `--repo` is not passed (see [Bridge Translation & Release Config Reference](./translation-and-release-config.md)). |
| `MANAGE_AGENTS_RELEASE_PUBLIC_KEY` | Unset (uses `release-signing.json`) | `src/utils/selfUpdate.ts` (`resolveReleaseTrustPolicy`) | Adds a trusted Ed25519 SPKI public key (PEM) to the release trust policy and enforces Ed25519 signature verification during `self-update`. Throws if its key ID collides with a different configured key. |
| `RELEASE_SIGNING_PRIVATE_KEY` | Unset | `src/utils/selfUpdate.ts` (`signReleaseAssets`) | Supplies the Ed25519 PKCS#8 private key (PEM; literal `\n` sequences are unescaped) for `manage-agents release sign` when `--private-key-file` is omitted. Required if `release-signing.json` configures Ed25519 trust. |
| `GITHUB_TOKEN` / `GH_TOKEN` | Unset (falls back to `gh auth token`) | `src/utils/selfUpdate.ts` (`createDefaultReleaseTransport`) | Bearer token (`GITHUB_TOKEN` preferred over `GH_TOKEN`; ignored if containing control characters) sent to `https://api.github.com` when direct HTTP fallback is used during `self-update`. |
| `GODEBUG` | Inherited | `src/utils/selfUpdate.ts` (`withHttp1Godebug`) | Preserved on initial `gh` CLI calls; if a transient transport error occurs, `http2client=0` is appended to `GODEBUG` on retry to force Go's HTTP client inside `gh` onto HTTP/1.1. |
| `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_OPTIONAL_LOCKS`, `GIT_CONFIG*` | Stripped (`GIT_TERMINAL_PROMPT=0` injected on remotes) | `src/utils/repositoryTransaction.ts` (`cleanGitEnvironment`), `src/utils/sources.ts`, `src/utils/github.ts`, `src/utils/engineVersion.ts`, `src/utils/selfUpdate.ts` | Stripped from `process.env` before spawning `git` or `gh` subprocesses so ambient Git overrides cannot redirect repository paths or inject config hooks. Non-interactive Git operations also pass `GIT_TERMINAL_PROMPT=0` (and `GIT_OPTIONAL_LOCKS=0` for `git status`). |
| `OPENCODE_AGENT_ROUTER` | Unset (router active) | `runtime/plugins/manage-agents-router/index.ts` (`setupRouter`) | Evaluated inside the OpenCode host process. Setting `OPENCODE_AGENT_ROUTER=off` (case-insensitive) disables the `manage-agents-router` plugin at startup without removing `./plugins/manage-agents-router` from `<target>/opencode.json`. |

## Related Pages

- [Bridge Translation & Release Config Reference](./translation-and-release-config.md) — Schema reference for `bridges/translation-config.json`, `release-signing.json`, and engine release manifests
- [Pack Lifecycle & Target Safety](../concepts/pack-lifecycle-and-target-safety.md) — Conceptual model of transactional target reconciliation, drift protection, and backups
- [Conditional Routing & Archetypes](../concepts/conditional-routing-and-archetypes.md) — How user `routing.json` layers combine with pack defaults into runtime policy rules
- [Security & Trust Model](../concepts/security-and-trust-model.md) — Source trust boundaries, symlink rejection, Git environment sanitization, and lock integrity
- [Transactional Target Installer](../modules/target-installer.md) — Implementation details of `planReconcile`, `applyPlan`, `install.lock`, and crash rollback
- [Archetypes, Conditional Flows & User Settings](../modules/routing-and-user-settings.md) — Implementation of `userSettings.ts` and scoped routing/override persistence
- [Sources & GitHub Integration](../modules/sources-and-github.md) — Implementation of `sources.json`, detached Git cache checkouts, and revision snapshots
- [CLI Command Reference](../api/cli-reference.md) — Commands and flags that read and mutate user settings and OpenCode targets
