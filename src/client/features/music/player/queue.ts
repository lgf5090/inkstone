/**
 * The queue's arithmetic: which track comes next, and what that does to the ordering.
 *
 * Everything here is pure. The player store owns the side effects — loading a URL, pausing an
 * element, persisting a snapshot — so the rules can be tested without a browser or an audio file.
 *
 * Shuffle keeps two lists. `tracks` is the order the player walks; `original` is the order the queue
 * was in before it was shuffled, which is what turning shuffle off restores. A queue that is not
 * shuffled has no `original`, and every list is then the play order itself.
 */
import { MUSIC_PLAY_MODES, type MusicPlayMode, type MusicTrack } from '@shared/music/model'

/** After this many failed loads in a row the player stops trying; otherwise a dead list loops forever. */
export const MAX_CONSECUTIVE_FAILURES = 5

/** A press of previous inside this window steps back; later it restarts the current track first. */
export const RESTART_THRESHOLD_MS = 3_000

export interface MusicQueue {
  /** The order the player walks, already shuffled when the mode says so. */
  tracks: MusicTrack[]
  /** Index into `tracks`; 0 when the queue is empty. */
  index: number
  mode: MusicPlayMode
  /** The pre-shuffle order, kept only while `mode` is `shuffle`. */
  original: MusicTrack[] | null
}

/** Why the queue is asked for its next track, which changes what single-track repeat means. */
export type QueueReason = 'user' | 'auto' | 'failure'

export type QueueStep =
  | { at: 'track'; queue: MusicQueue }
  /** Play the same track again from the start: single-track repeat, or a one-track queue wrapping. */
  | { at: 'restart'; queue: MusicQueue }
  | { at: 'end'; queue: MusicQueue }

export interface QueueRemoval {
  queue: MusicQueue
  found: boolean
  /** The removed track was the one playing, so the caller has to move the audio element too. */
  removedCurrent: boolean
}

export interface CreateQueueInput {
  tracks: readonly MusicTrack[]
  mode?: MusicPlayMode
  index?: number
  /** Preferred over `index`: a page knows the track it was asked to play, not its position. */
  trackId?: string
  random?: () => number
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.min(Math.max(0, Math.trunc(index)), length - 1)
}

function isPlayMode(value: unknown): value is MusicPlayMode {
  return typeof value === 'string' && (MUSIC_PLAY_MODES as readonly string[]).includes(value)
}

function uniqueTracks(tracks: readonly MusicTrack[]): MusicTrack[] {
  const seen = new Set<string>()
  const out: MusicTrack[] = []
  for (const track of tracks) {
    if (!track || typeof track.id !== 'string' || !track.id || seen.has(track.id)) continue
    seen.add(track.id)
    out.push(track)
  }
  return out
}

function withIndex(queue: MusicQueue, index: number): MusicQueue {
  return index === queue.index ? queue : { ...queue, index }
}

/**
 * Fisher-Yates with an injected source of randomness.
 *
 * `random` is expected to answer in [0, 1). A mock that answers exactly 1 is folded back to the last
 * slot instead of producing an out-of-range swap, because a test's fake should not need to know the
 * boundaries of the algorithm.
 */
function shuffleTracks(tracks: readonly MusicTrack[], random: () => number): MusicTrack[] {
  const out = [...tracks]
  for (let index = out.length - 1; index > 0; index--) {
    const value = random()
    const target = value >= 1 ? index : Math.max(0, Math.floor(value * (index + 1)))
    const current = out[index]!
    out[index] = out[target]!
    out[target] = current
  }
  return out
}

export function emptyQueue(mode: MusicPlayMode = 'order'): MusicQueue {
  return { tracks: [], index: 0, mode, original: null }
}

export function currentTrack(queue: MusicQueue): MusicTrack | null {
  return queue.tracks[queue.index] ?? null
}

