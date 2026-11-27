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
import { emptyLibrary, parseRssLibrary, rssHash, RSS_LIMITS, safeHttpUrl, type RssFeed, type RssFetchResult } from '@shared/rss/model'
import { applyLibraryPatch, parseRssPatch, patchChars, patchIsEmpty, patchIsMarksOnly } from '@shared/rss/patch'
import { accountExists, deleteRssReadingFeed, loadRssLibrary, loadServerRssArticles, rssFeedExists, rssMarkPatchFits, saveRssReadingFeed, searchServerRssArticles, storeRssLibrary, storeRssPatch, type RssRowPatch } from '../lib/rss-store'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { readJson, readStreamWithinLimit } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { assertFeedUrl, FETCH_TIMEOUT_MS, fetchFeed, headerOnly, MAX_HOPS, READER_AGENT, type FeedRequestInput } from '../lib/rss-fetch'

export const rssRoutes = new Hono<AppBindings>()

rssRoutes.use('*', requireAuth)

const MAX_RELAY_BYTES = 24 * 1024 * 1024
const BATCH_CONCURRENCY = 5
const MAX_BATCH = 25
const MAX_DISCOVER_BYTES = 1024 * 1024

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

async function spendFetchBudget(db: D1Database, userId: string, queue: FeedRequestInput[]): Promise<void> {
  const perUrl = new Map<string, number>()
  for (const item of queue) {
    if (!item || typeof item !== 'object' || typeof item.url !== 'string') continue
    try {
      const url = assertFeedUrl(item.url)
      const key = `rss-fetch-url:${userId}:${rssHash(url.href)}`
      perUrl.set(key, (perUrl.get(key) ?? 0) + 1)
    }
    catch {
      // Invalid entries still receive their own blocked result, but spend no outbound budget.
    }
  }
  if (!perUrl.size) return
  const total = [...perUrl.values()].reduce((sum, amount) => sum + amount, 0)
  await assertAttemptBudget(() => consumeAttemptBudget(db, [
    { key: `rss-fetch:${userId}`, maxAttempts: 1500, amount: total, windowMs: 10 * 60 * 1000, lockMs: 2 * 60 * 1000 },
    ...[...perUrl].map(([key, amount]) => ({ key, maxAttempts: 30, amount, windowMs: 10 * 60 * 1000, lockMs: 2 * 60 * 1000 })),
  ]), 'Too many feed requests')
}

function capMediaBody(body: ReadableStream<Uint8Array>, maxBytes: number, abort: () => void): ReadableStream<Uint8Array> {
  let bytes = 0
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes <= maxBytes) {
        controller.enqueue(chunk)
        return
      }
      abort()
      controller.error(new Error('media_too_large'))
    },
  }))
}

function htmlAttribute(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
}

rssRoutes.get('/discover', async (c) => {
  const userId = c.get('userId')
  let url: URL
  try {
    url = assertFeedUrl(c.req.query('url'))
  }
  catch {
    throw ApiError.badRequest('A valid web address is required')
  }
  await spendFetchBudget(c.env.DB, userId, [{ url: url.href }])
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let response: Response
  try {
    for (let hop = 0;; hop++) {
      response = await fetch(url.href, { headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': READER_AGENT }, redirect: NO_REDIRECT, signal })
      if (!isRedirectResponse(response) || response.status === 304) break
      const location = response.headers.get('location')
      if (!location || hop >= MAX_HOPS) throw ApiError.badRequest('The web page could not be reached')
      url = assertFeedUrl(new URL(location, url).href)
    }
  }
  catch {
    throw ApiError.badRequest('The web page could not be reached')
  }
  if (!response.ok) throw ApiError.badRequest('The web page could not be reached')
  const bytes = await readStreamWithinLimit(response.body, MAX_DISCOVER_BYTES)
  if (bytes === null) throw ApiError.tooLarge('The web page is too large to inspect')
  const html = new TextDecoder().decode(bytes)
  const feeds: string[] = []
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = htmlAttribute(tag, 'rel').toLowerCase()
    const type = htmlAttribute(tag, 'type').toLowerCase()
    if (rel !== 'alternate' || !/(?:rss|atom|feed\+json)/.test(type)) continue
    const href = safeHttpUrl(htmlAttribute(tag, 'href'), url.href)?.href ?? ''
    if (href && !feeds.includes(href)) feeds.push(href)
    if (feeds.length >= 10) break
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, '').trim().slice(0, 200) ?? ''
  return c.json({ url: url.href, title, feeds })
})

rssRoutes.post('/fetch', async (c) => {
  const body = await readJson<{ requests?: unknown }>(c, 64 * 1024)
  const queue = (Array.isArray(body.requests) ? body.requests.slice(0, MAX_BATCH) : []) as FeedRequestInput[]
  if (!queue.length) throw ApiError.badRequest('Name at least one feed to fetch')
  await spendFetchBudget(c.env.DB, c.get('userId'), queue)
  const results: RssFetchResult[] = []
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      results.push(await fetchFeed(item && typeof item === 'object' ? item : {}))
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker))
  return c.json({ results })
})

