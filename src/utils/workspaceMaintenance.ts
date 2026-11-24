import path from "node:path"
import {
  analyzeAgentName,
  auditSecurityPermissions,
  renameAgent,
  type AgentInfo,
  type NamingAnalysis,
} from "./agents.js"
import { manifestName, packDir } from "./catalog.js"
import { discoverPackDirs, validatePack, type PackValidation } from "./packs.js"
import { AUTO_COMMIT_MESSAGES, repositoryTransaction } from "./repositoryTransaction.js"

export interface PackValidationEntry {
  packName: string
  dir: string
  validation: PackValidation
  errors: number
  warnings: number
}

export interface WorkspaceValidationReport {
  packs: PackValidationEntry[]
  totalErrors: number
  totalWarnings: number
}

export interface LintFinding {
  agent: AgentInfo
  analysis: NamingAnalysis
}

export interface WorkspaceLintReport {
  total: number
  compliant: number
  nonCompliant: LintFinding[]
}

export interface FixNamePlanItem {
  agent: AgentInfo
  fromFilename: string
  toFilename: string
  destination: string
}

export interface FixNameApplyResult {
  renamedCount: number
  updatedReferences: number
}

export function runWorkspaceValidate(
  workspaceRoot: string,
  packNames?: readonly string[],
): WorkspaceValidationReport {
  const dirs = packNames && packNames.length > 0
    ? packNames
        .map(name => ({ name, dir: packDir(workspaceRoot, name) }))
        .filter((entry): entry is { name: string; dir: string } => Boolean(entry.dir))
    : [...discoverPackDirs(workspaceRoot)]
        .map(dir => ({ name: manifestName(dir) ?? path.basename(dir), dir }))

  const packs: PackValidationEntry[] = dirs.map(({ name, dir }) => {
    const validation = validatePack(dir)
    const errors = validation.issues.filter(i => i.level === "error").length
    const warnings = validation.issues.filter(i => i.level === "warning").length
    return { packName: name, dir, validation, errors, warnings }
  })

  return {
    packs,
    totalErrors: packs.reduce((sum, p) => sum + p.errors, 0),
    totalWarnings: packs.reduce((sum, p) => sum + p.warnings, 0),
  }
}

export function runWorkspaceLint(agents: readonly AgentInfo[]): WorkspaceLintReport {
  const allFilenames = agents.map(a => a.filename)
  const nonCompliant: LintFinding[] = []
  for (const agent of agents) {
    const analysis = analyzeAgentName(agent.filename, allFilenames)
    if (!analysis.isValid) nonCompliant.push({ agent, analysis })
  }
  return {
    total: agents.length,
    compliant: agents.length - nonCompliant.length,
    nonCompliant,
  }
}

export function runWorkspaceAudit(agents: AgentInfo[]) {
  return auditSecurityPermissions(agents)
}

export function previewFixNames(agents: readonly AgentInfo[]): FixNamePlanItem[] {
  const report = runWorkspaceLint(agents)
  return report.nonCompliant
    .filter(item => Boolean(item.analysis.suggestedName))
    .map(({ agent, analysis }) => ({
      agent,
      fromFilename: agent.filename,
      toFilename: analysis.suggestedName!,
      destination: path.join(path.dirname(agent.currentPath), analysis.suggestedName!),
    }))
}

export function applyFixNames(
  workspaceRoot: string,
  agents: AgentInfo[],
  plans: readonly FixNamePlanItem[] = previewFixNames(agents),
): FixNameApplyResult {
  if (plans.length === 0) return { renamedCount: 0, updatedReferences: 0 }
  const plannedPaths = [
    ...agents.map(agent => agent.currentPath),
    ...plans.map(plan => plan.destination),
  ]
  const { value: results } = repositoryTransaction(workspaceRoot, plannedPaths, AUTO_COMMIT_MESSAGES.rename, () => {
    const renamed = []
    for (const plan of plans) {
      const result = renameAgent(workspaceRoot, plan.agent.currentPath, path.basename(plan.destination), agents)
      if (!result.success) throw new Error(result.error || `Failed to rename ${plan.agent.filename}`)
      plan.agent.currentPath = result.newPath
      plan.agent.filename = path.basename(result.newPath)
      renamed.push(result)
    }
    return renamed
  })
  return {
    renamedCount: results.length,
    updatedReferences: results.reduce((sum, item) => sum + item.updatedReferences.length, 0),
  }
}