/**
 * Build a queue in the requested mode.
 *
 * In shuffle the chosen track is kept as the current one: the rest of the list is shuffled around it
 * rather than the current track being pulled to the front, so opening a playlist at track 12 still
 * starts at track 12.
 */
export function createQueue(input: CreateQueueInput): MusicQueue {
  const mode = input.mode ?? 'order'
  const random = input.random ?? Math.random
  const tracks = uniqueTracks(input.tracks)
  if (tracks.length === 0) return emptyQueue(mode)
  const wanted = input.trackId ? tracks.findIndex((track) => track.id === input.trackId) : -1
  const index = clampIndex(wanted >= 0 ? wanted : input.index ?? 0, tracks.length)
  if (mode !== 'shuffle') return { tracks, index, mode, original: null }
  const current = tracks[index]
  const shuffled = shuffleTracks(tracks, random)
  const shuffledIndex = current ? shuffled.findIndex((track) => track.id === current.id) : 0
  return { tracks: shuffled, index: clampIndex(shuffledIndex, shuffled.length), mode, original: tracks }
}

/** Turn shuffle on or off, restoring the pre-shuffle order on the way out. */
export function setQueueMode(queue: MusicQueue, mode: MusicPlayMode, random: () => number = Math.random): MusicQueue {
  if (mode === queue.mode) return queue
  const playing = currentTrack(queue)
  if (queue.mode === 'shuffle') {
    const restored = queue.original ? [...queue.original] : [...queue.tracks]
    const index = playing ? restored.findIndex((track) => track.id === playing.id) : -1
    return { tracks: restored, index: clampIndex(index >= 0 ? index : queue.index, restored.length), mode, original: null }
  }
  if (mode === 'shuffle') {
    const original = [...queue.tracks]
    const shuffled = shuffleTracks(original, random)
    const index = playing ? shuffled.findIndex((track) => track.id === playing.id) : -1
    return { tracks: shuffled, index: clampIndex(index >= 0 ? index : queue.index, shuffled.length), mode, original }
  }
  return { ...queue, mode }
}

export function nextInQueue(queue: MusicQueue, reason: QueueReason): QueueStep {
  const length = queue.tracks.length
  if (length === 0) return { at: 'end', queue }
  const index = clampIndex(queue.index, length)
  const last = length - 1

  if (queue.mode === 'repeatOne' && reason === 'auto') return { at: 'restart', queue: withIndex(queue, index) }

  // Single-track repeat still moves when the reader presses next or the engine fails: a broken track
  // must not be retried as the same track forever.
  const wraps = queue.mode === 'repeat' || queue.mode === 'shuffle' || queue.mode === 'repeatOne'
  if (!wraps && index >= last) return { at: 'end', queue }

  const next = wraps ? (index + 1) % length : index + 1
  const nextQueue = withIndex(queue, next)
  return next === index ? { at: 'restart', queue: nextQueue } : { at: 'track', queue: nextQueue }
}

export function previousInQueue(queue: MusicQueue): QueueStep {
  const length = queue.tracks.length
  if (length === 0) return { at: 'end', queue }
  const index = clampIndex(queue.index, length)
  const wraps = queue.mode !== 'order' && queue.mode !== 'intelligence'
  if (!wraps && index <= 0) return { at: 'restart', queue: withIndex(queue, index) }
  const previous = wraps ? (index - 1 + length) % length : index - 1
  const previousQueue = withIndex(queue, previous)
  return previous === index ? { at: 'restart', queue: previousQueue } : { at: 'track', queue: previousQueue }
}

/** Put a track after the current one, moving it there if the queue already held it. */
function insertAfterCurrent(list: readonly MusicTrack[], currentId: string | null, track: MusicTrack): MusicTrack[] {
  const remaining = list.filter((entry) => entry.id !== track.id)
  const currentPosition = currentId ? remaining.findIndex((entry) => entry.id === currentId) : -1
  const insertAt = currentPosition >= 0 ? currentPosition + 1 : remaining.length
  return [...remaining.slice(0, insertAt), track, ...remaining.slice(insertAt)]
}

