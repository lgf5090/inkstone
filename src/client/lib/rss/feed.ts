/**
 * Feed and OPML parsing, kept apart from everything that fetches or stores.
 *
 * It runs in the browser and in jsdom, so `DOMParser` is a parameter rather than a global: the
 * Worker has no DOM at all, and a test can hand in the document it wants. The reference reader this
 * port follows learned the hard way that feeds are not XML-only — a third of the wild serves a
 * document whose namespaces are inconsistent, whose dates carry no zone, and whose "HTML" body is
 * an escaped copy of itself. Each of those has a branch below.
 *
 * Nothing here sanitizes. It resolves every address to an absolute one, which is what lets the
 * client's sanitizer be a single pass over `src`/`href` with no base URL to carry along.
 */

import {
  canonicalFeedUrl,
  entryIdFor,
  rssHash,
  safeHttpUrl,
  RSS_LIMITS,
  type RssEntry,
} from '@shared/rss/model'

export interface FeedMeta {
  title: string
  siteUrl: string
  imageUrl: string
}

export interface ParsedFeed extends FeedMeta {
  entries: RssEntry[]
  /** How many items the document held that could not be kept. */
  skipped: number
}

export interface OpmlFeed {
  url: string
  title: string
  /** The joined label, for the preview list. */
  group: string
  /** The outline chain that label came from, so a nested folder survives a round trip. */
  groupPath: string[]
}

export interface ParsedOpml {
  feeds: OpmlFeed[]
  skipped: number
}

export class FeedParseError extends Error {}

/** Items scanned before the byte and count ceilings take over, matching the reference's window. */
const SCAN_LIMIT = 200
const MAX_XML_CHARS = 6 * 1024 * 1024

/**
 * Named entities HTML knows and XML does not.
 *
 * A feed that writes `&nbsp;` into an item body is not valid XML, and a strict parser refuses the
 * whole document over it — which in the wild reads as "this blog is broken" for feeds that are
 * perfectly readable in every other reader. Rewriting them to numeric references keeps the meaning
 * and the document.
 */
const XML_UNSAFE_ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/gi, '&#160;'],
  [/&copy;/gi, '&#169;'],
  [/&reg;/gi, '&#174;'],
  [/&mdash;/gi, '&#8212;'],
  [/&ndash;/gi, '&#8211;'],
  [/&hellip;/gi, '&#8230;'],
  [/&rsquo;/gi, '&#8217;'],
  [/&lsquo;/gi, '&#8216;'],
  [/&rdquo;/gi, '&#8221;'],
  [/&ldquo;/gi, '&#8220;'],
  [/&middot;/gi, '&#183;'],
  [/&bull;/gi, '&#8226;'],
  [/&trade;/gi, '&#8482;'],
]

function repairXml(text: string): string {
  return XML_UNSAFE_ENTITIES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text)
}

/** The prefixes feeds use, and the namespaces they are supposed to point at. */
const KNOWN_NAMESPACES: Array<[string, string]> = [
  ['content', 'http://purl.org/rss/1.0/modules/content/'],
  ['dc', 'http://purl.org/dc/elements/1.1/'],
  ['media', 'http://search.yahoo.com/mrss/'],
  ['atom', 'http://www.w3.org/2005/Atom'],
  ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
  ['itunes', 'http://www.itunes.com/dtds/podcast-1.0.dtd'],
  ['sr', 'http://www.sitepoint.com/Site-Updates/'],
  ['wfw', 'http://wellknownweb.org/xmlns/1.0/'],
]

/**
 * Declare the prefixes a document uses but forgot to bind.
 *
 * An undeclared prefix is a fatal XML error, and a feed generator that hand-writes its items can
 * ship one for years while every browser-based reader calls the whole site dead. This runs only
 * after a strict parse has already failed, so a well-formed document is never rewritten.
 */
