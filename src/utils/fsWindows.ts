import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const TRANSIENT_WINDOWS_LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY"])
const MOVE_RETRY_DELAYS_MS = [10, 25, 50, 100]

export const WINDOWS_SAFE_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const

export interface FsMoveOps {
  renameSync: typeof fs.renameSync
  cpSync: typeof fs.cpSync
  rmSync: typeof fs.rmSync
  lstatSync: typeof fs.lstatSync
  sleepMs?: (ms: number) => void
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      // Spin fallback when SharedArrayBuffer is unavailable.
    }
  }
}

export function isTransientWindowsLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" && TRANSIENT_WINDOWS_LOCK_CODES.has(code)
}

export function removePathWithRetry(
  target: string,
  rmImpl: typeof fs.rmSync = fs.rmSync,
  sleep: (ms: number) => void = sleepSync,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmImpl(target, WINDOWS_SAFE_RM_OPTIONS)
      return
    } catch (error) {
      if (!isTransientWindowsLockError(error) || attempt >= MOVE_RETRY_DELAYS_MS.length) throw error
      sleep(MOVE_RETRY_DELAYS_MS[attempt]!)
    }
  }
}

/**
 * Moves a file or directory across paths, retrying transient Windows file-indexer/AV locks (`EPERM`, `EACCES`, `EBUSY`)
 * and falling back to staged copy + remove so an existing destination is never deleted before the copy succeeds.
 */
export function movePathWithRetry(source: string, target: string, ops: Partial<FsMoveOps> = {}): void {
  const renameSync = ops.renameSync ?? fs.renameSync
  const cpSync = ops.cpSync ?? fs.cpSync
  const rmSync = ops.rmSync ?? fs.rmSync
  const lstatSync = ops.lstatSync ?? fs.lstatSync
  const sleep = ops.sleepMs ?? sleepSync
  const copyEntry = (from: string, to: string): void => {
    const sourceStat = lstatSync(from, { throwIfNoEntry: false })
    if (sourceStat?.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to)
      return
    }
    cpSync(from, to, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= MOVE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      renameSync(source, target)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === "EXDEV") break
      if (!isTransientWindowsLockError(error)) throw error
      if (attempt < MOVE_RETRY_DELAYS_MS.length) sleep(MOVE_RETRY_DELAYS_MS[attempt]!)
    }
  }

  const stat = lstatSync(source, { throwIfNoEntry: false })
  if (!stat) throw lastError

  const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  const staged = `${path.resolve(target)}.stage-${suffix}`
  const backup = `${path.resolve(target)}.bak-${suffix}`
  const targetExisted = Boolean(lstatSync(target, { throwIfNoEntry: false }))
  try {
    copyEntry(source, staged)
    if (targetExisted) copyEntry(target, backup)
  } catch (preparationError) {
    try {
      removePathWithRetry(staged, rmSync, sleep)
    } catch {}
    try {
      removePathWithRetry(backup, rmSync, sleep)
    } catch {}
    throw preparationError
  }

  try {
    removePathWithRetry(target, rmSync, sleep)
    try {
      renameSync(staged, target)
    } catch {
      copyEntry(staged, target)
      removePathWithRetry(staged, rmSync, sleep)
    }
  } catch (replaceError) {
    try {
      removePathWithRetry(staged, rmSync, sleep)
    } catch {}
    if (targetExisted) {
      try {
        removePathWithRetry(target, rmSync, sleep)
        try {
          renameSync(backup, target)
        } catch {
          copyEntry(backup, target)
        }
        if (!lstatSync(target, { throwIfNoEntry: false })) {
          throw new Error("restored target is missing")
        }
      } catch (restoreErr) {
        throw new Error(
          `${(replaceError as Error)?.message || replaceError} (rollback failed: ${(restoreErr as Error)?.message || restoreErr}; backup retained at ${backup})`,
        )
      }
      try {
        removePathWithRetry(backup, rmSync, sleep)
      } catch {}
    } else {
      try {
        removePathWithRetry(target, rmSync, sleep)
      } catch {}
    }
    throw replaceError
  }
  if (targetExisted) {
    try {
      removePathWithRetry(backup, rmSync, sleep)
    } catch {}
  }
  removePathWithRetry(source, rmSync, sleep)
}