export function addNextTrack(queue: MusicQueue, track: MusicTrack): MusicQueue {
  const playing = currentTrack(queue)
  if (playing && playing.id === track.id) return queue
  if (queue.tracks.length === 0) {
    const only = [track]
    return { tracks: only, index: 0, mode: queue.mode, original: queue.mode === 'shuffle' ? [...only] : null }
  }
  const tracks = insertAfterCurrent(queue.tracks, playing?.id ?? null, track)
  const original = queue.original
    ? insertAfterCurrent(queue.original, playing?.id ?? null, track)
    : null
  const index = playing ? tracks.findIndex((entry) => entry.id === playing.id) : 0
  return { tracks, index: clampIndex(index, tracks.length), mode: queue.mode, original }
}

/**
 * Take a track out. Removing the current track leaves the queue pointing at what slid into its place
 * (the next track, or the previous one when the last was removed), and says so in `removedCurrent`.
 */
export function removeTrackFromQueue(queue: MusicQueue, trackId: string): QueueRemoval {
  const position = queue.tracks.findIndex((track) => track.id === trackId)
  if (position < 0) return { queue, found: false, removedCurrent: false }
  const playing = currentTrack(queue)
  const removedCurrent = playing?.id === trackId
  const tracks = queue.tracks.filter((track) => track.id !== trackId)
  const original = queue.original ? queue.original.filter((track) => track.id !== trackId) : null
  let index: number
  if (tracks.length === 0) index = 0
  else if (removedCurrent) index = clampIndex(position, tracks.length)
  else if (position < queue.index) index = queue.index - 1
  else index = queue.index
  return {
    queue: { tracks, index: clampIndex(index, tracks.length), mode: queue.mode, original },
    found: true,
    removedCurrent,
  }
}

export function failureLimitReached(failures: number): boolean {
  return failures >= MAX_CONSECUTIVE_FAILURES
}

function isTrackLike(value: unknown): value is MusicTrack {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<MusicTrack>
  return typeof candidate.id === 'string' && candidate.id.length > 0
    && typeof candidate.title === 'string'
    && typeof candidate.provider === 'string'
}

function readTrackList(value: unknown): MusicTrack[] {
  if (!Array.isArray(value)) return []
  return uniqueTracks(value.filter(isTrackLike))
}

/**
 * Read a persisted queue back, keeping only entries that still look like a track.
 *
 * A record written by a newer build, a hand-edited one, or one half-overwritten by a full quota is
 * not a reason to refuse to start: the readable tracks survive and everything else falls back to the
 * caller's mode. The stored order is already the play order, so shuffle is not applied a second time.
 */
export function restoreQueue(value: unknown, fallbackMode: MusicPlayMode = 'order'): MusicQueue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyQueue(fallbackMode)
  const record = value as Partial<MusicQueue>
  const tracks = readTrackList(record.tracks)
  const mode = isPlayMode(record.mode) ? record.mode : fallbackMode
  if (tracks.length === 0) return emptyQueue(mode)
  const index = clampIndex(typeof record.index === 'number' ? record.index : 0, tracks.length)
  const original = mode === 'shuffle' ? readTrackList(record.original) : []
  return {
    tracks,
    index,
    mode,
    original: mode === 'shuffle' ? (original.length ? original : [...tracks]) : null,
  }
}

/** Put a track at the end, keeping the queue as it was when the track is already present. */
export function appendTrack(queue: MusicQueue, track: MusicTrack): MusicQueue {
  if (queue.tracks.some((entry) => entry.id === track.id)) return queue
  const tracks = [...queue.tracks, track]
  const original = queue.original ? [...queue.original, track] : null
  return {
    tracks,
    index: queue.tracks.length === 0 ? 0 : clampIndex(queue.index, tracks.length),
    mode: queue.mode,
    original,
  }
}
