/** Import a Netease playlist into the local library through the public playlist endpoints. */
import type { MusicPlaylist, MusicTrack } from '@shared/music/model'
import { musicApi } from './api'

const IMPORT_PAGE_SIZE = 100
const IMPORT_MAX_PAGES = 10

export class PlaylistImportError extends Error {
  constructor(readonly reason: 'invalid' | 'empty') {
    super(reason)
  }
}

export interface PlaylistImportResult {
  playlist: MusicPlaylist
  imported: number
  truncated: boolean
}

/** A share link, a playlist URL or a bare id; only the digits become the provider id. */
export function parseNeteasePlaylistId(input: string): string | null {
  const value = input.trim()
  if (/^\d{3,20}$/.test(value)) return value
  const match = value.match(/[?&#](?:id|playlistId)=(\d{3,20})/i)
    ?? value.match(/\/playlist\/(\d{3,20})/i)
  return match?.[1] ?? null
}

export async function importNeteasePlaylist(
  input: string,
  fallbackName: string,
): Promise<PlaylistImportResult> {
  const id = parseNeteasePlaylistId(input)
  if (!id) throw new PlaylistImportError('invalid')

  const first = await musicApi.playlist(id, 'netease', 1, IMPORT_PAGE_SIZE)
  if (first.tracks.length === 0) throw new PlaylistImportError('empty')

  const playlist = await musicApi.createPlaylist(first.playlist.name.trim() || fallbackName)
  const seen = new Set<string>()
  let imported = 0
  let truncated = false
  try {
    let page = 1
    let detail = first
    while (true) {
      const fresh: MusicTrack[] = []
      for (const track of detail.tracks) {
        if (!track.id || seen.has(track.id)) continue
        seen.add(track.id)
        fresh.push(track)
      }
      if (fresh.length > 0) {
        await musicApi.addPlaylistItems(playlist.id, fresh)
        imported += fresh.length
      }
      if (!detail.hasMore) break
      if (page >= IMPORT_MAX_PAGES) {
        truncated = true
        break
      }
      page += 1
      detail = await musicApi.playlist(id, 'netease', page, IMPORT_PAGE_SIZE)
    }
  } catch (error) {
    // A half-imported playlist is worse than none: remove the shell this call created. If cleanup
    // itself fails the original error still names the failure the reader can act on.
    try {
      await musicApi.deletePlaylist(playlist.id)
    } catch {
      // Best-effort rollback; the server may already have removed it or be unreachable.
    }
    throw error
  }

  return { playlist, imported, truncated }
}
