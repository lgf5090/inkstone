// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  extractPageMetadata,
  isSocialCrawler,
  parseOgPreview,
  renderOgPage,
} from '../src/worker/tools/shortlinks/og'
import { OgPreviewSchema } from '../src/shared/tools/shortlinks/schemas'

describe('Shortlinks Open Graph preview', () => {
  it('only treats social preview crawlers as crawlers, not search engines or browsers', () => {
    expect(isSocialCrawler('Twitterbot/1.0')).toBe(true)
    expect(isSocialCrawler('facebookexternalhit/1.1')).toBe(true)
    expect(isSocialCrawler('Slackbot-LinkExpanding 1.0')).toBe(true)
    expect(isSocialCrawler('WhatsApp/2.23')).toBe(true)
    expect(isSocialCrawler('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(false)
    expect(isSocialCrawler('Mozilla/5.0 Chrome/131 Safari/537.36')).toBe(false)
  })

  it('parses stored overrides defensively and caps their lengths', () => {
    expect(parseOgPreview('not json')).toBeNull()
    expect(parseOgPreview('{}')).toBeNull()
    expect(parseOgPreview(JSON.stringify({ title: '  Hello  ', description: 'Desc' }))).toEqual({
      title: 'Hello',
      description: 'Desc',
    })
    const long = parseOgPreview(JSON.stringify({ title: 'x'.repeat(200) }))
    expect(long?.title).toHaveLength(120)
  })

  it('reads Open Graph tags, resolves a relative image and falls back to the title tag', () => {
    const html = `<head>
      <title>Page title</title>
      <meta property="og:description" content="A description" />
      <meta content="https://cdn.example.com/cover.png" property="og:image" />
    </head>`
    const metadata = extractPageMetadata(html, 'https://target.example.com/page')
    expect(metadata).toEqual({
      title: 'Page title',
      description: 'A description',
      image: 'https://cdn.example.com/cover.png',
    })
    expect(extractPageMetadata('<meta property="og:image" content="/cover.png">', 'https://target.example.com/page').image).toBe(
      'https://target.example.com/cover.png',
    )
  })

  it('escapes every value and omits an unusable image from the rendered page', () => {
    const html = renderOgPage({
      title: '<script>alert(1)</script>',
      description: '"quoted" & more',
      image: 'javascript:alert(1)',
      shortUrl: 'https://short.example.com/l/og',
      target: 'https://target.example.com/?a=1&b=<x>',
      locale: 'en-US',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&quot;quoted&quot; &amp; more')
    expect(html).not.toContain('og:image')
    expect(html).toContain('og:url" content="https://short.example.com/l/og"')
  })

  it('validates the editor payload before it reaches D1', () => {
    expect(OgPreviewSchema.safeParse({ title: 'ok', description: 'ok', image: 'https://cdn.example.com/a.png' }).success).toBe(true)
    expect(OgPreviewSchema.safeParse({ image: 'javascript:alert(1)' }).success).toBe(false)
    expect(OgPreviewSchema.safeParse({ title: 'x'.repeat(121) }).success).toBe(false)
    expect(OgPreviewSchema.safeParse({ description: 'x'.repeat(201) }).success).toBe(false)
  })
})
