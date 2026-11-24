// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/worker/lib/host-guard', () => ({ resolvePublicHost: vi.fn(async () => 'ok') }))

import type { AppBindings } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { noteClipRoutes } from '../src/worker/routes/note-clip'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-clip'
const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('*', async (c, next) => {
  const userId = c.req.header('x-test-user')
  if (userId) c.set('userId', userId)
  await next()
})
app.route('/api/notes', noteClipRoutes)

let sqlite: DatabaseSync
let db: D1Database

async function request(url: string, user: string | null = USER): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (user) headers['x-test-user'] = user
  return app.fetch(new Request('http://localhost/api/notes/clip', {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
  }), { DB: db } as unknown as AppBindings['Bindings'])
}

function html(body: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(body, { headers: { 'content-type': contentType } })
}

function stubFetch(responder: (url: string) => Response | Promise<Response>): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return responder(url)
  })
  return calls
}

beforeEach(() => {
  vi.unstubAllGlobals()
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE login_attempts (
    key TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0,
    last_fail_at INTEGER NOT NULL, locked_until INTEGER
  )`)
  db = makeD1(sqlite)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

describe('POST /api/notes/clip', () => {
  it('follows guarded redirects and returns a narrow article with relative links intact', async () => {
    const calls = stubFetch(url => url.endsWith('/start')
      ? new Response(null, { status: 302, headers: { location: '/posts/final' } })
      : html(`<!doctype html><html><head><title> Example &amp; Guide </title><style>body{display:none}</style></head>
        <body><article><h1>Heading</h1><p>Hello <strong>world</strong>. <a href="/docs">Docs</a> <a href="section">Section</a></p></article></body></html>`))

    const response = await request('https://example.com/start')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      title: 'Example & Guide',
      url: 'https://example.com/posts/final',
      html: '<article><h1>Heading</h1><p>Hello <strong>world</strong>. <a href="/docs">Docs</a> <a href="section">Section</a></p></article>',
    })
    expect(calls).toEqual(['https://example.com/start', 'https://example.com/posts/final'])
  })

  it('accepts XHTML and falls back to the final hostname when the title is absent', async () => {
    stubFetch(() => html('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>XHTML text</p></body></html>', 'application/xhtml+xml'))
    const response = await request('https://docs.example.com/page')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ title: 'docs.example.com', url: 'https://docs.example.com/page', html: '<p>XHTML text</p>' })
  })

  it('strips scripts, event attributes, images, forms, embeds, and external CSS', async () => {
    stubFetch(() => html(`<html><head><title>Safe</title><link rel="stylesheet" href="https://evil.example/a.css">
      <style>p{color:red}</style><script>alert('title')</script></head><body>
      <article onclick="steal()"><p style="color:red" onmouseover="steal()">Readable</p>
      <script>alert('body')</script><img src="https://evil.example/pixel.png" onerror="steal()">
      <iframe src="https://evil.example/"></iframe><object data="x"></object><embed src="x">
      <form action="/steal"><input name="secret"><button>Send</button></form>
      <svg><script>alert('svg')</script></svg><a href="javascript:alert(1)" onclick="steal()">Link text</a></article></body></html>`))

    const response = await request('https://example.com/safe')
    expect(response.status).toBe(200)
    const body = await response.json() as { title: string; html: string }
    expect(body.title).toBe('Safe')
    expect(body.html).toContain('<p>Readable</p>')
    expect(body.html).toContain('<a>Link text</a>')
    for (const forbidden of ['script', 'style', 'link', 'img', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'onclick', 'onmouseover', 'onerror', 'javascript:', 'evil.example']) {
      expect(body.html).not.toContain(forbidden)
    }
  })

  it('rejects non-HTML responses without reading them as an article', async () => {
    const calls = stubFetch(() => html('{"title":"not html"}', 'application/json'))
    const response = await request('https://example.com/data.json')
    expect(response.status).toBe(415)
    expect(calls).toHaveLength(1)
  })

  it('rejects an oversized declared body and an oversized streamed body', async () => {
    stubFetch(() => new Response('small', { headers: { 'content-type': 'text/html', 'content-length': String(2 * 1024 * 1024 + 1) } }))
    expect((await request('https://example.com/declared')).status).toBe(413)

    const bytes = new TextEncoder().encode('x'.repeat(2 * 1024 * 1024 + 1))
    stubFetch(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }), { headers: { 'content-type': 'text/html' } }))
    expect((await request('https://example.com/streamed')).status).toBe(413)
  })

  it('rejects malformed, credentialed, non-HTTP, and overlong URLs before fetching', async () => {
    const calls = stubFetch(() => html('<p>unexpected</p>'))
    for (const url of ['not a url', 'ftp://example.com/file', 'https://user:pass@example.com/', `https://example.com/${'x'.repeat(2048)}`]) {
      expect((await request(url)).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  it('blocks private targets and unsafe redirect targets', async () => {
    const calls = stubFetch(url => url.endsWith('/start')
      ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
      : html('<p>unexpected</p>'))
    expect((await request('http://localhost/admin')).status).toBe(403)
    expect((await request('https://example.com/start')).status).toBe(403)
    expect(calls).toEqual(['https://example.com/start'])
  })

  it('requires authentication before spending a fetch or rate-limit attempt', async () => {
    const calls = stubFetch(() => html('<p>unexpected</p>'))
    expect((await request('https://example.com/', null)).status).toBe(401)
    expect(calls).toHaveLength(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM login_attempts').get()).toEqual({ count: 0 })
  })

  it('rate-limits each user independently', async () => {
    const calls = stubFetch(() => html('<p>Article</p>'))
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await request('https://example.com/article')).status).toBe(200)
    }
    expect((await request('https://example.com/article')).status).toBe(429)
    expect(calls).toHaveLength(20)
    expect((await request('https://example.com/article', 'other-user')).status).toBe(200)
    expect(calls).toHaveLength(21)
  })
})
