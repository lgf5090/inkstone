import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { newId } from '../lib/id'
import { sha256Hex } from '../lib/encoding'
import { requireCurrentPassword } from '../lib/reauth'
import { decryptCerthubDnsCredential, decryptCerthubOrderKey, encryptCerthubDnsCredential } from '../lib/crypto'
import { CERTHUB_LIMITS } from '@shared/development/certhub/limits'
import {
  accountSchema,
  actionSchema,
  configPatchSchema,
  createOrderSchema,
  dnsProviderSchema,
  settingsSchema,
  tokenCreateSchema,
} from '@shared/development/certhub/validation'
import type { CerthubAction, CerthubActor, CerthubConfigView } from '@shared/development/certhub/types'
import { ensureAccount, importAccountKey, rotateAccountKey } from '../development/certhub/accounts'
import { quotaContext, verifyTurnstile } from '../development/certhub/quota'
import { createOrderForUser } from '../development/certhub/orders'
import { handleOrderAction } from '../development/certhub/state-machine'
import { kickOrder } from '../development/certhub/worker'
import {
  appendEvent,
  cancelJobsForOrder,
  decodeCursor,
  decodeEventCursor,
  deleteOrderRows,
  deleteProvider,
  findOrder,
  findProvider,
  insertProvider,
  insertToken,
  listAccountsForUser,
  listDomains,
  listEvents,
  listOrders,
  listProviders,
  listRecentEvents,
  listTokens,
  orderWithDomains,
  providerReferenced,
  readConfig,
  readSettings,
  revokeToken,
  updateProvider,
  updateSettings,
  usageDay,
  usageMonth,
} from '../development/certhub/store'
import {
  deleteCerthubObjects,
  readCerthubText,
} from '../development/certhub/storage'
import { verifyCloudflareToken } from '../development/certhub/dns/cloudflare'
import { pemToPfx } from '../development/certhub/crypto/pfx'
import { buildCerthubZip } from '../development/certhub/export/zip'

export const developmentCerthubRoutes = new Hono<AppBindings>()

developmentCerthubRoutes.use('*', requireAuth)

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

async function parseBody<T>(c: Context<AppBindings>, schema: z.ZodType<T>, limit = JSON_BODY_LIMITS.small): Promise<T> {
  const raw = await readJson<unknown>(c, limit)
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw ApiError.badRequest(`${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid value'}`)
  }
  return parsed.data
}

function actionActor(c: Context<AppBindings>): CerthubActor {
  return c.get('user')?.role === 'owner' ? 'owner' : 'user'
}

developmentCerthubRoutes.get('/health', async (c) => {
  const config = await readConfig(c.env.DB)
  return c.json({
    ok: true,
    data: {
      ready: Boolean(c.env.CREDENTIAL_VAULT && c.env.FILES),
      vault: Boolean(c.env.CREDENTIAL_VAULT),
      r2: Boolean(c.env.FILES),
      enabledCas: config.enabledCas,
      staging: c.env.CERTHUB_ALLOW_STAGING === '1',
      captcha: {
        enabled: Boolean(c.env.CERTHUB_TURNSTILE_SECRET),
        siteKey: c.env.CERTHUB_TURNSTILE_SITE_KEY ?? '',
      },
    },
  })
})

