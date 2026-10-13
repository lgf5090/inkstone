/**
 * Making a stranger's HTML safe enough to put inside the notebook.
 *
 * An article body is the one place in this app where the markup was written by nobody the reader
 * trusts, and it arrives through a relay that cannot read it. So it is sanitized on the way in —
 * once, before it is cached or written to a note — and the pass that renders it is a plain
 * `innerHTML` of the result. Two things follow from that ordering, and both are why this file
 * exists rather than a call to DOMPurify at the render site: the string a reader saves into a note
 * has to be the same safe string they were shown, and the sanitizer must not be the kind that lets
 * an `<img onerror>` through because it was configured for a different surface.
 *
 * Where the pictures come from is a *display* question, not a safety one, so it is answered
 * separately. A cached body keeps the addresses its author wrote; the reader's setting for
 * relaying, and the setting for showing pictures at all, are applied each time the body is drawn.
 * Changing that setting therefore needs no re-fetch, and a note saved from the article gets the
 * original addresses rather than a link that only works while this session lasts.
 */
import DOMPurify from 'dompurify'
import { safeHttpUrl } from '@shared/rss/model'

const ALLOWED_TAGS = [
  'a', 'abbr', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section',
  'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
]

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'span', 'start', 'reversed',
  'type', 'align', 'lang', 'dir', 'datetime', 'id', 'headers', 'scope',
]

// The lazy-load attributes are the only `data-*` a body may keep, and only long enough to be
// read: they carry a picture's real address in the markup feeds write, and are removed on the way out.
/** Attributes a lazy-loading feed hides its real address behind. */
const LAZY_SRC_ATTRS = ['data-src', 'data-original-src', 'data-original', 'data-lazy-src']

const CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ADD_ATTR: [...LAZY_SRC_ATTRS],
  ALLOW_DATA_ATTR: false,
}

/**
 * The safety pass. Runs once, before a body is cached or written to a note.
 *
 * `<svg>` is not in the list on purpose: an SVG is a script with a picture attached, and a feed
 * that ships one loses the illustration rather than gaining a runner.
 *
 * `base` is the article's own address. A feed writes `/images/inline.png` and `/posts/2` meaning
 * *its* server, and an unresolved relative address would be read as one into this notebook — a
 * picture that never loads and a link that leaves the reader on their own instance with a 404.
 */
export function sanitizeFeedHtml(html: string, base?: string): string {
  const clean = DOMPurify.sanitize(html || '', CONFIG)
  if (!base) return clean
  const host = document.createElement('template')
  host.innerHTML = clean
  for (const node of Array.from(host.content.querySelectorAll('[src],[href]'))) {
    const attribute = node.hasAttribute('src') ? 'src' : 'href'
    const raw = node.getAttribute(attribute) || ''
    const resolved = safeHttpUrl(raw, base)
    // An address that is not http(s) after resolution — `mailto:`, `javascript:`, a fragment-only
    // pointer to a page that is not this one — is dropped rather than kept for the browser to guess.
    if (resolved) node.setAttribute(attribute, resolved.href)
    else node.removeAttribute(attribute)
  }
  return host.innerHTML
}

export interface DisplayOptions {
  images: 'relay' | 'direct' | 'off'
  /** Where a relayed address goes. Injected so this module stays free of the API client. */
  relay: (url: string) => string
}

/**
 * The display pass: sanitize again (cheap, and it covers a body cached by an older build), then
 * apply the reader's picture policy and make every link open somewhere they can read.
 *
 * The template round-trip is safe because the string it is handed has already been through
 * DOMPurify: nothing that parses here can execute.
 */
