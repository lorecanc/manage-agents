import * as crypto from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import semver from "semver"
import {
  assertSafeEnginePath,
  computeEngineBundleHash,
  defaultEngineRepository,
  isWithinRoot,
  readEngineReleaseManifest,
  resolveEngineRoot,
  resolveEngineVersion,
  stampAppliedEngineManifest,
  type EngineReleaseManifest,
  type EngineVersionInfo,
} from "./engineVersion.js"
import { movePathWithRetry, removePathWithRetry, WINDOWS_SAFE_RM_OPTIONS } from "./fsWindows.js"
import { changeTarget, reconcileChange, type ChangeResult } from "./installer.js"
import { defaultTarget, readLock } from "./lock.js"
import { realpathThroughExistingAncestor } from "./pathValidation.js"
import { cleanGitEnvironment } from "./repositoryTransaction.js"
import { loadSources } from "./sources.js"
import { terminalSafeText } from "./terminalText.js"

export const RELEASE_SIGNING_CONFIG_FILENAME = "release-signing.json"
export const RELEASE_METADATA_ASSET_NAME = "release-metadata.json"
export const RELEASE_SIGNATURE_ASSET_NAME = "release-metadata.json.sig"

export interface ReleaseSigningKeyEntry {
  keyId: string
  publicKey: string
  createdAt: string
}

export interface ReleaseSigningConfig {
  schemaVersion: 1
  repository: string
  algorithm: "ed25519"
  publicKeys: ReleaseSigningKeyEntry[]
}

export interface ReleaseArchiveDigest {
  name: string
  size: number
  sha256: string
}

export interface EngineReleaseMetadata {
  schemaVersion: 1
  repository: string
  tag: string
  commit: string
  builtAt: string
  signed: boolean
  algorithm: "ed25519" | "sha256"
  keyId?: string
  archive: ReleaseArchiveDigest
}

export interface GitHubReleaseAsset {
  id: number
  name: string
  size?: number
  url?: string
}

export interface GitHubReleasePayload {
  tag_name: string
  target_commitish?: string
  html_url?: string
  assets: GitHubReleaseAsset[]
}

export interface ReleaseTransport {
  getLatestRelease(repository: string): Promise<GitHubReleasePayload>
  downloadAsset(repository: string, asset: GitHubReleaseAsset): Promise<Buffer>
}

export interface EngineUpdateCheckResult {
  repository: string
  verificationMode: "ed25519" | "sha256"
  metadata: EngineReleaseMetadata
  release: GitHubReleasePayload
  archiveAsset: GitHubReleaseAsset
  currentVersion: EngineVersionInfo
  updateAvailable: boolean
  downgrade: boolean
  localGitDirty: boolean
  targetReconcileNeeded: boolean
}

export interface EngineUpdateResult {
  checkResult: EngineUpdateCheckResult
  applied: boolean
  dependenciesInstalled: boolean
  versionInfo: EngineVersionInfo
  reconcileResult?: ChangeResult
}

type ParsedPublicKey = { publicKey: crypto.KeyObject; publicKeyPem: string; keyId: string }

const GH_MAX_BUFFER_BYTES = 128 * 1024 * 1024
const GH_TIMEOUT_MS = 120_000
const GH_MAX_ATTEMPTS = 3

const ENGINE_REQUIRED_TARGETS = [
  "manage-agents.mjs",
  "package.json",
  "dist",
  "assets",
  "contract",
  "runtime",
] as const

const ENGINE_OPTIONAL_TARGETS = [
  "package-lock.json",
  "bun.lock",
  "src",
  "README.md",
  "GUIDA.md",
  "LICENSE",
  ".gitignore",
] as const

export const SELF_UPDATE_JOURNAL_REL = ".manage-agents/self-update-journal.json"
export const SELF_UPDATE_BACKUP_DIR_REL = ".manage-agents/self-update-backup"
const SELF_UPDATE_ALLOWED_TARGETS = new Set<string>([...ENGINE_REQUIRED_TARGETS, ...ENGINE_OPTIONAL_TARGETS, "node_modules"])

function safeText(value: unknown): string {
  return String(value instanceof Error ? value.message : value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
}

function sanitized<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    throw new Error(safeText(error))
  }
}

async function sanitizedAsync<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw new Error(safeText(error))
  }
}

async function reportProgress(onProgress: ((msg: string) => void) | undefined, message: string): Promise<void> {
  if (!onProgress) return
  onProgress(terminalSafeText(message))
  await new Promise<void>(resolve => setTimeout(resolve, 10))
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function containsControlCharacters(value: unknown): boolean {
  if (typeof value === "string") return /[\u0000-\u001f\u007f-\u009f]/.test(value)
  if (Array.isArray(value)) return value.some(containsControlCharacters)
  if (isObject(value)) {
    return Object.entries(value).some(([k, v]) => /[\u0000-\u001f\u007f-\u009f]/.test(k) || containsControlCharacters(v))
  }
  return false
}

export function validReleaseRepository(repository: unknown): repository is string {
  return typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

function validTag(tag: unknown): tag is string {
  return typeof tag === "string" && /^[0-9A-Za-z._-]+$/.test(tag) && !/[\u0000-\u001f\u007f-\u009f]/.test(tag)
}

function validSha(sha: unknown): sha is string {
  return typeof sha === "string" && /^[0-9a-fA-F]{40}$/.test(sha)
}

export function releaseArchiveName(tag: string): string {
  return `manage-agents-${tag}.tar.gz`
}

function assertNoSymlinkComponents(target: string): void {
  const resolved = path.resolve(target)
  const root = path.parse(resolved).root
  let current = root
  for (const component of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error: any) {
      if (error?.code === "ENOENT") return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error("Refusing a symlink path.")
  }
}

function atomicWriteFile(target: string, content: string | Buffer, mode: number, engineRoot?: string): void {
  const parent = path.dirname(target)
  if (engineRoot) {
    assertSafeEnginePath(engineRoot, parent)
    fs.mkdirSync(parent, { recursive: true })
    assertSafeEnginePath(engineRoot, target)
  } else {
    assertNoSymlinkComponents(parent)
    fs.mkdirSync(parent, { recursive: true })
    assertNoSymlinkComponents(target)
  }
  const existing = fs.lstatSync(target, { throwIfNoEntry: false })
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error("Refusing to overwrite a symlink or non-file target.")
  }
  const temporary = path.join(parent, `${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`)
  let fd: number | undefined
  try {
    fd = fs.openSync(temporary, "wx", mode)
    fs.writeFileSync(fd, content)
    fs.fchmodSync(fd, mode)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    if (engineRoot) assertSafeEnginePath(engineRoot, target)
    else assertNoSymlinkComponents(target)
    movePathWithRetry(temporary, target)
    if (engineRoot) fsyncDirectory(parent)
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    try {
      fs.unlinkSync(temporary)
    } catch {}
    throw new Error(safeText(error))
  }
}

function publicKeyIdFromKey(key: crypto.KeyObject): string {
  const der = key.export({ format: "der", type: "spki" })
  return `ed25519-${crypto.createHash("sha256").update(der).digest("hex").slice(0, 12)}`
}

function samePublicKey(left: crypto.KeyObject, right: crypto.KeyObject): boolean {
  return left.export({ format: "der", type: "spki" }).equals(right.export({ format: "der", type: "spki" }))
}

function asEd25519PublicKey(value: string | Buffer | crypto.KeyObject, allowBase64 = false): ParsedPublicKey {
  let key: crypto.KeyObject
  try {
    if (value instanceof crypto.KeyObject) {
      key = value.type === "private" ? crypto.createPublicKey(value) : value
    } else if (Buffer.isBuffer(value)) {
      key = crypto.createPublicKey({ key: value, format: "der", type: "spki" })
    } else if (allowBase64 && !value.includes("-----BEGIN")) {
      const encoded = value.trim()
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error()
      key = crypto.createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" })
    } else {
      key = crypto.createPublicKey(value.replace(/\\n/g, "\n"))
    }
  } catch {
    throw new Error("Invalid Ed25519 public key.")
  }
  if (key.asymmetricKeyType !== "ed25519" || key.type !== "public") {
    throw new Error("Release public keys must use Ed25519.")
  }
  const publicKeyPem = key.export({ format: "pem", type: "spki" }).toString()
  return { publicKey: key, publicKeyPem, keyId: publicKeyIdFromKey(key) }
}

export function computePublicKeyId(publicKeyPemOrDer: string | Buffer | crypto.KeyObject): string {
  return asEd25519PublicKey(publicKeyPemOrDer).keyId
}

function parseSigningConfig(value: unknown, repositoryOverride?: string): ReleaseSigningConfig {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.algorithm !== "ed25519" ||
    !validReleaseRepository(value.repository) ||
    !Array.isArray(value.publicKeys)
  ) {
    throw new Error("Invalid release signing configuration.")
  }
  const publicKeys: ReleaseSigningKeyEntry[] = []
  for (const item of value.publicKeys) {
    if (
      !isObject(item) ||
      typeof item.keyId !== "string" ||
      !/^ed25519-[0-9a-f]{12}$/.test(item.keyId) ||
      typeof item.publicKey !== "string" ||
      !validTimestamp(item.createdAt)
    ) {
      throw new Error("Invalid release signing key entry.")
    }
    const parsed = asEd25519PublicKey(item.publicKey)
    if (parsed.keyId !== item.keyId) throw new Error("Release signing key ID does not match its public key.")
    if (publicKeys.some(entry => entry.keyId === item.keyId)) throw new Error("Duplicate release signing key ID.")
    publicKeys.push({ keyId: item.keyId, publicKey: parsed.publicKeyPem, createdAt: item.createdAt })
  }
  const repository = repositoryOverride ?? value.repository
  if (!validReleaseRepository(repository)) throw new Error("Invalid release repository override.")
  return { schemaVersion: 1, repository, algorithm: "ed25519", publicKeys }
}

