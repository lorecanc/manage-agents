---
title: "Bridge Translation & Release Config Reference"
description: "Configuration reference for bridges/translation-config.json, release-signing.json, and engine release manifests"
category: "config"
source_files:
  - "src/utils/translationConfig.ts"
  - "src/utils/selfUpdate.ts"
  - "src/index.tsx"
  - "src/utils/engineVersion.ts"
  - "manage-agents.mjs"
  - ".github/workflows/ci.yml"
created: "2026-11-13"
last_updated: "2026-11-18"
---

# Bridge Translation & Release Config Reference

`manage-agents` uses JSON configuration and manifest files across two operational workflows: translating OpenCode *[packs]* (see [Glossary](../glossary.md)) into Claude Code or Codex bridge layers (`bridges/translation-config.json`; see [Cross-Harness Pack Translation](../concepts/cross-harness-translation.md)), and verifying engine releases and self-updates (`release-signing.json`, `.manage-agents/release-manifest.json`, and `release-metadata.json`; see [Launcher, Build & Self-Update](../modules/launcher-and-build.md)).

## Bridge Translation Config (`bridges/translation-config.json`)

Implemented in `src/utils/translationConfig.ts` (with Git-source path resolution in `src/utils/sourceCustomization.ts`), the translation configuration controls how OpenCode agents, models, skills, commands, and MCP servers are mapped when generating [Claude Code plugins or Codex layers](../modules/bridges.md) from the [CLI](../api/cli-reference.md) or [Authoring, Tuning & Bridge Modals](../components/authoring-and-bridge-modals.md).

### File Locations and Path Resolution

Where `manage-agents` reads and writes translation settings depends on whether the active catalog is a writable local directory or a cached Git source:

| Context | Read Precedence | Write Path | Bridge Output Directory |
|---------|-----------------|------------|-------------------------|
| Local workspace or local source | `--config <path>` (CLI) or `<workspace>/bridges/translation-config.json` | `--config <path>` (CLI) or `<workspace>/bridges/translation-config.json` | `--output <dir>` or `<workspace>/bridges/<claude-code\|codex>/<pluginName>` |
| Registered Git source (TUI) | 1. `$XDG_CONFIG_HOME/manage-agents/translations/<source>/translation.json`<br>2. `<workspace>/.agent-manager/translation.json` (legacy read fallback) | `$XDG_CONFIG_HOME/manage-agents/translations/<source>/translation.json` | `$XDG_CACHE_HOME/manage-agents/bridges/<source>/<claude-code\|codex>/<pluginName>` |

When `XDG_CONFIG_HOME` or `XDG_CACHE_HOME` is unset, `engineConfigDir()` and `engineCacheDir()` fall back to `~/.config/manage-agents` and `~/.cache/manage-agents`, respectively (see [User Settings, Target State & Environment Variables](./user-and-target-files.md)).

Path safety and migration rules enforced by `loadTranslationConfig()` and `saveTranslationConfig()`:

- **Symlink and containment checks**: Config files must not be symlinks (`lstatSync`), and their resolved real paths must stay inside the target base root (`workspaceRoot` for local workspaces, or the per-source `configRoot` under `translations/<source>` for Git sources).
- **Missing file behavior**: If the file does not exist on disk, `loadTranslationConfig()` returns `DEFAULT_TRANSLATION_CONFIG` normalized and validated in memory without writing a file until an explicit save occurs.
- **v1 automatic migration**: Files with `version: 1` or an omitted `version` are upgraded in memory by `migrateV1()` to `version: 2` (`claude.primaryModel` and `codex.modelMapping.primary` or `opus` map to `tiers.planning`; `claude.defaultSubagentModel` and `codex.modelMapping.default` map to `tiers.execution`; v1 wildcard `modelMap` and `exact` entries are discarded with a stderr warning). Direct calls to `loadTranslationConfig()` persist the migrated v2 file by default (`persistMigration: true`), whereas passive CLI/TUI reads pass `{ persistMigration: false }`. Any other `version !== 2` throws `unsupported config version`.

