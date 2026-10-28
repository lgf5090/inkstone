// Derived from Xget (AGPL-3.0-only) src/protocols/huggingface.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.

export function isHuggingFaceAPIRequest(request: Request, url: URL): boolean {
  void request
  if (url.pathname.startsWith('/hf/api/')) return true
  return url.pathname.startsWith('/hf/token')
}

export function configureHuggingFaceHeaders(headers: Headers, request: Request): void {
  const authorization = request.headers.get('Authorization')
  if (authorization) headers.set('Authorization', authorization)
  if (request.method === 'POST' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
}
