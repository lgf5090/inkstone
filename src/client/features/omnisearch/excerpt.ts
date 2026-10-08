/**
 * Match finding, excerpts and highlighting.
 *
 * The reference plugin returns an HTML string built by `String.replace`, so it has to escape twice,
 * and its offsets come from a text that was folded to a different width. Here the fold refuses to
 * change width, the excerpt comes back as data, and React paints it — a note body can therefore
 * never become markup.
 */
import { toPlainText } from '@shared/markdown-utils'
import { escapeRegExp, foldForDisplay } from './fold'
import type { Excerpt, ExcerptLine, OmnisearchMatch } from './types'

export type { Excerpt, ExcerptLine }

export const EXCERPT_BEFORE = 100
export const EXCERPT_AFTER = 300
const MAX_MATCHES = 400

export interface MatchOptions {
  ignoreDiacritics: boolean
  limit?: number
}

function termsToPattern(terms: readonly string[]): string {
  const unique = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length).slice(0, 32)
  if (!unique.length) return ''
  return unique.map(escapeRegExp).join('|')
}

/** Offsets are relative to `text`, so a caller can slice or scroll the original body with them. */
export function findMatches(text: string, terms: readonly string[], options: MatchOptions): OmnisearchMatch[] {
  const pattern = termsToPattern(terms)
  if (!pattern || !text) return []
  const folded = foldForDisplay(text, options.ignoreDiacritics)
  const regex = new RegExp(pattern, 'giu')
  const limit = options.limit ?? MAX_MATCHES
  const matches: OmnisearchMatch[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(folded.text)) !== null) {
    if (!match[0]) {
      regex.lastIndex++
      continue
    }
    matches.push({ term: text.slice(match.index, match.index + match[0].length), offset: match.index })
    if (matches.length >= limit) break
  }
  return matches
}

/**
 * When the whole query appears as one run, that is the place a reader wants to land, so it goes
 * first even though the index matched the individual terms.
 */
export function prioritizePhrase(
  matches: OmnisearchMatch[],
  text: string,
  phrase: string,
  ignoreDiacritics: boolean,
): OmnisearchMatch[] {
  const trimmed = phrase.trim()
  if (!trimmed || !text || matches.length === 0) return matches
  const pattern = termsToPattern([trimmed])
  if (!pattern) return matches
  const folded = foldForDisplay(text, ignoreDiacritics)
  const at = new RegExp(pattern, 'giu').exec(folded.text)
  if (!at || at.index < 0) return matches
  return [{ term: trimmed, offset: at.index }, ...matches.filter((item) => item.offset !== at.index)]
}

/** Matches closer together than `window` are one result, so a repeated word is not ten rows. */
export function groupOffsets(matches: readonly OmnisearchMatch[], window = EXCERPT_AFTER): number[] {
  const sorted = [...matches].sort((a, b) => a.offset - b.offset)
  const out: number[] = []
  let covered = -1
  for (const item of sorted) {
    if (item.offset <= covered) continue
    out.push(item.offset)
    covered = item.offset + window
  }
  return out
}

export interface ExcerptOptions {
  ignoreDiacritics: boolean
  keepLineReturns: boolean
  plainText: boolean
  terms: readonly string[]
  before?: number
  after?: number
}

function snapStart(value: string, from: number): number {
  if (from <= 0) return 0
  const space = value.lastIndexOf(' ', from)
  return space > 0 ? space + 1 : from
}

function snapEnd(value: string, to: number): number {
  if (to >= value.length) return value.length
  const space = value.indexOf(' ', to)
  return space < 0 ? value.length : space
}

export function buildExcerpt(body: string, offset: number, options: ExcerptOptions): Excerpt {
  if (!body) return { lines: [], leading: false, trailing: false }
  const before = options.before ?? EXCERPT_BEFORE
  const after = options.after ?? EXCERPT_AFTER
  const at = offset >= 0 ? offset : 0
  let from = snapStart(body, offset >= 0 ? Math.max(0, at - before) : 0)
  let to = snapEnd(body, Math.min(body.length, at + after))
  if (to <= from) {
    from = 0
    to = Math.min(body.length, after)
  }
  let slice = body.slice(from, to)
  const leading = from > 0
  const trailing = to < body.length

  if (options.keepLineReturns) {
    // A match in the middle of a paragraph should not carry three unrelated lines along.
    const newline = slice.lastIndexOf('\n', Math.max(0, at - from))
    if (newline > 0) {
      slice = slice.slice(newline + 1)
      from += newline + 1
    }
  }
  const display = options.plainText ? toPlainText(slice).trim() : slice
  const lines = markLines(display, options.terms, options.ignoreDiacritics)
  return { lines: options.keepLineReturns ? lines : lines.filter((line) => line.text.trim()), leading, trailing }
}

function markLines(display: string, terms: readonly string[], ignoreDiacritics: boolean): ExcerptLine[] {
  const raw = display.split('\n')
  const starts: number[] = []
  let acc = 0
  for (const line of raw) {
    starts.push(acc)
    acc += line.length + 1
  }
  const ranges: [number, number][][] = raw.map(() => [])
  const pattern = termsToPattern(terms)
  if (pattern) {
    const folded = foldForDisplay(display, ignoreDiacritics)
    const regex = new RegExp(pattern, 'giu')
    let line = 0
    let match: RegExpExecArray | null
    let counted = 0
    while ((match = regex.exec(folded.text)) !== null) {
      if (!match[0]) {
        regex.lastIndex++
        continue
      }
      while (line + 1 < starts.length && match.index >= starts[line + 1]!) line++
      ranges[line]!.push([match.index - starts[line]!, match.index - starts[line]! + match[0].length])
      if (++counted >= MAX_MATCHES) break
    }
  }
  return raw.map((text, index) => ({ text, hits: mergeRanges(ranges[index] ?? []) }))
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else out.push([range[0], range[1]])
  }
  return out
}
