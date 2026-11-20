import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import React from "react"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { App } from "./App.js"
import { fetchModels, loadModelCatalog } from "./utils/models.js"
import { analyzeAgentName, renameAgent, auditSecurityPermissions, buildTuningUpdateParams, updateAgentParams, parseTuneCliArgs, resolveAllowedTuneVariants, sanitizeFilename, KNOWN_MODEL_VARIANTS } from "./utils/agents.js"
import {
  DEFAULT_TRANSLATION_CONFIG,
  loadTranslationConfig,
  normalizeTranslationConfig,
  parseKeyValueMappings,
  saveTranslationConfig,
  translationConfigPath,
  validateMarketplaceName,
  type TranslationConfig,
  type TranslationTarget
} from "./utils/translationConfig.js"
import { AUTO_COMMIT_MESSAGES, isRepositoryLocalPath, repositoryTransaction, parseAutoCommitArgs } from "./utils/repositoryTransaction.js"
import { loadUiConfig } from "./utils/uiConfig.js"
import { discoverPackDirs, hasErrors, MANIFEST_FILE, PACK_NAME_RE, validatePack, type PackValidation } from "./utils/packs.js"
import { manifestName, packDir, readManifest } from "./utils/catalog.js"
import { addSource, deriveSourceName, discoverAllPacks, findSource, loadSources, pullSource, redactUrlCredentials, removeSource, saveSources, sourceRevision, sourceRoot, type Source } from "./utils/sources.js"
import { inspectGhAuth, runGhWebLogin } from "./utils/github.js"
import { describeExecutable, parsePackRequest, resolvePacks } from "./utils/resolver.js"
import { buildLock, confirmationsNeeded, defaultTarget, diffLocks, readLock } from "./utils/lock.js"
import { changeTarget, installChange, reconcileChange, restoreBackup, targetStatus, uninstallChange, updateChange, type ChangeResult } from "./utils/installer.js"
import { exportFlowsToPackManifest } from "./utils/archetypes.js"
import { describeConfiguredPackFlows, sourceBridgeOutputDir, sourceTranslationConfigLocation, standaloneBridgeKey } from "./utils/sourceCustomization.js"
import { CONFIG_SECTIONS, loadOverrideSettings, loadRoutingSettings, removeConfigEntry, saveOverrideSettings, saveRoutingSettings, scopeOf, setConfigOverride, setOverride, setPackCallers, setPackRules, setRoutes, unsetConfigOverride, unsetOverride, unsetRoutes, type ConfigSection } from "./utils/userSettings.js"
import { parseTriggerList, validateConditionalRule, type ConditionalPolicy, type DelegationEffect, type PolicyEffect } from "./utils/values.js"
import { isVirtualPackRoot } from "./utils/virtualPacks.js"
import {
  applyPackOnboarding,
  bumpPackVersion,
  cloneGitSourceForOnboarding,
  fixPackDoctor,
  inspectPackDoctor,
  resolveEditablePackDir,
  scaffoldPackResource,
  suggestCloneDestination,
  type OnboardingLayout,
  type ScaffoldResourceKind,
  type SemverReleaseKind,
} from "./utils/packOnboarding.js"
import YAML from "yaml"
import { isPathInsideWorkspace, realpathThroughExistingAncestor } from "./utils/pathValidation.js"
import { terminalSafeText } from "./utils/terminalText.js"
import { describeChangeResult, formatLockChange } from "./utils/changeReport.js"
import { claudeNextSteps } from "./utils/claudeNextSteps.js"
import { registerPlugin, validatePlugin } from "./utils/claudePluginCli.js"
import { resolveEngineRoot, resolveEngineVersion, writeEngineReleaseManifest } from "./utils/engineVersion.js"
import {
  applyEngineUpdate,
  checkForEngineUpdate,
  generateReleaseSigningKeypair,
  signReleaseAssets,
} from "./utils/selfUpdate.js"
import type { BridgeResult } from "./utils/bridge.js"
import { codexNextSteps, type CodexBridgeResult } from "./utils/codexBridge.js"

function repositoryMutation<T>(workspaceRoot: string, plan: string[] | { localPaths: string[]; externalPaths?: string[] }, message: string, mutation: () => T): T {
  const result = repositoryTransaction(workspaceRoot, plan, message, mutation)
  if (result.warning) console.error(`AUTO-COMMIT WARNING: ${result.warning.message}\n${result.warning.recovery}`)
  return result.value
}

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  )
}

export function askConfirmation(
  query: string,
  defaultYes = true,
  io: { stdin: typeof process.stdin; stdout: typeof process.stdout } = process
): Promise<boolean> {
  const { stdin, stdout } = io
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    return new Promise((resolve) => {
      stdout.write(query)
      stdin.setRawMode(true)

      const onKey = (data: Buffer) => {
        for (const key of data.toString("utf8")) {
          if (key !== "\u0003" && key !== "\u0004" && key !== "\r" && key !== "\n" && key !== "y" && key !== "Y" && key !== "n" && key !== "N") continue

          stdin.removeListener("data", onKey)
          stdin.setRawMode(false)
          stdin.pause()

          if (key === "\u0003" || key === "\u0004") {
            stdout.write("\n")
            resolve(false)
          } else if (key === "\r" || key === "\n") {
            stdout.write("\n")
            resolve(defaultYes)
          } else {
            stdout.write(`${key}\n`)
            resolve(key.toLowerCase() === "y")
          }
          return
        }
      }

      stdin.on("data", onKey)
      stdin.resume()
    })
  }

  return askQuestion(query).then((answer) => {
    const normalizedAnswer = answer.toLowerCase()
    const isYes = normalizedAnswer === "y" || normalizedAnswer === "yes"
    return defaultYes ? answer === "" || isYes : isYes
  })
}

async function runCreate(workspaceRoot: string) {
  console.log(`\n✨ Create New Agent (Naming Convention: [family-]pack-role_with_underscores)`)
  console.log("------------------------------------------")

  const singlePack = fs.existsSync(path.join(workspaceRoot, MANIFEST_FILE))
  const packs = singlePack ? [] : [...discoverPackDirs(workspaceRoot)].map(manifestName).filter(name => name !== null).sort()
  if (!singlePack && !packs.length) throw new Error("Onboard a pack before creating an agent")
  const familyInput = await askQuestion("1. 🏷  Family (Optional, e.g. go, mistral, hybrid - press enter to skip): ")
  let categoryInput = singlePack ? String(readManifest(workspaceRoot).name) : ""
  while (!singlePack && !packs.includes(categoryInput)) {
    categoryInput = (await askQuestion(`2. 📦 Pack (${packs.join(", ")}): `)).trim()
  }

  let roleInput = ""
  while (!roleInput) {
    roleInput = await askQuestion("3. 🛠  Role (Required, e.g. code_reviewer, orchestrator, html_writer): ")
  }

  const cleanFamily = familyInput.trim().toLowerCase()
  const cleanCategory = categoryInput.trim().toLowerCase()
  const cleanRole = roleInput.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_")

  const filename = cleanFamily
    ? `${cleanFamily}-${cleanCategory}-${cleanRole}.md`
    : `${cleanCategory}-${cleanRole}.md`

  const safeFilename = sanitizeFilename(filename)
  const agentsDir = path.join(packDir(workspaceRoot, cleanCategory) ?? workspaceRoot, "agents")
  const targetPath = path.join(agentsDir, safeFilename)
  if (targetPath === agentsDir || !isPathInsideWorkspace(agentsDir, targetPath)) {
    throw new Error(`Invalid agent path: ${safeFilename}`)
  }

  if (fs.existsSync(targetPath)) {
    console.error(`\nError: Agent file already exists at ${targetPath}`)
    process.exit(1)
  }

  const description = await askQuestion("\n📝 Enter agent description: ")

  // Fetch models for selection list
  let models: string[] = []
  models = fetchModels()
  if (models.length === 0) throw new Error("Model catalog unavailable; cannot create an agent without a verified model")

  console.log("\n🤖 Select an LLM model:")
  models.forEach((model, idx) => {
    console.log(`  [${idx + 1}] ${model}`)
  })

  let modelIndex = 0
  while (true) {
    const answer = await askQuestion(`Enter number (1-${models.length}) [1]: `)
    if (answer === "") {
      modelIndex = 0
      break
    }
    const idx = parseInt(answer, 10) - 1
    if (idx >= 0 && idx < models.length) {
      modelIndex = idx
      break
    }
    console.log("Invalid selection. Please try again.")
  }

  const selectedModel = models[modelIndex]

  // Write file
  const frontmatter = `---
description: ${JSON.stringify(description)}
mode: subagent
model: ${selectedModel}
---

# ${filename.replace(/\.md$/, "")}

Write agent instructions and prompts here.
`

  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true })
  }
  // The agents/ directory must really be the pack's: a link would place the new agent outside it.
  if (fs.lstatSync(agentsDir).isSymbolicLink() || !isPathInsideWorkspace(fs.realpathSync(workspaceRoot), fs.realpathSync(agentsDir))) {
    throw new Error(`${agentsDir} must be a directory of the workspace, not a link`)
  }

  repositoryMutation(workspaceRoot, [targetPath], AUTO_COMMIT_MESSAGES.create, () => fs.writeFileSync(targetPath, frontmatter, { encoding: "utf-8", flag: "wx" }))

  console.log("\n------------------------------------------")
  console.log(`🎉 Agent successfully created!`)
  console.log(`  File:     ${path.relative(workspaceRoot, targetPath)}`)
  console.log(`  Family:   ${cleanFamily || "(none)"}`)
  console.log(`  Pack:     ${cleanCategory}`)
  console.log(`  Role:     ${cleanRole}`)
  console.log(`  Model:    ${selectedModel}`)
}

async function askWithDefault(question: string, fallback: string): Promise<string> {
  const answer = await askQuestion(`${question} [${fallback}]: `)
  return answer || fallback
}

async function runTranslationWizard(
  workspaceRoot: string,
  current: TranslationConfig,
  configPath?: string,
  persist = true
): Promise<TranslationConfig> {
  console.log("\n🧭 Translation bridge configuration wizard")
  console.log("   This writes only a bridge config layer; source agents are not changed.\n")

  const targetAnswer = (await askWithDefault("Target (claude/codex)", "claude")).toLowerCase()
  if (targetAnswer !== "claude" && targetAnswer !== "codex") {
    throw new Error("Target must be 'claude' or 'codex'.")
  }
  const pluginName = await askWithDefault("Plugin name", current.pluginName)
  const prefix = await askWithDefault("Source prefix to strip", current.prefix)

  const next = normalizeTranslationConfig({ ...current, target: targetAnswer as TranslationTarget, pluginName, prefix })
  const planningClaude = await askWithDefault("Claude planning tier model", next.tiers.planning.claude.model)
  const executionClaude = await askWithDefault("Claude execution tier model", next.tiers.execution.claude.model)
  const planningCodex = await askWithDefault("Codex planning tier model", next.tiers.planning.codex.model)
  const executionCodex = await askWithDefault("Codex execution tier model", next.tiers.execution.codex.model)
  next.tiers = {
    ...next.tiers,
    planning: { ...next.tiers.planning, claude: { ...next.tiers.planning.claude, model: planningClaude }, codex: { ...next.tiers.planning.codex, model: planningCodex } },
    execution: { ...next.tiers.execution, claude: { ...next.tiers.execution.claude, model: executionClaude }, codex: { ...next.tiers.execution.codex, model: executionCodex } }
  }

  const savedPath = persist
    ? saveTranslationConfig(workspaceRoot, next, configPath)
    : configPath || translationConfigPath(workspaceRoot)
  console.log(`\n✅ Configuration saved to ${savedPath}`)
  console.log(`   Selected target: ${targetAnswer}`)
  return next
}