function readSigningConfigFile(engineRoot: string): unknown | null {
  const configPath = path.join(engineRoot, RELEASE_SIGNING_CONFIG_FILENAME)
  assertSafeEnginePath(engineRoot, engineRoot)
  const stat = fs.lstatSync(configPath, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("release-signing.json must be a regular file.")
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown
  } catch {
    throw new Error("Unable to parse release-signing.json.")
  }
}

export interface ReleaseTrustPolicy {
  repository: string
  requireSignature: boolean
  publicKeys: ReleaseSigningKeyEntry[]
}

export function resolveReleaseTrustPolicy(
  overrideEngineRoot?: string,
  options: { repository?: string; env?: NodeJS.ProcessEnv; requireSignature?: boolean; allowUnsigned?: boolean } = {},
): ReleaseTrustPolicy {
  return sanitized(() => {
    const env = options.env ?? process.env
    const engineRoot = resolveEngineRoot(overrideEngineRoot)
    const repoOverride = options.repository ?? env.MANAGE_AGENTS_REPO
    if (repoOverride !== undefined && !validReleaseRepository(repoOverride)) {
      throw new Error("Invalid repository override (expected owner/repo).")
    }

    const rawFile = readSigningConfigFile(engineRoot)
    const config = rawFile !== null ? parseSigningConfig(rawFile, repoOverride) : null
    const publicKeys = config ? [...config.publicKeys] : []

    if (env.MANAGE_AGENTS_RELEASE_PUBLIC_KEY) {
      const parsed = asEd25519PublicKey(env.MANAGE_AGENTS_RELEASE_PUBLIC_KEY, true)
      const existing = publicKeys.find(entry => entry.keyId === parsed.keyId)
      if (existing && !samePublicKey(asEd25519PublicKey(existing.publicKey).publicKey, parsed.publicKey)) {
        throw new Error("MANAGE_AGENTS_RELEASE_PUBLIC_KEY key ID collides with a different trusted key.")
      }
      if (!existing) {
        publicKeys.push({ keyId: parsed.keyId, publicKey: parsed.publicKeyPem, createdAt: new Date().toISOString() })
      }
    }

    const repository = repoOverride ?? config?.repository ?? defaultEngineRepository(engineRoot)
    if (!validReleaseRepository(repository)) throw new Error("Invalid release repository.")
    const allowUnsigned = options?.allowUnsigned === true || env.MANAGE_AGENTS_ALLOW_UNSIGNED === "1"
    const requireSignature = publicKeys.length > 0 ? true : (options.requireSignature ?? !allowUnsigned)
    if (requireSignature && publicKeys.length === 0) {
      throw new Error(
        "Signature verification is required, but no Ed25519 public key is configured. Configure release-signing.json or MANAGE_AGENTS_RELEASE_PUBLIC_KEY, or pass --allow-unsigned (MANAGE_AGENTS_ALLOW_UNSIGNED=1) to allow SHA-256-only updates.",
      )
    }
    return { repository, requireSignature, publicKeys }
  })
}

export function generateReleaseSigningKeypair(
  overrideEngineRoot?: string,
  options: { outPrivateKeyPath?: string; keyId?: string; repository?: string; replaceKeys?: boolean } = {},
): { keyId: string; publicKeyPem: string; privateKeyPem: string; configPath: string; privateKeyPath: string | null } {
  return sanitized(() => {
    const engineRoot = resolveEngineRoot(overrideEngineRoot)
    const keypair = crypto.generateKeyPairSync("ed25519")
    const publicKeyPem = keypair.publicKey.export({ format: "pem", type: "spki" }).toString()
    const privateKeyPem = keypair.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    const keyId = computePublicKeyId(keypair.publicKey)
    if (options.keyId !== undefined && options.keyId !== keyId) {
      throw new Error("Requested key ID does not match the generated Ed25519 key.")
    }

    const configPath = path.join(engineRoot, RELEASE_SIGNING_CONFIG_FILENAME)
    const existingRaw = readSigningConfigFile(engineRoot)
    const baseConfig =
      existingRaw === null
        ? { schemaVersion: 1 as const, repository: defaultEngineRepository(engineRoot), algorithm: "ed25519" as const, publicKeys: [] }
        : parseSigningConfig(existingRaw)
    const repository = options.repository ?? baseConfig.repository
    if (!validReleaseRepository(repository)) throw new Error("Invalid release repository.")
    const publicKeys = options.replaceKeys ? [] : [...baseConfig.publicKeys]
    publicKeys.push({ keyId, publicKey: publicKeyPem, createdAt: new Date().toISOString() })
    const nextConfig: ReleaseSigningConfig = { schemaVersion: 1, repository, algorithm: "ed25519", publicKeys }
    atomicWriteFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 0o644, engineRoot)

    let privateKeyPath: string | null = null
    if (options.outPrivateKeyPath !== undefined) {
      privateKeyPath = path.resolve(engineRoot, options.outPrivateKeyPath)
      assertNoSymlinkComponents(path.dirname(privateKeyPath))
      atomicWriteFile(privateKeyPath, privateKeyPem, 0o600)
    }
    return {
      keyId,
      publicKeyPem,
      privateKeyPem,
      configPath: safeText(configPath),
      privateKeyPath: privateKeyPath === null ? null : safeText(privateKeyPath),
    }
  })
}

