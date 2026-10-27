import { NO_REDIRECT, isRedirectResponse } from '../../lib/no-redirect'

export const D1_API_BASE = 'https://api.cloudflare.com/client/v4'

export const D1_REQUEST_TIMEOUT_MS = 30_000

export interface D1RawResult {
  columns: string[]
  rows: unknown[][]
  rowsAffected?: number
  meta?: Record<string, unknown>
}

export interface D1QueryOptions {
  accountId: string
  apiToken: string
  databaseId: string
  sql: string
  params?: unknown[]
  signal?: AbortSignal
}

export interface D1DatabaseListOptions {
  accountId: string
  apiToken: string
}

export interface D1DatabaseInfo {
  uuid: string
  name: string
}

export class D1ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'D1ApiError'
  }
}

interface D1ApiEnvelope<T> {
  success?: boolean
  result?: T
  errors?: Array<{ message?: string }>
}

interface D1ApiQueryEntry {
  success?: boolean
  results?: Array<Record<string, unknown>>
  meta?: Record<string, unknown>
}

function queryUrl(accountId: string, databaseId: string): string {
  return `${D1_API_BASE}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`
}

function authorizationHeader(apiToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }
}

function firstErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fallback
  const errors = (body as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return fallback
  for (const entry of errors) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const message = (entry as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function normalizeMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    } else if (typeof value === 'bigint') {
      out[key] = value.toString()
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export async function executeD1Query(options: D1QueryOptions): Promise<D1RawResult> {
  const response = await fetch(queryUrl(options.accountId, options.databaseId), {
    method: 'POST',
    headers: authorizationHeader(options.apiToken),
    body: JSON.stringify({ sql: options.sql, params: options.params ?? [] }),
    signal: options.signal,
    redirect: NO_REDIRECT,
  })
  if (isRedirectResponse(response)) throw new D1ApiError(502, 'Cloudflare API responded with a redirect')
  const body = await readBody(response)
  if (!response.ok) {
    throw new D1ApiError(
      response.status,
      firstErrorMessage(body, `Cloudflare API responded with ${response.status}`),
    )
  }
  const envelope = body as D1ApiEnvelope<D1ApiQueryEntry[]> | null
  if (!envelope || envelope.success !== true) {
    throw new D1ApiError(
      response.status,
      firstErrorMessage(body, 'Cloudflare API did not accept the query'),
    )
  }
  const entry = Array.isArray(envelope.result) ? envelope.result[0] : undefined
  if (entry && entry.success === false) {
    throw new D1ApiError(response.status, firstErrorMessage(body, 'Cloudflare API did not accept the query'))
  }
  const sourceRows = Array.isArray(entry?.results) ? entry.results : []
  const columns = sourceRows.length > 0 && sourceRows[0] ? Object.keys(sourceRows[0]) : []
  const rows = sourceRows.map((row) => columns.map((column) => (row[column] === undefined ? null : row[column])))
  const meta = normalizeMeta(entry?.meta)
  const rowsAffected =
    meta && typeof meta.changes === 'number' && Number.isFinite(meta.changes) ? meta.changes : undefined
  return { columns, rows, rowsAffected, meta }
}

export async function listD1Databases(
  options: D1DatabaseListOptions,
  signal: AbortSignal = AbortSignal.timeout(D1_REQUEST_TIMEOUT_MS),
): Promise<D1DatabaseInfo[]> {
  const response = await fetch(
    `${D1_API_BASE}/accounts/${encodeURIComponent(options.accountId)}/d1/database?per_page=100`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        'Content-Type': 'application/json',
      },
      signal,
      redirect: NO_REDIRECT,
    },
  )
  if (isRedirectResponse(response)) throw new D1ApiError(502, 'Cloudflare API responded with a redirect')
  const body = await readBody(response)
  if (!response.ok) {
    throw new D1ApiError(
      response.status,
      firstErrorMessage(body, `Cloudflare API responded with ${response.status}`),
    )
  }
  const envelope = body as D1ApiEnvelope<unknown[]> | null
  if (!envelope || envelope.success !== true) {
    throw new D1ApiError(response.status, firstErrorMessage(body, 'Cloudflare API did not return databases'))
  }
  const databases: D1DatabaseInfo[] = []
  for (const entry of Array.isArray(envelope.result) ? envelope.result : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const uuid = (entry as { uuid?: unknown }).uuid
    const name = (entry as { name?: unknown }).name
    if (typeof uuid === 'string' && uuid && typeof name === 'string') databases.push({ uuid, name })
  }
  return databases
}
