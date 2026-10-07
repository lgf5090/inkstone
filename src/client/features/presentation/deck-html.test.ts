import { describe, expect, it } from 'vitest'
import { createFenceBodies } from '../../lib/markdown/fence-bodies'
import { buildDeckHtmlDocument } from './deck-html'
import { buildDeckPages } from './deck-print'
import { rememberSlideHtml, slideCacheKey, slideSettingFlags } from './slide-html'
import { planSlidePages, type SlideBlock } from './slide-pagination'
import type { StageMetrics } from './slide-stage'

// N-33: a deck someone else can play. The file has to carry its own styles, its own navigation, and
// URLs that work from `file://` — and it has to be built from the same pages the projector walked,
// stepped states included, or the exported deck is a different talk.
const FLAGS = slideSettingFlags({ math: true, mermaid: true, chart: true })
const METRICS: StageMetrics = { scale: 1, designWidth: 1280, designHeight: 720, contentWidth: 1168, contentHeight: 632 }
const ORIGIN = 'https://notes.example'

const BLOCKS: SlideBlock[] = [
  { top: 0, height: 100, heading: true },
  { top: 100, height: 100, heading: false },
  { top: 200, height: 100, heading: false },
]

function document_of(html: string, extraHtml = '<p>plain</p>', plans: Record<number, ReturnType<typeof planSlidePages>> = {}) {
  const deck = ['<h2>One</h2>' + html, extraHtml]
  const cacheKeys = deck.map((_, index) => slideCacheKey({ fingerprint: 'fingerprint', dark: false, index, contentWidth: METRICS.contentWidth, contentHeight: METRICS.contentHeight }))
  rememberSlideHtml(cacheKeys[0], { html: `<h2>One</h2>${html}`, fences: createFenceBodies() })
  rememberSlideHtml(cacheKeys[1], { html: extraHtml, fences: createFenceBodies() })
  const pages = buildDeckPages(deck, cacheKeys, plans, METRICS, FLAGS)
  return buildDeckHtmlDocument({
    pages,
    metrics: METRICS,
    css: '.deck-print-page { background: var(--bg-editor) }',
    title: 'Quarterly Review',
    lang: 'en-US',
    font: 'sans',
    origin: ORIGIN,
    rootAttributes: 'data-theme="dark" data-accent="cinnabar"',
    labels: { previous: 'Previous', next: 'Next', deck: 'Deck navigation' },
  })
}

const sections = (file: string) => [...file.matchAll(/<section class="deck-print-page"([^>]*)>/g)].map((match) => match[1] ?? '')
const positions = (file: string) => sections(file).map((attributes) => /data-position="([^"]*)"/.exec(attributes)?.[1] ?? '')

describe('buildDeckHtmlDocument — a file that plays by itself', () => {
  it('is a complete document that opens as the deck it was exported from', () => {
    const file = document_of('<p>two</p>')
    expect(file.startsWith('<!doctype html>')).toBe(true)
    expect(file).toContain('<html lang="en-US" ')
    expect(file).toContain('<title>Quarterly Review</title>')
    expect(file).toContain('.deck-print-page { background: var(--bg-editor) }')
  })

  it('shows its first page and hands the rest to the keys', () => {
    const file = document_of('<p>two</p>')
    expect(file).toContain('data-current')
    expect(sections(file).filter((attributes) => attributes.includes('data-current'))).toHaveLength(1)
    expect(file).toContain('addEventListener')
    expect(file).toContain('ArrowRight')
  })

  it('offers the turn as buttons a pointer and a screen reader both reach', () => {
    const file = document_of('<p>two</p>')
    expect(file).toContain('<button type="button" data-deck-html-prev')
    expect(file).toContain('>Next</button>')
    expect(file).toContain('aria-live')
    // The printed number and the spoken one are the same derivation, printed twice rather than spelled twice.
    expect(file).toContain('deck-html-position')
  })

  it('keeps the sheet the printer reads, so printing the file prints the deck', () => {
    const file = document_of('<p>two</p>')
    expect(file).toContain('class="deck-print-sheet"')
    expect(file).toContain('data-deck-print')
    expect(file).toContain('@page { size: 1280px 720px')
  })

})

describe('buildDeckHtmlDocument — the states the show walked, in order', () => {
  it('holds one page per state the show walked, numbered the way the room read them', () => {
    const stepped = planSlidePages(BLOCKS, 632, undefined, true)
    const deck = ['<h2>One</h2><p>two</p><p>three</p>', '<p>plain</p>']
    const cacheKeys = deck.map((_, index) => slideCacheKey({ fingerprint: 'stepped', dark: false, index, contentWidth: METRICS.contentWidth, contentHeight: METRICS.contentHeight }))
    rememberSlideHtml(cacheKeys[0], { html: deck[0]!, fences: createFenceBodies() })
    rememberSlideHtml(cacheKeys[1], { html: deck[1]!, fences: createFenceBodies() })
    const file = buildDeckHtmlDocument({
      pages: buildDeckPages(deck, cacheKeys, { 0: stepped }, METRICS, FLAGS),
      metrics: METRICS,
      css: '',
      title: 'Stepped',
      lang: 'en-US',
      font: 'sans',
      origin: ORIGIN,
    rootAttributes: 'data-theme="dark" data-accent="cinnabar"',
      labels: { previous: 'Previous', next: 'Next', deck: 'Deck navigation' },
    })
    expect(positions(file)).toEqual(['1 / 2 · 1/3', '1 / 2 · 2/3', '1 / 2 · 3/3', '2 / 2'])
  })

})

