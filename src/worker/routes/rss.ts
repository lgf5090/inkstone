/**
 * The RSS relay and the account's subscription library.
 *
 * Two jobs, both of which have to happen outside the browser. Feeds are served by whoever wrote
 * them, and almost none of them send `Access-Control-Allow-Origin`, so a reader that fetched them
 * directly could only ever subscribe to sites that opted in. And the library is the thing a reader
 * builds across devices — subscriptions, groups, what they have read — so it lives beside the
 * account rather than in one browser's storage.
 *
 * What the relay may reach is the security question here, and it has the same answer as the AI
 * relay: the address comes from the request, so it is validated against the shared guard before it
 * leaves, redirects are followed by hand so every hop is validated too, the response is capped
 * while it streams rather than after, and the content type decides what the caller may do with it.
 * `global_fetch_strictly_public` in the deploy configs is the hard boundary underneath all of that;
 * this file is the polite refusal on top of it.
 */
import { Hono } from 'hono'
import { isBlockedTarget } from '@shared/ai-proxy-guard'
import { emptyLibrary, parseRssLibrary, RSS_LIMITS, type RssFetchResult } from '@shared/rss/model'
import { applyLibraryPatch, parseRssPatch, patchChars, patchIsEmpty } from '@shared/rss/patch'
import { loadRssLibrary, storeRssLibrary } from '../lib/rss-store'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'

export const rssRoutes = new Hono<AppBindings>()

rssRoutes.use('*', requireAuth)

/** Bytes one feed document may occupy. A whole-archive feed is common; a 40 MB one is an attack. */
const MAX_FEED_BYTES = 3 * 1024 * 1024
const MAX_RELAY_BYTES = 24 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000
const MAX_HOPS = 3
const BATCH_CONCURRENCY = 5
const MAX_BATCH = 25

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml, rdf/xml, */*'
const READER_AGENT = 'Inkstone RSS reader'

interface FeedRequestInput {
  url?: unknown
  etag?: unknown
  lastModified?: unknown
}

function assertFeedUrl(value: unknown): URL {
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

function headerOnly(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // A validator header is copied into an outbound request, so anything a newline could smuggle
  // has to go before it leaves.
  return value.replace(/[\r\n\0]/g, '').slice(0, max)
}

async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false })
  let received = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (received > MAX_FEED_BYTES) {
        await reader.cancel()
        return null
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  }
  finally {
    reader.releaseLock()
  }
  return text
}

/** The content types a feed document may arrive as. HTML means the address is a web page, not a feed. */
function looksLikeFeed(contentType: string): boolean {
  const type = contentType.toLowerCase()
  if (!type) return true
  if (/html|image\/|video\/|audio\/|pdf|zip|octet-stream/.test(type)) return false
  return /xml|rss|atom|rdf|text\/|application\/json/.test(type)
}

/**
 * One feed, start to finish.
 *
 * Never throws: a batch is only useful if one dead host cannot take the other twenty-four answers
 * with it, so every failure comes back as a reason the reader can name.
 */
