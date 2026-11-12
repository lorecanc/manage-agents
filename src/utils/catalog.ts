import fs from "node:fs"
import path from "node:path"
import { DISCOVERY_DEPTH, MANIFEST_FILE, PACK_NAME_RE, SKIPPED_DIRS } from "./packs.js"
import { derivePackSlug, isVirtualPackRoot, VIRTUAL_PACK_VERSION } from "./virtualPacks.js"

// A pack catalog is a source laid out as packs/<name>/opencode-pack.json (or packs up to DISCOVERY_DEPTH): what the
// TUI, the agent commands and the bridges edit and read. A single pack directory is a catalog of one.

export const packsDir = (workspaceRoot: string) => path.join(workspaceRoot, "packs")

function manifestName(dir: string): string | null {
  try {
    const name = readManifest(dir)?.name
    return typeof name === "string" && PACK_NAME_RE.test(name) ? name : null
  } catch {
    return null
  }
}

/** Directory of a pack of the catalog, or null when there is none of that name (or it is a symlink). */
export function packDir(workspaceRoot: string, name: string): string | null {
  if (!PACK_NAME_RE.test(name)) return null
  if (fs.existsSync(path.join(workspaceRoot, MANIFEST_FILE))) {
    return manifestName(workspaceRoot) === name ? workspaceRoot : null
  }
  const dir = path.join(packsDir(workspaceRoot), name)
  // A linked pack directory would bring content from outside the catalog into edits, installs and bridges.
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) return null
  if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return dir

  const search = (current: string, depth: number): string | null => {
    if (depth > 0 && fs.existsSync(path.join(current, MANIFEST_FILE))) {
      return manifestName(current) === name ? current : null
    }
    if (depth >= DISCOVERY_DEPTH || !fs.existsSync(current)) return null
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRS.has(entry.name)) continue
      const found = search(path.join(current, entry.name), depth + 1)
      if (found) return found
    }
    return null
  }
  const found = search(workspaceRoot, 0)
  if (found) return found
  const resolvedRoot = path.resolve(workspaceRoot)
  if (derivePackSlug(path.basename(resolvedRoot)) === name && isVirtualPackRoot(resolvedRoot)) {
    return workspaceRoot
  }
  return null
}

export function readManifest(dir: string): Record<string, any> {
  const manifestPath = path.join(dir, MANIFEST_FILE)
  if (!fs.existsSync(manifestPath) && isVirtualPackRoot(dir)) {
    const name = derivePackSlug(path.basename(path.resolve(dir)))
    return { contract: "1.1", name, version: VIRTUAL_PACK_VERSION, description: `Virtual agent pack (${name})`, requires: {} }
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"))
}

/** The pack and every pack it requires, transitively, dependencies first. */
export function resolvePackClosure(workspaceRoot: string, name: string): string[] {
  const ordered: string[] = []
  const visiting = new Set<string>()
  const visit = (pack: string, from: string | null) => {
    if (ordered.includes(pack)) return
    if (visiting.has(pack)) throw new Error(`dependency cycle through ${pack}`)
    const dir = packDir(workspaceRoot, pack)
    if (!dir) throw new Error(from ? `${from} requires ${pack}, which is not in the catalog` : `no pack ${pack} in the catalog`)
    visiting.add(pack)
    for (const dependency of Object.keys(readManifest(dir).requires ?? {}).sort()) visit(dependency, pack)
    visiting.delete(pack)
    ordered.push(pack)
  }
  visit(name, null)
  return ordered
}
