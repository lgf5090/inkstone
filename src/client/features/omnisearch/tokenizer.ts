/**
 * Tokenization for the local index.
 *
 * Indexing deliberately produces more tokens than the text has words: a hyphenated, camel-cased,
 * dotted, or Han-run token is searchable by each of its parts, which is what makes the reference
 * plugin feel effortless. A search builds those same groups into OR-of-AND combinations, so a token
 * only has to match in one of its readings — and one group failing does not lose the document.
 */
import { pinyinKeysOf } from '../../lib/pinyin'

export interface TokenizerSettings {
  splitCamelCase: boolean
  cjkBigrams: boolean
  pinyinSearch: boolean
}

/** Everything that is not a letter, a number, or a Han character. */
const SEPARATORS = '[\\p{Z}\\p{P}\\p{S}\\p{C}\\p{M}]'
const BRACKETS_AND_SPACE = /[|[\]()<>{}` \t\n\r]/
const HAN_RUN = /\p{Script=Han}{2,}/gu
const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/
const DATA_URI = /data:[^;\s)]*;base64,[A-Za-z0-9+/=_-]*/gi
const MAX_READING_CHARS = 12

export function stripDataUris(value: string): string {
  return value.replace(DATA_URI, ' ')
}

function splitCamelCase(token: string): string[] {
  return CAMEL_BOUNDARY.test(token) ? token.split(CAMEL_BOUNDARY).filter(Boolean) : []
}

function splitHyphens(token: string): string[] {
  return token.includes('-') ? token.split('-').filter(Boolean) : []
}

export function buildTokenizer(settings: TokenizerSettings, fold: (value: string) => string) {
  const readingOf = (run: string): string[] => {
    if (!settings.pinyinSearch || run.length > MAX_READING_CHARS) return []
    const keys = pinyinKeysOf(run)
    if (!keys) return []
    return [keys.initials, keys.full].filter((item) => item.length > 1)
  }

  /**
   * Han characters are letters to `\p{L}`, so the separator split leaves a whole sentence in one
   * token. Splitting runs into characters (plus adjacent pairs, which is what a reader types) is the
   * segmentation the reference plugin borrows from a third-party patch, without the dependency.
   */
  /**
   * A Han run becomes its characters and adjacent pairs. Readings are collected separately, because a
   * query for one word inside a longer run must not be ANDed with the reading of that whole run: the
   * document has no such token, and the pair would never match.
   */
  function expandHan(run: string, readings: boolean): string[] {
    const chars = [...run]
    const out = chars.slice()
    if (settings.cjkBigrams) {
      for (let index = 0; index + 1 < chars.length; index++) {
        const pair = chars[index]! + chars[index + 1]!
        out.push(pair)
        // The reading of each pair is what lets a reader type the initials of a word that sits in the
        // middle of a longer run; indexing only the whole run would answer to nothing in between.
        if (readings) out.push(...readingOf(pair))
      }
    }
    if (readings && run.length >= 2) out.push(...readingOf(run))
    return out
  }

  function intoPieces(value: string, readings: boolean): string[] {
    const out: string[] = []
    for (const piece of value.split(new RegExp(SEPARATORS, 'u'))) {
      if (!piece) continue
      let last = 0
      const spans: { start: number; end: number; text: string }[] = []
      for (const match of piece.matchAll(HAN_RUN)) {
        const start = match.index ?? 0
        spans.push({ start, end: start + match[0].length, text: match[0] })
      }
      for (const span of spans) {
        const before = piece.slice(last, span.start)
        if (before) out.push(before)
        out.push(...expandHan(span.text, readings))
        last = span.end
      }
      const tail = piece.slice(last)
      if (tail) out.push(tail)
    }
    return out
  }

  const rawWords = (value: string): string[] => value.split(BRACKETS_AND_SPACE).filter(Boolean)
  const rawPieces = (value: string, readings = false): string[] => intoPieces(value, readings)
  const rawReadings = (value: string): string[] => {
    if (!settings.pinyinSearch) return []
    const out: string[] = []
    for (const match of value.matchAll(HAN_RUN)) out.push(...readingOf(match[0]))
    return out
  }

  return {
    /**
     * Splitting happens on the text as written and folding comes last: a camel-case boundary needs
     * the capitals, and `fold` removes them.
     */
    tokenizeForIndex(text: string): string[] {
      const cleaned = stripDataUris(text)
      const pieces = rawPieces(cleaned, true)
      const out = [...pieces]
      for (const piece of pieces) {
        out.push(...splitHyphens(piece), ...(settings.splitCamelCase ? splitCamelCase(piece) : []))
      }
      out.push(...rawWords(cleaned))
      return out.map(fold).filter(Boolean)
    },

    tokenizeForSearch(text: string): { combineWith: 'OR'; queries: { combineWith: 'AND'; queries: string[] }[] } {
      const stripped = text
      const pieces = rawPieces(stripped)
      const readings = rawReadings(stripped)
      const groups = [
        { combineWith: 'AND' as const, queries: pieces.map(fold) },
        { combineWith: 'AND' as const, queries: rawWords(stripped).map(fold) },
        { combineWith: 'AND' as const, queries: pieces.flatMap(splitHyphens).map(fold) },
        ...(settings.splitCamelCase
          ? [{ combineWith: 'AND' as const, queries: pieces.flatMap(splitCamelCase).map(fold) }]
          : []),
        // A query written in latin letters can still be the reading of a Chinese word, and that is a
        // match of its own rather than one more thing every other token has to satisfy.
        ...(readings.length ? [{ combineWith: 'AND' as const, queries: readings.map(fold) }] : []),
      ].filter((group) => group.queries.filter(Boolean).length)
      return { combineWith: 'OR', queries: groups.map((group) => ({ ...group, queries: group.queries.filter(Boolean) })) }
    },
  }
}
