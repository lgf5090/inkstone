// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cfJson,
  makeCloudflareBed,
  readJson,
  seedAccount,
  stubCloudflare,
  TEST_USER,
  type CloudflareTestBed,
} from './cloudflare-fixtures'

const OTHER_USER = 'o'.repeat(26)
const ACCOUNT_A = 'a'.repeat(26)
const ACCOUNT_B = 'b'.repeat(26)

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

interface CfCall {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  headers: Record<string, string>
}

let bed: CloudflareTestBed
let calls: CfCall[]

function stubApi(handler: (call: CfCall) => Response | null | Promise<Response | null>): void {
  calls = []
  stubCloudflare(async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const rawBody = init?.body
    let body: unknown = rawBody
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody) as unknown
      } catch {
        body = rawBody
      }
    }
    const call: CfCall = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace('/client/v4', ''),
      query: url.searchParams,
      body,
      headers,
    }
    calls.push(call)
    const custom = await handler(call)
    if (custom) return custom
    return new Response('unexpected', { status: 404 })
  })
}

async function send(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
  const init: RequestInit = { method, headers: { ...(headers ?? {}) } }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return bed.app.request(`/api/cloudflare/storage${path}`, init, bed.env)
}

async function auditActions(): Promise<string[]> {
  const rows = await bed.env.DB.prepare(
    'SELECT action FROM cloudflare_log WHERE user_id = ? ORDER BY rowid ASC',
  ).bind(TEST_USER).all<{ action: string }>()
  return (rows.results ?? []).map((row) => row.action)
}

async function markDemo(accountId: string): Promise<void> {
  await bed.env.DB.prepare(
    'INSERT INTO cloudflare_setting (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
  ).bind(TEST_USER, 'demo_account_ids', accountId, Date.now()).run()
}

beforeEach(async () => {
  mocks.userId = TEST_USER
  bed = await makeCloudflareBed()
})

afterEach(() => vi.unstubAllGlobals())

