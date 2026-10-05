export function securityHeaders(url: string): Record<string, string> {
  const isHttps = new URL(url).protocol === 'https:'
  const imageSchemes = isHttps ? 'https:' : 'https: http:'
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'; base-uri 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ",
      `img-src 'self' data: blob: ${imageSchemes}; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; `,
      "manifest-src 'self'; media-src 'self' blob:; form-action 'self'; frame-src 'none'; ",
      "frame-ancestors 'none'; object-src 'none'",
    ].join(''),
  }
  if (isHttps) headers['Strict-Transport-Security'] = 'max-age=31536000'
  return headers
}

// The OAuth provider and the MCP handler answer their own responses, so the app
// middleware never sees them and the headers have to be applied at the edge.
export function withSecurityHeaders(response: Response, url: string): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(securityHeaders(url))) {
    if (!headers.has(name)) headers.set(name, value)
  }
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
