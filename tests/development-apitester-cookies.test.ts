// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { CookieRecord } from '../src/shared/development/api-tester/types'
import { cookieHeaderFor, cookieMatches, mergeResponseCookies } from '../src/client/features/development/api-tester/lib/cookies'

const cookie = (patch: Partial<CookieRecord> = {}): CookieRecord => ({
  id: 'c1',
  name: 'sid',
  value: 'abc',
  domain: 'example.com',
  path: '/',
  ...patch,
})

describe('API Tester cookie jar', () => {
  it('matches domain, path, secure and expiry rules', () => {
    const url = new URL('https://api.example.com/v1/users')
    expect(cookieMatches(cookie({ path: '/' }), url)).toBe(true)
    expect(cookieMatches(cookie({ path: '/v1' }), url)).toBe(true)
    expect(cookieMatches(cookie({ path: '/v2' }), url)).toBe(false)
    expect(cookieMatches(cookie({ domain: 'other.com' }), url)).toBe(false)
    expect(cookieMatches(cookie({ secure: true }), new URL('http://api.example.com/v1'))).toBe(false)
    expect(cookieMatches(cookie({ expiresAt: 1 }), url, 2)).toBe(false)
  })

  it('builds the Cookie header longest path first and skips expired rows', () => {
    const url = new URL('https://api.example.com/v1/users')
    const header = cookieHeaderFor(url, [
      cookie({ id: 'a', name: 'root', path: '/' }),
      cookie({ id: 'b', name: 'api', path: '/v1' }),
      cookie({ id: 'c', name: 'old', expiresAt: 1 }),
    ], 2)
    expect(header).toBe('api=abc; root=abc')
  })

  it('merges Set-Cookie rows by name/domain/path and removes expired ones', () => {
    const existing = [cookie({ id: 'old', name: 'sid', value: 'old' })]
    const merged = mergeResponseCookies(existing, {
      url: 'https://api.example.com/login',
      cookies: [
        { name: 'sid', value: 'new', domain: 'example.com', path: '/', secure: true, httpOnly: true },
        { name: 'gone', value: 'x', domain: 'example.com', path: '/', expiresAt: 1 },
      ],
    }, 100)
    expect(merged).toEqual([
      { id: 'old', name: 'sid', value: 'new', domain: 'example.com', path: '/', expiresAt: undefined, secure: true, httpOnly: true },
    ])
  })
})
