/**
 * The pattern reader the lint rules need.
 *
 * QuickAdd's `parseDatePattern` deliberately refuses tokens with no inverse — a weekday or an
 * offset does not name a day on its own — because an unreadable heading must sink to the bottom of
 * an ordering rather than sort by a guess. A lint run has the opposite need: the reader's own
 * `dddd, MMMM Do YYYY, h:mm:ss a` has to be read back, or the date-modified rule would rewrite a
 * correct timestamp every time. So the linter owns a reader that knows the name tokens, the ordinal
 * suffix, the meridian and the numeric offset.
 *
 * Month names are read in the locale the run passes, from the same `Intl` tables the formatter
 * writes with, so a pattern the app rendered is a pattern the app can read back.
 */
const TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['YYYY', '(\\d{4})|year'],
  ['YY', '(\\d{2})|year2'],
  ['GGGG', '(\\d{4})|year'],
  ['gg', '(\\d{2})|year2'],
  ['dddd', '([^\\s,;.]+)|weekday'],
  ['ddd', '([^\\s,;.]+)|weekday'],
  ['MMMM', '([^\\s,;.]+)|monthName'],
  ['MMM', '([^\\s,;.]+)|monthName'],
  ['MM', '(\\d{2})|month'],
  ['M', '(\\d{1,2})|month'],
  ['Do', '(\\d{1,2}[A-Za-z]{0,3})|day'],
  ['DD', '(\\d{2})|day'],
  ['D', '(\\d{1,2})|day'],
  ['HH', '(\\d{2})|hour'],
  ['H', '(\\d{1,2})|hour'],
  ['hh', '(\\d{2})|hour'],
  ['h', '(\\d{1,2})|hour'],
  ['mm', '(\\d{2})|minute'],
  ['m', '(\\d{1,2})|minute'],
  ['ss', '(\\d{2})|second'],
  ['s', '(\\d{1,2})|second'],
  ['a', '([AaPp][Mm])|meridian'],
  ['A', '([AaPp][Mm])|meridian'],
  ['ZZ', '([+-]\\d{4})|offset'],
  ['Z', '(Z|[+-]\\d{2}:?\\d{2})|offset'],
  ['SSS', '(\\d{3})|millisecond'],
]

type Piece = { field: string, pattern: string } | { literal: string }

/** The pattern cut into capture pieces and literal text, longest token first. */
function splitPattern(pattern: string): Piece[] {
  const pieces: Piece[] = []
  let rest = pattern
  let pendingLiteral = ''

  const flush = (): void => {
    if (pendingLiteral === '') return
    pieces.push({ literal: pendingLiteral })
    pendingLiteral = ''
  }

  while (rest.length > 0) {
    if (rest[0] === '[') {
      const close = rest.indexOf(']')
      if (close === -1) return []
      pendingLiteral += rest.slice(1, close)
      rest = rest.slice(close + 1)
      continue
    }

    if (rest[0] === '\\' && rest.length > 1) {
      pendingLiteral += rest[1]
      rest = rest.slice(2)
      continue
    }

    const token = TOKENS.find(([name]) => rest.startsWith(name))
    if (!token) {
      pendingLiteral += rest[0]
      rest = rest.slice(1)
      continue
    }

    flush()
    const [, spec] = token
    const separator = spec.lastIndexOf('|')
    pieces.push({ pattern: spec.slice(0, separator), field: spec.slice(separator + 1) })
    rest = rest.slice(token[0].length)
  }

  flush()

  return pieces
}

/**
 * The instant `text` names under `pattern`, or null when it does not fit.
 *
 * A pattern that does not spell out a month or a day leaves them at January 1st, the way Moment
 * filled them in: the rule round-trips a value it has just formatted, and a pattern like
 * `YYYY, h:mm:ss a` has to read back as the same instant it was written from. Only a missing year
 * makes the read fail, because nothing can be said about which year the text means then.
 */
