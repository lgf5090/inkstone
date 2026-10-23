// @vitest-environment node
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { OUTBOUND_MAX_BYTES } from '../src/worker/subscriptions/channels/http'
import { templaterRoutes } from '../src/worker/routes/templater'

const mocks = vi.hoisted(() => ({ userId: 'user-1' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    if (!mocks.userId) {
      throw new (await import('../src/worker/lib/errors')).ApiError(401, 'unauthenticated', 'Authentication required')
    }
    c.set('userId', mocks.userId)
    await next()
  },
}))

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/templater', templaterRoutes)

let callers = 0

/**
 * A caller of its own, asked for by every request unless the test is the one counting.
 *
 * The budget lives per account per wall-clock minute, so a file that reused one id would have its first
 * test spent by the tests that ran before it and would go red depending on order rather than on behaviour.
 */
function newCaller(): string {
  return `user-${++callers}`
}

async function postFetch(url: unknown, userId = newCaller()): Promise<Response> {
  mocks.userId = userId
  return app.request('/api/templater/fetch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  }, {} as AppBindings['Bindings'])
}

/** Every request this route was allowed to make, so a test can prove the ones it refused never left. */
let sent: Array<{ url: string, init: RequestInit }>

function stubUpstream(reply: (url: string) => Response | Promise<Response>): void {
  sent = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
    sent.push({ url, init: init ?? {} })
    return reply(url)
  })
}

function answerWithQuote(): void {
  stubUpstream(() => new Response('{"quote":"a line"}', { status: 200, headers: { 'content-type': 'application/json' } }))
}

