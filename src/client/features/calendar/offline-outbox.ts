/**
 * Writes made while the network was gone.
 *
 * The queue lives in localStorage so a reload does not lose the edit, keyed by account so one
 * profile cannot replay another's rows. Saves replay as an upsert because the first attempt may
 * have reached the server before the connection dropped; deletes keep the revision they read.
 */
import type { CalendarEventInput } from '@shared/calendar/model'
import { ApiError } from '../../lib/api'
import * as api from './api'

const PREFIX = 'inkstone:calendar:outbox:'
const MAX_ENTRIES = 200

export type OutboxEntry =
  | { kind: 'save'; eventId: string; input: CalendarEventInput; at: number }
  | { kind: 'delete'; eventId: string; rev: number; at: number }

function key(userId: string): string {
  return `${PREFIX}${userId}`
}

export function readOutbox(userId: string): OutboxEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is OutboxEntry => {
      if (!entry || typeof entry !== 'object') return false
      const record = entry as Record<string, unknown>
      return typeof record.eventId === 'string'
        && (record.kind === 'save' || record.kind === 'delete')
        && typeof record.at === 'number'
    })
  } catch {
    return []
  }
}

function writeOutbox(userId: string, entries: readonly OutboxEntry[]): void {
  try {
    localStorage.setItem(key(userId), JSON.stringify(entries.slice(-MAX_ENTRIES)))
  } catch {
    // A full quota means the edit cannot be kept across reloads; the session still holds it.
  }
}

/** One pending write per event: the newest intent replaces the older one. */
export function enqueueOutbox(userId: string, entry: OutboxEntry): void {
  const entries = readOutbox(userId).filter(item => item.eventId !== entry.eventId)
  entries.push(entry)
  writeOutbox(userId, entries)
}

export function removeOutbox(userId: string, eventId: string): void {
  writeOutbox(userId, readOutbox(userId).filter(entry => entry.eventId !== eventId))
}

export function clearOutbox(userId: string): void {
  try {
    localStorage.removeItem(key(userId))
  } catch {
    // Clearing is best-effort; a leftover queue replays as upserts on the next visit.
  }
}

export interface FlushResult {
  flushed: number
  pending: number
  /** Stops at the first failure; only a transport failure leaves the rest queued. */
  stopped: boolean
}

export async function flushOutbox(userId: string): Promise<FlushResult> {
  const entries = readOutbox(userId)
  let flushed = 0
  for (const entry of entries) {
    try {
      if (entry.kind === 'save') await api.createEvents([entry.input], 'upsert')
      else await api.deleteEvent(entry.eventId, entry.rev)
      removeOutbox(userId, entry.eventId)
      flushed++
    } catch (error) {
      if (error instanceof ApiError && (error.isOffline || error.status >= 500)) {
        return { flushed, pending: readOutbox(userId).length, stopped: true }
      }
      // A refusal this entry can never pass (gone, forbidden, stale) is dropped rather than
      // replayed forever; the range reload shows the server's version.
      removeOutbox(userId, entry.eventId)
    }
  }
  return { flushed, pending: readOutbox(userId).length, stopped: false }
}