developmentCerthubRoutes.get('/overview', async (c) => {
  const userId = userIdOf(c)
  const [quota, recent, counts, expiringSoon, recentEvents] = await Promise.all([
    quotaContext(c.env.DB, userId),
    listOrders(c.env.DB, userId, { limit: 6 }),
    c.env.DB.prepare(`SELECT status, COUNT(*) AS c FROM development_certhub_orders
      WHERE user_id = ?1 AND deleted_at IS NULL GROUP BY status`).bind(userId).all<{ status: string; c: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS c FROM development_certhub_orders
      WHERE user_id = ?1 AND deleted_at IS NULL AND status IN ('issued','expired')
        AND cert_not_after IS NOT NULL AND cert_not_after <= ?2`)
      .bind(userId, Date.now() + 30 * 86_400_000).first<{ c: number }>(),
    listRecentEvents(c.env.DB, userId, 10),
  ])
  const statusCounts: Record<string, number> = {}
  for (const row of counts.results) statusCounts[row.status] = Number(row.c)
  return c.json({
    ok: true,
    data: {
      counts: { ...statusCounts, expiringSoon: Number(expiringSoon?.c ?? 0) },
      recentOrders: recent.items,
      recentEvents,
      quota: quota.quota,
    },
  })
})

developmentCerthubRoutes.get('/orders', async (c) => {
  const userId = userIdOf(c)
  const query = c.req.query()
  const cursor = query.cursor ? decodeCursorSafe(query.cursor) : null
  const limit = Math.min(CERTHUB_LIMITS.listPageMax, Math.max(1, Number(query.limit ?? CERTHUB_LIMITS.listPageDefault)))
  const status = query.status && /^[a-z_]+$/.test(query.status) ? query.status : undefined
  const ca = query.ca && /^[a-z-]+$/.test(query.ca) ? query.ca : undefined
  const expiring = query.expiring ? Number(query.expiring) : undefined
  const result = await listOrders(c.env.DB, userId, {
    status: status as never,
    ca: ca as never,
    q: query.q,
    expiringWithinDays: Number.isFinite(expiring) ? expiring : undefined,
    cursor,
    limit,
  })
  return c.json({ ok: true, data: result })
})

function decodeCursorSafe(raw: string): { updatedAt: number; id: string } | null {
  try {
    return decodeCursor(raw)
  } catch {
    throw ApiError.badRequest('The cursor is not valid')
  }
}

developmentCerthubRoutes.post('/orders', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, createOrderSchema)
  await verifyTurnstile(c.env, body.captchaToken, c.req.header('CF-Connecting-IP'))
  const environment = c.env.CERTHUB_ALLOW_STAGING === '1' && c.req.query('environment') === 'staging'
    ? 'staging'
    : 'production'
  const result = await createOrderForUser(
    c.env,
    c.env.DB,
    userId,
    c.get('user').login,
    body,
    actionActor(c),
    (c.req.header('Idempotency-Key') ?? '').trim().slice(0, 128),
    environment,
  )
  if (!result.reused) c.executionCtx.waitUntil(kickOrder(c.env, c.env.DB, userId, result.order.id))
  return c.json({ ok: true, data: { order: result.order, jobId: result.jobId, reused: result.reused } }, result.reused ? 200 : 202)
})

developmentCerthubRoutes.get('/orders/:id', async (c) => {
  const userId = userIdOf(c)
  const order = await findOrder(c.env.DB, userId, c.req.param('id'))
  if (!order) throw ApiError.notFound('The certificate order was not found')
  const domains = await listDomains(c.env.DB, userId, order.id)
  const events = await listEvents(c.env.DB, userId, order.id, null, 10)
  return c.json({ ok: true, data: { order: orderWithDomains(order, domains), events: events.items } })
})

developmentCerthubRoutes.get('/orders/:id/events', async (c) => {
  const userId = userIdOf(c)
  const order = await findOrder(c.env.DB, userId, c.req.param('id'))
  if (!order) throw ApiError.notFound('The certificate order was not found')
  const limit = Math.min(CERTHUB_LIMITS.eventsPageMax, Math.max(1, Number(c.req.query('limit') ?? CERTHUB_LIMITS.eventsPageDefault)))
  const level = c.req.query('level')
  const cursorRaw = c.req.query('cursor')
  const result = await listEvents(
    c.env.DB,
    userId,
    order.id,
    decodeEventCursor(cursorRaw),
    limit,
    level === 'info' || level === 'warn' || level === 'error' ? level : undefined,
  )
  return c.json({ ok: true, data: result })
})

developmentCerthubRoutes.post('/orders/:id/actions', async (c) => {
  const userId = userIdOf(c)
  const orderId = c.req.param('id')
  const body = await parseBody(c, actionSchema)
  const order = await findOrder(c.env.DB, userId, orderId)
  if (!order) throw ApiError.notFound('The certificate order was not found')
  if (body.action === 'delete') {
    if (!['failed', 'canceled', 'revoked', 'expired'].includes(order.status)) {
      throw new ApiError(409, 'order_state_conflict', 'Only a finished order can be deleted')
    }
    if (body.confirm !== orderId) throw ApiError.badRequest('Type the order id to confirm deletion')
    await cancelJobsForOrder(c.env.DB, userId, orderId)
    const { orderObjectKeys, keyReferencedElsewhere } = await import('../development/certhub/store')
    const keys = await orderObjectKeys(c.env.DB, userId, orderId)
    const orphans: string[] = []
    for (const key of keys) {
      if (!(await keyReferencedElsewhere(c.env.DB, userId, orderId, key))) orphans.push(key)
    }
    await deleteOrderRows(c.env.DB, userId, orderId)
    await deleteCerthubObjects(c.env, orphans)
    await appendEvent(c.env.DB, {
      userId, orderId, actor: actionActor(c), kind: 'order.deleted', level: 'warn', messageCode: 'order.deleted',
    })
    return c.json({ ok: true, data: { deleted: true } })
  }
  const result = await handleOrderAction(c.env, c.env.DB, userId, orderId, body.action as CerthubAction, actionActor(c), {
    domainId: body.domainId,
    revokeReason: body.revokeReason,
  })
  if (result.retryAfterMs > 0) {
    const { enqueueJob } = await import('../development/certhub/store')
    await enqueueJob(c.env.DB, { userId, orderId, kind: 'advance', runAfter: Date.now() + result.retryAfterMs })
  }
  const domains = await listDomains(c.env.DB, userId, orderId)
  return c.json({ ok: true, data: { order: orderWithDomains(result.order, domains) } })
})

developmentCerthubRoutes.get('/orders/:id/download', async (c) => {
  const userId = userIdOf(c)
  const order = await findOrder(c.env.DB, userId, c.req.param('id'))
  if (!order) throw ApiError.notFound('The certificate order was not found')
  const kind = c.req.query('kind') ?? 'fullchain'
  if (!['cert', 'chain', 'fullchain', 'key', 'csr'].includes(kind)) throw ApiError.badRequest('Unknown download kind')
  if (!order.cert_object_key && kind !== 'csr' && kind !== 'key') throw ApiError.notFound('The certificate is not ready')
  if (kind === 'key') {
    const settings = await readSettings(c.env.DB, userId)
    if (settings.requireReauthForKeys) {
      await requireCurrentPassword(c.env.DB, userId, c.req.header('X-Certhub-Reauth') ?? '')
    }
    if (!order.key_object_key || order.key_purged_at !== null) throw ApiError.notFound('The private key is not available')
  }
  let content: string | null = null
  let contentType = 'application/x-pem-file'
  if (kind === 'key') {
    const ciphertext = await readCerthubText(c.env, order.key_object_key)
    const privateKey = ciphertext ? await decryptCerthubOrderKey(c.env, order.id, ciphertext) : null
    if (!privateKey) throw new ApiError(503, 'vault_unavailable', 'The private key could not be decrypted')
    content = privateKey
    contentType = 'application/octet-stream'
    await appendEvent(c.env.DB, {
      userId, orderId: order.id, actor: actionActor(c), kind: 'key.downloaded', level: 'warn', messageCode: 'key.downloaded',
    })
  } else if (kind === 'csr') {
    content = await readCerthubText(c.env, order.csr_object_key)
  } else if (kind === 'cert') {
    const fullchain = await readCerthubText(c.env, order.cert_object_key)
    content = fullchain?.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0] ?? null
  } else if (kind === 'chain') {
    content = await readCerthubText(c.env, order.chain_object_key)
  } else {
    content = await readCerthubText(c.env, order.cert_object_key)
  }
  if (!content) throw ApiError.notFound('The requested certificate file is missing')
  const domains = await listDomains(c.env.DB, userId, order.id)
  const primary = domains.find((domain) => domain.is_primary === 1) ?? domains[0]
  const name = (primary ? (primary.wildcard === 1 ? `*.${primary.name}` : primary.name) : order.id).replace(/[^a-z0-9.*-]/gi, '_')
  const extension = kind === 'key' ? 'pem' : kind === 'csr' ? 'csr' : 'pem'
  return new Response(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${name}-${kind}.${extension}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

developmentCerthubRoutes.get('/orders/:id/export', async (c) => {
  const userId = userIdOf(c)
  const order = await findOrder(c.env.DB, userId, c.req.param('id'))
  if (!order) throw ApiError.notFound('The certificate order was not found')
  const kind = c.req.query('kind')
  if (kind !== 'zip' && kind !== 'pfx') throw ApiError.badRequest('Unknown export kind')
  if (!order.cert_object_key || !order.key_object_key || order.key_purged_at !== null) {
    throw ApiError.notFound('The certificate or private key is not available')
  }
  const settings = await readSettings(c.env.DB, userId)
  if (settings.requireReauthForKeys) {
    await requireCurrentPassword(c.env.DB, userId, c.req.header('X-Certhub-Reauth') ?? '')
  }
  const fullchain = await readCerthubText(c.env, order.cert_object_key)
  const ciphertext = await readCerthubText(c.env, order.key_object_key)
  const privateKey = ciphertext ? await decryptCerthubOrderKey(c.env, order.id, ciphertext) : null
  if (!fullchain || !privateKey) throw ApiError.notFound('The stored certificate material is incomplete')
  const domains = await listDomains(c.env.DB, userId, order.id)
  const primary = domains.find((domain) => domain.is_primary === 1) ?? domains[0]
  const primaryName = primary ? (primary.wildcard === 1 ? `*.${primary.name}` : primary.name) : order.id
  await appendEvent(c.env.DB, {
    userId, orderId: order.id, actor: actionActor(c), kind: 'key.downloaded', level: 'warn', messageCode: 'key.downloaded',
    detail: { kind },
  })
  if (kind === 'pfx') {
    const password = `${newId().slice(0, 8)}${usageDay().replace(/-/g, '').slice(0, 4)}`
    const bytes = pemToPfx(privateKey, fullchain, password, primaryName)
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/x-pkcs12',
        'Content-Disposition': `attachment; filename="${primaryName.replace(/[^a-z0-9.-]/gi, '_')}.pfx"`,
        'Cache-Control': 'no-store',
        'X-Certhub-Pfx-Password': password,
      },
    })
  }
  const { leaf, chain } = splitChain(fullchain)
  const zip = buildCerthubZip([
    { path: 'fullchain.pem', content: fullchain },
    { path: 'cert.pem', content: leaf },
    { path: 'chain.pem', content: chain },
    { path: 'privkey.pem', content: privateKey },
    {
      path: 'README.txt',
      content: [
        'CertHub certificate bundle',
        `Order: ${order.id}`,
        `Domains: ${domains.map((domain) => (domain.wildcard === 1 ? `*.${domain.name}` : domain.name)).join(', ')}`,
        `Issued: ${order.issued_at ? new Date(order.issued_at).toISOString() : '-'}`,
        `Expires: ${order.cert_not_after ? new Date(order.cert_not_after).toISOString() : '-'}`,
        '',
        'fullchain.pem  certificate plus intermediates',
        'cert.pem       leaf certificate only',
        'chain.pem      intermediates only',
        'privkey.pem    private key',
      ].join('\n'),
    },
  ])
  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${primaryName.replace(/[^a-z0-9.-]/gi, '_')}.zip"`,
      'Cache-Control': 'no-store',
    },
  })
})

