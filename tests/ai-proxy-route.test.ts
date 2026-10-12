// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { errorResponse } from '../src/worker/lib/errors'
import { aiProxyRoutes } from '../src/worker/routes/ai-proxy'
import type { AppBindings } from '../src/worker/env'

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
app.route('/api/ai', aiProxyRoutes)

describe('ai proxy route', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.userId = 'user-1'
  })

  it('rejects unauthenticated request with 401', async () => {
    mocks.userId = ''
    const res = await app.request('/api/ai/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://api.deepseek.com' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects missing or non-http endpoint with 400', async () => {
    const res1 = await app.request('/api/ai/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res1.status).toBe(400)

    const res2 = await app.request('/api/ai/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'ftp://example.com' }),
    })
    expect(res2.status).toBe(400)
  })

  it('forwards request to upstream and pipes back response', async () => {
    let capturedUrl = ''
    let capturedMethod = ''
    let capturedBody = ''

    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url
      capturedMethod = init.method ?? 'GET'
      capturedBody = String(init.body)
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ text: 'hi' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }) as any

    const res = await app.request('/api/ai/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://api.deepseek.com/chat/completions',
        headers: { Authorization: 'Bearer test-key' },
        body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }] },
      }),
    })

    expect(res.status).toBe(200)
    expect(capturedUrl).toBe('https://api.deepseek.com/chat/completions')
    expect(capturedMethod).toBe('POST')
    expect(capturedBody).toContain('deepseek-flash')
    const json = await res.json() as any
    expect(json.choices[0].text).toBe('hi')
  })

  it('handles upstream fetch exception with 502', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection timeout')) as any

    const res = await app.request('/api/ai/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://api.deepseek.com/chat/completions',
        body: {},
      }),
    })

    expect(res.status).toBe(502)
    const json = await res.json() as any
    expect(json.error.message).toContain('connection timeout')
  })

  it.each([
    ['cloud metadata ipv4', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback ipv4', 'http://127.0.0.1:8788/api/notes'],
    ['private 10/8', 'http://10.0.0.5/x'],
    ['private 192.168/16', 'https://192.168.1.1/x'],
    ['private 172.16/12', 'https://172.20.0.4/x'],
    ['cgnat 100.64/10', 'https://100.64.0.1/x'],
    ['localhost name', 'http://localhost:5173/x'],
    ['service suffix', 'http://worker.default.svc.cluster.local/x'],
    ['ipv6 loopback', 'http://[::1]:8788/x'],
    ['ipv6 unique local', 'http://[fd00::1]/x'],
    ['ipv4 mapped ipv6', 'http://[::ffff:169.254.169.254]/x'],
    ['ipv4 mapped ipv6 hex', 'http://[::ffff:a9fe:a9fe]/x'],
    ['ipv6 unspecified', 'http://[::]/x'],
    ['credentials in url', 'https://user:pass@api.deepseek.com/chat/completions'],
  ])('refuses to relay to a %s target', async (_label, endpoint) => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as any
    const res = await app.request('/api/ai/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, body: {} }),
    })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards only provider headers and drops cookie plus unknown ones', async () => {
    let sent: Headers | undefined
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      sent = new Headers(init.headers)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as any

    await app.request('/api/ai/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://api.anthropic.com/v1/messages',
        headers: {
          Authorization: 'Bearer k',
          'anthropic-version': '2023-06-01',
          Cookie: 'inkstone_session=steal-me',
          'x-inkstone-client': '1',
          'referer': 'https://internal.example/',
        },
        body: {},
      }),
    })

    expect(sent?.get('authorization')).toBe('Bearer k')
    expect(sent?.get('anthropic-version')).toBe('2023-06-01')
    expect(sent?.get('cookie')).toBeNull()
    expect(sent?.get('x-inkstone-client')).toBeNull()
    expect(sent?.get('referer')).toBeNull()
  })

  it('does not follow an upstream redirect', async () => {
    const fetchSpy = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      // workerd has no `redirect: 'error'`, so the relay must ask for 'manual' and read the status.
      expect(init.redirect).toBe('manual')
      return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }))
    }) as any
    globalThis.fetch = fetchSpy

    const res = await app.request('/api/ai/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://api.openai.com/v1/chat/completions', body: {} }),
    })
    expect(res.status).toBe(502)
    const body = await res.json() as { error?: { message?: string } }
    expect(body.error?.message).toMatch(/redirect/i)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('relays a plain upstream answer untouched', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any

    const res = await app.request('/api/ai/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://api.openai.com/v1/chat/completions', body: {} }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.text()).toBe('{"ok":true}')
  })
})
