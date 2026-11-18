---
title: "Getting Started"
description: "Installation, Node/Bun runtime requirements, CLI and TUI quickstart, and contributor test/validation workflow"
category: "root"
source_files:
  - "package.json"
  - "manage-agents.mjs"
  - "src/build.mjs"
  - "tsconfig.json"
  - "README.md"
  - "GUIDA.md"
  - ".github/workflows/ci.yml"
  - "test/helpers.ts"
created: "2026-11-13"
last_updated: "2026-11-17"
---

# Getting Started

[`manage-agents`](./overview.md) is a catalog-agnostic [CLI](./api/cli-reference.md) and [terminal UI (TUI)](./components/tui-shell-and-catalog.md) engine for validating, resolving, editing, routing, and installing OpenCode agent *[packs]* (see [Glossary](./glossary.md)) from local directories or git repositories.

## Runtime Prerequisites

### JavaScript Runtime

You need **one** of the following runtimes (`package.json` `engines`):

- **Node.js `>=26.4.0`**: Required because the terminal interface ([`@opentui/core` `0.5.7`](./dependencies/runtime-and-tooling-stack.md)) relies on Node's native Foreign Function Interface (`--experimental-ffi`). You do not need to pass the flag manually—when [`manage-agents.mjs`](./modules/launcher-and-build.md) runs under Node, it validates the runtime version (`>= 26.4.0`) and automatically re-executes `process.execPath` with `--experimental-ffi` and `--no-warnings=ExperimentalWarning` if either flag is missing from `process.execArgv`. On Windows (`win32`), the launcher also pins the console codepage to UTF-8 (`chcp 65001`).
- **Bun `>=1.3.0`**: Supported natively as an alternative runtime. When `process.versions.bun` is present, `manage-agents.mjs` skips the Node version check and `--experimental-ffi` re-execution.

### Required and Optional External CLIs

| CLI | Requirement | Purpose |
|-----|-------------|---------|
| `git` | Required | Cloning and pulling git pack sources, release ancestry checks, and optional [scoped workspace auto-commits](./modules/agent-editing-and-v2-compat.md) (`git config user.name` and `user.email` must be set when `--auto-commit` or `AGENT_MANAGER_AUTO_COMMIT=1` is enabled). |
| `opencode` | Optional | Queries `opencode models` to populate the live `provider/model` catalog in the TUI model picker and model validation checks. |
| `gh` | Optional | Powers [`manage-agents source login`](./modules/sources-and-github.md) (`gh auth login --web`), `source auth`, private GitHub repository discovery, and token-free HTTPS pulls via `gh auth git-credential` (credentials are never stored in `sources.json`). |
| `claude` | Optional | Used by [`manage-agents bridge`](./modules/bridges.md) to run `claude plugin validate --strict` and register translated Claude Code plugins in user scope (unless disabled via `--no-validate` / `--no-register`). |

## Installation and Updating

### Installing from Source (Git Clone)

Clone the repository, install dependencies, and optionally link the `manage-agents` binary onto your `PATH`:

```bash
git clone https://github.com/lorecanc/manage-agents.git manage-agents && cd manage-agents
npm ci            # or: bun install
npm link          # optional: exposes `manage-agents` globally on PATH
```

You can invoke the tool via `manage-agents` (if linked), `./manage-agents.mjs`, `node manage-agents.mjs`, `bun manage-agents.mjs`, or `npm start`.

### Installing from GitHub Releases

For pushes of `v*` tags, CI publishes a [prebuilt `manage-agents-<tag>.tar.gz` archive](./modules/launcher-and-build.md) and `release-metadata.json`; it attaches `release-metadata.json.sig` when that file is generated. The release job runs only after the test job passes and checks that the tagged commit is an ancestor of `origin/main`. It builds and stages `dist/` in the archive, so the published archive includes the prebuilt `dist/index.js` bundle. See [release signing](./config/translation-and-release-config.md) for signing configuration.

### Automatic Dependency Install and Build on Launch

[`manage-agents.mjs`](./modules/launcher-and-build.md) makes source checkouts self-bootstrapping on first launch and across branch switches:

