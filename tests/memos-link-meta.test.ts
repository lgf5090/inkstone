// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MEMO_LINK_METADATA_BATCH_MAX,
  MEMO_LINK_METADATA_TTL_MS,
} from '../src/shared/memos/constants'
import type { MemoLinkMetadata } from '../src/shared/memos/types'
import type { AppBindings } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { fetchMemoLinkMetadata } from '../src/worker/memos/link-meta'
import { MEMOS_SCHEMA_STATEMENTS } from '../src/worker/memos/schema'
import {
  MEMO_LINK_META_HOURLY_ATTEMPTS,
  memoLinkMetaRoutes,
} from '../src/worker/routes/memos/link-meta'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER = 'user-owner'

const LOGIN_ATTEMPTS_SCHEMA = `CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  last_fail_at INTEGER NOT NULL,
  locked_until INTEGER
)`

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    if (!mocks.userId) {
      throw new (await import('../src/worker/lib/errors')).ApiError(401, 'unauthenticated', 'Please sign in first')
    }
    c.set('userId', mocks.userId)
    await next()
  },
}))

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/memos/link-metadata', memoLinkMetaRoutes)

const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()

let sqlite: DatabaseSync
let db: D1Database

function page(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function emptyMetadata(url: string): MemoLinkMetadata {
  return { url, title: '', description: '', image: '' }
}

function cacheRows(): Array<{
  url: string
  title: string
  description: string
  image: string
  fetched_at: number
}> {
  return sqlite
    .prepare('SELECT url, title, description, image, fetched_at FROM memos_link_metadata ORDER BY url')
    .all() as Array<{ url: string; title: string; description: string; image: string; fetched_at: number }>
}

async function post(body: unknown, userId = OWNER): Promise<Response> {
  mocks.userId = userId
  return await app.request(
    '/api/memos/link-metadata',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    testBindings(db),
  )
}

async function expectBadRequest(response: Response, message: string): Promise<void> {
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: { code: 'bad_request', message } })
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MEMOS_SCHEMA_STATEMENTS.join(';'))
  sqlite.exec(LOGIN_ATTEMPTS_SCHEMA)
  db = makeD1(sqlite)
  mocks.userId = OWNER
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => page(''))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('link metadata parsing', () => {
  it('prefers OpenGraph fields over the title tag and name description', async () => {
    fetchMock.mockResolvedValue(
      page(`<!doctype html><html><head>
        <title>Plain title</title>
        <meta name="description" content="Plain description">
        <meta property="og:title" content="OpenGraph title">
        <meta property="og:description" content="OpenGraph description">
        <meta property="og:image" content="/images/cover.png">
      </head></html>`),
    )
    const url = 'https://example.com/articles/1?ref=memo'

    await expect(fetchMemoLinkMetadata(db, [url])).resolves.toEqual([
      {
        url,
        title: 'OpenGraph title',
        description: 'OpenGraph description',
        image: 'https://example.com/images/cover.png',
      },
    ])
  })

  it('falls back to the title tag and name description when OpenGraph fields are absent or empty', async () => {
    fetchMock.mockResolvedValue(
      page(`<html><head>
        <title>  Plain <b>title</b>  </title>
        <meta property="og:title" content="">
        <meta name="description" content="Plain <i>description</i>">
      </head></html>`),
    )

    const [metadata] = await fetchMemoLinkMetadata(db, ['https://example.com/page'])

    expect(metadata).toMatchObject({
      title: 'Plain title',
      description: 'Plain description',
      image: '',
    })
  })

  it('decodes named, decimal and hexadecimal entities and strips markup', async () => {
    fetchMock.mockResolvedValue(
      page(`<html><head>
        <title>Tom &amp; Jerry &#39;Special&#x27; &mdash; &quot;Fun&quot;</title>
        <meta name="description" content="A &lt;b&gt;bold&lt;/b&gt; move &amp; more">
      </head></html>`),
    )

    const [metadata] = await fetchMemoLinkMetadata(db, ['https://example.com/page'])

    expect(metadata).toMatchObject({
      title: 'Tom & Jerry \'Special\' \u2014 "Fun"',
      description: 'A bold move & more',
    })
  })

  it('resolves a relative og:image against the page URL', async () => {
    fetchMock.mockResolvedValue(
      page('<meta property="og:image" content="../assets/cover.png?w=800&amp;h=400">'),
    )

    const [metadata] = await fetchMemoLinkMetadata(db, ['https://example.com/news/2026/story'])

    expect(metadata?.image).toBe('https://example.com/news/assets/cover.png?w=800&h=400')
  })

  it('keeps only http and https images', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      const content = url.endsWith('/data')
        ? 'data:image/png;base64,AAAA'
        : url.endsWith('/script')
          ? 'javascript:alert(1)'
          : 'ftp://cdn.example.com/cover.png'
      return page(`<meta property="og:image" content="${content}">`)
    })

    const urls = [
      'https://example.com/data',
      'https://example.com/script',
      'https://example.com/ftp',
    ]
    const items = await fetchMemoLinkMetadata(db, urls)

    expect(items.map((item) => item.image)).toEqual(['', '', ''])
    expect(cacheRows().map((row) => row.image)).toEqual(['', '', ''])
  })

  it('stops at the byte cap and ignores markup inside scripts and comments', async () => {
    fetchMock.mockResolvedValue(
      page(`<html><head>
        <!-- <title>Comment title</title> -->
        <script>const fake = '<title>Script title</title>'</script>
        <title>Real title</title>
      </head></html>`),
    )

    const [metadata] = await fetchMemoLinkMetadata(db, ['https://example.com/page'])

    expect(metadata?.title).toBe('Real title')
  })
})