### Schema Reference (v2)

#### Top-Level Fields (`TranslationConfig`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | `2` | Yes | `2` | Schema version literal. Must be `2`. |
| `target` | `"claude" \| "codex"` | Yes | `"claude"` | Default bridge target used when `--target` is omitted on the CLI. |
| `pluginName` | `string` | Yes | `"decent-pipeline"` | Generated plugin or layer name (sanitized for filesystem output). |
| `prefix` | `string` | Yes | `"pipeline-"` | Prefix stripped from agent filenames (after `.md` removal) to compute normalized role/agent names. Also used by `manage-agents bridge` to infer `--pack` (`prefix.replace(/-$/, "")`) when `--pack` is omitted. |
| `sourceDir` | `string` | Yes | `"general"` | Legacy pre-pack agent directory. Validated as a workspace-relative path (`isWorkspaceRelativePath`), ignored by pack bridges. |
| `inference` | `boolean` | No | `true` | Enables automatic tier inference (`buildInferenceIndex`) from sibling agents' source models when an agent's role is absent from `roles`. |
| `defaultTier` | `string` | Yes | `"execution"` | Fallback tier key when no override, `modelMap` entry, explicit `roles` mapping, or unambiguous inferred tier applies. Must exist in `tiers`. |
| `tiers` | `Record<string, TranslationTier>` | Yes | `planning`, `execution`, `light` | Named cross-target model tiers merged deeply with `DEFAULT_TIERS`. Must contain at least one tier. |
| `roles` | `Record<string, string>` | Yes | 10 built-in role mappings | Maps normalized agent names (`normalizeAgentName(filename, prefix)`) to keys in `tiers`. Merged shallowly with `DEFAULT_ROLES`. |
| `claude` | `object` | Yes | See below | Claude Code target overrides, model mappings, marketplace metadata, and emission flags. |
| `codex` | `object` | Yes | See below | Codex target overrides, model mappings, and emission flags. |

#### Tier Definitions (`tiers.<name>`)

Every entry in `tiers` must define non-empty `claude.model` and `codex.model` strings:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | `string` | No | Human-readable summary of the tier's purpose. |
| `claude.model` | `string` | Yes | Target Claude model alias (`fable`, `sonnet`, `opus`, `haiku`, `inherit`) or full `claude-*` model ID. |
| `claude.reasoningEffort` | `string` | No | Optional reasoning effort hint on `ModelTarget`. |
| `codex.model` | `string` | Yes | Target Codex model ID (for example, `"gpt-5.6-sol"` or `"gpt-5.6-luna"`). |
| `codex.reasoningEffort` | `string` | No | Optional Codex reasoning effort level (for example, `"high"` or `"max"`). |

Built-in `DEFAULT_TIERS`:

| Tier | `claude.model` | `codex.model` | `codex.reasoningEffort` | Description |
|------|----------------|---------------|-------------------------|-------------|
| `planning` | `"opus"` | `"gpt-5.6-sol"` | `"high"` | Agents that reason, plan and review |
| `execution` | `"sonnet"` | `"gpt-5.6-luna"` | `"max"` | Agents that execute tasks, cheaper and faster |
| `light` | `"haiku"` | `"gpt-5.6-luna"` | `"max"` | Agents that do lightweight work (claude haiku; codex parity with execution) |

#### Role Mappings (`roles`) and Tier Inference (`inference`)

`resolveRole()` normalizes each agent's filename by taking `path.basename(filename)`, stripping a trailing `.md` suffix, stripping `config.prefix` if present, and lowercasing the result (for example, `agents/pipeline-code_reviewer.md` with `prefix: "pipeline-"` resolves to `"code_reviewer"`). `roles` keys are exact normalized role names (not regular expressions), and every value must reference a valid key in `tiers`.

