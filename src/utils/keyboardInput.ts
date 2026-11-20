import { terminalSafeText } from "./terminalText.js"

export const PASTE_START = "\x1b[200~"
export const PASTE_END = "\x1b[201~"

export const MAX_PASTE_CHARS = 4096
const MAX_PASTE_EVENTS = 256

export interface PasteBuffer {
  inside: boolean
  parts: string[]
  nested: number
  chars: number
  events: number
}

export type PasteOutcome =
  | { kind: "pass" }
  | { kind: "hold"; prefix?: string }
  | { kind: "commit"; text: string; rest?: string }
  | { kind: "reset"; reason: "cap" | "escape" | "malformed"; rest?: string }

export function emptyPasteBuffer(): PasteBuffer {
  return { inside: false, parts: [], nested: 0, chars: 0, events: 0 }
}

export function sanitizePasteText(text: string): string {
  return terminalSafeText(text)
}

function overCap(buffer: PasteBuffer): boolean {
  return buffer.chars > MAX_PASTE_CHARS || buffer.events > MAX_PASTE_EVENTS
}

function processInside(seq: string, input: PasteBuffer): { buffer: PasteBuffer; outcome: PasteOutcome } {
  if (seq === "\x1b") {
    return { buffer: emptyPasteBuffer(), outcome: { kind: "reset", reason: "escape" } }
  }

  const buffer: PasteBuffer = { ...input, parts: input.parts.slice() }
  let current = seq

  while (true) {
    const startAt = current.indexOf(PASTE_START)
    const endAt = current.indexOf(PASTE_END)
    const hasStart = startAt >= 0
    const hasEnd = endAt >= 0

    if (!hasStart && !hasEnd) {
      if (current.length > 0) {
        const safe = sanitizePasteText(current)
        buffer.parts.push(safe)
        buffer.chars += safe.length
      }
      break
    }

    const markerAt = hasStart && (!hasEnd || startAt < endAt) ? startAt : endAt
    const isStart = hasStart && markerAt === startAt
    const before = current.slice(0, markerAt)
    if (before.length > 0) {
      const safe = sanitizePasteText(before)
      buffer.parts.push(safe)
      buffer.chars += safe.length
    }
    current = current.slice(markerAt + (isStart ? PASTE_START.length : PASTE_END.length))

    if (isStart) {
      buffer.nested += 1
      continue
    }
    if (buffer.nested > 0) {
      buffer.nested -= 1
      continue
    }
    if (overCap(buffer)) {
      return { buffer: emptyPasteBuffer(), outcome: { kind: "reset", reason: "cap" } }
    }
    const outcome: PasteOutcome = { kind: "commit", text: buffer.parts.join("") }
    if (current.length > 0) outcome.rest = current
    return { buffer: emptyPasteBuffer(), outcome }
  }

  if (overCap(buffer)) {
    return { buffer: emptyPasteBuffer(), outcome: { kind: "reset", reason: "cap" } }
  }
  return { buffer, outcome: { kind: "hold" } }
}

export function consumePasteSequence(
  seq: string,
  buffer: PasteBuffer,
): { buffer: PasteBuffer; outcome: PasteOutcome } {
  if (buffer.inside) {
    return processInside(seq, { ...buffer, events: buffer.events + 1 })
  }

  const startAt = seq.indexOf(PASTE_START)
  if (startAt < 0) return { buffer, outcome: { kind: "pass" } }

  const prefix = seq.slice(0, startAt)
  const opened: PasteBuffer = { inside: true, parts: [], nested: 0, chars: 0, events: 1 }
  const result = processInside(seq.slice(startAt + PASTE_START.length), opened)
  if (result.outcome.kind === "hold" && prefix.length > 0) {
    return { buffer: result.buffer, outcome: { kind: "hold", prefix } }
  }
  return result
}
