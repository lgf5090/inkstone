// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVELOPMENT_DATABASE_SCHEMA_STATEMENTS } from '../src/worker/development/database/schema'
import { exportKey } from '../src/worker/development/database/r2'
import {
  countSavedQueries,
  findConnection,
  findExport,
  insertExport,
  insertSavedQuery,
} from '../src/worker/development/database/store'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import type { AppBindings, Env } from '../src/worker/env'
import { newId } from '../src/worker/lib/id'
import { errorResponse } from '../src/worker/lib/errors'
import { developmentDatabaseRoutes } from '../src/worker/routes/development-database'
import {
  MAX_EXPORT_BYTES,
  MAX_SAVED_QUERIES,
  MAX_SAVED_SQL_LENGTH,
} from '../src/shared/development/database/types'
import type {
  DatabaseConnectionView,
  QueryHistoryEntry,
  QueryResult,
  SavedQuery,
} from '../src/shared/development/database/types'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace, testR2Bucket } from './doubles/bindings'
import type { TestR2Bucket } from './doubles/bindings'

const USER_A = '0123456789abcdefghjkmnpqrs'
const USER_B = '0123456789abcdefghjkmnpqrt'
const ACCOUNT_ID = 'acct-1'
const DATABASE_ID = 'db-1'
const TOKEN = 'd1-api-token-9876'

interface Envelope<T> {
  ok?: boolean
  data?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

const vaultStorage = new Map<string, unknown>()
let sqlite: DatabaseSync
let db: D1Database
let bucket: TestR2Bucket
let env: Env
let app: Hono<AppBindings>

function vaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) {
        return vaultStorage.get(key)
      },
      async put(key: string, value: unknown) {
        vaultStorage.set(key, value)
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
  } as unknown as DurableObjectState
}

function buildApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('*', async (c, next) => {
    const user = c.req.header('x-test-user')
    if (user) c.set('userId', user)
    await next()
  })
  instance.route('/api/development/database', developmentDatabaseRoutes)
  return instance
}

interface CallOptions {
  user?: string | null
  body?: unknown
  env?: Env
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.user !== null) headers['x-test-user'] = options.user ?? USER_A
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const target = path.startsWith('/api/') ? path : `/api/development/database${path}`
  return await app.fetch(
    new Request(`http://localhost${target}`, { method, headers, body }),
    options.env ?? env,
  )
}

async function bodyOf<T>(response: Response): Promise<Envelope<T>> {
  return JSON.parse(await response.text()) as Envelope<T>
}

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

interface ConnectionBody {
  name: string
  type: 'd1'
  d1AccountId: string
  d1DatabaseId: string
  d1DatabaseName: string
  secret: string
}

function connectionBody(name: string): ConnectionBody {
  return {
    name,
    type: 'd1',
    d1AccountId: ACCOUNT_ID,
    d1DatabaseId: DATABASE_ID,
    d1DatabaseName: 'main',
    secret: TOKEN,
  }
}

async function createConnection(name: string, user = USER_A): Promise<DatabaseConnectionView> {
  const response = await call('POST', '/connections', { user, body: connectionBody(name) })
  expect(response.status).toBe(200)
  const envelope = await bodyOf<DatabaseConnectionView>(response)
  expect(envelope.ok).toBe(true)
  return envelope.data!
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  vaultStorage.clear()
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_DATABASE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  bucket = testR2Bucket()
  env = testBindings(db, {
    CREDENTIAL_VAULT: testDurableObjectNamespace((request) =>
      new CredentialVault(vaultState()).fetch(request),
    ),
    FILES: bucket,
  })
  app = buildApp()
})

afterEach(() => {
  sqlite.close()
  vi.unstubAllGlobals()
})

