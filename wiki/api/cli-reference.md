---
title: "CLI Command Reference"
description: "Complete syntax, flags, exit codes, and JSON output reference for all 20 manage-agents CLI commands"
category: "api"
source_files:
  - "src/index.tsx"
  - "src/utils/engineVersion.ts"
  - "src/utils/selfUpdate.ts"
  - "manage-agents.mjs"
  - "README.md"
created: "2026-11-13"
last_updated: "2026-11-17"
---

# CLI Command Reference

`manage-agents` provides both an interactive [OpenTUI terminal interface](../components/tui-shell-and-catalog.md) and 20 non-interactive or wizard-driven CLI commands covering *[pack]* (see [Glossary](../glossary.md)) validation and authoring, source management, dependency resolution, [OpenCode target installation](../concepts/pack-lifecycle-and-target-safety.md), user model routing and frontmatter overrides, workspace agent editing, [Claude Code / Codex translation bridges](../concepts/cross-harness-translation.md), engine self-updates, and release signing.

All CLI parsing and dispatch logic resides in `src/index.tsx`, bootstrapped by the [`manage-agents.mjs` launcher](../modules/launcher-and-build.md) (for setup and quickstart examples, see [Getting Started](../getting-started.md)).

---

## 1. Invocation, Launcher & Global Flags

### Synopsis

```bash
manage-agents [<command>] [options] [--workspace <catalog-or-pack-dir>] [--source <registered-source>] [--auto-commit | --no-auto-commit]
```

You can also invoke the launcher directly with `node manage-agents.mjs` or `bun manage-agents.mjs`.

### Launcher Behavior (`manage-agents.mjs`)

Before importing `dist/index.js`, [`manage-agents.mjs`](../modules/launcher-and-build.md) performs four preflight steps:

1. **Windows UTF-8 console pin**: On `win32`, runs `chcp 65001` best-effort.
2. **Runtime & FFI check**: Under Node.js (skipped under Bun), verifies [Node.js `>= 26.4.0`](../dependencies/runtime-and-tooling-stack.md) (exits `1` otherwise) and re-executes `process.execPath` with `--experimental-ffi` and `--no-warnings=ExperimentalWarning` if missing, propagating child exit status or `128 + signal`.
3. **Dependency synchronization**: Unless `MANAGE_AGENTS_SKIP_AUTO_INSTALL=1`, checks installed `node_modules` versions against `package.json` and runs `npm ci` / `npm install` (or `bun install --frozen-lockfile` / `bun install`) with `--ignore-scripts` when out of sync.
4. **On-demand bundle build**: In source checkouts (`src/` present), runs `npm run build` (or `bun run build`) whenever `dist/index.js` is missing or older than `src/` or `package.json`.

### TUI Launch (No Command)

Running `manage-agents` without `<command>` opens the [OpenTUI interface](../components/tui-shell-and-catalog.md) (`src/index.tsx:1580-1656`), resolving its initial view in priority order:

1. `--workspace <dir>` or `$MANAGE_AGENTS_WORKSPACE` (validated with `findWorkspace`; exits `1` if invalid).
2. `--source <name>` (pulls uncached git sources automatically and marks `<name>` as the active source in `sources.json`).
3. Nearest catalog (`packs/<name>/opencode-pack.json`), single pack (`opencode-pack.json`), or [virtual pack](../modules/pack-validation-and-virtual-packs.md) root discovered at or above `process.cwd()`.
4. Active registered source (`registry.active`, falling back to `registry.sources[0]`), or the [**Data Sources**](../components/workspaces-flows-and-sources.md) screen if no sources exist.

### Global Flags & Environment Variables

Global flags are stripped from `process.argv` before command-specific parsing (`src/index.tsx:1542-1561`):

| Flag / Variable | Default | Description |
|-----------------|---------|-------------|
| `--workspace <dir>` | `$MANAGE_AGENTS_WORKSPACE` or auto-detected | Explicit catalog or single-pack directory for TUI startup and workspace commands (`create`, `lint`, `fix-names`, `audit`, `tune`, `bridge`). |
| `--source <name>` | `registry.active` | Registered source to open in the TUI when `--workspace` is not set. Requires a value (exits `2` if empty). |
| `--auto-commit` | Off (`0`) | Enable scoped, hook-free, unsigned [local Git commits](../modules/agent-editing-and-v2-compat.md) for workspace mutations (`create`, `fix-names`, `tune`, `bridge`). Parsing stops at `--`. Cannot be combined with `--no-auto-commit` (exits `1`). |
| `--no-auto-commit` | On (`0`) | Explicitly disable auto-commit even when `AGENT_MANAGER_AUTO_COMMIT=1` is set. |
| `--version`, `-v`, `-V` | — | Top-level alias for `manage-agents version` (forwards remaining flags such as `--json`). |
| `--help`, `-h` | — | Print top-level command list and usage, then exit `0`. |
| `MANAGE_AGENTS_WORKSPACE` | Unset | Default workspace path when `--workspace` is omitted. |
| `AGENT_MANAGER_AUTO_COMMIT` | `0` | Must be `0` or `1` if set (any other value throws an error and exits `1`). Overridden by `--auto-commit` / `--no-auto-commit`. |
| `MANAGE_AGENTS_SKIP_AUTO_INSTALL` | Unset | Set to `1` to skip automatic `npm`/`bun` dependency installation in `manage-agents.mjs`. |
| `MANAGE_AGENTS_ALLOW_UNSIGNED` | Unset (`0`) | Set to `1` to permit SHA-256-only release operations when no trusted Ed25519 public key is configured; the command-line equivalent is `--allow-unsigned` for `self-update` and `release sign`. |
| `AGENT_MANAGER_UI_CONFIG` | [`$XDG_CONFIG_HOME/manage-agents/ui.json`](../config/user-and-target-files.md) | Custom UI layout config file path (loads layout in read-only mode). |

