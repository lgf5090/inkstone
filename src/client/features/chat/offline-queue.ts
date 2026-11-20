/**
 * The small queue of text a reader typed while this tab had no connection.
 *
 * This is deliberately only a *draft shelf*, not an offline chat engine: there is no local model, no
 * queued request body and no automatic send. The composer owns the text while it is being written; the
 * input side hands a plain draft string to the capture event, this module keeps it across a reload, and
 * {@link readOfflineQueue} gives it back to the page when the network returns so it can be dropped into
 * the input box again. Nothing here knows what a provider, a key or a request looks like.
 */
const STORAGE_KEY = 'inkstone.chat.offline-queue.v1'

/** At most this many drafts are kept; beyond it the oldest is the least likely to still be meant. */
export const OFFLINE_QUEUE_LIMIT = 20

/** Mirrors the composer's own maxLength, so a draft can never outgrow what the box accepts. */
const MAX_TEXT_CHARS = 16_000

/** An input surface dispatches this on `window` with `{ detail: { text } }` to save a draft while offline. */
export const OFFLINE_CAPTURE_EVENT = 'inkstone:offline-capture'

/** The page dispatches this on `window` with `{ detail: { text } }` once a connection returns. */
export const OFFLINE_REPLAY_EVENT = 'inkstone:offline-replay'

/** A queue is plain strings only: never a request body, a provider or anything key-shaped. */
type Queue = string[]

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Storage can be denied outright (private mode, a blocked origin). The offline banner still has a
    // meaning without persistence; the draft just cannot survive a reload in that browser.
    return null
  }
}

function read(store: Storage | null): Queue {
  if (!store) return []
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, OFFLINE_QUEUE_LIMIT)
  } catch (error) {
    // A corrupt or hand-edited value must not break the composer; start the shelf empty this session.
    console.warn('[inkstone] offline queue could not be read', error)
    return []
  }
}

function write(store: Storage | null, queue: Queue): void {
  if (!store) return
  try {
    if (queue.length) store.setItem(STORAGE_KEY, JSON.stringify(queue))
    else store.removeItem(STORAGE_KEY)
  } catch (error) {
    // A full or unavailable store is best-effort: the in-memory size still describes this session, and
    // refusing to persist is not a reason to take the app down.
    console.warn('[inkstone] offline queue could not be persisted', error)
  }
}

export function offlineQueueSize(): number {
  return read(storage()).length
}

export function readOfflineQueue(): string[] {
  return read(storage())
}

export function clearOfflineQueue(): void {
  write(storage(), [])
}

/** Adds one draft, keeping the queue bounded, and answers with the new count for the offline banner. */
export function enqueueOfflineText(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return offlineQueueSize()
  const store = storage()
  const held = read(store)
  // Blur, hide and the browser's own offline event can all fire for the same draft; one draft is one
  // entry, or the replay would paste the same sentence back twice.
  if (held[held.length - 1] === trimmed.slice(0, MAX_TEXT_CHARS)) return held.length
  const next = [...held, trimmed.slice(0, MAX_TEXT_CHARS)]
  const bounded = next.slice(Math.max(0, next.length - OFFLINE_QUEUE_LIMIT))
  write(store, bounded)
  return bounded.length
}
