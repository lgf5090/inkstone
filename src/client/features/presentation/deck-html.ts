import { safeFileName } from '../../lib/export-note'
import { saveImage } from '../../lib/element-image'
import { formatDeckPosition } from './deck-position'
import type { DeckPrintPage } from './deck-print'
import { LAYOUT_CLASS } from './slide-prose'
import { SLIDE_PAD_X, SLIDE_PAD_Y } from './slide-stage'
import type { StageMetrics } from './slide-stage'
import type { ProseFont } from '@shared/types'

// N-33: the deck as a file someone else can play. The other two exports hand over pictures of the
// show; this one hands over the show — the same pages, the same styles, and a few lines of navigation
// — so a deck reaches a person who has never opened Inkstone, by double-click.
//
// It is a pure builder over the pages `buildDeckPages` already made: states the projector walked
// one by one (steps included) stay one page each here, and every number in the file is written by the
// same function the projector reads its own out of.

/** How much of the window the control bar takes, so the page fits the space that is left. */
const DECK_HTML_BAR = 64

export interface DeckHtmlLabels {
  previous: string
  next: string
  /** The bar's accessible name: what the two controls together are for. */
  deck: string
}

export interface DeckHtmlInput {
  pages: DeckPrintPage[]
  metrics: StageMetrics
  /** The stylesheets the document is wearing, from `collectDeckCss()`. */
  css: string
  title: string
  lang: string
  font: ProseFont
  /** What the app's own origin is: a file opened from disk has none, so every hosted reference has to
   * leave the page as a whole URL. */
  origin: string
  /** The live document's theming attributes, verbatim — see `deckThemeAttributes`. */
  rootAttributes: string
  labels: DeckHtmlLabels
}

export function buildDeckHtmlDocument(input: DeckHtmlInput): string {
  const { pages, metrics, css, title, lang, font, origin, labels } = input
  const geometry = deckHtmlGeometry(metrics)
  const sheets = pages.map((page, index) => deckHtmlPage(page, index, font, metrics, origin)).join('\n')
  return `<!doctype html>
<html lang="${escapeAttribute(lang)}" ${input.rootAttributes}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}${geometry}</style>
</head>
<body class="deck-html-body">
<div class="deck-print-sheet" data-deck-print data-deck-html-stage>${sheets}</div>
<div class="deck-html-bar" role="toolbar" aria-label="${escapeAttribute(labels.deck)}">
<button type="button" data-deck-html-prev>${escapeHtml(labels.previous)}</button>
<span class="deck-html-position" data-deck-html-position aria-live="polite">${escapeHtml(pages[0] ? deckHtmlPosition(pages[0]!) : '')}</span>
<button type="button" data-deck-html-next>${escapeHtml(labels.next)}</button>
</div>
<script>${deckHtmlScript(metrics)}</script>
</body>
</html>
`
}

/**
 * The attributes the running document hangs its theme on, as the exported file has to carry them.
 *
 * Every colour token is declared under `:root[data-theme=…]` (and its `data-background` / `data-accent`
 * partners), so a file that copies the stylesheets but not the attributes collects the colour *rules*
 * and none of the colours: the deck comes out transparent-on-black regardless of what the room saw.
 */
export function deckThemeAttributes(root: Element): string {
  return ['data-theme', 'data-background', 'data-accent', 'class']
    .filter((name) => root.hasAttribute(name))
    .map((name) => `${name}="${escapeAttribute(root.getAttribute(name) ?? '')}"`)
    .join(' ')
}

