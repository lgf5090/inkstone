import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { sha256Hex } from '../lib/encoding'
import { createMinuteBudget } from '../lib/rate-limit'
import { CERTHUB_LIMITS } from '@shared/development/certhub/limits'
import { actionSchema, createOrderSchema } from '@shared/development/certhub/validation'
import { createOrderForUser } from '../development/certhub/orders'
import { handleOrderAction } from '../development/certhub/state-machine'
import { kickOrder } from '../development/certhub/worker'
import { decryptCerthubOrderKey } from '../lib/crypto'
import { exportPassword } from '../development/certhub/export-password'
import { pemToPfx } from '../development/certhub/crypto/pfx'
import { buildCerthubZip } from '../development/certhub/export/zip'
import {
  appendEvent,
  decodeCursor,
  findOrder,
  findTokenByHash,
  incrementUsage,
  listDomains,
  listOrders,
  orderWithDomains,
  readUsage,
  touchToken,
  usageDay,
} from '../development/certhub/store'
import { parseOrderSort } from '@shared/development/certhub/sorting'
import { readCerthubText } from '../development/certhub/storage'

export const developmentCerthubOpenRoutes = new Hono<AppBindings>()

const budget = createMinuteBudget(CERTHUB_LIMITS.apiRequestsPerMinute, 'The API request budget is exhausted')
const issueBudget = createMinuteBudget(CERTHUB_LIMITS.apiIssuesPerMinute, 'The API issuance budget is exhausted')

interface ApiAuth {
  userId: string
  tokenId: string
  scopes: Set<string>
  lastUsedAt: number | null
}

async function authenticate(c: Context<AppBindings>): Promise<ApiAuth> {
  const header = c.req.header('Authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const token = bearer || (c.req.header('X-Certhub-Token') ?? '').trim()
  if (!token.startsWith('crt_')) throw ApiError.unauthenticated('A certificate API token is required')
  const row = await findTokenByHash(c.env.DB, await sha256Hex(token))
  if (!row || row.revoked_at !== null) throw ApiError.unauthenticated('The certificate API token is not valid')
  if (row.expires_at !== null && row.expires_at <= Date.now()) throw ApiError.unauthenticated('The certificate API token has expired')
  budget(row.user_id)
  const today = usageDay()
  const used = await readUsage(c.env.DB, row.user_id, 'api_calls', today)
  if (used >= CERTHUB_LIMITS.apiRequestsPerDay) throw new ApiError(429, 'too_many_attempts', 'The daily API request budget is exhausted')
  await incrementUsage(c.env.DB, row.user_id, 'api_calls', today)
  await touchToken(c.env.DB, row.user_id, row.id, row.last_used_at)
  return { userId: row.user_id, tokenId: row.id, scopes: new Set(row.scopes.split(',')), lastUsedAt: row.last_used_at }
}

function requireScope(auth: ApiAuth, scope: string): void {
  if (!auth.scopes.has(scope)) throw ApiError.forbidden(`The API token is missing the ${scope} scope`)
}

async function parseBody<T>(c: Context<AppBindings>, schema: z.ZodType<T>): Promise<T> {
  const raw = await readJson<unknown>(c, JSON_BODY_LIMITS.small)
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'invalid request body')
  return parsed.data
}

developmentCerthubOpenRoutes.post('/v1/orders', async (c) => {
  const auth = await authenticate(c)
  requireScope(auth, 'issue')
  const body = await parseBody(c, createOrderSchema)
  const today = usageDay()
  const issued = await readUsage(c.env.DB, auth.userId, 'orders_created', today)
  if (issued >= CERTHUB_LIMITS.apiIssuesPerDay) throw new ApiError(429, 'too_many_attempts', 'The daily API issuance budget is exhausted')
  issueBudget(auth.userId)
  const result = await createOrderForUser(
    c.env,
    c.env.DB,
    auth.userId,
    '',
    body,
    'api',
    (c.req.header('Idempotency-Key') ?? '').trim().slice(0, 128),
    'production',
  )
  if (!result.reused) c.executionCtx.waitUntil(kickOrder(c.env, c.env.DB, auth.userId, result.order.id))
  return c.json({ ok: true, data: { order: result.order, reused: result.reused } }, result.reused ? 200 : 202)
})

developmentCerthubOpenRoutes.get('/v1/orders', async (c) => {
  const auth = await authenticate(c)
  requireScope(auth, 'read')
  const limit = Math.min(CERTHUB_LIMITS.listPageMax, Math.max(1, Number(c.req.query('limit') ?? CERTHUB_LIMITS.listPageDefault)))
  const sort = parseOrderSort(c.req.query('sort'))
  if (!sort) throw ApiError.badRequest('Unknown sort')
  const cursor = c.req.query('cursor')
  const decoded = cursor ? decodeCursor(cursor) : null
  const result = await listOrders(c.env.DB, auth.userId, { q: c.req.query('q'), sort, cursor: decoded, limit })
  return c.json({ ok: true, data: result })
})

developmentCerthubOpenRoutes.get('/v1/orders/:id', async (c) => {
  const auth = await authenticate(c)
  requireScope(auth, 'read')
  const order = await findOrder(c.env.DB, auth.userId, c.req.param('id'))
  if (!order) throw ApiError.notFound('The certificate order was not found')
  const domains = await listDomains(c.env.DB, auth.userId, order.id)
  return c.json({ ok: true, data: { order: orderWithDomains(order, domains) } })
})