1. **Dependency check**: Unless [`MANAGE_AGENTS_SKIP_AUTO_INSTALL=1`](./config/user-and-target-files.md) is set in the environment, `manage-agents.mjs` inspects `node_modules` against `package.json` (`dependencies`, plus `devDependencies` when `src/` exists and a build is required). If any package is missing or outside its semver range, it runs:
   - Under Node.js: `npm ci --ignore-scripts --no-audit --no-fund` (when `package-lock.json` is present) or `npm install --ignore-scripts --no-audit --no-fund`.
   - Under Bun: `bun install --frozen-lockfile --ignore-scripts` (when `bun.lock` is present) or `bun install --ignore-scripts`.
2. **Stale bundle rebuild**: When `src/` exists (a git checkout), `manage-agents.mjs` compares the modification time of `dist/index.js` against `package.json` and every file under `src/`. Whenever `dist/index.js` is missing or older than the sources, it runs `npm run build` (or `bun run build`) before importing `dist/index.js`.
3. **Disabling auto-install**: Export `MANAGE_AGENTS_SKIP_AUTO_INSTALL=1` in offline, air-gapped, or controlled CI environments to skip automatic package installation.

### Checking Version and Self-Updating

Inspect the active engine version and release metadata:

```bash
manage-agents version          # aliases: --version, -v, -V (add --json for machine output)
```

Update an existing `manage-agents` installation from `v*` GitHub Releases:

```bash
manage-agents self-update --check    # check for newer releases without modifying files
manage-agents self-update            # alias: manage-agents update --self
```

[`self-update`](./modules/launcher-and-build.md) checks `v*` GitHub Releases and verifies the archive SHA-256 and inner bundle hash, plus the Ed25519 signature when [`release-signing.json`](./config/translation-and-release-config.md) is configured. It updates the engine and reconciles the [router plugin](./modules/runtime-router-plugin.md) across managed targets by default; `--no-reconcile` disables reconciliation. Use `--yes` / `-y` for non-interactive confirmation; `--reconcile`, `--force`, `--repo <owner/repo>`, and `--json` are also available.

## CLI Quickstart

[Every subcommand](./api/cli-reference.md) supports `--help` for full flag documentation.

### 1. Register a Pack Source

Authenticate with GitHub (optional, needed for private repositories) and [register a pack catalog](./modules/sources-and-github.md) from a GitHub `owner/repo` slug, git URL (`https:` or `ssh:`), or local directory:

```bash
manage-agents source login
manage-agents source add lorecanc/agents --pull
```

Sources are recorded in [`$XDG_CONFIG_HOME/manage-agents/sources.json`](./config/user-and-target-files.md), and remote git checkouts are cached read-only under `$XDG_CACHE_HOME/manage-agents/sources/<name>`.

### 2. List and Validate Packs

Inspect packs offered by your registered sources (including [virtual packs](./modules/pack-validation-and-virtual-packs.md) synthesized from manifest-free `.md` agent folders or `.opencode/` project configs) and validate local pack directories against the [contract](./api/pack-contract-reference.md):

```bash
manage-agents pack list
manage-agents pack validate contract/examples/minimal-pack
manage-agents pack validate ./my-pack --git --json
```

Use `manage-agents resolve <pack>...` to preview [dependency resolution (`requires`)](./modules/resolver-and-lock.md), install order, [executable surfaces](./concepts/security-and-trust-model.md), and required confirmations without writing to disk.

### 3. Install, Inspect, and Reconcile an OpenCode Target

By default, target commands operate on [`$XDG_CONFIG_HOME/opencode`](./config/user-and-target-files.md) (`~/.config/opencode`). Pass `--target <dir>` to manage an alternate OpenCode configuration directory:

```bash
manage-agents install flow pipeline        # resolve and install packs (--dry-run to preview, --yes to confirm)
manage-agents status                       # prints "In sync." when installed files match the lock
manage-agents reconcile                    # regenerate managed opencode.json keys, router plugin, and user overrides
manage-agents update                       # pull sources and upgrade installed packs to latest versions
```

Target operations are [journaled transactions](./modules/target-installer.md): unmanaged keys in `opencode.json` are preserved, [conflicts with user-owned files](./concepts/pack-lifecycle-and-target-safety.md) are reported prior to writing (`--adopt` backs up and replaces them under `<target>/.manage-agents/backups/<id>/`, and `manage-agents restore <backup-id>` rolls back).

