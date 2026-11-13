/**
 * The arithmetic behind the timeline, kept out of the component because it is the half that can be
 * wrong in ways the eye forgives: a bar one day wide of its range, a today line on the wrong column,
 * a child drawn as a sibling. Everything is measured in whole local days read through the module's
 * own date conversion, so a card dated the 10th sits on the 10th in every zone.
 */
import type { ProjectCard, ProjectProperty, ProjectScheduleScale } from './model'
import { parseProjectDateValue, projectStampToDay } from './date'
import { projectOptionCssColor } from './option-color'
import { groupProjectCards, projectOptionLabel } from './view-eval'

export const PROJECT_TIMELINE_DAY_MS = 86_400_000

/** Granularities the axis can be drawn at; the column width is what changes, not the window. */
export type ProjectTimelineScale = ProjectScheduleScale

export const PROJECT_TIMELINE_COLUMN_PX: Readonly<Record<ProjectTimelineScale, number>> = {
  day: 40,
  week: 18,
  month: 6,
  quarter: 3,
}

export interface TimelineRange {
  from: number
  to: number
}

/** The days a card covers, as local midnight stamps, or null when it names no date. */
export function projectCardDays(card: ProjectCard, propertyId: string | undefined): { start: number, end: number } | null {
  if (!propertyId) return null
  const value = parseProjectDateValue(card.values[propertyId] ?? '')
  if (value?.from === undefined) return null
  const includeTime = value.includeTime === true
  const start = projectStampToDay(value.from, includeTime, value.timeZone).getTime()
  const end = value.to === undefined ? start : projectStampToDay(value.to, includeTime, value.timeZone).getTime()
  return { start, end: Math.max(start, end) }
}