rssRoutes.get('/articles', async (c) => {
  const userId = c.get('userId')
  const feedId = c.req.query('feedId')?.slice(0, 80) ?? ''
  if (!feedId) throw ApiError.badRequest('A feed id is required')
  if (!(await rssFeedExists(c.env.DB, userId, feedId))) throw ApiError.notFound('Subscription not found')
  const articles = await loadServerRssArticles(c.env.DB, userId, feedId)
  return c.json({ feedId, articles }, { headers: { 'Cache-Control': 'private, no-store' } })
})

rssRoutes.get('/search', async (c) => {
  const userId = c.get('userId')
  const query = c.req.query('q')?.trim().slice(0, 200) ?? ''
  if (!query) throw ApiError.badRequest('A search query is required')
  const feedId = c.req.query('feedId')?.slice(0, 80) ?? ''
  if (feedId && !(await rssFeedExists(c.env.DB, userId, feedId))) throw ApiError.notFound('Subscription not found')
  const articles = await searchServerRssArticles(c.env.DB, userId, query, feedId)
  return c.json({ articles }, { headers: { 'Cache-Control': 'private, no-store' } })
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
  const body = await readJson<{ library?: unknown }>(c, RSS_LIMITS.payloadBytes)
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
  if (!(await accountExists(c.env.DB, userId))) throw ApiError.notFound('Account not found')
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
  const body = await readJson<{ patch?: unknown }>(c, RSS_LIMITS.payloadBytes)
  const patch = parseRssPatch(body.patch)
  if (!patch) throw ApiError.badRequest('The change set could not be read')
  if (patchChars(patch) > RSS_LIMITS.payloadChars) throw ApiError.tooLarge('The change set is too large to store')
  if (!(await accountExists(c.env.DB, userId))) throw ApiError.notFound('Account not found')
  if (patchIsMarksOnly(patch) && !patchIsEmpty(patch)) {
    if (!(await rssMarkPatchFits(c.env.DB, userId, patch))) {
      throw ApiError.badRequest('The RSS library holds entries that cannot be stored')
    }
    const savedAt = Date.now()
    const rowPatch: RssRowPatch = { ...patch, feeds: { upsert: [], remove: [] } }
    const report = await storeRssPatch(c.env.DB, userId, rowPatch, savedAt)
    return c.json({ savedAt, rows: report.rows })
  }
  const stored = await loadRssLibrary(c.env.DB, userId)
  if (patchIsEmpty(patch)) return c.json({ savedAt: stored.savedAt, rows: 0 })
  const merged = applyLibraryPatch(stored.library ?? emptyLibrary(), patch)
  const { data, dropped, truncated } = parseRssLibrary(merged)
  if (!data) throw ApiError.badRequest('The change set could not be read')
  if (dropped > 0 || truncated) {
    throw ApiError.badRequest('The RSS library holds entries that cannot be stored', { dropped, truncated })
  }
  const savedAt = Date.now()
  const feeds = patch.feeds.upsert.map((change) => {
    const existing = stored.library?.feeds.find(feed => feed.id === change.id)
    return {
      ...existing,
      ...change,
      tags: change.tags ? [...change.tags] : [...(existing?.tags ?? [])],
    } as RssFeed
  })
  const report = await storeRssPatch(c.env.DB, userId, {
    ...patch,
    feeds: { ...patch.feeds, upsert: feeds },
    state: patch.state ?? { lastChannel: stored.library?.lastChannel ?? '' },
  }, savedAt)
  return c.json({ savedAt, rows: report.rows })
})

