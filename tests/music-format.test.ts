// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildExportFilename,
  formatBytes,
  formatDuration,
  formatPlayCount,
  musicQualityRank,
  sanitizeMusicFilename,
} from '../src/shared/music/format'
import { formatFromFilename, musicCoverKey, musicObjectKey } from '../src/shared/music/constants'
import type { MusicTrack } from '../src/shared/music/model'

const track: MusicTrack = {
  id: 'track-1',
  provider: 'netease',
  providerId: '42',
  kind: 'song',
  title: 'A/B: Song?',
  artists: [{ id: '1', name: 'Artist One' }, { id: '2', name: 'Artist Two' }],
  album: 'Album',
  albumId: '9',
  coverUrl: '',
  coverKey: '',
  durationMs: 245_000,
  format: 'mp3',
  bitrate: 320_000,
  size: 1_000,
  sha256: '',
  r2Key: null,
  source: 'netease',
  sourceQuality: 'exhigh',
  createdAt: 0,
  updatedAt: 0,
}

describe('music formatting', () => {
  it('renders durations with and without an hour', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
  })

  it('renders byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1_024)).toBe('1.0 KB')
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB')
  })

  it('ranks the quality ladder and rejects upload-only quality for downloads', () => {
    expect(musicQualityRank('standard')).toBeLessThan(musicQualityRank('lossless'))
    expect(musicQualityRank('original')).toBe(0)
  })

  it('cleans filenames and expands the export template', () => {
    expect(sanitizeMusicFilename('  a<b>:c?  ')).toBe('a b c')
    expect(buildExportFilename('{title} - {artist}', track, 'mp3')).toBe('A B Song - Artist One, Artist Two.mp3')
  })

  it('formats play counts without assuming a locale', () => {
    expect(formatPlayCount(0)).toBe('0')
    expect(formatPlayCount(12_300, 'en')).toBe('12.3K')
  })

  it('keeps the R2 keys under the music prefix and disambiguates mp4 from m4a', () => {
    expect(musicObjectKey({ format: 'flac', userId: 'u1', trackId: 't1', quality: 'lossless' }))
      .toBe('music/flac/u1/t1-lossless.flac')
    expect(musicCoverKey({ userId: 'u1', trackId: 't1', extension: '.JPG' }))
      .toBe('music/covers/u1/t1.jpg')
    expect(formatFromFilename('video.MP4')).toBe('mp4')
    expect(formatFromFilename('audio.m4a')).toBe('m4a')
  })
})