describe('KV routes', () => {
  it('lists namespaces, keys with a cursor, and a raw value', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => {
      if (method === 'GET' && path === `/accounts/cf-a/storage/kv/namespaces`) {
        return cfJson([{ id: 'ns-1', title: 'Alpha' }, { id: 'ns-2', title: '' }])
      }
      if (method === 'GET' && path === '/accounts/cf-a/storage/kv/namespaces/ns-1/keys') {
        return Response.json({
          success: true,
          result: [{ name: 'user/one', expiration: 1_800_000_000 }],
          result_info: { cursor: 'next-page' },
        })
      }
      if (method === 'GET' && path === '/accounts/cf-a/storage/kv/namespaces/ns-1/values/user%2Fone') {
        return new Response('stored text')
      }
      return null
    })

    const namespaces = await readJson<{ namespaces: Array<{ id: string; title: string }> }>(
      await send('GET', `/${account.id}/kv`),
    )
    expect(namespaces.namespaces).toEqual([
      { id: 'ns-1', title: 'Alpha' },
      { id: 'ns-2', title: 'ns-2' },
    ])

    const keys = await readJson<{ keys: Array<{ name: string; expiration?: number }>; cursor: string | null }>(
      await send('GET', `/${account.id}/kv/ns-1/keys?prefix=user%2F&cursor=abc&limit=2`),
    )
    expect(keys).toEqual({ keys: [{ name: 'user/one', expiration: 1_800_000_000 }], cursor: 'next-page' })
    const keyCall = calls.find((call) => call.path.endsWith('/keys'))
    expect(keyCall?.query.get('prefix')).toBe('user/')
    expect(keyCall?.query.get('cursor')).toBe('abc')
    expect(keyCall?.query.get('limit')).toBe('2')

    const value = await readJson<{ value: string }>(
      await send('GET', `/${account.id}/kv/ns-1/values/${encodeURIComponent('user/one')}`),
    )
    expect(value.value).toBe('stored text')
  })

  it('writes a value with a TTL and deletes it with an audit row', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => {
      if (method === 'PUT' && path === '/accounts/cf-a/storage/kv/namespaces/ns-1/values/hello') {
        return cfJson({})
      }
      if (method === 'DELETE' && path === '/accounts/cf-a/storage/kv/namespaces/ns-1/values/hello') {
        return cfJson({})
      }
      return null
    })

    const saved = await send('PUT', `/${account.id}/kv/ns-1/values/hello`, {
      value: 'world',
      expiration_ttl: 120,
    })
    expect(saved.status).toBe(200)
    const putCall = calls.find((call) => call.method === 'PUT')
    expect(putCall?.body).toBe('world')
    expect(putCall?.query.get('expiration_ttl')).toBe('120')
    expect(putCall?.headers['Content-Type']).toBe('text/plain; charset=utf-8')

    const deleted = await send('DELETE', `/${account.id}/kv/ns-1/values/hello`)
    expect(deleted.status).toBe(200)
    expect(await auditActions()).toContain('delete_kv_key')
  })

  it('chunks a large KV bulk delete at the API ceiling', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => (
      method === 'DELETE' && path === '/accounts/cf-a/storage/kv/namespaces/ns-1/bulk' ? cfJson({}) : null
    ))
    const keys = Array.from({ length: 1_001 }, (_, index) => `key-${index}`)
    const response = await send('POST', `/${account.id}/kv/ns-1/bulk-delete`, { keys })
    expect(response.status).toBe(200)
    expect(await readJson<{ deleted: number }>(response)).toEqual({ deleted: 1_001 })
    const bulkCalls = calls.filter((call) => call.path.endsWith('/bulk'))
    expect(bulkCalls).toHaveLength(2)
    expect((bulkCalls[0]?.body as string[]).length).toBe(1_000)
    expect((bulkCalls[1]?.body as string[]).length).toBe(1)
  })

  it('answers 404 for another reader’s account and 403 for a demo account', async () => {
    const theirs = await seedAccount(bed, OTHER_USER, { id: ACCOUNT_B, token: 'token-b', accountId: 'cf-b' })
    const mine = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    stubApi(() => cfJson([]))

    const missing = await send('GET', `/${theirs.id}/kv`)
    expect(missing.status).toBe(404)
    expect(calls).toHaveLength(0)

    await markDemo(mine.id)
    const refused = await send('DELETE', `/${mine.id}/kv/ns-1`)
    expect(refused.status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})

describe('D1 routes', () => {
  it('lists databases, counts tables only on request, and reads a table schema', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    let countedSql = ''
    stubApi(({ method, path, body }) => {
      if (method === 'GET' && path === '/accounts/cf-a/d1/database') {
        return cfJson([{ uuid: 'db-1', name: 'main' }])
      }
      if (method === 'POST' && path === '/accounts/cf-a/d1/database/db-1/query') {
        const sql = (body as { sql: string }).sql
        if (sql.includes('sqlite_master')) {
          return cfJson([{ results: [{ name: 'users' }, { name: 'posts' }], meta: { duration: 1 } }])
        }
        if (sql.includes('COUNT(*)')) {
          countedSql = sql
          return cfJson([{ results: [{ users: 2, posts: 5 }], meta: { duration: 1 } }])
        }
        if (sql.startsWith('PRAGMA table_info')) {
          return cfJson([{
            results: [
              { cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
              { cid: 1, name: 'title', type: 'TEXT', notnull: 0, dflt_value: "'x'", pk: 0 },
            ],
            meta: { duration: 1 },
          }])
        }
      }
      return null
    })

    const databases = await readJson<{ databases: Array<{ id: string; name: string }> }>(
      await send('GET', `/${account.id}/d1`),
    )
    expect(databases.databases).toEqual([{ id: 'db-1', name: 'main' }])

    const tables = await readJson<{ tables: Array<{ name: string; rows: number | null }> }>(
      await send('GET', `/${account.id}/d1/db-1/tables`),
    )
    expect(tables.tables).toEqual([{ name: 'users', rows: null }, { name: 'posts', rows: null }])
    // Counting walks every table, so opening a database must not do it.
    expect(countedSql).toBe('')

    const counted = await readJson<{ tables: Array<{ name: string; rows: number | null }> }>(
      await send('GET', `/${account.id}/d1/db-1/tables?counts=1`),
    )
    expect(counted.tables).toEqual([{ name: 'users', rows: 2 }, { name: 'posts', rows: 5 }])
    // A compound `SELECT … UNION ALL` per table is what SQLite rejects on a real database, so the
    // counts must arrive as scalar subqueries in one select list.
    expect(countedSql).toContain('(SELECT COUNT(*) FROM "users") AS "users"')
    expect(countedSql).not.toContain('UNION ALL')

    const schema = await readJson<{ schema: Array<{ name: string; pk: number }> }>(
      await send('GET', `/${account.id}/d1/db-1/tables/users/schema`),
    )
    expect(schema.schema.map((column) => column.name)).toEqual(['id', 'title'])
    expect(schema.schema[0]?.pk).toBe(1)
  })

  it('refuses every write verb without allowWrite and runs it with the switch on', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method }) => (
      method === 'POST'
        ? cfJson([{ results: [{ inserted: 1 }], meta: { duration: 3, rows_written: 1 } }])
        : null
    ))
    const writes = [
      'INSERT INTO notes (id) VALUES (1)',
      'UPDATE notes SET title = 1',
      'DELETE FROM notes',
      'DROP TABLE notes',
      'ALTER TABLE notes ADD COLUMN extra TEXT',
      'CREATE TABLE notes (id INTEGER)',
      'REPLACE INTO notes (id) VALUES (1)',
      'TRUNCATE TABLE notes',
      'select 1; /* hidden */ drop table notes',
    ]
    for (const sql of writes) {
      const response = await send('POST', `/${account.id}/d1/db-1/query`, { sql, allowWrite: false })
      expect(response.status).toBe(403)
      const body = await readJson<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('forbidden')
    }
    expect(calls).toHaveLength(0)

    const allowed = await send('POST', `/${account.id}/d1/db-1/query`, {
      sql: 'INSERT INTO notes (id) VALUES (1)',
      allowWrite: true,
    })
    expect(allowed.status).toBe(200)
    expect(await readJson<{ results: unknown[]; meta: { duration: number; rows_written?: number } }>(allowed)).toEqual({
      results: [{ inserted: 1 }],
      meta: { duration: 3, rows_written: 1 },
    })
    expect(await auditActions()).toContain('d1_write')
  })

  it('refuses a write on a demo account and hides another reader’s database', async () => {
    const mine = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    const theirs = await seedAccount(bed, OTHER_USER, { id: ACCOUNT_B, token: 'token-b', accountId: 'cf-b' })
    stubApi(() => cfJson([{ results: [], meta: { duration: 1 } }]))
    await markDemo(mine.id)

    const demoWrite = await send('POST', `/${mine.id}/d1/db-1/query`, {
      sql: 'DELETE FROM notes',
      allowWrite: true,
    })
    expect(demoWrite.status).toBe(403)
    expect(calls).toHaveLength(0)

    const other = await send('GET', `/${theirs.id}/d1/db-1/tables`)
    expect(other.status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})

  it('reads the row-count batches concurrently and keys them by table', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-c', accountId: 'cf-c' })
    const names = Array.from({ length: 45 }, (_, index) => `t${index}`)
    let inFlight = 0
    let peak = 0
    let seen: string[] = []
    stubApi(async ({ method, path, body }) => {
      if (method !== 'POST' || path !== '/accounts/cf-c/d1/database/db-1/query') return null
      const sql = (body as { sql: string }).sql
      if (sql.includes('sqlite_master')) {
        return cfJson([{ results: names.map((name) => ({ name })), meta: { duration: 1 } }])
      }
      inFlight += 1
      peak = Math.max(peak, inFlight)
      seen = [...seen, sql]
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight -= 1
      const columns = names.filter((name) => sql.includes(`"${name}"`))
      const row: Record<string, number> = {}
      for (const name of columns) row[name] = name.length
      return cfJson([{ results: [row], meta: { duration: 1 } }])
    })

    const response = await send('GET', `/${account.id}/d1/db-1/tables?counts=1`)
    expect(response.status).toBe(200)
    const body = await readJson<{ tables: Array<{ name: string; rows: number | null }> }>(response)
    expect(body.tables).toHaveLength(45)
    expect(body.tables[0]?.rows).toBe(2)
    expect(body.tables[44]?.rows).toBe(3)
    expect(peak).toBe(2)
    expect(seen).toHaveLength(2)
  })

