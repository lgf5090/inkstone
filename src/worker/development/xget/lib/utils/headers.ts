// Derived from Xget (AGPL-3.0-only) src/utils/security.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.

const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'proxy-connection',
  'proxy-authorization',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'content-length',
])

const SITE_PRIVATE_HEADERS = new Set([
  'cookie',
  'x-inkstone-client',
  'x-inkstone-origin',
  'x-real-ip',
  'x-xget-token',
])

const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2', 'clear-site-data'])

export function isStrippedOutboundRequestHeader(name: string): boolean {
  const lower = name.toLowerCase()
  if (HOP_BY_HOP_HEADERS.has(lower) || SITE_PRIVATE_HEADERS.has(lower)) return true
  return lower.startsWith('cf-') || lower.startsWith('x-forwarded-')
}

export function isStrippedUpstreamResponseHeader(name: string): boolean {
  const lower = name.toLowerCase()
  if (STRIPPED_RESPONSE_HEADERS.has(lower)) return true
  return lower.startsWith('access-control-')
}

export function stripOutboundRequestHeaders(headers: Headers): Headers {
  const sanitized = new Headers()
  for (const [name, value] of headers.entries()) {
    if (isStrippedOutboundRequestHeader(name)) continue
    sanitized.set(name, value)
  }
  return sanitized
}

export function stripUpstreamResponseHeaders(headers: Headers): Headers {
  const sanitized = new Headers()
  for (const [name, value] of headers.entries()) {
    if (isStrippedUpstreamResponseHeader(name)) continue
    sanitized.set(name, value)
  }
  return sanitized
}
