// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicTrack } from '../src/shared/music/model'

const apiMock = vi.hoisted(() => ({
  fm: vi.fn(),
  heart: vi.fn(),
  fmTrash: vi.fn(),
}))
vi.mock('../src/client/features/music/api', () => ({ musicApi: apiMock }))

const engineMock = vi.hoisted(() => ({
  play: vi.fn(async () => undefined),
  pause: vi.fn(),
  stop: vi.fn(),
  seek: vi.fn(),
  setVolume: vi.fn(),
  setMuted: vi.fn(),
  setRate: vi.fn(),
  setNormalizationGain: vi.fn(),
  enableEqualizer: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  currentTimeMs: vi.fn(() => 0),
  durationMs: vi.fn(() => 0),
  hasSource: vi.fn(() => false),
}))
vi.mock('../src/client/features/music/player/engine', () => {
  class MusicPlaybackError extends Error { constructor(message: string, readonly code: number | null = null) { super(message) } }
  class MusicAutoplayBlockedError extends MusicPlaybackError {}
  class MusicUnavailableError extends MusicPlaybackError {}
  return {
    musicAudioEngine: engineMock,
    MusicPlaybackError,
    MusicAutoplayBlockedError,
    MusicUnavailableError,
    isAutoplayBlockedError: (error: unknown) => error instanceof MusicAutoplayBlockedError,
    isAudioUnavailableError: (error: unknown) => error instanceof MusicUnavailableError,
  }
})

import { emptyQueue } from '../src/client/features/music/player/queue'
import { useMusicPlayer } from '../src/client/features/music/store/player'

function track(id: string): MusicTrack {
  return {
    id, provider: 'netease', providerId: id, kind: 'song', title: `Track ${id}`,
    artists: [{ id: 'a', name: 'Artist' }], album: 'Album', albumId: 'album',
    coverUrl: '', coverKey: '', durationMs: 180_000, format: 'mp3', bitrate: null,
    size: null, sha256: '', r2Key: null, source: 'netease', sourceQuality: 'exhigh',
    createdAt: 0, updatedAt: 1,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useMusicPlayer.setState({
    queue: { ...emptyQueue('order'), tracks: [track('seed')], index: 0 },
    status: 'paused', positionMs: 0, durationMs: 180_000, volume: 1, muted: false, rate: 1,
    error: null, errorDetail: null, consecutiveFailures: 0, awaitingGesture: false,
    preview: false, radio: null, radioLoading: false, radioFailures: 0, sourceUrl: '',
  })
  apiMock.fm.mockResolvedValue({ tracks: [track('fm-1'), track('fm-2')] })
  apiMock.heart.mockResolvedValue({ tracks: [track('heart-1')] })
  apiMock.fmTrash.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the player radio actions', () => {
  it('starts an FM station and keeps it attached to the queue', async () => {
    const started = await useMusicPlayer.getState().startRadio('Private FM', 'FAMILIAR')
    expect(started).toBe(true)
    expect(apiMock.fm).toHaveBeenCalledWith('FAMILIAR')
    expect(useMusicPlayer.getState().radio).toMatchObject({ mode: 'FAMILIAR', name: 'Private FM' })
    expect(useMusicPlayer.getState().queue.tracks.map((entry) => entry.id)).toEqual(['fm-1', 'fm-2'])
  })

  it('turns the intelligence mode into a heart station and detaches it on another mode', async () => {
    useMusicPlayer.getState().setMode('intelligence')
    await vi.waitFor(() => {
      expect(useMusicPlayer.getState().radio).toMatchObject({ mode: 'heart' })
    })
    expect(apiMock.heart).toHaveBeenCalledWith('seed', 'seed')
    useMusicPlayer.getState().setMode('order')
    expect(useMusicPlayer.getState().radio).toBeNull()
  })

  it('keeps playing when a dislike is refused', async () => {
    await useMusicPlayer.getState().startRadio('Private FM', 'DEFAULT')
    apiMock.fmTrash.mockRejectedValueOnce(new Error('refused'))
    const before = useMusicPlayer.getState().queue.index
    const result = await useMusicPlayer.getState().fmTrash()
    expect(result).toBe(false)
    expect(useMusicPlayer.getState().queue.index).toBe(before)
  })
})
