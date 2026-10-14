import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { readJson } from '../lib/request'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { assertRelayableEndpoint, pickRelayHeaders } from '@shared/ai-proxy-guard'

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
    targetUrl = assertRelayableEndpoint(endpoint)
  } catch (err) {
    throw ApiError.badRequest(err instanceof Error ? err.message : 'Invalid endpoint URL')
  }

  const upstreamHeaders = new Headers(pickRelayHeaders(data.headers))

  if (!upstreamHeaders.has('content-type')) {
    upstreamHeaders.set('content-type', 'application/json')
  }

  const payload = typeof data.body === 'string' ? data.body : JSON.stringify(data.body ?? {})

  try {
    const upstreamRes = await fetch(targetUrl.toString(), {
      method: 'POST',
      headers: upstreamHeaders,
      body: payload,
      redirect: NO_REDIRECT,
    })

    if (isRedirectResponse(upstreamRes)) {
      throw new ApiError(502, 'internal', 'AI upstream responded with a redirect, which relays refuse')
    }

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
    if (err instanceof ApiError) throw err
    // The upstream failure text can name an internal host, a port or a retry hint, so it belongs in
    // the server log and not in a response body the caller sees — same rule as `errorResponse`,
    // which answers an unknown error as a generic 500 without the stack. A real upstream status never
    // reaches here: a non-2xx answer from the provider is piped through untouched above.
    console.warn('[inkstone] AI upstream request failed:', err)
    throw new ApiError(502, 'internal', 'The AI upstream request failed')
  }
})