describe('authentication and isolation', () => {
  it('requires a signed-in user', async () => {
    const response = await call('GET', '/connections', { user: null })
    expect(response.status).toBe(401)
    const envelope = await bodyOf(response)
    expect(envelope.error?.code).toBe('unauthenticated')
  })

  it('never returns the token or ciphertext and keeps connections per user', async () => {
    const created = await createConnection('Primary')
    expect(created.hasSecret).toBe(true)
    expect('secret' in created).toBe(false)
    expect('secretCiphertext' in created).toBe(false)
    expect(JSON.stringify(created)).not.toContain(TOKEN)

    const stored = sqlite
      .prepare('SELECT secret_ciphertext FROM development_database_connections WHERE user_id = ? AND id = ?')
      .get(USER_A, created.id) as { secret_ciphertext: string }
    expect(stored.secret_ciphertext).toMatch(/^v1\./)
    expect(stored.secret_ciphertext).not.toContain(TOKEN)

    const listA = await call('GET', '/connections')
    const listB = await call('GET', '/connections', { user: USER_B })
    expect((await bodyOf<DatabaseConnectionView[]>(listA)).data).toHaveLength(1)
    expect((await bodyOf<DatabaseConnectionView[]>(listB)).data).toHaveLength(0)

    const patch = await call('PATCH', `/connections/${created.id}`, {
      user: USER_B,
      body: { name: 'Stolen' },
    })
    expect(patch.status).toBe(404)
    const remove = await call('DELETE', `/connections/${created.id}`, { user: USER_B })
    expect(remove.status).toBe(404)

    const query = await call('POST', '/query', {
      user: USER_B,
      body: { connectionId: created.id, sql: 'select 1' },
    })
    expect(query.status).toBe(404)

    const saved = await call('POST', '/saved-queries', {
      user: USER_B,
      body: { connectionId: created.id, name: 'Stolen', sql: 'select 1' },
    })
    expect(saved.status).toBe(404)

    const history = await call('GET', `/history?connectionId=${created.id}`, { user: USER_B })
    expect(history.status).toBe(404)
  })

  it('keeps the token across updates with the three-state secret field', async () => {
    const created = await createConnection('Primary')

    const cleared = await call('PATCH', `/connections/${created.id}`, { body: { secret: '' } })
    expect(cleared.status).toBe(200)
    expect((await bodyOf<DatabaseConnectionView>(cleared)).data?.hasSecret).toBe(false)

    const renamed = await call('PATCH', `/connections/${created.id}`, { body: { name: 'Renamed' } })
    expect((await bodyOf<DatabaseConnectionView>(renamed)).data?.hasSecret).toBe(false)

    const replaced = await call('PATCH', `/connections/${created.id}`, {
      body: { secret: 'replacement-token' },
    })
    expect((await bodyOf<DatabaseConnectionView>(replaced)).data?.hasSecret).toBe(true)

    const fetchMock = vi.fn(async () => queryResponse([{ ok: 1 }]))
    vi.stubGlobal('fetch', fetchMock)
    const query = await call('POST', '/query', {
      body: { connectionId: created.id, sql: 'select 1' },
    })
    expect(query.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer replacement-token')

    const blank = await call('POST', '/connections', {
      body: { ...connectionBody('Blank'), secret: '   ' },
    })
    expect(blank.status).toBe(400)
  })

  it('validates connection payloads', async () => {
    const missingSecret = await call('POST', '/connections', {
      body: { name: 'No token', type: 'd1', d1AccountId: ACCOUNT_ID, d1DatabaseId: DATABASE_ID },
    })
    expect(missingSecret.status).toBe(400)

    const badTurso = await call('POST', '/connections', {
      body: { name: 'Turso', type: 'turso', tursoUrl: 'http://127.0.0.1:8080', secret: 'x' },
    })
    expect(badTurso.status).toBe(400)

    const goodTurso = await call('POST', '/connections', {
      body: { name: 'Turso', type: 'turso', tursoUrl: 'libsql://demo.turso.io', secret: 'x' },
    })
    expect(goodTurso.status).toBe(200)
    expect((await bodyOf<DatabaseConnectionView>(goodTurso)).data?.tursoUrl).toBe(
      'libsql://demo.turso.io',
    )
  })
})

describe('connection ordering and flags', () => {
  it('orders pinned then favorite and persists a drag order', async () => {
    const one = await createConnection('One')
    const two = await createConnection('Two')
    const three = await createConnection('Three')

    await call('PATCH', `/connections/${three.id}/flags`, { body: { isPinned: true } })
    await call('PATCH', `/connections/${two.id}/flags`, { body: { isFavorite: true } })

    let list = await bodyOf<DatabaseConnectionView[]>(await call('GET', '/connections'))
    expect(list.data?.map((connection) => connection.id)).toEqual([three.id, two.id, one.id])

    const reorder = await call('PUT', '/connections/order', {
      body: { ids: [two.id, one.id, three.id] },
    })
    expect(reorder.status).toBe(200)

    await call('PATCH', `/connections/${three.id}/flags`, { body: { isPinned: false } })
    list = await bodyOf<DatabaseConnectionView[]>(await call('GET', '/connections'))
    expect(list.data?.map((connection) => connection.id)).toEqual([two.id, one.id, three.id])
    expect(list.data?.map((connection) => connection.sort)).toEqual([0, 1, 2])

    const missing = await call('PUT', '/connections/order', { body: { ids: ['0123456789abcdefghjkmnpqrs'] } })
    expect(missing.status).toBe(400)
    const duplicate = await call('PUT', '/connections/order', { body: { ids: [one.id, one.id] } })
    expect(duplicate.status).toBe(400)
  })

  it('cascades saved queries and history when a connection is deleted', async () => {
    const created = await createConnection('Primary')
    const saved = await call('POST', '/saved-queries', {
      body: { connectionId: created.id, name: 'Query', sql: 'select 1' },
    })
    expect(saved.status).toBe(200)

    vi.stubGlobal('fetch', vi.fn(async () => queryResponse([])))
    const query = await call('POST', '/query', { body: { connectionId: created.id, sql: 'select 1' } })
    expect(query.status).toBe(200)

    const removed = await call('DELETE', `/connections/${created.id}`)
    expect(removed.status).toBe(200)
    expect(await countSavedQueries(db, USER_A)).toBe(0)
    const historyRows = sqlite
      .prepare('SELECT COUNT(*) AS count FROM development_database_query_history WHERE user_id = ?')
      .get(USER_A) as { count: number }
    expect(historyRows.count).toBe(0)
    expect(await findConnection(db, USER_A, created.id)).toBeNull()
  })
})

describe('D1 database discovery', () => {
  it('uses the saved connection and its decrypted token', async () => {
    const created = await createConnection('Primary')
    const fetchMock = vi.fn(async () =>
      jsonResponse({ success: true, result: [{ uuid: DATABASE_ID, name: 'main' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await call('POST', '/d1/databases', { body: { connectionId: created.id } })
    expect(response.status).toBe(200)
    const envelope = await bodyOf<{ databases: Array<{ uuid: string; name: string }> }>(response)
    expect(envelope.data?.databases).toEqual([{ uuid: DATABASE_ID, name: 'main' }])

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database?per_page=100`)
    expect(url).not.toContain(TOKEN)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('accepts an ad hoc account and token and maps upstream failures', async () => {
    const okMock = vi.fn(async () => jsonResponse({ success: true, result: [] }))
    vi.stubGlobal('fetch', okMock)
    const adHoc = await call('POST', '/d1/databases', {
      body: { accountId: 'acct-2', apiToken: 'adhoc-token' },
    })
    expect(adHoc.status).toBe(200)
    const [url, init] = okMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/accounts/acct-2/d1/database')
    expect(url).not.toContain('adhoc-token')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer adhoc-token')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: false, errors: [{ message: 'Authentication error' }] }, 403)),
    )
    const forbidden = await call('POST', '/d1/databases', {
      body: { accountId: 'acct-2', apiToken: 'adhoc-token' },
    })
    expect(forbidden.status).toBe(403)
    expect((await bodyOf(forbidden)).error?.details).toMatchObject({ kind: 'permission' })
  })

  it('refuses another user’s saved connection and a cleared secret', async () => {
    const created = await createConnection('Primary')
    const other = await call('POST', '/d1/databases', {
      user: USER_B,
      body: { connectionId: created.id },
    })
    expect(other.status).toBe(404)

    await call('PATCH', `/connections/${created.id}`, { body: { secret: '' } })
    const cleared = await call('POST', '/d1/databases', { body: { connectionId: created.id } })
    expect(cleared.status).toBe(400)
    expect((await bodyOf(cleared)).error?.message).toContain('no stored credential')
  })
})

describe('connection test', () => {
  it('tests a saved D1 connection with the stored token', async () => {
    const created = await createConnection('Primary')
    const fetchMock = vi.fn(async () => queryResponse([{ '1': 1 }]))
    vi.stubGlobal('fetch', fetchMock)
    const response = await call('POST', '/connections/test', {
      body: { type: 'd1', connectionId: created.id },
    })
    expect(response.status).toBe(200)
    const envelope = await bodyOf<{ ok: boolean; latencyMs: number }>(response)
    expect(envelope.data?.ok).toBe(true)
    expect(envelope.data?.latencyMs).toBeGreaterThanOrEqual(0)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(String(init.body)).toContain('SELECT 1')
  })

  it('tests ad hoc credentials without persisting them', async () => {
    const fetchMock = vi.fn(async () => queryResponse([{ '1': 1 }]))
    vi.stubGlobal('fetch', fetchMock)
    const response = await call('POST', '/connections/test', {
      body: { type: 'd1', d1AccountId: 'acct-2', d1DatabaseId: 'db-2', secret: 'adhoc-secret' },
    })
    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/accounts/acct-2/d1/database/db-2/query')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer adhoc-secret')
  })

  it('rejects mismatched saved types, other users and private hosts', async () => {
    const created = await createConnection('Primary')
    const mismatch = await call('POST', '/connections/test', {
      body: { type: 'turso', connectionId: created.id },
    })
    expect(mismatch.status).toBe(400)
    const other = await call('POST', '/connections/test', {
      user: USER_B,
      body: { type: 'd1', connectionId: created.id },
    })
    expect(other.status).toBe(404)
    const privateHost = await call('POST', '/connections/test', {
      body: { type: 'turso', tursoUrl: 'libsql://127.0.0.1:8080', secret: 'x' },
    })
    expect(privateHost.status).toBe(400)
  })

  it('maps upstream failures to the classified status', async () => {
    const created = await createConnection('Primary')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: false, errors: [{ message: 'Authentication error' }] }, 403)),
    )
    const response = await call('POST', '/connections/test', {
      body: { type: 'd1', connectionId: created.id },
    })
    expect(response.status).toBe(403)
    expect((await bodyOf(response)).error?.details).toMatchObject({ kind: 'permission' })
  })
})

describe('query endpoint', () => {
  it('runs one statement, normalizes blobs and records history', async () => {
    const created = await createConnection('Primary')
    const fetchMock = vi.fn(async () =>
      queryResponse([{ id: 1, blob: [1, 2, 3] }], { changes: 0, rows_read: 1 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await call('POST', '/query', {
      body: { connectionId: created.id, sql: 'select * from t where id = ?', params: [1], recordHistory: true },
    })
    expect(response.status).toBe(200)
    const result = (await bodyOf<QueryResult>(response)).data!
    expect(result.columns).toEqual(['id', 'blob'])
    expect(result.rows[0]![1]).toEqual({ __inkstone_blob__: 'AQID' })
    expect(result.meta).toEqual({ changes: 0, rows_read: 1 })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      sql: 'select * from t where id = ?',
      params: [1],
    })

    const history = await bodyOf<QueryHistoryEntry[]>(
      await call('GET', `/history?connectionId=${created.id}`),
    )
    expect(history.data).toHaveLength(1)
    expect(history.data?.[0]?.error).toBeNull()
  })

  it('does not record history for internal reads without the flag', async () => {
    const created = await createConnection('Primary')
    vi.stubGlobal('fetch', vi.fn(async () => queryResponse([])))
    const response = await call('POST', '/query', {
      body: { connectionId: created.id, sql: 'select * from t' },
    })
    expect(response.status).toBe(200)
    const history = await bodyOf<QueryHistoryEntry[]>(
      await call('GET', `/history?connectionId=${created.id}`),
    )
    expect(history.data).toHaveLength(0)
  })

  it('rejects multiple statements and empty input', async () => {
    const created = await createConnection('Primary')
    for (const sql of ['select 1; select 2', '   ']) {
      const response = await call('POST', '/query', { body: { connectionId: created.id, sql } })
      expect(response.status, sql).toBe(400)
    }
  })

  it('classifies failures, maps statuses and records the error', async () => {
    const created = await createConnection('Primary')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: false, errors: [{ message: 'no such table: users' }] }, 400)),
    )
    const missingTable = await call('POST', '/query', {
      body: { connectionId: created.id, sql: 'select * from users', recordHistory: true },
    })
    expect(missingTable.status).toBe(400)
    const missingBody = await bodyOf(missingTable)
    expect(missingBody.error?.message).toBe('Table does not exist')
    expect(missingBody.error?.details).toMatchObject({ kind: 'no_table' })

    const history = await bodyOf<QueryHistoryEntry[]>(
      await call('GET', `/history?connectionId=${created.id}`),
    )
    expect(history.data?.[0]?.error).toContain('no such table')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: false, errors: [{ message: 'Too many requests' }] }, 429)),
    )
    const limited = await call('POST', '/query', {
      body: { connectionId: created.id, sql: 'select 1' },
    })
    expect(limited.status).toBe(429)
    expect((await bodyOf(limited)).error?.code).toBe('too_many_attempts')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: false, errors: [{ message: 'Authentication error' }] }, 401)),
    )
    const forbidden = await call('POST', '/query', {
      body: { connectionId: created.id, sql: 'select 1' },
    })
    expect(forbidden.status).toBe(403)
    expect((await bodyOf(forbidden)).error?.details).toMatchObject({ kind: 'permission' })
  })

  it('trims history to the configured limit', async () => {
    const created = await createConnection('Primary')
    const settings = await call('PUT', '/settings', { body: { historyLimit: 5 } })
    expect(settings.status).toBe(200)

    vi.stubGlobal('fetch', vi.fn(async () => queryResponse([])))
    for (let index = 1; index <= 7; index++) {
      const response = await call('POST', '/query', {
        body: { connectionId: created.id, sql: `select ${index}`, recordHistory: true },
      })
      expect(response.status).toBe(200)
      await sleep(2)
    }

    const history = await bodyOf<QueryHistoryEntry[]>(
      await call('GET', `/history?connectionId=${created.id}`),
    )
    expect(history.data).toHaveLength(5)
    expect(history.data?.[0]?.query).toBe('select 7')
    expect(history.data?.map((entry) => entry.query)).not.toContain('select 1')
  })
})

describe('batch endpoint', () => {
  it('runs D1 statements sequentially and keeps the result order', async () => {
    const created = await createConnection('Primary')
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const sql = (JSON.parse(String(init.body)) as { sql: string }).sql
      return queryResponse([{ sql }])
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await call('POST', '/query/batch', {
      body: {
        connectionId: created.id,
        statements: [{ sql: 'select 1' }, { sql: 'select 2', params: ['x'] }, { sql: 'select 3' }],
      },
    })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const results = (await bodyOf<{ results: QueryResult[] }>(response)).data!.results
    expect(results.map((result) => result.rows[0]![0])).toEqual(['select 1', 'select 2', 'select 3'])
    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(String(init.body)) as { sql: string; params: unknown[] },
    )
    expect(bodies[1]).toEqual({ sql: 'select 2', params: ['x'] })
  })

  it('caps the batch size and rejects multi-statement entries', async () => {
    const created = await createConnection('Primary')
    const tooMany = await call('POST', '/query/batch', {
      body: {
        connectionId: created.id,
        statements: Array.from({ length: 21 }, () => ({ sql: 'select 1' })),
      },
    })
    expect(tooMany.status).toBe(400)

    const multiple = await call('POST', '/query/batch', {
      body: { connectionId: created.id, statements: [{ sql: 'select 1; select 2' }] },
    })
    expect(multiple.status).toBe(400)
  })
})

describe('saved queries', () => {
  it('defaults the namespace and supports update and delete', async () => {
    const created = await createConnection('Primary')

    const empty = await call('POST', '/saved-queries', {
      body: { connectionId: created.id, name: 'Empty', sql: 'select 1', namespace: '   ' },
    })
    expect(empty.status).toBe(200)
    expect((await bodyOf<SavedQuery>(empty)).data?.namespace).toBe('default')

    const named = await call('POST', '/saved-queries', {
      body: { connectionId: created.id, name: 'Named', sql: 'select 2', namespace: 'reports' },
    })
    const saved = (await bodyOf<SavedQuery>(named)).data!

    const list = await bodyOf<SavedQuery[]>(
      await call('GET', `/saved-queries?connectionId=${created.id}`),
    )
    expect(list.data?.map((query) => query.id)).toContain(saved.id)
    expect(list.data?.map((query) => query.id)).toHaveLength(2)

    const updated = await call('PATCH', `/saved-queries/${saved.id}`, {
      body: { name: 'Renamed', sql: 'select 3', namespace: '' },
    })
    expect(updated.status).toBe(200)
    const patched = (await bodyOf<SavedQuery>(updated)).data!
    expect(patched.name).toBe('Renamed')
    expect(patched.sql).toBe('select 3')
    expect(patched.namespace).toBe('default')

    const removed = await call('DELETE', `/saved-queries/${saved.id}`)
    expect(removed.status).toBe(200)
    expect((await call('DELETE', `/saved-queries/${saved.id}`)).status).toBe(404)

    const other = await call('PATCH', `/saved-queries/${saved.id}`, {
      user: USER_B,
      body: { name: 'Nope' },
    })
    expect(other.status).toBe(404)
  })

  it('enforces the 200 query limit and the SQL size limit', async () => {
    const created = await createConnection('Primary')
    for (let index = 0; index < MAX_SAVED_QUERIES; index++) {
      await insertSavedQuery(db, USER_A, {
        id: newId(),
        connectionId: created.id,
        name: `Query ${index}`,
        sql: 'select 1',
        namespace: 'default',
        createdAt: index,
        updatedAt: index,
      })
    }
    const overLimit = await call('POST', '/saved-queries', {
      body: { connectionId: created.id, name: 'One more', sql: 'select 1' },
    })
    expect(overLimit.status).toBe(400)

    const longSql = await call('POST', '/saved-queries', {
      body: { connectionId: created.id, name: 'Long', sql: 'x'.repeat(MAX_SAVED_SQL_LENGTH + 1) },
    })
    expect(longSql.status).toBe(400)
  })
})

describe('history and settings', () => {
  it('requires a connection id and clears per connection', async () => {
    const created = await createConnection('Primary')
    expect((await call('GET', '/history')).status).toBe(400)

    vi.stubGlobal('fetch', vi.fn(async () => queryResponse([])))
    await call('POST', '/query', { body: { connectionId: created.id, sql: 'select 1' } })

    const cleared = await call('DELETE', `/history?connectionId=${created.id}`)
    expect(cleared.status).toBe(200)
    const history = await bodyOf<QueryHistoryEntry[]>(
      await call('GET', `/history?connectionId=${created.id}`),
    )
    expect(history.data).toEqual([])
  })

  it('reads and writes the history limit within 5-500', async () => {
    const initial = await bodyOf<{ historyLimit: number }>(await call('GET', '/settings'))
    expect(initial.data).toEqual({ historyLimit: 30 })

    const saved = await call('PUT', '/settings', { body: { historyLimit: 5 } })
    expect((await bodyOf<{ historyLimit: number }>(saved)).data).toEqual({ historyLimit: 5 })

    expect((await call('PUT', '/settings', { body: { historyLimit: 4 } })).status).toBe(400)
    expect((await call('PUT', '/settings', { body: { historyLimit: 501 } })).status).toBe(400)
    expect((await bodyOf<{ historyLimit: number }>(await call('GET', '/settings'))).data).toEqual({
      historyLimit: 5,
    })
  })
})

describe('exports', () => {
  it('stores under the documented key, streams with a UTF-8 filename and deletes', async () => {
    const content = 'id,name\n1,alpha\n'
    const response = await call('POST', '/exports', {
      body: { format: 'csv', filename: '数据 (1).csv', content },
    })
    expect(response.status).toBe(200)
    const file = (await bodyOf<{ id: string; size: number; url: string }>(response)).data!
    expect(file.size).toBe(new TextEncoder().encode(content).byteLength)
    expect(file.url).toBe(`/api/development/database/exports/${file.id}`)

    const key = exportKey('csv', USER_A, file.id)
    expect(bucket.objects.has(key)).toBe(true)
    expect(bucket.types.get(key)).toBe('text/csv; charset=utf-8')

    const download = await call('GET', `/exports/${file.id}`)
    expect(download.status).toBe(200)
    expect(await download.text()).toBe(content)
    expect(download.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    const disposition = download.headers.get('content-disposition') ?? ''
    expect(disposition).toContain('filename="__ (1).csv"')
    expect(disposition).toContain("filename*=UTF-8''%E6%95%B0%E6%8D%AE%20%281%29.csv")
    expect(disposition).not.toMatch(/[\r\n]/)

    expect((await call('GET', `/exports/${file.id}`, { user: USER_B })).status).toBe(404)

    const listed = await bodyOf<Array<{ id: string; filename: string }>>(await call('GET', '/exports'))
    expect(listed.data?.map((entry) => entry.id)).toEqual([file.id])
    expect(listed.data?.[0]?.filename).toBe('数据 (1).csv')
    expect((await bodyOf<unknown[]>(await call('GET', '/exports', { user: USER_B }))).data).toEqual([])

    const removed = await call('DELETE', `/exports/${file.id}`)
    expect(removed.status).toBe(200)
    expect(bucket.objects.has(key)).toBe(false)
    expect(await findExport(db, USER_A, file.id)).toBeNull()
    expect((await call('GET', `/exports/${file.id}`)).status).toBe(404)
    expect((await bodyOf<unknown[]>(await call('GET', '/exports'))).data).toEqual([])
  })

  it('cleans expired exports on the next upload', async () => {
    const oldKey = exportKey('txt', USER_A, '0123456789abcdefghjkmnpqrs')
    await bucket.put(oldKey, 'old')
    await insertExport(db, USER_A, {
      id: '0123456789abcdefghjkmnpqrs',
      filename: 'old.txt',
      format: 'txt',
      r2Key: oldKey,
      size: 3,
      createdAt: Date.now() - 25 * 60 * 60 * 1_000,
    })

    const response = await call('POST', '/exports', {
      body: { format: 'txt', filename: 'fresh.txt', content: 'fresh' },
    })
    expect(response.status).toBe(200)
    expect(bucket.objects.has(oldKey)).toBe(false)
    expect(await findExport(db, USER_A, '0123456789abcdefghjkmnpqrs')).toBeNull()
  })

  it('enforces the byte limit and answers 503 without R2', async () => {
    const tooBig = await call('POST', '/exports', {
      body: { format: 'txt', filename: 'big.txt', content: '数'.repeat(3_000_000) },
    })
    expect(tooBig.status).toBe(413)
    expect(new TextEncoder().encode('数'.repeat(3_000_000)).byteLength).toBeGreaterThan(MAX_EXPORT_BYTES)

    const noFiles = testBindings(db)
    const unavailable = await call('POST', '/exports', {
      env: noFiles,
      body: { format: 'txt', filename: 'a.txt', content: 'a' },
    })
    expect(unavailable.status).toBe(503)
    expect((await bodyOf(unavailable)).error?.code).toBe('storage_unavailable')
  })
})
