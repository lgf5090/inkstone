import { testDurableObjectNamespace } from './bindings'

interface Bucket {
  count: number
  resetAt: number
}

export function testGithubLimiter(): DurableObjectNamespace {
  const buckets = new Map<string, Bucket>()
  return testDurableObjectNamespace(async (request) => {
    const body = await request.json() as { key: string; limit: number; windowMs: number }
    const now = Date.now()
    const existing = buckets.get(body.key)
    const bucket = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + body.windowMs }
    bucket.count += 1
    buckets.set(body.key, bucket)
    if (bucket.count <= body.limit) return new Response(null, { status: 204 })
    return Response.json(
      { retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) },
      { status: 429 },
    )
  })
}