Built-in `DEFAULT_ROLES`:

- **`planning`**: `orchestrator`, `planner`, `reasoner`, `critic`, `code_reviewer`
- **`execution`**: `refactorer`, `tester`, `fast_lane`
- **`light`**: `executor`, `explorer`

When an agent's normalized role is not present in `roles` and `inference !== false`, `buildInferenceIndex()` indexes all agents that *do* have a valid `roles` assignment by both their lowercased full source model (`provider/model`) and bare model ID (the substring after the last `/`). If a source model maps to **exactly one** tier across indexed agents, `resolveModelTarget()` assigns that tier with `source: "inferred"`; if multiple tiers share the same model, inference abstains and falls back to `defaultTier`.

#### Claude Target Settings (`claude`)

| Field | Type | Default | Validation / Behavior |
|-------|------|---------|-----------------------|
| `overrides` | `Record<string, ModelTarget>` | `{}` | Per-agent `{ model, reasoningEffort? }` overrides keyed by normalized agent name. Highest priority during model resolution. |
| `modelMap` | `Record<string, string>` | `{}` | Maps normalized source models (`provider/model`, bare `model`, or `"*"` catch-all) to Claude model names. Every value must match `/^(fable\|sonnet\|opus\|haiku\|inherit)$\|^claude-[a-z0-9][a-z0-9.-]*$/`. |
| `emitMarketplace` | `boolean` | `true` | Emit local Claude Code marketplace metadata alongside the generated plugin. |
| `emitCommands` | `boolean` | `true` | Emit translated slash commands. |
| `emitSkills` | `boolean` | `true` | Emit translated skills. |
| `autoValidate` | `boolean` | `true` | Run `claude plugin validate` automatically after generating a Claude plugin (see [Runtime & Tooling Dependencies](../dependencies/runtime-and-tooling-stack.md)). |
| `autoRegister` | `boolean` | `true` | Register the generated plugin/marketplace with the local `claude` CLI when validation passes. |
| `marketplaceName` | `string` | `<pluginName>-local` | Optional custom marketplace identifier (`resolveMarketplaceName`). Must match `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`. Exact names `"claude"` and `"claude-code"`, and prefixes `"claude-"`, `"anthropic-"`, and `"anthropics-"`, are reserved and rejected. |

#### Codex Target Settings (`codex`)

| Field | Type | Default | Validation / Behavior |
|-------|------|---------|-----------------------|
| `overrides` | `Record<string, ModelTarget>` | `{}` | Per-agent `{ model, reasoningEffort? }` overrides keyed by normalized agent name. CLI `--codex-map source=target[:effort]` parses missing effort as `"max"`. |
| `modelMap` | `Record<string, string>` | `{}` | Maps normalized source models (`provider/model`, bare `model`, or `"*"` catch-all) to non-empty Codex model names. |
| `emitSkills` | `boolean` | `true` | Include translated skills in the generated Codex plugin. |
| `emitReadme` | `boolean` | `true` | Generate a `README.md` inside the Codex output directory. |
| `emitMcp` | `boolean` | `undefined` (enabled) | Treated as enabled unless explicitly set to `false` (`config.codex.emitMcp !== false`); writes `.mcp.json` and links `mcpServers` in the Codex manifest when MCP servers are present. |

#### Model Resolution Precedence and Author Override

For each bridged agent, `resolveModelTarget(agent, index, config, target)` evaluates candidates in strict order:

1. **`override`**: `config[target].overrides[normalizedAgentName]`
2. **`model-map`**: `config[target].modelMap` checked by lowercased full `provider/model`, then lowercased bare `model`, then `"*"`
3. **`role`**: `config.tiers[config.roles[role]][target]`
4. **`inferred`**: Unambiguous tier from `buildInferenceIndex()` when `config.inference !== false`
5. **`default`**: `config.tiers[config.defaultTier][target]` (or the first key in `config.tiers` if `defaultTier` were missing prior to validation)

