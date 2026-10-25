// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  cookieJarToString,
  cookiePairs,
  cookieToString,
  parseCookie,
} from '../src/worker/music/providers/netease/request'

describe('Netease cookie parsing', () => {
  it('keeps every pair in a Cookie header', () => {
    expect(parseCookie('os=pc; MUSIC_U=session-token; __csrf=csrf-token')).toEqual({
      os: 'pc',
      MUSIC_U: 'session-token',
      __csrf: 'csrf-token',
    })
  })

  it('drops Set-Cookie attributes but keeps the cookie', () => {
    expect(cookiePairs([
      'MUSIC_U=session-token; Max-Age=315360000; Expires=Wed, 22 Oct 2036 15:22:18 GMT; Path=/; Domain=.music.163.com',
    ])).toEqual([['MUSIC_U', 'session-token']])
  })

  it('reads every Set-Cookie line', () => {
    expect(cookiePairs([
      'MUSIC_U=one; Path=/',
      'NMTID=two; Path=/',
    ])).toEqual([
      ['MUSIC_U', 'one'],
      ['NMTID', 'two'],
    ])
  })

  it('keeps equals signs inside a value', () => {
    expect(parseCookie('MUSIC_U=a=b==; os=pc')).toEqual({ MUSIC_U: 'a=b==', os: 'pc' })
  })

  it('round-trips a raw jar and encodes only on the wire', () => {
    const raw = { MUSIC_U: 'a+b/c==', _ntes_nnid: 'abc,123' }
    expect(parseCookie(cookieJarToString(raw))).toEqual(raw)
    expect(cookieToString(raw)).toBe('MUSIC_U=a%2Bb%2Fc%3D%3D; _ntes_nnid=abc%2C123')
  })
})
