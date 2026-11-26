/**
 * Writes made while the network was gone.
 *
 * The queue lives in localStorage so a reload does not lose the edit, keyed by account so one
 * profile cannot replay another's rows. A save records the revision it edited: new rows are created,
 * existing rows are conditionally patched, and a stale replay is handed to conflict resolution.
 */
import type { CalendarEventInput } from '@shared/calendar/model'
import { ApiError } from '../../lib/api'
import * as api from './api'
import { toPersistedCalendarEvent } from './model'
import type { ConflictRequest } from './persistence'

const PREFIX = 'inkstone:calendar:outbox:'
const MAX_ENTRIES = 200

type SaveEntry = { kind: 'save'; eventId: string; input: CalendarEventInput; baseRev: number | null; at: number; legacy?: false }
type LegacySaveEntry = { kind: 'save'; eventId: string; input: CalendarEventInput; legacy: true; at: number }

export type OutboxEntry = SaveEntry | LegacySaveEntry
  | { kind: 'delete'; eventId: string; rev: number; at: number }

export type OutboxWrite = SaveEntry | Exclude<OutboxEntry, { kind: 'save' }>

function key(userId: string): string {
  return `${PREFIX}${userId}`
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.eventId !== 'string' || !entry.eventId || typeof entry.at !== 'number') return false
  if (entry.kind === 'save') {
    return Boolean(entry.input && typeof entry.input === 'object' && !Array.isArray(entry.input))
      && (entry.baseRev === null || isRevision(entry.baseRev))
  }
  return entry.kind === 'delete' && isRevision(entry.rev)
}

function isLegacySaveEntry(value: unknown): value is LegacySaveEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return entry.kind === 'save'
    && entry.baseRev === undefined
    && typeof entry.eventId === 'string'
    && Boolean(entry.eventId)
    && typeof entry.at === 'number'
    && Boolean(entry.input && typeof entry.input === 'object' && !Array.isArray(entry.input))
}

export function readOutbox(userId: string): OutboxEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    // Rows written before baseRev existed cannot be replayed safely: their baseline is unknown.
    // Keep them until the flush reports and discards them instead of silently erasing or overwriting.
    return parsed.flatMap(entry => isLegacySaveEntry(entry)
      ? [{ ...entry, legacy: true as const }]
      : isOutboxEntry(entry) ? [entry] : [])
  } catch {
    return []
  }
}

export function outboxEventIds(userId: string): Set<string> {
  return new Set(readOutbox(userId).map(entry => entry.eventId))
}

function writeOutbox(userId: string, entries: readonly OutboxEntry[]): void {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`The calendar offline queue is full (${MAX_ENTRIES} events).`)
  }
  try {
    localStorage.setItem(key(userId), JSON.stringify(entries))
  } catch (cause) {
    throw new Error('The calendar change could not be saved for offline sync.', { cause })
  }
}

/** Web Locks serialise tabs; the promise chain covers browsers and tests without that API. */
const localLocks = new Map<string, Promise<void>>()

async function withOutboxLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const lockName = key(userId)
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return await navigator.locks.request<Promise<T>>(lockName, task)
  }
  const previous = localLocks.get(lockName) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  localLocks.set(lockName, current)
  return previous.then(async () => {
    try {
      return await task()
    } finally {
      release()
      if (localLocks.get(lockName) === current) localLocks.delete(lockName)
    }
  })
}

/** One pending write per event: the newest intent replaces the older one. */
export async function enqueueOutbox(userId: string, entry: OutboxWrite): Promise<void> {
  await withOutboxLock(userId, async () => {
    const entries = readOutbox(userId).filter(item => item.eventId !== entry.eventId)
    entries.push(entry.kind === 'save'
      ? { ...entry, input: toPersistedCalendarEvent(entry.input) }
      : entry)
    writeOutbox(userId, entries)
  })
}

function removeOutboxUnlocked(userId: string, eventId: string): void {
  const current = readOutbox(userId)
  const entries = current.filter(entry => entry.eventId !== eventId)
  if (entries.length !== current.length) writeOutbox(userId, entries)
}

export async function removeOutbox(userId: string, eventId: string): Promise<void> {
  await withOutboxLock(userId, async () => {
    removeOutboxUnlocked(userId, eventId)
  })
}

export async function clearOutbox(userId: string): Promise<void> {
  await withOutboxLock(userId, async () => {
    try {
      localStorage.removeItem(key(userId))
    } catch (cause) {
      throw new Error('The calendar offline queue could not be cleared.', { cause })
    }
  })
}

export interface FlushResult {
  flushed: number
  pending: number
  /** Stops at the first transient failure or a conflict with no handler. */
  stopped: boolean
  /** Permanent refusals and non-API failures discarded; the caller must refresh and report them. */
  dropped: number
  /** Stale writes moved to the conflict dialog rather than replayed over the server. */
  conflicts: number
}

export interface FlushOutboxOptions {
  onConflict?: (request: ConflictRequest) => void | Promise<void>
}

export async function flushOutbox(userId: string, options: FlushOutboxOptions = {}): Promise<FlushResult> {
  return withOutboxLock(userId, async () => {
    const entries = readOutbox(userId)
    let flushed = 0
    let dropped = 0
    let conflicts = 0
    for (const entry of entries) {
      try {
        if (entry.kind === 'save' && entry.legacy) {
          removeOutboxUnlocked(userId, entry.eventId)
          dropped++
          continue
        }
        if (entry.kind === 'save') {
          if (entry.baseRev === null) await api.createEvents([entry.input], 'create')
          else await api.updateEvent(entry.eventId, entry.input, entry.baseRev)
        } else {
          await api.deleteEvent(entry.eventId, entry.rev)
        }
        removeOutboxUnlocked(userId, entry.eventId)
        flushed++
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          if (!options.onConflict) {
            return { flushed, pending: readOutbox(userId).length, stopped: true, dropped, conflicts }
          }
          // The in-memory conflict now owns this intent. Removing the stale queue row prevents a
          // later reconnect from overwriting the reader's merged decision with the old payload.
          removeOutboxUnlocked(userId, entry.eventId)
          conflicts++
          await options.onConflict({
            id: entry.eventId,
            intent: entry.kind,
            mine: entry.kind === 'save' ? entry.input : null,
          })
          continue
        }
        if (error instanceof ApiError && (error.isOffline || error.status >= 500)) {
          return { flushed, pending: readOutbox(userId).length, stopped: true, dropped, conflicts }
        }
        // A refusal this entry can never pass (gone, forbidden, invalid) is discarded rather than
        // replayed forever. The count makes the loss visible and asks the surface to reload.
        removeOutboxUnlocked(userId, entry.eventId)
        dropped++
      }
    }
    return { flushed, pending: readOutbox(userId).length, stopped: false, dropped, conflicts }
  })
}
