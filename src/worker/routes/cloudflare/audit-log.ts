/**
 * `/api/cloudflare/audit-log` — the reader's own trail, filtered and paged.
 *
 * The reference route read every row and filtered in the browser, which cannot page a table and
 * quietly stops at a fixed limit. Here the filters, ordering and page bounds are SQL, and the reader
 * id is always the first condition: a log line is never visible to anyone but the person who caused
 * it.
 */
import { Hono, type Context } from 'hono'
import type { CloudflareAuditLog } from '@shared/cloudflare/model'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'

export const auditLogRouter = new Hono<AppBindings>()

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const MAX_SEARCH_LENGTH = 200

const SORT_COLUMNS: Record<string, string> = {
  created_at: 'l.created_at',
  account_name: 'a.name',
  action: 'l.action',
  target: 'l.target',
  detail: 'l.detail',
  status: 'l.status',
}

const LOG_COLUMNS = `l.id, l.account_id, l.action, l.target, l.detail, l.status, l.created_at,
  a.name AS account_name`

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

function readSort(raw: string | undefined): { column: string; direction: 'ASC' | 'DESC' } {
  const value = (raw ?? '-created_at').trim()
  const descending = value.startsWith('-')
  const key = descending ? value.slice(1) : value
  const column = SORT_COLUMNS[key]
  if (!column) throw ApiError.badRequest(`Unknown sort column: ${key || '(empty)'}`)
  return { column, direction: descending ? 'DESC' : 'ASC' }
}

function likeTerm(value: string): string {
  const escaped = value.replace(/[\\%_]/g, (character) => `\\${character}`)
  return `%${escaped}%`
}

interface AuditQuery {
  where: string
  values: unknown[]
  order: string
  limit: number
  offset: number
}

function readQuery(c: Context<AppBindings>): AuditQuery {
  const action = (c.req.query('action') ?? '').trim()
  const search = (c.req.query('q') ?? '').trim()
  if (search.length > MAX_SEARCH_LENGTH) {
    throw ApiError.badRequest(`q must be ${MAX_SEARCH_LENGTH} characters or fewer`)
  }
  const from = readBoundary(c.req.query('from'), 'from', false)
  const to = readBoundary(c.req.query('to'), 'to', true)
  if (from !== null && to !== null && from > to) {
    throw ApiError.badRequest('from must not be after to')
  }

  const conditions = ['l.user_id = ?']
  const values: unknown[] = [c.get('userId')]
  if (action) {
    conditions.push('l.action = ?')
    values.push(action)
  }
  if (search) {
    const term = likeTerm(search)
    conditions.push(
      `(a.name LIKE ? ESCAPE '\\' OR l.target LIKE ? ESCAPE '\\'
        OR l.detail LIKE ? ESCAPE '\\' OR l.action LIKE ? ESCAPE '\\')`,
    )
    values.push(term, term, term, term)
  }
  if (from !== null) {
    conditions.push('l.created_at >= ?')
    values.push(from)
  }
  if (to !== null) {
    conditions.push('l.created_at <= ?')
    values.push(to)
  }

  const page = readInteger(c.req.query('page'), 1, 1, 1_000_000, 'page')
  const pageSize = readInteger(c.req.query('pageSize'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, 'pageSize')
  const sort = readSort(c.req.query('sort'))
  return {
    where: conditions.join(' AND '),
    values,
    order: `ORDER BY ${sort.column} ${sort.direction}, l.id ${sort.direction}`,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  }
}

auditLogRouter.get('/actions', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT DISTINCT action FROM cloudflare_log WHERE user_id = ? ORDER BY action ASC',
  )
    .bind(c.get('userId'))
    .all<{ action: string }>()
  return c.json({ actions: (rows.results ?? []).map((row) => row.action) })
})

auditLogRouter.get('/', async (c) => {
  const query = readQuery(c)
  const base = `FROM cloudflare_log l
    LEFT JOIN cloudflare_account a ON a.id = l.account_id AND a.user_id = l.user_id
    WHERE ${query.where}`

  const [totalRow, rows, actionRows] = await Promise.all([
    c.env.DB.prepare(`SELECT count(*) AS n ${base}`)
      .bind(...query.values)
      .first<{ n: number }>(),
    c.env.DB.prepare(`SELECT ${LOG_COLUMNS} ${base} ${query.order} LIMIT ? OFFSET ?`)
      .bind(...query.values, query.limit, query.offset)
      .all<CloudflareAuditLog>(),
    c.env.DB.prepare('SELECT DISTINCT action FROM cloudflare_log WHERE user_id = ? ORDER BY action ASC')
      .bind(c.get('userId'))
      .all<{ action: string }>(),
  ])

  return c.json({
    logs: rows.results ?? [],
    total: totalRow?.n ?? 0,
    actions: (actionRows.results ?? []).map((row) => row.action),
  })
})
