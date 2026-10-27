/**
 * The audit trail, read back as rows.
 *
 * Filters, ordering and page bounds are SQL because the table can outgrow a browser copy; every
 * condition starts with the reader's id, so a log line is visible only to the person who caused it.
 * Parsing the query string into these fields belongs to the route.
 */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import type { CloudflareAuditLog } from '@shared/cloudflare/model'

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

export interface AuditLogQuery {
  action?: string
  q?: string
  from?: number | null
  to?: number | null
  page?: number
  pageSize?: number
  sort?: string
}

export interface AuditLogPage {
  logs: CloudflareAuditLog[]
  total: number
  actions: string[]
}

function likeTerm(value: string): string {
  const escaped = value.replace(/[\\%_]/g, (character) => `\\${character}`)
  return `%${escaped}%`
}

function orderBy(raw: string | undefined): string {
  const value = (raw ?? '-created_at').trim()
  const descending = value.startsWith('-')
  const key = descending ? value.slice(1) : value
  const column = SORT_COLUMNS[key]
  if (!column) throw ApiError.badRequest(`Unknown sort column: ${key || '(empty)'}`)
  return `ORDER BY ${column} ${descending ? 'DESC' : 'ASC'}, l.id ${descending ? 'DESC' : 'ASC'}`
}

export async function listAuditLogs(env: Env, userId: string, query: AuditLogQuery): Promise<AuditLogPage> {
  const action = (query.action ?? '').trim()
  const search = (query.q ?? '').trim()
  if (search.length > MAX_SEARCH_LENGTH) throw ApiError.badRequest(`q must be ${MAX_SEARCH_LENGTH} characters or fewer`)
  const conditions = ['l.user_id = ?']
  const values: unknown[] = [userId]
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
  if (query.from != null) {
    conditions.push('l.created_at >= ?')
    values.push(query.from)
  }
  if (query.to != null) {
    conditions.push('l.created_at <= ?')
    values.push(query.to)
  }

  const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const page = Math.max(query.page ?? 1, 1)
  const base = `FROM cloudflare_log l
    LEFT JOIN cloudflare_account a ON a.id = l.account_id AND a.user_id = l.user_id
    WHERE ${conditions.join(' AND ')}`

  const [totalRow, rows, actionRows] = await Promise.all([
    env.DB.prepare(`SELECT count(*) AS n ${base}`)
      .bind(...values)
      .first<{ n: number }>(),
    env.DB.prepare(`SELECT ${LOG_COLUMNS} ${base} ${orderBy(query.sort)} LIMIT ? OFFSET ?`)
      .bind(...values, pageSize, (page - 1) * pageSize)
      .all<CloudflareAuditLog>(),
    env.DB.prepare('SELECT DISTINCT action FROM cloudflare_log WHERE user_id = ? ORDER BY action ASC')
      .bind(userId)
      .all<{ action: string }>(),
  ])

  return {
    logs: rows.results ?? [],
    total: totalRow?.n ?? 0,
    actions: (actionRows.results ?? []).map((row) => row.action),
  }
}

export async function listAuditActions(env: Env, userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT DISTINCT action FROM cloudflare_log WHERE user_id = ? ORDER BY action ASC',
  )
    .bind(userId)
    .all<{ action: string }>()
  return (rows.results ?? []).map((row) => row.action)
}
