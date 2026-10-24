// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  formatCompatibleWithContainer,
  sanitizeUploadMetadata,
  sniffMusicFormat,
  titleFromFilename,
} from '../src/worker/music/metadata'
import { musicPartCount, musicPartLength } from '../src/worker/music/upload-store'
import { MUSIC_LIMITS } from '../src/shared/music/constants'

function bytes(...values: Array<string | number>): Uint8Array {
  const out: number[] = []
  for (const value of values) {
    if (typeof value === 'number') out.push(value)
    else for (const character of value) out.push(character.charCodeAt(0))
  }
  return new Uint8Array(out)
}

describe('music upload validation', () => {
  it('identifies the accepted containers from their signatures', () => {
    expect(sniffMusicFormat(bytes('fLaC', 0, 0, 0), null)).toBe('flac')
    expect(sniffMusicFormat(bytes('RIFF', 0, 0, 0, 0, 'WAVE'), null)).toBe('wav')
    expect(sniffMusicFormat(bytes('OggS', 0, 0, 0, 'OpusHead'), null)).toBe('opus')
    expect(sniffMusicFormat(bytes('OggS', 0, 0, 0, 'vorbis'), null)).toBe('ogg')
    expect(sniffMusicFormat(bytes('ID3', 4, 0), null)).toBe('mp3')
    expect(sniffMusicFormat(bytes(0, 0, 0, 0, 'ftypM4A '), null)).toBe('m4a')
    expect(sniffMusicFormat(bytes(0, 0, 0, 0, 'ftypisom'), null)).toBe('mp4')
    expect(sniffMusicFormat(bytes('nope'), null)).toBeNull()
  })

  it('only accepts container aliases that are the same file family', () => {
    expect(formatCompatibleWithContainer('m4a', 'mp4')).toBe(true)
    expect(formatCompatibleWithContainer('ogg', 'opus')).toBe(true)
    expect(formatCompatibleWithContainer('mp3', 'flac')).toBe(false)
  })

  it('trims client metadata instead of trusting it', () => {
    const result = sanitizeUploadMetadata({
      title: '  title  ',
      artists: ['one', 'one', { name: 'two' }, ''],
      album: ' album ',
      durationMs: -5,
      bitrate: 99_000_000,
      lyrics: '  [00:01.00]line  ',
    }, 'fallback')
    expect(result.title).toBe('title')
    expect(result.artists).toEqual(['one', 'two'])
    expect(result.album).toBe('album')
    expect(result.durationMs).toBe(0)
    expect(result.bitrate).toBeNull()
    expect(result.lyrics).toBe('[00:01.00]line')
  })

  it('falls back to the filename for a missing title', () => {
    expect(titleFromFilename('Song One.flac')).toBe('Song One')
    expect(titleFromFilename('no-extension')).toBe('no-extension')
  })

  it('computes part counts and the last part length', () => {
    const part = MUSIC_LIMITS.uploadPartBytes
    const size = part * 2 + 123
    expect(musicPartCount(size)).toBe(3)
    expect(musicPartLength(size, 1)).toBe(part)
    expect(musicPartLength(size, 3)).toBe(123)
    expect(musicPartLength(size, 4)).toBeNull()
    expect(musicPartCount(size, size)).toBe(1)
    expect(musicPartLength(size, 1, size)).toBe(size)
  })
})