### 4. Onboard an Existing Agent Folder

Convert a raw agent folder, `.opencode/` config, or registered git source into a compliant [Contract `1.1` pack](./api/pack-contract-reference.md):

```bash
manage-agents pack onboard ./my-agents --authoring-kit
```

[`pack onboard`](./modules/pack-onboarding-and-doctor.md) (alias `pack init`) migrates [legacy OpenCode V1 frontmatter to native V2 fields](./modules/agent-editing-and-v2-compat.md), infers [`archetype` declarations](./concepts/conditional-routing-and-archetypes.md), nests under `packs/<name>/` automatically when mixed application files sit at the repository root (`--layout auto|root|subpack`), and with `--authoring-kit` scaffolds `.opencode/skills/opencode-pack-authoring/` plus a GitHub Actions validation workflow.

## Launching the Interactive TUI

Running `manage-agents` (or `npm start`) with no subcommand starts the [interactive OpenTUI interface](./components/tui-shell-and-catalog.md). How it opens depends on context and flags:

1. **Local Workspace (`--workspace <dir>`)**:
   ```bash
   manage-agents --workspace ./path/to/catalog-or-pack
   ```
   Also selected automatically when `$MANAGE_AGENTS_WORKSPACE` is set or when you run `manage-agents` inside a directory containing `opencode-pack.json` or `packs/*/opencode-pack.json`. Edits modify pack files on disk directly.
2. **Registered Source (`--source <name>`)**:
   ```bash
   manage-agents --source agents
   ```
   Opens a registered local or git source. When viewing a git/GitHub source, model assignments and frontmatter edits made in the TUI are saved to [`$XDG_CONFIG_HOME/manage-agents/routing.json` and `overrides.json`](./modules/routing-and-user-settings.md) and reconciled into your OpenCode target without modifying the cached git checkout.
3. **No Arguments Outside a Workspace (Data Sources Screen)**:
   ```bash
   manage-agents
   ```
   Outside a local workspace, `manage-agents` opens your active registered source—or, if none is attached yet, launches directly into the **[Data Sources](./components/workspaces-flows-and-sources.md)** screen where you can log in via `gh`, clone/attach a GitHub repository or local directory, pull updates, and manage source trust. Press `o` at any time from the main TUI view to reopen Data Sources.

### Essential TUI Controls

- `→` / `l` and `←` / `h`: Expand or collapse a pack folder in the tree.
- `↑` / `↓` or `j` / `k`: Move selection (or scroll inspector tabs 2, 4, 5, and 6).
- `/`: Filter agents by file name (`Enter` keeps filter, `Esc` clears).
- `m`: Assign models (on an agent) or edit [conditional `IF / OR` routing flows](./concepts/conditional-routing-and-archetypes.md) (on a pack folder).
- `t`: [Tune agent parameters](./components/authoring-and-bridge-modals.md) (`steps`, `variant`, `mode`, `hidden`).
- `u`: Configure allowed/denied skills, custom tool families, and MCP servers.
- `e`: Dry-run preview and install the focused pack into OpenCode.
- `i` / `d`: Onboard a virtual pack (`i`) or open [Pack Doctor](./modules/pack-onboarding-and-doctor.md) (`d`) to auto-fix contract drift.
- `b` / `Shift-B`: Open the [Claude Code (`b`) or Codex (`Shift-B`) bridge](./concepts/cross-harness-translation.md) modal.
- `Ctrl-C`: Quit.

## Contributor Development and Verification Workflow

### Build, Typecheck, and Test Scripts

`tsconfig.json` configures [TypeScript](./dependencies/runtime-and-tooling-stack.md) (`ES2022`, `moduleResolution: "NodeNext"`, `jsx: "react-jsx"`, `noEmit: true`) across `src/**/*.ts`, `src/**/*.tsx`, and `test/**/*.ts`. Bundling is handled separately by [`src/build.mjs` via `esbuild`](./modules/launcher-and-build.md), which bundles `src/index.tsx` into ESM `dist/index.js` targeting Node while keeping `@opentui/core` and `yaml` external.

