import { addDaysKey, daysBetweenKeys } from '../../time'
import { getKanbanDueDate, getKanbanStartDate, kanbanDayKey } from './date-fields'
import type { KanbanItem } from './types'

export interface CalendarDay {
  date: Date
  dateStr: string
  dayNum: number
  isCurrentMonth: boolean
  isToday: boolean
}

export interface WeekEventSegment {
  item: KanbanItem
  startCol: number
  endCol: number
  isSegmentStart: boolean
  isSegmentEnd: boolean
  track: number
}

/**
 * How many cells precede the first of the month in a grid that opens on `weekStart`. Both calendar
 * surfaces index JS `getDay()` (Sunday = 0), so `weekStart` is 0-based here too.
 */
function cellsBefore(day: number, weekStart: number): number {
  return (day - weekStart + 7) % 7
}

function dayKeyOf(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function getMonthWeeks(year: number, month: number, weekStart: number): CalendarDay[][] {
  const formatStr = dayKeyOf
  const todayStr = formatStr(new Date())

  const firstDate = new Date(year, month, 1)
  const startDate = new Date(year, month, 1 - cellsBefore(firstDate.getDay(), weekStart))

  const lastDate = new Date(year, month + 1, 0)
  const endDate = new Date(year, month + 1, 6 - cellsBefore(lastDate.getDay(), weekStart))

  const weeks: CalendarDay[][] = []
  const curr = new Date(startDate)

  while (curr <= endDate) {
    const week: CalendarDay[] = []
    for (let i = 0; i < 7; i++) {
      const dateStr = formatStr(curr)
      week.push({
        date: new Date(curr),
        dateStr,
        dayNum: curr.getDate(),
        isCurrentMonth: curr.getMonth() === month,
        isToday: dateStr === todayStr,
      })
      curr.setDate(curr.getDate() + 1)
    }
    weeks.push(week)
  }

  return weeks
}

/**
 * The single week containing `date`, built exactly the way `getMonthWeeks` builds its rows — same
 * day shape, same week-start alignment, same today flag — so the week view is the month view with
 * one row and nothing else to keep in step. Days outside the anchor's month keep the same dimming
 * the month grid gives its own leading and trailing cells.
 */
export function getWeekDays(date: Date, weekStart: number): CalendarDay[] {
  const anchor = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const startDate = new Date(anchor)
  startDate.setDate(anchor.getDate() - cellsBefore(anchor.getDay(), weekStart))

  const todayStr = dayKeyOf(new Date())
  const week: CalendarDay[] = []
  for (let i = 0; i < 7; i++) {
    const curr = new Date(startDate)
    curr.setDate(startDate.getDate() + i)
    const dateStr = dayKeyOf(curr)
    week.push({
      date: curr,
      dateStr,
      dayNum: curr.getDate(),
      isCurrentMonth: curr.getMonth() === anchor.getMonth(),
      isToday: dateStr === todayStr,
    })
  }
  return week
}

function resolveItemDateRange(item: KanbanItem, dateField?: string): { start: string; end: string } | null {
  const primary = dateField ? item.properties[dateField] : undefined
  const startKey = kanbanDayKey(primary || getKanbanStartDate(item) || getKanbanDueDate(item))
  const endKey = kanbanDayKey(getKanbanDueDate(item) || primary || getKanbanStartDate(item))
  if (!startKey && !endKey) return null

  if (startKey && endKey) {
    return startKey <= endKey ? { start: startKey, end: endKey } : { start: endKey, end: startKey }
  }
  const single = startKey || endKey
  return { start: single, end: single }
}

function assignTracks(rawSegments: Omit<WeekEventSegment, 'track'>[]): WeekEventSegment[] {
  const trackOccupied: number[] = []
  const segments: WeekEventSegment[] = []

  for (const seg of rawSegments) {
    let assignedTrack = -1
    for (let t = 0; t < trackOccupied.length; t++) {
      if (trackOccupied[t] < seg.startCol) {
        assignedTrack = t
        trackOccupied[t] = seg.endCol
        break
      }
    }
    if (assignedTrack === -1) {
      assignedTrack = trackOccupied.length
      trackOccupied.push(seg.endCol)
    }
    segments.push({ ...seg, track: assignedTrack })
  }

  return segments
}

/** Which default deadline column a card actually keeps its day in, read the way `date-fields` reads it. */
function dueKeyOf(item: KanbanItem): string {
  return typeof item.properties.dueDate === 'string' && item.properties.dueDate ? 'dueDate' : 'endDate'
}

/**
 * The columns of a card that a calendar drag has to keep hold of — the day the bar is drawn from and
 * the day it ends on, each with the column it was read from. The pair is read the way
 * `resolveItemDateRange` draws it (the view's own field when it named one and the card carries it,
 * the fallback chain otherwise), because the patch a drop writes has to land in the columns that
 * hold the days that were drawn — a card moved in the calendar must read the same in the timeline.
 */
export interface CalendarMoveDays {
  start?: { key: string; day: string }
  end?: { key: string; day: string }
}

/** The two days a calendar draws, each with the column it came from, in draw order (start then end). */
export function calendarMoveDays(item: KanbanItem, dateField?: string): CalendarMoveDays {
  const configured = dateField ? kanbanDayKey(item.properties[dateField]) : ''
  if (dateField && configured) {
    // The view named its own column and the card carries a day there: that column holds the drawn
    // day, and the deadline — read the way every surface reads it — is the far end when it has one.
    const due = getKanbanDueDate(item)
    return due
      ? { start: { key: dateField, day: configured }, end: { key: dueKeyOf(item), day: due } }
      : { start: { key: dateField, day: configured } }
  }
  const start = getKanbanStartDate(item)
  const due = getKanbanDueDate(item)
  const move: CalendarMoveDays = {}
  if (start) move.start = { key: 'startDate', day: start }
  if (due) move.end = { key: dueKeyOf(item), day: due }
  return move
}

/**
 * The properties a card would carry if its bar moved onto `targetDay` — dragged there, or walked one
 * day with an arrow key. A bar moves whole: the start is written to the day the gesture named, and
 * the end keeps the span the bar had, so a three-day card stays three days long in its new week. The
 * patch lands in the columns that held the days (`calendarMoveDays` reads them), stored values are
 * normalised to the day itself the way day arithmetic demands, and the patch is empty when the card
 * has no day to move or the gesture named no day — which is what tells the view there is nothing to
 * commit, so a drag that never landed writes nothing rather than a day it never had.
 */
export function moveCalendarItemToDay(
  item: KanbanItem,
  targetDay: string,
  dateField?: string,
): Record<string, string> {
  if (!targetDay) return {}
  const move = calendarMoveDays(item, dateField)
  if (!move.start && !move.end) return {}
  const start = move.start ? kanbanDayKey(move.start.day) : ''
  const end = move.end ? kanbanDayKey(move.end.day) : ''
  const span = start && end ? -daysBetweenKeys(end, start) : 0
  const patch: Record<string, string> = {}
  if (move.start) patch[move.start.key] = targetDay
  if (move.end) patch[move.end.key] = addDaysKey(targetDay, span)
  return patch
}

export function getWeekEventSegments(items: KanbanItem[], week: CalendarDay[], dateField?: string): WeekEventSegment[] {
  if (!week.length) return []
  const weekStart = week[0].dateStr
  const weekEnd = week[6].dateStr
  const rawSegments: Omit<WeekEventSegment, 'track'>[] = []

  for (const item of items) {
    const range = resolveItemDateRange(item, dateField)
    if (!range || range.end < weekStart || range.start > weekEnd) continue

    const startCol = range.start < weekStart ? 0 : week.findIndex((d) => d.dateStr === range.start)
    const endCol = range.end > weekEnd ? 6 : week.findIndex((d) => d.dateStr === range.end)

    if (startCol === -1 || endCol === -1 || startCol > endCol) continue

    rawSegments.push({
      item,
      startCol,
      endCol,
      isSegmentStart: range.start >= weekStart,
      isSegmentEnd: range.end <= weekEnd,
    })
  }

  rawSegments.sort((a, b) => {
    if (a.startCol !== b.startCol) return a.startCol - b.startCol
    return (b.endCol - b.startCol) - (a.endCol - a.startCol)
  })

  return assignTracks(rawSegments)
}
