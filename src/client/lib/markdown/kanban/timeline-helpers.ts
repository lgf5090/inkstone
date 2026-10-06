import { getKanbanDueDate, getKanbanStartDate, kanbanDayKey } from './date-fields'
import { addDaysKey, weekStartFor } from '../../time'
import type { KanbanItem } from './types'

export type TimelineZoom = 'day' | 'week' | 'month'

/**
 * What one day costs in pixels at each scale. The grid is built in days at every scale — a bar is a
 * span of days — so the scale is only the width of a column and how often the header writes on it.
 */
export const TIMELINE_ZOOM_DAY_WIDTH: Record<TimelineZoom, number> = { day: 48, week: 16, month: 6 }
export const TIMELINE_DAY_WIDTH = TIMELINE_ZOOM_DAY_WIDTH.day
export const TIMELINE_BAR_OFFSET = 4
export const TIMELINE_BAR_GAP = 8
/** A bar is never narrower than this, or a one-day card at month scale would be a hairline. */
export const TIMELINE_MIN_BAR_WIDTH = 8
/** Room left between the outermost card and the edge of the window, so a bar is not flush with it. */
const TIMELINE_PAD_DAYS = 3
/** What an empty board shows: a month around today, so the view still has a scale to read. */
const TIMELINE_EMPTY_BEFORE = 7
const TIMELINE_EMPTY_AFTER = 21
/** The widest window a board may ask for; a card dated years out must not build a huge grid. */
export const TIMELINE_MAX_DAYS = 400

const MS_PER_DAY = 86400000

export interface TimelineDay {
  dateStr: string
  /** The text this column carries at the current scale; empty when the scale labels another day. */
  label: string
  isToday: boolean
}

export interface TimelineDayFields {
  startField?: string
  endField?: string
}

export interface TimelineRange {
  days: TimelineDay[]
  dayWidth: number
  /** Where today sits in the window; the window always holds today, so this is a real index. */
  todayIndex: number
  /** True when the cards span more than `TIMELINE_MAX_DAYS`, so the window is the part around today. */
  clipped: boolean
}

export interface TimelineRangeQuery {
  items: KanbanItem[]
  fields?: TimelineDayFields
  zoom: TimelineZoom
  baseDate?: Date
  locale?: string
}

function formatDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseDaysDiff(d1Str: string, d2Str: string): number {
  const d1 = new Date(d1Str + 'T00:00:00')
  const d2 = new Date(d2Str + 'T00:00:00')
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0
  return Math.round((d1.getTime() - d2.getTime()) / MS_PER_DAY)
}

/**
 * One of a card's two days, with the column it was read from. The key is what a drag has to write
 * back to: a card whose deadline is stored under `endDate` must not be handed a `dueDate` beside it,
 * and a view that named its own columns must not have them write into the defaults.
 */
interface TimelineDayEntry {
  key: string
  day: string
}

/** Which default deadline column a card actually keeps its day in, read the way `date-fields` reads it. */
function defaultDueKey(item: KanbanItem): string {
  const due = item.properties.dueDate
  return typeof due === 'string' && due ? 'dueDate' : 'endDate'
}

/**
 * The two days a card puts on the grid, each with the column it came from. A column the view named
 * wins, and an empty one falls back to the days every surface reads (`startDate`, then `dueDate` or
 * `endDate`) — the same precedence the grid draws with, so dragging a bar moves the day that was
 * drawn rather than the one the view merely mentioned.
 */
function itemDayEntries(
  item: KanbanItem,
  fields?: TimelineDayFields,
): { start: TimelineDayEntry; end: TimelineDayEntry } {
  const startField = fields?.startField
  const endField = fields?.endField
  const configuredStart = startField ? kanbanDayKey(item.properties[startField]) : ''
  const configuredEnd = endField ? kanbanDayKey(item.properties[endField]) : ''
  return {
    start:
      startField && configuredStart
        ? { key: startField, day: configuredStart }
        : { key: 'startDate', day: getKanbanStartDate(item) },
    end:
      endField && configuredEnd
        ? { key: endField, day: configuredEnd }
        : { key: defaultDueKey(item), day: getKanbanDueDate(item) },
  }
}

/** The two days a card can put on the grid, in either order. Empty strings mean "no such day". */
function itemDayKeys(item: KanbanItem, fields?: TimelineDayFields): { start: string; end: string } {
  const { start, end } = itemDayEntries(item, fields)
  return { start: start.day, end: end.day }
}