const BRIDGE_CHECK_HELP = `
Usage: manage-agents bridge check [options]

Regenerate every committed bridge (bridges/claude-code/<plugin>, bridges/codex/<plugin>) from the packs and compare it
byte-exact with the committed files.

Options:
  --pack <name>           Pack the bridges translate (default: the configured prefix without its trailing "-")
  --target, -t <name>     Only check claude or codex (default: both)
  --help, -h              Show this help
`

async function runBridgeCheck(workspaceRoot: string) {
  const args = process.argv.slice(4)
  let pack = ""
  let targetFilter: TranslationTarget | "" = ""

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pack" && args[i + 1]) {
      pack = args[++i]
    } else if ((args[i] === "--target" || args[i] === "-t") && args[i + 1]) {
      const requested = args[++i].toLowerCase()
      if (requested !== "claude" && requested !== "codex") throw new Error("--target must be claude or codex")
      targetFilter = requested
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(BRIDGE_CHECK_HELP)
      process.exit(0)
    } else {
      throw new Error(`Unknown option for 'bridge check': ${args[i]}`)
    }
  }

  // Check-only runs must never migrate or persist the translation config.
  const storageKey = standaloneBridgeKey(workspaceRoot)
  const loc = storageKey ? sourceTranslationConfigLocation(storageKey, workspaceRoot) : undefined
  const config = loadTranslationConfig(workspaceRoot, loc?.readPath, { persistMigration: false })
  pack = pack || (config.prefix || "").replace(/-$/, "") || manifestName(workspaceRoot) || ""
  if (!pack) throw new Error(`Cannot tell which pack the bridges translate: set 'prefix' in ${path.relative(workspaceRoot, translationConfigPath(workspaceRoot))} or pass --pack`)
  const pluginName = sanitizeFilename(config.pluginName || DEFAULT_TRANSLATION_CONFIG.pluginName)
  const checks = [
    { target: "claude" as const, folder: "claude-code" },
    { target: "codex" as const, folder: "codex" }
  ].filter(entry => !targetFilter || entry.target === targetFilter)
    .map(entry => ({ ...entry, committedDir: storageKey ? sourceBridgeOutputDir(storageKey, entry.target, pluginName) : path.join(workspaceRoot, "bridges", entry.folder, pluginName) }))
    .filter(entry => targetFilter || fs.existsSync(entry.committedDir))
  if (checks.length === 0) throw new Error(`No committed bridge named ${pluginName} under ${path.join(workspaceRoot, "bridges")}`)

  const { checkPackBridge } = await import("./utils/bridgeCheck.js")
  let drifted = false
  for (const check of checks) {
    const label = `${check.folder}/${pluginName}`
    const result = checkPackBridge({ workspaceRoot, pack, target: check.target, config: { ...config, prefix: config.prefix || `${pack}-` }, committedDir: check.committedDir })
    if (result.clean) {
      console.log(`Bridge ${label} (pack ${pack}): current.`)
      continue
    }
    drifted = true
    console.log(`Bridge ${label} (pack ${pack}): drift.`)
    for (const file of result.missing) console.log(`  missing ${file} (not emitted by a fresh regeneration)`)
    for (const file of result.changed) console.log(`  changed ${file} (content differs from a fresh regeneration)`)
    for (const file of result.extra) console.log(`  extra   ${file} (stale file no longer generated)`)
    console.log(`  Regenerate with: manage-agents bridge --pack ${pack} --target ${check.target}`)
  }
  if (drifted) process.exitCode = 1
}