/** Save the file under the note's own name, the way the image export saves its archive. */
export function saveDeckHtml(html: string, title: string): void {
  saveImage(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeFileName(title) || 'deck'}.html`)
}

/**
 * Hosted references rewritten against the app's origin.
 *
 * A page opened from `file://` has no origin of its own, so `/api/files/x.png` would resolve against
 * the disk and every attachment would come out broken. Absolute URLs, `data:`/`blob:` pictures and a
 * bare `#fragment` are left exactly as they were: the first two already travel, and the last one is
 * not a request.
 */
export function absolutizeDeckHtml(html: string, origin: string): string {
  if (!origin) return html
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
  for (const element of parsed.querySelectorAll<HTMLElement>('[src], [href], [xlink\\:href], [poster]')) {
    for (const name of ['src', 'href', 'xlink:href', 'poster']) {
      const value = element.getAttribute(name)
      if (!value || !needsOrigin(value)) continue
      const absolute = joinAgainstOrigin(value, origin)
      if (absolute) element.setAttribute(name, absolute)
    }
  }
  return parsed.body.innerHTML
}

// A reference that still has work to do: not empty, not a bare fragment, and not carrying a scheme of
// its own (`data:`, `blob:`, `mailto:`, an absolute URL). A protocol-relative `//host/x` has no scheme
// and does need one, which `new URL()` answers with the app's protocol.
function needsOrigin(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return false
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
}

function joinAgainstOrigin(value: string, origin: string): string {
  try {
    return new URL(value, origin).href
  }
  catch {
    // A reference the URL parser refuses is left as the author wrote it: a slide with one broken link
    // still exports as a deck, and the link is no worse in the file than it was on the projector.
    return value
  }
}

function deckHtmlPage(page: DeckPrintPage, index: number, font: ProseFont, metrics: StageMetrics, origin: string): string {
  const position = deckHtmlPosition(page)
  const layout = page.layout
  const prose = `ink-prose relative${layout ? ` ${LAYOUT_CLASS[layout]}` : ''}`
  const proseStyle = layout === 'cover' ? ` style="min-height:${metrics.contentHeight}px"` : ''
  return `<section class="deck-print-page"${index === 0 ? ' data-current' : ''} data-position="${escapeAttribute(position)}">
<div class="deck-print-body ink-slide"><div class="mx-auto" style="width:${metrics.contentWidth}px"><div class="ink-preview-container" data-font="${escapeAttribute(font)}"><div class="${prose}" data-slide-page${proseStyle}>${absolutizeDeckHtml(page.html, origin)}</div></div></div></div>
<span class="deck-print-page-number">${escapeHtml(position)}</span>
</section>`
}


function deckHtmlPosition(page: DeckPrintPage): string {
  return formatDeckPosition(page.position)
}

/** The page box and its pads, on the same rule the printed sheet uses, so the file prints like the
 * deck printed. */
function deckHtmlGeometry(metrics: StageMetrics): string {
  const width = Math.round(metrics.designWidth)
  const height = Math.round(metrics.designHeight)
  return `\n@page { size: ${width}px ${height}px; margin: 0 }
@media print { .deck-html-body .deck-print-page { display: block; transform: none } }\n[data-deck-print] { --deck-page-width: ${width}px; --deck-page-height: ${height}px; --deck-pad-x: ${SLIDE_PAD_X}; --deck-pad-y: ${SLIDE_PAD_Y}; }`
}

function deckHtmlScript(metrics: StageMetrics): string {
  return DECK_HTML_SCRIPT
    .replace('__WIDTH__', String(Math.round(metrics.designWidth)))
    .replace('__HEIGHT__', String(Math.round(metrics.designHeight)))
    .replace('__BAR__', String(DECK_HTML_BAR))
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character)
}

function escapeAttribute(text: string): string {
  return text.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character)
}

// The whole of the file's own behaviour: which page is on screen, what the two keys and the two
// buttons do with it, and how big the page box has to be drawn to fit this window. It reads the page
// numbers out of the markup rather than recomputing them, so a file cannot disagree with the deck it
// came from.
const DECK_HTML_SCRIPT = `(() => {
  const pages = [...document.querySelectorAll('.deck-print-page')]
  const position = document.querySelector('[data-deck-html-position]')
  const previous = document.querySelector('[data-deck-html-prev]')
  const upcoming = document.querySelector('[data-deck-html-next]')
  const stage = document.querySelector('[data-deck-html-stage]')
  const design = { width: __WIDTH__, height: __HEIGHT__, bar: __BAR__ }
  let current = 0
  const fit = () => {
    const scale = Math.min(window.innerWidth / design.width, (window.innerHeight - design.bar) / design.height, 1)
    document.documentElement.style.setProperty('--deck-html-scale', String(scale > 0 ? scale : 1))
  }
  const show = (at) => {
    current = Math.min(Math.max(at, 0), pages.length - 1)
    pages.forEach((page, index) => {
      if (index === current) page.setAttribute('data-current', '')
      else page.removeAttribute('data-current')
    })
    if (position) position.textContent = pages[current]?.dataset.position ?? ''
    if (previous) previous.disabled = current === 0
    if (upcoming) upcoming.disabled = current >= pages.length - 1
  }
  const move = (step) => show(current + step)
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ' || event.key === 'ArrowDown') move(1)
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp' || event.key === 'ArrowUp') move(-1)
    else if (event.key === 'Home') show(0)
    else if (event.key === 'End') show(pages.length - 1)
    else return
    event.preventDefault()
  })
  // The left half of the screen goes back, the right half forward: the same reading the projector
  // gives a pointer, so a presenter who never opens the help still turns pages the way they already do.
  stage?.addEventListener('click', (event) => {
    const target = event.target
    if (target instanceof Element && target.closest('a, button')) return
    move(event.clientX < window.innerWidth / 2 ? -1 : 1)
  })
  window.addEventListener('resize', fit)
  previous?.addEventListener('click', () => move(-1))
  upcoming?.addEventListener('click', () => move(1))
  fit()
  show(current)
})()
`
