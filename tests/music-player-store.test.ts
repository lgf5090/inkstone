// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicTrack } from '../src/shared/music/model'

const engineMock = vi.hoisted(() => ({
  play: vi.fn(),
  pause: vi.fn(),
  stop: vi.fn(),
  seek: vi.fn(),
  setVolume: vi.fn(),
  setMuted: vi.fn(),
  setRate: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  currentTimeMs: vi.fn(() => 0),
  durationMs: vi.fn(() => 0),
  hasSource: vi.fn(() => false),
}))

vi.mock('../src/client/features/music/player/engine', () => {
  class MusicPlaybackError extends Error {
    readonly code: number | null
    constructor(message: string, code: number | null = null) {
      super(message)
      this.name = 'MusicPlaybackError'
      this.code = code
    }
  }
  class MusicAutoplayBlockedError extends MusicPlaybackError {
    constructor(message = 'Autoplay was refused') {
      super(message)
      this.name = 'MusicAutoplayBlockedError'
    }
  }
  class MusicUnavailableError extends MusicPlaybackError {
    constructor(message = 'No audio element') {
      super(message)
      this.name = 'MusicUnavailableError'
    }
  }
  return {
    musicAudioEngine: engineMock,
    MusicPlaybackError,
    MusicAutoplayBlockedError,
    MusicUnavailableError,
    isAutoplayBlockedError: (error: unknown) => error instanceof MusicAutoplayBlockedError,
    isAudioUnavailableError: (error: unknown) => error instanceof MusicUnavailableError,
  }
})

import { MusicAutoplayBlockedError } from '../src/client/features/music/player/engine'
import { emptyQueue, MAX_CONSECUTIVE_FAILURES } from '../src/client/features/music/player/queue'
import {
  MUSIC_PLAYER_ERROR_KEYS,
  useMusicPlayer,
} from '../src/client/features/music/store/player'
import { useMusicSettings } from '../src/client/features/music/store/settings'
import { MUSIC_LIBRARY_ERROR_KEYS, useMusicLibrary } from '../src/client/features/music/store/library'
import { useMusicUi } from '../src/client/features/music/store/ui'
import { musicPathFor, parseMusicAddress } from '../src/client/features/music/music-address'

