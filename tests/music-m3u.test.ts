// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MusicTrack } from '../src/shared/music/model'
import { buildM3U, matchM3UTracks, parseM3U } from '../src/client/features/music/m3u'

function track(id: string, title: string, artist: string, durationMs = 180_000): MusicTrack {
  return {
    id,
    provider: 'netease',
    providerId: id,
    kind: 'song',
    title,
    artists: [{ id: '', name: artist }],
    album: '',
    albumId: '',
    coverUrl: '',
    coverKey: '',
    durationMs,
    format: 'mp3',
    bitrate: null,
    size: null,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: '',
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('M3U import and export', () => {
  it('reads EXTINF entries, bare lines and comments', () => {
    const entries = parseM3U([
      '#EXTM3U',
      '#EXTINF:232,DOUDOU - 宝船',
      'music/track/a',
      'A plain title',
      '# a comment',
    ].join('\n'))
    expect(entries).toEqual([
      { durationMs: 232_000, artist: 'DOUDOU', title: '宝船', location: 'music/track/a' },
      { durationMs: null, artist: '', title: 'A plain title', location: 'A plain title' },
    ])
  })

  it('matches by exported location, display name and title without duplicating', () => {
    const tracks = [track('a', '宝船', 'DOUDOU'), track('b', 'Plain Song', 'Artist')]
    const text = buildM3U([tracks[0]!])
    const exported = matchM3UTracks(parseM3U(text), tracks)
    expect(exported.matched.map((entry) => entry.id)).toEqual(['a'])

    const byName = matchM3UTracks(parseM3U('#EXTINF:1,DOUDOU - 宝船\nmissing\n#EXTINF:2,Artist - Plain Song\nmissing'), tracks)
    expect(byName.matched.map((entry) => entry.id)).toEqual(['a', 'b'])

    const byTitle = matchM3UTracks(parseM3U('#EXTINF:1,Plain Song\nmissing'), tracks)
    expect(byTitle.matched.map((entry) => entry.id)).toEqual(['b'])
    expect(byTitle.unmatched).toBe(0)
  })

  it('reports entries the visible list cannot answer', () => {
    const result = matchM3UTracks(parseM3U('#EXTINF:10,Someone - Else\nmissing'), [track('a', '宝船', 'DOUDOU')])
    expect(result).toEqual({ matched: [], unmatched: 1 })
  })
})
