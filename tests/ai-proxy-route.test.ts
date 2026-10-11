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
})
