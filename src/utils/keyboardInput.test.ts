import assert from "node:assert/strict"
import test from "node:test"
import {
  consumePasteSequence,
  emptyPasteBuffer,
  PASTE_END,
  PASTE_START,
  type PasteOutcome,
} from "./keyboardInput.js"

function asCommit(outcome: PasteOutcome): Extract<PasteOutcome, { kind: "commit" }> {
  if (outcome.kind !== "commit") {
    assert.fail(`expected commit, got ${outcome.kind}`)
  }
  return outcome
}

function asHold(outcome: PasteOutcome): Extract<PasteOutcome, { kind: "hold" }> {
  if (outcome.kind !== "hold") {
    assert.fail(`expected hold, got ${outcome.kind}`)
  }
  return outcome
}

function asReset(outcome: PasteOutcome): Extract<PasteOutcome, { kind: "reset" }> {
  if (outcome.kind !== "reset") {
    assert.fail(`expected reset, got ${outcome.kind}`)
  }
  return outcome
}

test("START, testo e END in un solo evento producono un solo commit", () => {
  const result = consumePasteSequence(`${PASTE_START}hello${PASTE_END}`, emptyPasteBuffer())
  assert.equal(asCommit(result.outcome).text, "hello")
  assert.deepEqual(result.buffer, emptyPasteBuffer())
})

test("frammenti separati restano nascosti e vengono concatenati in ordine", () => {
  let state = consumePasteSequence(PASTE_START, emptyPasteBuffer())
  assert.equal(asHold(state.outcome).kind, "hold")

  for (const fragment of ["frag1", "frag2", "frag3"]) {
    state = consumePasteSequence(fragment, state.buffer)
    assert.equal(state.outcome.kind, "hold", "nessun frammento deve essere visibile")
  }

  state = consumePasteSequence(PASTE_END, state.buffer)
  assert.equal(asCommit(state.outcome).text, "frag1frag2frag3")
  assert.deepEqual(state.buffer, emptyPasteBuffer())
})

test("incolla vuoto START+END non modifica il testo", () => {
  const result = consumePasteSequence(PASTE_START + PASTE_END, emptyPasteBuffer())
  assert.equal(asCommit(result.outcome).text, "")
  assert.deepEqual(result.buffer, emptyPasteBuffer())
})

test("nel payload sopravvive solo testo stampabile, senza Invio automatico", () => {
  const payload = "a\nb\tc\x1b[31mred\x1b]0;title\x07!\x0b"
  const result = consumePasteSequence(`${PASTE_START}${payload}${PASTE_END}`, emptyPasteBuffer())
  const text = asCommit(result.outcome).text

  assert.equal(text, "abcred!")
  assert.ok(!text.includes("\n"))
  assert.ok(!text.includes("\t"))
  assert.ok(!text.includes("\x1b"))
})

test("START doppio richiede due END prima del commit", () => {
  let state = consumePasteSequence(PASTE_START, emptyPasteBuffer())
  state = consumePasteSequence(PASTE_START, state.buffer)
  assert.equal(state.outcome.kind, "hold")
  assert.equal(state.buffer.nested, 1)

  state = consumePasteSequence("text", state.buffer)
  state = consumePasteSequence(PASTE_END, state.buffer)
  assert.equal(state.outcome.kind, "hold")
  assert.equal(state.buffer.nested, 0)

  state = consumePasteSequence(PASTE_END, state.buffer)
  assert.equal(asCommit(state.outcome).text, "text")
})

test("END fuori dallo stato viene passato senza effetti", () => {
  const buffer = emptyPasteBuffer()
  const result = consumePasteSequence(PASTE_END, buffer)

  assert.equal(result.outcome.kind, "pass")
  assert.equal(result.buffer, buffer)
})

test("START senza END oltre il cap produce reset e stato ripulito", () => {
  let state = consumePasteSequence(PASTE_START, emptyPasteBuffer())
  state = consumePasteSequence("x".repeat(4097), state.buffer)

  assert.equal(asReset(state.outcome).reason, "cap")
  assert.deepEqual(state.buffer, emptyPasteBuffer())

  const next = consumePasteSequence(`${PASTE_START}ok${PASTE_END}`, state.buffer)
  assert.equal(asCommit(next.outcome).text, "ok")
})

test("Escape, Tab, freccia su e vertical tab non entrano nel testo incollato", () => {
  let state = consumePasteSequence(PASTE_START, emptyPasteBuffer())
  for (const seq of ["a", "\t", "\x1b[A", "\x0b", "b"]) {
    state = consumePasteSequence(seq, state.buffer)
    assert.equal(state.outcome.kind, "hold")
  }
  state = consumePasteSequence(PASTE_END, state.buffer)
  assert.equal(asCommit(state.outcome).text, "ab")

  let escaped = consumePasteSequence(PASTE_START, emptyPasteBuffer())
  escaped = consumePasteSequence("\x1b", escaped.buffer)
  assert.equal(asReset(escaped.outcome).reason, "escape")
  assert.deepEqual(escaped.buffer, emptyPasteBuffer())
})

test("fuori dall'incolla le sequenze di tasti normali restano pass", () => {
  let buffer = emptyPasteBuffer()
  for (const seq of ["a", "\x1b[A", "\t", "hello"]) {
    const result = consumePasteSequence(seq, buffer)
    assert.equal(result.outcome.kind, "pass")
    buffer = result.buffer
  }
  assert.deepEqual(buffer, emptyPasteBuffer())
})

test("due incolli consecutivi non condividono le parti", () => {
  let state = consumePasteSequence(`${PASTE_START}first${PASTE_END}`, emptyPasteBuffer())
  assert.equal(asCommit(state.outcome).text, "first")

  state = consumePasteSequence(`${PASTE_START}second${PASTE_END}`, state.buffer)
  assert.equal(asCommit(state.outcome).text, "second")
})

test("testo prima di START e dopo END viene restituito come prefix e rest", () => {
  const opened = consumePasteSequence(`before${PASTE_START}pasted`, emptyPasteBuffer())
  assert.equal(asHold(opened.outcome).prefix, "before")

  const closed = consumePasteSequence(`${PASTE_END}after`, opened.buffer)
  const commit = asCommit(closed.outcome)
  assert.equal(commit.text, "pasted")
  assert.equal(commit.rest, "after")

  const replay = consumePasteSequence(commit.rest!, emptyPasteBuffer())
  assert.equal(replay.outcome.kind, "pass")
})
