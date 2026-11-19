import type { GhRepoSummary } from "./github.js"
import { isSourceSpecLike, type Source } from "./sources.js"

export type SourceWorkspaceRow =
  | { id: string; kind: "connect-input"; spec: string }
  | { id: string; kind: "registered"; source: Source; revision: string | null; isActive: boolean }
  | { id: string; kind: "gh-repo"; repo: GhRepoSummary }

export interface BuildSourceRowsInput {
  query: string
  registered: ReadonlyArray<{ source: Source; revision: string | null; isActive: boolean }>
  ghRepos: ReadonlyArray<GhRepoSummary>
  recentSuggestions?: ReadonlyArray<string>
}

const normalizeGitUrl = (url: string): string => url.toLowerCase().replace(/\.git$/i, "")

/**
 * Pure row builder for the sources workspace. Path-like queries float the connect row to the top so
 * Enter acts on the typed spec instead of the first registered source.
 */
export function buildSourceWorkspaceRows(input: BuildSourceRowsInput): SourceWorkspaceRow[] {
  const { query, registered, ghRepos, recentSuggestions } = input
  const trimmedQuery = query.trim()
  const isSpecLike = isSourceSpecLike(query)

  const registeredGitUrls = new Set<string>()
  for (const entry of registered) {
    if (entry.source.kind === "git") registeredGitUrls.add(normalizeGitUrl(entry.source.url))
  }

  const registeredRows: SourceWorkspaceRow[] = registered.map(entry => ({
    id: `reg:${entry.source.name}`,
    kind: "registered",
    source: entry.source,
    revision: entry.revision,
    isActive: entry.isActive,
  }))

  const ghRepoRows: SourceWorkspaceRow[] = []
  for (const repo of ghRepos) {
    if (registeredGitUrls.has(normalizeGitUrl(repo.url))) continue
    ghRepoRows.push({ id: `gh:${repo.nameWithOwner}`, kind: "gh-repo", repo })
  }

  const connectRow = (): SourceWorkspaceRow => ({ id: "connect-input", kind: "connect-input", spec: trimmedQuery })

  if (isSpecLike) {
    const rows: SourceWorkspaceRow[] = [connectRow()]
    const seen = new Set<string>([trimmedQuery.toLowerCase()])
    for (const rawSuggestion of recentSuggestions ?? []) {
      const suggestion = rawSuggestion.trim()
      if (!suggestion) continue
      const key = suggestion.toLowerCase()
      if (seen.has(key) || !key.includes(trimmedQuery.toLowerCase())) continue
      seen.add(key)
      rows.push({ id: `recent:${suggestion}`, kind: "connect-input", spec: suggestion })
    }
    rows.push(...registeredRows, ...ghRepoRows)
    return rows
  }

  const rows: SourceWorkspaceRow[] = [...registeredRows, ...ghRepoRows]
  if (trimmedQuery) rows.push(connectRow())
  return rows
}
