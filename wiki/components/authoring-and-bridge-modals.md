---
title: "Authoring, Tuning & Bridge Modals"
description: "Modal components for batch parameter tuning, Pack Doctor & scaffolding, Contract 1.1 onboarding, and bridge tier configuration"
category: "components"
source_files:
  - "src/ui/ParameterTuningModal.tsx"
  - "src/ui/PackDoctorModal.tsx"
  - "src/ui/PackOnboardingModal.tsx"
  - "src/ui/BridgeModal.tsx"
  - "src/utils/bridgePrompt.ts"
created: "2026-11-13"
last_updated: "2026-11-13"
---

# Authoring, Tuning & Bridge Modals

The [OpenTUI](../dependencies/runtime-and-tooling-stack.md) modal suite in `src/ui/` provides interactive overlays for batch-editing agent frontmatter parameters, diagnosing and scaffolding [OpenCode Contract `1.1`](../api/pack-contract-reference.md) *[packs]* (see [Glossary](../glossary.md)), onboarding un-manifested local or remote Git repositories, and configuring [translation bridges](../concepts/cross-harness-translation.md) to Claude Code and Codex. Each modal computes deterministic terminal geometry from `termWidth` and `termHeight`, sanitizes rendered strings with [`terminalSafeText`](../concepts/security-and-trust-model.md), and delegates state mutations to parent handlers in [`src/App.tsx`](./tui-shell-and-catalog.md).

## Key Files

| File | Role |
|------|------|
| `src/ui/ParameterTuningModal.tsx` | Single-agent and batch frontmatter tuning overlay (`steps`, `variant`, `mode`, `hidden`) plus deterministic pill wrapping (`chunkPillsByWidth`). |
| `src/ui/PackDoctorModal.tsx` | Dual-tab pack maintenance dialog combining Contract `1.1` health checks, auto-fixes, Authoring Kit setup, semver bumps, and V2 resource scaffolding. |
| `src/ui/PackOnboardingModal.tsx` | Guided Contract `1.1` pack initialization wizard supporting `root` vs. `subpack` layouts and clone-and-onboard flows for read-only Git sources. |
| `src/ui/BridgeModal.tsx` | Adaptive two-column/compact modal for configuring Claude Code and Codex model tiers, role mappings, and bridge plugin generation. |
| `src/utils/bridgePrompt.ts` | Pure state, pack filtering, field stepping, draft validation, and live per-agent model resolution preview helpers backing `BridgeModal`. |

---

## `ParameterTuningModal`

Defined in `src/ui/ParameterTuningModal.tsx` and rendered when `viewMode === "parameter-tuning"`, `ParameterTuningModal` edits four [OpenCode V2 agent parameters](../modules/agent-editing-and-v2-compat.md) across one selected agent, an entire pack folder, or a multi-select batch:

1. **Max Steps (`steps`)**: Maximum tool-call turns (`number`, positive integer).
2. **Thinking / Effort (`variant`)**: Model `#variant` preset (e.g., model-specific variants from the verified catalog or `KNOWN_MODEL_VARIANTS`, with `""` representing `default`).
3. **Execution Mode (`mode`)**: Segmented selector over `AGENT_TUNING_MODES` (`"primary"`, `"subagent"`, `"all"`).
4. **Visibility (`hidden`)**: Positive segmented toggle between `Visible` (`hidden: false`) and `Hidden` (`hidden: true`).

