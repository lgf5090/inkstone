/**
 * Cloudflare's account audit log (Audit Logs v2), read-only.
 *
 * This is not the module's own `cloudflare_log` table: that one records what this app did through the
 * reader's accounts. This endpoint asks Cloudflare what *everyone* did on the account — dashboard
 * logins, API calls, membership changes — which the reference client calls "Audit Logs". The two
 * views are kept apart on purpose.
 *
 * The v2 API paginates by `cursor` inside `result_info`, and the time window (`since`/`before`) is
 * mandatory. A revoked token or a missing `account-settings.read` scope comes back as Cloudflare's
 * own error, shown verbatim rather than turned into an empty page.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { loadAccount } from '../../cloudflare/accounts'
import { cfFetch } from '../../cloudflare/cf-api'

export const auditLogsV2Router = new Hono<AppBindings>()

const MAX_LIMIT = 200
const MAX_WINDOW_DAYS = 90

export interface CfAuditEntry {
  id: string
  time: string | null
  description: string | null
  result: string | null
  actor_email: string | null
  actor_type: string | null
  actor_context: string | null
  actor_ip: string | null
  resource_type: string | null
  resource_product: string | null
  resource_id: string | null
  method: string | null
  uri: string | null
  status_code: number | null
  zone_name: string | null
}

interface CfAuditResult {
  result?: Array<{
    id?: unknown
    action?: { description?: unknown; result?: unknown; time?: unknown; type?: unknown }
    actor?: { email?: unknown; type?: unknown; context?: unknown; ip_address?: unknown }
    resource?: { type?: unknown; product?: unknown; id?: unknown }
    raw?: { method?: unknown; status_code?: unknown; uri?: unknown }
    zone?: { id?: unknown; name?: unknown }
  }>
  result_info?: { cursor?: unknown }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Cursor is opaque; anything else in a "cursor" parameter position is refused. */
function parseCursor(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw ApiError.badRequest('Invalid audit log cursor')
  return value
}

auditLogsV2Router.get('/', async (c) => {
  const userId = c.get('userId')
  const accountId = (c.req.query('accountId') ?? '').trim()
  if (!accountId) throw ApiError.badRequest('accountId is required')
  const account = await loadAccount(c.env, userId, accountId)
  const cfAccountId = account.row.cf_account_id?.trim()
  if (!cfAccountId) {
    throw new ApiError(400, 'cloudflare_not_configured', 'This account has no Cloudflare account id')
  }

  // The v2 API needs a bounded time window. Default to the last 30 days, which is also what the
  // reference client shows.
  const now = Date.now()
  const sinceRaw = c.req.query('since')
  const beforeRaw = c.req.query('before')
  const before = beforeRaw ? Number(beforeRaw) : now
  const since = sinceRaw ? Number(sinceRaw) : before - 30 * 86_400_000
  if (!Number.isFinite(since) || !Number.isFinite(before) || since >= before) {
    throw ApiError.badRequest('since must be an earlier timestamp than before')
  }
  if (before - since > MAX_WINDOW_DAYS * 86_400_000) {
    throw ApiError.badRequest(`The audit window may span at most ${MAX_WINDOW_DAYS} days`)
  }

  const limitRaw = Number(c.req.query('limit') ?? 50)
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= MAX_LIMIT
    ? limitRaw
    : 50
  const cursor = c.req.query('cursor')
  if (cursor !== undefined && cursor.trim() !== '') parseCursor(cursor.trim())

  const path = `/accounts/${encodeURIComponent(cfAccountId)}/logs/audit`
  const query: Record<string, string> = {
    since: new Date(since).toISOString(),
    before: new Date(before).toISOString(),
    limit: String(limit),
    direction: 'desc',
  }
  if (cursor) query.cursor = cursor.trim()

  const body = await cfFetch<CfAuditResult>(account.auth, `${path}?${new URLSearchParams(query).toString()}`)
  const entries = (body.result ?? []).map((row): CfAuditEntry => {
    const action = asRecord(row.action)
    const actor = asRecord(row.actor)
    const resource = asRecord(row.resource)
    const raw = asRecord(row.raw)
    const zone = asRecord(row.zone)
    return {
      id: textOf(row.id),
      time: textOf(action.time),
      description: textOf(action.description),
      result: textOf(action.result),
      actor_email: textOf(actor.email),
      actor_type: textOf(actor.type),
      actor_context: textOf(actor.context),
      actor_ip: textOf(actor.ip_address),
      resource_type: textOf(resource.type),
      resource_product: textOf(resource.product),
      resource_id: textOf(resource.id),
      method: textOf(raw.method),
      uri: textOf(raw.uri),
      status_code: typeof raw.status_code === 'number' ? raw.status_code : null,
      zone_name: textOf(zone.name),
    }
  })

  return c.json({
    accountId: account.row.id,
    accountName: account.row.name,
    entries,
    cursor: body.result_info?.cursor ?? null,
  })
})
