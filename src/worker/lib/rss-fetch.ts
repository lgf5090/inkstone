import { isBlockedTarget } from '@shared/ai-proxy-guard'
import { rssHash, type RssFetchReason, type RssFetchResult } from '@shared/rss/model'
import { ApiError } from './errors'
import { NO_REDIRECT, isRedirectResponse } from './no-redirect'
import { readStreamWithinLimit } from './request'

export const MAX_FEED_BYTES = 3 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 15_000
export const MAX_HOPS = 3
export const READER_AGENT = 'Inkstone RSS reader'

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml, rdf/xml, */*'

export interface FeedRequestInput {
  url?: unknown
  etag?: unknown
  lastModified?: unknown
}

export function assertFeedUrl(value: unknown): URL {
  if (typeof value !== 'string') throw ApiError.badRequest('A feed address is required')
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw ApiError.badRequest('The feed address could not be read')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw ApiError.badRequest('Feeds are fetched over http or https only')
  if (url.username || url.password) throw ApiError.badRequest('A feed address may not carry credentials')
  if (isBlockedTarget(url.hostname)) throw ApiError.badRequest('That address is not reachable from this deployment')
  return url
}

export function headerOnly(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\r\n\0]/g, '').slice(0, max)
}

function looksLikeFeed(contentType: string): boolean {
  const type = contentType.toLowerCase()
  if (!type) return true
  if (/html|image\/|video\/|audio\/|pdf|zip|octet-stream/.test(type)) return false
  return /xml|rss|atom|rdf|text\/|application\/json/.test(type)
}

function feedEncoding(bytes: Uint8Array, contentType: string): string {
  const header = /charset\s*=\s*["']?([A-Za-z0-9._-]+)/i.exec(contentType)?.[1]
  if (header) return header
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256))
  return /^<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1] ?? 'utf-8'
}

function decodeFeedDocument(bytes: Uint8Array, contentType: string): string | null {
  try {
    return new TextDecoder(feedEncoding(bytes, contentType)).decode(bytes)
  }
  catch {
    return null
  }
}

function feedFailure(url: string, status: number, reason: RssFetchReason): RssFetchResult {
  console.warn('[inkstone] RSS fetch failed', { feed: rssHash(url), status, reason })
  return { url, status, ok: false, reason }
}

/** One bounded, SSRF-checked feed request. Failures are returned so a batch can isolate them. */
export async function fetchFeed(input: FeedRequestInput): Promise<RssFetchResult> {
  const requested = typeof input.url === 'string' ? input.url : ''
  let url: URL
  try {
    url = assertFeedUrl(requested)
  }
  catch {
    return feedFailure(requested, 0, 'blocked')
  }
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const etag = headerOnly(input.etag, 200)
  const lastModified = headerOnly(input.lastModified, 200)
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const headers: Record<string, string> = { accept: FEED_ACCEPT, 'user-agent': READER_AGENT }
      if (etag) headers['if-none-match'] = etag
      if (lastModified) headers['if-modified-since'] = lastModified
      const response = await fetch(url.href, { headers, redirect: NO_REDIRECT, signal })
      if (response.status === 304) {
        return { url: requested, finalUrl: url.href, status: 304, ok: true, etag: etag || undefined, lastModified: lastModified || undefined }
      }
      if (isRedirectResponse(response)) {
        const location = response.headers.get('location')
        if (!location || hop === MAX_HOPS) return feedFailure(requested, response.status, 'unreachable')
        try {
          url = assertFeedUrl(new URL(location, url).href)
        }
        catch {
          return feedFailure(requested, response.status, 'blocked')
        }
        continue
      }
      if (!response.ok) return feedFailure(requested, response.status, 'http')
      if (!looksLikeFeed(response.headers.get('content-type') || '')) return feedFailure(requested, response.status, 'not-a-feed')
      const bytes = await readStreamWithinLimit(response.body, MAX_FEED_BYTES)
      if (bytes === null) return feedFailure(requested, response.status, 'too-large')
      const xml = decodeFeedDocument(bytes, response.headers.get('content-type') || '')
      if (xml === null || !xml.trim()) return feedFailure(requested, response.status, 'not-a-feed')
      return {
        url: requested,
        finalUrl: url.href,
        status: response.status,
        ok: true,
        xml,
        etag: headerOnly(response.headers.get('etag'), 200) || undefined,
        lastModified: headerOnly(response.headers.get('last-modified'), 200) || undefined,
      }
    }
    return feedFailure(requested, 0, 'unreachable')
  }
  catch {
    return feedFailure(requested, 0, signal.aborted ? 'timeout' : 'unreachable')
  }
}