### Props Interface

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `targetCount` | `number` | yes | Number of agents targeted by the tuning session. |
| `singleTargetName` | `string` | no | Filename displayed when `targetCount === 1` (`.md` suffix stripped). |
| `focusedField` | `TuningField` | yes | Currently active card: `"steps" \| "variant" \| "mode" \| "hidden"`. |
| `dirtyFields` | `ReadonlySet<TuningField>` | yes | Tracks explicitly modified fields so untouched fields are preserved during batch saves. |
| `summary` | `TuningInitialState` | yes | Per-field baseline inspection (`value`, `mixed`, `distinctValues`) across target agents. |
| `steps` | `string` | yes | Draft numeric string for `steps`. |
| `variant` | `string` | yes | Draft variant string (`""` for default/unset). |
| `mode` | `AgentTuningMode` | yes | Draft execution mode (`"primary" \| "subagent" \| "all"`). |
| `hidden` | `boolean` | yes | Draft visibility flag (`false` = Visible, `true` = Hidden). |
| `variantChoices` | `readonly string[]` | yes | Ordered variant options starting with `""` (`default`). |
| `hasModelSpecificVariants` | `boolean` | yes | Indicates whether `variantChoices` came from verified model metadata (`model presets`) vs. generic `#variant` choices. |
| `termWidth` / `termHeight` | `number` | yes | Terminal viewport dimensions used to toggle compact borderless cards on short screens. |
| `onFocusField` | `(field: TuningField) => void` | yes | Focuses a parameter card on click or keyboard navigation. |
| `onStepDelta` | `(delta: number) => void` | yes | Adjusts `steps` by `delta` (used by mouse `−5` / `+5` buttons). |
| `onSelectVariant` | `(variant: string) => void` | yes | Selects a variant pill and marks `"variant"` dirty. |
| `onSelectMode` | `(mode: AgentTuningMode) => void` | yes | Selects an execution mode pill and marks `"mode"` dirty. |
| `onSelectHidden` | `(hidden: boolean) => void` | yes | Selects `Visible` or `Hidden` and marks `"hidden"` dirty. |
| `onSave` / `onClose` | `() => void` | yes | Commits dirty fields (`Enter`) or cancels (`Esc` / backdrop click). |

### Mixed-State Detection in Batch Mode

When tuning multiple agents whose existing frontmatter values differ, `inspectTuningTargets` populates `summary.<field>.mixed = true` and `summary.<field>.distinctValues`. Inside `ParameterTuningModal`, each field computes an untouched-mixed guard:

```tsx
const stepsUntouchedMixed = !dirtyFields.has("steps") && summary.steps.mixed
const variantUntouchedMixed = !dirtyFields.has("variant") && summary.variant.mixed
const modeUntouchedMixed = !dirtyFields.has("mode") && summary.mode.mixed
const hiddenUntouchedMixed = !dirtyFields.has("hidden") && summary.hidden.mixed
```

While a field remains untouched and mixed:
- **Max Steps** suppresses the `gaugeBar` and displays `mixed (<distinctValues>)` in muted text instead of a single number.
- **Thinking / Effort** displays `mixed (<distinctValues>)` in the card header and leaves all variant pills unselected.
- **Execution Mode** and **Visibility** append a `mixed` label next to the field title and suppress active pill highlighting.
- Header status shows `unchanged fields stay as-is` until the user modifies at least one field, after which `● N modified` appears and only `dirtyFields` are passed to `buildTuningUpdateParams`.

### Balanced Pill Wrapping (`chunkPillsByWidth`)

OpenTUI requires deterministic row counts to size bordered containers without clipping. `chunkPillsByWidth` wraps variant pills across rows while preventing two visual defects: lone orphaned pills on the final row and line-break jitter when the 2-cell active `● ` indicator moves between short and long labels.

```ts
export function chunkPillsByWidth<T extends string>(
  options: readonly PillOption<T>[],
  maxWidth: number,
): PillOption<T>[][] {
  if (options.length === 0) return [[]]
  // Reserve 2 cells for the active `● ` marker so cycling selection never shifts line breaks.
  const safeMax = Math.max(10, Math.floor(maxWidth) - 2)
  const measureRow = (slice: readonly PillOption<T>[]) =>
    slice.reduce((sum, opt, idx) => sum + displayWidth(opt.label) + 2 + (idx > 0 ? 1 : 0), 0)

  if (measureRow(options) <= safeMax) return [[...options]]

  // Try balanced k-row partitions (2..N) so rows distribute items evenly without trailing orphans.
  for (let rowCount = 2; rowCount <= options.length; rowCount++) {
    const baseSize = Math.floor(options.length / rowCount)
    const remainder = options.length % rowCount
    // ...
```

If every option fits on one line within `safeMax`, a single row is returned. Otherwise, the helper tests balanced `k`-row partitions (`rowCount = 2..N`) where the first `remainder` rows receive `baseSize + 1` pills and the remaining rows receive `baseSize` pills, returning the smallest `rowCount` whose widest row fits `safeMax`. A greedy width-packing fallback handles edge cases where an individual label exceeds `safeMax`. On short terminals (`termHeight < fullBoxedHeight`, such as `80x18..20`), `ParameterTuningModal` switches `compactCards` to `true`, collapsing 3-row bordered cards into 1-row borderless strips and recomputing `chunkPillsByWidth` for the wider inner width.

