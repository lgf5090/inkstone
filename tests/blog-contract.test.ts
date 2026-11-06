import { describe, expect, it } from 'vitest'
import { readBlogFrontMatter, slugifyBlogTitle } from '../src/shared/blog/frontmatter'
import { mergeBlogSettings, publicBlogSite } from '../src/shared/blog/settings'
import { BLOG_ALL_SCHEMA_STATEMENTS, BLOG_REQUIRED_TABLES } from '../src/worker/blog/schema'
import { sanitizeBlogHtml } from '../src/worker/blog/sanitize'

describe('blog front matter', () => {
  it('reads the publication fields from a note', () => {
    const meta = readBlogFrontMatter(`---
isPublished: true
blogSlug: custom-slug
blogExcerpt: A short summary
blogCategory: Guides
blogSeries: markdown
blogSeriesOrder: 2
blogPinned: true
blogComments: false
blogLanguage: zh-CN
blogAlias: /old
blogHideHomeContent: false
blogProtected: true
blogPasswordHint: hint
---

# Body
`)
    expect(meta).toMatchObject({
      isPublished: true,
      slug: 'custom-slug',
      excerpt: 'A short summary',
      category: 'Guides',
      series: 'markdown',
      seriesOrder: 2,
      pinned: true,
      comments: false,
      language: 'zh-CN',
      alias: '/old',
      hideHomeContent: false,
      protected: true,
      passwordHint: 'hint',
    })
  })

  it('treats a missing property as unpublished and builds a Unicode slug', () => {
    expect(readBlogFrontMatter('# Body').isPublished).toBe(false)
    expect(slugifyBlogTitle('Hello 世界')).toBe('hello-世界')
  })
})

describe('blog settings', () => {
  it('merges domains and replaces arrays', () => {
    const settings = mergeBlogSettings([
      { key: 'site', value: JSON.stringify({ title: 'My Blog' }) },
      { key: 'nav', value: JSON.stringify({ links: [{ label: 'Home', href: '/' }] }) },
    ])
    expect(settings.site.title).toBe('My Blog')
    expect(settings.site.locale).toBe('en')
    expect(settings.nav.links).toEqual([{ label: 'Home', href: '/' }])
  })

  it('projects only the public site fields', () => {
    const site = publicBlogSite(mergeBlogSettings([]), { posts: 1, categories: 2, tags: 3, series: 4, views: 0 })
    expect(site.site.title).toBe('Inkstone Blog')
    expect(site.counts).toEqual({ posts: 1, categories: 2, tags: 3, series: 4, views: 0 })
  })

  it('projects the full-text feed switch the admin saves under display', () => {
    const counts = { posts: 0, categories: 0, tags: 0, series: 0, views: 0 }
    expect(publicBlogSite(mergeBlogSettings([]), counts).display.feedFullText).toBe(false)
    expect(publicBlogSite(
      mergeBlogSettings([{ key: 'display', value: JSON.stringify({ feedFullText: true }) }]),
      counts,
    ).display.feedFullText).toBe(true)
  })

  it('serves the default zone when the stored one is not IANA', () => {
    // The calendar widget formats through this value; an unknown name would throw in the browser
    // and leave the widget blank, so the projection answers with the site default instead.
    const site = publicBlogSite(
      mergeBlogSettings([{ key: 'site', value: JSON.stringify({ timeZone: 'Mars/Olympus' }) }]),
      { posts: 0, categories: 0, tags: 0, series: 0, views: 0 },
    )
    expect(site.site.timeZone).toBe('UTC')
  })
})

describe('blog snapshot sanitizer', () => {
  it('removes scripts, handlers and javascript URLs while keeping renderer markup', () => {
    const html = sanitizeBlogHtml(
      '<p class="k" data-x="1" aria-label="a" style="color:red;background-image:url(javascript:alert(1))" onclick="alert(1)">x</p>' +
      '<script>alert(1)</script><a href="javascript:alert(1)">link</a>',
    )
    expect(html).toContain('class="k"')
    expect(html).toContain('data-x="1"')
    expect(html).toContain('aria-label="a"')
    expect(html).toContain('style="color:red"')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('background-image')
  })
})

describe('blog schema', () => {
  it('declares every required table and gives each one a user scope', () => {
    const statements = BLOG_ALL_SCHEMA_STATEMENTS.join('\n')
    for (const table of BLOG_REQUIRED_TABLES) {
      expect(statements).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    for (const table of BLOG_REQUIRED_TABLES) {
      const start = statements.indexOf(`CREATE TABLE IF NOT EXISTS ${table} `)
      expect(start).toBeGreaterThanOrEqual(0)
      const next = statements.indexOf('CREATE TABLE IF NOT EXISTS', start + 1)
      const block = statements.slice(start, next < 0 ? undefined : next)
      expect(block).toContain('user_id')
    }
  })
})