function localMidnight(stamp: number): number {
  const day = new Date(stamp)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * The window the axis draws: every dated card, padded by three days each side, or the fortnight
 * around today when nothing is dated yet — an empty axis still has to say what dates it covers.
 */
export function projectTimelineWindow(ranges: readonly TimelineRange[], today: number, padDays = 3): { start: number, end: number } {
  const pad = padDays * PROJECT_TIMELINE_DAY_MS
  if (ranges.length === 0) {
    const base = localMidnight(today)
    return { start: base - 7 * PROJECT_TIMELINE_DAY_MS, end: base + 7 * PROJECT_TIMELINE_DAY_MS }
  }
  let min = Infinity
  let max = -Infinity
  for (const range of ranges) {
    if (range.from < min) min = range.from
    if (range.to > max) max = range.to
  }
  return { start: localMidnight(min) - pad, end: localMidnight(max) + pad }
}

export interface TimelineDay {
  stamp: number
  weekend: boolean
  today: boolean
  /** The month label is drawn only on the first column of a month, the way the reference heads it. */
  monthStart: boolean
}

export function projectTimelineDays(window: { start: number, end: number }, today: number): TimelineDay[] {
  const todayStamp = localMidnight(today)
  const days: TimelineDay[] = []
  for (let stamp = window.start; stamp <= window.end; stamp += PROJECT_TIMELINE_DAY_MS) {
    const date = new Date(stamp)
    const weekday = date.getDay()
    days.push({ stamp, weekend: weekday === 0 || weekday === 6, today: stamp === todayStamp, monthStart: date.getDate() === 1 })
  }
  return days
}

/** Where a bar sits inside the window, in whole columns; a range is inclusive of its last day. */
export function projectTimelineBar(range: TimelineRange, window: { start: number, end: number }): { left: number, width: number } {
  const day = PROJECT_TIMELINE_DAY_MS
  const left = Math.round((range.from - window.start) / day)
  const last = Math.round((range.to - window.start) / day)
  return { left, width: Math.max(1, last - left + 1) }
}

export interface TimelineRow {
  card: ProjectCard
  depth: number
  childCount: number
}

/**
 * The rows in reading order: a parent, then its children indented under it.
 *
 * A card whose parent is not in this view is a root, so a filtered view never hides a child whose
 * parent was filtered out. `seen` breaks a cycle rather than recursing forever on imported data.
 */
export function projectTimelineRows(cards: readonly ProjectCard[], collapsed: ReadonlySet<string> = new Set()): TimelineRow[] {
  const ids = new Set(cards.map((card) => card.id))
  const children = new Map<string, ProjectCard[]>()
  const roots: ProjectCard[] = []
  for (const card of cards) {
    if (card.parentId && ids.has(card.parentId)) {
      const list = children.get(card.parentId)
      if (list) list.push(card)
      else children.set(card.parentId, [card])
    } else {
      roots.push(card)
    }
  }
  const rows: TimelineRow[] = []
  const seen = new Set<string>()
  const skip = (card: ProjectCard): void => {
    if (seen.has(card.id)) return
    seen.add(card.id)
    for (const kid of children.get(card.id) ?? []) skip(kid)
  }
  const walk = (card: ProjectCard, depth: number): void => {
    if (seen.has(card.id)) return
    seen.add(card.id)
    const kids = children.get(card.id) ?? []
    rows.push({ card, depth, childCount: kids.length })
    if (collapsed.has(card.id)) {
      for (const kid of kids) skip(kid)
      return
    }
    for (const kid of kids) walk(kid, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  // A cycle has no root, so its members would otherwise disappear from the view entirely.
  for (const card of cards) walk(card, 0)
  return rows
}
/**
 * The range a bar lands on after being dragged whole across the axis.
 *
 * The bar keeps its length: a three-day task moved two columns right is still three days, and the
 * writer turns both ends back into stored stamps so the move cannot quietly become a single day.
 */
export function projectTimelineDragRange(range: TimelineRange, columns: number): TimelineRange {
  const shift = Math.round(columns) * PROJECT_TIMELINE_DAY_MS
  return { from: range.from + shift, to: range.to + shift }
}

/** Which column a pointer at `offsetX` is over, clamped into the drawn window. */
export function projectTimelineColumn(offsetX: number, columnPx: number, dayCount: number): number {
  if (!(columnPx > 0) || dayCount <= 0) return 0
  return Math.min(dayCount - 1, Math.max(0, Math.floor(offsetX / columnPx)))
}

/**
 * Cards whose schedule contradicts a blocking dependency.
 *
 * A card that is blocked by another should not start before that one ends. The Gantt draws the edge
 * and outlines the offender, because an arrow alone does not say which end is wrong. Cards with no
 * date on either side are not judged.
 */
export function projectScheduleConflicts(
  links: readonly { fromCardId: string, toCardId: string, kind: string }[],
  daysByCard: ReadonlyMap<string, { start: number, end: number }>,
): Set<string> {
  const conflicts = new Set<string>()
  for (const link of links) {
    if (link.kind !== 'blocks') continue
    const blocker = daysByCard.get(link.fromCardId)
    const dependent = daysByCard.get(link.toCardId)
    if (!blocker || !dependent) continue
    if (dependent.start <= blocker.end) conflicts.add(link.toCardId)
  }
  return conflicts
}

/** The window that fits every dated card exactly, for the Gantt's "fit" action. */
export function projectTimelineFitScale(ranges: readonly TimelineRange[], viewportPx: number): ProjectTimelineScale {
  if (ranges.length === 0 || !(viewportPx > 0)) return 'day'
  const days = projectScheduleSpanDays(ranges)
  if (days * PROJECT_TIMELINE_COLUMN_PX.day <= viewportPx) return 'day'
  if (days * PROJECT_TIMELINE_COLUMN_PX.week <= viewportPx) return 'week'
  if (days * PROJECT_TIMELINE_COLUMN_PX.month <= viewportPx) return 'month'
  return 'quarter'
}

export interface ScheduleRow {
  kind: 'lane' | 'card'
  id: string
  card?: ProjectCard
  label: string
  depth: number
  childCount: number
  color: string
  laneKey: string
}

/**
 * The rows a schedule draws, optionally banded into lanes by a property.
 *
 * A lane is a row of its own rather than a sticky label over the cards, so the frozen name column and
 * the canvas stay in lockstep: row N on the left is row N on the axis, whatever it is.
 */
export function projectScheduleRows(
  cards: readonly ProjectCard[],
  options: {
    groupById?: string
    properties: readonly ProjectProperty[]
    collapsed?: ReadonlySet<string>
    colorOf: (card: ProjectCard) => string
  },
): ScheduleRow[] {
  const collapsed = options.collapsed ?? new Set<string>()
  const groupProperty = options.properties.find((property) => property.id === options.groupById)
  const cardRows = (list: readonly ProjectCard[], laneKey: string, depth: number): ScheduleRow[] =>
    projectTimelineRows(list, collapsed).map((row) => ({
      kind: 'card' as const,
      id: row.card.id,
      card: row.card,
      label: row.card.title,
      depth: row.depth + depth,
      childCount: row.childCount,
      color: options.colorOf(row.card),
      laneKey,
    }))
  if (!groupProperty) return cardRows(cards, '', 0)
  const groups = groupProjectCards(cards, groupProperty.id, options.properties)
  const keys = [...groupProperty.options.map((option) => option.id), '']
  const rows: ScheduleRow[] = []
  for (const key of keys) {
    const list = groups.get(key) ?? []
    const color = (key === '' ? null : projectOptionCssColor(groupProperty.options.find((option) => option.id === key)?.color ?? '')) ?? 'var(--text-quaternary)'
    rows.push({
      kind: 'lane',
      id: `lane:${key}`,
      label: key === '' ? '' : projectOptionLabel(groupProperty, key),
      depth: 0,
      childCount: list.length,
      color,
      laneKey: key,
    })
    if (!collapsed.has(`lane:${key}`)) rows.push(...cardRows(list, key, 1))
  }
  return rows
}

/** How far through its subtasks a card is, as a fraction the bar can fill. */
export function projectCardProgress(
  card: ProjectCard,
  subtasks: readonly ProjectCard[],
  isDone: (card: ProjectCard) => boolean,
): number {
  if (isDone(card)) return 1
  if (subtasks.length === 0) return 0
  return subtasks.filter(isDone).length / subtasks.length
}

/** The window a "fit" action needs, in days, so the caller can pick the widest scale that fits. */
export function projectScheduleSpanDays(ranges: readonly TimelineRange[]): number {
  if (ranges.length === 0) return 0
  let min = Infinity
  let max = -Infinity
  for (const range of ranges) {
    if (range.from < min) min = range.from
    if (range.to > max) max = range.to
  }
  return Math.max(1, Math.round((max - min) / PROJECT_TIMELINE_DAY_MS) + 1)
}
