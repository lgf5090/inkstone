import { isBlockedTarget } from '@shared/ai-proxy-guard'
import type { NavCheckError } from '@shared/nav/model'

export interface GuardedFetchOptions {
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  timeoutMs?: number
  maxRedirects?: number
}

export interface GuardedFetchResult {
  response: Response
  finalUrl: string
  error: NavCheckError | null
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export async function guardedFetch(raw: string, options: GuardedFetchOptions = {}): Promise<GuardedFetchResult> {
  const timeoutMs = options.timeoutMs ?? 8000
  const maxRedirects = options.maxRedirects ?? 5
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let current: URL
  try {
    current = new URL(raw)
  } catch {
    clearTimeout(timer)
    return { response: new Response(null, { status: 400 }), finalUrl: raw, error: 'invalid_url' }
  }
  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return { response: new Response(null, { status: 400 }), finalUrl: current.toString(), error: 'invalid_url' }
      }
      if (current.username || current.password) {
        return { response: new Response(null, { status: 400 }), finalUrl: current.toString(), error: 'invalid_url' }
      }
      if (isBlockedTarget(current.hostname)) {
        return { response: new Response(null, { status: 403 }), finalUrl: current.toString(), error: 'blocked_target' }
      }
      let response: Response
      try {
        response = await fetch(current.toString(), {
          method: options.method ?? 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; InkstoneNavLinkChecker/1.0)',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*;q=0.8,*/*;q=0.5',
            ...options.headers,
          },
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') {
          return { response: new Response(null, { status: 504 }), finalUrl: current.toString(), error: 'timeout' }
        }
        return { response: new Response(null, { status: 502 }), finalUrl: current.toString(), error: 'network' }
      }
      if (!REDIRECTS.has(response.status)) return { response, finalUrl: current.toString(), error: null }
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => null)
      if (!location) return { response: new Response(null, { status: 502 }), finalUrl: current.toString(), error: 'network' }
      if (hop === maxRedirects) return { response: new Response(null, { status: 502 }), finalUrl: current.toString(), error: 'too_many_redirects' }
      try {
        current = new URL(location, current)
      } catch {
        return { response: new Response(null, { status: 400 }), finalUrl: current.toString(), error: 'invalid_url' }
      }
    }
    return { response: new Response(null, { status: 502 }), finalUrl: current.toString(), error: 'too_many_redirects' }
  } finally {
    clearTimeout(timer)
  }
}

export async function readGuardedBytes(response: Response, maxBytes: number, timeoutMs = 8000): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), timeout])
      if (result === 'timeout') {
        await reader.cancel().catch(() => null)
        return null
      }
      if (result.done) break
      const value = result.value
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => null)
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
