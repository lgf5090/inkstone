/**
 * The activity heatmap's vocabulary: which kinds exist, how a request is validated, and how a year
 * lays out as fifty-three Monday-first columns.
 *
 * Pure on purpose. The worker validates the same parameters with the predicates here, the browser
 * lays the grid out with the same week function, and the tests pin both without touching D1 or the
 * DOM. A kind that has no real table behind it is simply absent from the list — the grid never draws
 * a column of zeroes for an activity this notebook cannot record.
 */

export const ACTIVITY_KINDS = [
  'notes',
  'todos',
  'todos_completed',
  'memos',
  'events',
  'uploads',
  'music',
  'chat',
] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/** A single year is the widest readable window; the grid has only fifty-three columns. */
export const HEATMAP_MAX_DAYS = 366

export interface HeatmapDay {
  /** `YYYY-MM-DD` in the account's timezone. */
  date: string
  /** Per-kind counts; a kind with no rows that day is absent rather than zero. */
  counts: Partial<Record<ActivityKind, number>>
}

export interface HeatmapResponse {
  from: string
  to: string
  /** The kinds the answer covers, in the order the request named them. */
  kinds: ActivityKind[]
  days: HeatmapDay[]
  totals: Record<ActivityKind, number>
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** A calendar day that exists, not merely a string of the right shape. */
export function isHeatmapDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const utc = new Date(Date.UTC(year, month - 1, day))
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
}

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value)
}

/**
 * The `kinds` parameter: a comma-separated list, or nothing for every kind.
 *
 * Unknown names are refused rather than dropped: a request for `email` would otherwise come back as
 * a plausible-looking year without email in it, and the reader could not tell that apart from an
 * account that never sent mail.
 */
export function parseHeatmapKinds(raw: string | null | undefined): ActivityKind[] | null {
  if (raw === undefined || raw === null || !raw.trim()) return [...ACTIVITY_KINDS]
  const parts = raw.split(',').map(part => part.trim()).filter(Boolean)
  const kinds: ActivityKind[] = []
  for (const part of parts) {
    if (!isActivityKind(part)) return null
    if (!kinds.includes(part)) kinds.push(part)
  }
  return kinds.length > 0 ? kinds : null
}

/** Whole days between two `YYYY-MM-DD` keys, counted as calendar days rather than instants. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** Whether a requested window is one the endpoint answers, or null when it does not. */
export function heatmapWindow(from: string, to: string): { from: string; to: string } | null {
  if (!isHeatmapDay(from) || !isHeatmapDay(to)) return null
  const span = daysBetween(from, to)
  if (span < 0 || span + 1 > HEATMAP_MAX_DAYS) return null
  return { from, to }
}

export interface HeatmapCell {
  /** `YYYY-MM-DD`, or null for the padding that squares off the first and last week. */
  date: string | null
}

/** Monday-first, because an ISO week starts there and a year grid reads as week numbers. */
const ISO_WEEK_START = 1

function keyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/**
 * One year as columns of seven days.
 *
 * The first column opens on the Monday on or before 1 January and the last closes on the Sunday on
 * or after 31 December, so every column is a real ISO week; cells outside the year are null rather
 * than another year's days, which keeps the grid's rows aligned with the weekday labels.
 */
export function yearGrid(year: number, weekStart: number = ISO_WEEK_START): HeatmapCell[][] {
  const first = new Date(Date.UTC(year, 0, 1))
  const offset = (first.getUTCDay() - weekStart + 7) % 7
  const start = new Date(Date.UTC(year, 0, 1 - offset))
  const last = new Date(Date.UTC(year, 11, 31))
  const tail = (weekStart + 6 - last.getUTCDay() + 7) % 7
  const end = new Date(Date.UTC(year, 11, 31 + tail))
  const columns: HeatmapCell[][] = []
  const cursor = new Date(start)
  while (cursor.getTime() <= end.getTime()) {
    const column: HeatmapCell[] = []
    for (let row = 0; row < 7; row++) {
      const date = new Date(cursor.getTime() + row * 86_400_000)
      column.push({ date: date.getUTCFullYear() === year ? keyOf(date) : null })
    }
    columns.push(column)
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }
  return columns
}

/** The level a cell is painted at, from the year's busiest day. Zero stays empty. */
export function heatLevel(count: number, max: number, levels = 5): number {
  if (count <= 0 || max <= 0) return 0
  return Math.max(1, Math.min(levels, Math.round((levels * count) / max)))
}
