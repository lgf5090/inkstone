import { Hono, type Context } from 'hono'
import {
  XGET_KNOWN_METHODS,
  XGET_PROXY_PREFIX,
  XGET_STATS_MAX_DAYS,
  XGET_TOKEN_MAX_LENGTH,
  XGET_TOKEN_MIN_LENGTH,
  XGET_TOKEN_PATTERN,
} from '@shared/development/xget/constants'
import { XGET_PLATFORMS, XGET_PLATFORMS_BY_LONGEST_PREFIX, xgetPathPrefix } from '@shared/development/xget/catalog'
import {
  XgetSettingsPatchSchema,
  XgetTestPathSchema,
  XgetTokenSchema,
} from '@shared/development/xget/schemas'
import type {
  XgetConfigOverrides,
  XgetSettingsConfig,
  XgetStatsSummary,
} from '@shared/development/xget/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { hashToken } from '../lib/session-store'
import { requireAuth } from '../middleware/auth'
import { handleXgetRequest, resolveProxyTarget } from '../development/xget/lib/app/handle-request'
import { createConfig, type XgetConfig } from '../development/xget/lib/config'
import {
  readXgetOverrides,
  readXgetSettingsRow,
  writeXgetOverrides,
  writeXgetTokenHash,
} from '../development/xget/settings'
import { readStatsSummary, recordProxyStat } from '../development/xget/stats'
import { isXgetProxyPath } from '../development/xget/paths'

function requireOwner(c: Context<AppBindings>): void {
  if (c.get('user')?.role !== 'owner') {
    throw ApiError.forbidden('Only the instance owner can change the Xget settings')
  }
}

function configFromOverrides(overrides: XgetConfigOverrides): XgetConfig {
  return createConfig(overrides)
}

function overridesFromConfig(config: XgetConfig): XgetConfigOverrides {
  return {
    TIMEOUT_SECONDS: config.TIMEOUT_SECONDS,
    MAX_RETRIES: config.MAX_RETRIES,
    RETRY_DELAY_MS: config.RETRY_DELAY_MS,
    CACHE_DURATION: config.CACHE_DURATION,
    ALLOW_ANONYMOUS: config.ALLOW_ANONYMOUS,
    SECURITY: {
      ALLOWED_METHODS: config.SECURITY.ALLOWED_METHODS,
      ALLOWED_ORIGINS: config.SECURITY.ALLOWED_ORIGINS,
      MAX_PATH_LENGTH: config.SECURITY.MAX_PATH_LENGTH,
    },
  }
}

function configView(config: XgetConfig): XgetSettingsConfig {
  return {
    timeout_seconds: config.TIMEOUT_SECONDS,
    max_retries: config.MAX_RETRIES,
    retry_delay_ms: config.RETRY_DELAY_MS,
    cache_duration: config.CACHE_DURATION,
    allow_anonymous: config.ALLOW_ANONYMOUS,
    allowed_methods: config.SECURITY.ALLOWED_METHODS,
    allowed_origins: config.SECURITY.ALLOWED_ORIGINS,
    max_path_length: config.SECURITY.MAX_PATH_LENGTH,
  }
}

function normalizeMethods(value: string[]): string[] {
  const known = new Set<string>(XGET_KNOWN_METHODS)
  const methods = [...new Set(value.map((entry) => entry.trim().toUpperCase()).filter(Boolean))]
  if (!methods.length) throw ApiError.badRequest('At least one method is required')
  const unsupported = methods.find((method) => !known.has(method))
  if (unsupported) throw ApiError.badRequest(`Unsupported method: ${unsupported}`)
  return methods
}