async function runBridge(workspaceRoot: string, explicitSource?: string) {
  if (process.argv[3] === "check") {
    await runBridgeCheck(workspaceRoot)
    return
  }

  // Parse CLI args. The wizard persists reusable mappings in a translation
  // layer so subsequent non-interactive runs use the same defaults.
  const args = process.argv.slice(3)
  let pack = ""
  let output = ""
  let pluginName = ""
  let prefix = ""
  let target: TranslationTarget = "claude"
  let targetSpecified = false
  let configFile = ""
  let wizard = false
  let modelMappings: Record<string, string> = {}
  let modelFlagsGiven = false
  let autoValidate: boolean | undefined
  let autoRegister: boolean | undefined
  let assumeYes = false
  let marketplaceName = ""
  let marketFlagsGiven = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pack" && args[i + 1]) {
      pack = args[++i]
    } else if ((args[i] === "--output" || args[i] === "-o") && args[i + 1]) {
      output = args[++i]
    } else if ((args[i] === "--name" || args[i] === "-n") && args[i + 1]) {
      pluginName = args[++i]
    } else if ((args[i] === "--prefix" || args[i] === "-p") && args[i + 1]) {
      prefix = args[++i]
    } else if ((args[i] === "--target" || args[i] === "-t") && args[i + 1]) {
      const requested = args[++i].toLowerCase()
      if (requested !== "claude" && requested !== "codex") throw new Error("--target must be claude or codex")
      target = requested
      targetSpecified = true
    } else if (args[i] === "--model" && args[i + 1]) {
      modelMappings = { ...modelMappings, ...parseKeyValueMappings(args[++i]) }
      modelFlagsGiven = true
    } else if (args[i] === "--map-all" && args[i + 1]) {
      modelMappings = { ...modelMappings, "*": args[++i] }
      modelFlagsGiven = true
    } else if (args[i] === "--no-validate") {
      autoValidate = false
      marketFlagsGiven = true
    } else if (args[i] === "--no-register") {
      autoRegister = false
      marketFlagsGiven = true
    } else if (args[i] === "--yes" || args[i] === "-y") {
      assumeYes = true
    } else if (args[i] === "--marketplace-name" && args[i + 1]) {
      marketplaceName = args[++i]
      validateMarketplaceName(marketplaceName)
      marketFlagsGiven = true
    } else if (args[i] === "--config" && args[i + 1]) {
      configFile = args[++i]
    } else if (args[i] === "--wizard" || args[i] === "-w") {
      wizard = true
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Usage: manage-agents bridge [options]
       manage-agents bridge check [options]

Translate a pack of the workspace, with the packs it requires, into a Claude Code plugin or a Codex layer.

Subcommands:
  check                   Verify committed bridges match a fresh regeneration

Options:
  --pack <name>           Pack to bridge (default: the configured prefix without its trailing "-")
  --target, -t <name>     Translation target: claude (default) or codex
  --output, -o <path>     Output directory (default: workspace bridges/ for catalogs, manager cache for standalone packs)
  --name, -n <name>       Plugin name (default: translated-agents)
  --prefix, -p <prefix>   Prefix to strip from agent names (default: <pack>-)
  --config <path>         Reusable translation config (default: bridges/translation-config.json)
  --model <src=target>    Map a source model to a target model; repeatable and accepts comma lists
                          (e.g. --model "zai-glm-5-3=opus" --model "deepseek-*=sonnet")
  --map-all <target>      Shorthand for --model "*=<target>": use one model for every source
  --no-validate           Skip 'claude plugin validate' after a claude bridge
  --no-register           Skip installing the generated plugin into Claude Code
  --yes, -y               Accept confirmation for untrusted executable content
  --marketplace-name <n>  Marketplace used when registering (default: <plugin>-local)
  --wizard, -w            Configure model mappings and save them before bridging
  --help, -h              Show this help

Model mappings use source=target syntax; the source may be a "*" catch-all (e.g. "*=sonnet")
and mappings merge with the loaded config for the selected target. Provided mappings are
persisted to the translation config, so later runs replay them without flags. The claude
automation flags are persisted the same way.
`)
      process.exit(0)
    } else {
      throw new Error(`Unknown option for 'bridge': ${args[i]}`)
    }
  }

  const storageKey = standaloneBridgeKey(workspaceRoot)
  const loc = storageKey ? sourceTranslationConfigLocation(storageKey, workspaceRoot) : undefined
  const loaded = loadTranslationConfig(workspaceRoot, configFile || loc?.readPath, { persistMigration: false })
  const config = wizard
    ? await runTranslationWizard(workspaceRoot, loaded, configFile || undefined, false)
    : loaded
  if (!targetSpecified) target = config.target
  if (modelFlagsGiven) config[target].modelMap = { ...(config[target].modelMap || {}), ...modelMappings }
  // Claude automation flags persist on the claude layer so later runs replay them.
  if (marketFlagsGiven) {
    config.claude = {
      ...config.claude,
      ...(autoValidate !== undefined ? { autoValidate } : {}),
      ...(autoRegister !== undefined ? { autoRegister } : {}),
      ...(marketplaceName ? { marketplaceName } : {})
    }
  }
  pluginName = pluginName || config.pluginName || DEFAULT_TRANSLATION_CONFIG.pluginName
  prefix = prefix || (pack ? `${pack}-` : config.prefix)
  if (!pack) pack = prefix.replace(/-$/, "") || manifestName(workspaceRoot) || ""
  if (!prefix) prefix = `${pack}-`
  if (!pack) {
    console.error("Error: --pack is required (or set prefix in the bridge wizard).")
    process.exit(1)
  }

  const safePluginName = sanitizeFilename(pluginName)
  const outputDir = path.resolve(output || (storageKey ? sourceBridgeOutputDir(storageKey, target, safePluginName) :
    path.join(workspaceRoot, "bridges", target === "codex" ? "codex" : "claude-code", safePluginName)))

  const safe = terminalSafeText
  console.log(`\n🔄 Bridging pack '${safe(pack)}' to ${safe(target)} layer '${safe(pluginName)}'...`)
  console.log(`   Prefix to strip: '${safe(prefix)}'`)
  console.log(`   Output directory: ${safe(outputDir)}\n`)

  const { bridgePack, bridgeConfirmationsNeeded, resolveBridgeWorkspaceTrust } = await import("./utils/bridgeWorkspace.js")
  const registeredSource = explicitSource ? loadSources().sources.find(source => source.name === explicitSource) : undefined
  const resolvedTrust = resolveBridgeWorkspaceTrust(workspaceRoot)
  const trust = registeredSource && resolvedTrust.sourceName === registeredSource.name
    ? { trusted: registeredSource.trusted, sourceName: registeredSource.name }
    : resolvedTrust
  const reasons = bridgeConfirmationsNeeded(workspaceRoot, pack, trust.trusted, trust.sourceName)
  if (reasons.length && !await confirmInTerminal(reasons, assumeYes)) {
    process.exitCode = 1
    return
  }
  const bridgeConfigPath = configFile || loc?.configPath || translationConfigPath(workspaceRoot)
  const bridgePlan = { localPaths: [bridgeConfigPath].filter(file => isRepositoryLocalPath(workspaceRoot, file)).concat(isRepositoryLocalPath(workspaceRoot, outputDir) ? [outputDir] : []), externalPaths: [bridgeConfigPath, outputDir].filter(file => !isRepositoryLocalPath(workspaceRoot, file)) }
  const result: BridgeResult | CodexBridgeResult = repositoryMutation(workspaceRoot, bridgePlan, AUTO_COMMIT_MESSAGES.bridge, () => {
    if (wizard || modelFlagsGiven || marketFlagsGiven) saveTranslationConfig(configFile ? workspaceRoot : loc?.configRoot ?? workspaceRoot, { ...config, pluginName, prefix }, bridgeConfigPath)
    return bridgePack({ workspaceRoot, pack, target, outputDir, config, pluginName: safePluginName, prefix, trusted: trust.trusted, allowUntrustedExecutable: true })
  })

  console.log(`✅ ${safe(target)} layer generated successfully!\n`)
  console.log(`   Files created:`)
  result.files.forEach(f => console.log(`     * ${safe(f)}`))
  if (result.preview?.length) {
    console.log(`\n   Preview (agent → role → tier → model → source):`)
    result.preview.forEach(p => console.log(`     ${safe(p.agent)} → ${safe(p.role)} → ${safe(p.tier)} → ${safe(p.model)} → ${safe(p.source)}`))
  }

  if (result.warnings.length > 0) {
    console.log(`\n   ⚠ Warnings:`)
    result.warnings.forEach(w => console.log(`     * ${safe(w)}`))
  }

  if (target === "claude" && "pluginName" in result) {
    console.log(`\n   Validate and run locally:`)
    claudeNextSteps(result.pluginName, result.orchestratorName, result.pluginDir).forEach(line => console.log(safe(line)))
    console.log()
    // Validation and registration run after the transaction: they spawn the
    // claude CLI and write user-level Claude config.
    let registrationSkipped = false
    if (config.claude.autoValidate !== false) {
      const validation = validatePlugin(result.pluginDir)
      console.log(`   Validation: ${safe(validation.kind)}`)
      console.log(`     ${safe(validation.message)}`)
      if (validation.detail) console.log(`     ${safe(validation.detail)}`)
      if (validation.kind === "fail") {
        registrationSkipped = true
        console.log(`     ⚠ Registration skipped: validation failed.`)
      } else if (validation.kind === "error") {
        registrationSkipped = true
        console.log(`     ⚠ Registration skipped: validation could not decide (unexpected CLI error).`)
      }
    }
    if (!registrationSkipped && config.claude.autoRegister !== false) {
      if (result.marketplaceName === null) {
        console.log(`     ⚠ Registration skipped: no marketplace manifest is emitted (claude.emitMarketplace is off).`)
      } else {
        const registration = registerPlugin(result.pluginDir, result.pluginName, result.marketplaceName)
        console.log(`   Registration: ${safe(registration.kind)}`)
        console.log(`     ${safe(registration.message)}`)
        if (registration.detail) console.log(`     ${safe(registration.detail)}`)
      }
    }
    console.log()
  } else if ("plugin" in result) {
    console.log("\n   Open the generated project in Codex:")
    codexNextSteps(result).forEach(line => console.log(safe(line)))
    console.log()
  }
}

async function runLint(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const agents = findAgentFiles(workspaceRoot)
  const allFilenames = agents.map(a => a.filename)

  console.log(`\n🔍 Naming Convention Lint Report`)
  console.log(`   Rule: [{family}-]{category}-{role_with_underscores}.md`)
  console.log(`   ------------------------------------------`)

  let validCount = 0
  let invalidCount = 0

  for (const agent of agents) {
    const analysis = analyzeAgentName(agent.filename, allFilenames)
    if (analysis.isValid) {
      validCount++
    } else {
      invalidCount++
      console.log(`\n  ❌ ${agent.filename}`)
      analysis.errors.forEach(e => console.log(`     * Error: ${e}`))
      if (analysis.suggestedName) {
        console.log(`     👉 Suggested: ${analysis.suggestedName}`)
      }
    }
  }

  console.log(`\n   ------------------------------------------`)
  console.log(`   Total agents: ${agents.length}`)
  console.log(`   ✅ Compliant:     ${validCount}`)
  console.log(`   ⚠ Non-Compliant: ${invalidCount}\n`)
}

async function runFixNames(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const args = process.argv.slice(3)
  const isDryRun = args.includes("--dry-run")

  const agents = findAgentFiles(workspaceRoot)
  const allFilenames = agents.map(a => a.filename)
  const nonCompliant = agents.map(a => ({ agent: a, analysis: analyzeAgentName(a.filename, allFilenames) })).filter(item => !item.analysis.isValid)

  if (nonCompliant.length === 0) {
    console.log("\n✨ All agents already comply with the naming convention!")
    return
  }

  console.log(`\n🛠  Fixing Agent Names (Naming Convention Refactoring)`)
  console.log(`   Mode: ${isDryRun ? "DRY RUN (no changes will be written)" : "EXECUTE"}`)
  console.log(`   Found ${nonCompliant.length} non-compliant agents.\n`)

  nonCompliant.forEach(({ agent, analysis }) => {
    console.log(`   * ${agent.filename}  ->  ${analysis.suggestedName}`)
  })

  if (isDryRun) {
    console.log("\n💡 Dry run complete. Run without --dry-run to apply changes.\n")
    return
  }

  const answer = await askQuestion("\n⚠  Proceed with refactoring? (Y/n): ")
  if (answer.toLowerCase() !== "y" && answer !== "") {
    console.log("\n❌ Operation cancelled.")
    return
  }

  const plans = nonCompliant.filter(item => item.analysis.suggestedName).map(({ agent, analysis }) => ({
    agent,
    destination: path.join(path.dirname(agent.currentPath), analysis.suggestedName!)
  }))
  const plannedPaths = [...agents.map(agent => agent.currentPath), ...plans.map(plan => plan.destination)]
  let successCount = 0
  let totalRefs = 0
  try {
    const results = repositoryMutation(workspaceRoot, plannedPaths, AUTO_COMMIT_MESSAGES.rename, () => {
      const renamed = []
      for (const plan of plans) {
        const result = renameAgent(workspaceRoot, plan.agent.currentPath, path.basename(plan.destination), agents)
        if (!result.success) throw new Error(result.error || `Failed to rename ${plan.agent.filename}`)
        renamed.push(result)
      }
      return renamed
    })
    successCount = results.length
    totalRefs = results.reduce((count, result) => count + result.updatedReferences.length, 0)
  } catch (e: any) {
    console.error(`Failed to rename agents: ${e.message || e}`)
    return
  }

  console.log(`\n✅ Batch refactoring complete!`)
  console.log(`   Successfully renamed ${successCount}/${nonCompliant.length} agents.`)
  console.log(`   Updated cross-references in ${totalRefs} places.\n`)
}

async function runAudit(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const agents = findAgentFiles(workspaceRoot)
  const audit = auditSecurityPermissions(agents)

  console.log(`\n🛡️  Security & Permission Audit Report`)
  console.log(`   ------------------------------------------`)

  if (audit.orderErrors.length > 0) {
    console.log(`\n  ⚠️ PERMISSION ORDER ERRORS (${audit.orderErrors.length} agents):`)
    console.log(`     (OpenCode spec requires wildcard "*": "deny" to be placed FIRST!)`)
    audit.orderErrors.forEach(({ agent, categories }) => {
      console.log(`     * ${agent.filename}  [categories: ${categories.join(", ")}]`)
    })
  }

  if (audit.highRisk.length > 0) {
    console.log(`\n  🔴 HIGH RISK (${audit.highRisk.length} agents):`)
    audit.highRisk.forEach(({ agent, reason }) => {
      console.log(`     * ${agent.filename}  (${reason})`)
    })
  }

  if (audit.mediumRisk.length > 0) {
    console.log(`\n  🟠 MEDIUM RISK (${audit.mediumRisk.length} agents):`)
    audit.mediumRisk.forEach(({ agent, reason }) => {
      console.log(`     * ${agent.filename}  (${reason})`)
    })
  }

  console.log(`\n  🟢 LOW RISK: ${audit.lowRisk.length} agents (Read-only / restricted access)`)
  console.log(`   ------------------------------------------\n`)
}

async function runTuneCLI(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const args = process.argv.slice(3)

  const usage = () => {
    console.log("Usage: manage-agents tune [options]")
    console.log("  --steps <number>                  Set max execution steps (positive integer)")
    console.log(`  --variant <name> / --effort <name> Set model variant (known: ${KNOWN_MODEL_VARIANTS.join("|")}; model-exposed variants from opencode models --verbose are supported)`)
    console.log("  --clear-variant / --clear-effort  Remove variant from agent frontmatter (revert to model default)")
    console.log("  --mode <primary|subagent|all>     Set agent execution mode")
    console.log("  --hidden / --no-hidden            Hide or unhide target agents")
    console.log("  --pack <pack> / --all             Target the agents of one pack, or all agents")
  }

  const parsed = parseTuneCliArgs(args)
  if (parsed.kind === "help") {
    usage()
    return
  }
  if (parsed.kind === "error") {
    console.error(`Error: ${terminalSafeText(parsed.message)}\n`)
    usage()
    process.exitCode = 1
    return
  }

  const { category, allCategories, params } = parsed
  const agents = findAgentFiles(workspaceRoot)
  const targetAgents = !allCategories && category ? agents.filter(a => a.category === category) : agents
  if (targetAgents.length === 0) {
    console.error(
      category
        ? `Error: No agents found for pack "${terminalSafeText(category)}".`
        : "Error: No agents found in workspace."
    )
    process.exitCode = 1
    return
  }

  const catalog = loadModelCatalog()
  const allowedVariants = resolveAllowedTuneVariants(targetAgents, catalog)
  let updateParams: Parameters<typeof updateAgentParams>[1] = { ...params, allowedVariants }
  if (params.variant !== undefined && params.variant !== null) {
    try {
      const validated = buildTuningUpdateParams(
        { steps: "50", variant: params.variant, mode: "subagent", hidden: false },
        new Set(["variant"]),
        allowedVariants,
      )
      if (validated.variant !== undefined) updateParams = { ...updateParams, variant: validated.variant }
    } catch (error: any) {
      console.error(`Error: ${terminalSafeText(error?.message || error)}`)
      process.exitCode = 1
      return
    }
  }

  console.log(`\n🎯 Parameter Tuning CLI`)
  console.log(`   Target agents: ${targetAgents.length}${!allCategories && category ? ` (pack: ${terminalSafeText(category)})` : " (all)"}`)
  console.log(`   Steps:       ${params.steps !== undefined ? params.steps : "unchanged"}`)
  console.log(`   Variant:     ${params.variant === undefined ? "unchanged" : params.variant === null ? "cleared" : terminalSafeText(params.variant)}`)
  console.log(`   Mode:        ${params.mode !== undefined ? params.mode : "unchanged"}`)
  console.log(`   Hidden:      ${params.hidden !== undefined ? params.hidden : "unchanged"}\n`)
  try {
    repositoryMutation(workspaceRoot, targetAgents.map(a => a.currentPath), AUTO_COMMIT_MESSAGES.tune, () =>
      updateAgentParams(targetAgents, updateParams)
    )
    console.log(`✅ Successfully updated parameters for ${targetAgents.length} agents!\n`)
  } catch (error: any) {
    console.error(`Error: ${terminalSafeText(error?.message || error)}`)
    process.exitCode = 1
  }
}

// Pack content may be hostile: escape C1 controls, which JSON.stringify leaves raw and some terminals interpret.
const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2).replace(/[\u007f-\u009f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`))

function parseCliArgs(args: string[], valued: string[], booleans: string[]): { positional: string[]; values: Record<string, string>; flags: Set<string> } | string {
  const positional: string[] = []
  const values: Record<string, string> = {}
  const flags = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--")) positional.push(arg)
    else if (valued.includes(arg)) {
      if (args[i + 1] === undefined || args[i + 1].startsWith("--")) return `${arg} needs a value`
      values[arg] = args[++i]
    } else if (booleans.includes(arg)) flags.add(arg)
    else return `unknown option ${terminalSafeText(arg)}`
  }
  return { positional, values, flags }
}

function cliError(message: string, code = 2) {
  console.error(`Error: ${message.split("\n").map(terminalSafeText).join("\n")}`)
  process.exitCode = code
}

function printPackValidation(validation: PackValidation) {
  const { manifest, ids, unresolved, issues } = validation
  const safe = terminalSafeText
  console.log(manifest ? `Pack ${safe(manifest.name)} ${safe(manifest.version)} (contract ${safe(manifest.contract)}): ${safe(validation.root)}` : `Pack at ${safe(validation.root)}`)
  const counts = Object.entries(ids).filter(([, list]) => list.length).map(([kind, list]) => `${list.length} ${kind}`)
  if (counts.length) console.log(`  Contents: ${counts.join(", ")}`)
  const surface = describeExecutable(validation)
  if (surface.length) console.log(`  Executable surface:\n${surface.map(item => `    - ${safe(item)}`).join("\n")}`)
  if (unresolved.length) console.log(`  Unresolved (must come from a required pack):\n${unresolved.map(ref => `    - ${safe(ref.from)}: ${ref.kind} ${safe(ref.target)}`).join("\n")}`)
  for (const issue of issues) console.log(`  ${issue.level === "error" ? "ERROR" : "warning"} [${issue.code}]${issue.path ? ` ${safe(issue.path)}` : ""}: ${safe(issue.message)}`)
  const errors = issues.filter(issue => issue.level === "error").length
  console.log(errors ? `  ${errors} error(s): the pack does not satisfy the contract.` : "  The pack satisfies the contract.")
}

