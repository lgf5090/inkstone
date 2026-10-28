// Derived from Xget (AGPL-3.0-only) src/upstream/fetch-upstream.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { XGET_MAX_BUFFERED_BODY_BYTES } from '@shared/development/xget/constants'
import type { XgetConfig } from '../config'
import { configureAIHeaders } from '../protocols/ai'
import {
  fetchToken,
  getScopeFromUrl,
  parseAuthenticate,
  readRegistryTokenResponse,
  responseUnauthorized,
} from '../protocols/docker'
import { configureGitHeaders } from '../protocols/git'
import { configureHuggingFaceHeaders } from '../protocols/huggingface'
import { stripOutboundRequestHeaders } from '../utils/headers'
import type { PerformanceMonitor } from '../utils/performance'
import { createErrorResponse } from '../utils/security'
import type { RequestTraits } from '../utils/validation'
import type { CachePolicy } from './cache-policy'

const MEDIA_FILE_PATTERN =
  /\.(mp4|avi|mkv|mov|wmv|flv|webm|mp3|wav|flac|aac|ogg|jpg|jpeg|png|gif|bmp|svg|pdf|zip|rar|7z|tar|gz|bz2|xz)$/i

export type BodyReadResult =
  | { ok: true; body: Uint8Array | null }
  | { ok: false; response: Response }

export async function readRequestBodyWithinLimit(
  request: Request,
  limitBytes: number = XGET_MAX_BUFFERED_BODY_BYTES,
): Promise<BodyReadResult> {
  if (request.body === null) return { ok: true, body: null }

  const declaredLength = request.headers.get('Content-Length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (Number.isFinite(parsedLength) && parsedLength > limitBytes) {
      return { ok: false, response: createErrorResponse('Request body too large', 413) }
    }
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limitBytes) {
        try {
          await reader.cancel()
        } catch (error) {
          console.warn(
            '[xget] Failed to cancel oversized request body:',
            error instanceof Error ? error.name : 'unknown error',
          )
        }
        return { ok: false, response: createErrorResponse('Request body too large', 413) }
      }
      chunks.push(value)
    }
  } catch (error) {
    console.warn(
      '[xget] Failed to read request body:',
      error instanceof Error ? error.name : 'unknown error',
    )
    return { ok: false, response: createErrorResponse('Failed to read request body', 400) }
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return { ok: true, body }
}

function createFetchOptions({
  authorization,
  cachePolicy,
  config,
  request,
  requestContext,
  shouldPassthroughRequest,
  targetUrl,
}: {
  authorization: string | null
  cachePolicy?: Pick<CachePolicy, 'allowFetchCache' | 'edgeTtl'>
  config: XgetConfig
  request: Request
  requestContext: RequestTraits & { url: URL }
  shouldPassthroughRequest: boolean
  targetUrl: string
}): { fetchOptions: RequestInit; requestHeaders: Headers } {
  const { isAI, isGit, isGitLFS, isHF, url } = requestContext
  const fetchOptions: RequestInit = {
    method: request.method,
    headers: new Headers(),
    redirect: 'follow',
  }
  const requestHeaders = fetchOptions.headers as Headers

  if (shouldPassthroughRequest) {
    const passthroughHeaders = stripOutboundRequestHeaders(request.headers)
    for (const [key, value] of passthroughHeaders.entries()) requestHeaders.set(key, value)

    if (isGit || isGitLFS) configureGitHeaders(requestHeaders, request, url, isGitLFS)
    if (isAI) configureAIHeaders(requestHeaders, request)
    if (isHF) configureHuggingFaceHeaders(requestHeaders, request)

    return { fetchOptions, requestHeaders }
  }

  if (!cachePolicy || cachePolicy.allowFetchCache) {
    Object.assign(fetchOptions, {
      cf: {
        http3: true,
        cacheTtl: cachePolicy ? cachePolicy.edgeTtl : config.CACHE_DURATION,
        cacheEverything: true,
        preconnect: true,
      },
    })
  }

  requestHeaders.set('Accept-Encoding', 'gzip, deflate, br')
  requestHeaders.set('User-Agent', 'Wget/1.21.3')

  const origin = request.headers.get('Origin')
  if (origin) requestHeaders.set('Origin', origin)

  if (authorization) requestHeaders.set('Authorization', authorization)

  const rangeHeader = request.headers.get('Range')
  if (MEDIA_FILE_PATTERN.test(targetUrl) || rangeHeader) {
    requestHeaders.set('Accept-Encoding', 'identity')
  }
  if (rangeHeader) requestHeaders.set('Range', rangeHeader)

  return { fetchOptions, requestHeaders }
}

