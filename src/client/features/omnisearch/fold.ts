/**
 * Case- and accent-folding for the local index.
 *
 * Two folds live here because they answer different questions. `foldTerm` is what the index stores
 * and what a query is folded with, so it may change the width of a string. `foldForDisplay` locates
 * matches inside a note body, where an offset has to stay valid for the *original* text, so it
 * refuses to fold as soon as any code point would change width.
 */
const MARKS = '[\\p{M}]'

export function foldTerm(value: string, ignoreDiacritics: boolean): string {
  const lowered = value.toLowerCase()
  return ignoreDiacritics
    ? lowered.normalize('NFD').replace(new RegExp(MARKS, 'gu'), '').normalize('NFC')
    : lowered
}

export interface FoldedText {
  text: string
  /** False when folding shifted any offset, in which case the caller matches the original instead. */
  aligned: boolean
}

const foldedByCodePoint = new Map<string, string>()

function foldCodePoint(point: string): string {
  const cached = foldedByCodePoint.get(point)
  if (cached !== undefined) return cached
  const folded = point.normalize('NFD').replace(new RegExp(MARKS, 'gu'), '').normalize('NFC')
  foldedByCodePoint.set(point, folded)
  return folded
}

/**
 * The accent-folded form of a body, or the body itself when folding would move an offset. A
 * combining mark written separately in the source folds away entirely and would shift every later
 * offset, sending both the excerpt and the editor caret astray. Case is left to the `i` flag of the
 * matching regex rather than lowered here, because lowering is not width-preserving either.
 */
export function foldForDisplay(value: string, ignoreDiacritics: boolean): FoldedText {
  if (!ignoreDiacritics) return { text: value, aligned: true }
  let out = ''
  for (const point of value) {
    const folded = foldCodePoint(point)
    if (folded.length !== point.length) return { text: value, aligned: false }
    out += folded
  }
  return { text: out, aligned: true }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
