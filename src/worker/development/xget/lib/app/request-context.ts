// Derived from Xget (AGPL-3.0-only) src/app/request-context.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import type { XgetConfig, XgetConfigOverrides } from '../config'
import { createConfig } from '../config'
import { getRequestTraits, type RequestTraits } from '../utils/validation'

export interface XgetRequestContext extends RequestTraits {
  config: XgetConfig
  isCorsPreflight: boolean
  proxyBaseUrl: string
  request: Request
  url: URL
}

export function createRequestContext(
  request: Request,
  overrides: XgetConfigOverrides,
  proxyBaseUrl: string,
): XgetRequestContext {
  const config = createConfig(overrides)
  const url = new URL(request.url)
  const traits = getRequestTraits(request, url)

  return {
    ...traits,
    config,
    isCorsPreflight:
      request.method === 'OPTIONS' &&
      request.headers.has('Origin') &&
      request.headers.has('Access-Control-Request-Method'),
    proxyBaseUrl,
    request,
    url,
  }
}
