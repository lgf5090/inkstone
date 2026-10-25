/**
 * Fill duration, artwork and embedded lyrics on tracks imported from WebDAV or Alist.
 *
 * An import is a reference, not a copy, so the library row starts with only a filename. The browser
 * reads a bounded prefix of the reference's own stream, parses tags and posts the result back. The
 * audio itself never enters R2, and a file whose tags cannot be read still keeps a playable row.
 */
import type { MusicTrack } from '@shared/music/model'
import { ApiError } from '../../lib/api'
import { musicApi } from './api'
import { useMusicLibrary } from './store/library'
import { useMusicPlayer } from './store/player'

const attempted = new Set<string>()
const MAX_AUTO_TRACKS = 20
const MAX_PARALLEL = 2

export interface EnrichImportedOptions {
  /** Explicit imports finish their batch; a tab that merely opened repairs a bounded slice. */
  limit?: number
}

function imported(track: MusicTrack): boolean {
  return track.provider === 'webdav' || track.provider === 'alist'
}

function missing(track: MusicTrack): boolean {
  return imported(track) && (!track.durationMs || !track.coverKey)
}

async function enrichOne(track: MusicTrack): Promise<boolean> {
  const { parseRemoteTrackMetadata } = await import('./upload-metadata')
  const parsed = await parseRemoteTrackMetadata({
    id: track.id,
    title: track.title,
    format: track.format,
    size: track.size,
  })
  if (!parsed.ok) {
    console.warn('[inkstone] Imported music metadata could not be read:', parsed.error)
    return false
  }
  let answer
  try {
    answer = await musicApi.attachImportedMetadata(track.id, parsed.data)
  } catch (error) {
    // A malformed embedded image should not cost the row its duration and lyrics.
    if (!(error instanceof ApiError) || error.status !== 415 || !parsed.data.cover) throw error
    console.warn('[inkstone] Imported music cover was refused; saving the other tags:', error)
    answer = await musicApi.attachImportedMetadata(track.id, { ...parsed.data, cover: null })
  }
  // A restored or already-playing queue holds the old snapshot; refresh it so the bar and queue
  // show the duration and cover the row now has.
  useMusicPlayer.getState().updateTrackSnapshot(answer.track)
  return true
}

/** Returns how many rows gained metadata, so the caller can reload exactly when something changed. */
export async function enrichImportedTracks(
  tracks: readonly MusicTrack[],
  options: EnrichImportedOptions = {},
): Promise<number> {
  const pending = tracks
    .filter((track) => missing(track) && !attempted.has(track.id))
    .slice(0, options.limit ?? MAX_AUTO_TRACKS)
  if (pending.length === 0) return 0
  // Marked before the first request so two observers of the same list cannot parse the same file twice.
  for (const track of pending) attempted.add(track.id)

  let completed = 0
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const track = pending[cursor++]
      if (!track) return
      try {
        if (await enrichOne(track)) completed += 1
      } catch (error) {
        console.warn('[inkstone] Imported music metadata could not be saved:', error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, pending.length) }, worker))
  if (completed > 0) useMusicLibrary.getState().bumpTrackRevision()
  return completed
}