/** The signed-in path's own call, so a test about being signed out has to make its request directly. */
async function postSignedOut(url: string): Promise<Response> {
  mocks.userId = ''
  return app.request('/api/templater/fetch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  }, {} as AppBindings['Bindings'])
}

beforeEach(() => {
  mocks.userId = 'user-1'
  answerWithQuote()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the templater web proxy', () => {
  it('refuses a caller that is not signed in', async () => {
    const res = await postSignedOut('https://quotes.example.com/today')
    expect(res.status).toBe(401)
    expect(sent).toHaveLength(0)
  })

  it('refuses a body whose address is not text', async () => {
    for (const url of [undefined, 42, true, null, { href: 'https://example.com' }, ['https://example.com']]) {
      const res = await postFetch(url)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('bad_request')
    }
    expect(sent).toHaveLength(0)
  })

  it('refuses a body that is not a JSON object', async () => {
    mocks.userId = newCaller()
    const res = await app.request('/api/templater/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'https://example.com',
    }, {} as AppBindings['Bindings'])
    expect(res.status).toBe(400)
  })

  it.each([
    ['a file address', 'file:///etc/passwd'],
    ['an ftp address', 'ftp://files.example.com/note.txt'],
    ['a javascript address', 'javascript:alert(1)'],
    ['text that is not an address', 'quotes.example.com/today'],
  ])('refuses %s before it leaves', async (_label, url) => {
    const res = await postFetch(url)
    expect(res.status).toBe(403)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('web-blocked')
    expect(sent).toHaveLength(0)
  })

  it.each([
    ['loopback', 'http://127.0.0.1:8788/api/notes'],
    ['the loopback name', 'http://localhost:5173/x'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['the metadata name', 'http://metadata/google/compute/v1'],
    ['a private 10/8', 'http://10.0.0.5/x'],
    ['a private 192.168/16', 'https://192.168.1.1/x'],
    ['a private 172.16/12', 'https://172.20.0.4/x'],
    ['carrier-grade nat', 'https://100.64.0.1/x'],
    ['ipv6 loopback', 'http://[::1]:8788/x'],
    ['ipv6 unique local', 'http://[fd00::1]/x'],
    ['an internal zone', 'http://worker.default.svc.cluster.local/x'],
    ['credentials in the address', 'https://user:pass@quotes.example.com/today'],
  ])('refuses %s', async (_label, url) => {
    const res = await postFetch(url)
    expect(res.status).toBe(403)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('web-blocked')
    expect(sent).toHaveLength(0)
  })

  it('refuses an address longer than the ceiling it states', async () => {
    const res = await postFetch(`https://example.com/${'x'.repeat(4096)}`)
    expect(res.status).toBe(400)
    expect(sent).toHaveLength(0)
  })

  it('fetches with the bounded GET and none of the caller’s headers', async () => {
    stubUpstream(() => new Response('{"quote":"a line"}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const res = await postFetch('https://quotes.example.com/today')
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    const init = sent[0]!.init
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(init.headers).has('cookie')).toBe(false)
    expect(new Headers(init.headers).has('authorization')).toBe(false)
  })

  it('does not follow a redirect and says which rule stopped it', async () => {
    let asks = 0
    stubUpstream(() => {
      asks++
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    })
    const res = await postFetch('https://short.example/looked-fine')
    expect(asks).toBe(1)
    expect(res.status).toBe(403)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('web-blocked')
  })

  it('answers a text fetch with exactly the four fields the worker reads back', async () => {
    stubUpstream(() => new Response('{"quote":"a line"}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const res = await postFetch('https://quotes.example.com/today')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 200,
      ok: true,
      contentType: 'application/json',
      text: '{"quote":"a line"}',
    })
  })

  it('carries an upstream error status back as data, not as a failed route', async () => {
    // The template is the one that decides a 404 is a failure — `jsonFromResponse` in the worker names the
    // status — so the proxy reports what came back instead of turning it into this deployment's error.
    stubUpstream(() => new Response('no such page', { status: 404, headers: { 'content-type': 'text/html' } }))
    const res = await postFetch('https://quotes.example.com/gone')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 404, ok: false, contentType: 'text/html', text: 'no such page' })
  })

  it.each([
    ['an image', 'image/png'],
    ['a pdf', 'application/pdf'],
    ['a raw stream', 'application/octet-stream'],
    ['a script type that is not text to a template', 'application/javascript'],
  ])('refuses to carry %s', async (_label, contentType) => {
    stubUpstream(() => new Response('PNG-bytes-or-some-such', { status: 200, headers: { 'content-type': contentType } }))
    const res = await postFetch('https://files.example.com/report')
    expect(res.status).toBe(415)
    const body = await res.json() as { error: { code: string, details?: { contentType?: string } } }
    expect(body.error.code).toBe('capability-blocked')
    expect(body.error.details?.contentType).toBe(contentType)
    expect(JSON.stringify(body)).not.toContain('PNG-bytes')
  })

  it('refuses an answer that declared no type at all', async () => {
    stubUpstream(() => new Response(null, { status: 200 }))
    const res = await postFetch('https://quotes.example.com/silent')
    expect(res.status).toBe(415)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('capability-blocked')
  })

  it('accepts the structured suffixes a template can read', async () => {
    stubUpstream(() => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/feed+json; charset=utf-8' } }))
    const res = await postFetch('https://quotes.example.com/feed')
    expect(res.status).toBe(200)
    expect((await res.json() as { text: string }).text).toBe('{"a":1}')
  })

  it('refuses an answer that filled the cap instead of returning it cut short', async () => {
    const filler = 'x'.repeat(OUTBOUND_MAX_BYTES + 8 * 1024)
    stubUpstream(() => new Response(filler, { status: 200, headers: { 'content-type': 'application/json' } }))
    const res = await postFetch('https://quotes.example.com/huge')
    expect(res.status).toBe(413)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('web-request-failed')
    // A caller that got a truncated body would read it as the whole document; the refusal says so in words
    // and carries none of it.
    expect(JSON.stringify(body)).not.toContain('xxxx')
  })

  it('reports an address that never answered as a failed request', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED https://slow.example.com/data?api_key=LEAK-IN-A-CAUSE')
    })
    const res = await postFetch('https://slow.example.com/data')
    expect(res.status).toBe(502)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('web-request-failed')
  })

  it('stops the call after the budget for one account is spent', async () => {
    const caller = newCaller()
    for (let used = 0; used < 20; used++) {
      const res = await postFetch('https://quotes.example.com/today', caller)
      expect(res.status, `call ${used + 1}`).toBe(200)
    }
    const over = await postFetch('https://quotes.example.com/today', caller)
    expect(over.status).toBe(429)
    expect((await over.json() as { error: { code: string } }).error.code).toBe('too_many_attempts')
    expect(sent).toHaveLength(20)
  })

  it('keeps the query out of the log, on both sides of the guard', async () => {
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubUpstream(() => new Response('{"quote":"a line"}', { status: 200, headers: { 'content-type': 'application/json' } }))

    await postFetch('http://169.254.169.254/latest/meta-data/?token=BLOCKED-QUERY-SECRET')
    await postFetch('https://user:pass@quotes.example.com/today?api_key=CRED-QUERY-SECRET')
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED https://slow.example.com/data?api_key=CAUSE-SECRET')
    })
    await postFetch('https://slow.example.com/data?api_key=FAILED-QUERY-SECRET')

    expect(logged.mock.calls.length).toBeGreaterThanOrEqual(3)
    const lines = logged.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
    expect(lines).toContain('host=169.254.169.254')
    expect(lines).toContain('host=slow.example.com')
    for (const secret of ['BLOCKED-QUERY-SECRET', 'CRED-QUERY-SECRET', 'CAUSE-SECRET', 'FAILED-QUERY-SECRET', 'user:pass']) {
      expect(lines).not.toContain(secret)
    }
    expect(lines).not.toContain('?')
    expect(lines).not.toContain('{"quote"')
  })
})
