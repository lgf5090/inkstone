// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizeRepo } from '../src/worker/development/github/github-repos'
import { normalizeGist } from '../src/worker/development/github/github-gists'
import { isHttpUrl, readHttpUrl, readNullableHttpUrl } from '../src/shared/development/github/url'

describe('GitHub upstream URL safety', () => {
  it('accepts only http and https URLs', () => {
    expect(isHttpUrl('https://github.com/acme/repo')).toBe(true)
    expect(isHttpUrl('http://example.com/a')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('data:text/html,hello')).toBe(false)
    expect(isHttpUrl('https://user:pass@example.com')).toBe(false)
    expect(readHttpUrl('javascript:alert(1)', 2048)).toBe('')
    expect(readNullableHttpUrl('', 2048)).toBeNull()
  })

  it('drops unsafe repository URLs before they reach anchors or images', () => {
    const repo = normalizeRepo({
      id: 1,
      name: 'demo',
      full_name: 'acme/demo',
      html_url: 'javascript:alert(1)',
      homepage: 'data:text/html,hello',
      owner: { login: 'acme', avatar_url: 'javascript:alert(2)' },
      topics: [],
    })
    expect(repo.url).toBe('')
    expect(repo.homepage).toBeNull()
    expect(repo.owner.avatarUrl).toBe('')
  })

  it('drops unsafe gist URLs and avatars', () => {
    const gist = normalizeGist({
      id: 'abcdef12',
      html_url: 'javascript:alert(1)',
      owner: { login: 'acme', avatar_url: 'javascript:alert(2)' },
      files: {},
    })
    expect(gist.url).toBe('')
    expect(gist.owner?.avatarUrl).toBe('')
  })
})