/**
 * The articles this device can hand the assistant, one feed at a time.
 *
 * The subscription rows say what the reader follows, never what is in an article, and the articles
 * themselves never leave the device that fetched them. The assistant runs in the Worker, so the
 * device uploads the text it already holds — newest first, reduced to plain text, capped per feed and
 * in total — and the RSS tools read that. The write is accepted only for a feed this account really
 * subscribes to, so the row cannot become a place to park arbitrary text.
 */
const MAX_READING_BODY = 512 * 1024
const MAX_READING_ENTRIES = 40

rssRoutes.put('/reading', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ feedId?: unknown; entries?: unknown }>(c, MAX_READING_BODY)
  const feedId = typeof body.feedId === 'string' ? body.feedId.slice(0, 80) : ''
  if (!feedId) throw ApiError.badRequest('A feed id is required')
  if (!Array.isArray(body.entries)) throw ApiError.badRequest('The reading snapshot must be a list of articles')
  if (!(await rssFeedExists(c.env.DB, userId, feedId))) {
    throw ApiError.badRequest('That subscription is not in this account')
  }
  const saved = await saveRssReadingFeed(c.env.DB, userId, feedId, body.entries.slice(0, MAX_READING_ENTRIES))
  return c.json(saved)
})

rssRoutes.delete('/reading', async (c) => {
  const feedId = c.req.query('feedId')?.slice(0, 80) || undefined
  await deleteRssReadingFeed(c.env.DB, c.get('userId'), feedId)
  return c.json({ ok: true })
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
/** Repeated Range requests for one episode share a short-lived local budget receipt. */
const relayBudgetReceipts = new Map<string, number>()
const RELAY_RECEIPT_MS = 60_000

async function spendRelayBudget(db: D1Database, userId: string, url: string): Promise<void> {
  const key = `${userId}\u0000${url}`
  const now = Date.now()
  const until = relayBudgetReceipts.get(key) ?? 0
  if (until > now) return
  await spendBudget(db, `rss-relay:${userId}`, 600, 'Too many media requests')
  if (relayBudgetReceipts.size >= 1000) {
    for (const [receipt, expires] of relayBudgetReceipts) {
      if (expires <= now) relayBudgetReceipts.delete(receipt)
    }
    if (relayBudgetReceipts.size >= 1000) {
      const oldest = relayBudgetReceipts.keys().next().value
      if (oldest) relayBudgetReceipts.delete(oldest)
    }
  }
  relayBudgetReceipts.set(key, now + RELAY_RECEIPT_MS)
}

rssRoutes.get('/relay', async (c) => {
  let url: URL
  try {
    url = assertFeedUrl(c.req.query('url'))
  }
  catch {
    throw ApiError.badRequest('That address cannot be relayed')
  }
  await spendRelayBudget(c.env.DB, c.get('userId'), url.href)
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
      if (!location || hop >= MAX_HOPS) {
        controller.abort()
        throw ApiError.badRequest('The media could not be reached')
      }
      url = assertFeedUrl(new URL(location, url).href)
    }
  }
  catch (error) {
    if (error instanceof ApiError) throw error
    controller.abort()
    throw ApiError.badRequest('The media could not be reached')
  }
  finally {
    // Cleared once the headers are in: the body keeps streaming for as long as the listener
    // plays, and a timer that outlives this function would cut it off mid-episode.
    clearTimeout(timer)
  }
  const contentType = upstream.headers.get('content-type') || ''
  if (!upstream.ok) {
    controller.abort()
    throw ApiError.notFound('The media could not be reached')
  }
  if (!RELAY_TYPES.test(contentType)) {
    controller.abort()
    throw ApiError.badRequest('Only images and audio can be relayed')
  }
  const declared = Number(upstream.headers.get('content-length') || '0')
  if (declared > MAX_RELAY_BYTES) {
    controller.abort()
    throw ApiError.tooLarge('That file is too large to relay')
  }
  const out = new Headers()
  for (const [name, value] of [
    ['content-type', contentType],
    ['content-length', upstream.headers.get('content-length') || ''],
    ['content-range', upstream.headers.get('content-range') || ''],
    ['accept-ranges', upstream.headers.get('accept-ranges') || 'bytes'],
    ['cache-control', 'private, no-store'],
  ] as const) {
    if (value) out.set(name, value)
  }
  const body = upstream.body ? capMediaBody(upstream.body, MAX_RELAY_BYTES, () => controller.abort()) : null
  return new Response(body, { status: upstream.status, headers: out })
})