export function signReleaseAssets(
  overrideEngineRoot: string | undefined,
  options: {
    tag: string
    sha: string
    assetsDir: string
    repository?: string
    privateKeyPem?: string
    env?: NodeJS.ProcessEnv
    builtAt?: string
    allowUnsigned?: boolean
  },
): {
  metadata: EngineReleaseMetadata
  metadataPath: string
  signaturePath: string | null
  signatureBase64: string | null
} {
  return sanitized(() => {
    if (!validTag(options.tag)) throw new Error("Release tag must contain only letters, numbers, dots, underscores, or hyphens.")
    if (!validSha(options.sha)) throw new Error("Release commit must be a 40-character hexadecimal SHA.")
    const env = options.env ?? process.env
    const engineRoot = resolveEngineRoot(overrideEngineRoot)
    const privateKeyText = (options.privateKeyPem ?? env.RELEASE_SIGNING_PRIVATE_KEY ?? "").trim()
    const allowUnsigned = options.allowUnsigned === true || env.MANAGE_AGENTS_ALLOW_UNSIGNED === "1"
    const policy = resolveReleaseTrustPolicy(engineRoot, {
      repository: options.repository,
      env,
      allowUnsigned: allowUnsigned || Boolean(privateKeyText),
    })

    if (!privateKeyText && (policy.requireSignature || !allowUnsigned)) {
      throw new Error("RELEASE_SIGNING_PRIVATE_KEY is required because release-signing.json configures Ed25519 trust.")
    }

    const builtAt = options.builtAt ?? new Date().toISOString()
    if (!validTimestamp(builtAt)) throw new Error("Release build timestamp must be an ISO timestamp.")

    const assetsRoot = path.resolve(options.assetsDir)
    const rootStat = fs.lstatSync(assetsRoot, { throwIfNoEntry: false })
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Release assets path must be a regular directory.")
    }

    const expectedName = releaseArchiveName(options.tag)
    const archivePath = path.join(assetsRoot, expectedName)
    const archiveStat = fs.lstatSync(archivePath, { throwIfNoEntry: false })
    if (!archiveStat || archiveStat.isSymbolicLink() || !archiveStat.isFile() || archiveStat.size <= 0) {
      throw new Error(`Required release archive is missing, empty, or not a regular file: ${safeText(expectedName)}`)
    }
    const archiveBytes = fs.readFileSync(archivePath)
    const archive: ReleaseArchiveDigest = {
      name: expectedName,
      size: archiveBytes.byteLength,
      sha256: `sha256:${crypto.createHash("sha256").update(archiveBytes).digest("hex")}`,
    }

    let privateKey: crypto.KeyObject | null = null
    let keyId: string | undefined
    if (privateKeyText) {
      try {
        privateKey = crypto.createPrivateKey(privateKeyText.replace(/\\n/g, "\n"))
      } catch {
        throw new Error("Invalid release signing private key.")
      }
      if (privateKey.asymmetricKeyType !== "ed25519") {
        throw new Error("Release signing private key must use Ed25519.")
      }
      const derivedPublic = crypto.createPublicKey(privateKey)
      keyId = computePublicKeyId(derivedPublic)
      if (
        policy.publicKeys.length > 0 &&
        !policy.publicKeys.some(entry => entry.keyId === keyId && samePublicKey(asEd25519PublicKey(entry.publicKey).publicKey, derivedPublic))
      ) {
        throw new Error("The release signing private key is not trusted by release-signing.json.")
      }
    }

    const metadata: EngineReleaseMetadata = {
      schemaVersion: 1,
      repository: policy.repository,
      tag: options.tag,
      commit: options.sha.toLowerCase(),
      builtAt,
      signed: Boolean(privateKey),
      algorithm: privateKey ? "ed25519" : "sha256",
      ...(keyId ? { keyId } : {}),
      archive,
    }
    const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8")
    const metadataPath = path.join(assetsRoot, RELEASE_METADATA_ASSET_NAME)
    atomicWriteFile(metadataPath, metadataBytes, 0o644)

    let signaturePath: string | null = null
    let signatureBase64: string | null = null
    if (privateKey) {
      signatureBase64 = crypto.sign(null, metadataBytes, privateKey).toString("base64")
      signaturePath = path.join(assetsRoot, RELEASE_SIGNATURE_ASSET_NAME)
      atomicWriteFile(signaturePath, `${signatureBase64}\n`, 0o644)
    }

    return {
      metadata,
      metadataPath: safeText(metadataPath),
      signaturePath: signaturePath === null ? null : safeText(signaturePath),
      signatureBase64,
    }
  })
}

function parseReleaseMetadataPayload(
  value: unknown,
  expectedRepository: string,
  expectedTag?: string,
): EngineReleaseMetadata {
  if (
    !isObject(value) ||
    containsControlCharacters(value) ||
    value.schemaVersion !== 1 ||
    value.repository !== expectedRepository ||
    !validTag(value.tag) ||
    (expectedTag !== undefined && value.tag !== expectedTag) ||
    typeof value.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.commit) ||
    !validTimestamp(value.builtAt) ||
    typeof value.signed !== "boolean" ||
    (value.algorithm !== "ed25519" && value.algorithm !== "sha256") ||
    !isObject(value.archive) ||
    value.archive.name !== releaseArchiveName(value.tag) ||
    !Number.isSafeInteger(value.archive.size) ||
    value.archive.size <= 0 ||
    typeof value.archive.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.archive.sha256)
  ) {
    throw new Error("Release metadata is invalid or does not match the configured repository and tag.")
  }
  if (value.signed) {
    if (value.algorithm !== "ed25519" || typeof value.keyId !== "string" || !/^ed25519-[0-9a-f]{12}$/.test(value.keyId)) {
      throw new Error("Signed release metadata is missing a valid Ed25519 key ID.")
    }
  }
  return value as EngineReleaseMetadata
}

export function verifyEngineReleaseMetadata(
  rawMetadataBytes: Buffer,
  rawSignatureText: string | null,
  policy: ReleaseTrustPolicy,
  expectedTag?: string,
): { metadata: EngineReleaseMetadata; verificationMode: "ed25519" | "sha256" } {
  return sanitized(() => {
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawMetadataBytes.toString("utf8")) as unknown
    } catch {
      throw new Error("Release metadata is not valid JSON.")
    }
    const metadata = parseReleaseMetadataPayload(parsedJson, policy.repository, expectedTag)

    if (policy.requireSignature || (policy.publicKeys.length > 0 && rawSignatureText !== null)) {
      if (!rawSignatureText || !metadata.signed || metadata.algorithm !== "ed25519") {
        throw new Error("Release metadata Ed25519 signature is required by the configured trust policy.")
      }
      const sigTrimmed = rawSignatureText.trim()
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(sigTrimmed)) {
        throw new Error("Release metadata signature is not valid base64.")
      }
      const sigBytes = Buffer.from(sigTrimmed, "base64")
      if (sigBytes.length !== 64 || sigBytes.toString("base64") !== sigTrimmed) {
        throw new Error("Release metadata signature has an invalid length or encoding.")
      }
      const matchingKey = policy.publicKeys.find(entry => entry.keyId === metadata.keyId)
      const candidates = matchingKey ? [matchingKey] : policy.publicKeys
      let verified = false
      for (const entry of candidates) {
        try {
          const pub = asEd25519PublicKey(entry.publicKey).publicKey
          if (crypto.verify(null, rawMetadataBytes, pub, sigBytes)) {
            verified = true
            break
          }
        } catch {}
      }
      if (!verified) throw new Error("Release metadata Ed25519 signature verification failed.")
      return { metadata, verificationMode: "ed25519" }
    }

    return { metadata, verificationMode: "sha256" }
  })
}