function injectNamespaces(value: string): string {
  const start = value.search(/<[A-Za-z_][\w.:-]*(?=[\s>])/)
  if (start < 0) return value
  const open = /<[A-Za-z_][\w.:-]*[^>]*>/.exec(value.slice(start))
  if (!open) return value
  const tag = open[0]
  const declared = new Set([...tag.matchAll(/xmlns:([\w.-]+)/g)].map(match => match[1]))
  const used = new Set([...value.matchAll(/<\/?[\w.-]*?([A-Za-z_][\w.-]*):[\w.-]+[\s/>]/g)].map(match => match[1]))
  const additions = KNOWN_NAMESPACES
    .filter(([prefix, uri]) => used.has(prefix) && !declared.has(prefix) && !value.includes(`xmlns:${prefix}="${uri}"`))
    .map(([prefix, uri]) => ` xmlns:${prefix}="${uri}"`)
    .join('')
  if (!additions) return value
  const insertAt = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1
  return `${value.slice(0, start + insertAt)}${additions}${value.slice(start + insertAt)}`
}

function doc(value: string, parser: DOMParser): Document {
  if (value.length > MAX_XML_CHARS) throw new FeedParseError('feed document is too large')
  // An internal-entity expansion loop parses into a document far bigger than the bytes it came in
  // on, and no size ceiling downstream sees it coming. Feeds do not need a doctype; refuse the ones
  // that carry one.
  if (/<!DOCTYPE|<!ENTITY/i.test(value.slice(0, 4096))) throw new FeedParseError('feed document declares a DTD')
  const repaired = repairXml(value)
  let parsed = parser.parseFromString(repaired, 'application/xml')
  if (parsed.getElementsByTagName('parsererror')[0]) {
    parsed = parser.parseFromString(injectNamespaces(repaired), 'application/xml')
  }
  const failure = parsed.getElementsByTagName('parsererror')[0]
  if (failure) throw new FeedParseError('feed document is not readable XML')
  const root = parsed.documentElement
  if (!root || root.localName === 'parsererror') throw new FeedParseError('feed document is empty')
  return parsed
}

function children(node: Element, name: string): Element[] {
  const out: Element[] = []
  for (const child of Array.from(node.children)) {
    if (child.localName === name) out.push(child)
  }
  return out
}

function child(node: Element | undefined | null, ...names: string[]): Element | undefined {
  if (!node) return undefined
  for (const name of names) {
    const found = children(node, name)[0]
    if (found) return found
  }
  return undefined
}

function text(node: Element | undefined | null, ...names: string[]): string {
  if (!node) return ''
  for (const name of names) {
    const value = child(node, name)?.textContent?.trim()
    if (value) return value
  }
  return ''
}

/** The nearest `xml:base` up the tree, falling back to the address the document came from. */
function baseUrl(node: Element, fallback: string): string {
  let base = fallback
  const chain: Element[] = []
  let current: Element | null = node
  while (current) {
    chain.unshift(current)
    current = current.parentElement
  }
  for (const element of chain) {
    const declared = element.getAttribute('xml:base')
      || element.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'base')
    const resolved = safeHttpUrl(declared || '', base)
    if (resolved) base = resolved.href
  }
  return base
}

function absolute(value: string | undefined | null, base: string): string {
  if (!value) return ''
  const url = safeHttpUrl(value.trim(), base)
  return url ? url.href : ''
}

/**
 * A date a feed actually wrote.
 *
 * A zone-less RFC 822 date is the common case from hand-maintained feeds, and reading it in the
 * reader's own zone would sort the same feed differently in two browsers, so it is pinned to UTC.
 */
