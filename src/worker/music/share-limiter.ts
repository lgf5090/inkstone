/**
 * The cross-isolate brake for public playlist links.
 *
 * A public link has no session to meter, and an isolate-local bucket disappears the moment Cloudflare
 * runs the next request somewhere else. This object is the one shared counter: every public page,
 * API read and cover request for one caller and slug lands here, so a hot link cannot multiply its
 * budget by arriving on a new isolate. The isolate budget in `music-share.ts` remains the fallback
 * for a deployment that has not bound this object yet.
 */
import type { Env } from '../env'
import { evaluateInternalGuard } from '../lib/internal-auth'

const BUCKETS_KEY = 'buckets'
const MAX_BUCKETS = 4_096
const MAX_KEY_LENGTH = 256
const MAX_WINDOW_MS = 5 * 60_000
const MAX_LIMIT = 10_000

interface Bucket {
  count: number
  resetAt: number
}

export interface MusicShareLimitRequest {
  key?: unknown
  limit?: unknown
  windowMs?: unknown
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
}

/**
 * Ask the shared counter. `null` means this deployment has no binding or the object could not answer;
 * the caller then keeps the isolate budget instead of failing the link outright.
 */
export async function meterPublicShareAcrossIsolates(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfter: number } | null> {
  const namespace = env.MUSIC_SHARE_LIMITER
  if (!namespace) return null
  try {
    const stub = namespace.get(namespace.idFromName('public-share'))
    const response = await stub.fetch('https://music-share-limit.internal/meter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.DO_AUTH_KEY ? { 'X-Inkstone-Internal': env.DO_AUTH_KEY } : {}),
      },
      body: JSON.stringify({ key, limit, windowMs }),
      signal: AbortSignal.timeout(2_000),
    })
    if (response.status === 204) return { allowed: true, retryAfter: 0 }
    if (response.status === 429) {
      const body = await response.json().catch(() => null) as { retryAfter?: unknown } | null
      const retryAfter = Number(body?.retryAfter)
      return { allowed: false, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1 }
    }
    console.warn('[inkstone] Music share limiter answered', response.status, '; using the isolate budget')
    return null
  } catch (error) {
    console.warn('[inkstone] Music share limiter could not be reached; using the isolate budget:', error)
    return null
  }
}

export class MusicShareLimiter implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const guard = evaluateInternalGuard(this.env, request)
    if (guard === 'denied') return new Response('Unauthorized', { status: 401 })
    if (guard === 'misconfigured') return new Response('DO_AUTH_KEY is set but empty', { status: 500 })
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/meter') {
      return new Response('Unknown path', { status: 404 })
    }

    let body: MusicShareLimitRequest
    try {
      body = await request.json() as MusicShareLimitRequest
    } catch {
      return new Response('Invalid meter body', { status: 400 })
    }
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!key || key.length > MAX_KEY_LENGTH) return new Response('Invalid meter key', { status: 400 })
    const limit = boundedInteger(body.limit, 120, 1, MAX_LIMIT)
    const windowMs = boundedInteger(body.windowMs, 60_000, 1_000, MAX_WINDOW_MS)

    let result: { allowed: boolean; retryAfter: number } = { allowed: false, retryAfter: 1 }
    // Input gates do not make a get/put pair atomic, so a burst from two callers could otherwise
    // read the same count and write 2 twice. The counter update is tiny; blocking here is the cost.
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now()
      const stored = await this.state.storage.get<Record<string, Bucket>>(BUCKETS_KEY) ?? {}
      const next: Record<string, Bucket> = {}
      for (const [entryKey, bucket] of Object.entries(stored)) {
        if (bucket.resetAt > now) next[entryKey] = bucket
      }
      const keys = Object.keys(next)
      if (keys.length > MAX_BUCKETS) {
        for (const stale of keys.slice(0, keys.length - MAX_BUCKETS)) delete next[stale]
      }
      const bucket = next[key]
      const current = bucket && bucket.resetAt > now
        ? bucket
        : { count: 0, resetAt: now + windowMs }
      current.count += 1
      next[key] = current
      await this.state.storage.put(BUCKETS_KEY, next)
      result = {
        allowed: current.count <= limit,
        retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
      }
    })

    if (result.allowed) return new Response(null, { status: 204 })
    return Response.json(result, {
      status: 429,
      headers: { 'Retry-After': String(result.retryAfter) },
    })
  }
}