function parseGitHubRelease(value: unknown): GitHubReleasePayload {
  if (!isObject(value) || !validTag(value.tag_name) || !Array.isArray(value.assets)) {
    throw new Error("GitHub returned an invalid latest-release response.")
  }
  const assets: GitHubReleaseAsset[] = value.assets.map((asset: unknown) => {
    if (
      !isObject(asset) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      typeof asset.name !== "string" ||
      /[\u0000-\u001f\u007f-\u009f]/.test(asset.name) ||
      (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size < 0))
    ) {
      throw new Error("GitHub returned an invalid release asset entry.")
    }
    return {
      id: asset.id,
      name: asset.name,
      ...(asset.size !== undefined ? { size: asset.size } : {}),
      ...(typeof asset.url === "string" ? { url: safeText(asset.url) } : {}),
    }
  })
  return {
    tag_name: value.tag_name,
    ...(typeof value.target_commitish === "string" ? { target_commitish: safeText(value.target_commitish) } : {}),
    ...(typeof value.html_url === "string" ? { html_url: safeText(value.html_url) } : {}),
    assets,
  }
}

export function isTransientTransportError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : isObject(error) && typeof error.message === "string"
          ? error.message
          : String(error ?? "")
  return /\b(wsarecv|WSAECONNRESET|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND)\b|forcibly closed by the remote host|connection reset|socket hang up|fetch failed|TLS handshake timeout|i\/o timeout|unexpected EOF|\bEOF\b|status (502|503|504)\b/i.test(
    message,
  )
}

export function withHttp1Godebug(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const godebug = env.GODEBUG ?? ""
  return {
    ...env,
    GODEBUG: godebug.split(",").some(setting => setting.trim() === "http2client=0")
      ? godebug
      : [godebug, "http2client=0"].filter(Boolean).join(","),
  }
}

function ghCallSync(spawnImpl: typeof spawnSync, args: string[], env: NodeJS.ProcessEnv): Buffer {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnImpl("gh", args, {
      cwd: process.cwd(),
      env: cleanGitEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER_BYTES,
      encoding: "buffer",
      windowsHide: true,
    })
  } catch (error) {
    const detail = terminalSafeText(error instanceof Error ? error.message : error).trim()
    throw new Error(detail ? `GitHub CLI request failed: ${detail}` : "GitHub CLI request failed.")
  }
  if (result.error || result.status !== 0 || !result.stdout) {
    const detail = [
      result.error?.message,
      Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : String(result.stderr ?? "").trim(),
    ]
      .map(val => terminalSafeText(val ?? "").trim())
      .filter(Boolean)
      .join(" ")
    throw new Error(detail ? `GitHub CLI request failed: ${detail}` : "GitHub CLI request failed.")
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
}

function ghCallAsync(args: string[], env: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("gh", args, {
        cwd: process.cwd(),
        env: cleanGitEnvironment(env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch {
      reject(new Error("GitHub CLI request failed."))
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let outputBytes = 0
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error("GitHub CLI request timed out."))
    }, GH_TIMEOUT_MS)

    const finish = (error?: Error, output?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(output ?? Buffer.alloc(0))
    }

    const collect = (chunks: Buffer[], chunk: Buffer) => {
      if (settled) return
      outputBytes += chunk.byteLength
      if (outputBytes > GH_MAX_BUFFER_BYTES) {
        child.kill()
        finish(new Error("GitHub CLI response exceeded the maximum buffer size."))
        return
      }
      chunks.push(chunk)
    }

    child.stdout?.on("data", (chunk: Buffer) => collect(stdoutChunks, Buffer.from(chunk)))
    child.stderr?.on("data", (chunk: Buffer) => collect(stderrChunks, Buffer.from(chunk)))
    child.once("error", error => finish(new Error(`GitHub CLI request failed: ${terminalSafeText(error.message)}`)))
    child.once("close", code => {
      const stdout = Buffer.concat(stdoutChunks)
      const stderr = Buffer.concat(stderrChunks)
      if (code !== 0 || !stdout) {
        const detail = terminalSafeText(stderr.toString("utf8").trim()).trim()
        finish(new Error(detail ? `GitHub CLI request failed: ${detail}` : "GitHub CLI request failed."))
        return
      }
      finish(undefined, stdout)
    })
  })
}

