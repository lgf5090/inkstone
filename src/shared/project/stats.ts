/**
 * The report numbers the reference's Stats view draws, computed from cards instead of tasks.
 *
 * A board has no fixed `priority` or `status` field — it has properties the reader named. So the
 * buckets are found by what the options say, not by a column position, and a board that never named
 * a priority simply reports no priority panel rather than inventing one.
 */
import type { ProjectCard, ProjectProperty } from './model'
import { isProjectCardDone } from './model'

const DAY_MS = 86_400_000

// U+9AD8 / U+4E2D / U+4F4E are high / medium / low; the lookbehind-free alternation is enough because
// an option named "not high" is not a priority level anyone writes.
const PRIORITY_WORDS: readonly RegExp[] = [/high|urgent|critical|\u9ad8/i, /medium|normal|\u4e2d/i, /low|minor|\u4f4e/i]

export interface ProjectPriorityBucket {
  key: string
  label: string
  color: string
  count: number
}

/** The select property whose options read as priority levels, if the board has one. */
export function projectPriorityProperty(properties: readonly ProjectProperty[]): ProjectProperty | null {
  for (const property of properties) {
    if (property.type !== 'select' || property.options.length < 2) continue
    const hits = PRIORITY_WORDS.filter((word) => property.options.some((option) => word.test(option.value)))
    if (hits.length >= 2) return property
  }
  return null
}

export function projectPriorityBuckets(
  cards: readonly ProjectCard[],
  property: ProjectProperty,
  colorOf: (color: string) => string | null,
): ProjectPriorityBucket[] {
  const order = PRIORITY_WORDS.map((word) => property.options.find((option) => word.test(option.value))).filter((option): option is NonNullable<typeof option> => Boolean(option))
  const rest = property.options.filter((option) => !order.includes(option))
  return [...order, ...rest].map((option) => ({
    key: option.id,
    label: option.value,
    color: colorOf(option.color) ?? 'var(--text-quaternary)',
    count: cards.filter((card) => card.values[property.id] === option.id).length,
  }))
}

export interface ProjectWeekBucket {
  start: number
  count: number
}

/**
 * Cards finished in each of the last `weeks` weeks, oldest first.
 *
 * "Finished" is the done test the whole app uses, dated by the card's last edit — the only timestamp
 * a card carries that can stand in for a completion time.
 */
export function projectWeeklyCompletions(
  cards: readonly ProjectCard[],
  properties: readonly ProjectProperty[],
  today: number,
  weeks = 4,
): ProjectWeekBucket[] {
  const base = new Date(today)
  base.setHours(0, 0, 0, 0)
  const monday = base.getTime() - ((base.getDay() + 6) % 7) * DAY_MS
  const buckets: ProjectWeekBucket[] = Array.from({ length: weeks }, (_, index) => ({ start: monday - (weeks - 1 - index) * 7 * DAY_MS, count: 0 }))
  for (const card of cards) {
    if (!isProjectCardDone(card, properties)) continue
    const at = card.completedAt ?? card.updateAt
    for (const bucket of buckets) {
      if (at >= bucket.start && at < bucket.start + 7 * DAY_MS) { bucket.count += 1; break }
    }
  }
  return buckets
}

export const PROJECT_SPRINT_STATUSES = ['planned', 'active', 'completed'] as const
export type ProjectSprintStatus = (typeof PROJECT_SPRINT_STATUSES)[number]

export interface ProjectSprint {
  id: string
  boardId: string
  name: string
  goal: string
  startAt: number
  endAt: number
  status: ProjectSprintStatus
  createdBy: string
  createdAt: number
  updatedAt: number
}

export interface ProjectSprintBurndownPoint {
  day: number
  dayLabel: string
  ideal: number
  remaining: number
  completed: number
}

export interface ProjectSprintBurndown {
  total: number
  completed: number
  remaining: number
  velocity: number
  points: ProjectSprintBurndownPoint[]
}

/** A sprint longer than a quarter gets no more than one point per day, so the chart stays bounded. */
const SPRINT_MAX_DAYS = 92

function dayStart(stamp: number): number {
  const date = new Date(stamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Scope, ideal line and actual line for one iteration. A card counts as finished on the day its
 * `completedAt` fell; older cards that predate that column fall back to the same update stamp the
 * four-week trend uses, so a board imported from an archive still draws a line.
 */
export function projectSprintBurndown(
  cards: readonly ProjectCard[],
  properties: readonly ProjectProperty[],
  sprint: ProjectSprint,
  today: number,
): ProjectSprintBurndown {
  const start = dayStart(sprint.startAt)
  const end = dayStart(sprint.endAt)
  const span = Math.max(1, Math.min(SPRINT_MAX_DAYS, Math.round((end - start) / DAY_MS) + 1))
  const total = cards.length
  const finishedAt = cards.map((card) => isProjectCardDone(card, properties) ? (card.completedAt ?? card.updateAt) : null)
  const points: ProjectSprintBurndownPoint[] = Array.from({ length: span }, (_, index) => {
    const day = start + index * DAY_MS
    const completed = finishedAt.filter((at) => at !== null && at < day + DAY_MS).length
    return {
      day,
      dayLabel: new Date(day).toISOString().slice(0, 10),
      ideal: Math.round(total * (1 - index / Math.max(1, span - 1)) * 10) / 10,
      remaining: total - completed,
      completed,
    }
  })
  const elapsed = Math.max(1, Math.min(span, Math.round((dayStart(today) - start) / DAY_MS) + 1))
  const completed = points[elapsed - 1]?.completed ?? 0
  return {
    total,
    completed,
    remaining: total - completed,
    velocity: Math.round((completed / elapsed) * 100) / 100,
    points,
  }
}

export interface ProjectEffortStats {
  total: number
  average: number
  max: number
  maxCard: ProjectCard | null
}

/** Sum, mean and peak of a numeric property — the reference's time panel, over whatever the board measures. */
export function projectEffortStats(cards: readonly ProjectCard[], property: ProjectProperty | undefined): ProjectEffortStats {
  if (!property) return { total: 0, average: 0, max: 0, maxCard: null }
  let total = 0
  let max = 0
  let counted = 0
  let maxCard: ProjectCard | null = null
  for (const card of cards) {
    const value = Number(card.values[property.id])
    if (!Number.isFinite(value) || value <= 0) continue
    total += value
    counted += 1
    if (value > max) { max = value; maxCard = card }
  }
  return { total, average: counted > 0 ? total / counted : 0, max, maxCard }
}