// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVELOPMENT_DATABASE_SCHEMA_STATEMENTS } from '../src/worker/development/database/schema'
import {
  D1ApiError,
  executeD1Query,
  listD1Databases,
} from '../src/worker/development/database/d1'
import {
  executeBatch,
  executeQuery,
  failureFromError,
  failureToApiError,
  normalizeQueryResult,
  QueryFailure,
} from '../src/worker/development/database/query'
import {
  assertTursoUrl,
  executeTursoBatch,
  executeTursoQuery,
} from '../src/worker/development/database/turso'
import { insertConnection } from '../src/worker/development/database/store'
import { INKSTONE_BLOB_KEY, MAX_QUERY_BYTES, MAX_QUERY_ROWS } from '../src/shared/development/database/types'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const libsql = vi.hoisted(() => ({ createClient: vi.fn() }))

vi.mock('@libsql/client/web', () => ({ createClient: libsql.createClient }))

const USER = 'user-a'
const CONNECTION_ID = '0123456789abcdefghjkmnpqrs'
const ACCOUNT_ID = 'acct-1'
const DATABASE_ID = 'db-1'
const TOKEN = 'd1-token-secret'

let sqlite: DatabaseSync
let db: D1Database
let env: Env

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function queryResponse(
  results: unknown[],
  meta: Record<string, unknown> = {},
  status = 200,
): Response {
  return jsonResponse({ success: true, result: [{ success: true, results, meta }] }, status)
}

function vaultBindings(): DurableObjectNamespace {
  return testDurableObjectNamespace(async (request) => {
    if (new URL(request.url).pathname === '/decrypt') {
      return Response.json({ value: { token: TOKEN } })
    }
    return Response.json({ ciphertext: 'v1.fake' })
  })
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_DATABASE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  await insertConnection(db, USER, {
    id: CONNECTION_ID,
    name: 'Test D1',
    type: 'd1',
    d1AccountId: ACCOUNT_ID,
    d1DatabaseId: DATABASE_ID,
    d1DatabaseName: 'main',
    secretCiphertext: 'v1.ciphertext',
    createdAt: 1,
    updatedAt: 1,
  })
  env = testBindings(db, { CREDENTIAL_VAULT: vaultBindings() })
  libsql.createClient.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('D1 execution', () => {
  it('calls the fixed Cloudflare endpoint with the token only in the Authorization header', async () => {
    const fetchMock = vi.fn(async () => queryResponse([{ id: 1, name: 'alpha' }], { changes: 0 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeD1Query({
      accountId: 'acct/1',
      apiToken: TOKEN,
      databaseId: DATABASE_ID,
      sql: 'select id, name from users where id = ?',
      params: [7],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct%2F1/d1/database/db-1/query',
    )
    expect(url).not.toContain(TOKEN)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(String(init.body))).toEqual({
      sql: 'select id, name from users where id = ?',
      params: [7],
    })
    expect(result.columns).toEqual(['id', 'name'])
    expect(result.rows).toEqual([[1, 'alpha']])
    expect(result.rowsAffected).toBe(0)
  })

  it('derives columns from the first row and returns an empty column list for empty results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => queryResponse([])))
    const empty = await executeD1Query({
      accountId: ACCOUNT_ID,
      apiToken: TOKEN,
      databaseId: DATABASE_ID,
      sql: 'select 1',
    })
    expect(empty.columns).toEqual([])
    expect(empty.rows).toEqual([])

    vi.stubGlobal('fetch', vi.fn(async () => queryResponse([{ b: 2, a: 1 }, { a: 3, b: 4 }])))
    const ordered = await executeD1Query({
      accountId: ACCOUNT_ID,
      apiToken: TOKEN,
      databaseId: DATABASE_ID,
      sql: 'select a, b from t',
    })
    expect(ordered.columns).toEqual(['b', 'a'])
    expect(ordered.rows).toEqual([[2, 1], [4, 3]])
  })

  it('turns API failures into errors that carry the upstream status and message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ success: false, errors: [{ message: 'no such table: users' }] }, 400),
      ),
    )
    await expect(
      executeD1Query({
        accountId: ACCOUNT_ID,
        apiToken: TOKEN,
        databaseId: DATABASE_ID,
        sql: 'select * from users',
      }),
    ).rejects.toMatchObject({ name: 'D1ApiError', status: 400, message: 'no such table: users' })
  })

  it('lists databases through the fixed host and keeps only usable entries', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        result: [
          { uuid: 'u1', name: 'first' },
          { uuid: 2, name: 'ignored' },
          { uuid: 'u2', name: 'second' },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const databases = await listD1Databases({ accountId: ACCOUNT_ID, apiToken: TOKEN })
    expect(databases).toEqual([
      { uuid: 'u1', name: 'first' },
      { uuid: 'u2', name: 'second' },
    ])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database?per_page=100',
    )
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(url).not.toContain(TOKEN)
  })

  it('maps upstream 403 and 429 to permission and rate-limit statuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: false, errors: [{ message: 'Authentication error' }] }, 403)),
    )
    const forbidden = await failureFromError(
      await executeD1Query({
        accountId: ACCOUNT_ID,
        apiToken: TOKEN,
        databaseId: DATABASE_ID,
        sql: 'select 1',
      }).catch((error: unknown) => error),
    )
    expect(forbidden.kind).toBe('permission')
    expect(failureToApiError(forbidden).status).toBe(403)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: false, errors: [{ message: 'Too many requests' }] }, 429)),
    )
    const limited = await failureFromError(
      await executeD1Query({
        accountId: ACCOUNT_ID,
        apiToken: TOKEN,
        databaseId: DATABASE_ID,
        sql: 'select 1',
      }).catch((error: unknown) => error),
    )
    expect(limited.kind).toBe('rate_limit')
    expect(failureToApiError(limited).status).toBe(429)
  })
})

