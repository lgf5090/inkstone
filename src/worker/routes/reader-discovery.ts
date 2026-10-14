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

const BOOK_HOST = 'gutenberg.pglaf.org'
const BOOK_NUMBER = /^\d{1,8}$/
/** Per isolate: a brake on a runaway client, not a quota. The size cap is the real limit. */
const FETCHES_PER_MINUTE = 12

export const readerDiscoveryRoutes = new Hono<AppBindings>()
readerDiscoveryRoutes.use('*', requireAuth)

const takeBudget = createMinuteBudget(FETCHES_PER_MINUTE, 'That is as many books as this account fetches in a minute.')

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
  const bytes = await upstream.arrayBuffer()
  if (!bytes.byteLength) throw ApiError.badRequest('That book arrived empty')
  if (bytes.byteLength > LIMITS.readerBookMaxBytes) {
    throw new ApiError(413, 'reader_book_too_large', 'That book is too large for the shelf')
  }
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
