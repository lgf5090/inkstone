/**
 * Where a reader is in a book, in a form that survives a resize, a font change and a restart.
 *
 * A screen page number is the obvious representation and the wrong one: it changes with the window,
 * the type size and the column count, so a position written on a phone would land in the middle of a
 * paragraph on a desktop. What does not change is the prose itself, so an EPUB position is a chapter
 * plus a character offset into that chapter's text, and a fixed-layout book's is a page.
 *
 * The codec is deliberately compact and printable (`e:12:340`) because it also appears in the
 * address bar of a `↩` link from the reading note, where a reader may paste it.
 */

export type BookPosition =
  | { kind: 'epub'; chapter: number; offset: number }
  | { kind: 'fixed'; page: number }

export function encodePosition(position: BookPosition): string {
  return position.kind === 'epub'
    ? `e:${position.chapter}:${position.offset}`
    : `f:${position.page}`
}

const EPUB_POSITION = /^e:(\d+):(\d+)$/
const FIXED_POSITION = /^f:(\d+)$/

/** Null for anything malformed, so a hand-edited address cannot produce a half-known position. */
export function decodePosition(raw: string | null | undefined): BookPosition | null {
  if (!raw) return null
  const epub = EPUB_POSITION.exec(raw)
  if (epub) {
    const chapter = Number(epub[1])
    const offset = Number(epub[2])
    if (!Number.isSafeInteger(chapter) || !Number.isSafeInteger(offset)) return null
    return { kind: 'epub', chapter, offset }
  }
  const fixed = FIXED_POSITION.exec(raw)
  if (fixed) {
    const page = Number(fixed[1])
    return Number.isSafeInteger(page) && page >= 1 ? { kind: 'fixed', page } : null
  }
  return null
}

/** Ordering for a single book's own positions; positions of different kinds never compare. */
export function comparePositions(a: BookPosition, b: BookPosition): number {
  if (a.kind !== b.kind) return 0
  if (a.kind === 'epub' && b.kind === 'epub') {
    return a.chapter === b.chapter ? a.offset - b.offset : a.chapter - b.chapter
  }
  return a.kind === 'fixed' && b.kind === 'fixed' ? a.page - b.page : 0
}

export interface PositionModel {
  kind: 'epub' | 'fixed'
  /** Chapter or page count, which is what a typed number or percentage is measured against. */
  total: number
  /** Per-chapter prose length, used to spread a percentage over chapters of different sizes. */
  weights?: number[]
}

/**
 * A percentage of a book is not a percentage of chapters: a 40-page chapter and a 2-page preface are
 * not equal slices of the reading. Where the weights are known they decide; otherwise the split is
 * linear and the reader is told so by the position it lands on.
 */
export function positionFromFraction(fraction: number, model: PositionModel): BookPosition | null {
  const clamped = Math.min(1, Math.max(0, fraction))
  if (model.kind === 'fixed') {
    const page = Math.min(model.total, Math.max(1, Math.round(clamped * model.total) || 1))
    return { kind: 'fixed', page }
  }
  const weights = model.weights?.length ? model.weights : new Array(model.total).fill(1)
  const totalWeight = weights.reduce((sum, one) => sum + Math.max(0, one), 0)
  if (!weights.length || totalWeight <= 0) return null
  let target = clamped * totalWeight
  for (let index = 0; index < weights.length; index++) {
    const weight = Math.max(0, weights[index] ?? 0)
    if (target > weight && index < weights.length - 1) {
      target -= weight
      continue
    }
    const within = weight > 0 ? Math.min(1, target / weight) : 0
    return { kind: 'epub', chapter: index, offset: Math.round(within * weight) }
  }
  return { kind: 'epub', chapter: weights.length - 1, offset: 0 }
}

/** How far through a book a position is, on the same weighted scale `positionFromFraction` inverts. */
export function fractionOfPosition(position: BookPosition, model: PositionModel, withinChapter = 0): number {
  if (model.kind === 'fixed') {
    return model.total > 0 ? Math.min(1, Math.max(0, (position.kind === 'fixed' ? position.page : 1) / model.total)) : 0
  }
  if (position.kind !== 'epub') return 0
  const weights = model.weights?.length ? model.weights : new Array(model.total).fill(1)
  const totalWeight = weights.reduce((sum, one) => sum + Math.max(0, one), 0)
  if (totalWeight <= 0) return 0
  let before = 0
  for (let index = 0; index < position.chapter && index < weights.length; index++) {
    before += Math.max(0, weights[index] ?? 0)
  }
  const chapterWeight = Math.max(0, weights[position.chapter] ?? 0)
  return Math.min(1, (before + Math.min(withinChapter, chapterWeight)) / totalWeight)
}

/**
 * What a reader types into the "go to" box: `42%`, `128` (a page or location number), or nothing at
 * all when the text is neither.
 */
export function parsePositionInput(raw: string, model: PositionModel): BookPosition | null {
  const value = raw.trim()
  if (!value) return null
  if (value.endsWith('%')) {
    const percent = Number(value.slice(0, -1).trim())
    return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.slice(0, -1).trim()) && percent >= 0 && percent <= 100
      ? positionFromFraction(percent / 100, model)
      : null
  }
  const decoded = decodePosition(value)
  if (decoded) return decoded
  if (!/^\d+$/.test(value)) return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > Math.max(1, model.total)) return null
  return model.kind === 'fixed'
    ? { kind: 'fixed', page: number }
    : positionFromFraction((number - 1) / Math.max(1, model.total), model)
}

/**
 * Where the reader stopped, in the book's own words.
 *
 * A shelf row that says only "read today" answers when but not where, and "where" is what decides
 * whether to open this book now. The chapter's own title is the label a reader recognises, so it is
 * read out of the contents the import cached rather than numbered.
 */
export function stoppedAtLabel(
  position: BookPosition | null | undefined,
  book: { unitCount: number; toc: { label: string; position: BookPosition | null }[] },
): string {
  if (!position) return ''
  if (position.kind === 'fixed') return `${position.page} / ${Math.max(1, book.unitCount)}`
  const entry = book.toc.find((one) => one.position?.kind === 'epub' && one.position.chapter === position.chapter)
  return entry?.label?.trim() ?? ''
}

export function formatPercent(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`
}