async function fetchFeed(input: FeedRequestInput): Promise<RssFetchResult> {
  const requested = typeof input.url === 'string' ? input.url : ''
  let url: URL
  try {
    url = assertFeedUrl(requested)
  }
  catch {
    return { url: requested, status: 0, ok: false, reason: 'blocked' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const etag = headerOnly(input.etag, 200)
  const lastModified = headerOnly(input.lastModified, 200)
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const headers: Record<string, string> = { accept: FEED_ACCEPT, 'user-agent': READER_AGENT }
      if (etag) headers['if-none-match'] = etag
      if (lastModified) headers['if-modified-since'] = lastModified
      const response = await fetch(url.href, { headers, redirect: NO_REDIRECT, signal: controller.signal })
      // A 304 is a 3xx, so it has to be read before the redirect branch or an unchanged feed looks
      // like a hop with nowhere to go.
      if (response.status === 304) {
        return { url: requested, status: 304, ok: true, etag: etag || undefined, lastModified: lastModified || undefined }
      }
      if (isRedirectResponse(response)) {
        const location = response.headers.get('location')
        if (!location || hop === MAX_HOPS) return { url: requested, status: response.status, ok: false, reason: 'unreachable' }
        try {
          url = assertFeedUrl(new URL(location, url).href)
        }
        catch {
          return { url: requested, status: response.status, ok: false, reason: 'blocked' }
        }
        continue
      }
      if (!response.ok) return { url: requested, status: response.status, ok: false, reason: 'http' }
      if (!looksLikeFeed(response.headers.get('content-type') || '')) {
        return { url: requested, status: response.status, ok: false, reason: 'not-a-feed' }
      }
      const xml = await readCapped(response.body)
      if (xml === null) return { url: requested, status: response.status, ok: false, reason: 'too-large' }
      if (!xml.trim()) return { url: requested, status: response.status, ok: false, reason: 'not-a-feed' }
      return {
        url: requested,
        status: response.status,
        ok: true,
        xml,
        etag: headerOnly(response.headers.get('etag'), 200) || undefined,
        lastModified: headerOnly(response.headers.get('last-modified'), 200) || undefined,
      }
    }
    return { url: requested, status: 0, ok: false, reason: 'unreachable' }
  }
  catch {
    return { url: requested, status: 0, ok: false, reason: controller.signal.aborted ? 'timeout' : 'unreachable' }
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * One budget per account per ten minutes.
 *
 * The relay is authenticated, so its abuse surface is one reader refreshing their own feeds — but
 * "refresh" is a button that can be held down, and a list of 400 feeds turns one press into 400
 * outbound requests. The ceiling is far above that and nowhere near an attack.
 */
async function spendBudget(db: D1Database, key: string, maxAttempts: number, message: string): Promise<void> {
  await assertAttemptBudget(
    () => consumeAttemptBudget(db, [{ key, maxAttempts, windowMs: 10 * 60 * 1000, lockMs: 2 * 60 * 1000 }]),
    // The helper appends the real retry window, which is more useful than the "shortly" these two
    // budgets used to promise, so `message` is the prefix only.
    message,
  )
}

rssRoutes.post('/fetch', async (c) => {
  await spendBudget(c.env.DB, `rss-fetch:${c.get('userId')}`, 60, 'Too many feed requests')
  const body = await readJson<{ requests?: unknown }>(c, 64 * 1024)
  const queue = (Array.isArray(body.requests) ? body.requests.slice(0, MAX_BATCH) : []) as FeedRequestInput[]
  if (!queue.length) throw ApiError.badRequest('Name at least one feed to fetch')
  const results: RssFetchResult[] = []
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      results.push(await fetchFeed(item))
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker))
  return c.json({ results })
})

rssRoutes.get('/library', async (c) => {
  const stored = await loadRssLibrary(c.env.DB, c.get('userId'))
  return c.json({ savedAt: stored.savedAt, library: stored.library })
})

/**
 * Store the whole library the device holds.
 *
 * The client still sends it as one text body, because that is what a device that has been reading
 * offline already has, and because refusing a library that did not fit is only meaningful while the
 * whole thing is in front of the route. What changed is the write: the library becomes rows, so a
 * save that only starred something touches one row instead of rewriting every subscription.
 */
rssRoutes.put('/library', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ library?: unknown }>(c, JSON_BODY_LIMITS.quickAdd)
  if (typeof body.library !== 'string') throw ApiError.badRequest('The RSS library must be sent as text')
  if (body.library.length > RSS_LIMITS.payloadChars) throw ApiError.tooLarge('The RSS library is too large to store')
  let parsed: unknown
  try {
    parsed = JSON.parse(body.library)
  }
  catch {
    throw ApiError.badRequest('The RSS library could not be read')
  }
  const { data, dropped, truncated } = parseRssLibrary(parsed)
  if (!data) throw ApiError.badRequest('The RSS library could not be read')
  // A library that needed trimming on the way in is refused rather than stored in its own image:
  // the reader has to hear that something did not fit, and a silent cut reads as a lost subscription.
  if (dropped > 0 || truncated) {
    throw ApiError.badRequest('The RSS library holds entries that cannot be stored', { dropped, truncated })
  }
  const account = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(userId).first()
  if (!account) throw ApiError.notFound('Account not found')
  const savedAt = Date.now()
  await storeRssLibrary(c.env.DB, userId, data, savedAt)
  return c.json({ savedAt })
})