---

## 2. Pack Authoring & Validation (`pack`)

Implemented by `runPackCLI()` (`src/index.tsx:742-906`). Inspects, lists, initializes, diagnoses, and scaffolds [OpenCode Contract `1.1`](./pack-contract-reference.md) packs.

### `pack validate`

```bash
manage-agents pack validate <pack-dir>... [--json] [--git]
```

[Validates](../modules/pack-validation-and-virtual-packs.md) one or more directories against the OpenCode Pack Contract (layout, `opencode-pack.json`, namespaces, `opencode.json` keys, cross-file and cross-pack references, archetype definitions, and executable surface).

| Argument / Flag | Default | Description |
|-----------------|---------|-------------|
| `<pack-dir>...` | Required | One or more pack root directories to validate. |
| `--git` | `false` (`local` mode) | Apply stricter validation rules required for git-hosted packs (`sourceKind: "git"`). |
| `--json` | `false` | Emit `PackValidation` as JSON (a single object when one `<pack-dir>` is given, or an array when multiple directories are given). |

- **Exit codes**: `0` if all packs pass without `error`-level issues; `1` if any pack has validation errors; `2` if `<pack-dir>` is omitted or an unknown flag is passed.

### `pack list`

```bash
manage-agents pack list [--json]
```

Lists all packs offered by registered sources, including virtual packs synthesized from manifest-free `.md` agent directories or `.opencode/` project configurations, along with any discovery warnings.

- `--json`: Emits `{ packs: Array<{ source, sourceKind, root, relativeDir, trusted, name, version, description, requires, ... }>, problems: string[] }`.
- **Exit codes**: `0` on success; `2` on unknown flags.

### `pack init` & `pack onboard`

```bash
manage-agents pack init [<dir>] [options]
manage-agents pack onboard [<dir>] [options]
```

Turns a raw folder or a cloned git source into a Contract `1.1` pack (see [Pack Onboarding, Doctor & Scaffolding](../modules/pack-onboarding-and-doctor.md)), [migrating V1 frontmatter to OpenCode V2](../modules/agent-editing-and-v2-compat.md), inferring [`archetype`](../concepts/conditional-routing-and-archetypes.md) metadata, and optionally organizing resources and installing authoring tooling.

| Argument / Flag | Default | Description |
|-----------------|---------|-------------|
| `[<dir>]` | `process.cwd()` (or `suggestCloneDestination` with `--clone-source`) | Target directory to initialize or destination path for `--clone-source`. |
| `--name <slug>` | Derived from directory | Pack slug (`opencode-pack.json` `name`). |
| `--version <semver>` | `"0.1.0"` (or existing) | Initial SemVer version string. |
| `--description <text>` | Generated / existing | Pack description in `opencode-pack.json`. |
| `--layout <auto\|root\|subpack>` | `root` (`init`), `auto` (`onboard`) | Pack layout: `root` writes `opencode-pack.json` at `<dir>`; `subpack` writes under `packs/<name>/`; `auto` chooses `subpack` when mixed application files sit at the repository root. |
| `--clone-source <name>` | None | Clone registered git source `<name>` into `[<dir>]`, register the local clone as the active source, and onboard it. |
| `--no-organize` | `false` (organizes files) | Keep existing file paths instead of moving loose agents/resources into canonical directories. |
| `--authoring-kit` | `false` | Install `.opencode/skills/opencode-pack-authoring/` and a GitHub Actions pack validation workflow. |
| `--json` | `false` | Emit onboarding report JSON (`{ cloned?, manifest, manifestPath, layout, movedAgents, movedResources, kitFiles, warnings }`). |

- **Exit codes**: `0` on success; `1` on clone/onboarding error; `2` on invalid `--layout` or CLI syntax error.

### `pack doctor`

```bash
manage-agents pack doctor [<dir>] [--fix] [--authoring-kit] [--bump <patch|minor|major>] [--json]
```

Diagnoses contract drift, missing authoring kit files, and auto-fixable issues in an existing pack, optionally repairing them and bumping the pack version.

| Argument / Flag | Default | Description |
|-----------------|---------|-------------|
| `[<dir>]` | `process.cwd()` | Pack or repository directory (resolved via `resolveEditablePackDir`). |
| `--fix` | `false` | Apply automatic repairs for fixable findings. |
| `--authoring-kit` | `false` | Install missing authoring skill and CI validation workflow files. |
| `--bump <patch\|minor\|major>` | None | Bump `version` in `opencode-pack.json` by `patch`, `minor`, or `major` before inspecting/fixing. |
| `--json` | `false` | Emit `{ bumped?, appliedFixes?, kitFiles?, report }`. |

- **Exit codes**: `0` when `report.validation` has zero errors; `1` if validation errors remain or a runtime error occurs; `2` on invalid `--bump` or unknown option.

### `pack add`

```bash
manage-agents pack add <agent|skill|command> <id> [--dir <dir>] [--description <text>] [--mode <primary|subagent|all>] [--json]
```

Scaffolds a compliant OpenCode V2 resource inside a local pack.

