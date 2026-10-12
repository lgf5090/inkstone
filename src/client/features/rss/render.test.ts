/**
 * The three small transforms an article passes through on its way to the screen, tested on the
 * markup feeds actually ship.
 *
 * Each of these is a security or fidelity boundary that a screenshot cannot see: a body that keeps
 * an `onerror`, a Markdown export that turns a list into a paragraph, an SVG that arrives as an
 * "image". The fixtures are written the way a feed writes them — double-escaped, namespaced,
 * missing a closing quote — rather than the way a formatter would tidy them.
 */
import { describe, expect, it } from 'vitest'
import { articleDisplayHtml, displayImageUrl, htmlToText, sanitizeFeedHtml } from './sanitize'
import { htmlToMarkdown } from './markdown'
import { playableAudio, videoLinkOf } from './media'

const relay = (url: string): string => `/relay?u=${encodeURIComponent(url)}`

describe('sanitizeFeedHtml', () => {
  it('drops the executable parts of a hostile body', () => {
    const dirty = `<p>Safe</p><script>alert(1)</script><img src="x" onerror="alert(2)">
      <iframe src="https://evil.example/"></iframe><a href="javascript:alert(3)">click</a>
      <object data="x"></object><style>body{display:none}</style><svg onload="alert(4)"></svg>`
    const clean = sanitizeFeedHtml(dirty)
    expect(clean).toContain('Safe')
    for (const fragment of ['<script', 'onerror', '<iframe', 'javascript:', '<object', '<style', '<svg']) {
      expect(clean).not.toContain(fragment)
    }
  })

  it('keeps the structure an article is made of', () => {
    const body = '<h2>Head</h2><ul><li>one</li></ul><blockquote>quoted</blockquote><pre><code class="language-js">let a=1</code></pre><table><tr><td>cell</td></tr></table>'
    const clean = sanitizeFeedHtml(body)
    for (const tag of ['<h2>', '<ul>', '<li>', '<blockquote>', '<pre>', '<code', '<table>', '<td>']) {
      expect(clean).toContain(tag)
    }
  })

  it('survives an empty or missing body', () => {
    expect(sanitizeFeedHtml('')).toBe('')
    expect(sanitizeFeedHtml(undefined as unknown as string)).toBe('')
  })
})

describe('articleDisplayHtml', () => {
  it('points every picture at the relay when the reader relays', () => {
    const html = articleDisplayHtml('<p>a</p><img src="https://cdn.example.com/a.png" alt="A">', { images: 'relay', relay })
    expect(html).toContain(`src="${relay('https://cdn.example.com/a.png')}"`)
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('referrerpolicy="no-referrer"')
  })

  it('leaves the addresses alone in direct mode and removes the pictures when off', () => {
    const direct = articleDisplayHtml('<img src="https://cdn.example.com/a.png">', { images: 'direct', relay })
    expect(direct).toContain('src="https://cdn.example.com/a.png"')
    expect(articleDisplayHtml('<img src="https://cdn.example.com/a.png"><p>keep me</p>', { images: 'off', relay })).not.toContain('<img')
  })

  it('takes the real address from a lazy-loading attribute and drops srcset', () => {
    const html = articleDisplayHtml('<img data-src="https://cdn.example.com/real.jpg" src="data:image/gif;base64,AA" srcset="https://cdn.example.com/big.jpg 2x">', { images: 'relay', relay })
    expect(html).toContain(relay('https://cdn.example.com/real.jpg'))
    expect(html).not.toContain('srcset')
    expect(html).not.toContain('base64')
  })

  it('makes links safe to open and unwraps the ones that are not addresses', () => {
    const html = articleDisplayHtml('<a href="https://x.example/a">post</a><a href="javascript:alert(1)">y</a>', { images: 'off', relay })
    expect(html).not.toContain('javascript:')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).toContain('target="_blank"')
  })

  it('resolves a body’s relative addresses against the article, not the notebook', () => {
    const clean = sanitizeFeedHtml('<a href="/posts/2">x</a><img src="/i.png">', 'https://blog.example.com/entry')
    expect(clean).toContain('href="https://blog.example.com/posts/2"')
    expect(clean).toContain('src="https://blog.example.com/i.png"')
    expect(sanitizeFeedHtml('<a href="mailto:hi@example.com">mail</a><a href="#top">x</a>', 'https://blog.example.com/entry')).toContain('href="https://blog.example.com/entry#top"')
    expect(sanitizeFeedHtml('<a href="mailto:hi@example.com">mail</a>', 'https://blog.example.com/entry')).not.toContain('href=')
  })

  it('resolves a relative picture against the article, not the notebook', () => {
    const html = articleDisplayHtml('<img src="/images/inline.png">', { images: 'relay', relay })
    expect(html).not.toContain('/relay?u=%2Fimages')
  })
})