function splitChain(fullchain: string): { leaf: string; chain: string } {
  const blocks = fullchain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  return { leaf: blocks[0] ? `${blocks[0]}\n` : '', chain: blocks.slice(1).map((block) => `${block}\n`).join('') }
}

developmentCerthubRoutes.get('/accounts', async (c) => {
  return c.json({ ok: true, data: { items: await listAccountsForUser(c.env.DB, userIdOf(c)) } })
})

developmentCerthubRoutes.post('/accounts', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, accountSchema)
  const settings = await readSettings(c.env.DB, userId)
  const environment = body.environment === 'staging' && c.env.CERTHUB_ALLOW_STAGING === '1' ? 'staging' : 'production'
  const account = body.privateKey
    ? await importAccountKey(c.env, c.env.DB, userId, body.ca, environment, settings.defaultKeyAlgorithm, body.privateKey, c.get('user').login)
    : (await ensureAccount(c.env, c.env.DB, userId, body.ca, environment, settings.defaultKeyAlgorithm, c.get('user').login)).account
  await appendEvent(c.env.DB, {
    userId,
    actor: actionActor(c),
    kind: 'account.registered',
    messageCode: 'account.registered',
    detail: { ca: body.ca, environment, fingerprint: account.key_fingerprint },
  })
  return c.json({ ok: true, data: { account: { id: account.id, ca: account.ca, environment: account.environment, accountUrl: account.account_url, keyFingerprint: account.key_fingerprint, status: account.status } } })
})