| Argument / Flag | Default | Description |
|-----------------|---------|-------------|
| `<agent\|skill\|command>` | Required | Kind of resource to scaffold. |
| `<id>` | Required | Resource identifier (namespaced appropriately for the pack). |
| `--dir <dir>` | `process.cwd()` | Pack or workspace root directory. |
| `--description <text>` | Generated default | Frontmatter description for the scaffolded resource. |
| `--mode <primary\|subagent\|all>` | Resource default | Execution mode (used when scaffolding an `agent`). |
| `--json` | `false` | Emit scaffolded resource metadata (`{ kind, id, relativePath, ... }`). |

- **Exit codes**: `0` on success; `1` if target file exists or pack resolution fails; `2` on invalid kind, missing `<id>`, or invalid `--mode`.

---

## 3. Source Registry & GitHub (`source`)

Implemented by `runSourceCLI()` (`src/index.tsx:908-1010`; see [Sources & GitHub Integration](../modules/sources-and-github.md)). Manages [`$XDG_CONFIG_HOME/manage-agents/sources.json`](../config/user-and-target-files.md) and cached git checkouts under `$XDG_CACHE_HOME/manage-agents/sources/<name>`.

### Subcommands

| Subcommand | Syntax | Description |
|------------|--------|-------------|
| `list` | `manage-agents source list [--json]` | List registered sources (`*` marks active), kind (`local`/`git`), trust state, path or URL+revision, and `prefer` mappings. `--json` prints the full `sources.json` registry object. |
| `add` | `manage-agents source add [<name>] <dir\|git-url\|owner/repo[#ref]> [--ref <ref>] [--trust] [--pull]` | Register a local directory, git URL (`https:`, `ssh:`, `git@host:path`), or GitHub shorthand (`owner/repo`, `github:owner/repo`). [Rejects URLs with embedded credentials](../concepts/security-and-trust-model.md). Derives `<name>` when omitted and sets `active` if none is set. `--trust` marks trusted; `--pull` immediately clones/fetches git sources. |
| `remove` | `manage-agents source remove <name>` | Remove `<name>` from `sources.json` (leaves any cached git checkout in `$XDG_CACHE_HOME/manage-agents/sources/`). |
| `pull` | `manage-agents source pull [<name>...]` | Clone or fetch named git sources into the cache (defaults to all registered `git` sources; local sources print a skip notice). Uses `gh auth git-credential` automatically when `gh` is authenticated for the HTTPS host. |
| `login` | `manage-agents source login [--hostname <host>]` | Authenticate GitHub CLI interactively via `gh auth login --web` for `<host>` (default: `github.com`). |
| `auth` | `manage-agents source auth [--hostname <host>] [--json]` | Check GitHub CLI authentication status for `<host>` (default: `github.com`). In text mode, exits `1` when unauthenticated; with `--json`, emits the `gh` auth status object and exits `0`. |
| `trust` | `manage-agents source trust <name>` | Mark source `<name>` as trusted so its initial executable content installs without confirmation. |
| `untrust` | `manage-agents source untrust <name>` | Mark source `<name>` as untrusted so installing its executable content requires confirmation. |
| `prefer` | `manage-agents source prefer <pack> <source>`<br>`manage-agents source prefer <pack> --clear` | Pin `<source>` when multiple sources provide `<pack>`, or remove the preference with `--clear`. |

- **Exit codes**: `0` on success; `1` on missing source, git/network failure, credentialed URL rejection, failed `login`, or unauthenticated `auth` (text mode); `2` on missing subcommand, invalid argument count, invalid `<pack>` slug, or unknown flag.

---

## 4. Resolution & OpenCode Target Lifecycle

Implemented by `runResolveCLI()` and `runTargetCLI()` (`src/index.tsx:1013-1143`). Manages [pack resolution](../modules/resolver-and-lock.md) and [transactional installation](../modules/target-installer.md) into an OpenCode configuration directory (`--target <dir>`, defaulting to `$XDG_CONFIG_HOME/opencode`, i.e. `~/.config/opencode`). [Target state](../config/user-and-target-files.md) is stored in `<target>/.manage-agents/` (`desired.json`, `lock.json`, `installed.json`, `backups/<id>/`, and `install.lock`; see [Pack Lifecycle & Target Safety](../concepts/pack-lifecycle-and-target-safety.md)).

### Pack Request Syntax

Root pack specifications accept `<[source/]pack[@range]>`:
- `flow` — pack `flow` from the sole offering source or configured `source prefer` mapping.
- `my-source/flow` — pack `flow` explicitly from source `my-source`.
- `flow@^1.2.0` or `my-source/flow@1.2.3` — pack `flow` constrained to a valid SemVer range.

### `resolve`

```bash
manage-agents resolve <[source/]pack[@range]>... [--target <opencode-config-dir>] [--json]
```

Resolves requested packs and transitive `requires` across registered sources without writing to disk. Validates every selected pack, compares the resulting lock against `<target>/.manage-agents/lock.json`, lists executable surfaces, and reports required confirmations.

- `--json`: Emits `{ target, packs, lock?, changes, executableChanges, confirmations, problems, warnings }`.
- **Exit codes**: `0` if `problems` is empty; `1` if resolution problems occur (ambiguous source, missing pack, dependency cycle, contract error); `2` if no pack arguments are given or flags are invalid.

### `install`, `uninstall`, `update`, `reconcile`, `status`, `restore`

```bash
manage-agents install <[source/]pack[@range]>... [--target <dir>] [--adopt] [--yes] [--dry-run] [--json]
manage-agents uninstall <pack>... [--target <dir>] [--dry-run] [--json]
manage-agents update [<pack>...] [--target <dir>] [--adopt] [--yes] [--dry-run] [--json]
manage-agents update --self [...]
manage-agents reconcile [--target <dir>] [--adopt] [--dry-run] [--json]
manage-agents status [--target <dir>] [--json]
manage-agents restore <backup-id> [--target <dir>]
```