describe('buildDeckHtmlDocument — what the file says about itself', () => {
  // Every colour token of this app is declared under `:root[data-theme=…]`, so a file that carries the
  // stylesheets without the attributes has the rules and none of the colours.
  it('is wearing the theme the deck was read in', () => {
    const file = document_of('<p>two</p>')
    expect(file).toContain('<html lang="en-US" data-theme="dark" data-accent="cinnabar">')
  })

  // The typeface a deck is read in is carried by `.ink-prose[data-font]` on this fork — not by a
  // wrapper class, which the reference had and this project never defined a rule for. Put the
  // attribute on the wrong element and the exported file silently loses the reader's serif choice.
  it('hands the typeface to the element the stylesheet reads it from', () => {
    const file = buildDeckHtmlDocument({
      pages: buildDeckPages(['<h2>One</h2>'], ['k0'], {}, METRICS, FLAGS),
      metrics: METRICS,
      css: '',
      title: 'Typeface',
      lang: 'en-US',
      font: 'serif',
      origin: ORIGIN,
      rootAttributes: 'data-theme="dark"',
      labels: { previous: 'P', next: 'N', deck: 'D' },
    })
    expect(file).toContain('class="ink-prose relative" data-font="serif"')
    expect(file).not.toContain('ink-preview-container')
  })

  // The file leaves this app in somebody else's hands, so it says what it may reach for: its own
  // pictures and nothing else — no form to post to, no plugin, no `<base>` to re-point every
  // relative URL at another host, and no `fetch` to carry the note's text away.
  it('tells a stranger’s browser what the file may not reach for', () => {
    const file = document_of('<p>two</p>')
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(file)?.[1]
    expect(policy, 'the exported file carries no policy').toBeTruthy()
    const directives = new Map((policy ?? '').split('; ').map((part) => {
      const split = part.indexOf(' ')
      return [part.slice(0, split), part.slice(split + 1)]
    }))
    expect(directives.get('default-src')).toBe("'none'")
    expect(directives.get('connect-src')).toBe("'none'")
    expect(directives.get('form-action')).toBe("'none'")
    expect(directives.get('object-src')).toBe("'none'")
    expect(directives.get('base-uri')).toBe("'none'")
    expect(directives.get('img-src')).toContain('data:')
    expect(file).toContain('<script>')
  })

  it('escapes what a note title is not allowed to become', () => {    const file = document_of('<p>two</p>').replace('<title>Quarterly Review</title>', '<title>x</title>')
    const hostile = buildDeckHtmlDocument({
      pages: [],
      metrics: METRICS,
      css: '',
      title: 'Q1 </title><script>alert(1)</script>',
      lang: 'en-US',
      font: 'sans',
      origin: ORIGIN,
    rootAttributes: 'data-theme="dark" data-accent="cinnabar"',
      labels: { previous: 'P', next: 'N', deck: 'D' },
    })
    expect(hostile).not.toContain('<script>alert(1)</script>')
    expect(hostile).toContain('&lt;script&gt;')
    expect(file).toContain('<title>x</title>')
  })
})

describe('buildDeckHtmlDocument — what an attachment has to travel as', () => {
  it('writes a hosted attachment as a whole URL the file:// page can fetch', () => {
    const file = document_of('<img src="/api/files/attachment-1.png" alt="chart">')
    expect(file).toContain(`${ORIGIN}/api/files/attachment-1.png`)
    expect(file).not.toContain('src="/api/files/')
  })

  it('leaves an absolute URL and a data URI alone', () => {
    const file = document_of('<img src="https://cdn.example/pic.png" alt="remote"><img src="data:image/png;base64,iVBOR" alt="inline">')
    expect(file).toContain('src="https://cdn.example/pic.png"')
    expect(file).toContain('src="data:image/png;base64,iVBOR"')
  })

  it('rewrites a document reference the same way, so a slide link still leaves the deck', () => {
    const file = document_of('<a href="/note/second">second</a>')
    expect(file).toContain(`href="${ORIGIN}/note/second"`)
  })

  // The parser resolves `http:/broken` against *nothing* and hands back `http://broken/`, so a
  // reference that already carries a scheme is a stop signal for the rewrite, not input to it.
  it('leaves a reference that only looks like a URL as the author wrote it', () => {
    const file = document_of('<a href="http:/broken">odd</a><a href="mailto:talk@example.com">mail</a>')
    expect(file).toContain('href="http:/broken"')
    expect(file).toContain('href="mailto:talk@example.com"')
  })

  it('keeps a fragment in place and does not touch an empty link', () => {
    const file = document_of('<a href="#anchor">jump</a><a>nothing</a>')
    expect(file).toContain('href="#anchor"')
    expect(file).not.toContain(`href="${ORIGIN}"`)
  })
})