describe('result normalization', () => {
  it('encodes blobs, converts bigints and keeps safe meta', () => {
    const result = normalizeQueryResult(
      {
        columns: ['id', 'blob', 'big'],
        rows: [
          [1, new Uint8Array([1, 2, 3]).buffer, 123n],
          [2, new Uint8Array([255]).buffer, 2n ** 60n],
        ],
        rowsAffected: 2,
        meta: { changes: 2, rows_read: 10, nested: { ignored: true } },
      },
      Date.now(),
    )
    expect(result.rows[0]![1]).toEqual({ [INKSTONE_BLOB_KEY]: 'AQID' })
    expect(result.rows[0]![2]).toBe(123)
    expect(result.rows[1]![1]).toEqual({ [INKSTONE_BLOB_KEY]: '/w==' })
    expect(result.rows[1]![2]).toBe('1152921504606846976')
    expect(result.rowsAffected).toBe(2)
    expect(result.meta).toEqual({ changes: 2, rows_read: 10 })
    expect(result.truncated).toBeUndefined()
  })

  it('caps rows at 2000 and marks the result truncated', () => {
    const rows = Array.from({ length: MAX_QUERY_ROWS + 5 }, (_, index) => [index])
    const result = normalizeQueryResult({ columns: ['n'], rows }, Date.now())
    expect(result.rows).toHaveLength(MAX_QUERY_ROWS)
    expect(result.truncated).toBe(true)
  })

  it('caps the serialized response at 8 MB', () => {
    const chunk = 'x'.repeat(1024 * 1024)
    const rows = Array.from({ length: 12 }, (_, index) => [chunk, index])
    const result = normalizeQueryResult({ columns: ['payload', 'n'], rows }, Date.now())
    expect(result.rows.length).toBeGreaterThan(0)
    expect(result.rows.length).toBeLessThan(rows.length)
    expect(result.truncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      MAX_QUERY_BYTES,
    )
  })

  it('redacts secrets and truncates error detail', () => {
    const failure = failureFromError(new Error(`bad ${TOKEN} ${'y'.repeat(600)}`), [TOKEN])
    expect(failure.detail).not.toContain(TOKEN)
    expect(failure.detail).toContain('[redacted]')
    expect(failure.detail.length).toBeLessThanOrEqual(500)
    const apiError = failureToApiError(failure)
    expect(apiError.status).toBe(400)
    expect(apiError.details).toEqual({ kind: 'unknown', detail: failure.detail })
  })
})