Generated plugin manifests and READMEs also stamp an author name resolved by `authorName()`: `"Lorenzo Cancellara"` by default (`DEFAULT_AUTHOR_NAME`), overridable via the `AGENT_AUTHOR_NAME` environment variable if it matches `/^[\p{L}\p{N} '’.\-]{1,100}$/u`.

### Annotated Example (`bridges/translation-config.json`)

```json
{
  "version": 2,
  "target": "claude",
  "pluginName": "decent-pipeline",
  "prefix": "pipeline-",
  "sourceDir": "general",
  "inference": true,
  "defaultTier": "execution",
  "tiers": {
    "planning": {
      "description": "Agents that reason, plan and review",
      "claude": { "model": "opus" },
      "codex": { "model": "gpt-5.6-sol", "reasoningEffort": "high" }
    },
    "execution": {
      "description": "Agents that execute tasks, cheaper and faster",
      "claude": { "model": "sonnet" },
      "codex": { "model": "gpt-5.6-luna", "reasoningEffort": "max" }
    },
    "light": {
      "description": "Agents that do lightweight work (claude haiku; codex parity with execution)",
      "claude": { "model": "haiku" },
      "codex": { "model": "gpt-5.6-luna", "reasoningEffort": "max" }
    }
  },
  "roles": {
    "orchestrator": "planning",
    "planner": "planning",
    "reasoner": "planning",
    "critic": "planning",
    "code_reviewer": "planning",
    "executor": "light",
    "explorer": "light",
    "refactorer": "execution",
    "tester": "execution",
    "fast_lane": "execution",
    "security_auditor": "planning"
  },
  "claude": {
    "overrides": {
      "docs_grounding": { "model": "haiku" }
    },
    "modelMap": {
      "anthropic/claude-opus-4-6": "opus",
      "*": "sonnet"
    },
    "emitMarketplace": true,
    "emitCommands": true,
    "emitSkills": true,
    "autoValidate": true,
    "autoRegister": true,
    "marketplaceName": "decent-pipeline-local"
  },
  "codex": {
    "overrides": {
      "reasoner": { "model": "gpt-5.6-sol", "reasoningEffort": "max" }
    },
    "modelMap": {
      "gpt-5.4": "gpt-5.6-luna"
    },
    "emitSkills": true,
    "emitReadme": true,
    "emitMcp": true
  }
}
```

---

## Release Signing Trust Policy (`release-signing.json`)

Implemented in `src/utils/selfUpdate.ts` (see [Launcher, Build & Self-Update](../modules/launcher-and-build.md)), `<engineRoot>/release-signing.json` (`RELEASE_SIGNING_CONFIG_FILENAME`) defines the repository identity and trusted Ed25519 public keys used by `manage-agents self-update` (`update --self`) and `manage-agents release sign` (see [CLI Command Reference](../api/cli-reference.md)).

`release-signing.json` is optional as a file, but the default trust policy requires signatures. If neither it nor `MANAGE_AGENTS_RELEASE_PUBLIC_KEY` (see [User Settings, Target State & Environment Variables](./user-and-target-files.md)) supplies a public key, self-update fails because signature verification is required by default but has no trusted key. SHA-256-only verification is an explicit opt-in via `--allow-unsigned`, `MANAGE_AGENTS_ALLOW_UNSIGNED=1`, or the API's `requireSignature: false` option; it still verifies release metadata, archive size and digest, and the embedded `.manage-agents/release-manifest.json` bundle hash. Once any public key is configured, signature verification is mandatory and cannot be disabled with the unsigned override, under the engine's [Security & Trust Model](../concepts/security-and-trust-model.md).

### On-Disk Schema (`ReleaseSigningConfig`)

