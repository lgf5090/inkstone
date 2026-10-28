import { classifyDatabaseError, databaseErrorMessage } from '@shared/development/database/errors'
import { MAX_QUERY_BYTES, MAX_QUERY_ROWS, INKSTONE_BLOB_KEY } from '@shared/development/database/types'
import type { DatabaseErrorKind, QueryResult } from '@shared/development/database/types'
import { utf8ByteLength } from '@shared/text-utils'
import type { Env } from '../../env'
import { toBase64 } from '../../lib/encoding'
import { ApiError } from '../../lib/errors'
import { openConnectionSecret } from './credentials'
import { D1ApiError, D1_REQUEST_TIMEOUT_MS, executeD1Query } from './d1'
import type { D1RawResult } from './d1'
import { findConnection } from './store'
import type { ConnectionRecord } from './store'
import { assertTursoUrl, executeTursoBatch, executeTursoQuery } from './turso'
import type { TursoStatementResult } from './turso'

export const QUERY_TIMEOUT_MS = D1_REQUEST_TIMEOUT_MS

export interface QueryTarget {
  connection: ConnectionRecord
  token: string
}

export class QueryTimeoutError extends Error {
  constructor() {
    super('The query timed out')
    this.name = 'QueryTimeoutError'
  }
}

export class QueryFailure extends Error {
  constructor(
    readonly kind: DatabaseErrorKind,
    readonly detail: string,
    readonly statementIndex?: number,
  ) {
    super(databaseErrorMessage(kind))
    this.name = 'QueryFailure'
  }
}

export interface RawQueryResult {
  columns: string[]
  rows: unknown[][]
  rowsAffected?: number
  meta?: Record<string, unknown>
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new QueryTimeoutError())
    }, QUERY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([run(controller.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function sanitizeDetail(message: string, secrets: string[]): string {
  let text = message
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]')
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 500)
}

function errorStatus(error: unknown): number {
  if (error instanceof D1ApiError) return error.status
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : 0
}

function errorStatementIndex(error: unknown): number | undefined {
  const index = (error as { statementIndex?: unknown }).statementIndex
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : undefined
}

export function failureFromError(error: unknown, secrets: string[] = []): QueryFailure {
  if (error instanceof QueryFailure) return error
  if (error instanceof QueryTimeoutError) return new QueryFailure('timeout', 'The query timed out')
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'The query could not be executed'
  const status = errorStatus(error)
  let kind = classifyDatabaseError(message)
  if (kind === 'unknown' && (status === 401 || status === 403)) kind = 'permission'
  if (kind === 'unknown' && status === 429) kind = 'rate_limit'
  return new QueryFailure(kind, sanitizeDetail(message, secrets), errorStatementIndex(error))
}

export function failureToApiError(failure: QueryFailure): ApiError {
  const status = failure.kind === 'rate_limit' ? 429 : failure.kind === 'permission' ? 403 : 400
  const code = status === 429 ? 'too_many_attempts' : status === 403 ? 'forbidden' : 'bad_request'
  const details: Record<string, unknown> = { kind: failure.kind }
  if (failure.detail) details.detail = failure.detail
  if (failure.statementIndex !== undefined) details.statementIndex = failure.statementIndex
  return new ApiError(status, code, failure.message, details)
}

function safeBigInt(value: bigint): number | string {
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value)
  }
  return value.toString()
}

function blobCell(bytes: ArrayBuffer | Uint8Array): Record<string, string> {
  return { [INKSTONE_BLOB_KEY]: toBase64(bytes) }
}

function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'bigint':
      return safeBigInt(value)
    case 'object':
      break
    default:
      return null
  }
  if (value instanceof ArrayBuffer) return blobCell(value)
  if (ArrayBuffer.isView(value)) {
    return blobCell(
      new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)),
    )
  }
  if (Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
    return blobCell(new Uint8Array(value).buffer)
  }
  return null
}

function normalizeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    } else if (typeof value === 'bigint') {
      out[key] = safeBigInt(value)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function normalizeQueryResult(raw: RawQueryResult, startedAt: number): QueryResult {
  const columns = raw.columns.map((column) => String(column))
  const rows: unknown[][] = []
  let truncated = raw.rows.length > MAX_QUERY_ROWS
  let bytes = utf8ByteLength(JSON.stringify(columns))
  for (const row of raw.rows) {
    if (rows.length >= MAX_QUERY_ROWS) {
      truncated = true
      break
    }
    const normalized = columns.map((_, index) => normalizeCell(row[index]))
    const rowBytes = utf8ByteLength(JSON.stringify(normalized)) + 1
    if (bytes + rowBytes > MAX_QUERY_BYTES) {
      truncated = true
      break
    }
    rows.push(normalized)
    bytes += rowBytes
  }
  const meta = normalizeMeta(raw.meta)
  const result: QueryResult = {
    columns,
    rows,
    durationMs: Math.max(0, Date.now() - startedAt),
  }
  if (raw.rowsAffected !== undefined) result.rowsAffected = raw.rowsAffected
  if (meta) result.meta = meta
  if (truncated) result.truncated = true
  while (rows.length > 0 && utf8ByteLength(JSON.stringify(result)) > MAX_QUERY_BYTES) {
    rows.pop()
    result.truncated = true
  }
  return result
}

export async function resolveQueryTarget(
  env: Env,
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<QueryTarget> {
  const connection = await findConnection(db, userId, connectionId)
  if (!connection) throw ApiError.notFound('Database connection not found')
  const token = await openConnectionSecret(env, connection.id, connection.secretCiphertext)
  if (connection.type === 'd1') {
    if (!connection.d1AccountId || !connection.d1DatabaseId) {
      throw ApiError.badRequest('The D1 connection is missing its account or database id')
    }
  } else {
    if (!connection.tursoUrl) throw ApiError.badRequest('The Turso connection is missing its URL')
    try {
      assertTursoUrl(connection.tursoUrl)
    } catch (error) {
      throw ApiError.badRequest(error instanceof Error ? error.message : 'The Turso URL is not valid')
    }
  }
  return { connection, token }
}

function targetSecrets(target: QueryTarget): string[] {
  return [target.token, target.connection.tursoUrl, target.connection.secretCiphertext]
}

async function runOnTarget(
  target: QueryTarget,
  sql: string,
  params: unknown[],
  signal: AbortSignal,
): Promise<D1RawResult | TursoStatementResult> {
  if (target.connection.type === 'd1') {
    return await executeD1Query({
      accountId: target.connection.d1AccountId,
      apiToken: target.token,
      databaseId: target.connection.d1DatabaseId,
      sql,
      params,
      signal,
    })
  }
  return await executeTursoQuery({
    url: target.connection.tursoUrl,
    token: target.token,
    sql,
    params,
    signal,
  })
}

export async function executeQuery(
  env: Env,
  db: D1Database,
  userId: string,
  connectionId: string,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult> {
  const target = await resolveQueryTarget(env, db, userId, connectionId)
  const startedAt = Date.now()
  try {
    const raw = await withTimeout((signal) => runOnTarget(target, sql, params, signal))
    return normalizeQueryResult(raw, startedAt)
  } catch (error) {
    throw failureFromError(error, targetSecrets(target))
  }
}

export async function executeBatch(
  env: Env,
  db: D1Database,
  userId: string,
  connectionId: string,
  statements: Array<{ sql: string; params?: unknown[] }>,
): Promise<QueryResult[]> {
  const target = await resolveQueryTarget(env, db, userId, connectionId)
  const secrets = targetSecrets(target)
  if (target.connection.type === 'd1') {
    const results: QueryResult[] = []
    for (const [index, statement] of statements.entries()) {
      const startedAt = Date.now()
      try {
        const raw = await withTimeout((signal) =>
          runOnTarget(target, statement.sql, statement.params ?? [], signal),
        )
        results.push(normalizeQueryResult(raw as D1RawResult, startedAt))
      } catch (error) {
        const failure = failureFromError(error, secrets)
        throw failure.statementIndex === undefined
          ? new QueryFailure(failure.kind, failure.detail, index)
          : failure
      }
    }
    return results
  }
  const startedAt = Date.now()
  try {
    const raw = await withTimeout((signal) =>
      executeTursoBatch({
        url: target.connection.tursoUrl,
        token: target.token,
        statements,
        signal,
      }),
    )
    return raw.map((result) => normalizeQueryResult(result, startedAt))
  } catch (error) {
    throw failureFromError(error, secrets)
  }
}
