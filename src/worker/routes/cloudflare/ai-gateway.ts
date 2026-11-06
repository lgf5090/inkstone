/**
 * `/api/cloudflare/ai-gateway` — the session-authenticated management surface for the self-hosted
 * gateway. The public data plane lives under `/api/gateway` and authenticates with `gw_` keys instead.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { readJson } from '../../lib/request'
import { createAuditLog } from '../../cloudflare/audit'
import { accountHasFeature, loadActiveAccounts } from '../../cloudflare/accounts'
import {
  AI_GATEWAY_HARD_LIMIT,
  gatewayDay,
  gatewayLimit,
  readAccountStates,
  readLedgers,
  reconcileAll,
} from '../../cloudflare/ai-gateway-quota'
import {
  createGatewayKey,
  listGatewayKeys,
  revokeGatewayKey,
} from '../../cloudflare/ai-gateway-keys'
import { listGatewayRequests } from '../../cloudflare/ai-gateway-log'
import { listGatewayModels } from '../../cloudflare/ai-gateway-models'

export const aiGatewayRouter = new Hono<AppBindings>()

aiGatewayRouter.get('/overview', async (c) => {
  const userId = c.get('userId')
  const now = Date.now()
  const day = gatewayDay(now)
  const limit = gatewayLimit(c.env)
  const [accounts, ledgers, states, keys] = await Promise.all([
    loadActiveAccounts(c.env, userId),
    readLedgers(c.env, userId, now),
    readAccountStates(c.env, userId),
    listGatewayKeys(c.env, userId, day),
  ])
  const aiAccounts = accounts.filter(({ row }) => Boolean(row.cf_account_id) && accountHasFeature(row, 'ai'))
  const accountRows = aiAccounts.map(({ row }) => {
    const ledger = ledgers.get(row.id)
    const state = states.get(row.id)
    const used = ledger?.effectiveNeurons ?? 0
    const remaining = Math.max(0, limit - used)
    const selections = state?.selectionDay === day ? state.selectionCount : 0
    return {
      id: row.id,
      name: row.name,
      status: ledger?.exhausted ? 'exhausted_today' : (state?.status ?? 'active'),
      usedNeurons: used,
      remainingNeurons: remaining,
      requests: ledger?.requests ?? 0,
      cooldownUntil: state?.cooldownUntil ?? 0,
      errorCode: state?.errorCode ?? null,
      selectionCount: selections,
      scheduleScore: remaining / (1 + selections),
    }
  })
  const totals = accountRows.reduce(
    (sum, account) => ({
      used: sum.used + account.usedNeurons,
      remaining: sum.remaining + account.remainingNeurons,
    }),
    { used: 0, remaining: 0 },
  )
  const { results: recentReconcile } = await c.env.DB.prepare(
    `SELECT account_id, authoritative_neurons, local_effective, delta, outcome, checked_at
       FROM ai_gateway_reconcile_snapshots
      WHERE user_id = ?1
      ORDER BY checked_at DESC LIMIT 10`,
  ).bind(userId).all<{
    account_id: string
    authoritative_neurons: number
    local_effective: number
    delta: number
    outcome: string
    checked_at: number
  }>()
  return c.json({
    day,
    limit,
    hardLimit: AI_GATEWAY_HARD_LIMIT,
    accounts: accountRows.sort((left, right) => right.scheduleScore - left.scheduleScore),
    totals,
    keys,
    recentReconcile: (recentReconcile ?? []).map((row) => ({
      accountId: row.account_id,
      authoritative: row.authoritative_neurons,
      localEffective: row.local_effective,
      delta: row.delta,
      outcome: row.outcome,
      checkedAt: row.checked_at,
    })),
  })
})

aiGatewayRouter.get('/keys', async (c) => {
  const userId = c.get('userId')
  return c.json({ keys: await listGatewayKeys(c.env, userId, gatewayDay()) })
})

aiGatewayRouter.post('/keys', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<Record<string, unknown>>(c, 64 * 1024)
  if (typeof body.name !== 'string' || !body.name.trim()) throw ApiError.badRequest('A key name is required')
  const models = Array.isArray(body.allowedModels)
    ? body.allowedModels.filter((model): model is string => typeof model === 'string')
    : undefined
  const limit = typeof body.dailyRequestLimit === 'number' ? body.dailyRequestLimit : 0
  const created = await createGatewayKey(c.env, userId, {
    name: body.name,
    ...(models ? { allowedModels: models } : {}),
    dailyRequestLimit: limit,
  })
  await createAuditLog(c.env, userId, '', 'ai_gateway_key_create', created.record.id, created.record.name, 'success')
  return c.json({ key: created.record, token: created.token }, 201)
})

aiGatewayRouter.delete('/keys/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!id || id.length > 64) throw ApiError.badRequest('Invalid key id')
  const revoked = await revokeGatewayKey(c.env, userId, id)
  if (!revoked) throw ApiError.notFound('That key does not exist or is already revoked')
  await createAuditLog(c.env, userId, '', 'ai_gateway_key_revoke', id, 'revoked', 'success')
  return c.json({ revoked: true })
})

aiGatewayRouter.get('/logs', async (c) => {
  const userId = c.get('userId')
  const query = new URL(c.req.url).searchParams
  const page = Number(query.get('page') ?? '1')
  const pageSize = Number(query.get('pageSize') ?? '50')
  const result = await listGatewayRequests(c.env, userId, {
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 50,
    ...(query.get('status') ? { status: query.get('status') as string } : {}),
    ...(query.get('format') ? { format: query.get('format') as string } : {}),
    ...(query.get('keyId') ? { keyId: query.get('keyId') as string } : {}),
    ...(query.get('accountId') ? { accountId: query.get('accountId') as string } : {}),
    ...(query.get('model') ? { model: query.get('model') as string } : {}),
    ...(query.get('since') ? { since: Number(query.get('since')) } : {}),
    ...(query.get('until') ? { until: Number(query.get('until')) } : {}),
  })
  return c.json(result)
})

aiGatewayRouter.post('/reconcile', async (c) => {
  const userId = c.get('userId')
  const results = await reconcileAll(c.env, userId)
  await createAuditLog(c.env, userId, '', 'ai_gateway_reconcile', 'all', `${results.length} accounts`, 'success')
  return c.json({ results })
})

aiGatewayRouter.get('/reconcile', async (c) => {
  const userId = c.get('userId')
  const query = new URL(c.req.url).searchParams
  const page = Math.max(1, Number(query.get('page') ?? '1'))
  const pageSize = Math.max(1, Math.min(100, Number(query.get('pageSize') ?? '50')))
  const accountId = query.get('accountId')
  const where = ['user_id = ?']
  const values: unknown[] = [userId]
  if (accountId) { where.push('account_id = ?'); values.push(accountId) }
  const [count, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM ai_gateway_reconcile_snapshots WHERE ${where.join(' AND ')}`)
      .bind(...values).first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT id, account_id, day, authoritative_neurons, local_effective, delta, outcome, checked_at, note
         FROM ai_gateway_reconcile_snapshots
        WHERE ${where.join(' AND ')}
        ORDER BY checked_at DESC
        LIMIT ? OFFSET ?`,
    ).bind(...values, pageSize, (page - 1) * pageSize).all<{
      id: string
      account_id: string
      day: string
      authoritative_neurons: number
      local_effective: number
      delta: number
      outcome: string
      checked_at: number
      note: string | null
    }>(),
  ])
  return c.json({
    total: count?.total ?? 0,
    items: (rows.results ?? []).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      day: row.day,
      authoritative: row.authoritative_neurons,
      localEffective: row.local_effective,
      delta: row.delta,
      outcome: row.outcome,
      checkedAt: row.checked_at,
      note: row.note,
    })),
  })
})

aiGatewayRouter.get('/access', async (c) => {
  const base = c.env.PUBLIC_URL ? c.env.PUBLIC_URL.replace(/\/$/, '') : new URL(c.req.url).origin
  return c.json({
    baseUrl: `${base}/api/gateway/v1`,
    models: listGatewayModels(),
    endpoints: ['/chat/completions', '/responses', '/models'],
  })
})
