import { describe, expect, it } from 'vitest'
import { joinCssPath, prefixSelector, rewriteUrls, scopeCss } from '../src/client/features/reading/engine/css-scope'

const scope = (css: string) => scopeCss(css, {
  scope: '.reader-doc',
  resolveUrl: (url) => `blob:resolved/${url}`,
}, 'OEBPS/style.css')

describe('prefixSelector', () => {
  it('confines an ordinary selector to the container', () => {
    expect(prefixSelector('p', '.reader-doc')).toBe('.reader-doc p')
    expect(prefixSelector('h1.title > span', '.reader-doc')).toBe('.reader-doc h1.title > span')
  })

  it('maps the document itself onto the container', () => {
    expect(prefixSelector('html', '.reader-doc')).toBe('.reader-doc')
    expect(prefixSelector('body', '.reader-doc')).toBe('.reader-doc')
    expect(prefixSelector(':root', '.reader-doc')).toBe('.reader-doc')
    expect(prefixSelector('html body', '.reader-doc')).toBe('.reader-doc')
    expect(prefixSelector('html > body > p', '.reader-doc')).toBe('.reader-doc p')
  })

  it('keeps a qualifier that belongs to the document on the container', () => {
    expect(prefixSelector('body.dark', '.reader-doc')).toBe('.reader-doc.dark')
    expect(prefixSelector('body[lang="zh"] p', '.reader-doc')).toBe('.reader-doc[lang="zh"] p')
  })

  it('does not mistake a longer element name for the document', () => {
    expect(prefixSelector('bodytext', '.reader-doc')).toBe('.reader-doc bodytext')
  })

  it('leaves an already-scoped selector alone', () => {
    expect(prefixSelector('.reader-doc p', '.reader-doc')).toBe('.reader-doc p')
  })
})

describe('rewriteUrls', () => {
  it('rewrites only what the reader can resolve', () => {
    const rewrite = (url: string) => (url.startsWith('http') || url.startsWith('data:') ? url : `blob:${url}`)
    expect(rewriteUrls('background: url(a.png); color: red', rewrite)).toContain('url("blob:a.png")')
    expect(rewriteUrls("src: url('https://x/f.woff2')", rewrite)).toContain('https://x/f.woff2')
    expect(rewriteUrls('src: url(data:font/woff2;base64,AAA)', rewrite)).toContain('data:font')
  })
})

describe('scopeCss', () => {
  it('confines a comma-separated selector list', async () => {
    const out = await scope('h1, h2, p > span { margin: 1em }')
    expect(out).toBe('.reader-doc h1,.reader-doc h2,.reader-doc p > span{margin: 1em}')
  })

  it('drops rules that would reach outside the book', async () => {
    const out = await scope('@page { margin: 0 } @charset "utf-8"; body { font-weight: 700 }')
    expect(out).toBe('.reader-doc{font-weight: 700}')
  })

  it('scopes the rules inside a media block and keeps its condition', async () => {
    const out = await scope('@media (max-width: 600px) { h1 { font-size: 1em } }')
    expect(out).toBe('@media (max-width: 600px){.reader-doc h1{font-size: 1em}}')
  })

  it('leaves @font-face global but resolves its file', async () => {
    const out = await scope('@font-face { font-family: "B"; src: url("fonts/b.woff2") format("woff2") }')
    expect(out).toContain('@font-face{')
    expect(out).toContain('blob:resolved/OEBPS/fonts/b.woff2')
    expect(out).not.toContain('.reader-doc')
  })

  it('survives a brace inside a quoted value', async () => {
    const out = await scope('p.note > span { content: "quoted } brace"; background: url(../images/note.png) }')
    expect(out).toContain('.reader-doc p.note > span')
    expect(out).toContain('"quoted } brace"')
    expect(out).toContain('blob:resolved/images/note.png')
  })

  it('follows an @import through the resolver and scopes what it finds', async () => {
    const out = await scopeCss('@import url("extra.css"); h1 { color: red }', {
      scope: '.reader-doc',
      resolveUrl: (url) => url,
      resolveImport: (path) => (path === 'OEBPS/extra.css' ? '.imported { text-indent: 1em }' : null),
    }, 'OEBPS/style.css')
    expect(out).toContain('.reader-doc .imported')
    expect(out).toContain('.reader-doc h1')
  })

  it('keeps a keyframes block addressable but out of the scope', async () => {
    const out = await scope('@keyframes fade { from { opacity: 0 } to { opacity: 1 } }')
    expect(out).toBe('@keyframes fade{from { opacity: 0 } to { opacity: 1 }}')
  })

  it('drops a stylesheet it cannot make sense of rather than emitting it raw', async () => {
    const out = await scope('p { margin: 0 /* no closing brace')
    expect(out).not.toContain('position: fixed')
    expect(out).toContain('p{margin: 0')
  })
})

