import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OUTBOUND_MAX_BYTES,
  checkTarget,
  outbound,
} from '../src/worker/lib/outbound'

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(url, init)
  })
}

afterEach(() => {
  calls = []
  vi.unstubAllGlobals()
})

describe('the shared outbound guard', () => {
  it('accepts http and https and returns the parsed address', () => {
    expect(checkTarget('https://example.com/hook').url?.toString()).toBe('https://example.com/hook')
    expect(checkTarget('http://example.com/hook').url?.protocol).toBe('http:')
    expect(checkTarget('https://example.com/hook').error).toBe('')
  })
})

describe('the shared outbound request', () => {
  it('sends the method, headers and body it was given, with redirects switched off', async () => {
    stubFetch(() => new Response('ok'))
    const result = await outbound('https://example.com/hook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })
    expect(result).toEqual({ ok: true, status: 200, text: 'ok', error: '' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://example.com/hook')
    expect(calls[0]!.init.method).toBe('PUT')
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(calls[0]!.init.body).toBe('{"a":1}')
    expect(calls[0]!.init.redirect).toBe('manual')
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('posts by default and reports a non-2xx answer as a failure with its status', async () => {
    stubFetch(() => new Response('nope', { status: 503 }))
    const result = await outbound('https://example.com/hook')
    expect(calls[0]!.init.method).toBe('POST')
    expect(result).toEqual({ ok: false, status: 503, text: 'nope', error: 'HTTP 503' })
  })

  it('refuses a redirect instead of following it', async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }))
    const result = await outbound('https://example.com/hook')
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(302)
    expect(result.error).toMatch(/redirect/)
  })

  it('caps the body at the default and the configured size', async () => {
    stubFetch(() => new Response('x'.repeat(OUTBOUND_MAX_BYTES + 1024)))
    const capped = await outbound('https://example.com/hook')
    expect(capped.text).toHaveLength(OUTBOUND_MAX_BYTES)

    stubFetch(() => new Response('y'.repeat(32)))
    const small = await outbound('https://example.com/hook', { maxBytes: 8 })
    expect(small.text).toBe('yyyyyyyy')
  })

  it('answers a timeout as a result rather than a throw', async () => {
    stubFetch(() => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    })
    const result = await outbound('https://example.com/hook', { timeoutMs: 1 })
    expect(result).toEqual({ ok: false, status: 0, text: '', error: 'The request timed out' })
  })

  it('answers a network failure as a result rather than a throw', async () => {
    stubFetch(() => {
      throw new TypeError('network down')
    })
    const result = await outbound('https://example.com/hook')
    expect(result).toEqual({ ok: false, status: 0, text: '', error: 'network down' })
  })

  it('refuses a blocked target without calling fetch', async () => {
    stubFetch(() => new Response('ok'))
    const result = await outbound('http://127.0.0.1/hook')
    expect(calls).toHaveLength(0)
    expect(result).toEqual({
      ok: false,
      status: 0,
      text: '',
      error: 'That address is not reachable from this deployment',
    })
  })
})
