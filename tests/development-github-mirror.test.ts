import { describe, expect, it } from 'vitest'
import type { GithubMirrorSource } from '@shared/development/github/types'
import {
  isHttpUrl,
  normalizeMirrorUrl,
  resolveMirror,
} from '../src/client/features/development/github/lib/mirror'

function mirror(id: string, enabled = true): GithubMirrorSource {
  return { id, name: id, url: `https://${id}.example.com`, enabled, createdAt: 0 }
}

describe('GitHub mirror helpers', () => {
  it('accepts only http and https URLs', () => {
    expect(isHttpUrl('https://gh-proxy.com')).toBe(true)
    expect(isHttpUrl('http://gh-proxy.com')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('ftp://gh-proxy.com')).toBe(false)
    expect(isHttpUrl('https://user:pass@gh-proxy.com')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })

  it('normalizes a mirror base URL without a trailing slash', () => {
    expect(normalizeMirrorUrl(' https://gh-proxy.com/ ')).toBe('https://gh-proxy.com')
    expect(normalizeMirrorUrl('https://gh-proxy.com/base///')).toBe('https://gh-proxy.com/base')
    expect(normalizeMirrorUrl('http://localhost:8787/')).toBe('http://localhost:8787')
    expect(normalizeMirrorUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeMirrorUrl('https://user:secret@gh-proxy.com')).toBeNull()
    expect(normalizeMirrorUrl('https://gh-proxy.com/has space')).toBeNull()
  })

  it('resolves the current enabled mirror with a fallback', () => {
    const mirrors = [mirror('one', false), mirror('two', true), mirror('three', true)]
    expect(resolveMirror(mirrors, 'three')?.id).toBe('three')
    expect(resolveMirror(mirrors, 'one')?.id).toBe('two')
    expect(resolveMirror(mirrors, 'missing')?.id).toBe('two')
    expect(resolveMirror(mirrors, null)?.id).toBe('two')
    expect(resolveMirror([mirror('one', false)], 'one')).toBeNull()
    expect(resolveMirror([], 'one')).toBeNull()
  })
})