/**
 * The day a reader who just moved a bar is looking at: the deadline the card now carries, or its start
 * when it has no deadline. One day rather than both, because the announcement is one sentence and the
 * bar the reader dragged is one span.
 */
export function timelineAnnouncedDay(
  item: KanbanItem,
  fields: TimelineDayFields | undefined,
  patch: Record<string, string>,
): string {
  const { start, end } = itemDayEntries(item, fields)
  return patch[end.key] ?? patch[start.key] ?? ''
}

/**
 * How many days a horizontal drag stands for, at the scale the grid is drawn at. A scale of nothing
 * (the reader zoomed out of the arithmetic, or a stub that reports no width) stands for no days, so a
 * drag with no scale under it commits nothing rather than whatever the pointer happened to cross.
 */
export function timelineDragDays(dx: number, dayWidth: number): number {
  if (dayWidth <= 0 || !Number.isFinite(dx)) return 0
  return Math.round(dx / dayWidth)
}

/**
 * The properties a card would carry if its days moved `dragDays` days later (earlier when negative).
 * Each day is written back to the column that held it and normalised to the day itself: a stored value
 * may carry a time, and day arithmetic cannot parse one. The patch is empty when the card has no day
 * to move or the drag stands for no days — which is what tells the view there is nothing to commit, so
 * a press that never moved writes nothing rather than re-writing the day it already had.
 */
export function shiftTimelineProperties(
  item: KanbanItem,
  fields: TimelineDayFields | undefined,
  dragDays: number,
): Record<string, string> {
  if (dragDays === 0) return {}
  const { start, end } = itemDayEntries(item, fields)
  const patch: Record<string, string> = {}
  for (const entry of [start, end]) {
    const day = kanbanDayKey(entry.day)
    if (day) patch[entry.key] = addDaysKey(day, dragDays)
  }
  return patch
}

/** Whether a card belongs on the grid at all. A card with no day is listed beside it instead. */
export function hasTimelineDates(item: KanbanItem, fields?: TimelineDayFields): boolean {
  const { start, end } = itemDayKeys(item, fields)
  return Boolean(start || end)
}

export function splitTimelineItems(
  items: KanbanItem[],
  fields?: TimelineDayFields,
): { dated: KanbanItem[]; undated: KanbanItem[] } {
  const dated: KanbanItem[] = []
  const undated: KanbanItem[] = []
  for (const item of items) (hasTimelineDates(item, fields) ? dated : undated).push(item)
  return { dated, undated }
}

/**
 * The span of days the reader is looking at, derived from the cards themselves rather than from the
 * clock: the window reaches from the earliest day on the board to the latest, plus a little room, and
 * always contains today so the marker has somewhere to stand. A board whose cards span more than the
 * cap gets the window around today instead — bounded work and a readable scale, with `clipped` telling
 * the view to say so out loud rather than drawing a fraction of the cards silently.
 */
export function buildTimelineRange(query: TimelineRangeQuery): TimelineRange {
  const { items, fields, zoom, locale = 'en-US' } = query
  const baseDate = query.baseDate ?? new Date()
  const baseDateStr = formatDateStr(baseDate)
  const dayWidth = TIMELINE_ZOOM_DAY_WIDTH[zoom]

  let earliest = 0
  let latest = 0
  let sawDay = false
  for (const item of items) {
    const { start, end } = itemDayKeys(item, fields)
    for (const key of [start, end]) {
      if (!key) continue
      const offset = parseDaysDiff(key, baseDateStr)
      earliest = sawDay ? Math.min(earliest, offset) : offset
      latest = sawDay ? Math.max(latest, offset) : offset
      sawDay = true
    }
  }

  let firstOffset = sawDay ? Math.min(earliest, 0) - TIMELINE_PAD_DAYS : -TIMELINE_EMPTY_BEFORE
  let lastOffset = sawDay ? Math.max(latest, 0) + TIMELINE_PAD_DAYS : TIMELINE_EMPTY_AFTER
  let clipped = false
  if (lastOffset - firstOffset + 1 > TIMELINE_MAX_DAYS) {
    clipped = true
    const half = Math.floor(TIMELINE_MAX_DAYS / 2)
    firstOffset = -half
    lastOffset = firstOffset + TIMELINE_MAX_DAYS - 1
  }

  const weekStart = weekStartFor(locale)
  const dayFormatter = new Intl.DateTimeFormat(locale, { day: 'numeric' })
  const shortDayFormatter = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' })
  const monthFormatter = new Intl.DateTimeFormat(locale, { month: 'short' })
  const monthYearFormatter = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' })

  const days: TimelineDay[] = []
  let todayIndex = 0
  for (let offset = firstOffset; offset <= lastOffset; offset++) {
    const date = new Date(baseDate)
    date.setDate(baseDate.getDate() + offset)
    const dateStr = formatDateStr(date)
    const isToday = dateStr === baseDateStr
    if (isToday) todayIndex = days.length
    days.push({ dateStr, label: timelineDayLabel(date, zoom, weekStart, offset === firstOffset, { dayFormatter, shortDayFormatter, monthFormatter, monthYearFormatter }), isToday })
  }

  return { days, dayWidth, todayIndex, clipped }
}

