// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MUSIC_LIMITS } from '../src/shared/music/constants'
import type { MusicFavoriteTrack } from '../src/shared/music/model'
import {
  MUSIC_LIBRARY_ERROR_KEYS,
  useMusicLibrary,
} from '../src/client/features/music/store/library'

function favorite(index: number): MusicFavoriteTrack {
  return {
    id: `track-${index}`,
    provider: 'netease',
    providerId: String(index),
    kind: 'song',
    title: `Song ${index}`,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: 'Album',
    albumId: 'album',
    coverUrl: '',
    coverKey: '',
    durationMs: 1_000,
    format: 'mp3',
    bitrate: null,
    size: null,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: '',
    createdAt: 0,
    updatedAt: 0,
    pinnedAt: null,
  }
}

function answer(items: unknown[], total = items.length): Response {
  return Response.json({ items, total })
}

const empty = (): Response => Response.json({ items: [] })

beforeEach(() => {
  useMusicLibrary.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('music library favourites sync', () => {
  it('loads every page up to the sync ceiling and reports a short list honestly', async () => {
    const all = Array.from({ length: MUSIC_LIMITS.favoriteSyncLimit + 50 }, (_, index) => favorite(index))
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = String(input)
      if (url.startsWith('/api/music/library/favorites?')) {
        const parsed = new URL(url, 'http://localhost')
        const page = Number(parsed.searchParams.get('page') ?? '1')
        const limit = Number(parsed.searchParams.get('limit') ?? '100')
        const offset = (page - 1) * limit
        return answer(all.slice(offset, offset + limit), all.length)
      }
      if (url === '/api/music/downloads') return Response.json({ items: [] })
      return empty()
    })

    await useMusicLibrary.getState().load()
    let state = useMusicLibrary.getState()
    expect(state.favorites).toHaveLength(MUSIC_LIMITS.libraryPageSize * 2)
    expect(state.favoritesTotal).toBe(all.length)
    expect(state.favoritesComplete).toBe(false)

    await state.loadAllFavorites()
    state = useMusicLibrary.getState()
    expect(state.favorites).toHaveLength(MUSIC_LIMITS.favoriteSyncLimit)
    expect(state.favoritesComplete).toBe(false)
    expect(state.favorites[0]?.id).toBe('track-0')
  })

  it('keeps the shelves that answered and names the partial failure', async () => {
    const all = Array.from({ length: 3 }, (_, index) => favorite(index))
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = String(input)
      if (url.startsWith('/api/music/library/favorites')) return answer(all)
      if (url === '/api/music/library/playlists') return new Response('server exploded', { status: 500 })
      if (url === '/api/music/downloads') return Response.json({ items: [] })
      return empty()
    })

    await useMusicLibrary.getState().load()
    const state = useMusicLibrary.getState()
    expect(state.status).toBe('ready')
    expect(state.favorites).toHaveLength(3)
    expect(state.error).toBe(MUSIC_LIBRARY_ERROR_KEYS.partial)
    expect(state.errorDetail).toContain('server exploded')
  })
})
