import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { atomicWriteRestrictedFile } from "./agents.js"
import { prepareBridgeWorkspace } from "./bridgeWorkspace.js"
import { spawnRunner, type CliRunner } from "./claudePluginCli.js"
import { writeCodexPlugin } from "./codexBridge.js"
import { withTargetLock } from "./installer.js"
import { assertSafeTargetSubpath } from "./lock.js"
import { parsePackRequest, resolvePacks, type ResolvedPack } from "./resolver.js"
import { discoverAllPacks, findSource, loadSources, sourceRoot } from "./sources.js"
import { sourceTranslationConfigLocation } from "./sourceCustomization.js"
import { loadTranslationConfig } from "./translationConfig.js"

const hash = (bytes: string | Buffer) => crypto.createHash("sha256").update(bytes).digest("hex")
const write = (file: string, content: string) => atomicWriteRestrictedFile(file, Buffer.from(content))
const read = (file: string) => fs.readFileSync(file, "utf8")
const stateDir = ".manage-agents/codex-plugins"
type Receipt = { executableHash: string; roles: Record<string, string> }

function dependencies(root: ResolvedPack, packs: ResolvedPack[]): ResolvedPack[] {
  const names = new Set([root.name])
  // The resolver orders dependencies before each dependent.
  for (const pack of [...packs].reverse()) {
    if (names.has(pack.name)) for (const name of Object.keys(pack.requires)) names.add(name)
  }
  return packs.filter(pack => names.has(pack.name))
}

function treeHash(root: string): string {
  const digest = crypto.createHash("sha256")
  for (const rel of fs.readdirSync(root, { recursive: true, encoding: "utf8" }).sort()) {
    const file = assertSafeTargetSubpath(root, rel.split(path.sep).join("/"))
    const st = fs.lstatSync(file)
    if (st.isDirectory()) continue
    if (!st.isFile()) throw new Error(`Unexpected plugin entry: ${file}`)
    digest.update(JSON.stringify([rel, st.mode & 0o111, hash(fs.readFileSync(file))]))
  }
  return digest.digest("hex")
}

function codex(args: string[], runner: CliRunner) {
  const result = runner("codex", args)
  if (result.status !== 0) throw new Error(`codex ${args.slice(0, 3).join(" ")}: ${result.error?.message || result.stderr.trim() || result.stdout.trim() || "failed"}`)
  return result.stdout
}

interface InstallOptions {
  dryRun?: boolean
  source?: string
  workspace?: string
  confirm: (reasons: string[]) => Promise<boolean>
  runner?: CliRunner
}