export function parseFeedDate(value: string): number | null {
  const raw = (value || '').trim()
  if (!raw) return null
  const normalised = /^[A-Za-z]{3},?\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw} UTC`
    : raw
  const ts = Date.parse(normalised)
  if (Number.isFinite(ts)) return ts
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw)
  if (!iso) return null
  const parts = [iso[1], iso[2], iso[3], iso[4] ?? '0', iso[5] ?? '0', iso[6] ?? '0'].map(Number)
  const built = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5])
  return Number.isFinite(built) ? built : null
}

/** Tag-free, collapsed text: what a title or a one-line summary has to become. */
export function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function fromCodePoint(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
}

/**
 * An Atom `<title type="xhtml">` or `<content type="xhtml">` holds real markup as child nodes;
 * `type="html"` holds escaped markup in its text. Anything else is literal text.
 */
function atomBody(node: Element | undefined): string {
  if (!node) return ''
  const type = node.getAttribute('type') || ''
  if (type === 'xhtml' || (type !== 'text' && type !== 'html' && node.children.length)) {
    return Array.from(node.children).map(el => el.outerHTML).join('')
  }
  const value = node.textContent || ''
  if (type === 'html') return value
  return `<p>${escapeHtml(value)}</p>`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A body that arrived escaped one time too many.
 *
 * Only a document that *is* escaped markup gets a pass: real markup already in the text rules it
 * out, and so does a sentence that merely mentions `&lt;br&gt;` somewhere inside it. Unescaping
 * prose like that would turn the author's own example into live markup, which is the opposite of
 * what they wrote.
 */
const ESCAPED_BLOCK_START = /^&lt;(?:p|div|section|article|h\d|ul|ol|li|table|figure|blockquote|pre)\b/i

function unescapeOnce(value: string): string {
  const trimmed = value.trim()
  if (!ESCAPED_BLOCK_START.test(trimmed) || /<[a-zA-Z/]/.test(trimmed)) return value
  return trimmed
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => fromCodePoint(Number.parseInt(code, 16)))
}

interface RawItem {
  title: string
  link: string
  identity: string
  published: string
  author: string
  body: string
  bodyBase: string
  imageUrl: string
  audioUrl: string
}

/** A `media:thumbnail`, an image `media:content`, an image enclosure or a preview link. */
function itemImage(node: Element, base: string): string {
  for (const child of Array.from(node.getElementsByTagName('*'))) {
    const name = (child.localName || '').toLowerCase()
    const type = (child.getAttribute('type') || '').toLowerCase()
    const medium = child.getAttribute('medium') || ''
    const rel = child.getAttribute('rel') || ''
    const isImage = name === 'thumbnail'
      || (name === 'content' && (medium === 'image' || type.startsWith('image/')))
      || (name === 'enclosure' && type.startsWith('image/'))
      || (name === 'link' && rel === 'preview' && type.startsWith('image/'))
    if (!isImage) continue
    const found = absolute(child.getAttribute('url') || child.getAttribute('href'), baseUrl(child, base))
    if (found) return found
  }
  return ''
}

/** The channel's own picture: RSS uses `image > url`, Atom uses `logo` or `icon`. */
function feedImage(host: Element, base: string): string {
  return itemImage(host, base)
    || absolute(child(host, 'image') ? text(child(host, 'image'), 'url', 'href') : '', base)
    || absolute(text(host, 'logo') || text(host, 'icon'), base)
}

function itemAudio(item: Element, base: string): string {
  for (const node of Array.from(item.children)) {
    const name = (node.localName || '').toLowerCase()
    const rel = node.getAttribute('rel') || ''
    const type = (node.getAttribute('type') || '').toLowerCase()
    const medium = node.getAttribute('medium') || ''
    const encloses = name === 'enclosure'
      || (name === 'link' && rel === 'enclosure')
      || (name === 'content' && (medium === 'audio' || type.startsWith('audio/')))
    if (!encloses) continue
    if (type && !type.startsWith('audio/')) continue
    const found = absolute(node.getAttribute('url') || node.getAttribute('href'), baseUrl(node, base))
    // A plain-HTTP enclosure would be blocked as mixed content on an HTTPS deployment, so it is
    // dropped here rather than rendered as a player that cannot load.
    if (found.startsWith('https://')) return found
  }
  return ''
}

function readItems(root: Element, atom: boolean, feedUrl: string): RawItem[] {
  const channel = child(root, 'channel')
  const container = atom ? root : root.localName === 'RDF' ? root : channel ?? root
  const nodes = atom ? children(root, 'entry') : children(container, 'item')
  const items: RawItem[] = []
  for (const item of nodes.slice(0, SCAN_LIMIT)) {
    const base = baseUrl(item, feedUrl)
    if (atom) {
      const linkNode = children(item, 'link').find((el) => {
        const rel = el.getAttribute('rel')
        return !rel || rel === 'alternate'
      })
      const bodyNode = child(item, 'content') || child(item, 'summary')
      items.push({
        title: plainText(atomBody(child(item, 'title'))),
        link: absolute(linkNode?.getAttribute('href'), base),
        identity: text(item, 'id'),
        published: text(item, 'published') || text(item, 'updated'),
        author: text(child(item, 'author') || root, 'name'),
        body: atomBody(bodyNode),
        bodyBase: bodyNode ? baseUrl(bodyNode, base) : base,
        imageUrl: itemImage(item, base),
        audioUrl: itemAudio(item, base),
      })
      continue
    }
    const bodyNode = child(item, 'encoded') || child(item, 'description') || child(item, 'summary')
    items.push({
      title: plainText(text(item, 'title')),
      link: absolute(text(item, 'link'), base),
      identity: text(item, 'guid') || text(item, 'id'),
      published: text(item, 'pubDate') || text(item, 'date') || text(item, 'issued'),
      author: text(item, 'creator') || text(item, 'author'),
      body: bodyNode?.textContent || '',
      bodyBase: bodyNode ? baseUrl(bodyNode, base) : base,
      imageUrl: itemImage(item, base),
      audioUrl: itemAudio(item, base),
    })
  }
  return items
}

/**
 * Turn a feed document into entries.
 *
 * `feedUrl` is the address the bytes came from, which is what every relative reference in the
 * document resolves against. Entries are deduplicated by identity (guid/id, then link, then
 * title+date), newest first, capped per feed, and cut off once the running byte total passes the
 * ceiling — shipping a whole archive in one document is common enough to be worth surviving.
 */
export function parseFeed(xml: string, feedUrl: string, parser: DOMParser = new DOMParser()): ParsedFeed {
  const parsed = doc(xml, parser)
  const root = parsed.documentElement
  const atom = root.localName === 'feed'
  const channel = child(root, 'channel')
  if (!atom && root.localName !== 'rss' && root.localName !== 'RDF' && !channel) {
    throw new FeedParseError('document is not an RSS or Atom feed')
  }
  const host = atom ? root : channel ?? root
  // A feed with no title of its own is named by the host it came from; the UI never shows an
  // unnamed source, and a translated placeholder would be a stranger answer than the domain is.
  const title = plainText(text(host, 'title'))
    || safeHttpUrl(feedUrl)?.hostname.replace(/^www\./, '')
    || ''
  const siteUrl = atom
    ? absolute(Array.from(host.children).find(el => el.localName === 'link'
      && (!el.getAttribute('rel') || el.getAttribute('rel') === 'alternate'))?.getAttribute('href'), feedUrl)
    : absolute(text(host, 'link'), feedUrl)
  const feedId = `f${rssHash(canonicalFeedUrl(feedUrl) || feedUrl)}`
  const entries: RssEntry[] = []
  const seen = new Set<string>()
  let bytes = 0
  let skipped = 0
  for (const item of readItems(root, atom, feedUrl)) {
    const identity = item.identity || item.link || `${item.title}\n${item.published}`
    const id = entryIdFor(feedId, identity)
    if (seen.has(id)) { skipped++; continue }
    seen.add(id)
    const clipped = item.body.length > RSS_LIMITS.contentChars
      ? `${item.body.slice(0, RSS_LIMITS.contentChars)}<p>…</p>`
      : unescapeOnce(item.body)
    const content = clipped.trim()
    const summary = plainText(content).slice(0, RSS_LIMITS.summaryChars)
    const entry: RssEntry = {
      id,
      feedId,
      title: (item.title || summary.slice(0, 80)).slice(0, RSS_LIMITS.titleChars),
      link: item.link || siteUrl || feedUrl,
      author: item.author.slice(0, RSS_LIMITS.nameChars),
      publishedTs: parseFeedDate(item.published),
      summary,
      content,
      imageUrl: item.imageUrl || firstImage(content, item.bodyBase),
      audioUrl: item.audioUrl,
    }
    bytes += entry.content.length + entry.summary.length
    if (bytes > RSS_LIMITS.feedBytes || entries.length >= RSS_LIMITS.entriesPerFeed) { skipped++; continue }
    entries.push(entry)
  }
  entries.sort((a, b) => (b.publishedTs ?? 0) - (a.publishedTs ?? 0))
  return {
    title: title.slice(0, RSS_LIMITS.nameChars),
    siteUrl,
    imageUrl: feedImage(host, feedUrl),
    entries,
    skipped,
  }
}

function firstImage(html: string, base: string): string {
  const match = /<img[^>]+\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html)
  return absolute(match?.[1] ?? match?.[2] ?? match?.[3], base)
}

/** OPML outlines, flattened: every `outline` that carries an `xmlUrl` is one subscription. */
export function parseOpml(xml: string, parser: DOMParser = new DOMParser()): ParsedOpml {
  const parsed = doc(xml, parser)
  const root = parsed.documentElement
  const body = child(root, 'body')
  if (root.localName !== 'opml' || !body) throw new FeedParseError('document is not an OPML file')
  const feeds: OpmlFeed[] = []
  const seen = new Set<string>()
  let skipped = 0
  const walk = (node: Element, groups: string[]): void => {
    for (const outline of children(node, 'outline')) {
      const raw = outline.getAttribute('xmlUrl') || outline.getAttribute('xmlurl') || ''
      const label = outline.getAttribute('text') || outline.getAttribute('title') || ''
      if (raw) {
        const url = safeHttpUrl(raw.trim())
        const canonical = url ? canonicalFeedUrl(url.href) : ''
        if (!canonical || seen.has(canonical)) skipped++
        else {
          seen.add(canonical)
          const path = groups.filter(Boolean).slice(0, RSS_LIMITS.groupDepthMax)
          feeds.push({
            url: (url as URL).href,
            title: (label || (url as URL).hostname).slice(0, RSS_LIMITS.nameChars),
            group: path.join(' / ').slice(0, RSS_LIMITS.groupChars),
            groupPath: path,
          })
        }
        continue
      }
      walk(outline, label ? [...groups, label] : groups)
    }
  }
  walk(body, [])
  return { feeds, skipped }
}

interface OpmlBranch {
  name: string
  kids: Map<string, OpmlBranch>
  feeds: Array<{ url: string, title: string, siteUrl?: string }>
}

/**
 * Subscriptions as one OPML 2.0 document, with the folder nesting written back the way it was
 * read. A reader who exports from this app and imports into another — or the other way round —
 * should get the same tree, not a shelf named "Front end / Reading".
 */
export function exportOpml(
  feeds: Array<{ url: string, title: string, groupPath: string[], siteUrl?: string }>,
  title: string,
): string {
  const tree: OpmlBranch = { name: '', kids: new Map(), feeds: [] }
  for (const feed of feeds) {
    let node = tree
    for (const name of feed.groupPath) {
      const key = name.toLocaleLowerCase()
      let kid = node.kids.get(key)
      if (!kid) {
        kid = { name, kids: new Map(), feeds: [] }
        node.kids.set(key, kid)
      }
      node = kid
    }
    node.feeds.push(feed)
  }
  const outline = (feed: { url: string, title: string, siteUrl?: string }, pad: string): string =>
    `${pad}<outline type="rss" text="${escapeAttr(feed.title)}" title="${escapeAttr(feed.title)}" xmlUrl="${escapeAttr(feed.url)}"${feed.siteUrl ? ` htmlUrl="${escapeAttr(feed.siteUrl)}"` : ''} />`
  const byTitle = (a: { title: string }, b: { title: string }): number => a.title.localeCompare(b.title)
  const branch = (node: OpmlBranch, depth: number): string[] => {
    const pad = '  '.repeat(depth + 3)
    const own = [...node.feeds].sort(byTitle).map(feed => outline(feed, pad))
    const kids = [...node.kids.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((kid) => {
        const inner = branch(kid, depth + 1)
        if (!inner.length) return []
        return [`${pad}<outline text="${escapeAttr(kid.name)}" title="${escapeAttr(kid.name)}">`, ...inner, `${pad}</outline>`]
      })
    return [...own, ...kids]
  }
  const parts = branch(tree, -1)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${escapeAttr(title)}</title>\n    <dateCreated>${new Date().toUTCString()}</dateCreated>\n  </head>\n  <body>\n${parts.join('\n')}\n  </body>\n</opml>\n`
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
