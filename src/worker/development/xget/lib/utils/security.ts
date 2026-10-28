// Derived from Xget (AGPL-3.0-only) src/utils/security.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import type { XgetConfig } from '../config'

export function resolveAllowedOrigin(request: Request, config: XgetConfig): string | null {
  const origin = request.headers.get('Origin')
  if (!origin) return null

  const allowedOrigins = config.SECURITY.ALLOWED_ORIGINS
  if (allowedOrigins.includes('*')) return '*'

  return allowedOrigins.includes(origin) ? origin : null
}

export function addCorsHeaders(headers: Headers, request: Request, config: XgetConfig): Headers {
  const allowedOrigin = resolveAllowedOrigin(request, config)
  if (!allowedOrigin) return headers

  headers.set('Access-Control-Allow-Origin', allowedOrigin)
  headers.set('Access-Control-Allow-Methods', config.SECURITY.ALLOWED_METHODS.join(', '))

  const requestedHeaders = request.headers.get('Access-Control-Request-Headers')
  if (requestedHeaders) headers.set('Access-Control-Allow-Headers', requestedHeaders)

  const vary = new Set(
    (headers.get('Vary') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
  vary.add('Origin')
  headers.set('Vary', Array.from(vary).join(', '))

  return headers
}

export function addSecurityHeaders(headers: Headers): Headers {
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('X-XSS-Protection', '1; mode=block')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; script-src 'none'")
  headers.set('Permissions-Policy', 'interest-cohort=()')
  return headers
}

export function createErrorResponse(
  message: string,
  status: number,
  includeDetails = false,
): Response {
  const body = includeDetails
    ? JSON.stringify({ error: message, status, timestamp: new Date().toISOString() })
    : message

  return new Response(body, {
    status,
    headers: addSecurityHeaders(
      new Headers({ 'Content-Type': includeDetails ? 'application/json' : 'text/plain' }),
    ),
  })
}