describe('query execution', () => {
  it('executes against the stored D1 connection and normalizes the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => queryResponse([{ id: 1, blob: [1, 2, 3] }], { changes: 0, rows_read: 1 })),
    )
    const result = await executeQuery(env, db, USER, CONNECTION_ID, 'select * from t')
    expect(result.columns).toEqual(['id', 'blob'])
    expect(result.rows[0]![1]).toEqual({ [INKSTONE_BLOB_KEY]: 'AQID' })
    expect(result.meta).toEqual({ changes: 0, rows_read: 1 })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('maps upstream errors and redacts the connection token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ success: false, errors: [{ message: `no such table ${TOKEN}` }] }, 400),
      ),
    )
    const error = await executeQuery(env, db, USER, CONNECTION_ID, 'select * from missing').catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(QueryFailure)
    expect((error as QueryFailure).kind).toBe('no_table')
    expect((error as QueryFailure).detail).not.toContain(TOKEN)
  })

  it('times out after 30 seconds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const pending = executeQuery(env, db, USER, CONNECTION_ID, 'select 1').catch(
      (caught: unknown) => caught,
    )
    await vi.advanceTimersByTimeAsync(30_000)
    const error = await pending
    expect(error).toBeInstanceOf(QueryFailure)
    expect((error as QueryFailure).kind).toBe('timeout')
    expect(failureToApiError(error as QueryFailure).status).toBe(400)
  })

  it('rejects a connection owned by another user', async () => {
    const error = await executeQuery(env, db, 'user-b', CONNECTION_ID, 'select 1').catch(
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ status: 404, code: 'not_found' })
  })

  it('runs D1 batches sequentially in order', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const sql = (JSON.parse(String(init.body)) as { sql: string }).sql
      return queryResponse([{ sql }], { changes: 1 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const results = await executeBatch(env, db, USER, CONNECTION_ID, [
      { sql: 'insert into t values (1)' },
      { sql: 'insert into t values (2)' },
      { sql: 'insert into t values (3)' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const calls = fetchMock.mock.calls.map(
      ([, init]) => (JSON.parse(String(init.body)) as { sql: string }).sql,
    )
    expect(calls).toEqual([
      'insert into t values (1)',
      'insert into t values (2)',
      'insert into t values (3)',
    ])
    expect(results.map((result) => result.rows[0]![0])).toEqual([
      'insert into t values (1)',
      'insert into t values (2)',
      'insert into t values (3)',
    ])
  })

  it('reports the failing statement index in a D1 batch', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        return call === 2
          ? jsonResponse({ success: false, errors: [{ message: 'no such table: x' }] }, 400)
          : queryResponse([])
      }),
    )
    const error = await executeBatch(env, db, USER, CONNECTION_ID, [
      { sql: 'select 1' },
      { sql: 'select * from x' },
    ]).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(QueryFailure)
    expect((error as QueryFailure).statementIndex).toBe(1)
    expect(failureToApiError(error as QueryFailure).details).toMatchObject({
      kind: 'no_table',
      statementIndex: 1,
    })
  })
})

describe('Turso', () => {
  it('accepts libsql and https URLs and refuses everything else', () => {
    expect(assertTursoUrl('libsql://demo.turso.io')).toContain('libsql://demo.turso.io')
    expect(assertTursoUrl('https://demo.turso.io')).toBe('https://demo.turso.io/')
    for (const url of [
      'http://demo.turso.io',
      'file:///etc/passwd',
      'ws://demo.turso.io',
      'libsql://127.0.0.1',
      'libsql://user:pass@demo.turso.io',
      'libsql://metadata.google.internal',
      'libsql://db.internal',
      'not a url',
    ]) {
      expect(() => assertTursoUrl(url), url).toThrow()
    }
    expect(() => assertTursoUrl('libsql://127.0.0.1')).toThrow(/publicly reachable database host/)
    expect(() => assertTursoUrl('libsql://127.0.0.1')).not.toThrow(/AI provider/)
  })

  it('creates one client, executes with args and always closes it', async () => {
    const close = vi.fn()
    const execute = vi.fn(async () => ({
      columns: ['id', 'blob', 'big'],
      rows: [[1, new Uint8Array([9, 8]).buffer, 2n ** 60n]],
      rowsAffected: 1,
    }))
    libsql.createClient.mockReturnValue({ execute, batch: vi.fn(), close })

    const result = await executeTursoQuery({
      url: 'libsql://demo.turso.io',
      token: 'turso-token',
      sql: 'select * from t where id = ?',
      params: [1],
    })

    expect(libsql.createClient).toHaveBeenCalledWith({
      url: 'libsql://demo.turso.io',
      authToken: 'turso-token',
    })
    expect(execute).toHaveBeenCalledWith({
      sql: 'select * from t where id = ?',
      args: [1],
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(result.columns).toEqual(['id', 'blob', 'big'])
    expect(result.rows[0]![0]).toBe(1)
    expect(result.rows[0]![2]).toBe(2n ** 60n)
    expect(result.rowsAffected).toBe(1)

    const normalized = normalizeQueryResult(result, Date.now())
    expect(normalized.rows[0]![1]).toEqual({ [INKSTONE_BLOB_KEY]: 'CQg=' })
    expect(normalized.rows[0]![2]).toBe('1152921504606846976')
  })

  it('runs a batch in write mode', async () => {
    const close = vi.fn()
    const batch = vi.fn(async () => [
      { columns: ['a'], rows: [[1]], rowsAffected: 1 },
      { columns: ['a'], rows: [[2]], rowsAffected: 1 },
    ])
    libsql.createClient.mockReturnValue({ execute: vi.fn(), batch, close })

    const results = await executeTursoBatch({
      url: 'libsql://demo.turso.io',
      token: 'turso-token',
      statements: [{ sql: 'insert into t values (1)' }, { sql: 'insert into t values (?)', params: [2] }],
    })

    expect(batch).toHaveBeenCalledTimes(1)
    const [statements, mode] = batch.mock.calls[0] as unknown as [unknown[], string]
    expect(mode).toBe('write')
    expect(statements).toEqual([
      { sql: 'insert into t values (1)', args: [] },
      { sql: 'insert into t values (?)', args: [2] },
    ])
    expect(close).toHaveBeenCalledTimes(1)
    expect(results.map((result) => result.rows[0]![0])).toEqual([1, 2])
  })
})