/**
 * Apply a change set: the rows one device touched, and nothing else.
 *
 * The merge happens here rather than on the device, because the account is the only place that
 * knows what is already stored. A mark this change set does not mention keeps its row, which is the
 * whole point: two devices reading the same library add to it instead of writing each other out.
 * The merged result still goes through the same whitelist as a whole save, so a change set that
 * would push the library past its ceilings is refused in the same words.
 */
rssRoutes.post('/patch', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ patch?: unknown }>(c, JSON_BODY_LIMITS.quickAdd)
  const patch = parseRssPatch(body.patch)
  if (!patch) throw ApiError.badRequest('The change set could not be read')
  if (patchChars(patch) > RSS_LIMITS.payloadChars) throw ApiError.tooLarge('The change set is too large to store')
  const account = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(userId).first()
  if (!account) throw ApiError.notFound('Account not found')
  const stored = await loadRssLibrary(c.env.DB, userId)
  if (patchIsEmpty(patch)) return c.json({ savedAt: stored.savedAt, rows: 0 })
  const merged = applyLibraryPatch(stored.library ?? emptyLibrary(), patch)
  const { data, dropped, truncated } = parseRssLibrary(merged)
  if (!data) throw ApiError.badRequest('The change set could not be read')
  if (dropped > 0 || truncated) {
    throw ApiError.badRequest('The RSS library holds entries that cannot be stored', { dropped, truncated })
  }
  const savedAt = Date.now()
  const report = await storeRssLibrary(c.env.DB, userId, data, savedAt)
  return c.json({ savedAt, rows: report.rowsWritten + report.rowsDeleted })
})

/**
 * Same-origin bytes for an article's images and a podcast's audio.
 *
 * The document policy allows remote images over https only, and allows no remote media at all, so
 * an article's plain-http thumbnails and every episode enclosure have to come through here to show
 * up. The address is validated the way a feed's is, only media types pass — SVG is refused, because
 * an SVG is a script with a picture attached — and a `Range` header travels through untouched so
 * seeking a two-hour episode does not download it first.
 */
const RELAY_TYPES = /^(image\/(?!svg)|audio\/|video\/mp4|video\/webm|application\/ogg)/i

rssRoutes.get('/relay', async (c) => {
  await spendBudget(c.env.DB, `rss-relay:${c.get('userId')}`, 600, 'Too many media requests')
  let url: URL
  try {
    url = assertFeedUrl(c.req.query('url'))
  }
  catch {
    throw ApiError.badRequest('That address cannot be relayed')
  }
  const headers: Record<string, string> = { 'user-agent': READER_AGENT, accept: 'image/*, audio/*, video/*, */*' }
  const range = headerOnly(c.req.header('range'), 200)
  if (range) headers.range = range
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let upstream: Response
  try {
    for (let hop = 0;; hop++) {
      upstream = await fetch(url.href, { headers, redirect: NO_REDIRECT, signal: controller.signal })
      if (!isRedirectResponse(upstream) || upstream.status === 304) break
      const location = upstream.headers.get('location')
      if (!location || hop >= MAX_HOPS) throw ApiError.badRequest('The media could not be reached')
      url = assertFeedUrl(new URL(location, url).href)
    }
  }
  catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('The media could not be reached')
  }
  finally {
    // Cleared once the headers are in: the body keeps streaming for as long as the listener
    // plays, and a timer that outlives this function would cut it off mid-episode.
    clearTimeout(timer)
  }
  const contentType = upstream.headers.get('content-type') || ''
  if (!upstream.ok) throw ApiError.notFound('The media could not be reached')
  if (!RELAY_TYPES.test(contentType)) throw ApiError.badRequest('Only images and audio can be relayed')
  const declared = Number(upstream.headers.get('content-length') || '0')
  if (declared > MAX_RELAY_BYTES) throw ApiError.tooLarge('That file is too large to relay')
  const out = new Headers()
  for (const [name, value] of [
    ['content-type', contentType],
    ['content-length', upstream.headers.get('content-length') || ''],
    ['content-range', upstream.headers.get('content-range') || ''],
    ['accept-ranges', upstream.headers.get('accept-ranges') || 'bytes'],
    ['cache-control', 'private, max-age=86400'],
  ] as const) {
    if (value) out.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
})