function runPackCLI() {
  const [action, ...rest] = process.argv.slice(3)
  const validActions = new Set(["validate", "list", "init", "onboard", "doctor", "add"])
  if (!action || !validActions.has(action) || rest.includes("--help") || rest.includes("-h")) {
    console.log("Usage: manage-agents pack validate <pack-dir>... [--json] [--git]")
    console.log("       manage-agents pack list [--json]")
    console.log("       manage-agents pack init|onboard [<dir>] [--name <slug>] [--version <semver>] [--description <text>] [--layout auto|root|subpack] [--authoring-kit] [--clone-source <name>] [--no-organize] [--json]")
    console.log("       manage-agents pack doctor [<dir>] [--fix] [--authoring-kit] [--bump patch|minor|major] [--json]")
    console.log("       manage-agents pack add <agent|skill|command> <id> [--dir <dir>] [--description <text>] [--mode primary|subagent|all] [--json]")
    console.log("validate checks directories against the OpenCode pack contract (contract/CONTRACT.md); init/onboard turns a folder or Git source into a Contract 1.1 pack; doctor inspects & repairs drift; add scaffolds compliant resources.")
    if (action && !validActions.has(action) && action !== "--help" && action !== "-h") process.exitCode = 2
    return
  }
  const valued =
    action === "init" || action === "onboard"
      ? ["--name", "--version", "--description", "--layout", "--clone-source"]
      : action === "doctor"
        ? ["--bump"]
        : action === "add"
          ? ["--dir", "--description", "--mode"]
          : []
  const booleans =
    action === "validate"
      ? ["--json", "--git"]
      : action === "init" || action === "onboard"
        ? ["--json", "--no-organize", "--authoring-kit"]
        : action === "doctor"
          ? ["--json", "--fix", "--authoring-kit"]
          : ["--json"]
  const parsed = parseCliArgs(rest, valued, booleans)
  if (typeof parsed === "string") return cliError(parsed)

  if (action === "init" || action === "onboard") {
    try {
      const rawLayout = parsed.values["--layout"]
      if (rawLayout !== undefined && rawLayout !== "auto" && rawLayout !== "root" && rawLayout !== "subpack") {
        return cliError(`invalid --layout "${rawLayout}": expected auto, root or subpack`)
      }
      const layout: OnboardingLayout = (rawLayout as OnboardingLayout | undefined) ?? (action === "onboard" ? "auto" : "root")
      let targetDir: string
      let clonedInfo: { sourceName: string; localSourceName: string } | null = null

      if (parsed.values["--clone-source"]) {
        const registry = loadSources()
        const src = findSource(registry, parsed.values["--clone-source"])
        const destDir = parsed.positional[0] ?? suggestCloneDestination(src)
        const cloned = cloneGitSourceForOnboarding({ source: src, destDir, registry })
        targetDir = cloned.localRoot
        clonedInfo = { sourceName: src.name, localSourceName: cloned.localSource.name }
      } else {
        targetDir = path.resolve(parsed.positional[0] ?? process.cwd())
      }

      const result = applyPackOnboarding(targetDir, {
        name: parsed.values["--name"],
        version: parsed.values["--version"],
        description: parsed.values["--description"],
        layout,
        organize: !parsed.flags.has("--no-organize"),
        authoringKit: parsed.flags.has("--authoring-kit"),
      })
      if (parsed.flags.has("--json")) return printJson({ ...(clonedInfo ? { cloned: clonedInfo } : {}), ...result })
      if (clonedInfo) {
        console.log(`Cloned "${terminalSafeText(clonedInfo.sourceName)}" -> ${terminalSafeText(targetDir)} (active source: ${terminalSafeText(clonedInfo.localSourceName)})`)
      }
      console.log(`Initialized pack "${terminalSafeText(result.manifest.name)}"@${terminalSafeText(result.manifest.version)} (contract ${terminalSafeText(result.manifest.contract)}, layout: ${result.layout}) at ${terminalSafeText(result.manifestPath)}`)
      for (const moved of result.movedAgents) console.log(`  moved ${terminalSafeText(moved.from)} -> ${terminalSafeText(moved.to)}`)
      for (const moved of result.movedResources) console.log(`  moved ${terminalSafeText(moved.from)} -> ${terminalSafeText(moved.to)}`)
      for (const kit of result.kitFiles) console.log(`  kit ${terminalSafeText(kit)}`)
      for (const warning of result.warnings) console.log(`  ${terminalSafeText(warning)}`)
    } catch (error) {
      cliError(error instanceof Error ? error.message : String(error), 1)
    }
    return
  }

  if (action === "doctor") {
    try {
      const baseDir = path.resolve(parsed.positional[0] ?? process.cwd())
      const targetPackDir = resolveEditablePackDir(baseDir) ?? baseDir
      const rawBump = parsed.values["--bump"]
      if (rawBump !== undefined && rawBump !== "patch" && rawBump !== "minor" && rawBump !== "major") {
        return cliError(`invalid --bump "${rawBump}": expected patch, minor or major`)
      }
      let bumped: { previousVersion: string; nextVersion: string } | null = null
      if (rawBump) {
        bumped = bumpPackVersion(targetPackDir, rawBump as SemverReleaseKind)
      }
      const shouldMutate = parsed.flags.has("--fix") || parsed.flags.has("--authoring-kit")
      const fixOutcome = shouldMutate
        ? fixPackDoctor(targetPackDir, { repoRoot: baseDir, authoringKit: parsed.flags.has("--authoring-kit") })
        : null
      const report = fixOutcome ? fixOutcome.report : inspectPackDoctor(targetPackDir, baseDir)
      if (parsed.flags.has("--json")) {
        printJson({
          ...(bumped ? { bumped } : {}),
          ...(fixOutcome ? { appliedFixes: fixOutcome.appliedFixes, kitFiles: fixOutcome.kitFiles } : {}),
          report,
        })
      } else {
        const m = report.manifest
        console.log(`${m ? `${terminalSafeText(m.name)}@${terminalSafeText(m.version)} (contract ${terminalSafeText(m.contract)})` : "Invalid pack"}  ${terminalSafeText(report.packDir)}`)
        if (bumped) console.log(`  version: ${terminalSafeText(bumped.previousVersion)} -> ${terminalSafeText(bumped.nextVersion)}`)
        if (fixOutcome) {
          for (const fix of fixOutcome.appliedFixes) console.log(`  fixed: ${terminalSafeText(fix)}`)
          for (const kf of fixOutcome.kitFiles) console.log(`  kit: ${terminalSafeText(kf)}`)
        }
        console.log(`  Authoring kit: skill=${report.hasAuthoringSkill ? "installed" : "missing"}, ci=${report.hasCiWorkflow ? "installed" : "missing"}`)
        if (report.findings.length === 0) {
          console.log("  ✓ Pack satisfies OpenCode Contract 1.1 with zero findings.")
        } else {
          for (const f of report.findings) {
            console.log(`  ${f.level}${f.autoFixable ? " [fixable]" : ""} [${terminalSafeText(f.code)}]${f.path ? ` ${terminalSafeText(f.path)}:` : ""} ${terminalSafeText(f.message)}`)
          }
        }
      }
      if (hasErrors(report.validation)) process.exitCode = 1
    } catch (error) {
      cliError(error instanceof Error ? error.message : String(error), 1)
    }
    return
  }

  if (action === "add") {
    try {
      const [rawKind, rawId] = parsed.positional
      if (rawKind !== "agent" && rawKind !== "skill" && rawKind !== "command") {
        return cliError("usage: manage-agents pack add <agent|skill|command> <id> [--dir <dir>] [--description <text>] [--mode primary|subagent|all]")
      }
      if (!rawId) {
        return cliError(`pack add ${rawKind} requires an <id>`)
      }
      const rawMode = parsed.values["--mode"]
      if (rawMode !== undefined && rawMode !== "primary" && rawMode !== "subagent" && rawMode !== "all") {
        return cliError(`invalid --mode "${rawMode}": expected primary, subagent or all`)
      }
      const baseDir = path.resolve(parsed.values["--dir"] ?? process.cwd())
      const targetPackDir = resolveEditablePackDir(baseDir) ?? baseDir
      const created = scaffoldPackResource(targetPackDir, {
        kind: rawKind as ScaffoldResourceKind,
        id: rawId,
        description: parsed.values["--description"],
        mode: rawMode as "primary" | "subagent" | "all" | undefined,
      })
      if (parsed.flags.has("--json")) return printJson(created)
      console.log(`Created ${created.kind} "${terminalSafeText(created.id)}" at ${terminalSafeText(created.relativePath)}`)
    } catch (error) {
      cliError(error instanceof Error ? error.message : String(error), 1)
    }
    return
  }
  if (action === "list") {
    const { candidates, problems } = discoverAllPacks(loadSources())
    if (parsed.flags.has("--json")) return printJson({ packs: candidates.map(({ manifest, ...candidate }) => ({ ...candidate, name: manifest.name, version: manifest.version, description: manifest.description, requires: manifest.requires })), problems })
    if (!candidates.length && !problems.length) console.log("No packs. Register a source with `manage-agents source add <name> <dir|git-url>`.")
    for (const candidate of candidates) console.log(`${terminalSafeText(candidate.source)}/${terminalSafeText(candidate.manifest.name)}@${terminalSafeText(candidate.manifest.version)}  ${terminalSafeText(candidate.relativeDir)}  ${terminalSafeText(candidate.manifest.description)}`)
    for (const problem of problems) console.log(`warning: ${terminalSafeText(problem)}`)
    return
  }
  if (!parsed.positional.length) return cliError("pack validate needs at least one pack directory.")
  const results = parsed.positional.map(dir => validatePack(dir, { sourceKind: parsed.flags.has("--git") ? "git" : "local" }))
  if (parsed.flags.has("--json")) printJson(results.length === 1 ? results[0] : results)
  else results.forEach(printPackValidation)
  if (results.some(hasErrors)) process.exitCode = 1
}

const SOURCE_USAGE = `Usage: manage-agents source <command>
  list [--json]                                   registered sources
  add [<name>] <dir|git-url|owner/repo[#ref]> [--ref <ref>] [--trust] [--pull]
                                                  register a local directory, git URL or GitHub repo
  remove <name>
  pull [<name>...]                                clone or fetch git sources into the cache (default: all)
  login [--hostname <host>]                       authenticate GitHub CLI (gh auth login --web)
  auth [--hostname <host>] [--json]               show GitHub CLI authentication status
  trust <name> | untrust <name>                   allow installing executable content from the source without asking
  prefer <pack> <source> | prefer <pack> --clear  which source to use when several offer the same pack
Sources live in $XDG_CONFIG_HOME/manage-agents/sources.json; git checkouts in $XDG_CACHE_HOME/manage-agents/sources/.`

