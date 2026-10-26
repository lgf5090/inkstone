/**
 * The last complete answer for a visible range, kept so a reload paints before the network answers.
 *
 * DayFlow is empty until the first range response arrives, so every reload draws an empty grid and
 * then fills it. This keeps the previous answer next to the calendar's own preferences and hands it
 * back synchronously, which is the whole point: the first frame shows the reader's week, and the
 * fetch that follows is a revalidation rather than the first paint.
 *
 * Three rules keep it honest:
 *  - it is keyed by the account, because one browser can be used by more than one person and events
 *    are not something to show the wrong one;
 *  - it stores the revision the answer had (`count` + `maxUpdatedAt`), so a refresh can ask whether
 *    anything changed instead of pulling every row again;
 *  - it is bounded and disposable. The server is the truth; a missing, stale, oversized or corrupt
 *    entry costs one fetch, never a wrong calendar.
 */
import type { CalendarEventDto, CalendarRangeRevisionDto } from '@shared/calendar/model'

export interface CachedCalendarRange {
  from: number
  to: number
  savedAt: number
  revision: CalendarRangeRevisionDto
  events: CalendarEventDto[]
  /** What the server expanded the masters into for this range, kept so recurring events paint too. */
  occurrences: CalendarEventDto[]
}

interface CacheFile {
  version: 1
  entries: CachedCalendarRange[]
}

const STORAGE_PREFIX = 'inkstone.calendar.range.v1'
/** Four ranges is a month of weeks, or a week of days: more than that is history nobody returns to. */
export const MAX_CACHED_RANGES = 4
/** One range of a very large calendar is a few hundred kilobytes; the whole file stays under this. */
export const MAX_CACHE_BYTES = 2 * 1024 * 1024

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function keyFor(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}`
}

function isRevision(value: unknown): value is CalendarRangeRevisionDto {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CalendarRangeRevisionDto>
  return typeof candidate.count === 'number'
    && typeof candidate.revSum === 'number'
    && typeof candidate.maxUpdatedAt === 'number'
}

function isEntry(value: unknown): value is CachedCalendarRange {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CachedCalendarRange>
  return typeof candidate.from === 'number'
    && typeof candidate.to === 'number'
    && typeof candidate.savedAt === 'number'
    && Array.isArray(candidate.events)
    && Array.isArray(candidate.occurrences)
    && isRevision(candidate.revision)
}

/** Every usable range this account has on this browser, newest first. */
export function readRanges(userId: string, storage: Storage | null = readStorage()): CachedCalendarRange[] {
  if (!storage) return []
  let raw: string | null = null
  try {
    raw = storage.getItem(keyFor(userId))
  } catch {
    // A browser that refuses reads (private mode, a disabled store) simply has no cache.
    return []
  }
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Partial<CacheFile>
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return []
    return parsed.entries.filter(isEntry).sort((left, right) => right.savedAt - left.savedAt)
  } catch {
    // A truncated or hand-edited value is discarded rather than repaired; the fetch will refill it.
    clearRanges(userId, storage)
    return []
  }
}

/** The cached answer for exactly this range, or null. Ranges are the padded ones the surface asked for. */
export function rangeFor(
  userId: string,
  from: number,
  to: number,
  storage: Storage | null = readStorage(),
): CachedCalendarRange | null {
  return readRanges(userId, storage).find(entry => entry.from === from && entry.to === to) ?? null
}

/** How stale a painted snapshot may be before it is not worth showing. */
export const MAX_PAINT_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The entry to paint when the reader asks for this range.
 *
 * Ranges are computed from the current instant, so the same week asked for on two different visits is
 * never the *same* pair of milliseconds; the fingerprint comparison needs that exactness, but painting
 * does not. The entry with the largest overlap wins, and one that is too old is not painted at all —
 * a week-old calendar painted as today's would be worse than an empty grid.
 */
export function paintableRange(
  userId: string,
  from: number,
  to: number,
  storage: Storage | null = readStorage(),
  now: number = Date.now(),
): CachedCalendarRange | null {
  const fresh = readRanges(userId, storage).filter(entry => now - entry.savedAt <= MAX_PAINT_AGE_MS)
  let best: CachedCalendarRange | null = null
  let bestOverlap = 0
  for (const entry of fresh) {
    const overlap = Math.min(entry.to, to) - Math.max(entry.from, from)
    if (overlap > bestOverlap) {
      best = entry
      bestOverlap = overlap
    }
  }
  return best
}

/** Keep this answer, dropping the oldest and anything that would push the file past its ceiling. */
export function saveRange(
  userId: string,
  entry: CachedCalendarRange,
  storage: Storage | null = readStorage(),
): void {
  if (!storage) return
  const kept = readRanges(userId, storage).filter(existing => !(existing.from === entry.from && existing.to === entry.to))
  const entries = [entry, ...kept].slice(0, MAX_CACHED_RANGES)
  const serialized = JSON.stringify({ version: 1, entries } satisfies CacheFile)
  if (serialized.length > MAX_CACHE_BYTES) {
    // This one range is larger than the whole allowance: keep what was already there instead.
    return
  }
  try {
    storage.setItem(keyFor(userId), serialized)
  } catch {
    // Quota or a disabled store: the cache is an optimisation, and the next load refetches.
    clearRanges(userId, storage)
  }
}

export function clearRanges(userId: string, storage: Storage | null = readStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(keyFor(userId))
  } catch {
    // Nothing to do: an unremovable entry is overwritten by the next successful save.
  }
}

/** Whether two fingerprints describe the same rows; every field must match. */
export function sameRevision(left: CalendarRangeRevisionDto, right: CalendarRangeRevisionDto): boolean {
  return left.count === right.count
    && left.revSum === right.revSum
    && left.maxUpdatedAt === right.maxUpdatedAt
}