`release-signing.json` must be a regular file (symlinks are rejected) conforming to `ReleaseSigningConfig`:

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `schemaVersion` | `1` | Yes | Must equal `1`. |
| `repository` | `string` | Yes | GitHub `owner/repo` slug matching `/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/`. |
| `algorithm` | `"ed25519"` | Yes | Must equal `"ed25519"`. |
| `publicKeys` | `ReleaseSigningKeyEntry[]` | Yes | Array of trusted Ed25519 public keys (may be empty, though keygen populates at least one). |
| `publicKeys[].keyId` | `string` | Yes | Derived identifier matching `/^ed25519-[0-9a-f]{12}$/`, computed as `ed25519-` + first 12 hex chars of SHA-256 over the SPKI DER public key (`computePublicKeyId`). Must match `publicKey`; duplicates are rejected. |
| `publicKeys[].publicKey` | `string` | Yes | Ed25519 public key in SPKI PEM format (`-----BEGIN PUBLIC KEY-----...`). |
| `publicKeys[].createdAt` | `string` | Yes | ISO-8601 timestamp (`YYYY-MM-DDTHH:mm:ss[.sss](Z\|±HH:mm)`). |

Example `release-signing.json` generated by `manage-agents release keygen`:

```json
{
  "schemaVersion": 1,
  "repository": "lorecanc/manage-agents",
  "algorithm": "ed25519",
  "publicKeys": [
    {
      "keyId": "ed25519-4a8f19c02d7e",
      "publicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----\n",
      "createdAt": "2026-11-13T10:00:00.000Z"
    }
  ]
}
```

### Runtime Trust Policy Resolution and Environment Overrides

`resolveReleaseTrustPolicy()` combines `release-signing.json`, CLI flags, and environment variables into a runtime `ReleaseTrustPolicy` (`{ repository, requireSignature, publicKeys }`):

