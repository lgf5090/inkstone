/**
 * A book the reader found elsewhere, brought in through this deployment.
 *
 * The browser cannot fetch a foreign host itself — the app's `connect-src` allows only this origin — and
 * letting a caller name a URL would turn an import button into a redirector. So the host is fixed here
 * to Project Gutenberg's file mirror, and the only thing a caller chooses is the book's number, which is
 * checked to be digits before it is ever interpolated into a path.
 *
 * Only the download is implemented. A search box would need a machine-readable upstream, and the one
 * Gutenberg offers (`/ebooks/opensearch`, `/feeds/search.php`) answers 503/504 from here often enough
 * that writing a parser against its shape would mean coding to a guess; the error the reader sees when
 * the mirror has no such book is a fact that can be tested.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { LIMITS } from '@shared/constants'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { createMinuteBudget } from '../lib/rate-limit'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { isBlockedTarget } from '@shared/ai-proxy-guard'

const BOOK_HOST = 'gutenberg.pglaf.org'
const BOOK_NUMBER = /^\d{1,8}$/
/** Per isolate: a brake on a runaway client, not a quota. The size cap is the real limit. */
const FETCHES_PER_MINUTE = 12
const OPDS_FEED_MAX_BYTES = 2 * 1024 * 1024

export const readerDiscoveryRoutes = new Hono<AppBindings>()
readerDiscoveryRoutes.use('*', requireAuth)

const takeBudget = createMinuteBudget(FETCHES_PER_MINUTE, 'That is as many books as this account fetches in a minute.')

function publicHttpUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw ApiError.badRequest('That OPDS address is not a URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isBlockedTarget(url.hostname)) {
    throw ApiError.badRequest('That OPDS address is not allowed')
  }
  return url
}

async function fetchOpds(url: URL, maxBytes: number): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(url.toString(), {
      redirect: NO_REDIRECT,
      headers: { Accept: 'application/atom+xml, application/xml, text/xml, */*', 'User-Agent': 'Inkstone reader import' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new ApiError(502, 'reader_fetch_failed', 'The OPDS server did not answer')
  }
  if (isRedirectResponse(upstream)) throw ApiError.badRequest('That OPDS link moved somewhere else')
  if (!upstream.ok) throw new ApiError(502, 'reader_fetch_failed', `The OPDS server answered ${upstream.status}`)
  if (Number(upstream.headers.get('content-length') ?? 0) > maxBytes) throw new ApiError(413, 'reader_book_too_large', 'That OPDS response is too large')
  return upstream
}

async function readBounded(response: Response, maxBytes: number, message: string): Promise<ArrayBuffer> {
  const reader = response.body?.getReader()
  if (!reader) return new ArrayBuffer(0)
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new ApiError(413, 'reader_book_too_large', message)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}

readerDiscoveryRoutes.get('/opds', async (c) => {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  const url = publicHttpUrl(c.req.query('url') ?? '')
  takeBudget(userId)
  if (c.req.query('download') === '1') {
    const upstream = await fetchOpds(url, LIMITS.readerBookMaxBytes)
    const bytes = await readBounded(upstream, LIMITS.readerBookMaxBytes, 'That OPDS book is empty or too large')
    if (!bytes.byteLength) throw ApiError.badRequest('That OPDS book is empty')
    return new Response(bytes, {
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': 'attachment; filename="opds-book"',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  }
  const upstream = await fetchOpds(url, OPDS_FEED_MAX_BYTES)
  const bytes = await readBounded(upstream, OPDS_FEED_MAX_BYTES, 'That OPDS response is too large')
  const xml = new TextDecoder().decode(bytes)
  if (!xml.trim()) throw ApiError.badRequest('That OPDS feed is empty')
  return c.json({ xml })
})

readerDiscoveryRoutes.get('/book/:number', async (c) => {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  const number = c.req.param('number') ?? ''
  if (!BOOK_NUMBER.test(number)) throw ApiError.badRequest('A Project Gutenberg book number is digits only')
  takeBudget(userId)

  const url = `https://${BOOK_HOST}/cache/epub/${number}/pg${number}.epub`
  let upstream: Response
  try {
    upstream = await fetch(url, { redirect: NO_REDIRECT, headers: { 'User-Agent': 'Inkstone reader import' } })
  } catch {
    throw new ApiError(502, 'reader_fetch_failed', 'Project Gutenberg did not answer')
  }
  if (isRedirectResponse(upstream)) throw ApiError.badRequest('That link moved somewhere else')
  if (upstream.status === 404) throw ApiError.notFound('No such book on Project Gutenberg')
  if (!upstream.ok) throw new ApiError(502, 'reader_fetch_failed', `Project Gutenberg answered ${upstream.status}`)
  const declared = Number(upstream.headers.get('content-length') ?? 0)
  if (declared > LIMITS.readerBookMaxBytes) {
    throw new ApiError(413, 'reader_book_too_large', 'That book is too large for the shelf')
  }
  const bytes = await readBounded(upstream, LIMITS.readerBookMaxBytes, 'That book is too large for the shelf')
  if (!bytes.byteLength) throw ApiError.badRequest('That book arrived empty')
  // The reader's own import path decides what the file is; this only carries the bytes.
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/epub+zip',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `inline; filename="pg${number}.epub"`,
      'Cache-Control': 'public, max-age=604800',
    },
  })
})