interface TimelineLabelFormatters {
  dayFormatter: Intl.DateTimeFormat
  shortDayFormatter: Intl.DateTimeFormat
  monthFormatter: Intl.DateTimeFormat
  monthYearFormatter: Intl.DateTimeFormat
}

/**
 * What the column writes at this scale. The day scale labels every column; the week and month scales
 * label only the column a period opens on, so the header states when the period changed instead of
 * repeating the same word over every day of it. The first column is always labelled, so a window that
 * opens mid-week still says which month it starts in.
 */
function timelineDayLabel(
  date: Date,
  zoom: TimelineZoom,
  weekStart: number,
  isFirstColumn: boolean,
  formatters: TimelineLabelFormatters,
): string {
  if (zoom === 'day') return formatters.dayFormatter.format(date)
  if (zoom === 'week') {
    const opensWeek = date.getDay() === weekStart
    return opensWeek || isFirstColumn ? formatters.shortDayFormatter.format(date) : ''
  }
  const opensMonth = date.getDate() === 1
  if (opensMonth && date.getMonth() === 0) return formatters.monthYearFormatter.format(date)
  if (opensMonth) return formatters.monthFormatter.format(date)
  return isFirstColumn ? formatters.monthYearFormatter.format(date) : ''
}

export interface TimelineBarGeometry {
  left: number
  width: number
  /** The card starts before the window, so the bar is cut at the left edge. */
  clippedBefore: boolean
  /** The card ends after the window, so the bar is cut at the right edge. */
  clippedAfter: boolean
}

/**
 * Where a card's bar sits inside the window, in pixels. A card with no day has no bar at all — it is
 * listed beside the grid — and one that reaches past either edge is cut there rather than drawn
 * outside the grid or, worse, at a negative offset no amount of scrolling can reach.
 */
export function calculateTimelineBarGeometry(
  item: KanbanItem,
  range: TimelineRange,
  fields?: TimelineDayFields,
): TimelineBarGeometry | null {
  if (range.days.length === 0) return null
  const { start, end } = itemDayKeys(item, fields)
  const hasStart = Boolean(start)
  const hasEnd = Boolean(end)
  if (!hasStart && !hasEnd) return null

  const firstDay = range.days[0]!.dateStr
  const lastIndex = range.days.length - 1
  const startOffset = hasStart ? parseDaysDiff(start, firstDay) : parseDaysDiff(end, firstDay)
  const endOffset = hasEnd ? parseDaysDiff(end, firstDay) : startOffset
  const rawStart = Math.min(startOffset, endOffset)
  const rawEnd = Math.max(startOffset, endOffset)
  const clippedBefore = rawStart < 0
  const clippedAfter = rawEnd > lastIndex
  const startIndex = Math.max(0, Math.min(lastIndex, rawStart))
  const endIndex = Math.max(0, Math.min(lastIndex, rawEnd))
  const spanDays = Math.max(1, endIndex - startIndex + 1)

  return {
    left: startIndex * range.dayWidth + TIMELINE_BAR_OFFSET,
    width: Math.max(TIMELINE_MIN_BAR_WIDTH, spanDays * range.dayWidth - TIMELINE_BAR_GAP),
    clippedBefore,
    clippedAfter,
  }
}

/** Where today's column starts, which is what the "today" control scrolls the grid to. */
export function timelineTodayOffset(range: TimelineRange): number {
  return range.todayIndex * range.dayWidth
}