### Numeric `steps` Entry & Variant Prefix Typing

Keyboard handling in `src/App.tsx` pairs with `ParameterTuningModal` for fast keyboard-only or mouse-assisted input:
- **`steps` controls**: Typing digits `0–9` appends directly to the draft value (replacing `mixed` on first keystroke); `-`/`_` and `+`/`=` or `←`/`→` step by `±1` (`Shift+←/→` steps by `±10`); mouse pills apply `−5` and `+5`; `Backspace` deletes the last digit; `Delete` or `Ctrl+U` clears the input. When `cardInnerWidth >= 56` and not mixed, a 10-cell `gaugeBar(Math.min(1, parsedSteps / 100), 10)` visualizes the turn budget.
- **`variant` controls**: `←`/`→`/`Space` cycle through `variantChoices`; typing `[a-zA-Z0-9._-]` enters partial-variant typing mode, highlighting matching pills via `isPrefixMatch` (`opt.value.startsWith(variant)`) and snapping to the first/last prefix match on `←`/`→`; `Delete` or `Ctrl+U` resets to `""` (`default`).

### Saving to Local Files vs. Read-Only `overrides.json`

Submitting via `Enter` invokes `submitTuningModal` → `applyAgentMutation` in `src/App.tsx`:
- **Writable local workspace (`!isReadOnlyGitSource`)**: Runs inside a repository transaction (`mutate(paths, "tune", () => updateAgentParams(targetAgents, params))`), writing updated frontmatter directly to the Markdown agent files on disk and optionally auto-committing if enabled.
- **Read-only Git source (`isReadOnlyGitSource`)**: Leaves the cached Git checkout untouched, instead executing `runWithOverrideWriter(workspaceRoot, writer => updateAgentParams(targetAgents, params, writer))` to persist per-agent overrides in [user settings](../modules/routing-and-user-settings.md) ([`overrides.json`](../config/user-and-target-files.md)) and immediately calling `reconcileTargetIfInstalled("override")` to update any [installed target](../modules/target-installer.md).

---

## `PackDoctorModal`

Defined in `src/ui/PackDoctorModal.tsx` and rendered when `viewMode === "pack-doctor"`, `PackDoctorModal` provides a dual-tab authoring and maintenance workbench for local manifested [OpenCode packs](../api/pack-contract-reference.md) (`resolveEditablePackDir` supports both root `opencode-pack.json` repositories and `packs/<name>/` subpacks). On un-manifested [virtual workspaces](../modules/pack-validation-and-virtual-packs.md), attempting to open Pack Doctor redirects automatically to `PackOnboardingModal`; on read-only Git sources, it prompts the user to clone locally first.

### Props & Sizing Helpers

- `getDoctorModalHeight(termHeight)` clamps modal height between `14` and `26` rows depending on terminal height.
- `getDoctorMaxFindingRows(termHeight)` reserves `11` chrome rows and allocates `Math.max(2, modalHeight - 11)` scrollable lines for diagnostic findings.
- `getScaffoldFieldOrder(kind)` returns `["kind", "id", "desc", "mode"]` when `kind === "agent"` and `["kind", "id", "desc"]` for `"skill"` or `"command"`.

| Prop | Type | Description |
|------|------|-------------|
| `tab` | `"doctor" \| "scaffold"` | Active tab; switches border and title accent between cyan (`doctor`) and green (`scaffold`). |
| `report` | `PackDoctorReport \| null` | Validation and authoring ergonomics report from `inspectPackDoctor`. |
| `scrollOffset` | `number` | First visible index in `report.findings`. |
| `statusMessage` | `string \| null` | Confirmation or error banner shown below the tab bar after an action. |
| `scaffoldField` | `"kind" \| "id" \| "desc" \| "mode"` | Focused input row in the `Scaffold` tab. |
| `scaffoldKind` | `"agent" \| "skill" \| "command"` | Selected V2 resource type to scaffold. |
| `scaffoldId` / `scaffoldDesc` | `string` | Draft resource slug/path and description text. |
| `scaffoldMode` | `"primary" \| "subagent" \| "all"` | Agent `mode` frontmatter value (rendered only when `scaffoldKind === "agent"`). |
| `onAutoFix` / `onInstallKit` / `onBumpVersion` | callbacks | Trigger auto-remediation, Authoring Kit installation, or `patch`/`minor`/`major` version bumps. |
| `onSubmitScaffold` | `() => void` | Scaffolds the configured starter resource via `scaffoldPackResource`. |

