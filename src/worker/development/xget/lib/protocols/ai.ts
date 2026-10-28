// Derived from Xget (AGPL-3.0-only) src/protocols/ai.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.

export function isAIInferenceRequest(request: Request, url: URL): boolean {
  void request
  return url.pathname.startsWith('/ip/')
}

export function configureAIHeaders(headers: Headers, request: Request): void {
  if (request.method === 'POST' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'Xget-AI-Proxy/1.0')
  }
}
