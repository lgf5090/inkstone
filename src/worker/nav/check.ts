import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { NavCheckSchema } from '@shared/nav/validation'
import { isHttpUrl, type NavCheckError, type NavCheckLevel, type NavCheckResult } from '@shared/nav/model'
import { guardedFetch } from './safe-fetch'

export const navCheckRoutes = new Hono<AppBindings>()
navCheckRoutes.use('*', requireAuth)

navCheckRoutes.post('/', async (c) => {
  const raw = await c.req.json().catch(() => null)
  const parsed = NavCheckSchema.safeParse(raw)
  if (!parsed.success) throw ApiError.badRequest('urls must be an array of at most 10 addresses')
  const results = await Promise.allSettled(parsed.data.urls.map((url) => checkOne(url)))
  return c.json({
    results: results.map((result, index) => result.status === 'fulfilled'
      ? result.value
      : {
        url: parsed.data.urls[index]!,
        status: null,
        ok: false,
        level: 'broken' as const,
        durationMs: 0,
        errorCode: 'network' as const,
      }),
  })
})

function levelFor(status: number): NavCheckLevel {
  if (status >= 200 && status < 400) return 'ok'
  if (status >= 400 && status < 500) return 'warning'
  return 'broken'
}

function failure(url: string, started: number, errorCode: NavCheckError, finalUrl?: string): NavCheckResult {
  const level: NavCheckLevel = errorCode === 'invalid_url' || errorCode === 'blocked_target' ? 'skipped' : 'broken'
  return { url, status: null, ok: false, level, durationMs: Date.now() - started, errorCode, finalUrl }
}

async function checkOne(url: string): Promise<NavCheckResult> {
  const started = Date.now()
  if (!isHttpUrl(url)) return { url, status: null, ok: false, level: 'skipped', durationMs: 0, errorCode: 'invalid_url' }
  let result = await guardedFetch(url, { method: 'HEAD', timeoutMs: 8000, maxRedirects: 5 })
  if (!result.error && (result.response.status === 405 || result.response.status === 403)) {
    await result.response.body?.cancel().catch(() => {})
    result = await guardedFetch(url, { method: 'GET', timeoutMs: 8000, maxRedirects: 5 })
  } else if (result.error && result.error !== 'blocked_target' && result.error !== 'invalid_url') {
    result = await guardedFetch(url, { method: 'GET', timeoutMs: 8000, maxRedirects: 5 })
  }
  if (result.error) return failure(url, started, result.error, result.finalUrl)
  await result.response.body?.cancel().catch(() => {})
  const level = levelFor(result.response.status)
  return {
    url,
    status: result.response.status,
    ok: level === 'ok',
    level,
    durationMs: Date.now() - started,
    ...(level === 'broken' ? { errorCode: 'http_error' as const } : {}),
    ...(result.finalUrl !== url ? { finalUrl: result.finalUrl } : {}),
  }
}