function runSourceCLI() {
  const [action, ...rest] = process.argv.slice(3)
  if (!action || action === "--help" || action === "-h" || rest.includes("--help")) {
    console.log(SOURCE_USAGE)
    if (!action) process.exitCode = 2
    return
  }
  const valueFlags = action === "add" ? ["--ref"] : action === "login" || action === "auth" ? ["--hostname"] : []
  const boolFlags = action === "add" ? ["--trust", "--pull"] : action === "list" || action === "auth" ? ["--json"] : action === "prefer" ? ["--clear"] : []
  const parsed = parseCliArgs(rest, valueFlags, boolFlags)
  if (typeof parsed === "string") return cliError(parsed)
  const [first, second] = parsed.positional
  try {
    const registry = loadSources()
    const safe = terminalSafeText
    if (action === "list") {
      if (parsed.flags.has("--json")) return printJson(registry)
      if (!registry.sources.length) console.log("No sources. Add one with `manage-agents source add [<name>] <dir|git-url|owner/repo>`.")
      for (const source of registry.sources) {
        const activeMark = registry.active === source.name ? "* " : "  "
        const location = source.kind === "local" ? source.path : `${redactUrlCredentials(source.url)}${source.ref ? `#${source.ref}` : ""} (${sourceRevision(source)?.slice(0, 12) ?? "not pulled"})`
        console.log(`${activeMark}${safe(source.name)}  ${source.kind}  ${source.trusted ? "trusted" : "untrusted"}  ${safe(location)}`)
      }
      for (const [pack, source] of Object.entries(registry.prefer)) console.log(`prefer ${safe(pack)} from ${safe(source)}`)
      return
    }
    if (action === "add") {
      if (!first || parsed.positional.length > 2) return cliError("usage: source add [<name>] <dir|git-url|owner/repo[#ref]> [--ref <ref>] [--trust] [--pull]")
      const name = second ? first : deriveSourceName(first, registry)
      const location = second ?? first
      const source = addSource(registry, name, location, { ref: parsed.values["--ref"], trusted: parsed.flags.has("--trust") })
      if (!registry.active) registry.active = source.name
      saveSources(registry)
      if (source.kind === "git" && parsed.flags.has("--pull")) {
        const commit = pullSource(source)
        console.log(`Added and pulled ${source.kind} source ${safe(source.name)}${source.trusted ? " (trusted)" : ""} (${commit?.slice(0, 12) ?? "ok"}).`)
      } else {
        console.log(`Added ${source.kind} source ${safe(source.name)}${source.trusted ? " (trusted)" : ""}.${source.kind === "git" ? ` Fetch it with \`manage-agents source pull ${source.name}\`.` : ""}`)
      }
      return
    }
    if (action === "login") {
      const host = parsed.values["--hostname"] ?? "github.com"
      const outcome = runGhWebLogin(host)
      if (!outcome.ok) return cliError(outcome.message, 1)
      console.log(safe(outcome.message))
      return
    }
    if (action === "auth") {
      const host = parsed.values["--hostname"] ?? "github.com"
      const status = inspectGhAuth(host)
      if (!status.authenticated) process.exitCode = 1
      if (parsed.flags.has("--json")) return printJson(status)
      console.log(safe(status.message))
      return
    }
    if (action === "remove") {
      if (!first || parsed.positional.length > 1) return cliError("usage: source remove <name>")
      removeSource(registry, first)
      saveSources(registry)
      console.log(`Removed source ${safe(first)}. Its cached checkout, if any, stays in the cache directory.`)
      return
    }
    if (action === "pull") {
      const sources = parsed.positional.length ? parsed.positional.map(name => findSource(registry, name)) : registry.sources.filter(source => source.kind === "git")
      for (const source of sources) {
        const commit = pullSource(source)
        console.log(commit ? `${safe(source.name)}: ${commit.slice(0, 12)}` : `${safe(source.name)}: local source, nothing to pull`)
      }
      return
    }
    if (action === "trust" || action === "untrust") {
      if (!first || parsed.positional.length > 1) return cliError(`usage: source ${action} <name>`)
      findSource(registry, first).trusted = action === "trust"
      saveSources(registry)
      console.log(`Source ${safe(first)} is now ${action === "trust" ? "trusted" : "untrusted"}.`)
      return
    }
    if (action === "prefer") {
      if (!first || !PACK_NAME_RE.test(first) || (parsed.flags.has("--clear") ? second !== undefined : !second)) return cliError("usage: source prefer <pack> <source> | source prefer <pack> --clear")
      if (parsed.flags.has("--clear")) delete registry.prefer[first]
      else registry.prefer[first] = findSource(registry, second).name
      saveSources(registry)
      console.log(parsed.flags.has("--clear") ? `Cleared the source preference for ${safe(first)}.` : `Pack ${safe(first)} now comes from ${safe(second)}.`)
      return
    }
    cliError(`unknown source command ${safe(action)}\n${SOURCE_USAGE}`)
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}


function runResolveCLI() {
  const args = process.argv.slice(3)
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: manage-agents resolve <[source/]pack[@range]>... [--target <opencode-config-dir>] [--json]")
    console.log("Resolves packs and their dependencies across the registered sources and prints the result, the changes against the target's lock and the executable surface. Writes nothing.")
    if (!args.length) process.exitCode = 2
    return
  }
  const parsed = parseCliArgs(args, ["--target"], ["--json"])
  if (typeof parsed === "string") return cliError(parsed)
  try {
    const requests = parsed.positional.map(parsePackRequest)
    const registry = loadSources()
    const { candidates, problems: discoveryProblems } = discoverAllPacks(registry)
    const resolution = resolvePacks(requests, candidates, { prefer: registry.prefer, revisionOf: name => sourceRevision(findSource(registry, name)) })
    const target = realpathThroughExistingAncestor(path.resolve(parsed.values["--target"] ?? defaultTarget()))
    const lock = resolution.problems.length ? null : buildLock(resolution)
    const previousLock = readLock(target)
    const diff = lock ? diffLocks(previousLock, lock) : { changes: [], executable: [] }
    const confirmations = lock ? confirmationsNeeded(lock, previousLock) : []
    const warnings = [...discoveryProblems, ...resolution.warnings]
    if (parsed.flags.has("--json")) printJson({ target, packs: resolution.packs.map(({ validation, ...pack }) => pack), ...(lock ? { lock } : {}), changes: diff.changes, executableChanges: diff.executable, confirmations, problems: resolution.problems, warnings })
    else {
      const safe = terminalSafeText
      console.log(`Resolution for ${safe(target)}:`)
      for (const pack of resolution.packs) {
        console.log(`  ${safe(pack.name)}@${safe(pack.version)} from ${safe(pack.source)}${pack.revision ? `@${pack.revision.slice(0, 12)}` : ""}${pack.root ? "" : `  (required by ${pack.requiredBy.map(safe).join(", ")})`}${pack.trusted ? "" : "  [untrusted]"}`)
        for (const item of pack.executable) console.log(`      runs: ${safe(item)}`)
      }
      if (diff.changes.length) console.log(`Changes against the lock:\n${diff.changes.map(formatLockChange).join("\n")}`)
      for (const reason of confirmations) console.log(`needs confirmation: ${safe(reason)}`)
      for (const warning of warnings) console.log(`warning: ${safe(warning)}`)
      for (const problem of resolution.problems) console.log(`ERROR: ${safe(problem)}`)
      console.log(resolution.problems.length ? "Resolution failed." : "Resolution succeeded. Nothing was written.")
    }
    if (resolution.problems.length) process.exitCode = 1
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}

const TARGET_USAGE = `Usage: manage-agents <command> [--target <opencode-config-dir>]
  install <[source/]pack[@range]>... [--adopt] [--yes] [--dry-run] [--json]
                     add root packs; packs already installed keep their locked version
  uninstall <pack>... [--dry-run] [--json]
                     remove root packs; dependencies still required stay
  update [<pack>...] [--adopt] [--yes] [--dry-run] [--json]
                     pull the git sources of the named packs (all packs when none is named) and re-resolve within the ranges
  update --self [...]  update the manage-agents engine itself from GitHub Releases (alias for self-update)
  reconcile [--adopt] [--dry-run] [--json]
                     rebuild the target from its desired state and lock (repairs missing or deleted files)
  status [--json]    read-only drift report; exit 1 when something differs
  restore <backup-id>
                     put back what --adopt replaced; the restored content becomes unmanaged
--adopt backs up and replaces files and config entries that are not managed or were changed locally.
--yes accepts executable content that needs confirmation (required without a terminal).
Default target: $XDG_CONFIG_HOME/opencode (~/.config/opencode). State lives in <target>/.manage-agents/.`

async function confirmInTerminal(reasons: string[], yes: boolean, json = false): Promise<boolean> {
  if (json && !yes) return false
  if (!json) for (const reason of reasons) console.log(`needs confirmation: ${terminalSafeText(reason)}`)
  if (yes) return true
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Error: this change needs confirmation; review the lines above and rerun with --yes.")
    return false
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>(resolve => rl.question("Proceed? [y/N] ", resolve))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

function printChangeResult(command: string, target: string, result: ChangeResult, json: boolean) {
  const plan = result.plan
  const problems = [...(result.change?.problems ?? []), ...(plan?.conflicts ?? [])]
  const warnings = [...(result.change?.warnings ?? []), ...(plan?.warnings ?? [])]
  if (result.status === "failed" || result.status === "declined") process.exitCode = 1
  if (json) {
    printJson({
      command, target, status: result.status, recovered: result.recovered, changes: result.changes, confirmations: result.confirmations, problems, warnings,
      writes: plan?.writes.map(({ rel, kind }) => ({ path: rel, kind })) ?? [], deletes: plan?.deletes ?? [], released: plan?.released ?? [],
      configChanged: plan ? plan.configText !== null : false, backupId: result.backupId,
    })
    return
  }
  for (const line of describeChangeResult(target, result)) console.log(line)
}

async function runTargetCLI(command: "install" | "uninstall" | "update" | "reconcile" | "status" | "restore") {
  const args = process.argv.slice(3)
  if (command === "update" && args.includes("--self")) {
    return runSelfUpdateCLI(args.filter(arg => arg !== "--self"))
  }
  if (args.includes("--help") || args.includes("-h")) return console.log(TARGET_USAGE)
  const booleans = { install: ["--adopt", "--yes", "--dry-run", "--json"], update: ["--adopt", "--yes", "--dry-run", "--json"], reconcile: ["--adopt", "--dry-run", "--json"], uninstall: ["--dry-run", "--json"], status: ["--json"], restore: [] }[command]
  const parsed = parseCliArgs(args, ["--target"], booleans)
  if (typeof parsed === "string") return cliError(`${parsed}\n${TARGET_USAGE}`)
  const names = parsed.positional
  if ((command === "install" || command === "uninstall" || command === "restore") && !names.length) return cliError(`${command} needs at least one argument\n${TARGET_USAGE}`)
  if ((command === "reconcile" || command === "status") && names.length) return cliError(`${command} takes no pack names\n${TARGET_USAGE}`)
  try {
    const target = realpathThroughExistingAncestor(path.resolve(parsed.values["--target"] ?? defaultTarget()))
    const registry = loadSources()
    const json = parsed.flags.has("--json")
    if (command === "status") {
      const status = targetStatus(target, registry)
      if (json) printJson({ target, roots: status.desired.roots, packs: Object.fromEntries(Object.entries(status.lock?.packs ?? {}).map(([name, pack]) => [name, { source: pack.source, version: pack.version, revision: pack.revision }])), drift: status.drift })
      else {
        console.log(`Target ${terminalSafeText(target)}`)
        console.log(status.lock && Object.keys(status.lock.packs).length ? `Packs:\n${Object.entries(status.lock.packs).map(([name, pack]) => `  ${terminalSafeText(name)}@${terminalSafeText(pack.version)} from ${terminalSafeText(pack.source)}${pack.revision ? `@${pack.revision.slice(0, 12)}` : ""}${status.desired.roots.some(root => parsePackRequest(root).name === name) ? "" : " (dependency)"}`).join("\n")}` : "No packs installed.")
        for (const line of status.drift) console.log(`drift: ${terminalSafeText(line)}`)
        if (!status.drift.length) console.log("In sync.")
      }
      if (status.drift.length) process.exitCode = 1
      return
    }
    if (command === "restore") {
      const restored = await restoreBackup(target, names[0])
      console.log(`Restored ${restored.files.length} file(s) and ${restored.config.length} config entr${restored.config.length === 1 ? "y" : "ies"}; they are no longer managed. \`manage-agents status\` shows what now differs from the packs.`)
      return
    }
    const options = { adopt: parsed.flags.has("--adopt"), dryRun: parsed.flags.has("--dry-run"), confirm: (reasons: string[]) => confirmInTerminal(reasons, parsed.flags.has("--yes"), json) }
    const compute = command === "install" ? installChange(registry, names)
      : command === "uninstall" ? uninstallChange(names)
        : command === "update" ? updateChange(registry, names)
          : reconcileChange
    const result = await changeTarget(target, command, registry, compute, options)
    printChangeResult(command, target, result, json)
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}

const SETTINGS_USAGE = `Usage (user settings applied at reconcile; never written into packs unless exported):
  models show [--json]
  models set <pack> <trigger[,trigger2...]> <agent>=<provider/model[#variant]|inherit>...
                     when a caller of <pack> runs on any trigger ("*", provider, or provider/model), route its subagents
  models unset <pack> <trigger[,trigger2...]> [<agent>...]
  models callers <pack> [<caller>...] [--unset]
                     configure or clear OR caller agents for <pack> in routing.json (works even without manifest archetype)
  models rule-set <pack> <trigger[,trigger2...]> [--callers <a,b>] [--model <sub=m>]... [--tool <k=allow|ask|deny>]...
                     [--perm <action=allow|ask|deny>]... [--delegate <sub=allow|deny>]... [--index <n>]
  models rule-unset <pack> [<index|all>]
  models export-pack <pack> [--dir <workspace-or-pack-dir>]
                     write effective callers, routingDefaults and flowDefaults into local <pack>/opencode-pack.json
  models pin <pack>/<agent> <provider/model[#variant]>
                     give a subagent a fixed model: routing skips it (writes the override "model")
  models unpin <pack>/<agent>
                     drop any fixed model, including the pack's own, so the subagent follows routing
  override show [--json]
  override set <pack>/<id> <field>=<value>... [--command]
                     patch frontmatter of an installed agent (or command with --command); value is YAML, null removes the field
  override unset <pack>/<id> [<field>...] [--command]
  override config-set <pack>/<section>/<key> <field>=<value>...
                      patch one config entry a pack contributes (sections: mcp.servers, lsp, formatter, experimental)
                      value is YAML; dotted field names nest (environment.FOO=x); null removes the field from the entry
                      an entry the pack does not have is created; the patched contribution must stay schema-valid
  override config-unset <pack>/<section>/<key> [<field>...]
                      drop overridden fields (dotted names address nested fields), or the whole entry override when none
  override config-remove <pack>/<section>/<key>
                      make the pack contribute no such entry at all
Common options: --target <opencode-config-dir> (default $XDG_CONFIG_HOME/opencode), --global (applies to every target;
default: only this target), --no-reconcile, --yes. Settings live in $XDG_CONFIG_HOME/manage-agents/{routing,overrides}.json.`

function splitPackId(spec: string): [string, string] {
  const slash = spec.indexOf("/")
  if (slash <= 0 || slash === spec.length - 1) throw new Error(`"${spec}" must be <pack>/<id>`)
  return [spec.slice(0, slash), spec.slice(slash + 1)]
}

function parseAssignments(items: string[], parseValue: (raw: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of items) {
    const equals = item.indexOf("=")
    if (equals <= 0) throw new Error(`"${item}" must be <name>=<value>`)
    Object.defineProperty(out, item.slice(0, equals), { value: parseValue(item.slice(equals + 1)), enumerable: true, writable: true, configurable: true })
  }
  return out
}

/** Turns "a.b=v" assignments into a nested patch: config override field names may be dotted paths. */
function expandDottedAssignments(assignments: Record<string, unknown>): Record<string, unknown> {
  const defineOwn = (object: Record<string, unknown>, key: string, value: unknown) =>
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(assignments)) {
    const parts = name.split(".")
    let cursor = out
    for (const part of parts.slice(0, -1)) {
      const next = Object.hasOwn(cursor, part) ? cursor[part] : undefined
      if (typeof next !== "object" || next === null || Array.isArray(next)) defineOwn(cursor, part, {})
      cursor = cursor[part] as Record<string, unknown>
    }
    defineOwn(cursor, parts[parts.length - 1], value)
  }
  return out
}

