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
import { projectCardDays } from './timeline-layout'

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

/**
 * Ribbons per day key, with a stable lane per card.
 *
 * Lanes are handed out greedily in start order, longest first, and reused once a lane's last task has
 * ended — the same packing a month view of any calendar uses. Only ranges that actually span more
 * than one day become ribbons; a single-day card stays a chip.
 */
export function projectCalendarRibbons(
  cards: readonly ProjectCard[],
  propertyId: string | undefined,
  properties: readonly ProjectProperty[],
  dayKeys: readonly string[],
  keyOf: (stamp: number) => string,
): Map<string, CalendarRibbon[]> {
  const visible = new Set(dayKeys)
  const spans: { card: ProjectCard, from: number, to: number, firstKey: string, lastKey: string }[] = []
  for (const card of cards) {
    const days = projectCardDays(card, propertyId)
    if (!days || days.end <= days.start) continue
    const firstKey = keyOf(days.start)
    const lastKey = keyOf(days.end)
    if (!dayKeys.some((key) => key >= firstKey && key <= lastKey)) continue
    spans.push({ card, from: days.start, to: days.end, firstKey, lastKey })
  }
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

/** The chips a day draws: cards starting or ending that day, which the ribbons do not already name. */
export function projectCalendarDayChips(
  cards: readonly ProjectCard[],
  propertyId: string | undefined,
  dayKey: string,
  keyOf: (stamp: number) => string,
): { card: ProjectCard, starting: boolean }[] {
  const out: { card: ProjectCard, starting: boolean }[] = []
  for (const card of cards) {
    const days = projectCardDays(card, propertyId)
    if (!days) continue
    const starts = keyOf(days.start) === dayKey
    const ends = keyOf(days.end) === dayKey
    if (!starts && !ends) continue
    if (days.end > days.start && !starts) continue
    out.push({ card, starting: starts })
  }
  return out
}

/** A chip reads as overdue when its range has passed and the card is not done. */
export function projectCalendarOverdue(card: ProjectCard, properties: readonly ProjectProperty[], endStamp: number, todayStamp: number): boolean {
  return endStamp < todayStamp && !isProjectCardDone(card, properties)
}