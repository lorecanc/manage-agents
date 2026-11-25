import { isDeepStrictEqual } from "node:util"
import { applyEdits, createScanner, parseTree, SyntaxKind, type Edit, type Node, type ParseError } from "jsonc-parser"

export type JsoncArrayOrigins = ReadonlyMap<string, readonly (number | null)[]>

interface Span {
  offset: number
  length: number
}

interface CommentSpan extends Span {
  text: string
}

export const jsoncArrayPath = (path: readonly (string | number)[]) => JSON.stringify(path)

function parseErrors(text: string): { root: Node | undefined; errors: ParseError[] } {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true })
  return { root, errors }
}

function commentsIn(text: string): CommentSpan[] {
  const scanner = createScanner(text, false)
  const comments: CommentSpan[] = []
  for (;;) {
    const token = scanner.scan()
    if (token === SyntaxKind.EOF) return comments
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      const offset = scanner.getTokenOffset()
      const length = scanner.getTokenLength()
      comments.push({ offset, length, text: text.slice(offset, offset + length) })
    }
  }
}

function ownObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serialize(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  if (text === undefined) throw new Error("unsupported JSON value")
  return text
}

function lineIndent(text: string, offset: number): string | null {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  const prefix = text.slice(lineStart, offset)
  return /^\s*$/.test(prefix) ? prefix : null
}

function indentUnit(text: string, root: Node): string {
  const first = root.children?.[0]
  if (first) {
    const indent = lineIndent(text, first.offset)
    if (indent && indent.length) return indent
  }
  const match = text.match(/\n([ \t]+)\S/)
  return match?.[1] ?? "  "
}

function propertyNodes(node: Node): Array<{ key: string; property: Node; value: Node }> {
  const result: Array<{ key: string; property: Node; value: Node }> = []
  const seen = new Set<string>()
  for (const property of node.children ?? []) {
    if (property.type !== "property") continue
    const [keyNode, valueNode] = property.children ?? []
    if (typeof keyNode?.value !== "string" || !valueNode) throw new Error("invalid JSONC object")
    if (seen.has(keyNode.value)) throw new Error("duplicate JSONC key")
    seen.add(keyNode.value)
    result.push({ key: keyNode.value, property, value: valueNode })
  }
  return result
}

function childPathIndent(path: readonly (string | number)[], unit: string): string {
  return unit.repeat(path.length + 1)
}

function preservedComments(comments: readonly CommentSpan[], start: number, end: number, eol: string, indent: string): string {
  let low = 0
  let high = comments.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (comments[middle].offset < start) low = middle + 1
    else high = middle
  }
  const retained: CommentSpan[] = []
  for (let index = low; index < comments.length && comments[index].offset + comments[index].length <= end; index++) retained.push(comments[index])
  return retained.length ? `${eol}${indent}${retained.map(comment => comment.text).join(`${eol}${indent}`)}${eol}${indent}` : ""
}

function firstSpanInGap(spans: readonly Span[], start: number, end: number): Span | undefined {
  let low = 0
  let high = spans.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (spans[middle].offset < start) low = middle + 1
    else high = middle
  }
  const span = spans[low]
  return span && span.offset + span.length <= end ? span : undefined
}

function insertSeparator(edits: Edit[], offset: number): void {
  const removal = edits.find(edit => edit.offset === offset && edit.length > 0)
  if (removal) removal.content = `,${removal.content}`
  else edits.push({ offset, length: 0, content: "," })
}

function removeRun(nodes: readonly Node[], first: number, last: number, closeOffset: number, keepLeadingSeparator: boolean, comments: readonly CommentSpan[], commas: readonly Span[], edits: Edit[], eol: string, indent: string): void {
  for (let index = first; index <= last; index++) {
    const node = nodes[index]
    const start = node.offset
    const end = start + node.length
    edits.push({ offset: start, length: node.length, content: preservedComments(comments, start, end, eol, indent) })
    const nextOffset = index + 1 < nodes.length ? nodes[index + 1].offset : closeOffset
    const separator = firstSpanInGap(commas, end, nextOffset)
    if (separator) edits.push({ offset: separator.offset, length: separator.length, content: "" })
  }
  if (first > 0 && last === nodes.length - 1 && !keepLeadingSeparator) {
    const previous = nodes[first - 1]
    const separator = firstSpanInGap(commas, previous.offset + previous.length, nodes[first].offset)
    if (!separator) throw new Error("invalid JSONC separator before removed tail")
    edits.push({ offset: separator.offset, length: separator.length, content: "" })
  }
}

