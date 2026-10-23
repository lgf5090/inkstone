import { LIMITS, SETTINGS_REQUEST_BUDGET_BYTES } from '@shared/constants'
import { MAX_ARTIFACT_CONTENT_CHARS, MAX_SKILL_BUNDLE_SKILLS, MAX_SKILL_CONTENT_CHARS } from '@shared/assistant'
import { utf8ByteLength } from '@shared/text-utils'
import { ApiError } from './errors'


export const JSON_BODY_LIMITS = {
  small: 8 * 1024,
  // The shared number, because the settings lists in `@shared/constants` were sized against it.
  settings: SETTINGS_REQUEST_BUDGET_BYTES,
  templateLibrary: 1024 * 1024,
  quickAdd: 1024 * 1024,
  backup: 32 * 1024,
  // A hub batch names up to a hundred files, and a tag write can carry a hundred tags of a hundred
  // characters each — the most either route can legitimately be asked to parse.
  attachmentHub: 64 * 1024,
  profile: 256 * 1024,
  // A whole skill library arriving at once: the ceiling is the number of skills the list route will hand
  // over, times the most a single one may hold. Nothing smaller can refuse a file this app can produce.
  skillBundle: MAX_SKILL_BUNDLE_SKILLS * (MAX_SKILL_CONTENT_CHARS + 1024) + 64 * 1024,
  note: LIMITS.contentMaxBytes * 6 + 64 * 1024,
  // One draft in the side panel: the most it may hold, times the worst-case bytes per character and the
  // escaping a JSON body adds — the same arithmetic the note ceiling above is built from.
  artifact: MAX_ARTIFACT_CONTENT_CHARS * 6 + 64 * 1024,
} as const

export const FORM_BODY_LIMITS = {
  authorization: 16 * 1024,
  oauthToken: 16 * 1024,
  attachment: LIMITS.attachmentMaxBytes + 512 * 1024,
  import: LIMITS.importUploadMaxBytes + 1024 * 1024,
} as const


export async function readJson<T>(
  c: {
    req: {
      json: () => Promise<unknown>
      text: () => Promise<string>
      raw?: Request
      header?: (name: string) => string | undefined
    }
  },
  maxBytes?: number,
): Promise<T> {
  if (maxBytes) assertDeclaredBodySize(c.req, maxBytes)
  let value: unknown
  try {
    if (maxBytes) {
      const text = await readTextWithinLimit(c.req, maxBytes)
      value = JSON.parse(text) as unknown
    } else {
      value = await c.req.json()
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('The request body is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('The request body must be a JSON object')
  }
  return value as T
}


export async function readFormDataWithinLimit(
  req: {
    raw?: Request
    header?: (name: string) => string | undefined
  },
  maxBytes: number,
): Promise<FormData> {
  assertDeclaredBodySize(req, maxBytes)
  const contentType = req.header?.('Content-Type') ?? req.raw?.headers.get('Content-Type') ?? ''
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    throw ApiError.badRequest('The request body must use multipart/form-data')
  }

  const bytes = await readBytesWithinLimit(req.raw?.body, maxBytes)
  try {
    return await new Request('https://inkstone.invalid/upload', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bytes as BodyInit,
    }).formData()
  } catch {
    throw ApiError.badRequest('The upload form is invalid')
  }
}

export async function readUrlEncodedFormWithinLimit(
  req: {
    raw?: Request
    header?: (name: string) => string | undefined
  },
  maxBytes: number,
): Promise<URLSearchParams> {
  assertDeclaredBodySize(req, maxBytes)
  const contentType = req.header?.('Content-Type') ?? req.raw?.headers.get('Content-Type') ?? ''
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
    throw ApiError.badRequest('The request body must use application/x-www-form-urlencoded')
  }
  const bytes = await readBytesWithinLimit(req.raw?.body, maxBytes)
  return new URLSearchParams(new TextDecoder().decode(bytes))
}


export function readOptionalJson<T extends object>(
  c: Parameters<typeof readJson<T>>[0],
  maxBytes: number,
  fallback: T,
): Promise<T> {
  const declared = c.req.header?.('Content-Length')
  if (c.req.raw?.body == null || declared === '0') return Promise.resolve(fallback)
  return readJson<T>(c, maxBytes)
}


export function assertDeclaredBodySize(
  req: { header?: (name: string) => string | undefined },
  maxBytes: number,
): void {
  if (!req.header) return
  const raw = req.header('Content-Length')
  if (raw === undefined) return
  const declared = Number(raw)
  if (Number.isFinite(declared) && declared >= 0 && declared > maxBytes) {
    throw ApiError.tooLarge('The request body is too large')
  }
}

async function readTextWithinLimit(
  req: { raw?: Request; text: () => Promise<string> },
  maxBytes: number,
): Promise<string> {
  const stream = req.raw?.body
  if (!stream) {
    const text = await req.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw ApiError.tooLarge('The request body is too large')
    return text
  }

  return new TextDecoder().decode(await readBytesWithinLimit(stream, maxBytes))
}

/**
 * The one capped stream reader.
 *
 * The request-body reader, the chat attachment fetch, the RSS relay, the update check and the backup
 * transports each carried their own copy of the same loop — `getReader`, add up `byteLength`, cancel
 * once the total passes the ceiling, join the chunks back. The loop is the same in all five and only
 * the answer differs, so this holds the loop and answers with `null` when the ceiling is passed: the
 * caller turns that into its own status, its own message, or its own "no body" value.
 *
 * Counting while streaming is the point. Reading the whole body and checking its length afterwards
 * lets whoever is on the other side decide how much memory this request holds.
 */
export async function readStreamWithinLimit(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array()

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        // Best-effort: the payload is already refused, and a `cancel()` that itself rejects would
        // replace the caller's honest overflow answer with a stream plumbing error.
        try {
          await reader.cancel('payload_too_large')
        } catch {
          // The reader is released below and the source is dropped with it.
        }
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function readBytesWithinLimit(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  const bytes = await readStreamWithinLimit(stream, maxBytes)
  if (bytes === null) throw ApiError.tooLarge('The request body is too large')
  return bytes
}

/** The same ceiling read as text: `null` means the far side sent more than `maxBytes`. */
export async function readStreamTextWithinLimit(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<string | null> {
  const bytes = await readStreamWithinLimit(stream, maxBytes)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}


export function requestClientIp(source: {
  req: { header: (name: string) => string | undefined; raw?: Request }
} | Request): string {
  const request = source instanceof Request ? source : source.req.raw
  const value = (source instanceof Request
    ? source.headers.get('CF-Connecting-IP')
    : source.req.header('CF-Connecting-IP'))?.trim().toLowerCase()
  if (!value) return 'local'
  // CF-Connecting-IP is injected by the Cloudflare edge and cannot be
  // spoofed there. On any other runtime the header is client-controlled,
  // so ignore it rather than trusting it for throttling.
  if (!request || !(request as Request & { cf?: unknown }).cf) return 'local'
  return value.replace(/[^a-f0-9:.%-]/g, '').slice(0, 64) || 'unknown'
}

export function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}


export function assertContentSize(content: string): void {
  if (utf8ByteLength(content) > LIMITS.contentMaxBytes) {
    throw ApiError.tooLarge(`Note content exceeds the ${LIMITS.contentMaxBytes / 1_000_000} MB limit`)
  }
}
