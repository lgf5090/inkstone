// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { apiKeyAllows, parseKeyScopes } from '../src/worker/clouddrive/store-keys'

describe('CloudDrive API key scopes', () => {
  it('keeps legacy webdav keys read/write during migration', () => {
    const scopes = parseKeyScopes('webdav')
    expect(apiKeyAllows(scopes, 'webdav:read')).toBe(true)
    expect(apiKeyAllows(scopes, 'webdav:write')).toBe(true)
  })

  it('enforces read-only and write-only scopes', () => {
    const read = parseKeyScopes(['webdav:read'])
    const write = parseKeyScopes(['webdav:write'])
    expect(apiKeyAllows(read, 'webdav:read')).toBe(true)
    expect(apiKeyAllows(read, 'webdav:write')).toBe(false)
    expect(apiKeyAllows(write, 'webdav:write')).toBe(true)
    expect(apiKeyAllows(write, 'webdav:read')).toBe(false)
  })

  it('drops unknown scopes instead of half-authenticating', () => {
    expect(parseKeyScopes(['webdav:read', 'admin'])).toEqual(['webdav:read'])
  })
})
