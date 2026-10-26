/**
 * What the last visit left, so the calendar opens on the reader's own month instead of a skeleton.
 *
 * The app shell gates the calendar on a first read of its calendars and its range, which is one round
 * trip of empty grid on every visit. Remembering the metadata half — small, and exactly what the shell
 * refuses to render without — together with the range snapshot the surface already keeps, lets the
 * first frame be the real thing; the read that follows is a revalidation and replaces it.
 *
 * Only the account's own metadata is stored, under its own key, and a value that cannot be read is
 * discarded rather than repaired: a missing entry costs one skeleton, a wrong one would cost trust.
 */
import type { CalendarMetaDto } from '@shared/calendar/model'

const STORAGE_KEY = 'inkstone.calendar.first-paint.v1'
const MAX_BYTES = 256 * 1024

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function keyFor(userId: string): string {
  return `${STORAGE_KEY}:${userId}`
}

/** The calendars and preferences the last visit showed, or null. */
export function readFirstPaintMeta(userId: string, storage: Storage | null = readStorage()): CalendarMetaDto | null {
  if (!storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(keyFor(userId))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { version?: number; meta?: CalendarMetaDto }
    if (parsed.version !== 1 || !parsed.meta || !Array.isArray(parsed.meta.calendars)) return null
    return parsed.meta
  } catch {
    // Truncated or hand-edited: drop it rather than guess what the reader's calendars are.
    saveFirstPaintMeta(userId, null, storage)
    return null
  }
}

export function saveFirstPaintMeta(
  userId: string,
  meta: CalendarMetaDto | null,
  storage: Storage | null = readStorage(),
): void {
  if (!storage) return
  try {
    if (!meta) {
      storage.removeItem(keyFor(userId))
      return
    }
    const serialized = JSON.stringify({ version: 1, meta })
    if (serialized.length > MAX_BYTES) {
      storage.removeItem(keyFor(userId))
      return
    }
    storage.setItem(keyFor(userId), serialized)
  } catch {
    // Quota or a disabled store: the shell falls back to its skeleton, which is the old behaviour.
  }
}