/** Splits "<pack>/<section>/<key>": the section has no slash, the key may contain one. */
function splitConfigSpec(spec: string): [string, ConfigSection, string] {
  const [pack, rest] = splitPackId(spec)
  const slash = rest.indexOf("/")
  if (slash <= 0 || slash === rest.length - 1) throw new Error(`"${spec}" must be <pack>/<section>/<key> with section in {${CONFIG_SECTIONS.join(", ")}}`)
  const section = rest.slice(0, slash)
  if (!(CONFIG_SECTIONS as readonly string[]).includes(section)) throw new Error(`unknown config section "${section}" (allowed: ${CONFIG_SECTIONS.join(", ")})`)
  return [pack, section as ConfigSection, rest.slice(slash + 1)]
}

async function runSettingsCLI(command: "models" | "override") {
  const [action, ...rest] = process.argv.slice(3)
  if (!action || action === "--help" || action === "-h" || rest.includes("--help")) {
    console.log(SETTINGS_USAGE)
    if (!action) process.exitCode = 2
    return
  }
  const multiFlags = command === "models" && action === "rule-set" ? new Set(["--model", "--tool", "--perm", "--delegate"]) : new Set<string>()
  const collectedMulti: Record<string, string[]> = {}
  const filteredRest: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (multiFlags.has(token)) {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) return cliError(`${token} needs a value\n${SETTINGS_USAGE}`)
      ;(collectedMulti[token] ??= []).push(...rest[++i].split(",").map(s => s.trim()).filter(Boolean))
    } else {
      filteredRest.push(token)
    }
  }
  const valued = ["--target", ...(command === "models" ? ["--callers", "--index", "--dir"] : [])]
  const booleans = ["--global", "--no-reconcile", "--yes", "--json", ...(command === "override" ? ["--command"] : ["--unset"])]
  const parsed = parseCliArgs(filteredRest, valued, booleans)
  if (typeof parsed === "string") return cliError(`${parsed}\n${SETTINGS_USAGE}`)
  try {
    const target = realpathThroughExistingAncestor(path.resolve(parsed.values["--target"] ?? defaultTarget()))
    const scopeTarget = parsed.flags.has("--global") ? null : target
    const scopeLabel = scopeTarget === null ? "every target" : terminalSafeText(target)
    const [first, ...others] = parsed.positional
    if (action === "show") {
      const settings = command === "models" ? loadRoutingSettings() : loadOverrideSettings()
      const view = { default: settings.default, target: settings.targets[target] ?? {} }
      const routingFile = path.join(target, "plugins", "manage-agents-router", "routing.json")
      const installed = command === "models" && fs.existsSync(routingFile) ? JSON.parse(fs.readFileSync(routingFile, "utf8")) : null
      if (parsed.flags.has("--json")) return printJson(command === "models" ? { ...view, installed } : view)
      console.log(`Settings for every target:\n${JSON.stringify(view.default, null, 2)}`)
      console.log(`Settings for ${terminalSafeText(target)} (win over the above):\n${JSON.stringify(view.target, null, 2)}`)
      if (command === "models") console.log(installed ? `Installed routing (packs' defaults + settings):\n${JSON.stringify(installed.archetypes, null, 2)}` : "No archetype or conditional flow is active in this target.")
      return
    }
    if (command === "models" && action === "export-pack") {
      if (!first) return cliError(`usage: models export-pack <pack> [--dir <workspace-or-pack-dir>]\n${SETTINGS_USAGE}`)
      const wsRoot = parsed.values["--dir"] ? path.resolve(parsed.values["--dir"]) : (findWorkspace(process.cwd()) ?? process.cwd())
      const flowView = describeConfiguredPackFlows(wsRoot, first, { target })
      if (!flowView) return cliError(`pack "${first}" was not found in ${terminalSafeText(wsRoot)}`, 1)
      const manifestPath = exportFlowsToPackManifest(wsRoot, flowView)
      console.log(`Exported callers and conditional flows of ${terminalSafeText(first)} to ${terminalSafeText(manifestPath)}.`)
      return
    }
    let message: string
    if (command === "models") {
      if (action === "set" || action === "unset") {
        if (!first || (!others.length && action === "set")) return cliError(`usage: models ${action} <pack> <trigger> ...\n${SETTINGS_USAGE}`)
        const [trigger, ...assignments] = others
        const settings = loadRoutingSettings()
        const scope = scopeOf(settings, scopeTarget)
        if (action === "set") setRoutes(scope, first, trigger, parseAssignments(assignments, raw => raw) as Record<string, string>)
        else if (!unsetRoutes(scope, first, trigger ?? "", assignments)) return cliError(`no routing for ${first} ${trigger ?? ""} in ${scopeLabel}`, 1)
        saveRoutingSettings(settings)
        message = `Routing of ${terminalSafeText(first)} for ${terminalSafeText(trigger)} updated for ${scopeLabel}.`
      } else if (action === "callers") {
        if (!first || (!parsed.flags.has("--unset") && !others.length)) {
          return cliError(`usage: models callers <pack> <caller>... | models callers <pack> --unset\n${SETTINGS_USAGE}`)
        }
        const settings = loadRoutingSettings()
        const scope = scopeOf(settings, scopeTarget)
        const callers = parsed.flags.has("--unset") ? null : others.flatMap(item => item.split(",").map(s => s.trim()).filter(Boolean))
        const changed = setPackCallers(scope, first, callers)
        if (!changed && callers === null) return cliError(`no custom callers set for ${first} in ${scopeLabel}`, 1)
        saveRoutingSettings(settings)
        message = callers ? `Callers (OR) of ${terminalSafeText(first)} set to [${callers.map(terminalSafeText).join(", ")}] for ${scopeLabel}.` : `Custom callers of ${terminalSafeText(first)} cleared for ${scopeLabel}.`
      } else if (action === "rule-set") {
        if (!first || !others[0]) return cliError(`usage: models rule-set <pack> <trigger[,trigger2...]> [--model ...] [--tool ...] [--perm ...] [--delegate ...]\n${SETTINGS_USAGE}`)
        const triggers = parseTriggerList(others[0])
        const callers = parsed.values["--callers"] ? parsed.values["--callers"].split(",").map(s => s.trim()).filter(Boolean) : undefined
        const then: ConditionalPolicy = {}
        if (collectedMulti["--model"]?.length) then.models = parseAssignments(collectedMulti["--model"], raw => raw) as Record<string, string>
        if (collectedMulti["--tool"]?.length) then.tools = parseAssignments(collectedMulti["--tool"], raw => raw) as Record<string, PolicyEffect>
        if (collectedMulti["--perm"]?.length) then.permissions = parseAssignments(collectedMulti["--perm"], raw => raw) as Record<string, PolicyEffect>
        if (collectedMulti["--delegate"]?.length) then.delegations = parseAssignments(collectedMulti["--delegate"], raw => raw) as Record<string, DelegationEffect>
        const { rule, error: ruleErr } = validateConditionalRule({ ...(callers?.length ? { callers } : {}), triggers, then }, `${first}`)
        if (ruleErr || !rule) return cliError(ruleErr ?? "invalid rule", 1)
        const settings = loadRoutingSettings()
        const scope = scopeOf(settings, scopeTarget)
        const existing = [...(scope[first]?.$rules ?? [])]
        if (parsed.values["--index"] !== undefined) {
          const idx = Number(parsed.values["--index"])
          if (!Number.isInteger(idx) || idx < 0 || idx > existing.length) return cliError(`invalid --index ${parsed.values["--index"]} (0..${existing.length})`, 1)
          existing[idx] = rule
        } else {
          existing.push(rule)
        }
        setPackRules(scope, first, existing)
        saveRoutingSettings(settings)
        message = `Conditional flow of ${terminalSafeText(first)} on [${triggers.map(terminalSafeText).join(" OR ")}] saved for ${scopeLabel}.`
      } else if (action === "rule-unset") {
        if (!first) return cliError(`usage: models rule-unset <pack> [<index|all>]\n${SETTINGS_USAGE}`)
        const which = others[0] ?? "all"
        const settings = loadRoutingSettings()
        const scope = scopeOf(settings, scopeTarget)
        const existing = [...(scope[first]?.$rules ?? [])]
        if (!existing.length) return cliError(`no conditional rules for ${first} in ${scopeLabel}`, 1)
        if (which === "all") {
          setPackRules(scope, first, null)
        } else {
          const idx = Number(which)
          if (!Number.isInteger(idx) || idx < 0 || idx >= existing.length) return cliError(`invalid rule index "${which}" (0..${existing.length - 1})`, 1)
          existing.splice(idx, 1)
          setPackRules(scope, first, existing)
        }
        saveRoutingSettings(settings)
        message = `Conditional rule(s) of ${terminalSafeText(first)} updated for ${scopeLabel}.`
      } else if (action === "pin" || action === "unpin") {
        if (!first || (action === "pin" ? others.length !== 1 : others.length)) return cliError(`usage: models ${action} <pack>/<agent>${action === "pin" ? " <provider/model[#variant]>" : ""}`)
        const [pack, agent] = splitPackId(first)
        const settings = loadOverrideSettings()
        setOverride(scopeOf(settings, scopeTarget), pack, "agents", agent, { model: action === "pin" ? others[0] : null })
        saveOverrideSettings(settings)
        message = action === "pin" ? `${terminalSafeText(first)} is pinned to ${terminalSafeText(others[0])} for ${scopeLabel}.` : `${terminalSafeText(first)} has no fixed model for ${scopeLabel}: it follows routing.`
      } else return cliError(`unknown models command ${terminalSafeText(action)}\n${SETTINGS_USAGE}`)
    } else if (action === "config-set" || action === "config-unset" || action === "config-remove") {
      if (!first || (action === "config-set" && !others.length)) {
        return cliError(`usage: override ${action} <pack>/<section>/<key>${action === "config-set" ? " <field>=<value>..." : " [<field>...]"}\n${SETTINGS_USAGE}`)
      }
      const [pack, section, key] = splitConfigSpec(first)
      const settings = loadOverrideSettings()
      const scope = scopeOf(settings, scopeTarget)
      if (action === "config-set") {
        setConfigOverride(scope, pack, section, key, expandDottedAssignments(parseAssignments(others, raw => YAML.parse(raw))))
        message = `Config override of ${terminalSafeText(first)} updated for ${scopeLabel}.`
      } else if (action === "config-remove") {
        removeConfigEntry(scope, pack, section, key)
        message = `Config entry ${terminalSafeText(first)} is no longer contributed by the pack for ${scopeLabel}.`
      } else if (!unsetConfigOverride(scope, pack, section, key, others)) {
        return cliError(`no config override for ${first} in ${scopeLabel}`, 1)
      } else {
        message = `Config override of ${terminalSafeText(first)} updated for ${scopeLabel}.`
      }
      saveOverrideSettings(settings)
    } else {
      if (action !== "set" && action !== "unset") return cliError(`unknown override command ${terminalSafeText(action)}\n${SETTINGS_USAGE}`)
      if (!first || (action === "set" && !others.length)) return cliError(`usage: override ${action} <pack>/<id> ...\n${SETTINGS_USAGE}`)
      const [pack, id] = splitPackId(first)
      const kind = parsed.flags.has("--command") ? "commands" : "agents"
      const settings = loadOverrideSettings()
      const scope = scopeOf(settings, scopeTarget)
      if (action === "set") setOverride(scope, pack, kind, id, parseAssignments(others, raw => YAML.parse(raw)))
      else if (!unsetOverride(scope, pack, kind, id, others)) return cliError(`no override for ${first} in ${scopeLabel}`, 1)
      saveOverrideSettings(settings)
      message = `Override of ${terminalSafeText(first)} updated for ${scopeLabel}.`
    }
    const json = parsed.flags.has("--json")
    if (!json) console.log(message)
    if (parsed.flags.has("--no-reconcile")) {
      if (json) printJson({ updated: true, message, reconciled: false })
      else console.log("Not reconciled: run `manage-agents reconcile` to apply it.")
      return
    }
    if (!readLock(target)) {
      if (json) printJson({ updated: true, message, reconciled: false, target })
      else console.log(`Nothing is installed in ${terminalSafeText(target)}; the setting applies at the next install.`)
      return
    }
    const registry = loadSources()
    const result = await changeTarget(target, command, registry, reconcileChange, { confirm: (reasons: string[]) => confirmInTerminal(reasons, parsed.flags.has("--yes"), json) })
    printChangeResult("reconcile", target, result, json)
    if (scopeTarget === null && !json) console.log("Other targets pick the change up at their next `manage-agents reconcile --target <dir>`.")
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}

