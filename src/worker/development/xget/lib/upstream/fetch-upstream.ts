// Derived from Xget (AGPL-3.0-only) src/upstream/fetch-upstream.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import {
  XGET_MAX_BUFFERED_BODY_BYTES,
  XGET_MAX_REQUEST_BODY_BYTES,
} from '@shared/development/xget/constants'
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

export interface BodyLimits {
  request: number
  buffered: number
}

const DEFAULT_BODY_LIMITS: BodyLimits = {
  request: XGET_MAX_REQUEST_BODY_BYTES,
  buffered: XGET_MAX_BUFFERED_BODY_BYTES,
}

export type PreparedRequestBody =
  | {
      ok: true
      body: Uint8Array | ReadableStream<Uint8Array> | null
      buffered: boolean
      tooLarge: () => boolean
    }
  | { ok: false; response: Response }

function bodyTooLarge(): Response {
  return createErrorResponse('Request body too large', 413)
}

async function cancelBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch (error) {
    console.warn(
      '[xget] Failed to cancel request body:',
      error instanceof Error ? error.name : 'unknown error',
    )
  }
}

function guardBodyStream(
  body: ReadableStream<Uint8Array>,
  limitBytes: number,
): { stream: ReadableStream<Uint8Array>; tooLarge: () => boolean } {
  const reader = body.getReader()
  let total = 0
  let tooLarge = false

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch (error) {
        controller.error(error)
        return
      }
      if (next.done) {
        controller.close()
        return
      }
      if (!next.value) return
      total += next.value.byteLength
      if (total > limitBytes) {
        tooLarge = true
        controller.error(new Error('request body too large'))
        await cancelBodyReader(reader)
        return
      }
      controller.enqueue(next.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return { stream, tooLarge: () => tooLarge }
}

function replayStream(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  totalBytes: number,
  limitBytes: number,
): { stream: ReadableStream<Uint8Array>; tooLarge: () => boolean } {
  let total = totalBytes
  let tooLarge = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
    },
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch (error) {
        controller.error(error)
        return
      }
      if (next.done) {
        controller.close()
        return
      }
      if (!next.value) return
      total += next.value.byteLength
      if (total > limitBytes) {
        tooLarge = true
        controller.error(new Error('request body too large'))
        await cancelBodyReader(reader)
        return
      }
      controller.enqueue(next.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return { stream, tooLarge: () => tooLarge }
}

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export async function prepareRequestBody(
  request: Request,
  limits: BodyLimits = DEFAULT_BODY_LIMITS,
): Promise<PreparedRequestBody> {
  if (request.body === null) {
    return { ok: true, body: null, buffered: true, tooLarge: () => false }
  }

  const declaredLength = request.headers.get('Content-Length')
  const declared = declaredLength === null ? null : Number(declaredLength)
  if (declared !== null && Number.isFinite(declared)) {
    if (declared > limits.request) return { ok: false, response: bodyTooLarge() }
    if (declared > limits.buffered) {
      const guarded = guardBodyStream(request.body, limits.request)
      return { ok: true, body: guarded.stream, buffered: false, tooLarge: guarded.tooLarge }
    }
    const buffered = await readRequestBodyWithinLimit(request, limits.buffered)
    if (!buffered.ok) return { ok: false, response: buffered.response }
    return { ok: true, body: buffered.body, buffered: true, tooLarge: () => false }
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return {
          ok: true,
          body: joinChunks(chunks, total),
          buffered: true,
          tooLarge: () => false,
        }
      }
      if (!value) continue
      total += value.byteLength
      if (total > limits.request) {
        await cancelBodyReader(reader)
        return { ok: false, response: bodyTooLarge() }
      }
      if (total > limits.buffered) {
        chunks.push(value)
        const replayed = replayStream(chunks, reader, total, limits.request)
        return {
          ok: true,
          body: replayed.stream,
          buffered: false,
          tooLarge: replayed.tooLarge,
        }
      }
      chunks.push(value)
    }
  } catch (error) {
    console.warn(
      '[xget] Failed to read request body:',
      error instanceof Error ? error.name : 'unknown error',
    )
    await cancelBodyReader(reader)
    return { ok: false, response: createErrorResponse('Failed to read request body', 400) }
  }
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

  const preparedBody =
    request.body !== null && !canUseCache
      ? await prepareRequestBody(request)
      : { ok: true as const, body: null, buffered: true, tooLarge: () => false }
  if (!preparedBody.ok) {
    return { response: preparedBody.response, responseGeneratedLocally: true }
  }
  const bufferedBody = preparedBody.buffered ? (preparedBody.body as Uint8Array | null) : null
  const streamingBody = preparedBody.buffered
    ? undefined
    : (preparedBody.body as ReadableStream<Uint8Array>)
  const canRetryBody = preparedBody.buffered

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
        body: bufferedBody ?? streamingBody ?? fetchOptions.body,
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

      if (!canRetryBody) {
        monitor.mark('streaming_body_no_retry')
        break
      }

      attempts++
      if (attempts < config.MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, config.RETRY_DELAY_MS * attempts))
      }
    } catch (error) {
      attempts++
      if (preparedBody.tooLarge()) {
        response = bodyTooLarge()
        responseGeneratedLocally = true
        break
      }

      if (error instanceof Error && error.name === 'AbortError') {
        response = createErrorResponse('Request timeout', 408)
        responseGeneratedLocally = true
        break
      }

      console.warn(
        '[xget] Upstream fetch attempt failed:',
        error instanceof Error ? error.name : 'unknown error',
      )

      if (!canRetryBody || attempts >= config.MAX_RETRIES) {
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
