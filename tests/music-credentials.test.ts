// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isCredentialRecord, isScope } from '../src/worker/durable/credential-vault'

const userId = 'a'.repeat(26)

describe('the music credential scope', () => {
  it('accepts one account scoped cookie', () => {
    expect(isScope(`music:${userId}`)).toBe(true)
    expect(isCredentialRecord(`music:${userId}`, { cookie: 'MUSIC_U=abc; __csrf=def' })).toBe(true)
  })

  it('refuses fields other than the cookie and cookies beyond the vault bound', () => {
    expect(isCredentialRecord(`music:${userId}`, { token: 'x' })).toBe(false)
    expect(isCredentialRecord(`music:${userId}`, { cookie: '' })).toBe(false)
    expect(isCredentialRecord(`music:${userId}`, { cookie: 'x'.repeat(8 * 1024 + 1) })).toBe(false)
  })

  it('does not let a music scope be named by a malformed id', () => {
    expect(isScope('music:short')).toBe(false)
    expect(isScope(`music:${userId.toUpperCase()}`)).toBe(false)
  })
})