describe('joinCssPath', () => {
  it('resolves a relative reference against the sheet that wrote it', () => {
    expect(joinCssPath('OEBPS/text', '../style/x.css')).toBe('OEBPS/style/x.css')
    expect(joinCssPath('', 'a.css')).toBe('a.css')
  })

  it('leaves an absolute or external reference alone', () => {
    expect(joinCssPath('OEBPS', 'https://cdn/x.css')).toBe('https://cdn/x.css')
    expect(joinCssPath('OEBPS', '/x.css')).toBe('/x.css')
  })
})
describe('the reader palette', () => {
  it('drops what the author painted the page with', async () => {
    const css = await scope('body { color: #222; font-size: 1em }')
    expect(css).toBe('.reader-doc{font-size: 1em}')
    expect(css).not.toContain('color')
  })

  it('drops a flat background but keeps an ornament', async () => {
    expect(await scope('p { background: #eee }')).toBe('.reader-doc p{}')
    expect(await scope('p { background-color: red }')).toBe('.reader-doc p{}')
    expect(await scope('p { background: url(art.png) no-repeat }')).toBe('.reader-doc p{background: url("blob:resolved/OEBPS/art.png") no-repeat}')
  })

  it('leaves everything that cannot make the prose unreadable', async () => {
    const css = await scope('h1 { border-color: red; text-align: center; --brand: #f00 }')
    expect(css).toContain('border-color: red')
    expect(css).toContain('text-align: center')
    expect(css).toContain('--brand: #f00')
  })

  it('keeps a font face untouched, semicolons and all', async () => {
    expect(await scope('@font-face { font-family: X; src: url(x.woff2); }')).toBe('@font-face{font-family: X; src: url("blob:resolved/OEBPS/x.woff2");}')
  })

  it('applies the same rule inside a media block', async () => {
    const css = await scope('@media (max-width: 40em) { p { color: blue; margin: 0 } }')
    expect(css).toContain('margin: 0')
    expect(css).not.toContain('color')
  })
})

describe('the chapter box', () => {
  it('refuses a book that would size or pin the page itself', async () => {
    const css = await scope('body { padding: 0; margin: 0; position: fixed; width: 100vw; overflow: hidden }')
    expect(css).toBe('.reader-doc{}')
  })

  it('leaves the same properties alone inside the chapter', async () => {
    const css = await scope('p { padding: 4px; margin: 1em; width: 40em; text-indent: 2em }')
    expect(css).toContain('padding: 4px')
    expect(css).toContain('margin: 1em')
    expect(css).toContain('width: 40em')
    expect(css).toContain('text-indent: 2em')
  })

  it('keeps a qualified root rule, which describes a variant rather than the page', async () => {
    const css = await scope('body.dark { padding: 8px }')
    expect(css).toBe('.reader-doc.dark{padding: 8px}')
  })
})

describe('the reader’s type', () => {
  it('takes the leading away from the book, wherever the book put it', async () => {
    const css = await scope('p { text-indent: 2em; line-height: 1.9 }')
    expect(css).toContain('text-indent: 2em')
    expect(css).not.toContain('line-height')
  })

  it('keeps a heading sized in em and drops one nailed to the page', async () => {
    expect(await scope('h1 { font-size: 1.6em }')).toContain('font-size: 1.6em')
    expect(await scope('h2 { font-size: 150% }')).toContain('font-size: 150%')
    expect(await scope('p { font-size: 14px }')).not.toContain('font-size')
    expect(await scope('blockquote { font-size: 0.9rem }')).not.toContain('font-size')
  })
})
