import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isTransientWindowsLockError, movePathWithRetry, removePathWithRetry } from "./fsWindows.js"

test("movePathWithRetry retries transient EPERM/EBUSY errors before succeeding", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-fswin-"))
  try {
    const src = path.join(tmp, "source.txt")
    const dst = path.join(tmp, "dest.txt")
    fs.writeFileSync(src, "hello")
    let calls = 0
    const delays: number[] = []

    movePathWithRetry(src, dst, {
      sleepMs: ms => delays.push(ms),
      renameSync: (from, to) => {
        calls++
        if (calls < 3) {
          const err = Object.assign(new Error("locked"), { code: calls === 1 ? "EPERM" : "EBUSY" })
          throw err
        }
        fs.renameSync(from, to)
      },
    })

    assert.equal(calls, 3)
    assert.deepEqual(delays, [10, 25])
    assert.equal(fs.readFileSync(dst, "utf8"), "hello")
    assert.equal(fs.existsSync(src), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("movePathWithRetry falls back to copy+remove when rename keeps failing with EACCES", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-fswin-fallback-"))
  try {
    const srcDir = path.join(tmp, "src-dir")
    const dstDir = path.join(tmp, "dst-dir")
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, "nested.txt"), "payload")

    movePathWithRetry(srcDir, dstDir, {
      sleepMs: () => {},
      renameSync: () => {
        throw Object.assign(new Error("access denied"), { code: "EACCES" })
      },
    })

    assert.equal(fs.readFileSync(path.join(dstDir, "nested.txt"), "utf8"), "payload")
    assert.equal(fs.existsSync(srcDir), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("isTransientWindowsLockError distinguishes lock codes from fatal filesystem errors", () => {
  assert.equal(isTransientWindowsLockError({ code: "EPERM" }), true)
  assert.equal(isTransientWindowsLockError({ code: "EACCES" }), true)
  assert.equal(isTransientWindowsLockError({ code: "EBUSY" }), true)
  assert.equal(isTransientWindowsLockError({ code: "ENOENT" }), false)
  assert.equal(isTransientWindowsLockError(new Error("boom")), false)
})

test("removePathWithRetry retries EACCES and movePathWithRetry preserves destination if copy fails", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-fswin-safe-"))
  try {
    let rmCalls = 0
    const targetToDelete = path.join(tmp, "del.txt")
    fs.writeFileSync(targetToDelete, "bye")
    removePathWithRetry(
      targetToDelete,
      ((p: fs.PathLike, opts?: fs.RmOptions) => {
        rmCalls++
        if (rmCalls < 3) throw Object.assign(new Error("denied"), { code: "EACCES" })
        fs.rmSync(p, opts)
      }) as typeof fs.rmSync,
      () => {},
    )
    assert.equal(rmCalls, 3)
    assert.equal(fs.existsSync(targetToDelete), false)

    const src = path.join(tmp, "new.txt")
    const dst = path.join(tmp, "existing.txt")
    fs.writeFileSync(src, "new-bytes")
    fs.writeFileSync(dst, "precious-old-bytes")

    assert.throws(
      () =>
        movePathWithRetry(src, dst, {
          sleepMs: () => {},
          renameSync: () => {
            throw Object.assign(new Error("locked"), { code: "EACCES" })
          },
          cpSync: () => {
            throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })
          },
        }),
      /ENOSPC/,
    )
    assert.equal(fs.readFileSync(dst, "utf8"), "precious-old-bytes")
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("movePathWithRetry restores the original target after a partial replacement copy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-fswin-rollback-"))
  try {
    const src = path.join(tmp, "source.txt")
    const dst = path.join(tmp, "dest.txt")
    fs.writeFileSync(src, "new-bytes")
    fs.writeFileSync(dst, "original-bytes")
    let backup = ""

    assert.throws(
      () =>
        movePathWithRetry(src, dst, {
          sleepMs: () => {},
          renameSync: (from, to) => {
            if (from === src) throw Object.assign(new Error("cross-device"), { code: "EXDEV" })
            if (String(from).includes(".stage-") && to === dst) throw new Error("staged rename failed")
            fs.renameSync(from, to)
          },
          cpSync: (from, to, options) => {
            if (String(to).includes(".bak-")) backup = String(to)
            if (String(from).includes(".stage-") && to === dst) {
              fs.writeFileSync(to, "partial-bytes")
              throw new Error("replacement copy failed")
            }
            fs.cpSync(from, to, options)
          },
        }),
      /replacement copy failed/,
    )

    assert.equal(fs.readFileSync(dst, "utf8"), "original-bytes")
    assert.notEqual(backup, "")
    assert.equal(fs.existsSync(backup), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("movePathWithRetry retains the backup when target restoration fails", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-fswin-rollback-fail-"))
  try {
    const src = path.join(tmp, "source.txt")
    const dst = path.join(tmp, "dest.txt")
    fs.writeFileSync(src, "new-bytes")
    fs.writeFileSync(dst, "original-bytes")
    let backup = ""

    let replaceError: unknown
    try {
      movePathWithRetry(src, dst, {
        sleepMs: () => {},
        renameSync: (from, to) => {
          if (from === src) throw Object.assign(new Error("cross-device"), { code: "EXDEV" })
          if (to === dst && String(from).includes(".stage-")) throw new Error("staged rename failed")
          if (to === dst && String(from).includes(".bak-")) throw new Error("restore rename failed")
          fs.renameSync(from, to)
        },
        cpSync: (from, to, options) => {
          if (String(to).includes(".bak-")) backup = String(to)
          if (to === dst && String(from).includes(".stage-")) {
            fs.writeFileSync(to, "partial-bytes")
            throw new Error("replacement copy failed")
          }
          if (to === dst && String(from).includes(".bak-")) throw new Error("restore copy failed")
          fs.cpSync(from, to, options)
        },
      })
    } catch (error) {
      replaceError = error
    }

    assert.ok(replaceError instanceof Error)
    assert.match(replaceError.message, /replacement copy failed/)
    assert.match(replaceError.message, /rollback failed: restore copy failed/)
    assert.ok(backup)
    assert.ok(replaceError.message.includes(backup))
    assert.equal(fs.readFileSync(backup, "utf8"), "original-bytes")
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("movePathWithRetry copies dangling symlinks during EXDEV fallback", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-fswin-dangling-link-"))
  try {
    const src = path.join(tmp, "source-link")
    const dst = path.join(tmp, "dest-link")
    fs.symlinkSync("missing-target", src)

    movePathWithRetry(src, dst, {
      sleepMs: () => {},
      renameSync: (from, to) => {
        if (from === src) throw Object.assign(new Error("cross-device"), { code: "EXDEV" })
        fs.renameSync(from, to)
      },
    })

    assert.equal(fs.readlinkSync(dst), "missing-target")
    assert.equal(fs.lstatSync(dst).isSymbolicLink(), true)
    assert.equal(fs.lstatSync(src, { throwIfNoEntry: false }), undefined)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