developmentCerthubOpenRoutes.get('/v1/orders/:id/download', async (c) => {
  const auth = await authenticate(c)
  const order = await findOrder(c.env.DB, auth.userId, c.req.param('id'))
  if (!order) throw ApiError.notFound('The certificate order was not found')
  const kind = c.req.query('kind') ?? 'fullchain'
  if (!(DOWNLOAD_KINDS as readonly string[]).includes(kind)) throw ApiError.badRequest('Unknown download kind')
  if (kind === 'key') requireScope(auth, 'read-key')
  else requireScope(auth, 'read')
  if (!order.cert_object_key && kind !== 'csr' && kind !== 'key') throw ApiError.notFound('The certificate is not ready')
  if (kind === 'key') {
    if (!order.key_object_key || order.key_purged_at !== null) throw ApiError.notFound('The private key is not available')
    const ciphertext = await readCerthubText(c.env, order.key_object_key)
    const privateKey = ciphertext ? await decryptCerthubOrderKey(c.env, order.id, ciphertext) : null
    if (!privateKey) throw new ApiError(503, 'vault_unavailable', 'The private key could not be decrypted')
    await appendEvent(c.env.DB, {
      userId: auth.userId, orderId: order.id, actor: 'api', kind: 'key.downloaded', level: 'warn', messageCode: 'key.downloaded',
    })
    return new Response(privateKey, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${order.id}-key.pem"`,
        'Cache-Control': 'no-store',
      },
    })
  }
  let content: string
  if (kind === 'csr') {
    content = await readCerthubText(c.env, order.csr_object_key) ?? ''
  } else {
    const fullchain = await readCerthubText(c.env, order.cert_object_key) ?? ''
    const blocks = certificateBlocks(fullchain)
    content = kind === 'chain'
      ? blocks.slice(1).map((block) => `${block}\n`).join('')
      : kind === 'cert'
        ? (blocks[0] ? `${blocks[0]}\n` : '')
        : fullchain
  }
  if (!content) throw ApiError.notFound('The requested certificate file is missing')
  return new Response(content, {
    headers: {
      'Content-Type': 'application/x-pem-file',
      'Content-Disposition': `attachment; filename="${order.id}-${kind}.pem"`,
      'Cache-Control': 'no-store',
    },
  })
})

const DOWNLOAD_KINDS = ['fullchain', 'cert', 'chain', 'key', 'csr'] as const

function certificateBlocks(fullchain: string): string[] {
  return fullchain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
}

developmentCerthubOpenRoutes.get('/v1/orders/:id/export', async (c) => {
  const auth = await authenticate(c)
  requireScope(auth, 'read-key')
  const order = await findOrder(c.env.DB, auth.userId, c.req.param('id'))
  if (!order) throw ApiError.notFound('The certificate order was not found')
  const kind = c.req.query('kind')
  if (kind !== 'zip' && kind !== 'pfx') throw ApiError.badRequest('Unknown export kind')
  const fullchain = await readCerthubText(c.env, order.cert_object_key)
  const ciphertext = await readCerthubText(c.env, order.key_object_key)
  const privateKey = ciphertext ? await decryptCerthubOrderKey(c.env, order.id, ciphertext) : null
  if (!fullchain || !privateKey) throw ApiError.notFound('The certificate material is incomplete')
  await appendEvent(c.env.DB, {
    userId: auth.userId, orderId: order.id, actor: 'api', kind: 'key.downloaded', level: 'warn', messageCode: 'key.downloaded',
    detail: { kind },
  })
  if (kind === 'pfx') {
    const password = exportPassword()
    return new Response(pemToPfx(privateKey, fullchain, password, order.id), {
      headers: {
        'Content-Type': 'application/x-pkcs12',
        'Content-Disposition': `attachment; filename="${order.id}.pfx"`,
        'Cache-Control': 'no-store',
        'X-Certhub-Pfx-Password': password,
        'X-PFX-Password': password,
        'Access-Control-Expose-Headers': 'Content-Disposition, X-Certhub-Pfx-Password, X-PFX-Password',
      },
    })
  }
  const blocks = fullchain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  const zip = buildCerthubZip([
    { path: 'fullchain.pem', content: fullchain },
    { path: 'cert.pem', content: blocks[0] ? `${blocks[0]}\n` : '' },
    { path: 'chain.pem', content: blocks.slice(1).map((block) => `${block}\n`).join('') },
    { path: 'privkey.pem', content: privateKey },
  ])
  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${order.id}.zip"`,
      'Cache-Control': 'no-store',
      'Access-Control-Expose-Headers': 'Content-Disposition',
    },
  })
})

developmentCerthubOpenRoutes.post('/v1/orders/:id/actions', async (c) => {
  const auth = await authenticate(c)
  const body = await parseBody(c, actionSchema)
  if (body.action === 'revoke') requireScope(auth, 'revoke')
  else requireScope(auth, 'issue')
  if (body.action === 'delete' || body.action === 'purge_key') throw ApiError.forbidden('This action is not available over the API')
  const result = await handleOrderAction(c.env, c.env.DB, auth.userId, c.req.param('id'), body.action, 'api', {
    domainId: body.domainId,
    revokeReason: body.revokeReason,
  })
  const domains = await listDomains(c.env.DB, auth.userId, c.req.param('id'))
  return c.json({ ok: true, data: { order: orderWithDomains(result.order, domains) } })
})

developmentCerthubOpenRoutes.post('/v1/orders/:id/revoke', async (c) => {
  const auth = await authenticate(c)
  requireScope(auth, 'revoke')
  const body = await readJson<{ reason?: unknown }>(c, JSON_BODY_LIMITS.small).catch(() => ({ reason: undefined }))
  const reason = typeof body.reason === 'number' ? body.reason : 0
  const result = await handleOrderAction(c.env, c.env.DB, auth.userId, c.req.param('id'), 'revoke', 'api', { revokeReason: reason })
  const domains = await listDomains(c.env.DB, auth.userId, c.req.param('id'))
  return c.json({ ok: true, data: { order: orderWithDomains(result.order, domains) } })
})