export function parseDateWithPattern(text: string, pattern: string, locale = 'en'): Date | null {
  const pieces = splitPattern(pattern)
  if (!pieces.length) {
    return null
  }

  const source = pieces.map((piece) => ('literal' in piece ? escapeLiteral(piece.literal) : piece.pattern)).join('')
  const fields = new Map<string, string>()
  const matched = new RegExp(`^${source}$`, 'i').exec(text.trim())
  if (!matched) {
    return null
  }

  let group = 1
  for (const piece of pieces) {
    if ('literal' in piece) continue
    const value = matched[group++]
    if (value === undefined) return null
    if (!fields.has(piece.field)) fields.set(piece.field, value)
  }

  const year = fields.has('year') ? Number(fields.get('year')) : fields.has('year2') ? twoDigitYear(Number(fields.get('year2'))) : null
  if (year === null) {
    return null
  }

  const monthText = fields.get('month') ?? fields.get('monthName')
  // an unstated month or day is January 1st; a stated one that cannot be named is not a date at all
  const month = monthText === undefined ? 0 : monthIndex(monthText, locale)
  if (month === null) {
    return null
  }

  const dayText = fields.get('day')
  // `Do` writes the day with its ordinal suffix, which is locale-shaped: 1st, 2nd, 1er, 3e
  const day = dayText === undefined ? 1 : Number(dayText.replace(/[A-Za-z]+$/, ''))
  if (Number.isNaN(day)) {
    return null
  }

  const hour = applyMeridian(Number(fields.get('hour') ?? 0), fields.get('meridian'))
  const minute = Number(fields.get('minute') ?? 0)
  const second = Number(fields.get('second') ?? 0)
  const millisecond = Number(fields.get('millisecond') ?? 0)
  const offset = fields.has('offset') ? offsetMinutes(fields.get('offset')!) : null

  if (offset !== null) {
    // the wall clock has to be a real one before the offset is applied to it
    const wall = new Date(Date.UTC(year, month, day, hour, minute, second, millisecond))
    if (!sameWallClock(wall, year, month, day, hour, minute, second, true)) {
      return null
    }

    return new Date(wall.getTime() - offset * 60_000)
  }

  const local = new Date(year, month, day, hour, minute, second, millisecond)

  // `new Date(2020, 12, 40)` rolls over into the next year rather than refusing the reading, which
  // would let a typo'd date in the front matter pass as a real one
  return sameWallClock(local, year, month, day, hour, minute, second, false) ? local : null
}

function sameWallClock(date: Date, year: number, month: number, day: number, hour: number, minute: number, second: number, utc: boolean): boolean {
  const read = utc
    ? [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    : [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]

  return read[0] === year && read[1] === month && read[2] === day && read[3] === hour && read[4] === minute && read[5] === second
}

function twoDigitYear(value: number): number {
  return value <= 68 ? 2000 + value : 1900 + value
}

/**
 * Which month a captured word names, in the reader's language.
 *
 * The names come from `Intl`, the same source the formatter prints them from, so a pattern the app
 * rendered is a pattern the app can read back. A name no table knows fails the read rather than
 * becoming January.
 */
function monthIndex(value: string | null | undefined, locale: string): number | null {
  if (value === null || value === undefined) {
    return null
  }

  if (/^\d{1,2}$/.test(value)) {
    const numeric = Number(value)

    return numeric >= 1 && numeric <= 12 ? numeric - 1 : null
  }

  const wanted = normalizeName(value)
  if (wanted === '') {
    return null
  }

  const at = monthNames(locale).indexOf(wanted)

  return at === -1 ? null : Math.floor(at / 2)
}

const MONTH_NAME_CACHE = new Map<string, string[]>()

function monthNames(locale: string): string[] {
  const key = locale || 'en'
  const cached = MONTH_NAME_CACHE.get(key)
  if (cached) {
    return cached
  }

  const names = namesFor(key, 'month')
  MONTH_NAME_CACHE.set(key, names)

  return names
}

/** Every long and short month or day name a locale has, in calendar order, twice per month. */
function namesFor(locale: string, unit: 'month' | 'weekday'): string[] {
  const build = (style: 'long' | 'short'): string[] => {
    try {
      const format = new Intl.DateTimeFormat(locale, { [unit]: style, timeZone: 'UTC' })

      return Array.from({ length: 12 }, (_, index) => normalizeName(format.format(new Date(Date.UTC(2021, unit === 'month' ? index : 0, unit === 'month' ? 15 : 1 + index * 7)))))
    } catch {
      return []
    }
  }

  const long = build('long')
  const short = build('short')

  return long.flatMap((name, index) => [name, short[index] ?? name])
}

function normalizeName(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.,\s]/g, '')
}

function applyMeridian(hour: number, meridian: string | undefined): number {
  if (!meridian) {
    return hour
  }

  const pm = meridian.toLowerCase().startsWith('p')

  if (pm && hour < 12) return hour + 12
  if (!pm && hour === 12) return 0

  return hour
}

function offsetMinutes(value: string): number {
  if (value.toUpperCase() === 'Z') return 0
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(value)
  if (!match) return 0

  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+').replace(/[-/]/g, '\\$&')
}
