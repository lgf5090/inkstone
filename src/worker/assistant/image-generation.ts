/**
 * Drawing a picture, on the reader's own image model.
 *
 * The chat wire and the image wire are two different doors even when they share a host and a key, so this
 * is a client of its own rather than a mode of `upstream.ts`: there is no stream to read, no tool calls and
 * no thinking dialect — one JSON request, one picture back, either inline as base64 or behind a URL that
 * has to be fetched before the vendor forgets it.
 *
 * Only the OpenAI-compatible shape is implemented, and a model of another protocol is refused by name. Not
 * a limitation of effort but of the wire: Anthropic has no image endpoint at all, and Gemini's answers a
 * different request with a different body — calling either with this one would earn a 400 the reader would
 * have to read as a bug in this app.
 *
 * What comes back is never trusted as an image because the vendor said so. The bytes are sniffed and the
 * claimed type has to match their signature, because these bytes go into the reader's own file storage and
 * then into an `<img>` in their browser.
 */

import { assertRelayableEndpoint, pickRelayHeaders } from '@shared/ai-proxy-guard'
import type { AssistantProtocol } from '@shared/assistant'
import { fromBase64 } from '../lib/encoding'
import { hasExpectedImageSignature } from '../lib/image'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'

/** How long one picture may take. The slowest vendors spend a minute on a large one. */
export const IMAGE_GENERATION_TIMEOUT_MS = 120_000

/**
 * The sizes a request may name, spelled the way the OpenAI-compatible vendors spell them.
 *
 * Deliberately not exhaustive and not per-model: the field is optional, and omitting it leaves the choice
 * to the model, which is the only party that knows what it supports. A size named here and refused by the
 * far end is reported as the vendor's own error rather than silently corrected.
 */
export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792'] as const

export class ImageGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageGenerationError'
  }
}

/** `{base}/images/generations`, by the same rule the chat endpoint follows. */
export function imagesEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith('/images/generations')) return base
  const afterHost = base.replace(/^[a-z]+:\/\//i, '')
  return afterHost.includes('/') ? `${base}/images/generations` : `${base}/v1/images/generations`
}

export interface ImageRequest {
  protocol: AssistantProtocol
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  /** Left out when the reader's model is the one that should decide; see `IMAGE_SIZES`. */
  size?: string
}

export interface GeneratedImage {
  bytes: Uint8Array
  mime: string
}

export async function generateImage(input: ImageRequest): Promise<GeneratedImage> {
  if (input.protocol !== 'openai') {
    throw new ImageGenerationError(
      `Image generation needs a model on an OpenAI-compatible provider; this one speaks ${input.protocol}.`,
    )
  }
  let url: URL
  try {
    url = assertRelayableEndpoint(imagesEndpoint(input.baseUrl))
  } catch (error) {
    throw new ImageGenerationError(error instanceof Error ? error.message : 'That provider address cannot be called.')
  }
  const body: Record<string, unknown> = { model: input.model, prompt: input.prompt, n: 1 }
  if (input.size) body.size = input.size
  const headers = pickRelayHeaders({
    'content-type': 'application/json',
    accept: 'application/json',
    ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
  }) as Record<string, string>

  // One deadline for the whole exchange, the second fetch included: a vendor that hands back a URL instead
  // of bytes has not finished the job, and the clock on "one picture" covers both halves of it.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_GENERATION_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        // The address was vetted, the redirect target was not: a provider that answers with one is not
        // allowed to move the request to an address this app never checked.
        redirect: NO_REDIRECT,
      })
    } catch (error) {
      if (controller.signal.aborted) throw new ImageGenerationError(`The image model did not answer within ${IMAGE_GENERATION_TIMEOUT_MS / 1000} seconds.`)
      throw new ImageGenerationError(`Could not reach the image model: ${error instanceof Error ? error.message : 'the request failed'}.`)
    }
    if (isRedirectResponse(response)) throw new ImageGenerationError('The image model answered with a redirect, which this app refuses to follow.')
    if (!response.ok) throw new ImageGenerationError(await describeFailure(response))

    const payload = await response.json().catch(() => null) as { data?: unknown } | null
    const first = Array.isArray(payload?.data) ? payload.data[0] as Record<string, unknown> | undefined : undefined
    if (!first) throw new ImageGenerationError('The image model answered with no picture in it.')

    if (typeof first.b64_json === 'string' && first.b64_json) {
      return decodeInline(first.b64_json)
    }
    if (typeof first.url === 'string' && first.url) {
      return await fetchVendorImage(first.url, controller.signal)
    }
    throw new ImageGenerationError('The image model answered with no picture in it.')
  } finally {
    clearTimeout(timer)
  }
}

