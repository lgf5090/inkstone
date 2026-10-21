import { describe, expect, it } from 'vitest'
import { classifyMemoSurface } from './public-route'

describe('classifyMemoSurface', () => {
  it('treats share and profile addresses as public without a session', () => {
    expect(classifyMemoSurface('/memos/s/token123')).toEqual({
      kind: 'public',
      route: { kind: 'share', token: 'token123' },
    })
    expect(classifyMemoSurface('/memos/s/token123/')).toEqual({
      kind: 'public',
      route: { kind: 'share', token: 'token123' },
    })
    expect(classifyMemoSurface('/memos/u/alice')).toEqual({
      kind: 'public',
      route: { kind: 'profile', username: 'alice' },
    })
    expect(classifyMemoSurface('/memos/u/alice/m/abc123')).toEqual({
      kind: 'public',
      route: { kind: 'profileMemo', username: 'alice', id: 'abc123' },
    })
  })

  it('asks for the session on explore', () => {
    expect(classifyMemoSurface('/memos/explore')).toEqual({ kind: 'explore' })
    expect(classifyMemoSurface('/memos/explore/')).toEqual({ kind: 'explore' })
  })

  it('leaves every other address to the app', () => {
    const appPaths = [
      '/',
      '/notes',
      '/memos',
      '/memos/archived',
      '/memos/m/abc123',
      '/memos/unknown',
      '/memos/s',
      '/memos/s/token123/extra',
      '/memos/u',
      '/memos/u/alice/extra',
      '/memos/explore/extra',
    ]
    for (const path of appPaths) {
      expect(classifyMemoSurface(path), path).toEqual({ kind: 'app' })
    }
  })
})
