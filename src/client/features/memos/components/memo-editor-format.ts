import type { MemoAttachment } from '@shared/memos/types'

export interface MemoFormatResult {
  text: string
  from: number
  to: number
}

export type MemoFormatAction =
  | { kind: 'inline'; open: string; close?: string }
  | { kind: 'line'; prefix: string; pattern: RegExp; replacement?: RegExp }
  | { kind: 'heading'; level: number }
  | { kind: 'link' }

export const MEMO_LIST_PATTERNS = {
  quote: /^>\s?/,
  bullet: /^[-*+][ \t]+(?!\[[ xX]\][ \t]+)/,
  ordered: /^\d+[.)][ \t]+(?!\[[ xX]\][ \t]+)/,
  task: /^(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\][ \t]+/,
} as const

const WORD_START = /[\p{L}\p{N}_]+$/u
const WORD_END = /^[\p{L}\p{N}_]+/u
const HEADING_PREFIX = /^(#{1,6})[ \t]+/
const LINE_INDENT = /^[ \t]*/

export const MEMO_ANY_LIST_PREFIX = /^(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function safeRange(text: string, from: number, to: number): { from: number; to: number } {
  const start = clamp(from, 0, text.length)
  const end = clamp(to, start, text.length)
  return { from: start, to: end }
}

export function expandMemoSelection(
  text: string,
  from: number,
  to: number,
): { from: number; to: number } {
  const range = safeRange(text, from, to)
  if (range.from !== range.to) return range
  const lineStart = text.lastIndexOf('\n', range.from - 1) + 1
  const lineEndIndex = text.indexOf('\n', range.from)
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex
  const before = text.slice(lineStart, range.from)
  const after = text.slice(range.from, lineEnd)
  const wordStart = WORD_START.exec(before)?.[0] ?? ''
  const wordEnd = WORD_END.exec(after)?.[0] ?? ''
  return {
    from: range.from - wordStart.length,
    to: range.from + wordEnd.length,
  }
}

export function toggleMemoInline(
  text: string,
  from: number,
  to: number,
  open: string,
  close: string = open,
): MemoFormatResult {
  const range = expandMemoSelection(text, from, to)
  const before = text.slice(Math.max(0, range.from - open.length), range.from)
  const after = text.slice(range.to, Math.min(text.length, range.to + close.length))
  if (range.from >= open.length && before === open && after === close) {
    const outerFrom = range.from - open.length
    const outerTo = range.to + close.length
    return {
      text: text.slice(0, outerFrom) + text.slice(range.from, range.to) + text.slice(outerTo),
      from: outerFrom,
      to: range.to - open.length,
    }
  }
  const selected = text.slice(range.from, range.to)
  if (
    selected.length >= open.length + close.length
    && selected.startsWith(open)
    && selected.endsWith(close)
  ) {
    const innerText = selected.slice(open.length, selected.length - close.length)
    return {
      text: text.slice(0, range.from) + innerText + text.slice(range.to),
      from: range.from,
      to: range.from + innerText.length,
    }
  }
  const insert = `${open}${selected}${close}`
  return {
    text: text.slice(0, range.from) + insert + text.slice(range.to),
    from: range.from + open.length,
    to: range.from + open.length + selected.length,
  }
}

function selectedLineBlock(text: string, from: number, to: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', from - 1) + 1
  const effectiveTo = to > from && text[to - 1] === '\n' ? to - 1 : to
  const lineEnd = text.indexOf('\n', effectiveTo)
  return { start, end: lineEnd === -1 ? text.length : lineEnd }
}

function lineIndent(line: string): string {
  return LINE_INDENT.exec(line)?.[0] ?? ''
}

function prefixMatch(line: string, pattern: RegExp): RegExpExecArray | null {
  pattern.lastIndex = 0
  return pattern.exec(line.slice(lineIndent(line).length))
}

function mapBlockOffset(
  oldLines: readonly string[],
  newLines: readonly string[],
  blockStart: number,
  position: number,
): number {
  let oldOffset = blockStart
  let newOffset = blockStart
  for (let index = 0; index < oldLines.length; index++) {
    const oldLine = oldLines[index]!
    const newLine = newLines[index]!
    const oldEnd = oldOffset + oldLine.length
    if (position <= oldEnd) {
      return newOffset + Math.min(position - oldOffset, newLine.length)
    }
    if (position <= oldEnd + 1) return newOffset + newLine.length
    oldOffset = oldEnd + 1
    newOffset += newLine.length + 1
  }
  return newOffset
}

function replaceLineBlock(
  text: string,
  from: number,
  to: number,
  transform: (lines: readonly string[]) => string[],
): MemoFormatResult {
  const range = safeRange(text, from, to)
  const block = selectedLineBlock(text, range.from, range.to)
  const oldLines = text.slice(block.start, block.end).split('\n')
  const newLines = transform(oldLines)
  const nextBlock = newLines.join('\n')
  const nextText = text.slice(0, block.start) + nextBlock + text.slice(block.end)
  return {
    text: nextText,
    from: mapBlockOffset(oldLines, newLines, block.start, range.from),
    to: mapBlockOffset(oldLines, newLines, block.start, range.to),
  }
}

export function toggleMemoLinePrefix(
  text: string,
  from: number,
  to: number,
  prefix: string,
  pattern: RegExp,
  replacement?: RegExp,
): MemoFormatResult {
  return replaceLineBlock(text, from, to, (lines) => {
    const contentful = lines.filter((line) => line.trim().length > 0)
    const everyLineHasPrefix = contentful.length > 0 && contentful.every((line) => prefixMatch(line, pattern) !== null)
    return lines.map((line) => {
      const indent = lineIndent(line)
      const match = prefixMatch(line, pattern)
      if (everyLineHasPrefix) {
        if (!match) return line
        return line.slice(0, indent.length) + line.slice(indent.length + match[0].length)
      }
      if (match) return line
      const replaced = replacement ? prefixMatch(line, replacement) : null
      const staleLength = replaced?.[0].length ?? 0
      return line.slice(0, indent.length) + prefix + line.slice(indent.length + staleLength)
    })
  })
}

export function setMemoHeading(
  text: string,
  from: number,
  to: number,
  level: number,
): MemoFormatResult {
  const target = clamp(level, 0, 6)
  return replaceLineBlock(text, from, to, (lines) => {
    const contentful = lines.filter((line) => line.trim().length > 0)
    const everyLineHasLevel = target > 0 && contentful.length > 0 && contentful.every((line) => {
      const match = HEADING_PREFIX.exec(line)
      return match !== null && match[1]!.length === target
    })
    return lines.map((line) => {
      const match = HEADING_PREFIX.exec(line)
      if (target === 0 || everyLineHasLevel) {
        return match ? line.slice(match[0].length) : line
      }
      const marker = `${'#'.repeat(target)} `
      return match ? marker + line.slice(match[0].length) : marker + line
    })
  })
}

export function insertMemoLink(text: string, from: number, to: number): MemoFormatResult {
  const range = safeRange(text, from, to)
  const selected = text.slice(range.from, range.to)
  const label = selected.replace(/\\/g, '\\\\').replace(/[[\]]/g, '\\$&')
  const insert = `[${label}]()`
  return {
    text: text.slice(0, range.from) + insert + text.slice(range.to),
    from: range.from + (selected ? insert.length - 1 : 1),
    to: range.from + (selected ? insert.length - 1 : 1),
  }
}

export function insertMemoSnippet(
  text: string,
  from: number,
  to: number,
  snippet: string,
  cursorOffset: number = snippet.length,
): MemoFormatResult {
  const range = safeRange(text, from, to)
  const cursor = range.from + clamp(cursorOffset, 0, snippet.length)
  return {
    text: text.slice(0, range.from) + snippet + text.slice(range.to),
    from: cursor,
    to: cursor,
  }
}

export function applyMemoFormat(
  text: string,
  from: number,
  to: number,
  action: MemoFormatAction,
): MemoFormatResult {
  if (action.kind === 'inline') {
    return toggleMemoInline(text, from, to, action.open, action.close)
  }
  if (action.kind === 'line') {
    return toggleMemoLinePrefix(text, from, to, action.prefix, action.pattern, action.replacement)
  }
  if (action.kind === 'heading') {
    return setMemoHeading(text, from, to, action.level)
  }
  return insertMemoLink(text, from, to)
}

function escapeAttachmentName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/[[\]]/g, '\\$&')
}

export function attachmentMarkdown(
  attachment: Pick<MemoAttachment, 'filename' | 'mime' | 'url'>,
): string {
  const label = escapeAttachmentName(attachment.filename)
  return attachment.mime.startsWith('image/')
    ? `![${label}](${attachment.url})`
    : `[${label}](${attachment.url})`
}
