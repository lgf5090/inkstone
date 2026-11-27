import { Parser } from 'htmlparser2'
import { entryIdFor, RSS_LIMITS, safeHttpUrl, type RssEntry } from '@shared/rss/model'

interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

export interface ServerParsedFeed {
  title: string
  siteUrl: string
  imageUrl: string
  entries: RssEntry[]
  skipped: number
}

function parseXml(xml: string): XmlNode {
  if (/<!ENTITY/i.test(xml.slice(0, 4096))) throw new Error('DTD entities are not allowed')
  let root: XmlNode | null = null
  const stack: XmlNode[] = []
  const parser = new Parser({
    onopentag(name, attrs) {
      const node: XmlNode = { name: name.split(':').at(-1)?.toLowerCase() ?? '', attrs, children: [], text: '' }
      if (stack.at(-1)) stack.at(-1)!.children.push(node)
      else {
        if (root) throw new Error('Multiple XML roots')
        root = node
      }
      stack.push(node)
    },
    onclosetag() { stack.pop() },
    ontext(value) { if (stack.at(-1)) stack.at(-1)!.text += value },
    onprocessinginstruction(name) { if (name.toLowerCase() === '!doctype') throw new Error('Simple DTD declarations are not accepted server-side') },
  }, { xmlMode: true, decodeEntities: true })
  parser.write(xml)
  parser.end()
  if (!root || stack.length) throw new Error('Feed XML is not readable')
  return root
}

function children(node: XmlNode | null | undefined, name: string): XmlNode[] {
  return node?.children.filter(child => child.name === name) ?? []
}

function child(node: XmlNode | null | undefined, ...names: string[]): XmlNode | undefined {
  for (const name of names) {
    const found = children(node, name)[0]
    if (found) return found
  }
  return undefined
}

function text(node: XmlNode | null | undefined, ...names: string[]): string {
  return child(node, ...names)?.text.trim() ?? ''
}

function absolute(value: string, base: string): string {
  return safeHttpUrl(value.trim(), base)?.href ?? ''
}