### `Doctor` Tab (`[D] Contract Doctor`)

The `Doctor` tab inspects `PackDoctorReport` produced by [`inspectPackDoctor`](../modules/pack-onboarding-and-doctor.md):
- **Summary Header**: Displays `Contract <version>`, counts of validated `agents`, `skills`, and `commands`, and Authoring Kit presence (`✓ skill` / `○ skill` for `.opencode/skills/opencode-pack-authoring/SKILL.md` and `✓ CI` / `○ CI` for `.github/workflows/validate-pack.yml`).
- **Findings Viewport**: Scrollable via `↑`/`↓`, `j`/`k`, or mouse wheel (`onMouseScroll`). Findings render severity badges (`✗` red for `error`, `!` amber for `warning`, `◆` cyan for `suggestion`), issue code (`[<code>]`), file path, message, and an `[auto-fix]` suffix when `item.autoFixable` is `true`. Diagnostics cover strict `validatePack` Contract `1.1` errors/warnings alongside authoring checks:
  - Legacy [V1 agent frontmatter](../modules/agent-editing-and-v2-compat.md) keys (`agent-deprecated-key` and `agent-v1-frontmatter` detected via `detectFrontmatterVersion(parsed) === "v1"`).
  - Manifest contract upgrades from `1.0` to `1.1` (`contract-upgrade`) for conditional [`flowDefaults`](../concepts/conditional-routing-and-archetypes.md) support.
  - Missing `archetype` metadata when primary callers and subagents are present (`archetype-missing`), legacy directories (`legacy-directory`), unnamespaced files (`namespace`), disallowed `opencode.json` keys (`config-key`), and missing skill descriptions (`skill-description`).
- **Maintenance Actions**:
  - **`[F] Auto-Fix (N)`**: Runs `fixPackDoctor`, automatically rewriting V1 agent frontmatter to V2, migrating legacy directories/namespaces, upgrading `"contract": "1.0"` to `"1.1"`, or populating inferred `archetype` metadata, then refreshes `report`.
  - **`[A] Authoring Kit`**: Runs `installPackAuthoringKit`, installing the bundled `opencode-pack-authoring` skill and GitHub Actions pack validation workflow.
  - **`[1] +patch` · `[2] +minor` · `[3] +major`**: Header pills (and number keys `1`, `2`, `3`) invoke `bumpPackVersion` to increment `version` in `opencode-pack.json`.

### `Scaffold` Tab (`[N] New Agent / Skill / Cmd`)

Pressing `N` in the `Doctor` tab (or clicking `[N] New Agent / Skill / Cmd`) switches to the resource generator:
- Displays a live OpenCode V2 target path preview:
  - `agent` → `agents/<id>.md`
  - `skill` → `skills/<id>/SKILL.md`
  - `command` → `commands/<id>.md`
- `Tab` / `Shift+Tab` / `↑` / `↓` step through `getScaffoldFieldOrder(scaffoldKind)`.
- `Space` / `←` / `→` cycle `Resource` (`agent`, `skill`, `command`) and `Agent Mode` (`subagent`, `primary`, `all`), while `D` on non-text fields returns to the `Doctor` tab.
- `ID / Slug` accepts `[a-zA-Z0-9._/-]` characters; `Description` accepts printable ASCII; `Enter` calls `scaffoldPackResource`, reloads catalog data, re-runs `inspectPackDoctor`, and shows `✓ Created <relativePath>`.

---

## `PackOnboardingModal`

Defined in `src/ui/PackOnboardingModal.tsx` and rendered when `viewMode === "pack-init"`, `PackOnboardingModal` guides users through turning an un-manifested ("[virtual](../modules/pack-validation-and-virtual-packs.md)") agent directory or remote Git repository into a validated [Contract `1.1`](../api/pack-contract-reference.md) pack. `src/App.tsx` opens this modal automatically once per virtual workspace root (`promptedVirtualRootsRef`) or on demand via `[I] Onboard Pack` / `[I] Clone & Onboard`.

### Discovery Banner & Context Line