export async function installCodexPacks(specs: string[], options: InstallOptions) {
  const profile = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
  const registry = loadSources()
  const requests = specs.map(parsePackRequest)
  let selectedSource = options.source
  if (options.workspace) {
    const root = fs.realpathSync(options.workspace)
    const matched = registry.sources.find(source => {
      const dir = sourceRoot(source)
      return fs.existsSync(dir) && fs.realpathSync(dir) === root
    })
    if (selectedSource && selectedSource !== matched?.name) throw new Error("--workspace and --source select different catalogs")
    if (matched) selectedSource = matched.name
    else {
      selectedSource = `workspace-${hash(root).slice(0, 16)}`
      if (registry.sources.some(s => s.name === selectedSource)) throw new Error(`Workspace source name already exists: ${selectedSource}`)
      registry.sources.push({ name: selectedSource, kind: "local", path: root, trusted: false })
    }
  }
  for (const request of requests) {
    if (!selectedSource) continue
    if (request.source && request.source !== selectedSource) throw new Error(`Conflicting sources for ${request.name}`)
    request.source = selectedSource
  }
  if (!requests.length) throw new Error("install --codex needs at least one pack")
  const { candidates, problems } = discoverAllPacks(registry)
  const resolved = resolvePacks(requests, candidates, { prefer: registry.prefer })
  if (resolved.problems.length) throw new Error([...resolved.problems, ...problems].join("\n"))
  const work = async () => {
    const cleanups: Array<() => void> = []
    const confirmations: string[] = []
    const pendingRoles = new Set<string>()
    try {
      const plans = resolved.packs.filter(pack => pack.root).map(root => {
        const pack = root.name
        const catalog = sourceRoot(findSource(registry, root.source))
        const selected = dependencies(root, resolved.packs)
        const workspace = prepareBridgeWorkspace(catalog, pack, process.env, "codex", selected)
        cleanups.push(workspace.cleanup)
        const location = sourceTranslationConfigLocation(root.source, catalog)
        const config = loadTranslationConfig(catalog, fs.existsSync(location.readPath) ? location.readPath : undefined, { persistMigration: false })
        const generatedDir = fs.mkdtempSync(path.join(workspace.root, ".codex-install-"))
        const result = writeCodexPlugin(workspace.agents, pack, pack + "-", generatedDir, workspace.root, config, undefined, pack + "-")
        const receiptFile = assertSafeTargetSubpath(profile, `${stateDir}/${pack}/receipt.json`)
        const previous: Receipt | undefined = fs.existsSync(receiptFile) ? JSON.parse(read(receiptFile)) : undefined
        const surface = crypto.createHash("sha256")
        const sensitive = result.files.filter(file => {
          const rel = path.relative(generatedDir, file).split(path.sep).join("/")
          return rel === ".mcp.json" || rel.startsWith("resources/") || (rel.startsWith(".agents/skills/") && !rel.endsWith("/SKILL.md"))
        })
        for (const item of selected) surface.update(JSON.stringify([item.name, item.source, item.executableHash]))
        for (const file of sensitive.sort()) surface.update(JSON.stringify([path.relative(generatedDir, file), hash(fs.readFileSync(file))]))
        const executableHash = surface.digest("hex")
        if (previous && previous.executableHash !== executableHash) confirmations.push(`${pack}: installed executable surface changed`)
        if (!previous) for (const entry of workspace.executable) {
          if (!selected.find(item => item.name === entry.pack)?.trusted) confirmations.push(`${pack}: untrusted ${entry.pack} (${entry.items.join(", ")})`)
        }
        const roles = Object.fromEntries(result.plugin.agents.map(agent => {
          const content = `# Generated by manage-agents for ${pack}\n` + read(path.join(generatedDir, ".codex", "agents", agent.filename))
          return [agent.filename, content]
        }))
        const checkRoles = () => {
          for (const name of new Set([...Object.keys(previous?.roles ?? {}), ...Object.keys(roles)])) {
            if (!/^[a-z0-9-]+\.toml$/.test(name) || !name.startsWith(pack + "-")) throw new Error(`Invalid managed role: ${name}`)
            const filename = assertSafeTargetSubpath(profile, `agents/${name}`)
            if (!fs.existsSync(filename)) continue
            const existing = read(filename)
            if (existing !== roles[name] && hash(existing) !== previous?.roles[name]) throw new Error(`Preserving edited or unmanaged Codex role: ${filename}`)
          }
        }
        checkRoles()
        for (const name of Object.keys(roles)) {
          if (pendingRoles.has(name)) throw new Error(`Several packs provide Codex role ${name}`)
          pendingRoles.add(name)
        }
        const hasPlugin = fs.existsSync(path.join(generatedDir, ".agents/plugins/marketplace.json"))
        return { pack, generatedDir, roles, checkRoles, receiptFile, previous, executableHash, hasPlugin,
          summary: { pack, plugin: hasPlugin ? `${pack}@${pack}-local` : null, roles: Object.keys(roles).length, skills: result.plugin.skills.length } }
      })
      const report = { profile, packs: plans.map(plan => plan.summary), confirmations }
      if (options.dryRun) return report
      if (confirmations.length && !await options.confirm(confirmations)) throw new Error("Codex installation needs confirmation; rerun with --yes")
      const run = options.runner ?? spawnRunner
      if (plans.some(plan => plan.hasPlugin)) {
        const installed = JSON.parse(codex(["plugin", "marketplace", "list", "--json"], run)).marketplaces
        for (const plan of plans.filter(plan => plan.hasPlugin)) {
          const current = installed.find(item => item.name === `${plan.pack}-local`)
          const managed = assertSafeTargetSubpath(profile, `${stateDir}/${plan.pack}/marketplace`)
          if (current && path.resolve(current.root) !== managed) throw new Error(`Marketplace ${current.name} already belongs to ${current.root}`)
        }
      }
      for (const plan of plans) {
        const { pack, generatedDir, roles } = plan
        if (plan.hasPlugin) {
          const relative = `${stateDir}/${pack}/marketplace`
          const market = assertSafeTargetSubpath(profile, relative)
          const revision = treeHash(generatedDir)
          const release = assertSafeTargetSubpath(profile, `${relative}/releases/${revision}`)
          if (fs.existsSync(release)) {
            if (treeHash(release) !== revision) throw new Error(`Modified managed Codex plugin: ${release}`)
          } else {
            fs.mkdirSync(path.dirname(release), { recursive: true })
            const staging = fs.mkdtempSync(path.join(path.dirname(release), ".stage-"))
            try {
              fs.cpSync(generatedDir, staging, { recursive: true })
              fs.renameSync(staging, release)
            } finally {
              fs.rmSync(staging, { recursive: true, force: true })
            }
          }
          const manifest = JSON.parse(read(path.join(generatedDir, ".agents/plugins/marketplace.json")))
          manifest.plugins[0].source.path = `./releases/${revision}`
          write(assertSafeTargetSubpath(profile, `${relative}/.agents/plugins/marketplace.json`), JSON.stringify(manifest, null, 2) + "\n")
          codex(["plugin", "marketplace", "add", market], run)
          codex(["plugin", "add", plan.summary.plugin], run)
        }
        plan.checkRoles()
        for (const [name, content] of Object.entries(roles)) {
          write(assertSafeTargetSubpath(profile, `agents/${name}`), content)
        }
        for (const name of Object.keys(plan.previous?.roles ?? {})) {
          if (!Object.hasOwn(roles, name)) fs.rmSync(assertSafeTargetSubpath(profile, `agents/${name}`), { force: true })
        }
        write(plan.receiptFile, JSON.stringify({ executableHash: plan.executableHash,
          roles: Object.fromEntries(Object.entries(roles).map(([name, content]) => [name, hash(content)])) }, null, 2) + "\n")
      }
      return report
    } finally {
      for (const cleanup of cleanups) cleanup()
    }
  }
  return options.dryRun ? work() : withTargetLock(profile, "install --codex", work)
}