developmentCerthubRoutes.post('/accounts/:id/rotate', async (c) => {
  const userId = userIdOf(c)
  const account = await rotateAccountKey(c.env, c.env.DB, userId, c.req.param('id'))
  await appendEvent(c.env.DB, {
    userId,
    actor: actionActor(c),
    kind: 'account.rotated',
    level: 'warn',
    messageCode: 'account.rotated',
    detail: { ca: account.ca },
  })
  return c.json({ ok: true, data: { account: { id: account.id, ca: account.ca, status: account.status } } })
})

developmentCerthubRoutes.get('/dns-providers', async (c) => {
  return c.json({ ok: true, data: { items: await listProviders(c.env.DB, userIdOf(c)) } })
})

developmentCerthubRoutes.post('/dns-providers', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, dnsProviderSchema)
  if (body.kind === 'cloudflare' && (!body.zoneId || !body.secret)) {
    throw ApiError.badRequest('A Cloudflare provider needs a zone id and an API token')
  }
  const id = newId()
  const now = Date.now()
  const ciphertext = body.kind === 'cloudflare' && body.secret
    ? await encryptCerthubDnsCredential(c.env, id, { token: body.secret, email: body.accountEmail })
    : ''
  await insertProvider(c.env.DB, {
    user_id: userId,
    id,
    kind: body.kind,
    label: body.label,
    zone_id: body.zoneId ?? '',
    zone_name: body.zoneName ?? '',
    account_email: body.accountEmail ?? '',
    credential_ciphertext: ciphertext,
    status: 'active',
    last_checked_at: null,
    last_error_code: null,
    last_error_message: null,
    created_at: now,
    updated_at: now,
  })
  await appendEvent(c.env.DB, {
    userId, actor: actionActor(c), kind: 'provider.created', messageCode: 'provider.created',
    detail: { kind: body.kind, label: body.label },
  })
  return c.json({ ok: true, data: { items: await listProviders(c.env.DB, userId) } })
})