function normalizeOrigins(value: string[]): string[] {
  const entries = value.map((entry) => entry.trim()).filter(Boolean)
  if (entries.includes('*')) return ['*']

  const origins: string[] = []
  for (const entry of entries) {
    let parsed: URL
    try {
      parsed = new URL(entry)
    } catch {
      throw ApiError.badRequest(`Invalid CORS origin: ${entry}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw ApiError.badRequest(`Invalid CORS origin: ${entry}`)
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw ApiError.badRequest(`Invalid CORS origin: ${entry}`)
    }
    const origin = parsed.origin
    if (!origins.includes(origin)) origins.push(origin)
  }
  return origins
}

function patchToOverrides(
  body: {
    timeout_seconds?: number
    max_retries?: number
    retry_delay_ms?: number
    cache_duration?: number
    allow_anonymous?: boolean
    allowed_methods?: string[]
    allowed_origins?: string[]
    max_path_length?: number
  },
  existing: XgetConfigOverrides,
): XgetConfigOverrides {
  const next: XgetConfigOverrides = {
    ...existing,
    SECURITY: { ...existing.SECURITY },
  }
  if (body.timeout_seconds !== undefined) next.TIMEOUT_SECONDS = body.timeout_seconds
  if (body.max_retries !== undefined) next.MAX_RETRIES = body.max_retries
  if (body.retry_delay_ms !== undefined) next.RETRY_DELAY_MS = body.retry_delay_ms
  if (body.cache_duration !== undefined) next.CACHE_DURATION = body.cache_duration
  if (body.allow_anonymous !== undefined) next.ALLOW_ANONYMOUS = body.allow_anonymous
  if (body.max_path_length !== undefined) next.SECURITY!.MAX_PATH_LENGTH = body.max_path_length
  if (body.allowed_methods !== undefined) {
    next.SECURITY!.ALLOWED_METHODS = normalizeMethods(body.allowed_methods)
  }
  if (body.allowed_origins !== undefined) {
    next.SECURITY!.ALLOWED_ORIGINS = normalizeOrigins(body.allowed_origins)
  }
  return next
}

function sameHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

interface ProxyToken {
  value: string
  source: 'header' | 'query'
}

function proxyTokenFrom(c: { req: { header(name: string): string | undefined; query(name: string): string | undefined } }): ProxyToken | null {
  const header = c.req.header('x-xget-token') ?? ''
  if (header) return { value: header, source: 'header' }
  const query = c.req.query('access_token') ?? ''
  return query ? { value: query, source: 'query' } : null
}

function withoutAccessToken(search: string): string {
  const params = new URLSearchParams(search)
  if (!params.has('access_token')) return search
  params.delete('access_token')
  const next = params.toString()
  return next ? `?${next}` : ''
}

function isCorsPreflight(c: Context<AppBindings>): boolean {
  return (
    c.req.method.toUpperCase() === 'OPTIONS' &&
    c.req.header('origin') !== undefined &&
    c.req.header('access-control-request-method') !== undefined
  )
}

function executionWaitUntil(
  c: Context<AppBindings>,
): ((task: Promise<unknown>) => void) | undefined {
  try {
    const executionCtx = c.executionCtx
    return (task) => executionCtx.waitUntil(task)
  } catch {
    return undefined
  }
}

function platformFromPath(pathname: string): string | null {
  for (const platform of XGET_PLATFORMS_BY_LONGEST_PREFIX) {
    if (pathname.startsWith(`/${xgetPathPrefix(platform.key)}/`)) return platform.key
  }
  return null
}

async function parseBody<T>(c: Context<AppBindings>, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number | symbol)[]; message: string }[] } } }, limit: number): Promise<T> {
  const raw = await readJson<unknown>(c, limit)
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') || 'body'
    throw ApiError.badRequest(`${path}: ${issue?.message ?? 'Invalid value'}`)
  }
  return result.data
}

export const developmentXgetRoutes = new Hono<AppBindings>()

const settingsRoutes = new Hono<AppBindings>()
settingsRoutes.use('*', requireAuth)

settingsRoutes.get('/', async (c) => {
  const { overrides, tokenHash } = await readXgetSettingsRow(c.env.DB)
  const config = configFromOverrides(overrides)
  return c.json({
    ok: true,
    data: {
      proxy_base_url: `${new URL(c.req.url).origin}${XGET_PROXY_PREFIX}`,
      platform_count: XGET_PLATFORMS.length,
      has_proxy_token: tokenHash !== '',
      can_manage: c.get('user')?.role === 'owner',
      config: configView(config),
    },
  })
})

settingsRoutes.put('/', async (c) => {
  requireOwner(c)
  const body = await parseBody(c, XgetSettingsPatchSchema, JSON_BODY_LIMITS.settings)
  const existing = await readXgetOverrides(c.env.DB)
  const next = patchToOverrides(body, existing)
  const config = configFromOverrides(next)
  await writeXgetOverrides(c.env.DB, overridesFromConfig(config), Date.now())
  return c.json({ ok: true, data: { config: configView(config) } })
})

settingsRoutes.put('/token', async (c) => {
  requireOwner(c)
  const body = await parseBody(c, XgetTokenSchema, JSON_BODY_LIMITS.settings)
  const token = body.token.trim()
  if (token && (token.length < XGET_TOKEN_MIN_LENGTH || token.length > XGET_TOKEN_MAX_LENGTH)) {
    throw ApiError.badRequest(`The token must be ${XGET_TOKEN_MIN_LENGTH}-${XGET_TOKEN_MAX_LENGTH} characters`)
  }
  if (token && !XGET_TOKEN_PATTERN.test(token)) {
    throw ApiError.badRequest('The token may only contain letters, digits, dot, underscore and hyphen')
  }
  const tokenHash = token ? await hashToken(token) : ''
  await writeXgetTokenHash(c.env.DB, tokenHash, Date.now())
  return c.json({ ok: true, data: { has_proxy_token: Boolean(token) } })
})

settingsRoutes.post('/test', async (c) => {
  const body = await parseBody(c, XgetTestPathSchema, JSON_BODY_LIMITS.settings)
  const pathname = body.path.trim()
  if (!pathname.startsWith('/')) {
    throw ApiError.badRequest('path must start with /, for example /gh/microsoft/vscode')
  }
  const result = resolveProxyTarget(pathname, await readXgetOverrides(c.env.DB))
  if (!result.ok) throw ApiError.badRequest(result.error)
  return c.json({ ok: true, data: { platform: result.platform, target_url: result.targetUrl } })
})

const statsRoutes = new Hono<AppBindings>()
statsRoutes.use('*', requireAuth)

statsRoutes.get('/summary', async (c) => {
  const raw = c.req.query('days')
  let days: number | null = null
  if (raw !== undefined && raw !== '' && raw !== 'all') {
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > XGET_STATS_MAX_DAYS) {
      throw ApiError.badRequest(`days must be an integer between 1 and ${XGET_STATS_MAX_DAYS}, or all`)
    }
    days = parsed
  }
  const summary: XgetStatsSummary = await readStatsSummary(c.env.DB, days)
  return c.json({ ok: true, data: summary })
})

developmentXgetRoutes.route('/settings', settingsRoutes)
developmentXgetRoutes.route('/stats', statsRoutes)

developmentXgetRoutes.use('*', async (c, next) => {
  if (!isXgetProxyPath(c.req.path)) return next()

  const settings = await readXgetSettingsRow(c.env.DB)
  const storedHash = settings.tokenHash
  const allowAnonymous = createConfig(settings.overrides).ALLOW_ANONYMOUS
  let provided: ProxyToken | null = null
  if ((storedHash !== '' || !allowAnonymous) && !c.get('userId') && !isCorsPreflight(c)) {
    provided = proxyTokenFrom(c)
    const providedHash = provided ? await hashToken(provided.value) : ''
    if (!storedHash || !providedHash || !sameHash(providedHash, storedHash)) {
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: storedHash ? 'invalid proxy token' : 'anonymous access is disabled',
          },
        },
        401,
      )
    }
  }

  const url = new URL(c.req.url)
  const pathname = url.pathname.slice(XGET_PROXY_PREFIX.length) || '/'
  const search = provided?.source === 'query' ? withoutAccessToken(url.search) : url.search
  const engineUrl = new URL(`${pathname}${search}`, url.origin)
  const overrides = settings.overrides
  const request = new Request(engineUrl.toString(), c.req.raw)
  const waitUntil = executionWaitUntil(c)
  const response = await handleXgetRequest(
    request,
    overrides,
    `${url.origin}${XGET_PROXY_PREFIX}`,
    waitUntil,
  )
  const statWrite = recordProxyStat(c.env.DB, platformFromPath(pathname), response.status)
  if (waitUntil) {
    waitUntil(statWrite)
  } else {
    await statWrite
  }
  return response
})
