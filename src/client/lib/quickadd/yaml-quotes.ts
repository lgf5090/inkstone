/**
 * Keeping a formatted token inside a note's own properties from breaking them.
 *
 * A template author writes `title: "{{VALUE}}"` and the reader answers `Say "hi"` — a plain splice
 * puts a stray quote into a YAML scalar and the note's properties stop parsing. So the engine asks,
 * for every token it replaces, whether that occurrence sits inside a quoted scalar of the front
 * matter, and writes the value the way that scalar would hold it.
 */
import { bodyOf, parseValueToken, scanTokens, type TokenSpan } from './token-grammar'

const OPEN_FENCE_RE = /^---[ \t]*\r?\n/
const CLOSE_FENCE_RE = /^(?:---|\.\.\.)[ \t]*$/
/** `key: "value"`, with the quotes balanced and an optional trailing comment. */
const QUOTED_SCALAR_RE = /^(\s*(?:[-?:][ \t]+)?[^:\n]+:[ \t]*)(["'])(.*)\2[ \t]*(?:#[^\n]*)?$/

export interface ScalarContext {
  quote: '"' | "'"
  /** The token is the whole scalar, with nothing of the author's own text around it. */
  wholeScalar: boolean
}

/** The character range of the note's properties, or null when the text has no closed block. */
export function frontMatterRange(text: string): { start: number; end: number } | null {
  const opened = OPEN_FENCE_RE.exec(text)
  if (!opened) return null
  const start = opened[0].length
  let cursor = start
  for (;;) {
    const next = text.indexOf('\n', cursor)
    const lineEnd = next === -1 ? text.length : next
    if (CLOSE_FENCE_RE.test(text.slice(cursor, lineEnd).replace(/\r$/, ''))) return { start, end: cursor }
    if (next === -1) return null
    cursor = next + 1
  }
}

/** Where `text.slice(start, end)` sits, if it is a token inside a quoted front-matter scalar. */
export function quotedScalarAt(
  text: string,
  start: number,
  end: number,
  range: { start: number; end: number } | null = frontMatterRange(text),
): ScalarContext | null {
  if (!range || start < range.start || end > range.end) return null
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const rawLineEnd = text.indexOf('\n', start)
  const lineEnd = rawLineEnd === -1 ? text.length : rawLineEnd
  const line = text.slice(lineStart, lineEnd).replace(/\r$/, '')
  const match = QUOTED_SCALAR_RE.exec(line)
  if (!match) return null
  const openAt = lineStart + match[1].length
  const closeAt = openAt + 1 + match[3].length
  if (start < openAt + 1 || end > closeAt) return null
  return { quote: match[2] as '"' | "'", wholeScalar: start === openAt + 1 && end === closeAt }
}

/**
 * The value as that scalar can hold it. A double-quoted scalar escapes what it must and can carry a
 * line break as `\n`; a single-quoted one has no escape for a line break at all, so the break folds
 * to a space and the caller says so rather than writing a broken property.
 */
export function escapeIntoScalar(value: string, quote: string): { text: string; folded: boolean } {
  if (quote === "'") {
    const folded = /[\r\n]/.test(value)
    return { text: value.replace(/'/g, "''").replace(/\r?\n/g, ' '), folded }
  }
  return {
    text: value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n'),
    folded: false,
  }
}

/**
 * `rating: "{{VALUE:rating|type:number}}"` means the number, not a string that happens to look like
 * one, so the author's quotes come off before the token is filled in. Only a scalar that is exactly
 * one such token is touched; text and multiline answers keep their quotes and get escaped instead.
 */
export function unquoteTypedScalars(text: string): string {
  const range = frontMatterRange(text)
  if (!range) return text
  let out = text.slice(0, range.start)
  let cursor = range.start
  while (cursor < range.end) {
    const found = text.indexOf('\n', cursor)
    const lineEnd = found === -1 || found >= range.end ? range.end : found
    const rawLine = text.slice(cursor, lineEnd)
    const line = rawLine.replace(/\r$/, '')
    const match = QUOTED_SCALAR_RE.exec(line)
    let kept = rawLine
    if (match) {
      const inner = match[3]
      const span = soleToken(inner)
      if (span && consumesQuotesFor(span)) {
        const afterQuote = match[1].length + 1 + inner.length + 1
        // The carriage return lives at the end of the raw line, past the text the match saw.
        kept = `${match[1]}${inner}${line.slice(afterQuote)}${rawLine.endsWith('\r') ? '\r' : ''}`
      }
    }
    out += kept
    const separator = text.slice(lineEnd, lineEnd + 1)
    out += separator
    cursor = lineEnd + (separator === '' ? 1 : separator.length)
  }
  return `${out}${text.slice(range.end)}`
}

/** The one token that fills the text entirely, or null when there is author text around it. */
function soleToken(inner: string): TokenSpan | null {
  if (!inner.startsWith('{{')) return null
  const spans = scanTokens(inner)
  const span = spans[0]
  if (spans.length !== 1 || !span || span.start !== 0 || span.end !== inner.length) return null
  return span
}

function consumesQuotesFor(span: TokenSpan): boolean {
  const type = parseValueToken(bodyOf(span)).inputType
  return type === 'number' || type === 'checkbox'
}
