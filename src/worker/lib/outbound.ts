/**
 * The one door out.
 *
 * Every channel sends through here, because the address is the reader's and the network is the
 * deployment's — the exact shape of a request that can be aimed at a metadata endpoint. Three rules,
 * and each of them exists because of a way the alternative fails:
 *
 *  - the target is checked against the shared guard, which is the same list the AI relay and the feed
 *    relay use, so a private address is refused once rather than three different ways;
 *  - redirects are not followed, because the guard checks the address that was typed and a redirect
 *    would replace it with one nobody checked;
 *  - every call is bounded in time and in bytes, because a webhook that never answers would otherwise
 *    hold the cron invocation open and a webhook that answers with a video would fill a row.
 *
 * Nothing here throws. A channel that cannot send is a result, not an exception: one broken webhook
 * must not stop the other eight from delivering, and the reason has to reach the log line.
 */
import { isBlockedTarget } from '@shared/ai-proxy-guard'
import { NO_REDIRECT, isRedirectResponse } from './no-redirect'

export const OUTBOUND_TIMEOUT_MS = 10_000
export const OUTBOUND_MAX_BYTES = 64 * 1024

export interface OutboundOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
}

export interface OutboundResponse {
  ok: boolean
  status: number
  text: string
  error: string
}

/** A URL a channel may send to, or the reason it may not. */
export function checkTarget(raw: string): { url: URL | null; error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { url: null, error: 'The address is not a valid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { url: null, error: 'Only http and https addresses can be reached' }
  }
  if (url.username || url.password) {
    return { url: null, error: 'The address may not carry credentials' }
  }
  if (isBlockedTarget(url.hostname)) {
    return { url: null, error: 'That address is not reachable from this deployment' }
  }
  return { url, error: '' }
}

export async function outbound(raw: string, options: OutboundOptions = {}): Promise<OutboundResponse> {
  const target = checkTarget(raw)
  if (!target.url) return { ok: false, status: 0, text: '', error: target.error }

  const maxBytes = options.maxBytes ?? OUTBOUND_MAX_BYTES
  try {
    const response = await fetch(target.url.toString(), {
      method: options.method ?? 'POST',
      headers: options.headers,
      body: options.body,
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(options.timeoutMs ?? OUTBOUND_TIMEOUT_MS),
    })
    if (isRedirectResponse(response)) {
      return { ok: false, status: response.status, text: '', error: 'The address redirected, and redirects are not followed' }
    }
    const text = await readCapped(response, maxBytes)
    return {
      ok: response.ok,
      status: response.status,
      text,
      error: response.ok ? '' : `HTTP ${response.status}`,
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, status: 0, text: '', error: 'The request timed out' }
    }
    return { ok: false, status: 0, text: '', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read at most `maxBytes` of a body.
 *
 * The cap is applied while reading rather than after, so a response that never ends cannot become a
 * string in the first place.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const slice = value.byteLength > maxBytes - size ? value.slice(0, maxBytes - size) : value
      chunks.push(slice)
      size += slice.byteLength
    }
  } catch (error) {
    // Keep the bytes read so far; log only the error because the target may hold credentials.
    console.warn('[inkstone] Outbound response body ended early:', error)
  } finally {
    // Cancel is best-effort; the bytes already read are the result either way.
    void reader.cancel().catch((error) => {
      console.warn('[inkstone] Outbound response cancel failed:', error)
    })
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}