export function createDefaultReleaseTransport(
  options: { env?: NodeJS.ProcessEnv; spawnImpl?: typeof spawnSync; fetchImpl?: typeof fetch } = {},
): ReleaseTransport {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? fetch

  async function runGh(args: string[]): Promise<Buffer> {
    for (let attempt = 0; attempt < GH_MAX_ATTEMPTS; attempt++) {
      try {
        const attemptEnv = attempt === 0 ? env : withHttp1Godebug(env)
        return options.spawnImpl ? ghCallSync(options.spawnImpl, args, attemptEnv) : await ghCallAsync(args, attemptEnv)
      } catch (error) {
        if (attempt >= GH_MAX_ATTEMPTS - 1 || !isTransientTransportError(error)) throw error
        if (!options.spawnImpl) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)))
      }
    }
    throw new Error("GitHub CLI request failed.")
  }

  let cachedAuthToken: string | null | undefined
  async function resolveAuthToken(): Promise<string | null> {
    const envToken = (env.GITHUB_TOKEN || env.GH_TOKEN || "").trim()
    if (envToken && !containsControlCharacters(envToken)) return envToken
    if (cachedAuthToken !== undefined) return cachedAuthToken

    for (const args of [["auth", "token", "--hostname", "github.com"], ["auth", "token"]]) {
      try {
        const output = options.spawnImpl ? ghCallSync(options.spawnImpl, args, env) : await ghCallAsync(args, env)
        const token = output.toString("utf8").trim()
        if (token && !containsControlCharacters(token)) {
          cachedAuthToken = token
          return token
        }
      } catch {}
    }
    cachedAuthToken = null
    return null
  }

  async function fallbackHttpRequest(repository: string, resource: string, accept: string): Promise<Buffer> {
    const token = await resolveAuthToken()
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": "manage-agents",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
    for (let attempt = 0; attempt < GH_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${repository}/${resource}`, { headers })
        if (!response.ok) throw new Error(`GitHub API request failed with status ${response.status}.`)
        return Buffer.from(await response.arrayBuffer())
      } catch (error) {
        if (attempt >= GH_MAX_ATTEMPTS - 1 || !isTransientTransportError(error)) throw error
      }
    }
    throw new Error("GitHub API request failed.")
  }

  async function request(repository: string, resource: string, accept: string): Promise<Buffer> {
    return sanitizedAsync(async () => {
      if (!validReleaseRepository(repository)) throw new Error("Invalid release repository.")
      try {
        return await runGh(["api", `repos/${repository}/${resource}`, "-H", `Accept: ${accept}`])
      } catch (ghError) {
        try {
          return await fallbackHttpRequest(repository, resource, accept)
        } catch (fetchError) {
          const ghDetail = terminalSafeText(ghError instanceof Error ? ghError.message : ghError).trim()
          const fetchDetail = terminalSafeText(fetchError instanceof Error ? fetchError.message : fetchError).trim()
          const details = [ghDetail, fetchDetail].filter(Boolean).join(" ")
          throw new Error(
            `Unable to access GitHub releases for ${repository}. Ensure a v* release is published, or authenticate with 'gh auth login' / GITHUB_TOKEN.${details ? ` ${details}` : ""}`,
          )
        }
      }
    })
  }

  return {
    async getLatestRelease(repository: string): Promise<GitHubReleasePayload> {
      return sanitizedAsync(async () => {
        const bytes = await request(repository, "releases/latest", "application/vnd.github+json")
        let value: unknown
        try {
          value = JSON.parse(bytes.toString("utf8")) as unknown
        } catch {
          throw new Error("GitHub returned invalid release JSON.")
        }
        return parseGitHubRelease(value)
      })
    },
    async downloadAsset(repository: string, asset: GitHubReleaseAsset): Promise<Buffer> {
      return request(repository, `releases/assets/${asset.id}`, "application/octet-stream")
    },
  }
}

/** Negative when `left` is older than `right`; null when either is not a semantic version tag. */
export function compareReleaseTags(left: string, right: string): number | null {
  const norm = (tag: string) => (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) ? tag.replace(/^v/, "") : null)
  const aStr = norm(left)
  const bStr = norm(right)
  if (!aStr || !bStr) return null
  const a = semver.parse(aStr)
  const b = semver.parse(bStr)
  if (!a || !b) return null
  return semver.compare(a, b)
}

export function hasUncommittedEngineChanges(overrideEngineRoot?: string): boolean {
  const engineRoot = resolveEngineRoot(overrideEngineRoot)
  const version = resolveEngineVersion(engineRoot)
  if (!fs.existsSync(path.join(engineRoot, ".git"))) {
    if (!version.manifestPresent) return false
    return version.dirty || !version.manifestValid || version.channel !== "release"
  }
  if ((version.channel === "release" || version.channel === "git-tag") && !version.dirty) return false
  try {
    const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: engineRoot,
      env: cleanGitEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      encoding: "utf8",
      windowsHide: true,
    })
    if (result.status !== 0) return true
    const nonManifestLines = result.stdout
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !l.endsWith(" .manage-agents/") && !l.includes(" .manage-agents/"))
    return nonManifestLines.length > 0
  } catch {
    return true
  }
}

function findUniqueAsset(release: GitHubReleasePayload, name: string): GitHubReleaseAsset | null {
  const matches = release.assets.filter(asset => asset.name === name)
  if (matches.length === 0) return null
  if (matches.length > 1) throw new Error(`GitHub release contains duplicate '${safeText(name)}' assets.`)
  return matches[0]!
}

function targetHasInstalledPacks(targetDir: string): boolean {
  try {
    const resolved = realpathThroughExistingAncestor(path.resolve(targetDir))
    const lock = readLock(resolved)
    return Boolean(lock && Object.keys(lock.packs).length > 0)
  } catch {
    return false
  }
}

export async function checkForEngineUpdate(
  overrideEngineRoot?: string,
  options: {
    repository?: string
    target?: string
    env?: NodeJS.ProcessEnv
    transport?: ReleaseTransport
    requireSignature?: boolean
    allowUnsigned?: boolean
    onProgress?: (stepMessage: string) => void
  } = {},
): Promise<EngineUpdateCheckResult> {
  return sanitizedAsync(async () => {
    const env = options.env ?? process.env
    const engineRoot = resolveEngineRoot(overrideEngineRoot)
    recoverInterruptedSelfUpdate(engineRoot)
    const policy = resolveReleaseTrustPolicy(engineRoot, {
      repository: options.repository,
      env,
      requireSignature: options.requireSignature,
      allowUnsigned: options.allowUnsigned,
    })
    const transport = options.transport ?? createDefaultReleaseTransport({ env })

    await reportProgress(options.onProgress, `Checking latest GitHub release (${policy.repository})...`)
    const release = parseGitHubRelease(await transport.getLatestRelease(policy.repository))
    const metadataAsset = findUniqueAsset(release, RELEASE_METADATA_ASSET_NAME)
    if (!metadataAsset) {
      throw new Error(`GitHub release '${safeText(release.tag_name)}' is missing '${RELEASE_METADATA_ASSET_NAME}'.`)
    }
    const signatureAsset = findUniqueAsset(release, RELEASE_SIGNATURE_ASSET_NAME)
    if (policy.requireSignature && !signatureAsset) {
      throw new Error(`GitHub release '${safeText(release.tag_name)}' is missing '${RELEASE_SIGNATURE_ASSET_NAME}' required by release-signing.json.`)
    }

    await reportProgress(options.onProgress, "Verifying release metadata...")
    const metadataBytes = Buffer.from(await transport.downloadAsset(policy.repository, metadataAsset))
    const signatureText = signatureAsset
      ? Buffer.from(await transport.downloadAsset(policy.repository, signatureAsset)).toString("utf8")
      : null
    const { metadata, verificationMode } = verifyEngineReleaseMetadata(metadataBytes, signatureText, policy, release.tag_name)

    const archiveAsset = findUniqueAsset(release, metadata.archive.name)
    if (!archiveAsset) {
      throw new Error(`GitHub release '${safeText(release.tag_name)}' is missing archive '${safeText(metadata.archive.name)}'.`)
    }

    const currentVersion = resolveEngineVersion(engineRoot)
    const cleanInstalledTag = !currentVersion.dirty ? currentVersion.tag : null
    const comparison = cleanInstalledTag ? compareReleaseTags(metadata.tag, cleanInstalledTag) : null
    const downgrade = comparison !== null && comparison < 0
    const sameInstalledRelease =
      !currentVersion.dirty &&
      (currentVersion.channel === "release" || currentVersion.channel === "git-tag") &&
      currentVersion.version === metadata.tag
    const samePackageSemver =
      comparison === 0 && currentVersion.channel === "package" && !currentVersion.dirty
    const updateAvailable = !sameInstalledRelease && !samePackageSemver && !downgrade

    const targetDir = options.target ?? defaultTarget(env)
    return {
      repository: policy.repository,
      verificationMode,
      metadata,
      release,
      archiveAsset,
      currentVersion,
      updateAvailable,
      downgrade,
      localGitDirty: hasUncommittedEngineChanges(engineRoot),
      targetReconcileNeeded: targetHasInstalledPacks(targetDir),
    }
  })
}

function assertNoSymlinkTree(root: string): void {
  const rootStat = fs.lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Release extraction root is invalid.")
  const walk = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const candidate = path.resolve(directory, name)
      if (!isWithinRoot(root, candidate)) throw new Error("Release archive contains a path outside its extraction directory.")
      const stat = fs.lstatSync(candidate)
      if (stat.isSymbolicLink()) throw new Error("Release archive contains a symlink.")
      if (stat.isDirectory()) walk(candidate)
      else if (!stat.isFile()) throw new Error("Release archive contains a non-regular entry.")
    }
  }
  walk(root)
}

function extractTarGzAsync(archiveFile: string, destinationDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("tar", ["-xzf", archiveFile, "-C", destinationDir], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      })
    } catch {
      reject(new Error("Unable to invoke tar to extract the release archive."))
      return
    }
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error("Timed out extracting the release archive."))
    }, GH_TIMEOUT_MS)
    child.once("error", () => finish(new Error("Unable to extract the downloaded release archive.")))
    child.once("close", code => {
      if (code !== 0) finish(new Error("Unable to safely extract the downloaded release archive."))
      else finish()
    })
  })
}

function hasEngineManifestFile(dir: string): boolean {
  try {
    return fs.lstatSync(path.join(dir, ".manage-agents", "release-manifest.json")).isFile()
  } catch {
    return false
  }
}

function resolveExtractedEngineDir(extractRoot: string, expectedDirName: string): string {
  const entries = fs.readdirSync(extractRoot, { withFileTypes: true })
  const subdirsWithManifest = entries.filter(e => e.isDirectory() && hasEngineManifestFile(path.join(extractRoot, e.name)))
  const rootHasManifest = hasEngineManifestFile(extractRoot)

  if (subdirsWithManifest.length > 0) {
    if (rootHasManifest || subdirsWithManifest.length !== 1 || entries.length !== 1) {
      throw new Error("Release archive has an ambiguous top-level package layout.")
    }
    const pkgDir = subdirsWithManifest[0]!
    if (pkgDir.name !== expectedDirName) {
      throw new Error("Release archive contains an unexpected top-level package directory.")
    }
    return path.join(extractRoot, pkgDir.name)
  }
  if (rootHasManifest) return extractRoot
  throw new Error("Release archive is missing .manage-agents/release-manifest.json.")
}

function validateStagedEngineManifest(stagedRoot: string, metadata: EngineReleaseMetadata): EngineReleaseManifest {
  const manifest = readEngineReleaseManifest(stagedRoot)
  if (
    !manifest ||
    manifest.tag !== metadata.tag ||
    manifest.commit !== metadata.commit ||
    manifest.channel !== "release" ||
    manifest.dirty ||
    computeEngineBundleHash(stagedRoot) !== manifest.bundleHash
  ) {
    throw new Error("Downloaded archive does not contain a matching release manifest and bundle hash.")
  }
  return manifest
}

function copyTree(source: string, target: string): void {
  fs.cpSync(source, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
}

interface SelfUpdateJournalEntry {
  idx: number
  rel: string
  existed: boolean
}

interface SelfUpdateJournal {
  schemaVersion: 1
  id: string
  entries: SelfUpdateJournalEntry[]
  manifestExisted: boolean
}

function pathContentsMatch(left: string, right: string): boolean {
  const leftStat = fs.lstatSync(left, { throwIfNoEntry: false })
  const rightStat = fs.lstatSync(right, { throwIfNoEntry: false })
  if (!leftStat || !rightStat || leftStat.mode !== rightStat.mode || leftStat.isSymbolicLink() !== rightStat.isSymbolicLink()) return false
  if (leftStat.isSymbolicLink()) return fs.readlinkSync(left) === fs.readlinkSync(right)
  if (leftStat.isFile()) return rightStat.isFile() && fs.readFileSync(left).equals(fs.readFileSync(right))
  if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false
  const leftNames = fs.readdirSync(left).sort()
  const rightNames = fs.readdirSync(right).sort()
  return leftNames.length === rightNames.length && leftNames.every((name, index) => name === rightNames[index] && pathContentsMatch(path.join(left, name), path.join(right, name)))
}

function fsyncPathTree(target: string): void {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) fsyncPathTree(path.join(target, name))
  }
  if (process.platform === "win32" && stat.isDirectory()) return
  // Windows' FlushFileBuffers requires a write-capable handle, without truncating the file.
  const fd = fs.openSync(target, process.platform === "win32" ? fs.constants.O_WRONLY : fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function fsyncDirectory(target: string): void {
  if (process.platform === "win32") return
  const fd = fs.openSync(target, "r")
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function parseSelfUpdateJournal(value: unknown): SelfUpdateJournal {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.id) ||
    !Array.isArray(value.entries) ||
    typeof value.manifestExisted !== "boolean"
  ) {
    throw new Error("Self-update recovery journal is invalid.")
  }
  const seenIndexes = new Set<number>()
  const seenTargets = new Set<string>()
  const entries = value.entries.map(entry => {
    if (
      !isObject(entry) ||
      !Number.isSafeInteger(entry.idx) ||
      entry.idx < 0 ||
      typeof entry.rel !== "string" ||
      !SELF_UPDATE_ALLOWED_TARGETS.has(entry.rel) ||
      typeof entry.existed !== "boolean" ||
      seenIndexes.has(entry.idx) ||
      seenTargets.has(entry.rel)
    ) {
      throw new Error("Self-update recovery journal contains an invalid engine target.")
    }
    seenIndexes.add(entry.idx)
    seenTargets.add(entry.rel)
    return { idx: entry.idx as number, rel: entry.rel, existed: entry.existed }
  })
  return { schemaVersion: 1, id: value.id, entries, manifestExisted: value.manifestExisted }
}

export function recoverInterruptedSelfUpdate(overrideEngineRoot?: string): boolean {
  return sanitized(() => {
    const engineRoot = resolveEngineRoot(overrideEngineRoot)
    const journalPath = path.join(engineRoot, ...SELF_UPDATE_JOURNAL_REL.split("/"))
    const stateDir = path.dirname(journalPath)
    const backupBase = path.join(engineRoot, ...SELF_UPDATE_BACKUP_DIR_REL.split("/"))
    assertSafeEnginePath(engineRoot, stateDir)
    assertSafeEnginePath(engineRoot, journalPath)
    assertSafeEnginePath(engineRoot, backupBase)
    const journalStat = fs.lstatSync(journalPath, { throwIfNoEntry: false })
    if (!journalStat) return false
    if (!journalStat.isFile() || journalStat.isSymbolicLink()) throw new Error("Self-update recovery journal must be a regular file.")

    const journal = parseSelfUpdateJournal(JSON.parse(fs.readFileSync(journalPath, "utf8")) as unknown)
    const backupRoot = path.join(backupBase, journal.id)
    const backupEntries = path.join(backupRoot, "entries")
    const manifestPath = path.join(stateDir, "release-manifest.json")
    const manifestBackup = path.join(backupRoot, "release-manifest.json")

    try {
      assertSafeEnginePath(engineRoot, backupRoot)
      assertSafeEnginePath(engineRoot, backupEntries)
      assertSafeEnginePath(engineRoot, manifestPath)
      assertSafeEnginePath(engineRoot, manifestBackup)
      const backupStat = fs.lstatSync(backupRoot, { throwIfNoEntry: false })
      if (!backupStat || !backupStat.isDirectory() || backupStat.isSymbolicLink()) throw new Error("Self-update backup directory is missing or invalid.")
      const recoveryEntries = [...journal.entries].reverse()
      const launcherEntry = recoveryEntries.find(entry => entry.rel === "manage-agents.mjs")
      for (const entry of [
        ...recoveryEntries.filter(candidate => candidate.rel !== "manage-agents.mjs"),
        ...(launcherEntry ? [launcherEntry] : []),
      ]) {
        const target = path.join(engineRoot, ...entry.rel.split("/"))
        const backup = path.join(backupEntries, String(entry.idx))
        assertSafeEnginePath(engineRoot, target)
        assertSafeEnginePath(engineRoot, backup)
        const backupStat = fs.lstatSync(backup, { throwIfNoEntry: false })
        if (entry.existed && !backupStat) throw new Error(`Missing backup for engine target '${entry.rel}'.`)
        const targetStat = fs.lstatSync(target, { throwIfNoEntry: false })
        if (entry.existed) {
          if (backupStat!.isFile() && (!targetStat || targetStat.isFile())) {
            const restoreStage = path.join(backupRoot, "stage", `restore-${entry.idx}`)
            assertSafeEnginePath(engineRoot, restoreStage)
            fs.mkdirSync(path.dirname(restoreStage), { recursive: true, mode: 0o700 })
            removePathWithRetry(restoreStage)
            copyTree(backup, restoreStage)
            movePathWithRetry(restoreStage, target)
          } else {
            removePathWithRetry(target)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            copyTree(backup, target)
          }
          if (!pathContentsMatch(backup, target)) throw new Error(`Unable to verify restored engine target '${entry.rel}'.`)
        } else {
          removePathWithRetry(target)
          if (fs.lstatSync(target, { throwIfNoEntry: false })) {
            throw new Error(`Unable to verify removal of engine target '${entry.rel}'.`)
          }
        }
      }

      const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false })
      if (manifestStat?.isSymbolicLink()) throw new Error("Refusing a symlink release manifest during recovery.")
      removePathWithRetry(manifestPath)
      if (journal.manifestExisted) {
        const manifestBackupStat = fs.lstatSync(manifestBackup, { throwIfNoEntry: false })
        if (!manifestBackupStat?.isFile() || manifestBackupStat.isSymbolicLink()) throw new Error("Release manifest backup is missing or invalid.")
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
        copyTree(manifestBackup, manifestPath)
        if (!pathContentsMatch(manifestBackup, manifestPath)) throw new Error("Unable to verify restored release manifest.")
      } else if (fs.lstatSync(manifestPath, { throwIfNoEntry: false })) {
        throw new Error("Unable to verify removal of release manifest.")
      }

      removePathWithRetry(path.join(backupRoot, "stage"))
      fs.unlinkSync(journalPath)
      fsyncDirectory(stateDir)
      removePathWithRetry(backupRoot)
      try {
        if (fs.readdirSync(backupBase).length === 0) fs.rmdirSync(backupBase)
      } catch (error: any) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error
      }
      return true
    } catch (error) {
      throw new Error(`Unable to recover interrupted self-update; backup retained at ${safeText(backupRoot)}: ${safeText(error)}`)
    }
  })
}

function fileDigestOrNull(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false })
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
  } catch {
    return null
  }
}

function runDependencyInstallSync(engineRoot: string, env: NodeJS.ProcessEnv): void {
  const isBun = Boolean(process.versions.bun)
  const command = isBun ? "bun" : process.platform === "win32" ? "npm.cmd" : "npm"
  const args = isBun
    ? fs.existsSync(path.join(engineRoot, "bun.lock"))
      ? ["install", "--frozen-lockfile", "--ignore-scripts"]
      : ["install", "--no-save", "--ignore-scripts"]
    : fs.existsSync(path.join(engineRoot, "package-lock.json"))
      ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]
      : ["install", "--ignore-scripts", "--no-audit", "--no-fund"]

  const result = spawnSync(command, args, {
    cwd: engineRoot,
    env: cleanGitEnvironment(env),
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && !isBun,
    timeout: 180_000,
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    const detail = terminalSafeText((result.stderr || result.error?.message || "").trim()).slice(-300)
    throw new Error(`Dependency installation after update failed${detail ? `: ${detail}` : "."}`)
  }
}

export async function applyEngineUpdate(
  overrideEngineRoot?: string,
  options: {
    force?: boolean
    reconcile?: boolean
    target?: string
    repository?: string
    env?: NodeJS.ProcessEnv
    transport?: ReleaseTransport
    requireSignature?: boolean
    allowUnsigned?: boolean
    skipDependencyInstall?: boolean
    dependencyInstaller?: (engineRoot: string, env: NodeJS.ProcessEnv) => void
    checkResult?: EngineUpdateCheckResult
    onProgress?: (stepMessage: string) => void
  } = {},
): Promise<EngineUpdateResult> {
  return sanitizedAsync(async () => {
    const env = options.env ?? process.env
    const engineRoot = resolveEngineRoot(overrideEngineRoot)
    recoverInterruptedSelfUpdate(engineRoot)
    const checkResult =
      options.checkResult ??
      (await checkForEngineUpdate(engineRoot, {
        repository: options.repository,
        target: options.target,
        env,
        transport: options.transport,
        requireSignature: options.requireSignature,
        allowUnsigned: options.allowUnsigned,
        onProgress: options.onProgress,
      }))

    if (hasUncommittedEngineChanges(engineRoot) && !options.force) {
      throw new Error("Engine self-update refused because the manage-agents directory has uncommitted changes; pass --force to overwrite.")
    }
    if (checkResult.downgrade && !options.force) {
      throw new Error(
        `Latest release ${checkResult.metadata.tag} is older than installed ${checkResult.currentVersion.displayVersion}; pass --force to downgrade.`,
      )
    }

    if (!checkResult.updateAvailable && !options.force) {
      let reconcileResult: ChangeResult | undefined
      if (options.reconcile === true && checkResult.targetReconcileNeeded) {
        await reportProgress(options.onProgress, "Reconciling OpenCode target...")
        const target = realpathThroughExistingAncestor(path.resolve(options.target ?? defaultTarget(env)))
        reconcileResult = await changeTarget(target, "reconcile", loadSources(env), reconcileChange, {
          adopt: false,
          dryRun: false,
          confirm: async () => true,
        })
      }
      return {
        checkResult,
        applied: false,
        dependenciesInstalled: false,
        versionInfo: resolveEngineVersion(engineRoot),
        ...(reconcileResult ? { reconcileResult } : {}),
      }
    }

    const transport = options.transport ?? createDefaultReleaseTransport({ env })
    await reportProgress(options.onProgress, `Downloading release archive (${checkResult.metadata.archive.name})...`)
    const archiveBuffer = Buffer.from(await transport.downloadAsset(checkResult.repository, checkResult.archiveAsset))

    await reportProgress(options.onProgress, "Verifying archive SHA-256 and extracting...")
    const actualSha256 = `sha256:${crypto.createHash("sha256").update(archiveBuffer).digest("hex")}`
    if (archiveBuffer.byteLength !== checkResult.metadata.archive.size || actualSha256 !== checkResult.metadata.archive.sha256) {
      throw new Error("Downloaded release archive does not match its expected size and SHA-256 digest.")
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manage-agents-self-update-"))
    fs.chmodSync(tempRoot, 0o700)
    let journalWritten = false
    let backupRoot: string | null = null
    try {
      const archiveFile = path.join(tempRoot, checkResult.metadata.archive.name)
      const extractRoot = path.join(tempRoot, "extracted")
      fs.mkdirSync(extractRoot, { mode: 0o700 })
      fs.writeFileSync(archiveFile, archiveBuffer, { mode: 0o600 })

      await extractTarGzAsync(archiveFile, extractRoot)
      assertNoSymlinkTree(extractRoot)

      const expectedPkgDirName = `manage-agents-${checkResult.metadata.tag}`
      const stagedRoot = resolveExtractedEngineDir(extractRoot, expectedPkgDirName)
      const stagedManifest = validateStagedEngineManifest(stagedRoot, checkResult.metadata)

      for (const reqRel of ENGINE_REQUIRED_TARGETS) {
        const st = fs.lstatSync(path.join(stagedRoot, ...reqRel.split("/")), { throwIfNoEntry: false })
        if (!st || st.isSymbolicLink()) {
          throw new Error(`Release archive is missing required engine target '${reqRel}'.`)
        }
      }

      const prevPkgDigest = fileDigestOrNull(path.join(engineRoot, "package.json"))
      const prevLockDigest = fileDigestOrNull(path.join(engineRoot, "package-lock.json"))
      const prevBunLockDigest = fileDigestOrNull(path.join(engineRoot, "bun.lock"))
      const nextPkgDigest = fileDigestOrNull(path.join(stagedRoot, "package.json"))
      const nextLockDigest = fileDigestOrNull(path.join(stagedRoot, "package-lock.json"))
      const nextBunLockDigest = fileDigestOrNull(path.join(stagedRoot, "bun.lock"))
      const depsChanged =
        prevPkgDigest !== nextPkgDigest ||
        prevLockDigest !== nextLockDigest ||
        prevBunLockDigest !== nextBunLockDigest ||
        !fs.existsSync(path.join(engineRoot, "node_modules"))

      let dependenciesInstalled = false
      if (depsChanged && !options.skipDependencyInstall) {
        await reportProgress(options.onProgress, "Updating engine dependencies in staging...")
        const installer = options.dependencyInstaller ?? runDependencyInstallSync
        installer(stagedRoot, env)
        dependenciesInstalled = true
      }

      await reportProgress(options.onProgress, `Applying ${checkResult.metadata.tag} to ${engineRoot}...`)
      const stateDir = path.join(engineRoot, ".manage-agents")
      const journalPath = path.join(engineRoot, ...SELF_UPDATE_JOURNAL_REL.split("/"))
      const backupBase = path.join(engineRoot, ...SELF_UPDATE_BACKUP_DIR_REL.split("/"))
      const manifestPath = path.join(stateDir, "release-manifest.json")
      assertSafeEnginePath(engineRoot, stateDir)
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      fsyncDirectory(engineRoot)
      assertSafeEnginePath(engineRoot, stateDir)
      assertSafeEnginePath(engineRoot, journalPath)
      assertSafeEnginePath(engineRoot, backupBase)
      if (fs.lstatSync(journalPath, { throwIfNoEntry: false })) throw new Error("An unrecovered self-update journal already exists.")
      fs.mkdirSync(backupBase, { recursive: true, mode: 0o700 })
      fsyncDirectory(stateDir)
      assertSafeEnginePath(engineRoot, backupBase)
      const id = crypto.randomBytes(16).toString("hex")
      backupRoot = path.join(backupBase, id)
      fs.mkdirSync(backupRoot, { mode: 0o700 })
      const backupEntries = path.join(backupRoot, "entries")
      fs.mkdirSync(backupEntries, { mode: 0o700 })

      const stagedHasNodeModules = Boolean(fs.lstatSync(path.join(stagedRoot, "node_modules"), { throwIfNoEntry: false }))
      const allTargets = [
        ...ENGINE_REQUIRED_TARGETS.filter(rel => rel !== "manage-agents.mjs"),
        ...ENGINE_OPTIONAL_TARGETS,
        ...(dependenciesInstalled && stagedHasNodeModules ? (["node_modules"] as const) : []),
        "manage-agents.mjs",
      ]
      const backups: Array<{ idx: number; rel: string; target: string; backup: string; existed: boolean; inStage: boolean }> = []

      for (const [idx, rel] of allTargets.entries()) {
        const target = path.join(engineRoot, ...rel.split("/"))
        const staged = path.join(stagedRoot, ...rel.split("/"))
        assertSafeEnginePath(engineRoot, target)
        const targetStat = fs.lstatSync(target, { throwIfNoEntry: false })
        if (targetStat?.isSymbolicLink()) throw new Error(`Refusing to replace symlink inside engine directory: ${rel}`)
        const stagedStat = fs.lstatSync(staged, { throwIfNoEntry: false })
        if (!stagedStat && !targetStat) continue
        const backup = path.join(backupEntries, String(idx))
        assertSafeEnginePath(engineRoot, backup)
        if (targetStat) copyTree(target, backup)
        backups.push({ idx, rel, target, backup, existed: Boolean(targetStat), inStage: Boolean(stagedStat) })
      }

      assertSafeEnginePath(engineRoot, manifestPath)
      const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false })
      if (manifestStat && (!manifestStat.isFile() || manifestStat.isSymbolicLink())) {
        throw new Error("Release manifest must be a regular file before self-update.")
      }
      const manifestExisted = Boolean(manifestStat)
      const manifestBackup = path.join(backupRoot, "release-manifest.json")
      if (manifestExisted) copyTree(manifestPath, manifestBackup)
      const stageEntries = path.join(backupRoot, "stage")
      fs.mkdirSync(stageEntries, { mode: 0o700 })
      for (const entry of backups) {
        if (!entry.inStage) continue
        const staged = path.join(stagedRoot, ...entry.rel.split("/"))
        const sameFsStageEntry = path.join(stageEntries, String(entry.idx))
        assertSafeEnginePath(engineRoot, sameFsStageEntry)
        copyTree(staged, sameFsStageEntry)
      }
      fsyncPathTree(backupRoot)
      fsyncDirectory(backupBase)

      const journal: SelfUpdateJournal = {
        schemaVersion: 1,
        id,
        entries: backups.map(entry => ({ idx: entry.idx, rel: entry.rel, existed: entry.existed })),
        manifestExisted,
      }
      atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600, engineRoot)
      journalWritten = true

      let finalVersion: EngineVersionInfo
      for (const entry of backups) {
        if (entry.inStage) {
          const sameFsStageEntry = path.join(stageEntries, String(entry.idx))
          const stageStat = fs.lstatSync(sameFsStageEntry)
          const targetStat = fs.lstatSync(entry.target, { throwIfNoEntry: false })
          fs.mkdirSync(path.dirname(entry.target), { recursive: true })
          if (stageStat.isFile() && (!targetStat || targetStat.isFile())) {
            movePathWithRetry(sameFsStageEntry, entry.target)
          } else {
            removePathWithRetry(entry.target)
            movePathWithRetry(sameFsStageEntry, entry.target)
          }
        } else {
          removePathWithRetry(entry.target)
        }
      }

      // Touch dist/index.js so the launcher never sees stale mtime relative to extracted src/
      const distEntry = path.join(engineRoot, "dist", "index.js")
      if (fs.existsSync(distEntry)) {
        const now = new Date()
        fs.utimesSync(distEntry, now, now)
      }

      stampAppliedEngineManifest(engineRoot, stagedManifest)
      finalVersion = resolveEngineVersion(engineRoot)
      if (finalVersion.channel !== "release" || finalVersion.dirty || finalVersion.version !== stagedManifest.tag) {
        throw new Error("Installed engine release failed post-update version verification.")
      }

      removePathWithRetry(stageEntries)
      fs.unlinkSync(journalPath)
      journalWritten = false
      fsyncDirectory(stateDir)
      removePathWithRetry(backupRoot)
      backupRoot = null
      try {
        if (fs.readdirSync(backupBase).length === 0) fs.rmdirSync(backupBase)
      } catch (error: any) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error
      }

      let reconcileResult: ChangeResult | undefined
      if (options.reconcile !== false && checkResult.targetReconcileNeeded) {
        await reportProgress(options.onProgress, "Reconciling OpenCode target router plugin...")
        const target = realpathThroughExistingAncestor(path.resolve(options.target ?? defaultTarget(env)))
        reconcileResult = await changeTarget(target, "reconcile", loadSources(env), reconcileChange, {
          adopt: false,
          dryRun: false,
          confirm: async () => true,
        })
      }

      return {
        checkResult,
        applied: true,
        dependenciesInstalled,
        versionInfo: finalVersion,
        ...(reconcileResult ? { reconcileResult } : {}),
      }
    } catch (error) {
      const journalPath = path.join(engineRoot, ...SELF_UPDATE_JOURNAL_REL.split("/"))
      const journalOnDisk = fs.lstatSync(journalPath, { throwIfNoEntry: false })
      if (journalWritten || journalOnDisk) {
        try {
          recoverInterruptedSelfUpdate(engineRoot)
        } catch (recoveryError) {
          throw new Error(`${safeText(error)} ${safeText(recoveryError)}`)
        }
      } else if (backupRoot) {
        try {
          removePathWithRetry(backupRoot)
        } catch {}
      }
      throw error
    } finally {
      try {
        removePathWithRetry(tempRoot)
      } catch {}
    }
  })
}
