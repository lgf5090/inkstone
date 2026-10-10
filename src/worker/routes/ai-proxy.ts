import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { readJson } from '../lib/request'

interface AIProxyPayload {
  endpoint?: string
  headers?: Record<string, string>
  body?: unknown
}

export const aiProxyRoutes = new Hono<AppBindings>()
aiProxyRoutes.use('*', requireAuth)

aiProxyRoutes.post('/proxy', async (c) => {
  const data = await readJson<AIProxyPayload>(c, 512 * 1024)
  const endpoint = data.endpoint
  if (!endpoint || typeof endpoint !== 'string') {
    throw ApiError.badRequest('Missing or invalid endpoint')
  }

  let targetUrl: URL
  try {
    targetUrl = new URL(endpoint)
  } catch {
    throw ApiError.badRequest('Invalid endpoint URL')
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw ApiError.badRequest('Endpoint must use http or https')
  }

  const upstreamHeaders = new Headers()
  if (data.headers && typeof data.headers === 'object') {
    for (const [key, value] of Object.entries(data.headers)) {
      const lower = key.toLowerCase()
      if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue
      if (typeof value === 'string') {
        upstreamHeaders.set(key, value)
      }
    }
  }

  if (!upstreamHeaders.has('content-type')) {
    upstreamHeaders.set('content-type', 'application/json')
  }

  const payload = typeof data.body === 'string' ? data.body : JSON.stringify(data.body ?? {})

  try {
    const upstreamRes = await fetch(targetUrl.toString(), {
      method: 'POST',
      headers: upstreamHeaders,
      body: payload,
    })

    const responseHeaders = new Headers()
    const contentType = upstreamRes.headers.get('content-type')
    if (contentType) responseHeaders.set('content-type', contentType)
    responseHeaders.set('cache-control', 'no-cache')

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: { message: `AI upstream request failed: ${message}` } }, 502)
  }
})