developmentCerthubRoutes.patch('/dns-providers/:id', async (c) => {
  const userId = userIdOf(c)
  const provider = await findProvider(c.env.DB, userId, c.req.param('id'))
  if (!provider) throw ApiError.notFound('The DNS provider was not found')
  const body = await parseBody(c, dnsProviderSchema.partial())
  const patch: Record<string, unknown> = {
    label: body.label ?? provider.label,
    zone_id: body.zoneId ?? provider.zone_id,
    zone_name: body.zoneName ?? provider.zone_name,
    account_email: body.accountEmail ?? provider.account_email,
    updated_at: Date.now(),
  }
  if (body.secret) {
    if (provider.kind !== 'cloudflare') throw ApiError.badRequest('Only a Cloudflare provider carries a token')
    patch.credential_ciphertext = await encryptCerthubDnsCredential(c.env, provider.id, {
      token: body.secret,
      email: body.accountEmail ?? provider.account_email,
    })
  }
  await updateProvider(c.env.DB, userId, provider.id, patch)
  await appendEvent(c.env.DB, {
    userId, actor: actionActor(c), kind: 'provider.updated', messageCode: 'provider.updated',
    detail: { id: provider.id },
  })
  return c.json({ ok: true, data: { items: await listProviders(c.env.DB, userId) } })
})

developmentCerthubRoutes.delete('/dns-providers/:id', async (c) => {
  const userId = userIdOf(c)
  const provider = await findProvider(c.env.DB, userId, c.req.param('id'))
  if (!provider) throw ApiError.notFound('The DNS provider was not found')
  if (await providerReferenced(c.env.DB, userId, provider.id)) {
    throw new ApiError(409, 'conflict', 'A pending order still uses this DNS provider')
  }
  const body = await readJson<{ confirm?: unknown }>(c, JSON_BODY_LIMITS.small).catch(() => ({ confirm: undefined }))
  if (String(body.confirm ?? '') !== provider.label) throw ApiError.badRequest('Type the provider label to confirm deletion')
  await deleteProvider(c.env.DB, userId, provider.id)
  await appendEvent(c.env.DB, {
    userId, actor: actionActor(c), kind: 'provider.deleted', level: 'warn', messageCode: 'provider.deleted',
    detail: { label: provider.label },
  })
  return c.json({ ok: true, data: { items: await listProviders(c.env.DB, userId) } })
})