At the top of the modal, `PackOnboardingModal` summarizes the [`OnboardingInspection`](../modules/pack-onboarding-and-doctor.md) scan of the target directory:
- **Discovery banner**: Lists discovered agent count (plus `(N V1->V2)` when V1 frontmatter agents are detected), skill count, command count, `.opencode/` presence, count of user-level keys to strip from `opencode.json`, and any `inferredArchetype.reference`.
- **Context line**: Explains whether onboarding will clone a remote Git source (`Remote Git (<label>): clones locally & switches active source`), isolate pack files inside a mixed software project (`Mixed repo (<files>): packs/<name>/ keeps project root clean`), or initialize the local workspace directly.

### Props & Field Order (`getOnboardingFieldOrder`)

`getOnboardingFieldOrder(isRemoteGit)` prepends `"cloneDest"` when onboarding a read-only remote Git source:

```ts
export function getOnboardingFieldOrder(isRemoteGit: boolean): OnboardingField[] {
  return isRemoteGit
    ? ["cloneDest", "name", "version", "desc", "layout", "organize", "kit"]
    : ["name", "version", "desc", "layout", "organize", "kit"]
}
```

| Field | Control Type | Behavior |
|-------|--------------|----------|
| `cloneDest` | Text input (`isRemoteGit` only) | Local filesystem destination directory for cloning the remote Git source before onboarding. |
| `name` | Slug input | Lowercase `[a-z0-9-]` pack slug (capped at 64 chars), defaulting to `derivePackSlug`. |
| `version` | Semver input | Initial pack version string (e.g., `0.1.0`, spaces rejected). |
| `desc` | Text input | Human-readable `description` written to `opencode-pack.json`. |
| `layout` | Toggle pills (`Pack Root`) | Chooses `"root"` (`Root ./`) vs. `"subpack"` (`packs/<slug>/`). Appends `(auto)` to `inspection.recommendedLayout` (`"subpack"` is recommended automatically when application markers such as `package.json`, `Cargo.toml`, or `src/` are detected at root). |
| `organize` | Toggle pills (`Normalize`) | `"V2 + agents/ + archetype"` (`true`) vs. `"Keep in place"` (`false`). When enabled, `applyPackOnboarding` upgrades V1 frontmatter to V2, moves loose agents/skills/commands into canonical `agents/`, `skills/`, and `commands/` directories, backs up non-pack user keys from `opencode.json` into `.opencode/opencode.user-backup.json`, namespaces non-native root directories under `<dir>/<name>/`, and writes inferred `archetype` metadata. |
| `kit` | Toggle pills (`Author Kit`) | `".opencode skill + CI"` (`true`) vs. `"Skip"` (`false`); installs `.opencode/skills/opencode-pack-authoring/SKILL.md` and `.github/workflows/validate-pack.yml`. |

### Local Onboarding vs. Remote Git Clone-and-Onboard

Pressing `Enter` (`onSubmit` → `submitPackOnboarding` in `src/App.tsx`) handles both source types seamlessly:
1. **Remote Read-Only Git Source (`isRemoteGit === true`)**: Calls `cloneGitSourceForOnboarding({ source, destDir: initCloneDest, registry })`, which clones the remote repository to `destDir`, registers the new writable local source in [`sources.json`](../modules/sources-and-github.md), runs `applyPackOnboarding` on the local clone, refreshes the sources registry, and calls `switchToDataSource` so the TUI immediately switches its [active workspace](./workspaces-flows-and-sources.md) to the newly onboarded local repository.
2. **Local Directory (`isRemoteGit === false`)**: Runs `applyPackOnboarding` directly on `workspaceRoot`, reloads workspace data (`refreshData()`), and opens the `action-result` summary showing created manifest details, moved files, backed-up user config keys, installed kit files, and Contract `1.1` validation status.

---

## `BridgeModal` & `bridgePrompt` Utilities

`BridgeModal` (`src/ui/BridgeModal.tsx`) and its companion state module `src/utils/bridgePrompt.ts` provide the interactive UI (`viewMode === "bridge-prompt"`) for [translating an OpenCode pack](../concepts/cross-harness-translation.md) into either a **Claude Code plugin** (`target === "claude"`, output under `bridges/claude-code/<plugin>/`) or a **Codex translation layer** (`target === "codex"`, output under `bridges/codex/<plugin>/`). Note that while the [headless CLI](../api/cli-reference.md) (`manage-agents bridge`) accepts `--target claude-code|codex|both`, `--prefix`, `--no-register`, and `--force`, the interactive `BridgeModal` operates on a single selected `TranslationTarget` (`"claude"` or `"codex"`), derives the stripped agent prefix automatically via `deriveBridgePrefix(selectedPack)` (`<pack>-`), and honors `claude.autoValidate` and `claude.autoRegister` from [`TranslationConfig`](../config/translation-and-release-config.md).