- **Automatic `requireSignature` derivation**: `requireSignature` is not a JSON field in `release-signing.json`. Any configured public key forces it to `true`; with no keys, it is `options.requireSignature ?? !allowUnsigned`, where `allowUnsigned` is enabled by the API option or `MANAGE_AGENTS_ALLOW_UNSIGNED=1`. The default is therefore `true`, and a required signature with no public key is a configuration error rather than a fallback to SHA-256. Whenever a key is trusted, unsigned releases or missing `release-metadata.json.sig` assets are rejected even if the unsigned override is set.
- **Key rotation and revocation**: There is no separate `revokedKeyIds` array. Rotating keys appends a new entry to `publicKeys` via `manage-agents release keygen`, and revoking old keys removes them via `manage-agents release keygen --replace-keys` (written atomically with mode `0644`, while the generated PKCS#8 private key defaults to `.release-key.pem` with mode `0600`).
- **`MANAGE_AGENTS_RELEASE_PUBLIC_KEY`**: Injects a trusted Ed25519 public key from the environment as either SPKI PEM (supporting literal newlines or `\n` escapes) or base64-encoded SPKI DER. Its `keyId` is computed automatically; if `publicKeys` already contains the same `keyId` with a different key, resolution aborts with a collision error. Setting this variable makes `publicKeys` non-empty and enforces `requireSignature: true` even when `release-signing.json` does not exist on disk.
- **`MANAGE_AGENTS_REPO`**: Overrides the release `repository` (`owner/repo`) when `--repo` is not passed on the CLI. Repository precedence is `--repo` -> `MANAGE_AGENTS_REPO` -> `release-signing.json#repository` -> `package.json#repository` -> `"lorecanc/manage-agents"`.
- **`RELEASE_SIGNING_PRIVATE_KEY`**: Read by `manage-agents release sign` when `--private-key-file` is omitted. Expects an Ed25519 PKCS#8 PEM private key whose derived public key matches an entry in `publicKeys` (when `publicKeys` is non-empty). A private key can produce a signature when no public key is configured, but it does not itself establish client trust; clients still need the corresponding public key in `release-signing.json` or `MANAGE_AGENTS_RELEASE_PUBLIC_KEY`.

---

## Engine Release Manifests

Release integrity relies on two manifest files (implemented in [Launcher, Build & Self-Update](../modules/launcher-and-build.md)) that bind the GitHub Release assets to the exact runtime files extracted on disk:

1. **`.manage-agents/release-manifest.json`** (`EngineReleaseManifest` in `src/utils/engineVersion.ts`): Embedded *inside* the release tarball and installed engine directory to fingerprint the runtime bundle.
2. **`release-metadata.json`** and **`release-metadata.json.sig`** (`EngineReleaseMetadata` in `src/utils/selfUpdate.ts`): Published *alongside* the tarball as GitHub Release assets to authenticate the archive before extraction.

### Embedded Manifest (`.manage-agents/release-manifest.json`)

Produced by `writeEngineReleaseManifest()` via `manage-agents version --write-manifest`:

```bash
node manage-agents.mjs --no-auto-commit version --write-manifest \
  --ref-type <tag|branch> \
  --ref-name <name> \
  --sha <sha> \
  [--engine-root <dir>] [--json]
```

#### Schema (`EngineReleaseManifest`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `1` | Yes | Must equal `1`. |
| `version` | `string` | Yes | `<tag>` when `channel === "release"`, or `sha-<shortCommit>-dirty` when `channel === "ci-snapshot"`. |
| `packageVersion` | `string` | Yes | Semver string read from `<engineRoot>/package.json` (`"0.0.0"` fallback). |
| `tag` | `string \| null` | Yes | Safe tag string (`/^(v?[0-9A-Za-z._-]+)$/`) when `--ref-type tag`; `null` otherwise. |
| `commit` | `string` | Yes | Full 40-character lowercase hexadecimal Git commit SHA (7–40 hex input is resolved via `git rev-parse` when `.git` exists). |
| `shortCommit` | `string` | Yes | First 7 characters of `commit`. |
| `dirty` | `boolean` | Yes | `false` when `channel === "release"`, `true` when `channel === "ci-snapshot"`. |
| `channel` | `"release" \| "ci-snapshot"` | Yes | `"release"` for `--ref-type tag`; `"ci-snapshot"` for branch/non-tag builds. (At runtime, `resolveEngineVersion()` can also report `"git-tag"`, `"git"`, or `"package"` when no matching manifest applies.) |
| `bundleHash` | `string` | Yes | `sha256:<64-hex>` digest computed by `computeEngineBundleHash()`. |
| `builtAt` | `string` | Yes | ISO-8601 build timestamp. |
| `appliedOverGitHead` | `string` | No | 40-char lowercase hex `HEAD` stamped by `stampAppliedEngineManifest()` when `self-update` installs a release over an existing Git checkout. |
| `appliedWorktreeStateHash` | `string` | No | `sha256:<64-hex>` of `git status --porcelain=v1 -z` (excluding `.manage-agents/`) stamped after `self-update`, allowing `resolveEngineVersion()` to report a clean `"release"` channel unless worktree files are modified later. |

`computeEngineBundleHash()` hashes sorted, length-prefixed POSIX relative paths and byte contents across `package.json`, `package-lock.json`, `bun.lock`, `manage-agents.mjs`, `README.md`, `GUIDA.md`, `LICENSE`, `.gitignore`, `dist/index.js`, `assets/**`, `contract/**`, `runtime/**` (excluding `*.test.*`), and `src/**` (if present, excluding `*.test.*`), ignoring symlinks, `.log`, `.DS_Store`, `Thumbs.db`, and excluded directories (`node_modules`, `.git`, `dist`, `build`, `.manage-agents`, `.agent-manager`, `.opencode`, `artifacts`, `backups`, `coverage`, `.cache`).

The trust configuration is separate from the runtime bundle fingerprint: `release-signing.json` is not an input to `computeEngineBundleHash()` and is not among `applyEngineUpdate()`'s replacement targets, so a locally provisioned trust file survives an update and does not change the embedded bundle hash. The GitHub `release-metadata.json` and `.sig` are separate release assets, not inputs to the tarball's embedded manifest.

### GitHub Release Metadata (`release-metadata.json` & `.sig`)

Produced by `signReleaseAssets()` via `manage-agents release sign`:

```bash
node manage-agents.mjs --no-auto-commit release sign \
  --tag <tag> \
  --sha <sha> \
  --assets-dir <dir> \
  [--repo <owner/repo>] [--private-key-file <file>] [--allow-unsigned] [--engine-root <dir>] [--json]
```

`signReleaseAssets()` locates `<assets-dir>/manage-agents-<tag>.tar.gz`, computes its byte length and SHA-256 digest, and writes `release-metadata.json`. When a private key is supplied via `--private-key-file` or `RELEASE_SIGNING_PRIVATE_KEY`, the key must match a configured trusted key if `publicKeys` is non-empty; the exact UTF-8 metadata bytes are signed with Node's one-shot Ed25519 `crypto.sign(null, metadataBytes, privateKey)`, and the 64-byte signature is written as base64 (plus trailing newline) to `release-metadata.json.sig`. Without a private key, the command fails under the default signature-required policy; when the resolved trust policy has no trusted keys, an explicitly allowed unsigned release records `signed: false` and `algorithm: "sha256"`. A signed metadata asset is useful to clients only when they have the matching public key configured.

#### Schema (`EngineReleaseMetadata`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `1` | Yes | Must equal `1`. |
| `repository` | `string` | Yes | GitHub `owner/repo` slug; must match the verifier's resolved trust policy repository. |
| `tag` | `string` | Yes | Release tag (`[0-9A-Za-z._-]+`); must match the GitHub Release `tag_name`. |
| `commit` | `string` | Yes | 40-character lowercase hexadecimal commit SHA. |
| `builtAt` | `string` | Yes | ISO-8601 timestamp. |
| `signed` | `boolean` | Yes | `true` when signed with an Ed25519 private key; `false` in unsigned SHA-256 mode. |
| `algorithm` | `"ed25519" \| "sha256"` | Yes | `"ed25519"` when `signed` is `true`, `"sha256"` when `signed` is `false`. |
| `keyId` | `string` | Conditional | Required when `signed` is `true` (`ed25519-<12-hex>`); omitted when unsigned. |
| `archive.name` | `string` | Yes | Expected archive filename: `manage-agents-<tag>.tar.gz`. |
| `archive.size` | `number` | Yes | Positive safe integer byte size of `manage-agents-<tag>.tar.gz`. |
| `archive.sha256` | `string` | Yes | `sha256:<64-hex>` digest of `manage-agents-<tag>.tar.gz`. |

### CI Release Packaging and Self-Update Verification (`.github/workflows/ci.yml`)

In `.github/workflows/ci.yml`, pushes matching `refs/tags/v*` trigger the `release` job on `ubuntu-latest` after the `test` matrix (`ubuntu-latest`, `macos-latest`, `windows-latest` across Node 26 and Bun) succeeds:

1. **Ancestry gate**: Fetches `origin/main` and runs `git merge-base --is-ancestor "$TARGET_SHA" refs/remotes/origin/main` so tags outside `main` cannot publish releases.
2. **Clean build and staging**: Runs `npm ci --ignore-scripts` and `npm run build`, exports tracked sources with `git archive --format=tar HEAD` into `artifacts/release-stage/manage-agents-${TAG_NAME}`, and copies `dist/` into the staged directory.
3. **Embedded manifest & archive creation**: Runs `manage-agents version --write-manifest --ref-type tag --ref-name "$TAG_NAME" --sha "$TARGET_SHA" --engine-root "$stage_dir"`, touches `$stage_dir/dist/index.js` so `manage-agents.mjs` never sees a stale bundle timestamp relative to `src/`, and archives `artifacts/release-assets/manage-agents-${TAG_NAME}.tar.gz`.
4. **Metadata signing & publication**: Runs `manage-agents release sign --tag "$TAG_NAME" --sha "$TARGET_SHA" --assets-dir "$out_dir" --repo "$REPO_SLUG"` with `RELEASE_SIGNING_PRIVATE_KEY: ${{ secrets.RELEASE_SIGNING_PRIVATE_KEY }}`, then publishes the tarball, `release-metadata.json`, and (when present) `release-metadata.json.sig` via `gh release create "$TAG_NAME" ... --verify-tag --generate-notes`. The signing secret must be present for the default signature-required policy; if a public key is configured in the staged engine, the secret's key must match it. The CI command does not opt into unsigned releases. Signing with the secret alone does not provision the corresponding public key to self-update clients.

When a user later runs `manage-agents self-update`, `checkForEngineUpdate()` and `applyEngineUpdate()` verify the full chain before replacing engine files:

1. Fetch `release-metadata.json` (and `release-metadata.json.sig` when present or required) via `gh api` (with HTTPS API fallback; see [Sources & GitHub Integration](../modules/sources-and-github.md)) and verify `repository`, `tag`, and the Ed25519 signature against `resolveReleaseTrustPolicy()`.
2. Download `manage-agents-<tag>.tar.gz` and verify its exact byte length (`archive.size`) and SHA-256 digest (`archive.sha256`) before extraction.
3. Extract into a `0700` temporary directory, reject any symlinks or path traversal entries (`assertNoSymlinkTree()`; see [Security & Trust Model](../concepts/security-and-trust-model.md)), check required engine targets (`manage-agents.mjs`, `package.json`, `dist`, `assets`, `contract`, `runtime`), and call `validateStagedEngineManifest()` to confirm `.manage-agents/release-manifest.json` matches `metadata.tag`, `metadata.commit`, `channel === "release"`, `dirty === false`, and `computeEngineBundleHash(stagedRoot) === manifest.bundleHash`.
4. Stage dependency updates if `package.json` or lockfiles changed, back up existing engine files for rollback on failure, copy staged files into place, stamp `.manage-agents/release-manifest.json` (`stampAppliedEngineManifest()`), verify `resolveEngineVersion()`, and [reconcile installed OpenCode targets](../modules/target-installer.md) when needed. Update detection compares the release tag with the installed version resolved from the manifest, Git, or package metadata; a matching clean release/tag (or matching package semver) is a no-op, while an older semantic release is a downgrade. Applying over uncommitted engine changes or downgrading requires `--force`; in the normal CLI flow this bypasses only those local/version guards, not release metadata, archive, or manifest integrity checks.

## Related Pages

- [User Settings, Target State & Environment Variables](./user-and-target-files.md) — XDG user configs, Git source cache layout, target `.manage-agents/` state files, and environment variables
- [Claude Code & Codex Bridges](../modules/bridges.md) — Implementation of Claude Code plugin and Codex layer translation pipelines
- [Cross-Harness Pack Translation](../concepts/cross-harness-translation.md) — Design principles behind model tier mapping, tool translation, and dual-harness output
- [Authoring, Tuning & Bridge Modals](../components/authoring-and-bridge-modals.md) — Interactive TUI modals that edit `TranslationConfig` and run bridges
- [Launcher, Build & Self-Update](../modules/launcher-and-build.md) — Engine version resolution, release signing, and atomic self-update internals
- [Security & Trust Model](../concepts/security-and-trust-model.md) — Cryptographic release verification, symlink protection, and trust boundaries
- [CLI Command Reference](../api/cli-reference.md) — Usage for `manage-agents bridge`, `version`, `release`, and `self-update`
