// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { MusicTrack } from '../src/shared/music/model'
import {
  mergeVisibleOrder,
  nextTrackSort,
  orderByManualIds,
  readTrackOrder,
  saveTrackOrder,
  sortTracks,
  trackSource,
} from '../src/client/features/music/track-order'

function track(id: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id,
    provider: 'upload',
    providerId: id,
    kind: 'song',
    title: `Track ${id}`,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: 'Album',
    albumId: 'album',
    coverUrl: '',
    coverKey: '',
    durationMs: 60_000,
    format: 'mp3',
    bitrate: null,
    size: null,
    sha256: '',
    r2Key: `music/mp3/u/${id}.mp3`,
    source: 'upload',
    sourceQuality: 'original',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('shared track ordering', () => {
  it('puts downloaded online tracks on the R2 shelf and keeps WebDAV/Alist apart', () => {
    expect(trackSource(track('a'))).toBe('upload')
    expect(trackSource(track('b', { provider: 'netease', r2Key: 'music/mp3/u/b.mp3' }))).toBe('upload')
    expect(trackSource(track('c', { provider: 'webdav', r2Key: null }))).toBe('webdav')
    expect(trackSource(track('d', { provider: 'alist', r2Key: null }))).toBe('alist')
  })

  it('cycles a header through ascending, descending and the page default', () => {
    expect(nextTrackSort(null, 'title')).toEqual({ key: 'title', direction: 'asc' })
    expect(nextTrackSort({ key: 'title', direction: 'asc' }, 'title')).toEqual({ key: 'title', direction: 'desc' })
    expect(nextTrackSort({ key: 'title', direction: 'desc' }, 'title')).toBeNull()
    expect(nextTrackSort({ key: 'title', direction: 'desc' }, 'size')).toEqual({ key: 'size', direction: 'asc' })
  })

  it('sorts by title, album, duration, source and size without mutating the input', () => {
    const list = [
      track('b', { title: 'Beta', album: 'Two', durationMs: 2_000, size: 20, provider: 'webdav', r2Key: null }),
      track('a', { title: 'Alpha', album: 'One', durationMs: 1_000, size: 10 }),
    ]
    expect(sortTracks(list, { key: 'title', direction: 'asc' }).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(sortTracks(list, { key: 'title', direction: 'desc' }).map((entry) => entry.id)).toEqual(['b', 'a'])
    expect(sortTracks(list, { key: 'album', direction: 'asc' }).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(sortTracks(list, { key: 'duration', direction: 'asc' }).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(sortTracks(list, { key: 'size', direction: 'asc' }).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(sortTracks(list, { key: 'source', direction: 'asc' }).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(list.map((entry) => entry.id)).toEqual(['b', 'a'])
  })

  it('keeps stored drag ids in front and leaves unknown rows in server order', () => {
    const list = [track('a'), track('b'), track('c'), track('d')]
    expect(orderByManualIds(list, ['c', 'a', 'missing']).map((entry) => entry.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(orderByManualIds(list, []).map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('merges a dragged search slice without moving hidden rows', () => {
    expect(mergeVisibleOrder(['a', 'b', 'c', 'd', 'e'], ['b', 'd'], ['d', 'b']))
      .toEqual(['a', 'd', 'c', 'b', 'e'])
    expect(mergeVisibleOrder(['a', 'b'], ['a', 'b'], ['b'])).toEqual(['a', 'b'])
    expect(mergeVisibleOrder(['a', 'b'], ['a', 'b'], ['b', 'b'])).toEqual(['a', 'b'])
  })

  it('round-trips the per-device order and ignores a corrupted value', () => {
    saveTrackOrder('inkstone.test.trackOrder', ['b', 'a'])
    expect(readTrackOrder('inkstone.test.trackOrder')).toEqual(['b', 'a'])
    localStorage.setItem('inkstone.test.trackOrder', '{broken')
    expect(readTrackOrder('inkstone.test.trackOrder')).toEqual([])
    localStorage.removeItem('inkstone.test.trackOrder')
  })
})