| Command | Underlying Execution | Purpose |
|---------|----------------------|---------|
| `npm run typecheck` | `tsc --noEmit` | Typechecks all source and test TypeScript/TSX files without emitting JS. |
| `npm test` | `npm run typecheck && node --experimental-ffi --no-warnings=ExperimentalWarning --import tsx --test "src/utils/*.test.ts" "runtime/**/*.test.mjs"` | Runs `tsc --noEmit` followed by Node's built-in `node:test` runner across core TypeScript utilities and the [V2 router plugin](./modules/runtime-router-plugin.md) `.mjs` suite. |
| `npm run build` | `node src/build.mjs` | Bundles `src/index.tsx` to `dist/index.js` with `esbuild`. |
| `npm run validate` | `npm test && npm run build && node manage-agents.mjs pack validate contract/examples/minimal-pack` | Full pre-commit verification gate: typecheck, unit tests, production bundle build, and end-to-end CLI validation against the reference minimal pack. |

Always run `npm run validate` before finishing any code or contract change.

### Writing Tests with `test/helpers.ts`

Unit and integration tests live alongside modules in `src/utils/*.test.ts` (and `runtime/**/*.test.mjs`) and use shared fixture builders from `test/helpers.ts`:

```ts
import test from "node:test"
import { makePack, tempDir, writePack, BASE_MANIFEST } from "../../test/helpers.js"

test("validates a minimal synthetic pack", (t) => {
  const packDir = makePack(
    t,
    { "agents/demo-helper.md": "---\ndescription: Demo helper\nmode: subagent\n---\nPrompt body.\n" },
    { name: "demo", version: "1.1.0" },
  )
  // packDir contains opencode-pack.json merged over BASE_MANIFEST and is removed automatically via t.after()
})
```

- `BASE_MANIFEST`: Default `{ contract: "1.0", name: "demo", version: "1.0.0", description: "demo pack" }` object.
- `tempDir(t, prefix?)`: Allocates an isolated directory in `os.tmpdir()` and registers recursive cleanup with `t.after(...)`.
- `writePack(dir, files, manifest?)`: Writes relative `files` into `dir` and writes `opencode-pack.json` merged over `BASE_MANIFEST` (pass `null` for `manifest` to test manifest-free directories).
- `makePack(t, files, manifest?)`: Convenience wrapper combining `tempDir` and `writePack`.

### Continuous Integration (`.github/workflows/ci.yml`)

GitHub Actions runs two jobs defined in `.github/workflows/ci.yml`:

1. **`test` (Push and Pull Request Matrix)**:
    Executes across `ubuntu-latest`, `macos-latest`, and `windows-latest`, checking both supported runtimes on every operating system:
    - **Node.js 26**: Runs `npm ci --ignore-scripts`, `npm run validate` (typecheck + `node:test` suites + `esbuild` bundle + `minimal-pack` validation), `node manage-agents.mjs --help`, and `node manage-agents.mjs --version`.
    - **Bun**: Runs `bun install --ignore-scripts`, `bun run typecheck`, `bun run build`, and `bun manage-agents.mjs --help`.
2. **`release` (Tag Pushes `refs/tags/v*`)**:
    Runs on `ubuntu-latest` only after `test` passes. It verifies that the tagged commit is an ancestor of `origin/main`, builds `dist/` on Node.js 26, writes the embedded engine version manifest (`version --write-manifest`), packages `manage-agents-<tag>.tar.gz`, runs `release sign`, and publishes the archive and `release-metadata.json` with `gh release create`. The `.sig` asset is included only when present. This describes the workflow; it does not prescribe additional manual release steps.

## Related Pages

- [Project Overview](./overview.md) — Core domain concepts, capabilities, and repository directory map
- [System Architecture](./architecture.md) — Layered architecture, target safety invariants, and runtime data flows
- [CLI Command Reference](./api/cli-reference.md) — Complete flag and subcommand reference for `manage-agents`
- [TUI Shell, Catalog Tree & Inspector](./components/tui-shell-and-catalog.md) — Guide to the interactive OpenTUI interface, workspaces, and keyboard navigation
- [Launcher, Build & Self-Update](./modules/launcher-and-build.md) — Internals of `manage-agents.mjs`, auto-bundling, and Ed25519-verified self-updates