function track(id: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id,
    provider: 'netease',
    providerId: id,
    kind: 'song',
    title: `Track ${id}`,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: 'Album',
    albumId: 'album',
    coverUrl: '',
    coverKey: '',
    durationMs: 180_000,
    format: 'mp3',
    bitrate: 320_000,
    size: 1_000,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: 'exhigh',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const tracks = [track('a'), track('b'), track('c')]
const settingsStorageKey = 'inkstone.music.settings'
const playerStorageKey = 'inkstone.music.player'
const searchStorageKey = 'inkstone.music.searchHistory'

function resetPlayer(): void {
  useMusicPlayer.setState({
    queue: emptyQueue('order'),
    status: 'idle',
    positionMs: 0,
    durationMs: 0,
    volume: 1,
    muted: false,
    rate: 1,
    error: null,
    errorDetail: null,
    consecutiveFailures: 0,
    awaitingGesture: false,
    sourceUrl: '',
  })
}

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

function failed(status: number, text: string): Response {
  return {
    ok: false,
    status,
    statusText: 'Server Error',
    json: async () => ({}),
    text: async () => text,
  } as Response
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  engineMock.play.mockReset()
  engineMock.play.mockResolvedValue(undefined)
  engineMock.pause.mockReset()
  engineMock.stop.mockReset()
  engineMock.seek.mockReset()
  engineMock.setVolume.mockReset()
  engineMock.setMuted.mockReset()
  engineMock.setRate.mockReset()
  useMusicSettings.getState().resetLocal()
  resetPlayer()
  useMusicLibrary.getState().reset()
  useMusicUi.setState({
    page: { kind: 'home' },
    queueOpen: false,
    lyricsOpen: false,
    searchHistory: [],
    quality: 'exhigh',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('music player store', () => {
  it('sets a queue and plays the chosen track through the streaming route', async () => {
    const selected = useMusicPlayer.getState().setQueue(tracks)
    expect(selected?.id).toBe('a')
    expect(useMusicPlayer.getState().queue.tracks.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(useMusicPlayer.getState().status).toBe('paused')

    const played = await useMusicPlayer.getState().playTrack(tracks[1]!)
    expect(played).toBe(true)
    expect(useMusicPlayer.getState().queue.index).toBe(1)
    expect(useMusicPlayer.getState().status).toBe('playing')
    expect(engineMock.play).toHaveBeenCalledTimes(1)
    expect(engineMock.play.mock.calls[0]?.[0]).toMatchObject({
      url: '/api/music/media/stream/b',
      autoplay: true,
      volume: 1,
      muted: false,
      rate: 1,
    })
  })

  it('walks the queue, stops at its end and loops when the mode says so', async () => {
    useMusicPlayer.getState().setQueue(tracks)
    await useMusicPlayer.getState().playTrack(tracks[0]!)

    expect(await useMusicPlayer.getState().next()).toBe(true)
    expect(useMusicPlayer.getState().queue.index).toBe(1)

    expect(await useMusicPlayer.getState().next()).toBe(true)
    expect(useMusicPlayer.getState().queue.index).toBe(2)

    // A press at the end of an order queue keeps the current track playing.
    expect(await useMusicPlayer.getState().next()).toBe(false)
    expect(useMusicPlayer.getState().status).toBe('playing')

    // A natural end stops instead, which is what the ended handler passes.
    expect(await useMusicPlayer.getState().next('ended')).toBe(false)
    expect(useMusicPlayer.getState().status).toBe('ended')

    useMusicPlayer.getState().setMode('repeat')
    expect(await useMusicPlayer.getState().next('ended')).toBe(true)
    expect(useMusicPlayer.getState().queue.index).toBe(0)
  })

  it('repeats one track on a natural end but moves on when the reader presses next', async () => {
    useMusicPlayer.getState().setQueue(tracks)
    await useMusicPlayer.getState().playTrack(tracks[0]!)
    useMusicPlayer.getState().setMode('repeatOne')

    expect(await useMusicPlayer.getState().next('ended')).toBe(true)
    expect(useMusicPlayer.getState().queue.index).toBe(0)
    expect(engineMock.play.mock.calls.at(-1)?.[0]).toMatchObject({
      url: '/api/music/media/stream/a',
      startAtMs: 0,
    })

    expect(await useMusicPlayer.getState().next()).toBe(true)
    expect(useMusicPlayer.getState().queue.index).toBe(1)
  })

  it('steps back, and restarts the current track when the position is past the threshold', async () => {
    useMusicPlayer.getState().setQueue(tracks)
    await useMusicPlayer.getState().playTrack(tracks[1]!)

    expect(await useMusicPlayer.getState().prev()).toBe(true)
    expect(useMusicPlayer.getState().queue.index).toBe(0)

    useMusicPlayer.setState({ positionMs: 5_000 })
    const calls = engineMock.play.mock.calls.length
    expect(await useMusicPlayer.getState().prev()).toBe(true)
    expect(engineMock.seek).toHaveBeenCalledWith(0)
    expect(engineMock.play).toHaveBeenCalledTimes(calls)
  })

  it('inserts after the current track and moves rather than duplicates an existing one', () => {
    useMusicPlayer.getState().setQueue(tracks)
    useMusicPlayer.getState().addNext(track('x'))
    expect(useMusicPlayer.getState().queue.tracks.map((entry) => entry.id)).toEqual(['a', 'x', 'b', 'c'])

    useMusicPlayer.getState().addNext(tracks[2]!)
    expect(useMusicPlayer.getState().queue.tracks.map((entry) => entry.id)).toEqual(['a', 'c', 'x', 'b'])
  })

  it('removes the current track and leaves the queue on the next one', async () => {
    useMusicPlayer.getState().setQueue(tracks)
    await useMusicPlayer.getState().playTrack(tracks[1]!)

    expect(await useMusicPlayer.getState().removeFromQueue('b')).toBe(true)
    expect(useMusicPlayer.getState().queue.tracks.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(useMusicPlayer.getState().queue.index).toBe(1)
    expect(useMusicPlayer.getState().status).toBe('playing')
    expect(engineMock.play.mock.calls.at(-1)?.[0]).toMatchObject({ url: '/api/music/media/stream/c' })

    expect(await useMusicPlayer.getState().removeFromQueue('c')).toBe(true)
    expect(await useMusicPlayer.getState().removeFromQueue('a')).toBe(false)
    expect(useMusicPlayer.getState().queue.tracks).toEqual([])
    expect(useMusicPlayer.getState().status).toBe('idle')
    expect(engineMock.stop).toHaveBeenCalled()
  })

  it('stops after the fifth consecutive load failure instead of skipping forever', async () => {
    const many = Array.from({ length: 10 }, (_, index) => track(`t${index}`))
    useMusicPlayer.getState().setQueue(many)
    engineMock.play.mockRejectedValue(new Error('stream unavailable'))

    const played = await useMusicPlayer.getState().playTrack(many[0]!)

    expect(played).toBe(false)
    expect(engineMock.play).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES)
    expect(useMusicPlayer.getState().consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES)
    expect(useMusicPlayer.getState().queue.index).toBe(MAX_CONSECUTIVE_FAILURES - 1)
    expect(useMusicPlayer.getState().status).toBe('error')
    expect(useMusicPlayer.getState().error).toBe(MUSIC_PLAYER_ERROR_KEYS.playback)
  })

  it('keeps a refused autoplay paused until a gesture instead of counting it as a bad track', async () => {
    useMusicPlayer.getState().setQueue(tracks)
    engineMock.play.mockRejectedValueOnce(new MusicAutoplayBlockedError())

    expect(await useMusicPlayer.getState().playTrack(tracks[0]!)).toBe(false)
    expect(useMusicPlayer.getState().status).toBe('paused')
    expect(useMusicPlayer.getState().awaitingGesture).toBe(true)
    expect(useMusicPlayer.getState().consecutiveFailures).toBe(0)
    expect(useMusicPlayer.getState().error).toBe(MUSIC_PLAYER_ERROR_KEYS.autoplay)

    engineMock.play.mockResolvedValueOnce(undefined)
    expect(await useMusicPlayer.getState().toggle()).toBe(true)
    expect(useMusicPlayer.getState().status).toBe('playing')
    expect(useMusicPlayer.getState().awaitingGesture).toBe(false)
  })

  it('restores a persisted queue paused, without pretending it is playing', () => {
    const snapshot = {
      version: 1,
      queue: {
        tracks: [tracks[0], tracks[1]],
        index: 1,
        mode: 'repeat',
        original: null,
      },
      positionMs: 5_000,
    }
    localStorage.setItem(playerStorageKey, JSON.stringify(snapshot))

    expect(useMusicPlayer.getState().restore()).toBe(true)
    const state = useMusicPlayer.getState()
    expect(state.queue.tracks.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(state.queue.index).toBe(1)
    expect(state.queue.mode).toBe('repeat')
    expect(state.status).toBe('paused')
    expect(state.awaitingGesture).toBe(true)
    expect(state.positionMs).toBe(5_000)
    expect(engineMock.play).not.toHaveBeenCalled()
    expect(useMusicSettings.getState().local.mode).toBe('repeat')
  })
})

describe('music settings store', () => {
  it('persists player preferences and delegates them to the engine', () => {
    useMusicPlayer.getState().setVolume(0.35)
    expect(useMusicSettings.getState().local.volume).toBe(0.35)
    expect(engineMock.setVolume).toHaveBeenLastCalledWith(0.35)

    useMusicPlayer.getState().setRate(2.5)
    expect(useMusicSettings.getState().local.rate).toBe(2.5)
    expect(engineMock.setRate).toHaveBeenLastCalledWith(2.5)

    useMusicPlayer.getState().toggleMute()
    expect(useMusicSettings.getState().local.muted).toBe(true)
    expect(engineMock.setMuted).toHaveBeenLastCalledWith(true)

    useMusicPlayer.getState().setVolume(0.6)
    expect(useMusicSettings.getState().local.muted).toBe(false)
    expect(engineMock.setMuted).toHaveBeenLastCalledWith(false)

    const stored = JSON.parse(localStorage.getItem(settingsStorageKey) ?? '{}') as {
      volume?: number
      rate?: number
      muted?: boolean
    }
    expect(stored).toMatchObject({ volume: 0.6, rate: 2.5, muted: false })
  })

  it('clamps hand-edited values on the way back from storage', () => {
    useMusicSettings.getState().setVolume(2)
    expect(useMusicSettings.getState().local.volume).toBe(1)
    useMusicSettings.getState().setRate(99)
    expect(useMusicSettings.getState().local.rate).toBe(3)
  })
})

describe('music ui store', () => {
  it('keeps the last fifty distinct search terms, newest first', () => {
    const ui = useMusicUi.getState()
    ui.clearSearchHistory()
    for (let index = 0; index < 55; index++) useMusicUi.getState().pushSearchHistory(`term ${index}`)

    expect(useMusicUi.getState().searchHistory).toHaveLength(50)
    expect(useMusicUi.getState().searchHistory[0]).toBe('term 54')

    useMusicUi.getState().pushSearchHistory('term 10')
    expect(useMusicUi.getState().searchHistory[0]).toBe('term 10')
    expect(useMusicUi.getState().searchHistory.filter((entry) => entry === 'term 10')).toHaveLength(1)

    const stored = JSON.parse(localStorage.getItem(searchStorageKey) ?? '[]') as string[]
    expect(stored).toHaveLength(50)
    expect(stored[0]).toBe('term 10')
  })

  it('keeps the queue drawer and lyrics layer from being open together', () => {
    useMusicUi.getState().setQueueOpen(true)
    expect(useMusicUi.getState().queueOpen).toBe(true)
    useMusicUi.getState().setLyricsOpen(true)
    expect(useMusicUi.getState().lyricsOpen).toBe(true)
    expect(useMusicUi.getState().queueOpen).toBe(false)

    useMusicUi.getState().setQueueOpen(true)
    expect(useMusicUi.getState().lyricsOpen).toBe(false)
  })
})

describe('music address', () => {
  it('reads the screens under /music and round-trips them back to an address', () => {
    expect(parseMusicAddress('/music')).toEqual({ kind: 'home' })
    expect(parseMusicAddress('/music/')).toEqual({ kind: 'home' })
    expect(parseMusicAddress('/music/search', '?q=rain')).toEqual({ kind: 'search', query: 'rain' })
    expect(parseMusicAddress('/music/playlist/42')).toEqual({ kind: 'playlist', id: '42' })
    expect(parseMusicAddress('/music/album/7')).toEqual({ kind: 'album', id: '7' })
    expect(parseMusicAddress('/music/artist/9')).toEqual({ kind: 'artist', id: '9' })
    expect(parseMusicAddress('/music/toplist/3')).toEqual({ kind: 'toplist', id: '3' })
    expect(parseMusicAddress('/music/mv')).toEqual({ kind: 'mv' })
    expect(parseMusicAddress('/music/mv/8')).toEqual({ kind: 'mvDetail', id: '8' })
    expect(parseMusicAddress('/music/podcast')).toEqual({ kind: 'podcast' })
    expect(parseMusicAddress('/music/podcast/5')).toEqual({ kind: 'podcastDetail', id: '5' })
    expect(parseMusicAddress('/music/favorites')).toEqual({ kind: 'favorites' })
    expect(parseMusicAddress('/music/history')).toEqual({ kind: 'history' })
    expect(parseMusicAddress('/music/heatmap')).toEqual({ kind: 'heatmap' })
    expect(parseMusicAddress('/music/user')).toEqual({ kind: 'me' })
    expect(parseMusicAddress('/music/user/77')).toEqual({ kind: 'user', id: '77' })
    expect(parseMusicAddress('/music/settings')).toEqual({ kind: 'settings' })

    const page = { kind: 'playlist', id: 'a b' } as const
    expect(musicPathFor(page)).toBe('/music/playlist/a%20b')
    expect(parseMusicAddress(musicPathFor(page))).toEqual(page)

    expect(parseMusicAddress('/music/playlist').kind).toBe('notFound')
    expect(parseMusicAddress('/music/nope').kind).toBe('notFound')
    expect(parseMusicAddress('/other').kind).toBe('notFound')
  })
})

describe('music library store', () => {
  it('updates a favourite optimistically and keeps it after the server accepts it', async () => {
    const fetchMock = vi.fn(async () => ok({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    useMusicLibrary.setState({ favorites: [tracks[0]!] })

    const result = await useMusicLibrary.getState().toggleFavorite(tracks[1]!)

    expect(result).toBe(true)
    expect(useMusicLibrary.getState().favorites.map((entry) => entry.id)).toEqual(['b', 'a'])
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/music/library/favorites',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rolls a refused favourite back and reports it', async () => {
    const fetchMock = vi.fn(async () => failed(500, 'cannot store'))
    vi.stubGlobal('fetch', fetchMock)
    useMusicLibrary.setState({ favorites: [tracks[0]!] })

    const result = await useMusicLibrary.getState().toggleFavorite(tracks[1]!)

    expect(result).toBe(false)
    expect(useMusicLibrary.getState().favorites.map((entry) => entry.id)).toEqual(['a'])
    expect(useMusicLibrary.getState().error).toBe(MUSIC_LIBRARY_ERROR_KEYS.favorite)
  })

  it('saves a track before queueing its download by library id', async () => {
    const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path === '/api/music/library/tracks') {
        return ok({ tracks: [{ ...tracks[0]!, id: 'library-1' }] })
      }
      if (path === '/api/music/downloads') {
        return ok({
          download: {
            id: 'download-1',
            trackId: 'library-1',
            quality: 'exhigh',
            format: 'auto',
            status: 'queued',
            progress: 0,
            size: null,
            r2Key: null,
            error: '',
            attempts: 0,
            createdAt: 1,
            updatedAt: 1,
            completedAt: null,
          },
        })
      }
      return failed(500, 'unexpected request')
    })
    vi.stubGlobal('fetch', fetchMock)

    await useMusicLibrary.getState().requestDownload(tracks[0]!, 'exhigh', 'auto')

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/music/library/tracks',
      '/api/music/downloads',
    ])
    const downloadBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body))
    expect(downloadBody).toMatchObject({ trackId: 'library-1', quality: 'exhigh', format: 'auto' })
    expect(useMusicLibrary.getState().downloads[0]).toMatchObject({ id: 'download-1', track: { id: 'library-1' } })
  })

  it('writes a play once per track inside the debounce window', async () => {    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => ok({
      ok: true,
      entry: {
        id: 'history-1',
        trackId: 'library-track-1',
        playedAt: Date.now(),
        durationPlayed: 0,
        completed: false,
        contextType: '',
        contextId: '',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await useMusicLibrary.getState().recordHistory({ track: tracks[0]! })
    await useMusicLibrary.getState().recordHistory({ track: tracks[0]! })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(useMusicLibrary.getState().history).toHaveLength(1)
    expect(useMusicLibrary.getState().history[0]?.trackId).toBe('library-track-1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/music/library/history',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body))
    expect(body.track.id).toBe(tracks[0]!.id)
  })

  it('loads every collection and leaves the library ready', async () => {
    const fetchMock = vi.fn(async (path: string) => ok(
      path === '/api/music/downloads' ? { items: [] } : { items: [] },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await useMusicLibrary.getState().load()

    expect(useMusicLibrary.getState().status).toBe('ready')
    expect(useMusicLibrary.getState().loadedAt).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual(expect.arrayContaining([
      '/api/music/library/favorites',
      '/api/music/library/history',
      '/api/music/library/recent',
      '/api/music/library/playlists',
      '/api/music/downloads',
      '/api/music/uploads',
    ]))
  })
})
