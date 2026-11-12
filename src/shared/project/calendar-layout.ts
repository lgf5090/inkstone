/**
 * The calendar's spanning ribbons.
 *
 * A task that runs Tuesday to Thursday is one ribbon across three cells, not three unrelated chips.
 * The reference stacks a thin line at the top of each day and pushes the day number below the stack;
 * the lane a task occupies is decided once for the whole visible grid so the ribbon does not jump
 * rows as it crosses a week boundary.
 */
import type { ProjectCard, ProjectProperty } from './model'
import { isProjectCardDone } from './model'
import { projectOptionCssColor } from './option-color'
import { PROJECT_TIMELINE_DAY_MS as PROJECT_ONE_DAY_MS, projectCardDays } from './timeline-layout'

export const PROJECT_CALENDAR_RIBBON_PX = 4

export interface CalendarRibbon {
  card: ProjectCard
  lane: number
  start: boolean
  end: boolean
  color: string
}

/** The colour a card's chip border and ribbon wear: its status option, or the accent. */
export function projectCalendarCardColor(card: ProjectCard, properties: readonly ProjectProperty[]): string {
  const status = properties.find((property) => property.type === 'select')
  const option = status?.options.find((entry) => entry.id === card.values[status.id])
  return (option && projectOptionCssColor(option.color)) ?? 'var(--accent)'
}

/** One card as the calendar sees it: the days it covers, resolved once. */
export interface CalendarEntry {
  card: ProjectCard
  firstKey: string
  lastKey: string
  start: number
  end: number
}

/**
 * Ribbons per day key, with a stable lane per card.
 *
 * Lanes are handed out greedily in start order, longest first, and reused once a lane's last task has
 * ended — the same packing a month view of any calendar uses. Only ranges that actually span more
 * than one day become ribbons; a single-day card stays a chip.
 */
export function projectCalendarRibbons(
  entries: readonly CalendarEntry[],
  properties: readonly ProjectProperty[],
  dayKeys: readonly string[],
): Map<string, CalendarRibbon[]> {
  const visible = new Set(dayKeys)
  const first = dayKeys[0]
  const last = dayKeys[dayKeys.length - 1]
  const spans = entries
    .filter((entry) => entry.end > entry.start && first !== undefined && last !== undefined && entry.lastKey >= first && entry.firstKey <= last)
    .map((entry) => ({ card: entry.card, from: entry.start, to: entry.end, firstKey: entry.firstKey, lastKey: entry.lastKey }))
  spans.sort((left, right) => left.from - right.from || (right.to - right.from) - (left.to - left.from))
  const laneEnds: string[] = []
  const byDay = new Map<string, CalendarRibbon[]>()
  for (const span of spans) {
    let lane = laneEnds.findIndex((lastKey) => lastKey < span.firstKey)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(span.lastKey)
    } else {
      laneEnds[lane] = span.lastKey
    }
    const color = projectCalendarCardColor(span.card, properties)
    for (const key of dayKeys) {
      if (key < span.firstKey || key > span.lastKey || !visible.has(key)) continue
      const list = byDay.get(key) ?? []
      list.push({ card: span.card, lane, start: key === span.firstKey, end: key === span.lastKey, color })
      byDay.set(key, list)
    }
  }
  return byDay
}

/**
 * Every dated card, parsed once, bucketed under each day it covers.
 *
 * A month grid asks 42 questions of the same card list. Answering each by rescanning every card
 * re-parses its date JSON and rebuilds three Dates per cell — 3000 cards measured 146ms a frame.
 * One pass here turns each cell into a map lookup.
 */
export function projectCalendarIndex(
  cards: readonly ProjectCard[],
  propertyId: string | undefined,
  keyOf: (stamp: number) => string,
): { entries: CalendarEntry[], byDay: Map<string, CalendarEntry[]> } {
  const entries: CalendarEntry[] = []
  const byDay = new Map<string, CalendarEntry[]>()
  for (const card of cards) {
    const days = projectCardDays(card, propertyId)
    if (!days) continue
    const entry: CalendarEntry = { card, firstKey: keyOf(days.start), lastKey: keyOf(days.end), start: days.start, end: days.end }
    entries.push(entry)
    for (let stamp = days.start; stamp <= days.end; stamp += PROJECT_ONE_DAY_MS) {
      const key = keyOf(stamp)
      const list = byDay.get(key)
      if (list) list.push(entry)
      else byDay.set(key, [entry])
    }
  }
  return { entries, byDay }
}

/**
 * The chips a day draws: cards that live on that day alone.
 *
 * A spanning card is named by its ribbon, so repeating it as a chip on its start day said the same
 * thing twice and pushed the single-day cards out of a short cell.
 */
export function projectCalendarDayChips(bucket: readonly CalendarEntry[]): { card: ProjectCard, starting: boolean, end: number }[] {
  return bucket.filter((entry) => entry.firstKey === entry.lastKey).map((entry) => ({ card: entry.card, starting: true, end: entry.end }))
}

export type CalendarDayRole = 'start' | 'due' | 'both' | 'active'

/** Every card the day touches, and what the day means to it — the day panel's own vocabulary. */
export function projectCalendarDayRoles(bucket: readonly CalendarEntry[], dayKey: string): { card: ProjectCard, role: CalendarDayRole }[] {
  return bucket.map((entry) => {
    const starts = dayKey === entry.firstKey
    const ends = dayKey === entry.lastKey
    return { card: entry.card, role: starts && ends ? 'both' : starts ? 'start' : ends ? 'due' : 'active' } as { card: ProjectCard, role: CalendarDayRole }
  })
}

/** A chip reads as overdue when its range has passed and the card is not done. */
export function projectCalendarOverdue(card: ProjectCard, properties: readonly ProjectProperty[], endStamp: number, todayStamp: number): boolean {
  return endStamp < todayStamp && !isProjectCardDone(card, properties)
}
export interface CalendarWeekSpan {
  card: ProjectCard
  lane: number
  startCol: number
  endCol: number
  continuesLeft: boolean
  continuesRight: boolean
  color: string
}

/**
 * One week's ribbons as bars, not as per-day fragments.
 *
 * The lane was decided for the whole grid, so a card keeps its row across the week boundary; here the
 * days it covers inside this week collapse into a single bar with the columns it spans. A bar that
 * runs off either edge is left square on that side, which is how a reader sees "continues".
 */
export function projectCalendarWeekSpans(
  weekKeys: readonly string[],
  ribbons: ReadonlyMap<string, CalendarRibbon[]>,
): CalendarWeekSpan[] {
  const byCard = new Map<string, CalendarWeekSpan>()
  weekKeys.forEach((key, column) => {
    for (const ribbon of ribbons.get(key) ?? []) {
      const existing = byCard.get(ribbon.card.id)
      if (existing) {
        existing.endCol = column
        existing.continuesRight = !ribbon.end
      } else {
        byCard.set(ribbon.card.id, {
          card: ribbon.card,
          lane: ribbon.lane,
          startCol: column,
          endCol: column,
          continuesLeft: !ribbon.start,
          continuesRight: !ribbon.end,
          color: ribbon.color,
        })
      }
    }
  })
  return [...byCard.values()]
}
