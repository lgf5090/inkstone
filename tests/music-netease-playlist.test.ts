// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NeteaseProvider } from '../src/worker/music/providers/netease/client'

const SONG = (id: number) => ({
  id,
  name: `Song ${id}`,
  dt: 1_000,
  ar: [{ id: 'artist', name: 'Artist' }],
  al: { id: 'album', name: 'Album' },
})

describe('netease playlist paging', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('slices the track-id list and fetches only the songs on this page', async () => {
    const calls: Array<{ url: string; body: string }> = []
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, body: String(init.body ?? '') })
      if (url.includes('/eapi/v6/playlist/detail')) {
        return Response.json({
          code: 200,
          playlist: {
            id: 9,
            name: 'List',
            trackCount: 5,
            trackIds: [1, 2, 3, 4, 5].map((id) => ({ id })),
            tracks: [SONG(1)],
          },
        })
      }
      if (url.includes('/weapi/v3/song/detail')) {
        return Response.json({ code: 200, songs: [SONG(3), SONG(4)] })
      }
      return Response.json({ code: 404 })
    })

    const provider = new NeteaseProvider({ retries: 0 })
    const page = await provider.playlist('9', { offset: 2, limit: 2 })

    expect(page.tracks.map((track) => track.providerId)).toEqual(['3', '4'])
    expect(page.total).toBe(5)
    expect(page.hasMore).toBe(true)
    expect(calls.filter((call) => call.url.includes('/eapi/v6/playlist/detail'))).toHaveLength(1)
    expect(calls.filter((call) => call.url.includes('/weapi/v3/song/detail'))).toHaveLength(1)
  })

  it('falls back to one bounded snapshot request when the detail has no track-id list', async () => {
    const calls: Array<{ url: string; body: string }> = []
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, body: String(init.body ?? '') })
      if (url.includes('/eapi/v6/playlist/detail')) {
        return Response.json({
          code: 200,
          playlist: {
            id: 9,
            name: 'Old shape',
            trackCount: 3,
            tracks: [SONG(1), SONG(2), SONG(3)],
          },
        })
      }
      return Response.json({ code: 404 })
    })

    const provider = new NeteaseProvider({ retries: 0 })
    const page = await provider.playlist('9', { offset: 1, limit: 2 })

    expect(page.tracks.map((track) => track.providerId)).toEqual(['2', '3'])
    expect(calls.filter((call) => call.url.includes('/eapi/v6/playlist/detail'))).toHaveLength(2)
  })
})