export function articleDisplayHtml(html: string, options: DisplayOptions): string {
  const host = document.createElement('template')
  host.innerHTML = sanitizeFeedHtml(html)
  for (const node of Array.from(host.content.querySelectorAll('*'))) {
    const tag = node.tagName.toLowerCase()
    if (tag === 'img') {
      if (options.images === 'off') {
        node.remove()
        continue
      }
      const declared = LAZY_SRC_ATTRS.map(attribute => node.getAttribute(attribute)).find(Boolean)
      const written = node.getAttribute('src') || ''
      for (const attribute of LAZY_SRC_ATTRS) node.removeAttribute(attribute)
      // A lazy-loading feed puts a placeholder in `src` and the real picture in `data-src`, so the
      // placeholder is only believed when it is an address of its own.
      const url = safeHttpUrl(written) || safeHttpUrl(declared || '')
      // srcset would let the browser pick a candidate the relay never saw, so the choice is taken
      // away rather than trusted to agree with us.
      node.removeAttribute('srcset')
      node.removeAttribute('sizes')
      if (!url) node.remove()
      else if (options.images === 'relay') node.setAttribute('src', options.relay(url.href))
      node.setAttribute('loading', 'lazy')
      node.setAttribute('decoding', 'async')
      node.setAttribute('referrerpolicy', 'no-referrer')
      continue
    }
    if (tag === 'a') {
      const url = safeHttpUrl(node.getAttribute('href') || '')
      if (!url) {
        node.replaceWith(...Array.from(node.childNodes))
        continue
      }
      node.setAttribute('href', url.href)
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  }
  return host.innerHTML
}

/** The address a thumbnail or an article picture is pointed at under the reader's policy. */
export function displayImageUrl(url: string, options: DisplayOptions): string {
  if (!url || options.images === 'off') return ''
  const safe = safeHttpUrl(url)
  if (!safe) return ''
  return options.images === 'relay' ? options.relay(safe.href) : safe.href
}

/** Text an article boils down to: what a note header or a search row can hold. */
export function htmlToText(html: string, max = 400): string {
  // Block ends become spaces first: `textContent` would otherwise glue `</li><li>` and `</p><p>`
  // together into one word, and a summary of a list then reads as a typo.
  const spaced = (html || '')
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr|td|th|pre|ul|ol|section|article|figcaption)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
  const host = document.createElement('div')
  host.innerHTML = DOMPurify.sanitize(spaced, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
  return (host.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

const minutesCache = new Map<string, number>()
const wordCache = new Map<string, number>()

/** One character of a Han, kana or hangul script is one word of it. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff66-\uff9f]/g

/**
 * How many words the body is, counting a CJK character as a word and a Latin run as one.
 *
 * The reference only has a word count for podcasts, because its server supplies one; this is the
 * local answer to the same question, and it has to be script-aware or a Chinese article reads as one
 * long word. Cached the same way as the minutes, because the list asks per row.
 */
export function wordCount(entry: { id: string, content: string, summary: string }): number {
  const key = `${entry.id}:${entry.content.length}:${entry.summary.length}`
  const hit = wordCache.get(key)
  if (hit !== undefined) return hit
  const text = (entry.content || entry.summary).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ')
  const words = (text.match(CJK) || []).length + (text.replace(CJK, ' ').match(/[\p{L}\p{N}]+/gu) || []).length
  if (wordCache.size > 4000) wordCache.clear()
  wordCache.set(key, words)
  return words
}

/**
 * How long the body would take to read, in whole minutes, at four hundred characters a minute.
 *
 * A rate, not a promise: it is the number a reader uses to decide whether to open something now or
 * star it for later. Cached by id and body length because the list asks for sixty rows at a time
 * and a body can be a hundred kilobytes.
 */
export function readingMinutes(entry: { id: string, content: string, summary: string }): number {
  const key = `${entry.id}:${entry.content.length}`
  const hit = minutesCache.get(key)
  if (hit !== undefined) return hit
  const text = entry.content || entry.summary
  const chars = text ? text.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length : 0
  const minutes = chars ? Math.max(1, Math.round(chars / 400)) : 0
  if (minutesCache.size > 4000) minutesCache.clear()
  minutesCache.set(key, minutes)
  return minutes
}
