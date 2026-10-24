// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseNeteasePlaylistId } from '../src/client/features/music/playlist-import'

describe('Netease playlist links', () => {
  it('accepts a bare provider id', () => {
    expect(parseNeteasePlaylistId('6845417475')).toBe('6845417475')
  })

  it('reads the id from the usual share links', () => {
    expect(parseNeteasePlaylistId('https://music.163.com/playlist?id=6845417475')).toBe('6845417475')
    expect(parseNeteasePlaylistId('https://music.163.com/#/playlist?id=6845417475&userid=1')).toBe('6845417475')
    expect(parseNeteasePlaylistId('https://y.music.163.com/m/playlist/6845417475')).toBe('6845417475')
  })

  it('refuses text without a provider id', () => {
    expect(parseNeteasePlaylistId('https://music.163.com/')).toBeNull()
    expect(parseNeteasePlaylistId('12')).toBeNull()
    expect(parseNeteasePlaylistId('playlist?id=abc')).toBeNull()
  })
})
