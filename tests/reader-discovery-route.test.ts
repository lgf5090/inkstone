// @vitest-environment node
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readerDiscoveryRoutes } from '../src/worker/routes/reader-discovery'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { LIMITS } from '../src/shared/constants'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/reader/discovery', readerDiscoveryRoutes)

const fetched: string[] = []

function answer(init: { status?: number, body?: BodyInit, headers?: Record<string, string> }) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    fetched.push(String(input))
    return new Response(init.body ?? '', { status: init.status ?? 200, headers: init.headers })
  }))
}

async function get(path: string) {
  return app.request(`/api/reader/discovery${path}`, {}, { DB: {} as never, FILES: {} as never } as unknown as AppBindings['Bindings'])
}

beforeEach(() => {
  mocks.userId = 'user-alice'
  fetched.length = 0
  vi.unstubAllGlobals()
})

describe('bringing a book in from Project Gutenberg', () => {
  it('carries the bytes back through this origin', async () => {
    answer({ body: 'epub-bytes', headers: { 'Content-Length': '9' } })
    const res = await get('/book/27819')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('epub-bytes')
    expect(res.headers.get('content-type')).toBe('application/epub+zip')
    // The host is the route's, not the caller's: only the number moved.
    expect(fetched).toEqual(['https://gutenberg.pglaf.org/cache/epub/27819/pg27819.epub'])
  })

  it('refuses anything that is not a book number before it reaches the network', async () => {
    answer({ body: 'x' })
    for (const bad of ['../etc/passwd', '1;DROP', 'a1', '27819/../../x']) {
      const res = await get(`/book/${encodeURIComponent(bad)}`)
      expect(res.status, bad).toBe(400)
    }
    // No number at all never matches the route; either way no request leaves.
    expect((await get('/book/')).status).toBe(404)
    expect(fetched).toEqual([])
  })

  it('reports a book that is not there as missing, not as broken', async () => {
    answer({ status: 404, body: 'nope' })
    const res = await get('/book/99999999')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })

  it('will not carry a book larger than the shelf', async () => {
    answer({ body: new Uint8Array(LIMITS.readerBookMaxBytes + 1), headers: { 'Content-Length': String(LIMITS.readerBookMaxBytes + 1) } })
    const res = await get('/book/1')
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('reader_book_too_large')
  })

  it('does not follow a link that moved', async () => {
    answer({ status: 302, body: '' })
    const res = await get('/book/1')
    expect(res.status).toBe(400)
  })

  it('says the upstream did not answer rather than inventing a book', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const res = await get('/book/1')
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('reader_fetch_failed')
  })

  it('needs a signed-in reader', async () => {
    mocks.userId = ''
    answer({ body: 'x' })
    expect((await get('/book/27819')).status).toBe(401)
  })
})