developmentCerthubRoutes.post('/dns-providers/:id/test', async (c) => {
  const userId = userIdOf(c)
  const provider = await findProvider(c.env.DB, userId, c.req.param('id'))
  if (!provider) throw ApiError.notFound('The DNS provider was not found')
  if (provider.kind !== 'cloudflare') {
    return c.json({ ok: true, data: { ok: Boolean(c.env.CERTHUB_DCV_ZONE && c.env.CERTHUB_DCV_TOKEN) } })
  }
  const credential = await decryptCerthubDnsCredential(c.env, provider.id, provider.credential_ciphertext)
  if (!credential) throw new ApiError(503, 'vault_unavailable', 'The DNS provider credential could not be decrypted')
  await verifyCloudflareToken(credential.token)
  await updateProvider(c.env.DB, userId, provider.id, { last_checked_at: Date.now(), status: 'active', updated_at: Date.now() })
  return c.json({ ok: true, data: { ok: true } })
})

developmentCerthubRoutes.get('/settings', async (c) => {
  const settings = await readSettings(c.env.DB, userIdOf(c))
  const config = await readConfig(c.env.DB)
  return c.json({ ok: true, data: { settings, config: publicConfig(config) } })
})

function publicConfig(config: CerthubConfigView): CerthubConfigView {
  return config
}

developmentCerthubRoutes.put('/settings', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, settingsSchema)
  const patch: Record<string, unknown> = { updated_at: Date.now() }
  if (body.defaultCa !== undefined) patch.default_ca = body.defaultCa
  if (body.defaultKeyAlgorithm !== undefined) patch.default_key_algorithm = body.defaultKeyAlgorithm
  if (body.defaultChallengeMode !== undefined) patch.default_challenge_mode = body.defaultChallengeMode
  if (body.defaultAutoRenew !== undefined) patch.default_auto_renew = body.defaultAutoRenew ? 1 : 0
  if (body.renewDaysBefore !== undefined) patch.renew_days_before = body.renewDaysBefore
  if (body.notifyOnIssued !== undefined) patch.notify_on_issued = body.notifyOnIssued ? 1 : 0
  if (body.notifyOnFailed !== undefined) patch.notify_on_failed = body.notifyOnFailed ? 1 : 0
  if (body.notifyOnExpiring !== undefined) patch.notify_on_expiring = body.notifyOnExpiring ? 1 : 0
  if (body.notifyOnExpired !== undefined) patch.notify_on_expired = body.notifyOnExpired ? 1 : 0
  if (body.maxActiveCerts !== undefined) patch.max_active_certs = body.maxActiveCerts
  if (body.requireReauthForKeys !== undefined) patch.require_reauth_for_keys = body.requireReauthForKeys ? 1 : 0
  await updateSettings(c.env.DB, userId, patch)
  return c.json({ ok: true, data: { settings: await readSettings(c.env.DB, userId) } })
})

developmentCerthubRoutes.get('/tokens', async (c) => {
  return c.json({ ok: true, data: { items: await listTokens(c.env.DB, userIdOf(c)) } })
})

developmentCerthubRoutes.post('/tokens', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, tokenCreateSchema)
  const token = `crt_${newSlugToken()}`
  const id = newId()
  await insertToken(c.env.DB, {
    userId,
    id,
    name: body.name,
    tokenHash: await sha256Hex(token),
    tokenPrefix: token.slice(0, 10),
    scopes: body.scopes ?? ['read', 'issue'],
    expiresAt: body.expiresAt ?? null,
  })
  await appendEvent(c.env.DB, {
    userId, actor: actionActor(c), kind: 'token.created', messageCode: 'token.created', detail: { id, name: body.name },
  })
  return c.json({ ok: true, data: { token, item: (await listTokens(c.env.DB, userId)).find((entry) => entry.id === id) } }, 201)
})

function newSlugToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
  let out = ''
  for (let index = 0; index < bytes.length; index += 1) out += alphabet[bytes[index]! & 31]
  return out
}

