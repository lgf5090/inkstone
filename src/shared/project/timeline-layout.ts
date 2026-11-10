/**
 * The arithmetic behind the timeline, kept out of the component because it is the half that can be
 * wrong in ways the eye forgives: a bar one day wide of its range, a today line on the wrong column,
 * a child drawn as a sibling. Everything is measured in whole local days read through the module's
 * own date conversion, so a card dated the 10th sits on the 10th in every zone.
 */
import type { ProjectCard } from './model'
import { parseProjectDateValue, projectStampToDay } from './date'

export const PROJECT_TIMELINE_DAY_MS = 86_400_000

/** Granularities the axis can be drawn at; the column width is what changes, not the window. */
export type ProjectTimelineScale = 'day' | 'week' | 'month'

export const PROJECT_TIMELINE_COLUMN_PX: Readonly<Record<ProjectTimelineScale, number>> = {
  day: 40,
  week: 18,
  month: 6,
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
  const start = projectStampToDay(value.from, includeTime).getTime()
  const end = value.to === undefined ? start : projectStampToDay(value.to, includeTime).getTime()
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