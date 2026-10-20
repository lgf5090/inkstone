import * as chrono from 'chrono-node'
import { startOfDay } from '../../../lib/time'
import { DateRange, numberedDateRange } from './date-range'

/**
 * Shorthands a reader types when they are not willing to spell the whole word out.
 *
 * Only expanded ahead of a space, so `td` inside `today` stays `today`.
 */
const ABBREVIATIONS: Record<string, string> = {
  td: 'today',
  tm: 'tomorrow',
  yd: 'yesterday',
  tw: 'this week',
  nw: 'next week',
  weekend: 'sat',
  we: 'sat',
}

export function expandDateAbbreviation(input: string): string {
  let out = input
  for (const [key, value] of Object.entries(ABBREVIATIONS)) {
    out = out.replace(new RegExp(`\\b${key}\\s`, 'i'), `${value} `)
  }
  return out
}

/**
 * A day named in free text, stripped to local midnight.
 *
 * Midnight rather than "now" because a due date answers `due on 2026-10-19` for the whole of that
 * day, and a comparison against an un-stripped instant would flip partway through the afternoon.
 * Returns null when nothing in the text is a date, which the query layer turns into an error line
 * rather than a filter that quietly matches nothing.
 */
export function parseDay(input: string, now: Date, forwardDate = false): Date | null {
  const parsed = chrono.parseDate(expandDateAbbreviation(input), now, { forwardDate })
  return parsed === null ? null : startOfDay(parsed)
}

const RELATIVE_RANGE = /(last|this|next) (week|month|quarter|year)/i

/**
 * A span named in free text: `last month`, `2022-W10`, or one or two absolute dates.
 *
 * The three parsers are tried most-specific first, because chrono happily reads `2022-W10` as a
 * pair of numbers and would answer a different question than the one was asked.
 */
export function parseRange(input: string, now: Date, forwardDate = false): DateRange | null {
  const relative = RELATIVE_RANGE.exec(input)
  if (relative) {
    const unit = relative[2]!.toLowerCase() as 'week' | 'month' | 'quarter' | 'year'
    const range = DateRange.buildRelative(unit, now)
    switch (relative[1]!.toLowerCase()) {
      case 'last':
        range.moveToPrevious(unit)
        break
      case 'next':
        range.moveToNext(unit)
        break
    }
    return range
  }

  const numbered = numberedDateRange(input)
  if (numbered) return numbered

  const hits = chrono.parse(expandDateAbbreviation(input), now, { forwardDate })
  if (hits.length === 0) return null
  const start = startOfDay(hits[0]!.start.date())
  const end = hits[1] ? startOfDay(hits[1].start.date()) : start
  return new DateRange(start, end)
}
