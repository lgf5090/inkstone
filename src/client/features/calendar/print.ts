/**
 * The paper version of the calendar.
 *
 * Printing the live grid produces nothing usable: the columns are a fixed pixel height, the day bodies
 * scroll, and colour is the point of the screen rather than of the page. So the print surface is a
 * second document — one section per day, all-day items first, then the timed ones in order — built
 * from a range read of the server, which is why it does not depend on which view is showing.
 */
import { Temporal } from 'temporal-polyfill'
import type { CalendarDto, CalendarEventDto, TimeFormat } from '@shared/calendar/model'
import { temporalValueToEpochMs } from '@shared/calendar/model'

export interface PrintItem {
  key: string
  /** Empty for an all-day item; the formatted start otherwise. */
  time: string
  title: string
  calendarName: string
  color: string
  location: string
}

export interface PrintDay {
  key: string
  label: string
  items: PrintItem[]
}

export interface PrintSheet {
  title: string
  subtitle: string
  days: PrintDay[]
  /** Shown once when the period holds nothing, instead of a page of blank dates. */
  emptyLabel: string
}

export interface PrintSheetInput {
  events: readonly CalendarEventDto[]
  calendars: readonly CalendarDto[]
  /** The period to print, in epoch milliseconds. */
  fromMs: number
  toMs: number
  timeZone: string
  locale: string
  timeFormat: TimeFormat
  title: string
  subtitle: string
  emptyLabel: string
}

function dayKey(millis: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(millis)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString()
}

function dayStartMillis(date: string, timeZone: string): number {
  return Temporal.PlainDate.from(date).toZonedDateTime({
    timeZone,
    plainTime: Temporal.PlainTime.from('00:00'),
  }).epochMilliseconds
}

function timeLabel(
  millis: number,
  timeZone: string,
  locale: string,
  timeFormat: TimeFormat,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: timeFormat === '12h',
  }).format(new Date(millis))
}

export function buildPrintSheet(input: PrintSheetInput): PrintSheet {
  const calendars = new Map(input.calendars.map((calendar) => [calendar.id, calendar]))
  const days = new Map<string, Array<PrintItem & { sortMs: number }>>()
  const fromDay = dayKey(input.fromMs, input.timeZone)
  const toDay = dayKey(input.toMs, input.timeZone)

  for (const event of input.events) {
    const startMs = temporalValueToEpochMs(event.start, input.timeZone)
    const key = dayKey(startMs, input.timeZone)
    if (key < fromDay || key > toDay) continue
    const calendar = calendars.get(event.calendarIds[0] ?? event.calendarId)
    const location = event.meta?.location
    days.set(key, [
      ...(days.get(key) ?? []),
      {
        key: event.id,
        sortMs: startMs,
        time: event.allDay ? '' : timeLabel(startMs, input.timeZone, input.locale, input.timeFormat),
        title: event.title,
        calendarName: calendar?.name ?? '',
        color: calendar?.darkColor ?? calendar?.color ?? '#888888',
        location: typeof location === 'string' ? location : '',
      },
    ])
  }

  const ordered = [...days.entries()].map(([key, items]) => ({
    key,
    label: new Intl.DateTimeFormat(input.locale, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: input.timeZone,
    }).format(new Date(dayStartMillis(key, input.timeZone))),
    items: items
      .sort((left, right) => left.sortMs - right.sortMs
        || (left.title ?? '').localeCompare(right.title ?? '')
        || left.key.localeCompare(right.key))
      .map(({ sortMs: _sortMs, ...item }) => item),
  })).sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))

  return { title: input.title, subtitle: input.subtitle, days: ordered, emptyLabel: input.emptyLabel }
}

/**
 * The period a printed sheet should cover.
 *
 * Day, week and month print what the reader is looking at; the year and agenda views fall back to the
 * current month, because a year of appointments is not something anyone reads on paper.
 */
export function printPeriod(
  view: string,
  date: Date,
  timeZone: string,
  weekStart: number,
): { fromMs: number; toMs: number } {
  const plain = Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
  const month = view === 'month' || view === 'year' || view === 'agenda' || view === 'list'
  const first = view === 'week'
    ? plain.add({ days: -((plain.dayOfWeek - weekStart + 7) % 7) })
    : month
      ? plain.with({ day: 1 })
      : plain
  const last = view === 'week'
    ? first.add({ days: 6 })
    : month
      ? first.add({ months: 1 }).subtract({ days: 1 })
      : first
  return {
    fromMs: dayStartMillis(first.toString(), timeZone),
    toMs: dayStartMillis(last.toString(), timeZone) + 86_400_000 - 1,
  }
}

const PRINTING_CLASS = 'calendar-printing'
/** Backstop for the browser that never fires `afterprint`, which would leave the app print-chromed. */
const PRINTING_CLEANUP_MS = 3000

/** Hand the mounted sheet to the browser's print dialogue, then call `onDone` exactly once. */
export function printCalendarSheet(onDone: () => void): void {
  const root = document.documentElement
  if (root.classList.contains(PRINTING_CLASS)) return
  let finished = false
  const done = (): void => {
    if (finished) return
    finished = true
    root.classList.remove(PRINTING_CLASS)
    window.removeEventListener('afterprint', done)
    onDone()
  }
  root.classList.add(PRINTING_CLASS)
  window.addEventListener('afterprint', done)
  window.setTimeout(done, PRINTING_CLEANUP_MS)
  window.print()
}