developmentCerthubRoutes.post('/tokens/:id/rotate', async (c) => {
  const userId = userIdOf(c)
  const tokenId = c.req.param('id')
  const existing = (await listTokens(c.env.DB, userId)).find((entry) => entry.id === tokenId)
  if (!existing) throw ApiError.notFound('The API token was not found')
  await revokeToken(c.env.DB, userId, tokenId)
  const token = `crt_${newSlugToken()}`
  const id = newId()
  await insertToken(c.env.DB, {
    userId,
    id,
    name: existing.name,
    tokenHash: await sha256Hex(token),
    tokenPrefix: token.slice(0, 10),
    scopes: existing.scopes,
    expiresAt: existing.expiresAt,
  })
  await appendEvent(c.env.DB, {
    userId, actor: actionActor(c), kind: 'token.rotated', level: 'warn', messageCode: 'token.rotated', detail: { id },
  })
  return c.json({ ok: true, data: { token, item: (await listTokens(c.env.DB, userId)).find((entry) => entry.id === id) } })
})

developmentCerthubRoutes.delete('/tokens/:id', async (c) => {
  const userId = userIdOf(c)
  const tokenId = c.req.param('id')
  await revokeToken(c.env.DB, userId, tokenId)
  await appendEvent(c.env.DB, {
    userId, actor: actionActor(c), kind: 'token.revoked', level: 'warn', messageCode: 'token.revoked', detail: { id: tokenId },
  })
  return c.json({ ok: true, data: { items: await listTokens(c.env.DB, userId) } })
})

developmentCerthubRoutes.get('/config', async (c) => {
  const config = await readConfig(c.env.DB)
  return c.json({ ok: true, data: { config: publicConfig(config), usage: { day: usageDay(), month: usageMonth() } } })
})

developmentCerthubRoutes.get('/admin/overview', async (c) => {
  if (c.get('user')?.role !== 'owner') throw ApiError.forbidden('Owner access required')
  const counts = await c.env.DB.prepare(`SELECT status, COUNT(*) AS c FROM development_certhub_orders
    WHERE deleted_at IS NULL GROUP BY status`).all<{ status: string; c: number }>()
  const failed = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM development_certhub_orders
    WHERE status = 'failed' AND updated_at > ?1`).bind(Date.now() - 86_400_000).first<{ c: number }>()
  return c.json({ ok: true, data: { counts: counts.results, failures24h: Number(failed?.c ?? 0), queue: await readConfig(c.env.DB) } })
})

developmentCerthubRoutes.get('/admin/config', async (c) => {
  if (c.get('user')?.role !== 'owner') throw ApiError.forbidden('Owner access required')
  return c.json({ ok: true, data: { config: await readConfig(c.env.DB) } })
})

developmentCerthubRoutes.put('/admin/config', async (c) => {
  if (c.get('user')?.role !== 'owner') throw ApiError.forbidden('Owner access required')
  const body = await parseBody(c, configPatchSchema)
  const mapping: Record<string, unknown> = {}
  if (body.enabledCas) mapping.enabledCas = body.enabledCas
  if (body.maxOrdersPerDay !== undefined) mapping.maxOrdersPerDay = body.maxOrdersPerDay
  if (body.maxOrdersPerMonth !== undefined) mapping.maxOrdersPerMonth = body.maxOrdersPerMonth
  if (body.maxPendingOrders !== undefined) mapping.maxPendingOrders = body.maxPendingOrders
  if (body.maxActiveCertsDefault !== undefined) mapping.maxActiveCertsDefault = body.maxActiveCertsDefault
  if (body.maxDomainsPerOrder !== undefined) mapping.maxDomainsPerOrder = body.maxDomainsPerOrder
  if (body.acmeTimeoutMs !== undefined) mapping.acmeTimeoutMs = body.acmeTimeoutMs
  if (body.jobBatchSize !== undefined) mapping.jobBatchSize = body.jobBatchSize
  const { updateConfig } = await import('../development/certhub/store')
  await updateConfig(c.env.DB, mapping)
  await appendEvent(c.env.DB, {
    userId: userIdOf(c), actor: 'owner', kind: 'config.updated', level: 'warn', messageCode: 'config.updated',
  })
  return c.json({ ok: true, data: { config: await readConfig(c.env.DB) } })
})

developmentCerthubRoutes.get('/admin/orders', async (c) => {
  if (c.get('user')?.role !== 'owner') throw ApiError.forbidden('Owner access required')
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 30)))
  const rows = await c.env.DB.prepare(`SELECT id, user_id, status, ca, created_at, updated_at, cert_not_after
    FROM development_certhub_orders WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?1`)
    .bind(limit).all()
  return c.json({ ok: true, data: { items: rows.results } })
})

developmentCerthubRoutes.get('/admin/orders/:id', async (c) => {
  if (c.get('user')?.role !== 'owner') throw ApiError.forbidden('Owner access required')
  const row = await c.env.DB.prepare(`SELECT user_id FROM development_certhub_orders WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(c.req.param('id')).first<{ user_id: string }>()
  if (!row) throw ApiError.notFound('The certificate order was not found')
  const order = await findOrder(c.env.DB, row.user_id, c.req.param('id'))
  if (!order) throw ApiError.notFound('The certificate order was not found')
  const domains = await listDomains(c.env.DB, row.user_id, order.id)
  const events = await listEvents(c.env.DB, row.user_id, order.id, null, 20)
  return c.json({ ok: true, data: { userId: row.user_id, order: orderWithDomains(order, domains), events: events.items } })
})

