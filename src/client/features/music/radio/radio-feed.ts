/**
 * The FM feed and the queue it grows.
 *
 * The server decides what the station suggests; this module decides which of those rows are usable,
 * how a batch joins the queue without repeating a track, and where the growth stops. Everything but
 * the two request wrappers is pure, so the rules can be tested without a network or an audio element.
 */
import { MUSIC_FM_MODES, type MusicFmMode, type MusicTrack } from '@shared/music/model'
import { musicApi } from '../api'
import type { MusicQueue } from '../player/queue'

/** A session may keep growing, but not without bound: the feed holds at most this many rows. */
export const RADIO_FEED_LIMIT = 200

/** A station is either one of the provider's FM modes or the track-seeded heart mode. */
export type MusicRadioMode = MusicFmMode | 'heart'

export interface MusicRadioState {
  /** The station label as the reader chose it, kept so a restored session names the same station. */
  name: string
  mode: MusicRadioMode
  /** The track heart mode started from; later batches keep returning to that neighbourhood. */
  seedProviderId?: string
}

/** The two requests the feed needs, injected so a test can answer without the network. */
export interface RadioFeedApi {
  fm: (mode: MusicFmMode) => Promise<{ tracks: MusicTrack[] }>
  heart: (providerId: string, startProviderId?: string) => Promise<{ tracks: MusicTrack[] }>
}

export function isMusicFmMode(value: unknown): value is MusicFmMode {
  return typeof value === 'string' && (MUSIC_FM_MODES as readonly string[]).includes(value)
}

export function isRadioMode(value: unknown): value is MusicRadioMode {
  return value === 'heart' || isMusicFmMode(value)
}

/**
 * Read a persisted station back. A hand-edited or newer record with an unknown mode is dropped
 * rather than half-restored, because a station that cannot name its own feed cannot be continued.
 */
export function sanitizeRadio(value: unknown): MusicRadioState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<MusicRadioState>
  if (!isRadioMode(record.mode)) return null
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name) return null
  const seed = typeof record.seedProviderId === 'string' ? record.seedProviderId.trim() : ''
  return { name, mode: record.mode, ...(seed ? { seedProviderId: seed } : {}) }
}

/**
 * Keep only rows a player can address: an id to queue, a provider id to stream, a title to show.
 * The provider occasionally answers with a placeholder without an id; skipping it is cheaper than
 * starting a load that can only fail.
 */
export function playableFilter(tracks: readonly MusicTrack[]): MusicTrack[] {
  const seen = new Set<string>()
  const playable: MusicTrack[] = []
  for (const track of tracks) {
    if (!track || typeof track.id !== 'string' || !track.id) continue
    if (typeof track.provider !== 'string' || !track.provider) continue
    if (typeof track.providerId !== 'string' || !track.providerId) continue
    if (typeof track.title !== 'string' || !track.title) continue
    if (seen.has(track.id)) continue
    seen.add(track.id)
    playable.push(track)
  }
  return playable
}

function trimQueue(tracks: MusicTrack[], index: number, limit: number): { tracks: MusicTrack[]; index: number } {
  let drop = tracks.length - limit
  if (drop <= 0) return { tracks, index }
  let trimmed = tracks
  let nextIndex = index
  // History before the current track goes first; the track that is playing must stay addressable.
  if (nextIndex > 0) {
    const fromFront = Math.min(drop, nextIndex)
    trimmed = trimmed.slice(fromFront)
    nextIndex -= fromFront
    drop -= fromFront
  }
  if (drop > 0) {
    // The current track sits at the front: drop the oldest upcoming rows and keep the newest ones.
    const keepAfter = Math.max(0, trimmed.length - 1 - drop)
    trimmed = [trimmed[0]!, ...trimmed.slice(trimmed.length - keepAfter)]
  }
  return { tracks: trimmed, index: Math.min(nextIndex, trimmed.length - 1) }
}

/**
 * Append a feed batch: unknown rows join, repeats are ignored, and the queue stops at the feed cap.
 * Returns the same queue when the batch adds nothing, so the caller can treat that as a failed beat
 * instead of believing the station grew.
 */
export function appendRadioTracks(
  queue: MusicQueue,
  incoming: readonly MusicTrack[],
  limit: number = RADIO_FEED_LIMIT,
): MusicQueue {
  const known = new Set(queue.tracks.map((track) => track.id))
  const fresh = playableFilter(incoming).filter((track) => !known.has(track.id))
  if (fresh.length === 0) return queue
  const trimmed = trimQueue([...queue.tracks, ...fresh], queue.index, limit)
  let original = queue.original
  if (original) {
    const originalIds = new Set(original.map((track) => track.id))
    const additions = fresh.filter((track) => !originalIds.has(track.id))
    original = additions.length > 0 ? [...original, ...additions].slice(-limit) : original
  }
  return { ...queue, tracks: trimmed.tracks, index: trimmed.index, original }
}

/** One FM batch, in the requested mode. */
export async function nextFmTracks(
  mode: MusicFmMode,
  api: RadioFeedApi = musicApi,
): Promise<MusicTrack[]> {
  const answer = await api.fm(mode)
  return playableFilter(answer.tracks)
}

/**
 * One heart-mode batch. `providerId` is the track currently playing, so the station moves forward;
 * `startProviderId` is the track the session started from and keeps the recommendations anchored.
 */
export async function nextHeartTracks(
  providerId: string,
  startProviderId: string = providerId,
  api: RadioFeedApi = musicApi,
): Promise<MusicTrack[]> {
  if (!providerId) return []
  const answer = await api.heart(providerId, startProviderId)
  return playableFilter(answer.tracks)
}