### Adaptive Terminal Layout (`calculateBridgeModalLayout`)

`calculateBridgeModalLayout(termWidth, termHeight, { packExpanded, tierCount })` switches between two distinct responsive layouts at the `termWidth >= 96 && termHeight >= 26` threshold:

| Mode | Trigger | Geometry & Structure |
|------|---------|----------------------|
| **Wide Two-Column Split** (`wide: true`) | `termWidth >= 96 && termHeight >= 26` | Up to `112×32` centered box. **Left column** (`48%` inner width) renders rounded bordered cards for `Plugin Name`, filterable `Pack` selector, `Tiers` editor, `Map all to` catch-all override, and source/output path footers. **Right column** (`52%` inner width) renders a full-height bordered `Pack '<pack>' Mapping` table with tier count summary badges and pagination counter (`i/N`). |
| **Compact Single-Column Stack** (`wide: false`) | Terminals narrower than `96` cols or shorter than `26` rows (e.g., `80×24`) | Expands to `w - 4` by `h - 2` with zero vertical padding and borderless 1-row sections (`Plugin Name`, collapsible `Pack` list, `Tiers` rows, `Map all to`, and `Mapping` preview) so every control and at least `2` agent preview rows remain visible without clipping. |

Border and highlight accents adapt per harness: `#FF6B35` (Claude orange) when `target === "claude"` and `THEME.accentBlue` when `target === "codex"`. Unsaved tier or role edits append `" *"` to the modal title (`tiersDirty`).

### Field Focus Cycle & Pack Filtering (`src/utils/bridgePrompt.ts`)

`stepBridgeField(current, reverse, target)` governs `Tab` / `Shift+Tab` cycling across modal sections, inserting the Codex-only `"effort"` stop when `target === "codex"`:
- **Claude Code order**: `"name"` → `"pack"` → `"tiers"` → `"agents"` → `"model"`
- **Codex order**: `"name"` → `"pack"` → `"tiers"` → `"effort"` → `"agents"` → `"model"`

Pack selection helpers in `src/utils/bridgePrompt.ts`:
- `collectBridgeablePacks(agents, isPackValid)` counts agents per category, filters valid packs, and sorts `"general"` last via `comparePackCategories`.
- `resolveInitialBridgePack` pre-selects the currently focused [catalog](./tui-shell-and-catalog.md)/[flows](./workspaces-flows-and-sources.md) pack when opening the modal (marking it `· current`).
- When `focusedField === "pack"`, the pack row switches into a live filter `<input>` backed by `reconcileBridgePackQuery` (preserving the current selection if it still matches `packQuery`) and `stepBridgePackSelection` (`↑`/`↓` cyclic scrolling with `clampListScroll`).

### Inline Tier Editing (`planning`, `execution`, `light`)

Default tiers in `DEFAULT_TRANSLATION_CONFIG` (`src/utils/translationConfig.ts`) define `"planning"` (purple), `"execution"` (cyan), and `"light"` (green), with custom tier names rendered in amber:

- **Claude Code (`target === "claude"`)**: Each tier row displays `CLAUDE_TIER_MODEL_PRESETS` (`["opus", "sonnet", "haiku", "inherit"]`) as clickable pills. Pressing `←`/`→`/`Space` cycles presets via `cyclePresetValue`; typing `[a-zA-Z0-9._-]` switches into custom model entry (rendering an active `● <custom-model>` pill), validated against `validateClaudeModelName` before saving.
- **Codex (`target === "codex"`)**: Focusing `"tiers"` turns the selected tier's model column into a live `<input>` for editing the Codex model ID (e.g., `gpt-5.6-sol`, `gpt-5.6-luna`). Pressing `Tab` advances focus to `"effort"`, highlighting the right-hand `reasoningEffort` pill where `←`/`→`/`Space` (or clicking the pill) cycles `CODEX_EFFORT_PRESETS` (`["low", "medium", "high", "xhigh", "max"]`).
- **Catch-all Override (`focusedField === "model"`)**: Entering a model in `Map all to:` sets `config[target].modelMap["*"]`, overriding tier mapping for every agent in that target harness when non-empty.