function plain(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function dateOf(value: string): number | null {
  const raw = value.trim()
  if (!raw) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw)
  if (iso && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0))
  }
  const normalised = /^[A-Za-z]{3},?\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw} UTC` : raw
  const parsed = Date.parse(normalised)
  return Number.isFinite(parsed) ? parsed : null
}

function imageOf(item: XmlNode, base: string): string {
  for (const node of item.children) {
    const type = (node.attrs.type ?? '').toLowerCase()
    const medium = node.attrs.medium ?? ''
    if (node.name === 'thumbnail' || (node.name === 'image' && node.attrs.href)
      || (node.name === 'content' && (medium === 'image' || type.startsWith('image/')))
      || (node.name === 'enclosure' && type.startsWith('image/'))) {
      const found = absolute(node.attrs.url ?? node.attrs.href ?? '', base)
      if (found) return found
    }
  }
  return ''
}

function audioOf(item: XmlNode, base: string): string {
  for (const node of item.children) {
    const type = (node.attrs.type ?? '').toLowerCase()
    const rel = node.attrs.rel ?? ''
    if ((node.name === 'enclosure' || (node.name === 'link' && rel === 'enclosure')) && (!type || type.startsWith('audio/'))) {
      const found = absolute(node.attrs.url ?? node.attrs.href ?? '', base)
      if (found) return found
    }
  }
  return ''
}

function durationOf(item: XmlNode): number {
  const raw = text(item, 'duration')
  if (/^\d+$/.test(raw)) return Number(raw)
  const parts = raw.split(':').map(Number)
  return parts.length && parts.every(Number.isFinite) ? parts.reduce((total, part) => total * 60 + part, 0) : 0
}

function numberOf(item: XmlNode, name: string): number {
  const value = Number(text(item, name))
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function parseJson(xml: string, feedId: string, feedUrl: string): ServerParsedFeed {
  const feed = JSON.parse(xml.replace(/^\uFEFF/, '')) as Record<string, unknown>
  if (!feed || typeof feed !== 'object' || !Array.isArray(feed.items) || typeof feed.title !== 'string') throw new Error('Not a JSON Feed')
  const rows = feed.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
  const entries: RssEntry[] = []
  const seen = new Set<string>()
  let bytes = 0
  let skipped = 0
  for (const item of rows) {
    const identity = String(item.id ?? item.url ?? `${item.title ?? ''}\n${item.date_published ?? item.date_modified ?? ''}`)
    const id = entryIdFor(feedId, identity)
    if (seen.has(id)) { skipped++; continue }
    seen.add(id)
    const content = String(item.content_html ?? (item.content_text ? `<p>${escapeHtml(String(item.content_text))}</p>` : '')).slice(0, RSS_LIMITS.contentChars)
    const summary = (plain(content) || String(item.summary ?? '')).slice(0, RSS_LIMITS.summaryChars)
    const attachments = Array.isArray(item.attachments) ? item.attachments : []
    const audio = attachments.map(value => value && typeof value === 'object' ? value as Record<string, unknown> : null)
      .find(value => value && (!value.mime_type || String(value.mime_type).startsWith('audio/')))
    const entry: RssEntry = {
      id, feedId,
      title: String(item.title ?? summary.slice(0, 80)).slice(0, RSS_LIMITS.titleChars),
      link: absolute(String(item.url ?? ''), feedUrl) || absolute(String(feed.home_page_url ?? feed.feed_url ?? ''), feedUrl) || feedUrl,
      author: '', publishedTs: dateOf(String(item.date_published ?? item.date_modified ?? '')),
      summary, content,
      imageUrl: absolute(String(item.image ?? ''), feedUrl),
      audioUrl: absolute(String(audio?.url ?? ''), feedUrl),
      duration: Number(item.duration) || undefined,
      episode: Number(item.episode) || undefined,
      season: Number(item.season) || undefined,
    }
    bytes += content.length + summary.length
    if (bytes > RSS_LIMITS.feedBytes || entries.length >= RSS_LIMITS.entriesPerFeed) { skipped++; continue }
    entries.push(entry)
  }
  entries.sort((a, b) => (b.publishedTs ?? 0) - (a.publishedTs ?? 0))
  return {
    title: String(feed.title).slice(0, RSS_LIMITS.nameChars),
    siteUrl: absolute(String(feed.home_page_url ?? feed.feed_url ?? ''), feedUrl),
    imageUrl: absolute(String(feed.icon ?? feed.logo ?? feed.favicon ?? ''), feedUrl),
    entries,
    skipped,
  }
}

/** A bounded server-side parser for the RSS, Atom, RDF and JSON Feed shapes the client accepts. */
export function parseServerFeed(xml: string, feedId: string, feedUrl: string): ServerParsedFeed {
  if (xml.replace(/^\uFEFF/, '').trimStart().startsWith('{')) return parseJson(xml, feedId, feedUrl)
  if (/<!ENTITY/i.test(xml.slice(0, 4096))) throw new Error('DTD entities are not allowed')
  const root = parseXml(xml.replace(/<!DOCTYPE\s+[^>]*>/gi, ''))
  const atom = root.name === 'feed'
  const channel = child(root, 'channel')
  if (!atom && !['rss', 'rdf'].includes(root.name) && !channel) throw new Error('Not an RSS or Atom feed')
  const host = atom ? root : channel ?? root
  const container = atom ? root : root.name === 'rdf' ? root : channel ?? root
  const nodes = atom ? children(root, 'entry') : children(container, 'item')
  const entries: RssEntry[] = []
  const seen = new Set<string>()
  let bytes = 0
  let skipped = 0
  for (const item of nodes) {
    const linkNode = atom ? children(item, 'link').find(node => !node.attrs.rel || node.attrs.rel === 'alternate') : undefined
    const link = absolute(atom ? linkNode?.attrs.href ?? '' : text(item, 'link'), feedUrl)
    const identity = text(item, 'guid') || text(item, 'id') || link || `${text(item, 'title')}\n${text(item, 'pubdate') || text(item, 'published') || text(item, 'updated')}`
    const id = entryIdFor(feedId, identity)
    if (seen.has(id)) { skipped++; continue }
    seen.add(id)
    const raw = text(item, 'encoded') || text(item, 'description') || text(item, 'content') || text(item, 'summary')
    const content = raw.slice(0, RSS_LIMITS.contentChars)
    const summary = (plain(content) || text(item, 'summary')).slice(0, RSS_LIMITS.summaryChars)
    const entry: RssEntry = {
      id, feedId,
      title: (text(item, 'title') || summary.slice(0, 80)).slice(0, RSS_LIMITS.titleChars),
      link: link || absolute(text(host, 'link'), feedUrl) || feedUrl,
      author: (text(item, 'creator') || text(item, 'author') || text(child(item, 'author'), 'name')).slice(0, RSS_LIMITS.nameChars),
      publishedTs: dateOf(text(item, 'pubdate') || text(item, 'date') || text(item, 'published') || text(item, 'updated')),
      summary, content,
      imageUrl: imageOf(item, feedUrl),
      audioUrl: audioOf(item, feedUrl),
      duration: durationOf(item) || undefined,
      episode: numberOf(item, 'episode') || undefined,
      season: numberOf(item, 'season') || undefined,
    }
    bytes += content.length + summary.length
    if (bytes > RSS_LIMITS.feedBytes || entries.length >= RSS_LIMITS.entriesPerFeed) { skipped++; continue }
    entries.push(entry)
  }
  entries.sort((a, b) => (b.publishedTs ?? 0) - (a.publishedTs ?? 0))
  const siteUrl = atom
    ? absolute(host.children.find(node => node.name === 'link' && (!node.attrs.rel || node.attrs.rel === 'alternate'))?.attrs.href ?? '', feedUrl)
    : absolute(text(host, 'link'), feedUrl)
  return {
    title: (text(host, 'title') || (safeHttpUrl(feedUrl)?.hostname ?? '')).slice(0, RSS_LIMITS.nameChars),
    siteUrl,
    imageUrl: absolute(child(host, 'image') ? text(child(host, 'image'), 'url', 'href') : '', feedUrl) || absolute(text(host, 'logo') || text(host, 'icon'), feedUrl),
    entries,
    skipped,
  }
}