/** The pack catalog (a directory with packs/<name>/opencode-pack.json) or single pack the agent commands and the TUI edit. */
function isWorkspaceRoot(dir: string): boolean {
  return !discoverPackDirs(dir).next().done || isVirtualPackRoot(dir)
}

export function findWorkspace(start: string): string | null {
  const resolvedStart = path.resolve(start)
  for (let dir = resolvedStart; ; dir = path.dirname(dir)) {
    const packs = path.join(dir, "packs")
    if (fs.lstatSync(packs, { throwIfNoEntry: false })?.isDirectory() && !discoverPackDirs(packs, 1).next().done) return dir
    if (fs.existsSync(path.join(dir, "opencode-pack.json"))) return dir
    if (fs.existsSync(path.join(dir, ".git"))) {
      // Only search this repository. The engine's bundled contract example is not a user catalog.
      if (dir !== resolveEngineRoot() && !discoverPackDirs(dir).next().done) return dir
      break
    }
    if (path.dirname(dir) === dir) break
  }
  return isVirtualPackRoot(resolvedStart) ? resolvedStart : null
}

const VERSION_USAGE = `Usage: manage-agents version [--json] [--engine-root <dir>]
       manage-agents version --write-manifest --ref-type <tag|branch> --ref-name <name> --sha <sha> [--engine-root <dir>] [--json]`

const SELF_UPDATE_USAGE = `Usage: manage-agents self-update [--check] [--yes|-y] [--force] [--allow-unsigned] [--reconcile|--no-reconcile] [--repo <owner/repo>] [--target <dir>] [--engine-root <dir>] [--json]
       manage-agents update --self [...]
Checks or installs the latest GitHub Release of manage-agents into its installation directory, verifying SHA-256 and bundle hash (plus Ed25519 signature when release-signing.json is configured).`

const RELEASE_USAGE = `Usage: manage-agents release keygen [--out <private-key-file>] [--key-id <id>] [--repo <owner/repo>] [--replace-keys] [--engine-root <dir>] [--json]
       manage-agents release sign --tag <tag> --sha <sha> --assets-dir <dir> [--repo <owner/repo>] [--private-key-file <file>] [--engine-root <dir>] [--allow-unsigned] [--json]`

async function runVersionCLI(rawArgs = process.argv.slice(3)) {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) return console.log(VERSION_USAGE)
  const parsed = parseCliArgs(rawArgs, ["--ref-type", "--ref-name", "--sha", "--engine-root"], ["--json", "--write-manifest"])
  if (typeof parsed === "string") return cliError(`${parsed}\n${VERSION_USAGE}`)
  if (parsed.positional.length) return cliError(`version takes no positional arguments\n${VERSION_USAGE}`)
  try {
    const engineRoot = parsed.values["--engine-root"]
    const json = parsed.flags.has("--json")
    if (parsed.flags.has("--write-manifest")) {
      const refType = parsed.values["--ref-type"]
      const refName = parsed.values["--ref-name"]
      const sha = parsed.values["--sha"]
      if (!refType || !refName || !sha) {
        return cliError(`version --write-manifest requires --ref-type, --ref-name, and --sha\n${VERSION_USAGE}`)
      }
      const manifest = writeEngineReleaseManifest(engineRoot, { refType, refName, sha })
      if (json) printJson(manifest)
      else console.log(`Wrote release manifest: ${terminalSafeText(manifest.version)} (${terminalSafeText(manifest.shortCommit)})`)
      return
    }
    const info = resolveEngineVersion(engineRoot)
    if (json) {
      printJson(info)
      return
    }
    console.log(`Version: ${terminalSafeText(info.displayVersion)}`)
    console.log(`Channel: ${terminalSafeText(info.channel)}`)
    console.log(`Dirty: ${info.dirty ? "yes" : "no"}`)
    console.log(`Engine root: ${terminalSafeText(info.engineRoot)}`)
    console.log(`Bundle hash: ${terminalSafeText(info.bundleHash)}`)
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}

async function runSelfUpdateCLI(rawArgs = process.argv.slice(3)) {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) return console.log(SELF_UPDATE_USAGE)
  const normalized = rawArgs.map(arg => (arg === "-y" ? "--yes" : arg))
  const parsed = parseCliArgs(
    normalized,
    ["--repo", "--target", "--engine-root"],
    ["--check", "--yes", "--force", "--allow-unsigned", "--reconcile", "--no-reconcile", "--json"],
  )
  if (typeof parsed === "string") return cliError(`${parsed}\n${SELF_UPDATE_USAGE}`)
  if (parsed.positional.length) return cliError(`self-update takes no pack names (use 'manage-agents update <pack>' for packs)\n${SELF_UPDATE_USAGE}`)
  if (parsed.flags.has("--reconcile") && parsed.flags.has("--no-reconcile")) {
    return cliError(`cannot combine --reconcile and --no-reconcile\n${SELF_UPDATE_USAGE}`)
  }
  try {
    const engineRoot = parsed.values["--engine-root"]
    const repository = parsed.values["--repo"]
    const target = parsed.values["--target"]
    const json = parsed.flags.has("--json")
    const force = parsed.flags.has("--force")
    const allowUnsigned = parsed.flags.has("--allow-unsigned")
    const assumeYes = parsed.flags.has("--yes")
    const reconcile = parsed.flags.has("--no-reconcile") ? false : parsed.flags.has("--reconcile") ? true : undefined

    const checkResult = await checkForEngineUpdate(engineRoot, { repository, target, allowUnsigned })
    if (parsed.flags.has("--check")) {
      if (checkResult.downgrade && !force) process.exitCode = 1
      if (json) {
        printJson(checkResult)
      } else {
        console.log(`Current version: ${terminalSafeText(checkResult.currentVersion.displayVersion)}`)
        console.log(`Latest release:  ${terminalSafeText(checkResult.metadata.tag)} (${terminalSafeText(checkResult.metadata.commit.slice(0, 7))})`)
        console.log(`Verification:    ${checkResult.verificationMode === "ed25519" ? `Ed25519 (${terminalSafeText(checkResult.metadata.keyId ?? "")})` : "SHA-256 + bundle manifest"}`)
        console.log(`Archive:         ${terminalSafeText(checkResult.metadata.archive.name)} (${terminalSafeText(checkResult.metadata.archive.sha256)})`)
        console.log(`Update available: ${checkResult.updateAvailable ? "yes" : checkResult.downgrade ? "no (installed version is newer)" : "no"}`)
      }
      return
    }

    if (checkResult.downgrade && !force) {
      const msg = `Latest release ${terminalSafeText(checkResult.metadata.tag)} is older than installed ${terminalSafeText(checkResult.currentVersion.displayVersion)}; pass --force to downgrade.`
      process.exitCode = 1
      if (json) printJson({ updated: false, applied: false, downgrade: true, checkResult })
      else console.log(msg)
      return
    }

    if (!checkResult.updateAvailable && !force && reconcile !== true) {
      if (json) printJson({ updated: false, applied: false, checkResult })
      else console.log(`manage-agents is already up to date (${terminalSafeText(checkResult.currentVersion.displayVersion)}).`)
      return
    }

    if (!assumeYes) {
      if (json || !process.stdin.isTTY || !process.stdout.isTTY) {
        return cliError("self-update requires --yes when running without an interactive terminal or with --json.", 1)
      }
      const answer = await askQuestion(
        `Update manage-agents ${terminalSafeText(checkResult.currentVersion.displayVersion)} -> ${terminalSafeText(checkResult.metadata.tag)}? [Y/n] `,
      )
      if (answer !== "" && !/^y(es)?$/i.test(answer)) {
        console.log("Self-update cancelled.")
        return
      }
    }

    const result = await applyEngineUpdate(engineRoot, {
      force,
      reconcile,
      target,
      repository,
      allowUnsigned,
      checkResult,
      onProgress: json ? undefined : msg => console.log(terminalSafeText(msg)),
    })

    if (result.reconcileResult && (result.reconcileResult.status === "failed" || result.reconcileResult.status === "declined")) process.exitCode = 1
    if (json) {
      printJson(result)
      return
    }
    console.log(`Updated manage-agents: ${terminalSafeText(result.checkResult.currentVersion.displayVersion)} -> ${terminalSafeText(result.versionInfo.displayVersion)}`)
    if (result.dependenciesInstalled) console.log("Dependencies synchronized.")
    if (result.reconcileResult) console.log(`OpenCode target reconciled (${terminalSafeText(result.reconcileResult.status)}).`)
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}