async function followDockerRedirectIfNeeded(
  response: Response,
  targetUrl: string,
  finalFetchOptions: RequestInit,
): Promise<Response> {
  if (![301, 302, 303, 307, 308].includes(response.status)) return response

  const location = response.headers.get('Location')
  if (!location) return response

  let locationUrl: URL
  try {
    locationUrl = new URL(location, targetUrl)
  } catch {
    console.warn('[xget] Docker redirect target is invalid')
    return response
  }
  if (locationUrl.protocol !== 'https:' && locationUrl.protocol !== 'http:') {
    console.warn('[xget] Docker redirect target uses an unsupported protocol')
    return response
  }

  const redirectHeaders = new Headers(finalFetchOptions.headers as Headers)
  redirectHeaders.delete('Authorization')

  return await fetch(locationUrl, {
    ...finalFetchOptions,
    headers: redirectHeaders,
    redirect: 'follow',
  })
}

async function executeFetch({
  fetchOptions,
  request,
  requestContext,
  requestHeaders,
  targetUrl,
}: {
  fetchOptions: RequestInit
  request: Request
  requestContext: { isDocker: boolean }
  requestHeaders: Headers
  targetUrl: string
}): Promise<Response> {
  const finalFetchOptions: RequestInit = { ...fetchOptions, signal: fetchOptions.signal }
  if (requestContext.isDocker) finalFetchOptions.redirect = 'manual'

  let response: Response

  if (request.method === 'HEAD') {
    response = await fetch(targetUrl, finalFetchOptions)

    if (response.ok && !response.headers.get('Content-Length')) {
      const rangeHeaders = new Headers(requestHeaders)
      rangeHeaders.set('Range', 'bytes=0-0')

      const rangeResponse = await fetch(targetUrl, {
        ...finalFetchOptions,
        method: 'GET',
        headers: rangeHeaders,
      })

      let contentLength: string | null = null
      if (rangeResponse.status === 206) {
        const contentRange = rangeResponse.headers.get('Content-Range')
        const match = contentRange?.match(/bytes\s+\d+-\d+\/(\d+)/)
        if (match) contentLength = match[1]
      } else if (rangeResponse.ok) {
        contentLength = rangeResponse.headers.get('Content-Length')
      }

      if (contentLength) {
        const headHeaders = new Headers(response.headers)
        headHeaders.set('Content-Length', contentLength)
        response = new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: headHeaders,
        })
      }
    }
  } else {
    response = await fetch(targetUrl, finalFetchOptions)
  }

  if (requestContext.isDocker) {
    response = await followDockerRedirectIfNeeded(response, targetUrl, finalFetchOptions)
  }

  return response
}

async function retryDockerWithAnonymousToken({
  effectivePath,
  finalFetchOptions,
  platform,
  proxyBaseUrl,
  requestContext,
  requestHeaders,
  response,
  targetUrl,
  timeoutSeconds,
}: {
  effectivePath: string
  finalFetchOptions: RequestInit
  platform: string
  proxyBaseUrl: string
  requestContext: { isDocker: boolean; url: URL }
  requestHeaders: Headers
  response: Response
  targetUrl: string
  timeoutSeconds: number
}): Promise<Response> {
  const authenticateStr = response.headers.get('WWW-Authenticate')
  const scope = getScopeFromUrl(requestContext.url, effectivePath, platform)

  if (authenticateStr) {
    try {
      const wwwAuthenticate = parseAuthenticate(authenticateStr)
      const tokenResponse = await fetchToken(wwwAuthenticate, scope || '', '', timeoutSeconds)

      if (tokenResponse.ok) {
        const token = await readRegistryTokenResponse(tokenResponse)
        if (token) {
          const retryHeaders = new Headers(requestHeaders)
          retryHeaders.set('Authorization', `Bearer ${token}`)

          const retryOptions: RequestInit = {
            ...finalFetchOptions,
            headers: retryHeaders,
            redirect: 'manual',
          }

          const retryResponse = await followDockerRedirectIfNeeded(
            await fetch(targetUrl, retryOptions),
            targetUrl,
            retryOptions,
          )

          if (retryResponse.ok) return retryResponse
        }
      }
    } catch (error) {
      console.warn(
        '[xget] Docker anonymous token retry failed:',
        error instanceof Error ? error.name : 'unknown error',
      )
    }
  }

  return responseUnauthorized(platform, proxyBaseUrl)
}

