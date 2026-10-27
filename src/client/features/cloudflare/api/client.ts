/**
 * The Cloudflare app's only door to `/api/cloudflare`.
 *
 * Three shapes are needed and they do not share one: ordinary JSON goes through the notebook's
 * `request()` (timeouts, error codes, the localised refusal), downloads need the bytes rather than a
 * decoded body, and the OpenAI-compatible endpoints answer with a stream the caller reads itself.
 * All three carry the client header, because every route here is a POST away from being refused.
 */
import { CLIENT_HEADER } from '@shared/constants'
import { ApiError, CLIENT_ID, request, type RequestOptions } from '../../../lib/api'
import { getLocale, translateApiError } from '../../../lib/i18n'

const BASE = '/api/cloudflare'

export function cfRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(`${BASE}${path}`, options)
}

function baseHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra)
  headers.set(CLIENT_HEADER, '1')
  headers.set('X-Inkstone-Origin', CLIENT_ID)
  headers.set('Accept-Language', getLocale())
  return headers
}

export interface CloudflareDownload {
  blob: Blob
  filename: string
}

/** A binary answer (an R2 object, a PDF) with the filename the route chose. */
export async function cfDownload(path: string, fallbackName: string): Promise<CloudflareDownload> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, { headers: baseHeaders(), credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'offline', 'The network is unavailable')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new ApiError(response.status, 'download_failed', body?.error?.message ?? 'The download failed')
  }
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const filename = /filename="([^"\r\n]+)"/i.exec(disposition)?.[1] ?? fallbackName
  return { blob: await response.blob(), filename }
}

/**
 * A streaming POST (the OpenAI-compatible endpoints).
 *
 * The caller owns the body and must cancel the reader when it stops: this function cannot know when
 * a stream is finished with.
 */
export async function cfStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: baseHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new ApiError(0, 'offline', 'The network is unavailable')
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      error?: string | { message?: string }
      message?: string
    } | null
    const message = typeof payload?.error === 'string'
      ? payload.error
      : payload?.error?.message ?? payload?.message ?? 'The request was refused'
    throw new ApiError(response.status, 'cloudflare_upstream', message)
  }
  return response
}

/**
 * The one sentence a failed call shows: the localized line for the code.
 *
 * It used to prefer the server's own English, which put a raw GraphQL complaint in the middle of a
 * Chinese screen. The route's sentence is still worth reading — it just belongs on the detail line
 * below the headline, which is what `cfErrorDetail` is for.
 */
export function cfErrorText(error: unknown): string {
  if (error instanceof ApiError) return translateApiError(error.code, error.serverMessage ?? error.message)
  if (error instanceof Error) return error.message
  return String(error)
}

/** The route's or Cloudflare's own words, when they add something the localized headline cannot say. */
export function cfErrorDetail(error: unknown): string {
  if (!(error instanceof ApiError)) return ''
  const raw = error.serverMessage || error.message
  const headline = cfErrorText(error)
  return raw && raw !== headline ? raw : ''
}