async function runReleaseCLI(rawArgs = process.argv.slice(3)) {
  const action = rawArgs[0]
  if (!action || action === "--help" || action === "-h" || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    return console.log(RELEASE_USAGE)
  }
  if (action !== "keygen" && action !== "sign") {
    return cliError(`release requires 'keygen' or 'sign'\n${RELEASE_USAGE}`)
  }
  const rest = rawArgs.slice(1)
  try {
    if (action === "keygen") {
      const parsed = parseCliArgs(rest, ["--out", "--key-id", "--repo", "--engine-root"], ["--replace-keys", "--json"])
      if (typeof parsed === "string") return cliError(`${parsed}\n${RELEASE_USAGE}`)
      if (parsed.positional.length) return cliError(`release keygen takes no positional arguments\n${RELEASE_USAGE}`)
      const engineRoot = parsed.values["--engine-root"]
      const res = generateReleaseSigningKeypair(engineRoot, {
        outPrivateKeyPath: parsed.values["--out"] ?? ".release-key.pem",
        keyId: parsed.values["--key-id"],
        repository: parsed.values["--repo"],
        replaceKeys: parsed.flags.has("--replace-keys"),
      })
      if (parsed.flags.has("--json")) {
        printJson({
          keyId: res.keyId,
          publicKeyPem: res.publicKeyPem,
          configPath: res.configPath,
          privateKeyPath: res.privateKeyPath,
        })
      } else {
        console.log(`Generated Ed25519 release signing key: ${terminalSafeText(res.keyId)}`)
        console.log(`Public trust config: ${terminalSafeText(res.configPath)}`)
        if (res.privateKeyPath) console.log(`Private key file (0600): ${terminalSafeText(res.privateKeyPath)}`)
        console.log("Store the private key as RELEASE_SIGNING_PRIVATE_KEY in your GitHub Actions 'release' environment.")
      }
      return
    }

    const parsed = parseCliArgs(rest, ["--tag", "--sha", "--assets-dir", "--repo", "--private-key-file", "--engine-root"], ["--allow-unsigned", "--json"])
    if (typeof parsed === "string") return cliError(`${parsed}\n${RELEASE_USAGE}`)
    if (parsed.positional.length) return cliError(`release sign takes no positional arguments\n${RELEASE_USAGE}`)
    const tag = parsed.values["--tag"]
    const sha = parsed.values["--sha"]
    const assetsDir = parsed.values["--assets-dir"]
    if (!tag || !sha || !assetsDir) return cliError(`release sign requires --tag, --sha, and --assets-dir\n${RELEASE_USAGE}`)
    const privateKeyPem = parsed.values["--private-key-file"] ? fs.readFileSync(parsed.values["--private-key-file"], "utf8") : undefined
    const res = signReleaseAssets(parsed.values["--engine-root"], {
      tag,
      sha,
      assetsDir,
      repository: parsed.values["--repo"],
      privateKeyPem,
      allowUnsigned: parsed.flags.has("--allow-unsigned"),
    })
    if (parsed.flags.has("--json")) {
      printJson(res)
    } else {
      console.log(`Wrote release metadata: ${terminalSafeText(res.metadataPath)}`)
      if (res.signaturePath) console.log(`Signed Ed25519 (${terminalSafeText(res.metadata.keyId ?? "")}): ${terminalSafeText(res.signaturePath)}`)
      else console.log("Unsigned SHA-256 metadata mode (no release-signing.json / RELEASE_SIGNING_PRIVATE_KEY configured).")
    }
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}

const COMMANDS = ["pack", "source", "resolve", "install", "uninstall", "update", "self-update", "version", "release", "reconcile", "status", "restore", "models", "override", "create", "lint", "fix-names", "audit", "tune", "bridge"]
const WORKSPACE_COMMANDS: Record<string, (workspaceRoot: string) => Promise<void>> = {
  create: workspaceRoot => runCreate(workspaceRoot),
  lint: runLint,
  "fix-names": runFixNames,
  audit: runAudit,
  tune: runTuneCLI,
  bridge: runBridge,
}

async function run() {
  const autoCommit = parseAutoCommitArgs(process.argv.slice(2))
  process.env.AGENT_MANAGER_AUTO_COMMIT = autoCommit.enabled ? "1" : "0"
  process.argv = [...process.argv.slice(0, 2), ...autoCommit.argv]
  const workspaceFlag = process.argv.indexOf("--workspace")
  const explicitWorkspace = workspaceFlag === -1 ? process.env.MANAGE_AGENTS_WORKSPACE : process.argv[workspaceFlag + 1]
  if (workspaceFlag !== -1) process.argv.splice(workspaceFlag, 2)
  const sourceFlag = process.argv.indexOf("--source")
  const explicitSource = sourceFlag === -1 ? undefined : process.argv[sourceFlag + 1]
  if (sourceFlag !== -1) process.argv.splice(sourceFlag, 2)
  const command = process.argv[2]

  if (command === "--version" || command === "-v" || command === "-V") {
    return runVersionCLI(process.argv.slice(3))
  }
  if (command === "--help" || command === "-h") {
    console.log("Usage: manage-agents [<command>] [options] [--workspace <catalog-or-pack-dir>] [--source <registered-source>]")
    console.log(`Commands: ${COMMANDS.join(", ")}. Without a command the TUI opens on the workspace, active source, or Data Sources screen.`)
    console.log("The workspace (for create, lint, fix-names, audit, tune, bridge) is --workspace, $MANAGE_AGENTS_WORKSPACE, or the nearest pack catalog or pack above the current directory.")
    return
  }
  if (command === "version") return runVersionCLI()
  if (command === "self-update") return runSelfUpdateCLI()
  if (command === "release") return runReleaseCLI()
  if (command === "pack") return runPackCLI()
  if (command === "source") return runSourceCLI()
  if (command === "resolve") return runResolveCLI()
  if (command === "models" || command === "override") return runSettingsCLI(command)
  if (command === "install" || command === "uninstall" || command === "update" || command === "reconcile" || command === "status" || command === "restore") return runTargetCLI(command)
  if (command && !command.startsWith("-") && !WORKSPACE_COMMANDS[command]) return cliError(`unknown command ${terminalSafeText(command)}; run manage-agents --help`)

  if (command) {
    const workspaceRoot = explicitWorkspace ? path.resolve(explicitWorkspace) : findWorkspace(process.cwd())
    if (!workspaceRoot || (explicitWorkspace && !isWorkspaceRoot(workspaceRoot))) {
      return cliError(`no pack catalog or pack found${explicitWorkspace ? ` at ${terminalSafeText(explicitWorkspace)}` : " above the current directory"}; pass --workspace <dir> (a pack, a catalog containing pack manifests, or a folder of OpenCode agents)`, 1)
    }
    return command === "bridge" ? runBridge(workspaceRoot, explicitSource) : WORKSPACE_COMMANDS[command](workspaceRoot)
  }

  let tuiWorkspaceRoot: string | undefined
  let initialSource: Source | undefined
  let startupNotice: string | undefined

  if (explicitWorkspace) {
    const resolved = path.resolve(explicitWorkspace)
    if (!isWorkspaceRoot(resolved)) {
      return cliError(`no pack catalog or pack found at ${terminalSafeText(explicitWorkspace)}; pass --workspace <dir> (a pack, a catalog containing pack manifests, or a folder of OpenCode agents)`, 1)
    }
    tuiWorkspaceRoot = resolved
  } else if (explicitSource !== undefined) {
    if (!explicitSource) return cliError("--source requires a source name", 2)
    const registry = loadSources()
    const chosen = findSource(registry, explicitSource)
    if (chosen.kind === "git" && !fs.existsSync(path.join(sourceRoot(chosen), ".git"))) {
      try {
        pullSource(chosen)
        initialSource = chosen
      } catch (error) {
        startupNotice = `Could not pull "${chosen.name}": ${error instanceof Error ? error.message : String(error)}`
      }
    } else {
      initialSource = chosen
    }
    if (initialSource && registry.active !== chosen.name) {
      registry.active = chosen.name
      saveSources(registry)
    }
  } else {
    const discovered = findWorkspace(process.cwd())
    if (discovered) {
      tuiWorkspaceRoot = discovered
    } else {
      try {
        const registry = loadSources()
        const chosen = (registry.active ? registry.sources.find(s => s.name === registry.active) : undefined) ?? registry.sources[0]
        if (chosen) {
          if (chosen.kind === "git" && !fs.existsSync(path.join(sourceRoot(chosen), ".git"))) {
            try {
              pullSource(chosen)
              initialSource = chosen
            } catch (error) {
              startupNotice = `Could not pull "${chosen.name}": ${error instanceof Error ? error.message : String(error)}`
            }
          } else if (chosen.kind === "local" && !fs.existsSync(chosen.path)) {
            startupNotice = `Local source "${chosen.name}" does not exist on disk (${chosen.path}).`
          } else {
            initialSource = chosen
          }
        }
      } catch (error) {
        startupNotice = error instanceof Error ? error.message : String(error)
      }
    }
  }

  const uiConfig = loadUiConfig()
  if (uiConfig.warning) console.error(`UI CONFIG WARNING: ${uiConfig.warning}`)
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen"
  })

  const root = createRoot(renderer)
  root.render(
    <App
      workspaceRoot={tuiWorkspaceRoot}
      initialSource={initialSource}
      startupNotice={startupNotice}
      listShare={uiConfig.config.listShare}
      reducedMotion={uiConfig.config.reducedMotion}
      uiConfigWarning={uiConfig.warning}
      configReadOnly={uiConfig.readOnly}
      uiConfigRevision={uiConfig.revision}
    />
  )
}

const IS_CLI_ENTRYPOINT = /(?:^|[\\/])(?:manage-agents\.mjs|index\.(?:js|tsx))$/.test(process.argv[1] ?? "")
if (IS_CLI_ENTRYPOINT) {
  run().catch((error) => {
    console.error(`✗ Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