describe('R2 routes', () => {
  it('lists buckets and objects with delimited prefixes and a cursor', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => {
      if (method === 'GET' && path === '/accounts/cf-a/r2/buckets') {
        return cfJson([{ name: 'bucket-a', creation_date: '2026-01-01' }])
      }
      if (method === 'GET' && path === '/accounts/cf-a/r2/buckets/bucket-a/objects') {
        return Response.json({
          success: true,
          result: [{ key: 'docs/a.txt', size: 3, http_metadata: { contentType: 'text/plain' } }],
          result_info: { delimited: ['images/'], cursor: 'more' },
        })
      }
      return null
    })

    const buckets = await readJson<{ buckets: Array<{ name: string }> }>(await send('GET', `/${account.id}/r2`))
    expect(buckets.buckets.map((bucket) => bucket.name)).toEqual(['bucket-a'])

    const objects = await readJson<{
      objects: Array<{ key: string; content_type: string }>
      delimited_prefixes: string[]
      cursor: string | null
    }>(await send('GET', `/${account.id}/r2/bucket-a/objects?prefix=docs%2F&delimiter=%2F&limit=50`))
    expect(objects.objects).toEqual([{
      key: 'docs/a.txt',
      size: 3,
      etag: '',
      last_modified: '',
      content_type: 'text/plain',
    }])
    expect(objects.delimited_prefixes).toEqual(['images/'])
    expect(objects.cursor).toBe('more')
    const listCall = calls.find((call) => call.path.endsWith('/objects'))
    expect(listCall?.query.get('prefix')).toBe('docs/')
    expect(listCall?.query.get('delimiter')).toBe('/')
    expect(listCall?.query.get('per_page')).toBe('50')
  })

  it('rejects traversal, leading slashes and oversized uploads before calling Cloudflare', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    stubApi(() => cfJson({}))

    expect((await send('GET', `/${account.id}/r2/bucket-a/download?key=..%2Fsecret`)).status).toBe(400)
    expect((await send('DELETE', `/${account.id}/r2/bucket-a/objects?key=%2Fabsolute`)).status).toBe(400)
    expect((await send('GET', `/${account.id}/r2/bucket-a/objects?prefix=..%2F`)).status).toBe(400)

    const traversalForm = new FormData()
    traversalForm.append('key', 'docs/../secret.txt')
    traversalForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'secret.txt')
    expect((await send('PUT', `/${account.id}/r2/bucket-a/upload`, traversalForm)).status).toBe(400)

    const largeForm = new FormData()
    largeForm.append('key', 'docs/large.bin')
    largeForm.append('file', new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], {
      type: 'application/octet-stream',
    }), 'large.bin')
    const tooLarge = await send('PUT', `/${account.id}/r2/bucket-a/upload`, largeForm)
    expect(tooLarge.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('uploads bytes with the file content type', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => (
      method === 'PUT' && path === '/accounts/cf-a/r2/buckets/bucket-a/objects/docs%2Fhello.txt'
        ? cfJson({})
        : null
    ))
    const form = new FormData()
    form.append('key', 'docs/hello.txt')
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt')

    const response = await send('PUT', `/${account.id}/r2/bucket-a/upload`, form)
    expect(response.status).toBe(200)
    expect(await readJson<{ uploaded: boolean; key: string; size: number }>(response)).toEqual({
      uploaded: true,
      key: 'docs/hello.txt',
      size: 5,
    })
    const putCall = calls.find((call) => call.method === 'PUT')
    expect(putCall?.headers['Content-Type']).toBe('text/plain')
    expect(putCall?.body).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(putCall?.body as Uint8Array)).toBe('hello')
    expect(await auditActions()).toContain('r2_upload')
  })

  it('streams a download with a filename disposition', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => (
      method === 'GET' && path === '/accounts/cf-a/r2/buckets/bucket-a/objects/docs%2Fa%20b.txt'
        ? new Response('hello', { headers: { 'Content-Type': 'text/plain', 'Content-Length': '5' } })
        : null
    ))

    const response = await send('GET', `/${account.id}/r2/bucket-a/download?key=docs%2Fa%20b.txt`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
    expect(response.headers.get('Content-Type')).toBe('text/plain')
    expect(response.headers.get('Content-Disposition')).toContain('filename="a b.txt"')
    expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''a%20b.txt")
  })

  it('deletes many objects in bounded concurrent batches', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, token: 'token-a', accountId: 'cf-a' })
    let active = 0
    let peak = 0
    stubCloudflare(async (url, init) => {
      const path = url.pathname.replace('/client/v4', '')
      if ((init?.method ?? 'GET') === 'DELETE' && path.startsWith('/accounts/cf-a/r2/buckets/bucket-a/objects/')) {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return cfJson({})
      }
      return new Response('unexpected', { status: 404 })
    })
    const keys = Array.from({ length: 12 }, (_, index) => `docs/${index}.txt`)
    const response = await send('POST', `/${account.id}/r2/bucket-a/bulk-delete`, { keys })
    expect(response.status).toBe(200)
    expect(await readJson<{ deleted: number }>(response)).toEqual({ deleted: 12 })
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1)
    expect(await auditActions()).toContain('bulk_delete_r2_objects')
  })

  it('answers 404 for another reader’s bucket', async () => {
    const theirs = await seedAccount(bed, OTHER_USER, { id: ACCOUNT_B, token: 'token-b', accountId: 'cf-b' })
    stubApi(() => cfJson([]))
    const response = await send('GET', `/${theirs.id}/r2`)
    expect(response.status).toBe(404)
    expect(calls).toHaveLength(0)
  })


})