function rewrite(text: string, oldValue: unknown, nextValue: unknown, root: Node, comments: readonly CommentSpan[], commas: readonly Span[], origins: JsoncArrayOrigins, edits: Edit[], unit: string, eol: string): void {
  const walk = (node: Node, oldValue: unknown, nextValue: unknown, path: Array<string | number>): void => {
    if (isDeepStrictEqual(oldValue, nextValue)) return

    if (node.type === "object" && ownObject(oldValue) && ownObject(nextValue)) {
      const properties = propertyNodes(node)
      const oldKeys = new Set(properties.map(({ key }) => key))
      const nextKeys = Object.keys(nextValue)
      const keep = new Set<number>()
      const byKey = new Map(properties.map((entry, index) => [entry.key, { ...entry, index }]))
      for (const [key, { value, index }] of byKey) {
        if (!Object.hasOwn(nextValue, key)) continue
        keep.add(index)
        walk(value, oldValue[key], nextValue[key], [...path, key])
      }

      const additions = nextKeys.filter(key => !oldKeys.has(key))
      const closeOffset = node.offset + node.length - 1
      for (let index = 0; index < properties.length;) {
        if (keep.has(index)) { index++; continue }
        const first = index
        while (index + 1 < properties.length && !keep.has(index + 1)) index++
        const last = index
        const keepLeadingSeparator = additions.length > 0 && first > 0 && last === properties.length - 1
        removeRun(properties.map(({ property }) => property), first, last, closeOffset, keepLeadingSeparator, comments, commas, edits, eol, childPathIndent(path, unit))
        index++
      }

      if (additions.length) {
        let lastKeptIndex = -1
        for (const index of keep) lastKeptIndex = Math.max(lastKeptIndex, index)
        const last = lastKeptIndex === -1 ? undefined : properties[lastKeptIndex].property
        const trailingComma = last && lastKeptIndex === properties.length - 1 && Boolean(firstSpanInGap(commas, last.offset + last.length, closeOffset))
        const separatorBeforeRemovedTail = last && lastKeptIndex < properties.length - 1
          ? Boolean(firstSpanInGap(commas, last.offset + last.length, properties[lastKeptIndex + 1].property.offset))
          : false
        if (last && !trailingComma && !separatorBeforeRemovedTail) insertSeparator(edits, last.offset + last.length)
        const indent = childPathIndent(path, unit)
        const parentIndent = unit.repeat(path.length)
        const rendered = additions.map(key => `${indent}${JSON.stringify(key)}: ${serialize(nextValue[key]).replace(/\n/g, `${eol}${indent}`)}`)
        edits.push({ offset: closeOffset, length: 0, content: `${eol}${rendered.join(`,${eol}`)}${eol}${parentIndent}` })
      }
      return
    }

    if (node.type === "array" && Array.isArray(oldValue) && Array.isArray(nextValue)) {
      const children = node.children ?? []
      const supplied = origins.get(jsoncArrayPath(path))
      const sourceIndices = supplied ?? nextValue.map((_, index) => index < children.length ? index : null)
      if (sourceIndices.length !== nextValue.length) throw new Error("invalid JSONC array origins")
      const hasAdditions = sourceIndices.some(sourceIndex => sourceIndex === null)
      const used = new Set<number>()
      let previousIndex = -1
      for (const sourceIndex of sourceIndices) {
        if (sourceIndex === null) continue
        if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= children.length || used.has(sourceIndex) || sourceIndex <= previousIndex) {
          throw new Error("invalid JSONC array origins")
        }
        used.add(sourceIndex)
        previousIndex = sourceIndex
      }

      const closeOffset = node.offset + node.length - 1
      for (let index = 0; index < children.length;) {
        if (used.has(index)) { index++; continue }
        const first = index
        while (index + 1 < children.length && !used.has(index + 1)) index++
        const last = index
        const keepLeadingSeparator = hasAdditions && first > 0 && last === children.length - 1
        removeRun(children, first, last, closeOffset, keepLeadingSeparator, comments, commas, edits, eol, childPathIndent(path, unit))
        index++
      }

      const additions: string[] = []
      for (let index = 0; index < sourceIndices.length; index++) {
        const sourceIndex = sourceIndices[index]
        if (sourceIndex === null) additions.push(serialize(nextValue[index]).replace(/\n/g, `${eol}${childPathIndent(path, unit)}`))
        else walk(children[sourceIndex], oldValue[sourceIndex], nextValue[index], [...path, index])
      }
      if (additions.length) {
        let lastKeptIndex = -1
        for (const index of used) lastKeptIndex = Math.max(lastKeptIndex, index)
        const last = lastKeptIndex === -1 ? undefined : children[lastKeptIndex]
        const trailingComma = last && lastKeptIndex === children.length - 1 && Boolean(firstSpanInGap(commas, last.offset + last.length, closeOffset))
        const separatorBeforeRemovedTail = last && lastKeptIndex < children.length - 1
          ? Boolean(firstSpanInGap(commas, last.offset + last.length, children[lastKeptIndex + 1].offset))
          : false
        if (last && !trailingComma && !separatorBeforeRemovedTail) insertSeparator(edits, last.offset + last.length)
        const indent = childPathIndent(path, unit)
        const parentIndent = unit.repeat(path.length)
        edits.push({ offset: closeOffset, length: 0, content: `${eol}${additions.map(value => `${indent}${value}`).join(`,${eol}`)}${eol}${parentIndent}` })
      }
      return
    }

    const content = serialize(nextValue)
    const start = node.offset
    const end = node.offset + node.length
    edits.push({ offset: start, length: node.length, content: `${content}${preservedComments(comments, start, end, eol, childPathIndent(path, unit))}` })
  }

  walk(root, oldValue, nextValue, [])
}

export function rewriteJsoncPreservingComments(text: string, current: unknown, next: unknown, origins: JsoncArrayOrigins = new Map()): string {
  const { root, errors } = parseErrors(text)
  if (!root || errors.length || root.type !== "object" || !ownObject(current) || !ownObject(next)) throw new Error("invalid JSONC document")
  const comments = commentsIn(text)
  const commas = (() => {
    const scanner = createScanner(text, false)
    const result: Span[] = []
    while (scanner.scan() !== SyntaxKind.EOF) {
      if (scanner.getToken() === SyntaxKind.CommaToken) result.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength() })
    }
    return result
  })()
  const edits: Edit[] = []
  rewrite(text, current, next, root, comments, commas, origins, edits, indentUnit(text, root), text.includes("\r\n") ? "\r\n" : "\n")
  const result = applyEdits(text, edits)
  const parsed = parseErrors(result)
  if (!parsed.root || parsed.errors.length) throw new Error("JSONC edit produced invalid syntax")
  const updatedComments = commentsIn(result)
  if (comments.length !== updatedComments.length || comments.some((comment, index) => comment.text !== updatedComments[index].text)) {
    throw new Error("JSONC comments could not be preserved")
  }
  return result
}
