// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRenderState } from '../src/worker/cloudflare/browser-render'
import { makeCloudflareBed, readJson, seedAccount, stubCloudflare, TEST_USER } from './cloudflare-fixtures'

const mocks = vi.hoisted(() => ({ userId: 'u'.repeat(26) }))
vi.mock('../src/worker/middleware/auth', () => ({
  requireClientHeader: async (_c: unknown, next: () => Promise<void>) => { await next() },
  loadSession: async (_c: unknown, next: () => Promise<void>) => { await next() },
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

beforeEach(() => resetRenderState())
afterEach(() => vi.unstubAllGlobals())

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

describe('the browser-render route', () => {
  it('returns a data URL and records the browser seconds it cost', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    stubCloudflare((url) => {
      expect(url.pathname).toContain(`/accounts/${'b'.repeat(32)}/browser-rendering/screenshot`)
      return new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'x-browser-ms-used': '2500' },
      })
    })
    const response = await bed.app.request('/api/cloudflare/browser-render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', mode: 'screenshot' }),
    }, bed.env)
    expect(response.status).toBe(200)
    const body = await readJson<{ mode: string; screenshot: string; duration: number }>(response)
    expect(body.mode).toBe('screenshot')
    expect(body.screenshot.startsWith('data:image/png;base64,')).toBe(true)
    expect(body.duration).toBe(2.5)
    const usage = await bed.env.DB.prepare(
      'SELECT count FROM cloudflare_quota_usage WHERE user_id = ? AND account_id = ? AND resource = ?',
    ).bind(TEST_USER, id, 'browser_render_seconds').first<{ count: number }>()
    expect(usage?.count).toBe(3)
    const audit = await bed.env.DB.prepare('SELECT action FROM cloudflare_log WHERE user_id = ?').bind(TEST_USER).first<{ action: string }>()
    expect(audit?.action).toBe('browser_render')
  })

  it('refuses unknown modes, non-http URLs and empty input', async () => {
    const bed = await makeCloudflareBed()
    await seedAccount(bed, TEST_USER)
    for (const body of [
      { url: 'https://example.com', mode: 'video' },
      { url: 'javascript:alert(1)', mode: 'screenshot' },
      { url: '', mode: 'screenshot' },
      { url: 'https://example.com', mode: 'screenshot', browser: 'netscape' },
    ]) {
      const response = await bed.app.request('/api/cloudflare/browser-render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, bed.env)
      expect(response.status).toBe(400)
    }
  })

  it('cools down one account for ten seconds between renders', async () => {
    const bed = await makeCloudflareBed()
    await seedAccount(bed, TEST_USER)
    stubCloudflare(() => new Response(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'x-browser-ms-used': '1000' },
    }))
    const first = await bed.app.request('/api/cloudflare/browser-render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', mode: 'screenshot' }),
    }, bed.env)
    expect(first.status).toBe(200)
    const second = await bed.app.request('/api/cloudflare/browser-render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', mode: 'screenshot' }),
    }, bed.env)
    expect(second.status).toBe(429)
    const body = await readJson<{ error: { code: string } }>(second)
    expect(body.error.code).toBe('too_many_attempts')
  })

  it('marks an account exhausted on a daily-limit refusal and does not reuse it', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    stubCloudflare(() => new Response('Browser time limit exceeded', {
      status: 429,
      headers: { 'retry-after': '3600' },
    }))
    const response = await bed.app.request('/api/cloudflare/browser-render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', mode: 'screenshot' }),
    }, bed.env)
    expect(response.status).toBe(429)
    const body = await readJson<{ error: { code: string } }>(response)
    expect(body.error.code).toBe('cloudflare_quota_exceeded')
    const quota = await bed.env.DB.prepare(
      'SELECT exhausted FROM cloudflare_quota_usage WHERE user_id = ? AND account_id = ? AND resource = ?',
    ).bind(TEST_USER, id, 'browser_render_seconds').first<{ exhausted: number }>()
    expect(quota?.exhausted).toBe(1)
  })

  it('never renders on another reader’s account', async () => {
    const bed = await makeCloudflareBed()
    const other = 'o'.repeat(26)
    const { id } = await seedAccount(bed, other)
    const response = await bed.app.request('/api/cloudflare/browser-render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', mode: 'screenshot', accountId: id }),
    }, bed.env)
    expect(response.status).toBe(404)
  })
})
