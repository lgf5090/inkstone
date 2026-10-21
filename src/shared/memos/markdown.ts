import { truncateText } from '../text-utils'
import { MEMO_TAG_NAME_MAX_LENGTH, MEMO_TAGS_MAX, MEMOS_API_PREFIX } from './constants'

const MEMO_TITLE_MAX_LENGTH = 200
const MEMO_SNIPPET_MAX_LENGTH = 200
const ATTACHMENT_URL_PREFIX = `${MEMOS_API_PREFIX}/files/`

const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/
const HEADING_PATTERN = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/
const HORIZONTAL_RULE_PATTERN = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const TASK_PATTERN = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\](?:[ \t]+\S|$)/gm
const LINK_PATTERN = /!?\[[^\]\n]*\]\(([^)\n]*)\)/gu
const REFERENCE_LINK_PATTERN = /\[[^\]\n]+\]\[[^\]\n]*\]/gu
const REFERENCE_DEFINITION_PATTERN = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+/gmu
const AUTOLINK_PATTERN = /<((?:https?|mailto):[^>\s]+)>/giu
const BARE_URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+/giu
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?(?:-->|$)/gu
const MATH_PATTERN = /\$\$[\s\S]*?(?:\$\$|$)/gu

const TAG_PATTERN =
  /(?:^|[\s(\uFF08\[\u3010>\u300C\u300E\uFF0C,\u3001;\uFF1B:\uFF1A])#([\p{L}\p{M}\p{N}_/\-\u00B7+&'\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f]+)/gu

const ATTACHMENT_PATTERN = new RegExp(
  `(?:^|[\\s(<"'=])(?:https?:\\/\\/[^\\s<>"']+)?${ATTACHMENT_URL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9a-hjkmnp-tv-z]{26})(?=$|[\\s>)\\]"'?#])`,
  'g',
)

export interface MemoMarkdownProperties {
  hasLink: boolean
  hasCode: boolean
  hasTaskList: boolean
  hasIncompleteTasks: boolean
}

interface MarkdownMask {
  masked: string
  codeMasked: string
  hasFence: boolean
  hasInlineCode: boolean
  hasLink: boolean
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes++
  return slashes % 2 === 1
}

function maskedText(content: string, protectedChars: Uint8Array): string {
  const chars = content.split('')
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!
    if (protectedChars[index] && char !== '\n' && char !== '\r') chars[index] = ' '
  }
  return chars.join('')
}

function maskMarkdown(content: string): MarkdownMask {
  const protectedChars = new Uint8Array(content.length)
  const protect = (start: number, end: number): void => {
    const from = Math.max(0, start)
    const to = Math.min(content.length, end)
    for (let index = from; index < to; index++) protectedChars[index] = 1
  }
  const isProtectedRange = (start: number, end: number): boolean => {
    for (let index = start; index < end; index++) {
      if (protectedChars[index]) return true
    }
    return false
  }

  let hasFence = false
  let hasInlineCode = false
  let hasLink = false

  let inFence = false
  let fenceChar = ''
  let fenceLength = 0
  let lineStart = 0
  while (lineStart < content.length) {
    const newline = content.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? content.length : newline + 1
    const line = content.slice(lineStart, newline < 0 ? content.length : newline).replace(/\r$/, '')
    const fence = FENCE_PATTERN.exec(line)
    if (fence) {
      hasFence = true
      const marker = fence[1]!
      if (!inFence) {
        inFence = true
        fenceChar = marker[0]!
        fenceLength = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        inFence = false
      }
      protect(lineStart, lineEnd)
    } else if (inFence) {
      protect(lineStart, lineEnd)
    }
    lineStart = lineEnd
  }

  for (let index = 0; index < content.length; ) {
    if (protectedChars[index] || content[index] !== '`' || isEscaped(content, index)) {
      index++
      continue
    }
    let markerEnd = index + 1
    while (content[markerEnd] === '`') markerEnd++
    const markerLength = markerEnd - index
    let closing = markerEnd
    let matched = false
    while (closing < content.length) {
      closing = content.indexOf('`', closing)
      if (closing < 0) break
      let closingEnd = closing + 1
      while (content[closingEnd] === '`') closingEnd++
      if (closingEnd - closing === markerLength) {
        protect(index, closingEnd)
        hasInlineCode = true
        matched = true
        index = closingEnd
        break
      }
      closing = closingEnd
    }
    if (!matched) index = markerEnd
  }

  const codeMasked = maskedText(content, protectedChars)
  const protectPattern = (pattern: RegExp, onMatch?: () => void): void => {
    for (const match of content.matchAll(pattern)) {
      const start = match.index
      if (start === undefined || isProtectedRange(start, start + match[0].length)) continue
      protect(start, start + match[0].length)
      onMatch?.()
    }
  }

  protectPattern(HTML_COMMENT_PATTERN)
  protectPattern(MATH_PATTERN)

  for (const match of content.matchAll(LINK_PATTERN)) {
    const start = match.index
    if (start === undefined || isProtectedRange(start, start + match[0].length)) continue
    const destinationStart = start + match[0].lastIndexOf('](') + 2
    protect(destinationStart, start + match[0].length)
    if (!match[0].startsWith('!')) hasLink = true
  }
  protectPattern(REFERENCE_LINK_PATTERN, () => {
    hasLink = true
  })
  protectPattern(REFERENCE_DEFINITION_PATTERN, () => {
    hasLink = true
  })
  protectPattern(AUTOLINK_PATTERN, () => {
    hasLink = true
  })
  protectPattern(BARE_URL_PATTERN, () => {
    hasLink = true
  })

  return {
    masked: maskedText(content, protectedChars),
    codeMasked,
    hasFence,
    hasInlineCode,
    hasLink,
  }
}

function normalizeTagName(raw: string): string {
  const segments = raw
    .replace(/[/\-_\u00B7]+$/u, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
  return segments.join('/')
}

export function scanMemoTags(content: string): string[] {
  const { masked } = maskMarkdown(content)
  const tags: string[] = []
  const seen = new Set<string>()
  for (const match of masked.matchAll(TAG_PATTERN)) {
    const name = normalizeTagName(match[1]!)
    if (!name) continue
    let prefix = ''
    for (const segment of name.split('/')) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      if (prefix.length > MEMO_TAG_NAME_MAX_LENGTH) break
      if (seen.has(prefix)) continue
      seen.add(prefix)
      tags.push(prefix)
      if (tags.length >= MEMO_TAGS_MAX) return tags
    }
  }
  return tags
}

export function scanMemoProperties(content: string): MemoMarkdownProperties {
  const mask = maskMarkdown(content)
  let hasTaskList = false
  let hasIncompleteTasks = false
  for (const match of mask.codeMasked.matchAll(TASK_PATTERN)) {
    hasTaskList = true
    if (match[1] === ' ') hasIncompleteTasks = true
  }
  return {
    hasLink: mask.hasLink,
    hasCode: mask.hasFence || mask.hasInlineCode,
    hasTaskList,
    hasIncompleteTasks,
  }
}

export function scanMemoAttachmentIds(content: string): string[] {
  const { codeMasked } = maskMarkdown(content)
  const ids: string[] = []
  for (const match of codeMasked.matchAll(ATTACHMENT_PATTERN)) {
    const id = match[1]!
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

function plainInline(value: string): string {
  const text = value
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1')
    .replace(/\[([^\]\n]*)\]\[[^\]\n]*\]/gu, '$1')
    .replace(/<((?:https?|mailto):[^>\n]+)>/giu, '$1')
    .replace(/`+([^`\n]*)`+/gu, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/gu, '')
    .replace(/[*_~]{1,3}/gu, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
  return text
}

function blockLead(value: string): string {
  return value
    .replace(/^[ \t]{0,3}(?:>[ \t]?)+/u, '')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/u, '')
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/u, '')
    .replace(/^[ \t]*[-*+][ \t]+/u, '')
    .replace(/^[ \t]*\d+[.)][ \t]+\[[ xX]\][ \t]+/u, '')
    .replace(/^[ \t]*\d+[.)][ \t]+/u, '')
    .trim()
}

export function deriveMemoTitle(content: string): string {
  const lines = content.split('\n')
  let inFence = false
  let fenceChar = ''
  let fenceLength = 0
  const visible: string[] = []
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    const fence = FENCE_PATTERN.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (!inFence) {
        inFence = true
        fenceChar = marker[0]!
        fenceLength = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        inFence = false
      }
      continue
    }
    if (!inFence) visible.push(line)
  }

  for (const line of visible) {
    const heading = HEADING_PATTERN.exec(line)
    if (!heading) continue
    const title = plainInline(heading[1]!)
    if (title) return truncateText(title, MEMO_TITLE_MAX_LENGTH)
  }
  for (const line of visible) {
    if (!line.trim() || HORIZONTAL_RULE_PATTERN.test(line)) continue
    const title = plainInline(blockLead(line))
    if (title) return truncateText(title, MEMO_TITLE_MAX_LENGTH)
  }
  return ''
}

function memoPlainText(content: string): string {
  const lines: string[] = []
  let inFence = false
  let fenceChar = ''
  let fenceLength = 0
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const fence = FENCE_PATTERN.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (!inFence) {
        inFence = true
        fenceChar = marker[0]!
        fenceLength = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        inFence = false
      }
      continue
    }
    if (HORIZONTAL_RULE_PATTERN.test(line)) continue
    const text = inFence ? line.trim() : plainInline(blockLead(line))
    if (text) lines.push(text)
  }
  return lines.join(' ').replace(/\s+/gu, ' ').trim()
}

export function deriveMemoSnippet(content: string): string {
  const plain = memoPlainText(content)
  const title = deriveMemoTitle(content)
  const text = title && plain.startsWith(title) ? plain.slice(title.length).trim() : plain
  if (!text) return ''
  if (text.length <= MEMO_SNIPPET_MAX_LENGTH) return text
  return `${truncateText(text, MEMO_SNIPPET_MAX_LENGTH).trimEnd()}\u2026`
}

export function deriveMemoContentSearch(content: string): string {
  return content.toLocaleLowerCase()
}