/** Base64 straight from the vendor, checked against its own signature before it is called an image. */
function decodeInline(encoded: string): GeneratedImage {
  let bytes: Uint8Array
  try {
    bytes = fromBase64(encoded)
  } catch {
    throw new ImageGenerationError('The image model sent a picture this app could not read.')
  }
  if (!bytes.length) throw new ImageGenerationError('The image model sent an empty picture.')
  const mime = sniffImageMime(bytes)
  if (!mime) throw new ImageGenerationError('What the image model sent was not a picture.')
  return { bytes, mime }
}

/**
 * The other half of the same answer: a link the vendor keeps for an hour.
 *
 * Fetched now and stored, never linked to. A thread is read for years and a vendor's URL is read for
 * minutes, so an attachment that pointed at one would be a broken image by tomorrow — and the link would
 * also tell that vendor when the reader opens their own conversation.
 */
async function fetchVendorImage(rawUrl: string, signal: AbortSignal): Promise<GeneratedImage> {
  let target: URL
  try {
    target = assertRelayableEndpoint(rawUrl)
  } catch {
    throw new ImageGenerationError('The image model handed back an address this app will not call.')
  }
  let response: Response
  try {
    response = await fetch(target, { signal, redirect: NO_REDIRECT })
  } catch {
    throw new ImageGenerationError('The picture the image model linked to could not be fetched.')
  }
  if (isRedirectResponse(response)) throw new ImageGenerationError('The picture link redirected somewhere this app refuses to fetch.')
  if (!response.ok) throw new ImageGenerationError(`The picture the image model linked to could not be fetched (${response.status}).`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.length) throw new ImageGenerationError('The image model sent an empty picture.')
  const mime = sniffImageMime(bytes)
  if (!mime) throw new ImageGenerationError('What the image model sent was not a picture.')
  return { bytes, mime }
}

/**
 * What these bytes actually are, read from their own signature.
 *
 * The vendor's `content-type` is not consulted: it is a claim by the party whose answer is being checked,
 * and `saveChatUpload` will decide how the attachment may be rendered from what this returns.
 */
function sniffImageMime(bytes: Uint8Array): string | null {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif']) {
    if (hasExpectedImageSignature(bytes, mime)) return mime
  }
  return null
}

/** The vendor's own words when it refuses, so the reader is told what it said rather than that it failed. */
async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  let detail = text.slice(0, 400)
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string, message?: unknown }
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
    detail = typeof message === 'string' && message ? message : typeof parsed.message === 'string' ? parsed.message : detail
  } catch {
    // Not JSON, or not the shape either vendor uses; the raw text is the best available answer.
  }
  if (response.status === 401 || response.status === 403) {
    return `The image model refused this key (${response.status}). Check the provider's API key.`
  }
  if (response.status === 404) {
    return `The image model was not found at that provider (404). Check the model id and the provider's address.${detail ? ` ${detail}` : ''}`
  }
  if (response.status === 429) return 'The image model is rate limited right now. Try again shortly.'
  return `The image model refused the request (${response.status}).${detail ? ` ${detail}` : ''}`
}