developmentCerthubRoutes.post('/admin/orders/:id/actions', async (c) => {
  if (c.get('user')?.role !== 'owner') throw ApiError.forbidden('Owner access required')
  const body = await parseBody(c, actionSchema)
  const row = await c.env.DB.prepare(`SELECT user_id FROM development_certhub_orders WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(c.req.param('id')).first<{ user_id: string }>()
  if (!row) throw ApiError.notFound('The certificate order was not found')
  const order = await findOrder(c.env.DB, row.user_id, c.req.param('id'))
  if (!order) throw ApiError.notFound('The certificate order was not found')
  if (body.action === 'delete') {
    if (!['failed', 'canceled', 'revoked', 'expired'].includes(order.status)) {
      throw new ApiError(409, 'order_state_conflict', 'Only a finished order can be deleted')
    }
    if (body.confirm !== order.id) throw ApiError.badRequest('Type the order id to confirm deletion')
    await cancelJobsForOrder(c.env.DB, row.user_id, order.id)
    const { orderObjectKeys, keyReferencedElsewhere } = await import('../development/certhub/store')
    const keys = await orderObjectKeys(c.env.DB, row.user_id, order.id)
    const orphans: string[] = []
    for (const key of keys) {
      if (!(await keyReferencedElsewhere(c.env.DB, row.user_id, order.id, key))) orphans.push(key)
    }
    await deleteOrderRows(c.env.DB, row.user_id, order.id)
    await deleteCerthubObjects(c.env, orphans)
    await appendEvent(c.env.DB, {
      userId: row.user_id, orderId: order.id, actor: 'owner', kind: 'order.deleted', level: 'warn', messageCode: 'order.deleted',
    })
    return c.json({ ok: true, data: { deleted: true } })
  }
  if (body.action === 'renew' || body.action === 'cancel') {
    throw ApiError.forbidden('Owner may retry, revoke, purge or delete only')
  }
  const result = await handleOrderAction(c.env, c.env.DB, row.user_id, order.id, body.action, 'owner', {
    revokeReason: body.revokeReason,
  })
  const domains = await listDomains(c.env.DB, row.user_id, order.id)
  return c.json({ ok: true, data: { order: orderWithDomains(result.order, domains) } })
})

developmentCerthubRoutes.get('/admin/users/:userId/limits', async (c) => {
  if (c.get('user')?.role !== 'owner') throw ApiError.forbidden('Owner access required')
  const settings = await readSettings(c.env.DB, c.req.param('userId'))
  return c.json({ ok: true, data: { settings } })
})

developmentCerthubRoutes.put('/admin/users/:userId/limits', async (c) => {
  if (c.get('user')?.role !== 'owner') throw ApiError.forbidden('Owner access required')
  const body = await parseBody(c, z.object({ maxActiveCerts: z.number().int().min(0).max(CERTHUB_LIMITS.maxActiveCertsCeiling) }).strict())
  await updateSettings(c.env.DB, c.req.param('userId'), { max_active_certs: body.maxActiveCerts, updated_at: Date.now() })
  await appendEvent(c.env.DB, {
    userId: c.req.param('userId'), actor: 'owner', kind: 'quota.updated', level: 'warn', messageCode: 'quota.updated',
    detail: { maxActiveCerts: body.maxActiveCerts },
  })
  return c.json({ ok: true, data: { settings: await readSettings(c.env.DB, c.req.param('userId')) } })
})


