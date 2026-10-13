/**
 * The catalogue behind the Discover tab.
 *
 * It is a static asset rather than a module, for two reasons that point the same way: 2,000 feeds
 * of other people's names is not something a reader who never opens the tab should download, and a
 * file under `public/` can be updated without rebuilding the app. The three shelves are the three
 * kinds of thing a reader asks for — a handful of long-running writers, the independent-blog index,
 * and the news/podcast catalogue — and each says where it came from, because a list of other
 * people's work should be traceable to whoever compiled it.
 */
import { safeHttpUrl } from '@shared/rss/model'

export interface DiscoverySource {
  id: string
  name: string
  url: string
  site: string
  category: string
  tags: string[]
}

export interface DiscoveryShelf {
  sources: DiscoverySource[]
  source: string
  revision: string
}

export interface DiscoveryCatalog {
  featured: DiscoveryShelf
  blogs: DiscoveryShelf
  news: DiscoveryShelf
}

export type ShelfName = keyof DiscoveryCatalog

const FILES: Record<ShelfName, string> = {
  featured: '/rss/featured.json',
  blogs: '/rss/blogs.json',
  news: '/rss/news.json',
}

let cached: Promise<DiscoveryCatalog> | null = null

export function loadDiscovery(): Promise<DiscoveryCatalog> {
  if (!cached) {
    cached = Promise.all([readShelf('featured'), readShelf('blogs'), readShelf('news')])
      .then(([featured, blogs, news]) => ({ featured, blogs, news }))
      .catch((error: unknown) => {
        // A failed load is not a failed cache: the next open asks again rather than showing an
        // empty catalogue forever.
        cached = null
        throw error
      })
  }
  return cached
}

async function readShelf(name: ShelfName): Promise<DiscoveryShelf> {
  const response = await fetch(FILES[name], { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`${name} catalogue is unavailable`)
  const value = await response.json() as {
    source?: unknown
    revision?: unknown
    items?: unknown
    feeds?: unknown
  }
  const raw = Array.isArray(value.items) ? value.items : []
  const sources: DiscoverySource[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const url = typeof entry.u === 'string' ? entry.u : typeof entry.feed_url === 'string' ? entry.feed_url : ''
    // An address that is not http(s) is not a feed, whatever the catalogue meant by it.
    if (!safeHttpUrl(url)) continue
    sources.push({
      id: typeof entry.id === 'string' ? entry.id : url,
      name: typeof entry.n === 'string' ? entry.n : typeof entry.title === 'string' ? entry.title : new URL(url).hostname,
      url,
      site: typeof entry.s === 'string' ? entry.s : typeof entry.site_url === 'string' ? entry.site_url : '',
      category: typeof entry.c === 'string' ? entry.c : typeof entry.category === 'string' ? entry.category : '',
      tags: Array.isArray(entry.t) ? (entry.t as unknown[]).filter((tag): tag is string => typeof tag === 'string').slice(0, 12) : [],
    })
  }
  return {
    sources,
    source: typeof value.source === 'string' ? value.source : '',
    revision: typeof value.revision === 'string' ? value.revision : '',
  }
}

export function filterSources(sources: DiscoverySource[], query: string, tag: string): DiscoverySource[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return sources.filter((source) => {
    if (tag && !source.tags.includes(tag)) return false
    if (!terms.length) return true
    const haystack = `${source.name} ${source.category} ${source.tags.join(' ')} ${source.site} ${source.url}`.toLocaleLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

export function topTags(sources: DiscoverySource[], limit = 40): string[] {
  const counts = new Map<string, number>()
  for (const source of sources) {
    for (const tag of source.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag)
}