describe('displayImageUrl and htmlToText', () => {
  it('refuses a non-address and an off setting', () => {
    expect(displayImageUrl('not a url', { images: 'relay', relay })).toBe('')
    expect(displayImageUrl('https://x.example/a.png', { images: 'off', relay })).toBe('')
    expect(displayImageUrl('https://x.example/a.png', { images: 'relay', relay })).toBe(relay('https://x.example/a.png'))
  })

  it('flattens markup to the text a search row can hold', () => {
    expect(htmlToText('<p>One   two</p><script>bad()</script><div>three</div>', 20)).toBe('One two three')
    expect(htmlToText(`<p>${'x'.repeat(500)}</p>`, 10)).toHaveLength(10)
  })
})

describe('htmlToMarkdown', () => {
  it('keeps the blocks a reader edits later', () => {
    const md = htmlToMarkdown('<h2>Head</h2><p>Para one</p><ul><li>a</li><li>b</li></ul><ol start="3"><li>c</li></ol>')
    expect(md).toContain('## Head')
    expect(md).toContain('Para one')
    expect(md).toContain('- a')
    expect(md).toContain('3. c')
  })

  it('writes links, pictures and code the way a note wants them', () => {
    const md = htmlToMarkdown('<p>See <a href="https://x.example/a">the post</a> and <img src="https://cdn.example/i.png" alt="I"></p><pre><code class="language-ts">let a = 1</code></pre>')
    expect(md).toContain('[the post](https://x.example/a)')
    expect(md).toContain('![I](https://cdn.example/i.png)')
    expect(md).toContain('```ts\nlet a = 1\n```')
  })

  it('rewrites a relayed address back to the origin for a note that outlives the session', () => {
    const md = htmlToMarkdown('<img src="/api/rss/relay?url=https%3A%2F%2Fcdn.example%2Fa.png">', url => {
      const marker = '/api/rss/relay?url='
      const at = url.indexOf(marker)
      return at < 0 ? url : decodeURIComponent(url.slice(at + marker.length))
    })
    expect(md).toContain('![](https://cdn.example/a.png)')
  })

  it('keeps a nested list inside its parent and a quote as a quote', () => {
    const md = htmlToMarkdown('<ul><li>top<ul><li>deep</li></ul></li></ul><blockquote>said it</blockquote>')
    expect(md).toContain('- top\n  - deep')
    expect(md).toContain('> said it')
  })

  it('flattens a table it cannot spell rather than mis-rendering it', () => {
    const grid = htmlToMarkdown('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>')
    expect(grid).toContain('| a | b |')
    expect(grid).toContain('| 1 | 2 |')
    const merged = htmlToMarkdown('<table><tr><td colspan="2">wide</td></tr><tr><td>1</td><td>2</td></tr></table>')
    expect(merged).not.toContain('|')
    expect(merged).toContain('wide')
    expect(merged).toContain('1 · 2')
  })

  it('keeps a line break the author asked for', () => {
    expect(htmlToMarkdown('<p>one<br>two</p>')).toBe('one  \ntwo')
  })
})

describe('media', () => {
  it('recognises the video spellings a feed writes', () => {
    expect(videoLinkOf('https://www.youtube.com/watch?v=abcDEF12345&t=1')).toEqual({ host: 'YouTube', url: 'https://www.youtube.com/watch?v=abcDEF12345' })
    expect(videoLinkOf('https://youtu.be/abcDEF12345')).toEqual({ host: 'YouTube', url: 'https://www.youtube.com/watch?v=abcDEF12345' })
    expect(videoLinkOf('https://m.youtube.com/shorts/abcDEF12345')).toEqual({ host: 'YouTube', url: 'https://www.youtube.com/watch?v=abcDEF12345' })
    expect(videoLinkOf('https://www.bilibili.com/video/BV1xx411c7mD/?p=2')?.host).toBe('bilibili')
  })

  it('refuses a link that only looks like a video', () => {
    expect(videoLinkOf('https://www.youtube.com/watch')).toBeNull()
    expect(videoLinkOf('http://www.youtube.com/watch?v=abcDEF12345')).toBeNull()
    expect(videoLinkOf('https://player.bilibili.com/player.html?bvid=BV1xx411c7mD')).toBeNull()
    expect(videoLinkOf('https://example.com/watch?v=abcDEF12345')).toBeNull()
    expect(videoLinkOf('')).toBeNull()
  })

  it('plays only an enclosure a secure page can load', () => {
    expect(playableAudio('https://cdn.example/e.mp3')).toBe('https://cdn.example/e.mp3')
    expect(playableAudio('http://cdn.example/e.mp3')).toBe('')
    expect(playableAudio('')).toBe('')
  })
})