describe('link metadata cache', () => {
  it('serves a fresh row without fetching again', async () => {
    fetchMock.mockResolvedValue(page('<title>First title</title>'))
    const url = 'https://example.com/cached'

    const first = await fetchMemoLinkMetadata(db, [url])
    const second = await fetchMemoLinkMetadata(db, [url])

    expect(first).toEqual(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cacheRows()).toMatchObject([{ url, title: 'First title' }])
  })

  it('refetches an expired row and updates it in place', async () => {
    fetchMock.mockResolvedValueOnce(page('<title>Old title</title>'))
    const url = 'https://example.com/expired'
    await fetchMemoLinkMetadata(db, [url])

    const expired = Math.floor((Date.now() - MEMO_LINK_METADATA_TTL_MS) / 1000) - 10
    sqlite.prepare('UPDATE memos_link_metadata SET fetched_at = ?').run(expired)
    fetchMock.mockResolvedValueOnce(page('<title>New title</title>'))

    await expect(fetchMemoLinkMetadata(db, [url])).resolves.toMatchObject([{ title: 'New title' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cacheRows()).toMatchObject([{ url, title: 'New title' }])
    expect(cacheRows()[0]?.fetched_at).toBeGreaterThan(expired)
  })

  it('does not cache a failed fetch', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const url = 'https://example.com/flaky'

    await expect(fetchMemoLinkMetadata(db, [url])).resolves.toEqual([emptyMetadata(url)])
    expect(cacheRows()).toEqual([])

    fetchMock.mockResolvedValueOnce(page('<title>Recovered</title>'))
    await expect(fetchMemoLinkMetadata(db, [url])).resolves.toMatchObject([{ title: 'Recovered' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('link metadata outbound safety', () => {
  it('returns an empty entry for a blocked private target without fetching', async () => {
    const url = 'http://127.0.0.1/admin'

    await expect(fetchMemoLinkMetadata(db, [url])).resolves.toEqual([emptyMetadata(url)])
    await expect(fetchMemoLinkMetadata(db, ['http://169.254.169.254/latest/meta-data'])).resolves.toEqual([
      emptyMetadata('http://169.254.169.254/latest/meta-data'),
    ])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(cacheRows()).toEqual([])
  })

  it('returns an empty entry for a redirect without following it', async () => {
    fetchMock.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://elsewhere.example/' },
    }))

    await expect(fetchMemoLinkMetadata(db, ['https://example.com/redirect'])).resolves.toEqual([
      emptyMetadata('https://example.com/redirect'),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    })
    expect(cacheRows()).toEqual([])
  })

  it('returns an empty entry when the target times out', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))

    await expect(fetchMemoLinkMetadata(db, ['https://example.com/slow'])).resolves.toEqual([
      emptyMetadata('https://example.com/slow'),
    ])
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
    })
    expect(cacheRows()).toEqual([])
  })

  it('returns an empty entry for an HTTP error', async () => {
    fetchMock.mockResolvedValue(page('not found', 404))

    await expect(fetchMemoLinkMetadata(db, ['https://example.com/missing'])).resolves.toEqual([
      emptyMetadata('https://example.com/missing'),
    ])
    expect(cacheRows()).toEqual([])
  })
})