### Live Per-Agent Model Resolution Preview

`buildPackBridgePreview(agents, baseConfig, options)` in `src/utils/bridgePrompt.ts` recomputes the right-hand mapping table live whenever `selectedPack`, `tiers`, `roles`, or `modelCatchAll` changes:

```ts
const prefix = deriveBridgePrefix(pack)
const draftConfig = applyBridgeDraftToConfig(baseConfig ?? DEFAULT_TRANSLATION_CONFIG, {
  target,
  tiers,
  roles,
  pack,
  modelCatchAll,
})
const index = buildInferenceIndex(packAgents, draftConfig)
```

For each agent in `selectedPack`, `resolveModelTarget(agent, index, draftConfig, target)` resolves its role, effective tier, target model (plus `:reasoningEffort` on Codex), and provenance source. `BridgeModal` renders each row as:

```text
  <strippedName>                        [<tier>] → <model(:effort)> <srcTag>
```

where `<srcTag>` maps `BridgeAgentMappingItem["source"]` via `shortSourceLabel`:
- `ovr` (`"override"`, amber): Explicit per-agent override in `config[target].overrides`.
- `map` (`"model-map"`, amber): Matched `config[target].modelMap` (including `"*"` catch-all).
- `role` (`"role"`, secondary): Explicit role-to-tier entry in `config.roles`.
- `inf` (`"inferred"`, muted): Inferred from sibling agents sharing the same OpenCode model via `buildInferenceIndex`.
- `def` (`"default"`, muted): Fell back to `config.defaultTier`.

Focusing the `agents` panel (`↑`/`↓` to select an agent, `←`/`→`/`Space` or clicking `[<tier>]`) calls `cycleAgentRoleTier`, reassigning `roles[item.role]` across available tiers and immediately updating every preview row that shares that role.

### `Ctrl+S` Standalone Tier Save vs. `Enter` Full Bridge Generation

`BridgeModal` separates translation-config tuning from full bridge emission:
- **`Ctrl+S` (`onSaveTiers` → `saveBridgeTiersOnly`)**: Validates draft tiers with `validateDraftBridgeTiers(bridgeDraftTiers, bridgeTarget)`, merges only `tiers` and `roles` via `applyBridgeDraftToConfig`, writes `bridge.config.json` (in the workspace transaction for local repos, or `sourceTranslationConfigLocation` for read-only [Git sources](../modules/sources-and-github.md)), clears `tiersDirty`, and keeps `BridgeModal` open with a confirmation toast (`✓ Saved bridge tier configuration`).
- **`Enter` (`onSubmit` → `generateBridge`)**: Requires a non-empty `Plugin Name` and valid `selectedPack`, validates tiers and optional `Map all to` model override, persists the complete `TranslationConfig` (including `pluginName`, `prefix: "<pack>-"`, and `modelMap["*"]`), and runs [`bridgePack`](../modules/bridges.md) to emit files under `bridges/claude-code/<plugin>/` or `bridges/codex/<plugin>/` (or the per-source bridge cache for Git sources). When bridging to Claude Code, `generateBridge` additionally runs `validatePlugin` (unless `claude.autoValidate === false`) and, if validation succeeds and a marketplace manifest was emitted, invokes `registerPlugin` (unless `claude.autoRegister === false`) before presenting the full summary in `action-result`.

---

## Related Pages

- [TUI Shell, Catalog Tree & Inspector](./tui-shell-and-catalog.md)
- [Flows & Data Sources Workspaces](./workspaces-flows-and-sources.md)
- [Command Palette, Help & Markdown View](./navigation-help-and-markdown.md)
- [Pack Onboarding, Doctor & Scaffolding](../modules/pack-onboarding-and-doctor.md)
- [Agent Editing, V2 Compatibility & Git Transactions](../modules/agent-editing-and-v2-compat.md)
- [Claude Code & Codex Bridges](../modules/bridges.md)
- [Cross-Harness Pack Translation](../concepts/cross-harness-translation.md)
- [Bridge Translation & Release Config Reference](../config/translation-and-release-config.md)