export async function fetchUpstreamResponse({
  authorization,
  cachePolicy,
  canUseCache,
  config,
  effectivePath,
  monitor,
  platform,
  request,
  requestContext,
  shouldPassthroughRequest,
  targetUrl,
}: {
  authorization: string | null
  cachePolicy?: Pick<CachePolicy, 'allowFetchCache' | 'edgeTtl'>
  canUseCache: boolean
  config: XgetConfig
  effectivePath: string
  monitor: PerformanceMonitor
  platform: string
  request: Request
  requestContext: RequestTraits & { url: URL; proxyBaseUrl: string }
  shouldPassthroughRequest: boolean
  targetUrl: string
}): Promise<{ response: Response; responseGeneratedLocally: boolean }> {
  let response: Response | undefined
  let responseGeneratedLocally = false

  let bufferedBody: Uint8Array | null = null
  if (request.body !== null && !canUseCache) {
    const bodyResult = await readRequestBodyWithinLimit(request)
    if (!bodyResult.ok) return { response: bodyResult.response, responseGeneratedLocally: true }
    bufferedBody = bodyResult.body
  }

  const { fetchOptions, requestHeaders } = createFetchOptions({
    authorization,
    cachePolicy,
    config,
    request,
    requestContext,
    shouldPassthroughRequest,
    targetUrl,
  })

  let attempts = 0
  while (attempts < config.MAX_RETRIES) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      monitor.mark(`attempt_${attempts}`)

      const controller = new AbortController()
      timeoutId = setTimeout(() => controller.abort(), config.TIMEOUT_SECONDS * 1000)

      const attemptOptions: RequestInit = {
        ...fetchOptions,
        signal: controller.signal,
        body: bufferedBody ?? fetchOptions.body,
      }

      response = await executeFetch({
        fetchOptions: attemptOptions,
        request,
        requestContext,
        requestHeaders,
        targetUrl,
      })

      if (response.ok || response.status === 206) {
        monitor.mark('success')
        break
      }

      if (requestContext.isDocker && response.status === 401) {
        monitor.mark('docker_auth_challenge')
        response = await retryDockerWithAnonymousToken({
          effectivePath,
          finalFetchOptions: attemptOptions,
          platform,
          proxyBaseUrl: requestContext.proxyBaseUrl,
          requestContext,
          requestHeaders,
          response,
          targetUrl,
          timeoutSeconds: config.TIMEOUT_SECONDS,
        })
        if (response.ok) monitor.mark('success')
        break
      }

      if (response.status >= 400 && response.status < 500) {
        monitor.mark('client_error')
        break
      }

      attempts++
      if (attempts < config.MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, config.RETRY_DELAY_MS * attempts))
      }
    } catch (error) {
      attempts++
      if (error instanceof Error && error.name === 'AbortError') {
        response = createErrorResponse('Request timeout', 408)
        responseGeneratedLocally = true
        break
      }

      console.warn(
        '[xget] Upstream fetch attempt failed:',
        error instanceof Error ? error.name : 'unknown error',
      )

      if (attempts >= config.MAX_RETRIES) {
        response = createErrorResponse('Upstream request failed', 502)
        responseGeneratedLocally = true
        break
      }

      await new Promise((resolve) => setTimeout(resolve, config.RETRY_DELAY_MS * attempts))
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }

  if (!response) {
    response = createErrorResponse('No response received after all retry attempts', 500)
    responseGeneratedLocally = true
  }

  return { response, responseGeneratedLocally }
}
