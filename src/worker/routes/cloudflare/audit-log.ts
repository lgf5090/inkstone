/**
 * `/api/cloudflare/audit-log` — the reader's own trail, filtered and paged.
 *
 * The route turns query strings into numbers and dates, and answers refusals as 400. The SQL and the
 * row shape live in `cloudflare/audit-log.ts`; this file never names a table.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { listAuditActions, listAuditLogs } from '../../cloudflare/audit-log'

export const auditLogRouter = new Hono<AppBindings>()

/** Dates arrive as `YYYY-MM-DD` from the date fields; milliseconds are accepted for API callers. */
function readBoundary(raw: string | undefined, field: string, endOfDay: boolean): number | null {
  if (raw === undefined || raw === '') return null
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw)
  const value = dateOnly
    ? Date.parse(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : Number(raw)
  if (!Number.isFinite(value)) {
    throw ApiError.badRequest(`${field} must be a date or a millisecond timestamp`)
  }
  return value
}

function readInteger(raw: string | undefined, fallback: number, min: number, max: number, field: string): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw ApiError.badRequest(`${field} must be a whole number between ${min} and ${max}`)
  }
  return value
}

auditLogRouter.get('/actions', async (c) => {
  return c.json({ actions: await listAuditActions(c.env, c.get('userId')) })
})

auditLogRouter.get('/', async (c) => {
  const from = readBoundary(c.req.query('from'), 'from', false)
  const to = readBoundary(c.req.query('to'), 'to', true)
  if (from !== null && to !== null && from > to) {
    throw ApiError.badRequest('from must not be after to')
  }
  const page = readInteger(c.req.query('page'), 1, 1, 1_000_000, 'page')
  const pageSize = readInteger(c.req.query('pageSize'), 20, 1, 100, 'pageSize')
  const result = await listAuditLogs(c.env, c.get('userId'), {
    action: c.req.query('action'),
    q: c.req.query('q'),
    from,
    to,
    page,
    pageSize,
    sort: c.req.query('sort'),
  })
  return c.json(result)
})
