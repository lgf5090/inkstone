// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEFAULT_BLOG_SETTINGS, publicBlogSite } from '../src/shared/blog/settings'
import { sanitizeBlogHtml } from '../src/worker/blog/sanitize'
import type { BlogSettings } from '../src/shared/blog/settings'

const counts = { posts: 1, categories: 1, tags: 1, series: 1, views: 0 }

function project(overrides: Partial<Record<keyof BlogSettings, Record<string, unknown>>>) {
  const settings = { ...DEFAULT_BLOG_SETTINGS, ...overrides } as BlogSettings
  return publicBlogSite(settings, counts)
}

describe('the public site projection exposes the settings the frontend renders', () => {
  it('carries article toggles and clamps discovery counts', () => {
    const site = project({
      article: { share: false, showLastUpdated: true, lastUpdatedDays: 30, relatedCount: 99, randomCount: -3 },
    })
    expect(site.article).toEqual({
      share: false,
      showLastUpdated: true,
      lastUpdatedDays: 30,
      relatedCount: 20,
      randomCount: 0,
    })
  })

  it('falls back to the shipped article defaults when a field is absent', () => {
    const site = project({ article: { share: true } })
    expect(site.article).toEqual({
      share: true,
      showLastUpdated: true,
      lastUpdatedDays: 90,
      relatedCount: 3,
      randomCount: 2,
    })
  })

  it('keeps only safe license URLs and whitelisted fab actions', () => {
    const site = project({
      license: { enable: true, name: 'CC BY 4.0', url: 'javascript:alert(1)' },
      fab: { enable: true, items: ['home', 'toc', 'eval', 'top', 'home'] },
    })
    expect(site.license).toEqual({ enable: true, name: 'CC BY 4.0', url: '' })
    expect(site.fab).toEqual({ enable: true, items: ['home', 'toc', 'top'] })
    const allowed = project({ license: { enable: true, name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' } })
    expect(allowed.license.url).toBe('https://creativecommons.org/licenses/by/4.0/')
  })

  it('carries the announcement and llms settings the public pages consume', () => {
    const site = project({
      announcement: { enable: true, text: '  Server maintenance on Sunday  ', closable: false },
      llms: { enable: false, excludeTags: ['secret', ' secret ', 42, 'private'] },
    })
    expect(site.announcement).toEqual({ enable: true, text: 'Server maintenance on Sunday', closable: false })
    expect(site.llms).toEqual({ enable: false, excludeTags: ['secret', 'private'] })
  })

  it('strips scripts from owner footer markup before it reaches the public page', () => {
    const html = sanitizeBlogHtml('<p>Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>')
    expect(html).toContain('<p>Hi</p>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
  })
})
