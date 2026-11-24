import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { installCodexPacks } from "./codexInstall.js"
import {
  changeTarget,
  installChange,
  reconcileChange,
  restoreBackup,
  uninstallChange,
  updateChange,
  type ChangeResult,
} from "./installer.js"
import { assertSafeTargetSubpath, serializeLock } from "./lock.js"
import type { SourceRegistry } from "./sources.js"

export interface TargetBackupSummary {
  id: string
  createdAt: string | null
  fileCount: number
  configCount: number
  files: string[]
}

export type TargetLifecycleOp = "install" | "update" | "uninstall" | "reconcile"

/** Lists valid `.manage-agents/backups/<id>` entries without following symlinks. */
export function listTargetBackups(target: string): TargetBackupSummary[] {
  const backupsRel = ".manage-agents/backups"
  const backupsDir = path.join(target, backupsRel)
  const stat = fs.lstatSync(backupsDir, { throwIfNoEntry: false })
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return []

  try {
    assertSafeTargetSubpath(target, backupsRel, { allowLeafSymlink: false })
  } catch {
    return []
  }

  const summaries: TargetBackupSummary[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (!/^[\w-]+$/.test(entry.name)) continue
    try {
      const jsonPath = assertSafeTargetSubpath(target, `${backupsRel}/${entry.name}/backup.json`, {
        allowLeafSymlink: false,
      })
      const fileStat = fs.lstatSync(jsonPath, { throwIfNoEntry: false })
      if (!fileStat?.isFile() || fileStat.isSymbolicLink()) continue
      const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"))
      if (!parsed || !Array.isArray(parsed.files) || !Array.isArray(parsed.config)) continue
      summaries.push({
        id: entry.name,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
        fileCount: parsed.files.length,
        configCount: parsed.config.length,
        files: parsed.files.filter((item: unknown): item is string => typeof item === "string"),
      })
    } catch {
      continue
    }
  }

  return summaries.sort((a, b) => b.id.localeCompare(a.id))
}

export function buildTargetCompute(
  operation: TargetLifecycleOp,
  registry: SourceRegistry,
  specs: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  switch (operation) {
    case "install":
      return installChange(registry, specs, env)
    case "update":
      return updateChange(registry, specs, env)
    case "uninstall":
      return uninstallChange(specs)
    case "reconcile":
      return reconcileChange
  }
}

export async function runTargetLifecycleOperation(
  target: string,
  operation: TargetLifecycleOp,
  registry: SourceRegistry,
  specs: string[],
  options: {
    dryRun?: boolean
    adopt?: boolean
    yes?: boolean
    confirm?: (reasons: string[]) => Promise<boolean>
    expectedLockText?: string
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<ChangeResult> {
  const baseCompute = buildTargetCompute(operation, registry, specs, options.env)
  const compute = options.expectedLockText !== undefined
    ? (current: Parameters<typeof baseCompute>[0]) => {
        const change = baseCompute(current)
        if (change.problems.length || serializeLock(change.lock) === options.expectedLockText) return change
        return { ...change, problems: [`the target state changed since the preview; rerun ${operation} to review`] }
      }
    : baseCompute
  return changeTarget(target, operation, registry, compute, {
    dryRun: options.dryRun,
    adopt: options.adopt,
    confirm: options.confirm ?? (options.yes ? async () => true : undefined),
    env: options.env,
  })
}

export async function runRestoreBackup(target: string, backupId: string) {
  return restoreBackup(target, backupId)
}

export interface CodexInstallPreviewResult {
  profile: string
  packs: Array<{ pack: string; plugin: string | null; roles: number; skills: number }>
  confirmations: string[]
}

export async function previewCodexInstall(
  specs: string[],
  options: { source?: string; workspace?: string },
): Promise<CodexInstallPreviewResult> {
  const result = await installCodexPacks(specs, {
    dryRun: true,
    source: options.source,
    workspace: options.workspace,
    confirm: async () => false,
  })
  return {
    profile: result.profile,
    packs: result.packs,
    confirmations: [...result.confirmations],
  }
}

export async function executeCodexInstall(
  specs: string[],
  options: { source?: string; workspace?: string; expectedConfirmations: readonly string[] },
) {
  return installCodexPacks(specs, {
    dryRun: false,
    source: options.source,
    workspace: options.workspace,
    confirm: async reasons => isDeepStrictEqual([...reasons].sort(), [...options.expectedConfirmations].sort()),
  })
}