describe('link metadata batching', () => {
  it('dedupes and keeps the first-appearance order of the request', async () => {
    fetchMock.mockImplementation(async (input) => page(`<title>${String(input)}</title>`))

    const items = await fetchMemoLinkMetadata(db, [
      'https://b.example/2',
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ])

    expect(items.map((item) => item.url)).toEqual([
      'https://b.example/2',
      'https://a.example/1',
      'https://c.example/3',
    ])
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://b.example/2',
      'https://a.example/1',
      'https://c.example/3',
    ])
  })
})

describe('link metadata route', () => {
  it('requires a signed-in user', async () => {
    const response = await post({ urls: ['https://example.com/'] }, '')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Please sign in first' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns metadata for every requested URL in order', async () => {
    fetchMock.mockImplementation(async (input) => page(`<title>${String(input)}</title>`))

    const response = await post({
      urls: ['https://example.com/b', 'https://example.com/a', 'https://example.com/b'],
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      items: [
        { url: 'https://example.com/b', title: 'https://example.com/b', description: '', image: '' },
        { url: 'https://example.com/a', title: 'https://example.com/a', description: '', image: '' },
      ],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('accepts an empty URL list', async () => {
    const response = await post({ urls: [] })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows the last request in the hourly budget and rejects the next without fetching', async () => {
    sqlite
      .prepare('INSERT INTO login_attempts (key, fails, last_fail_at, locked_until) VALUES (?, ?, ?, NULL)')
      .run(`memo-link-meta:${OWNER}`, MEMO_LINK_META_HOURLY_ATTEMPTS - 1, Date.now())

    const allowed = await post({ urls: ['https://example.com/last'] })
    expect(allowed.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockClear()
    const rejected = await post({ urls: ['https://example.com/over'] })

    expect(rejected.status).toBe(429)
    const body = await rejected.json() as {
      error: { code: string; details?: { retryAfter?: number } }
    }
    expect(body.error.code).toBe('too_many_attempts')
    expect(body.error.details?.retryAfter).toBeGreaterThan(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('normalizes host casing and fragments before deduping', async () => {
    fetchMock.mockImplementation(async (input) => page(`<title>${String(input)}</title>`))

    const response = await post({
      urls: ['https://EXAMPLE.com/page#one', 'https://example.com/page#two'],
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      items: [
        { url: 'https://example.com/page', title: 'https://example.com/page', description: '', image: '' },
      ],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts at most ten URLs', async () => {
    fetchMock.mockImplementation(async (input) => page(`<title>${String(input)}</title>`))
    const urls = Array.from({ length: MEMO_LINK_METADATA_BATCH_MAX }, (_, index) => `https://example.com/${index}`)

    const accepted = await post({ urls })
    expect(accepted.status).toBe(200)
    expect((await accepted.json() as { items: MemoLinkMetadata[] }).items).toHaveLength(MEMO_LINK_METADATA_BATCH_MAX)

    const rejected = await post({ urls: [...urls, 'https://example.com/extra'] })
    await expectBadRequest(
      rejected,
      `urls cannot contain more than ${MEMO_LINK_METADATA_BATCH_MAX} entries`,
    )
  })

  it('rejects a body whose urls is not an array', async () => {
    await expectBadRequest(await post({}), 'urls must be an array')
    await expectBadRequest(await post({ urls: 'https://example.com/' }), 'urls must be an array')
    await expectBadRequest(await post({ urls: null }), 'urls must be an array')
    await expectBadRequest(await post([]), 'The request body must be a JSON object')
  })

  it('rejects non-string and non-http entries', async () => {
    await expectBadRequest(await post({ urls: [42] }), 'urls[0] must be a string')
    await expectBadRequest(
      await post({ urls: ['/relative/path'] }),
      'urls[0] must be an absolute http or https URL without credentials',
    )
    await expectBadRequest(
      await post({ urls: ['ftp://example.com/file'] }),
      'urls[0] must be an absolute http or https URL without credentials',
    )
    await expectBadRequest(
      await post({ urls: ['javascript:alert(1)'] }),
      'urls[0] must be an absolute http or https URL without credentials',
    )
    await expectBadRequest(
      await post({ urls: ['https://user:secret@example.com/'] }),
      'urls[0] must be an absolute http or https URL without credentials',
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(cacheRows()).toEqual([])
  })
})