| Command | Positional Arguments | Supported Flags | Behavior |
|---------|----------------------|-----------------|----------|
| `install` | `<[source/]pack[@range]>...` (required) | `--target`, `--adopt`, `--yes`, `--dry-run`, `--json` | Adds root packs and dependencies to `<target>`. Already-installed packs keep their locked version. |
| `uninstall` | `<pack>...` (required) | `--target`, `--dry-run`, `--json` | Removes root packs from `desired.json`; transitive dependencies still needed by remaining roots stay installed. |
| `update` | `[<pack>...]` (optional) | `--target`, `--adopt`, `--yes`, `--dry-run`, `--json`, `--self` | Pulls git sources of named packs (or all installed packs when omitted) and re-resolves within version ranges. Passing `--self` delegates to `self-update`. |
| `reconcile` | None (rejected if passed) | `--target`, `--adopt`, `--dry-run`, `--json` | Rebuilds `<target>` from `desired.json`, `lock.json`, `routing.json`, and `overrides.json`, repairing modified/missing managed files and regenerating [`plugins/manage-agents-router/routing.json`](../modules/runtime-router-plugin.md). |
| `status` | None (rejected if passed) | `--target`, `--json` | Read-only drift check comparing `<target>` against `lock.json` and `installed.json`. Prints `"In sync."` or lists `drift:` items. |
| `restore` | `<backup-id>` (required; uses first arg) | `--target` | Restores files and `opencode.json` keys backed up under `<target>/.manage-agents/backups/<backup-id>/` by `--adopt`; restored entries become unmanaged. |

#### Target Lifecycle Flags

- `--target <opencode-config-dir>`: OpenCode config directory to inspect or mutate (default: `$XDG_CONFIG_HOME/opencode`).
- `--adopt`: Back up conflicting unmanaged files, unmanaged `opencode.json` keys, or locally edited managed files into `<target>/.manage-agents/backups/<id>/` and replace them.
- `--yes`: Accept confirmations for [untrusted executable content](../concepts/security-and-trust-model.md) or changed executable surfaces (required when running without an interactive TTY).
- `--dry-run`: Compute the full plan, conflicts, and confirmations without mutating `<target>`.
- `--json`:
  - For `install`, `uninstall`, `update`, `reconcile`: emits `{ command, target, status, recovered, changes, confirmations, problems, warnings, writes, deletes, released, configChanged, backupId }`, where `status` is `"applied" | "noop" | "dry-run" | "declined" | "failed"`.
  - For `status`: emits `{ target, roots, packs, drift }`.
- **Exit codes**:
  - `status`: `0` when `drift` is empty; `1` when `drift` is non-empty or an error occurs; `2` on invalid flags or unexpected positional args.
  - `install`, `uninstall`, `update`, `reconcile`: in text mode, exits `1` when `result.status` is `"failed"` or `"declined"`; in `--json` mode, exits `0` with `status: "failed" | "declined"` in the JSON payload (or `1` if an uncaught filesystem/lock exception is thrown); exits `2` on CLI argument errors.
  - `restore`: `0` on success; `1` if `<backup-id>` is missing/invalid on disk; `2` if `<backup-id>` argument is omitted.

---

## 5. User Routing & Frontmatter Overrides (`models`, `override`)

Implemented by `runSettingsCLI()` (`src/index.tsx:1145-1325`). Persists [user customizations](../modules/routing-and-user-settings.md) in [`$XDG_CONFIG_HOME/manage-agents/routing.json` and `$XDG_CONFIG_HOME/manage-agents/overrides.json`](../config/user-and-target-files.md) without modifying pack sources (so read-only git sources remain clean). Unless `--no-reconcile` is passed, mutating subcommands automatically run `reconcile` on `--target` if a `lock.json` exists.

### Common Flags (`models` & `override`)

| Flag | Default | Description |
|------|---------|-------------|
| `--target <dir>` | `$XDG_CONFIG_HOME/opencode` | Target OpenCode directory for target-scoped settings and automatic reconciliation. |
| `--global` | `false` (target-scoped) | Write to the `default` scope (applies to every target; target-scoped settings take precedence over `default`). |
| `--no-reconcile` | `false` | Save settings without immediately reconciling `--target`. |
| `--yes` | `false` | Auto-accept any confirmation prompts triggered during post-save reconciliation. |
| `--json` | `false` | Emit JSON output (used by `models show` and `override show`). |

### `models` Subcommands

```bash
manage-agents models show [--target <dir>] [--json]
manage-agents models set <pack> <trigger[,trigger2...]> <agent>=<provider/model[#variant]|inherit>... [common-flags]
manage-agents models unset <pack> <trigger[,trigger2...]> [<agent>...] [common-flags]
manage-agents models callers <pack> [<caller>...] [--unset] [common-flags]
manage-agents models rule-set <pack> <trigger[,trigger2...]> [--callers <a,b>] [--model <sub=m>]... [--tool <k=allow|ask|deny>]... [--perm <action=allow|ask|deny>]... [--delegate <sub=allow|deny>]... [--index <n>] [common-flags]
manage-agents models rule-unset <pack> [<index|all>] [common-flags]
manage-agents models export-pack <pack> [--dir <workspace-or-pack-dir>] [--target <dir>]
manage-agents models pin <pack>/<agent> <provider/model[#variant]> [common-flags]
manage-agents models unpin <pack>/<agent> [common-flags]
```

