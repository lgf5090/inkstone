// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MusicTrack } from '../src/shared/music/model'
import { emptyQueue } from '../src/client/features/music/player/queue'
import {
  appendRadioTracks,
  nextFmTracks,
  nextHeartTracks,
  playableFilter,
  RADIO_FEED_LIMIT,
  sanitizeRadio,
  type RadioFeedApi,
} from '../src/client/features/music/radio/radio-feed'

function track(id: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id,
    provider: 'netease',
    providerId: id,
    kind: 'song',
    title: `Track ${id}`,
    artists: [{ id: 'a', name: 'Artist' }],
    album: 'Album',
    albumId: 'album',
    coverUrl: '',
    coverKey: '',
    durationMs: 180_000,
    format: 'mp3',
    bitrate: null,
    size: null,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: 'exhigh',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('the radio feed', () => {
  it('appends only new playable rows and keeps the current index addressable', () => {
    const queue = { ...emptyQueue('order'), tracks: [track('a'), track('b')], index: 1 }
    const next = appendRadioTracks(queue, [track('b'), track('c'), { ...track('bad'), providerId: '' }])
    expect(next.tracks.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(next.index).toBe(1)
    expect(appendRadioTracks(next, [track('c')])).toBe(next)
  })

  it('never grows past the feed cap and drops the oldest history first', () => {
    const tracks = Array.from({ length: RADIO_FEED_LIMIT }, (_, index) => track(`t${index}`))
    const queue = { ...emptyQueue('order'), tracks, index: RADIO_FEED_LIMIT - 1 }
    const next = appendRadioTracks(queue, [track('fresh')])
    expect(next.tracks).toHaveLength(RADIO_FEED_LIMIT)
    expect(next.tracks.at(-1)?.id).toBe('fresh')
    expect(next.tracks[next.index]?.id).toBe(`t${RADIO_FEED_LIMIT - 1}`)
  })

  it('drops unusable provider rows before they reach the queue', () => {
    expect(playableFilter([track('a'), { ...track('b'), title: '' }, { ...track('c'), provider: '' as MusicTrack['provider'] }]))
      .toEqual([track('a')])
  })

  it('reads a persisted station only when its mode is known', () => {
    expect(sanitizeRadio({ name: 'FM', mode: 'FAMILIAR' })).toEqual({ name: 'FM', mode: 'FAMILIAR' })
    expect(sanitizeRadio({ name: 'Heart', mode: 'heart', seedProviderId: '9' })).toEqual({
      name: 'Heart', mode: 'heart', seedProviderId: '9',
    })
    expect(sanitizeRadio({ name: 'FM', mode: 'unknown' })).toBeNull()
    expect(sanitizeRadio({ name: '', mode: 'DEFAULT' })).toBeNull()
  })

  it('asks the injected feed for the chosen FM taste or heart seed', async () => {
    const calls: string[] = []
    const api: RadioFeedApi = {
      fm: async (mode) => {
        calls.push(`fm:${mode}`)
        return { tracks: [track('f')] }
      },
      heart: async (providerId, startProviderId) => {
        calls.push(`heart:${providerId}:${startProviderId}`)
        return { tracks: [track('h')] }
      },
    }
    expect((await nextFmTracks('EXPLORE', api)).map((entry) => entry.id)).toEqual(['f'])
    expect((await nextHeartTracks('next', 'seed', api)).map((entry) => entry.id)).toEqual(['h'])
    expect(calls).toEqual(['fm:EXPLORE', 'heart:next:seed'])
  })
})