| Subcommand | Description |
|------------|-------------|
| `show` | Display global (`default`), target-specific (`target`), and active merged [router configuration](../modules/runtime-router-plugin.md) (`<target>/plugins/manage-agents-router/routing.json`). With `--json`, emits `{ default, target, installed }`. |
| `set` | Route subagents `<agent>=<provider/model[#variant]\|inherit>...` whenever a caller of `<pack>` runs on `<trigger>` (`*`, `<provider>`, or `<provider/model>`; comma-separated `OR` list supported). |
| `unset` | Remove specific `<agent>...` route assignments (or the entire `<trigger>` entry when `<agent>` is omitted) for `<pack>`. Exits `1` if no matching route exists in scope. |
| `callers` | Set custom `OR` caller agent IDs for `<pack>` in `routing.json` (accepts space- or comma-separated IDs; works even on packs without `archetype` in `opencode-pack.json`), or clear custom callers with `--unset` (exits `1` if none set). |
| `rule-set` | Append (or replace at 0-based `--index <n>`) a full [conditional `IF / OR` rule](../concepts/conditional-routing-and-archetypes.md) for `<pack>` matching `<trigger[,trigger2...]>`, optionally scoped to `--callers <a,b>`. Repeatable/comma-list policy flags: `--model <sub=model>`, `--tool <key=allow\|ask\|deny>`, `--perm <action=allow\|ask\|deny>`, `--delegate <sub=allow\|deny>`. |
| `rule-unset` | Remove conditional rule at 0-based `<index>` or clear `all` rules (default when omitted is `all`) for `<pack>`. Exits `1` if no rules exist or `<index>` is out of range. |
| `export-pack` | Write effective callers, `routingDefaults`, and `flowDefaults` for `<pack>` (resolved against `--target`) directly into the local pack's [`opencode-pack.json`](./pack-contract-reference.md) inside `--dir` (defaults to `findWorkspace(process.cwd()) ?? process.cwd()`). Does not reconcile. |
| `pin` | Fix `<pack>/<agent>` to `<provider/model[#variant]>` in `overrides.json` (`model` field) so dynamic routing skips it. |
| `unpin` | Write `model: null` for `<pack>/<agent>` in `overrides.json`, stripping any fixed model (including the pack's own frontmatter `model`) so the subagent follows dynamic routing. |

### `override` Subcommands

```bash
manage-agents override show [--target <dir>] [--json]
manage-agents override set <pack>/<id> <field>=<value>... [--command] [common-flags]
manage-agents override unset <pack>/<id> [<field>...] [--command] [common-flags]
```

| Subcommand | Description |
|------------|-------------|
| `show` | Display global (`default`) and target-specific (`target`) frontmatter overrides. With `--json`, emits `{ default, target }`. |
| `set` | Patch frontmatter fields on installed agent `<pack>/<id>` (or command `<pack>/<id>` when `--command` is set). Each `<field>=<value>` parses `<value>` as YAML (for example `steps=30`, `hidden=true`, `model=null` where `null` deletes the field from installed frontmatter). |
| `unset` | Delete specific override `<field>...` keys (or all overrides on `<pack>/<id>` when `<field>` is omitted). Pass `--command` to target a command instead of an agent. Exits `1` if no matching override exists in scope. |

- **Exit codes (`models` & `override`)**: `0` on success; `1` on validation errors, malformed `<pack>/<id>` or `<name>=<value>`, missing unset target, missing pack in `export-pack`, or failed post-save reconciliation; `2` on missing subcommand or unknown CLI flags.

---

## 6. Workspace Agent Editing & Cross-Harness Bridges

Workspace commands operate on a local pack catalog or single pack resolved via `--workspace <dir>`, `$MANAGE_AGENTS_WORKSPACE`, or `findWorkspace(process.cwd())` (`src/index.tsx:1572-1578`). If no valid workspace is found, `manage-agents` exits `1`. Mutating commands (`create`, `fix-names`, `tune`, `bridge`) execute inside [`repositoryMutation`](../modules/agent-editing-and-v2-compat.md), honoring `--auto-commit` / `--no-auto-commit`.

### `create`

```bash
manage-agents create
```

Interactive CLI wizard (`src/index.tsx:128-223`) that creates a new OpenCode V2 subagent markdown file following `[<family>-]<pack>-<role_with_underscores>.md`:

1. Prompts for optional **Family**, **Pack** (automatically selected in single-pack workspaces), required **Role**, **Description**, and **LLM model** (queried live from `opencode models`).
2. Writes `<pack>/agents/[<family>-]<pack>-<role>.md` exclusively (`wx` flag) after verifying `agents/` is a real directory inside the workspace (never a symlink).
- **Exit codes**: `0` on creation; `1` if target agent already exists, `opencode models` returns an empty catalog, or path validation fails.

### `lint`

```bash
manage-agents lint
```

Read-only report (`src/index.tsx:515-545`) checking all workspace agent filenames against `[{family}-]{category}-{role_with_underscores}.md`, printing errors, suggested renames, and compliant/non-compliant totals. Always exits `0`.

### `fix-names`

```bash
manage-agents fix-names [--dry-run]
```

Batch-renames non-compliant agent files to their suggested names and rewrites cross-references across the workspace (`src/index.tsx:547-607`).

- `--dry-run`: Preview planned renames without prompting or modifying files.
- Without `--dry-run`: Prompts `Proceed with refactoring? (Y/n):` before applying atomic renames.
- **Exit codes**: `0` (errors during rename are logged to `stderr` and abort the batch cleanly).

### `audit`

```bash
manage-agents audit
```

Read-only [security and permission audit](../concepts/security-and-trust-model.md) (`src/index.tsx:609-641`) across all workspace agents:
- Flags **Permission Order Errors** where wildcard `"*": "deny"` is not placed first.
- Classifies agents into **High Risk**, **Medium Risk**, and **Low Risk** tiers with reasons.
- Always exits `0`.

### `tune`

```bash
manage-agents tune [options]
```

Batch-updates OpenCode V2 execution frontmatter parameters across workspace agents (`src/index.tsx:643-702`, `src/utils/agents.ts:128-217`; interactive TUI counterpart: [Authoring, Tuning & Bridge Modals](../components/authoring-and-bridge-modals.md)). At least one parameter mutation flag must be supplied.

| Flag | Default | Description |
|------|---------|-------------|
| `--steps <number>` | Unchanged | Set max execution steps (positive integer). |
| `--variant <name>`, `--effort <name>` | Unchanged | Set model reasoning/effort variant (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `thinking`, or any variant exposed by the agent's model in `opencode models --verbose`). |
| `--clear-variant`, `--clear-effort` | `false` | Remove `variant` from agent frontmatter. Cannot combine with `--variant` / `--effort`. |
| `--mode <primary\|subagent\|all>` | Unchanged | Set agent execution `mode`. |
| `--hidden` / `--no-hidden` | Unchanged | Set `hidden: true` or `hidden: false` (mutually exclusive). |
| `--pack <pack>`, `--category <pack>`, `-c <pack>` | All packs | Restrict updates to agents belonging to `<pack>`. |
| `--all` | `true` (when `--pack` omitted) | Explicitly target all workspace agents. Cannot combine with `--pack` / `--category`. |
| `--help`, `-h` | — | Print `tune` usage and exit `0`. |

> **Note**: Passing legacy `--temp` fails with exit code `1` because OpenCode V2 ignores agent-level sampling parameters (`temperature`, `top_p`, `top_k`); configure sampling on model variants instead.

- **Exit codes**: `0` on success; `1` on invalid/conflicting flags, unknown variant, or empty matching agent set.

### `bridge` & `bridge check`

```bash
manage-agents bridge [options]
manage-agents bridge check [--pack <name>] [--target <claude|codex>]
```

[Translates](../concepts/cross-harness-translation.md) a workspace pack and its transitive `requires` into a **Claude Code plugin** or a **Codex layer** (`src/index.tsx:265-513`; see [Claude Code & Codex Bridges](../modules/bridges.md)). Reusable settings are stored in [`bridges/translation-config.json`](../config/translation-and-release-config.md) by default.

#### `bridge` Options

| Flag | Default | Description |
|------|---------|-------------|
| `--pack <name>` | Configured `prefix` stripped of trailing `-` | Pack to translate (with its required packs). |
| `--target <name>`, `-t <name>` | `config.target` (`claude`) | Translation target: `claude` or `codex`. |
| `--output <path>`, `-o <path>` | `bridges/<claude-code\|codex>/<name>` | Output directory for generated bridge files. |
| `--name <name>`, `-n <name>` | `config.pluginName` (`decent-pipeline`) | Plugin / layer name (sanitized for filesystem use). |
| `--prefix <prefix>`, `-p <prefix>` | `<pack>-` (or `config.prefix`) | Prefix stripped from source agent names. |
| `--config <path>` | `bridges/translation-config.json` | Path to reusable translation config JSON. |
| `--model <src=target>` | Merged into `config[target].modelMap` | Map source model ID (full `provider/model`, bare `model`, or `*`) to target model; repeatable and accepts comma-separated lists. Persisted to config. |
| `--map-all <target>` | None | Shorthand for `--model "*=<target>"`. Persisted to config. |
| `--no-validate` | `claude.autoValidate` (`true`) | Skip running `claude plugin validate --strict` after generating a `claude` bridge. Persisted to config. |
| `--no-register` | `claude.autoRegister` (`true`) | Skip registering/installing the generated plugin into Claude Code. Persisted to config. |
| `--marketplace-name <name>` | `<plugin>-local` | Local Claude marketplace identifier used during plugin registration. Persisted to config. |
| `--wizard`, `-w` | `false` | Launch interactive wizard to configure target, plugin name, prefix, and planning/execution tier models before bridging. |
| `--help`, `-h` | — | Print `bridge` usage and exit `0`. |

#### `bridge check` Options

Regenerates committed bridges (`bridges/claude-code/<plugin>` and/or `bridges/codex/<plugin>`) in memory without migrating or writing `translation-config.json`, comparing every file byte-for-byte (`missing`, `changed`, `extra`).

| Flag | Default | Description |
|------|---------|-------------|
| `--pack <name>` | Configured `prefix` without trailing `-` | Pack translated by the committed bridges. |
| `--target <name>`, `-t <name>` | Both `claude` and `codex` (if present) | Check only `claude` or only `codex`. |
| `--help`, `-h` | — | Print `bridge check` usage and exit `0`. |

- **Exit codes (`bridge` & `bridge check`)**: `0` when generation succeeds or committed bridges match cleanly; `1` when `bridge check` detects drift, `--pack` cannot be determined, `--target` is invalid, no committed bridge exists, or an unknown option is passed.

---

## 7. Engine Version, Self-Update & Release Signing

Implemented by `runVersionCLI()`, `runSelfUpdateCLI()`, and `runReleaseCLI()` (`src/index.tsx:1377-1614`; dispatches `version`, `self-update`, `release`, `--version`/`-v`/`-V`, and `update --self`; see [Launcher, Build & Self-Update](../modules/launcher-and-build.md)).

### `version`

```bash
manage-agents version [--json] [--engine-root <dir>]
manage-agents --version [--json]
manage-agents -v [--json]
manage-agents -V [--json]
manage-agents version --write-manifest --ref-type <tag|branch> --ref-name <name> --sha <sha> [--engine-root <dir>] [--json]
```

Inspects the running `manage-agents` engine installation or writes an engine release manifest during CI builds.

| Flag | Default | Description |
|------|---------|-------------|
| `--engine-root <dir>` | Auto-detected engine root | Override the `manage-agents` installation directory to inspect or stamp. |
| `--write-manifest` | `false` | Write engine release manifest metadata (requires `--ref-type`, `--ref-name`, and `--sha`). |
| `--ref-type <tag\|branch>` | Required with `--write-manifest` | Git reference kind (`tag` or `branch`). |
| `--ref-name <name>` | Required with `--write-manifest` | Git tag or branch name. |
| `--sha <sha>` | Required with `--write-manifest` | Full commit SHA being packaged. |
| `--json` | `false` | Emit `EngineVersionInfo` (`displayVersion`, `channel`, `dirty`, `engineRoot`, `bundleHash`, etc.) or written `EngineReleaseManifest` as JSON. |

- **Exit codes**: `0` on success; `1` on manifest/filesystem failure; `2` on positional arguments, missing `--write-manifest` required flags, or unknown options.

### `self-update`

```bash
manage-agents self-update [--check] [--yes|-y] [--force] [--allow-unsigned] [--reconcile|--no-reconcile] [--repo <owner/repo>] [--target <dir>] [--engine-root <dir>] [--json]
manage-agents update --self [...]
```

Checks or installs the latest `v*` GitHub Release of `manage-agents` into its installation directory with atomic backup/rollback, archive SHA-256 verification, and inner bundle hash verification. A configured trusted Ed25519 key requires a valid release signature; without a configured key, `--allow-unsigned` opts into SHA-256-only release verification. `update --self` dispatches to this command after removing the alias flag.

| Flag | Default | Description |
|------|---------|-------------|
| `--check` | `false` | Check for updates against GitHub Releases and report verification mode, digests, and availability without modifying disk. |
| `--yes`, `-y` | `false` | Skip interactive `[Y/n]` confirmation prompt. **Required** when running non-interactively (non-TTY) or with `--json` when an update is available. |
| `--force` | `false` | Allow downgrading and overwrite an engine installation with uncommitted changes. |
| `--allow-unsigned` | `false` | Permit SHA-256 and bundle-hash verification without an Ed25519 signature when no trusted public key is configured. Does not bypass a configured trusted-key requirement. |
| `--reconcile` | Automatic after an applied update when the target has installed packs | Request reconciliation even when the engine is already current (when the target has installed packs). Mutually exclusive with `--no-reconcile`. |
| `--no-reconcile` | `false` | Skip automatic reconciliation of `--target` after updating the engine. |
| `--repo <owner/repo>` | Configured repo, `$MANAGE_AGENTS_REPO`, or `lorecanc/manage-agents` | GitHub repository to query for releases. |
| `--target <dir>` | `$XDG_CONFIG_HOME/opencode` | OpenCode target directory to check and reconcile after updating. |
| `--engine-root <dir>` | Auto-detected engine root | Override `manage-agents` installation directory. |
| `--json` | `false` | Emit structured JSON (`checkResult` on `--check`; `{ updated: false, applied: false, ... }` when up-to-date or downgrade-blocked; full update result when applied) and suppress progress lines. A blocked downgrade exits `1`; a failed post-update reconciliation also sets exit code `1`. |

- **Exit codes**: `0` on success, up-to-date, or user-cancelled prompt; `1` on a blocked downgrade (without `--force`), network/signature/checksum failure, missing `--yes` in non-TTY / `--json` mode when an update applies, or failed reconciliation; `2` on positional arguments, combining `--reconcile` with `--no-reconcile`, or unknown flags.

### `release` (`keygen` & `sign`)

```bash
manage-agents release keygen [--out <private-key-file>] [--key-id <id>] [--repo <owner/repo>] [--replace-keys] [--engine-root <dir>] [--json]
manage-agents release sign --tag <tag> --sha <sha> --assets-dir <dir> [--repo <owner/repo>] [--private-key-file <file>] [--engine-root <dir>] [--allow-unsigned] [--json]
```

Maintainer tooling for Ed25519 release signing and `release-metadata.json` generation. `--allow-unsigned` permits SHA-256-only metadata when no trusted signing key is configured; a configured trusted-key policy still requires a matching Ed25519 private key.

#### `release keygen`

Generates an Ed25519 signing keypair, writes the private key with `0600` permissions, and updates `release-signing.json` in `--engine-root`.

| Flag | Default | Description |
|------|---------|-------------|
| `--out <private-key-file>` | `.release-key.pem` | Output path for the PEM private key (`0600`). |
| `--key-id <id>` | Auto-generated | Explicit key identifier stored in `release-signing.json`. |
| `--repo <owner/repo>` | Engine default (`lorecanc/manage-agents`) | Repository recorded in `release-signing.json`. |
| `--replace-keys` | `false` (appends key for rotation) | Replace existing public keys in `release-signing.json` instead of appending. |
| `--engine-root <dir>` | Auto-detected engine root | Directory containing `release-signing.json`. |
| `--json` | `false` | Emit `{ keyId, publicKeyPem, configPath, privateKeyPath }`. |

#### `release sign`

Computes SHA-256 archive digests in `--assets-dir` and writes `release-metadata.json`. When an Ed25519 private key is provided from `--private-key-file` or `$RELEASE_SIGNING_PRIVATE_KEY`, it also writes `release-metadata.json.sig`; unsigned SHA-256-only metadata requires `--allow-unsigned` and no configured trusted public keys.

| Flag | Default | Description |
|------|---------|-------------|
| `--tag <tag>` | Required | Release tag name (for example `v1.2.0`). |
| `--sha <sha>` | Required | Commit SHA corresponding to the release. |
| `--assets-dir <dir>` | Required | Directory containing built release archive assets and receiving `release-metadata.json` (+ `.sig`). |
| `--private-key-file <file>` | Not set | Read the Ed25519 PEM private key from this file; if omitted, read PEM content from `$RELEASE_SIGNING_PRIVATE_KEY`. |
| `--repo <owner/repo>` | Engine default | Repository identifier recorded in `release-metadata.json`. |
| `--engine-root <dir>` | Auto-detected engine root | Engine root used to read `release-signing.json`. |
| `--allow-unsigned` | `false` | Write SHA-256-only metadata when no trusted key is configured; the policy cannot be bypassed when trusted public keys are present. |
| `--json` | `false` | Emit `{ metadata, metadataPath, signaturePath, signatureBase64 }`; signature fields are `null` in unsigned mode. |

- **Exit codes (`release`)**: `0` on success (`--help` or bare `manage-agents release` prints usage and exits `0`); `1` on missing/invalid signing key or asset/signing errors; `2` on invalid subcommand, missing required flags, unexpected positional arguments, or unknown options.

---

## 8. Exit Codes & `--json` Output Conventions

### Standard Exit Code Contract

| Exit Code | Meaning | Typical Triggers |
|-----------|---------|------------------|
| `0` | **Success** | Command completed cleanly, `--help` / `--version` printed, `status` is in sync, `bridge check` has no drift, or `self-update` found no update needed or the user cancelled its confirmation prompt. |
| `1` | **Operational, validation, or drift failure** | Pack validation errors (`pack validate`, `pack doctor`), resolution problems (`resolve`), target drift (`status`), declined/failed target changes in text mode (`install`, `uninstall`, `update`, `reconcile`), bridge drift (`bridge check`), unauthenticated `source auth` (text mode), missing workspace, `tune` validation errors, blocked self-update downgrade, failed self-update reconciliation, Node.js `< 26.4.0` in `manage-agents.mjs`, or runtime exceptions. |
| `2` | **CLI usage / argument error** | Unknown top-level command, unknown option or missing flag value in `parseCliArgs()`, missing required subcommand (`pack`, `source`, `models`, `override`), missing required positional arguments (`install`, `uninstall`, `restore`, `resolve`, `pack validate`), unexpected positional arguments (`reconcile`, `status`, `version`, `self-update`), invalid `release` subcommand or syntax, or empty `--source`. |
| `128 + N` | **Signal termination** | Launcher (`manage-agents.mjs`) child Node process terminated by OS signal `N`. |

### `--json` Output & Terminal Safety Escaping

1. **C1 & DEL control character escaping**: Because pack manifests, descriptions, and git metadata come from untrusted external repositories, `printJson()` (`src/index.tsx:705`) formats output with `JSON.stringify(value, null, 2)` and escapes bytes `\u007f` through `\u009f` (DEL and C1 control codes, which standard `JSON.stringify` leaves raw and some terminal emulators interpret as escape sequences; see [Security & Trust Model](../concepts/security-and-trust-model.md)) into `\u007f`–`\u009f` hex escapes:
   ```ts
   const printJson = (value: unknown) =>
     console.log(
       JSON.stringify(value, null, 2).replace(
         /[\u007f-\u009f]/g,
         char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
       ),
     )
   ```
   Human-readable text output and `cliError()` messages similarly sanitize untrusted strings via `terminalSafeText()`.
2. **Error stream separation**: Structured JSON payloads are written exclusively to `stdout`. CLI usage and operational errors emitted via `cliError()` are written to `stderr` prefixed with `Error: `.
3. **Status inspection in `--json` mode**:
   - Commands `pack validate`, `pack doctor`, `resolve`, and `status` set `process.exitCode = 1` even when `--json` is passed if errors or drift are present.
   - Target mutation commands (`install`, `uninstall`, `update`, `reconcile`) with `--json` emit the structured [`ChangeResult`](../modules/target-installer.md) summary and exit `0` when planning/execution finishes normally—automation consumers should inspect the JSON `status` field (`"applied"`, `"noop"`, `"dry-run"`, `"declined"`, `"failed"`) alongside the process exit code.
   - `source auth --json` emits the authentication status object (`{ authenticated: boolean, ... }`) and exits `0`; check `authenticated` in the JSON payload.

---

## Related Pages

- [Getting Started](../getting-started.md)
- [System Architecture](../architecture.md)
- [OpenCode Pack Contract 1.1 Reference](./pack-contract-reference.md)
- [Launcher, Build & Self-Update](../modules/launcher-and-build.md)
- [Pack Lifecycle & Target Safety](../concepts/pack-lifecycle-and-target-safety.md)
- [Conditional Routing & Archetypes](../concepts/conditional-routing-and-archetypes.md)
- [Cross-Harness Pack Translation](../concepts/cross-harness-translation.md)
- [User Settings, Target State & Environment Variables](../config/user-and-target-files.md)
