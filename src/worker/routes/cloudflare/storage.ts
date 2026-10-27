/**
 * `/api/cloudflare/storage` — KV, D1 and R2 for one of the reader's own accounts.
 *
 * Every route starts at `requireAccount`, which reads the row by `user_id` and `id` and therefore
 * answers 404 for another reader's account. Mutations also pass `assertNotDemo` here, even though the
 * screen hides those controls, and the D1 query route repeats the write check on the server instead of
 * trusting the editor's switch.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { clampInt, readFormDataWithinLimit, readJson } from '../../lib/request'
import {
  accountHasFeature,
  assertNotDemo,
  loadAccount,
  type CloudflareAccountRow,
} from '../../cloudflare/accounts'
import { createAuditLog } from '../../cloudflare/audit'
import type { CloudflareAuth } from '../../cloudflare/cf-api'
import {
  bulkDeleteKvKeys,
  createKvNamespace,
  deleteKvKey,
  deleteKvNamespace,
  getKvValue,
  listKvKeys,
  listKvNamespaces,
  putKvValue,
  type KvKeyListOptions,
} from '../../cloudflare/storage-kv'
import {
  createD1Database,
  deleteD1Database,
  getD1TableSchema,
  listD1Databases,
  listD1Tables,
  runD1Query,
} from '../../cloudflare/storage-d1'
import {
  assertValidBucketName,
  assertValidR2Key,
  bulkDeleteR2Objects,
  createR2Bucket,
  deleteR2Bucket,
  deleteR2Object,
  fetchR2Object,
  listR2Buckets,
  listR2Objects,
  R2_UPLOAD_MAX_BYTES,
  uploadR2Object,
} from '../../cloudflare/storage-r2'
import { isWriteSql } from '../../../shared/cloudflare/sql-utils'

export const storageRouter = new Hono<AppBindings>()

type AppContext = Context<AppBindings>

interface StorageAccount {
  row: CloudflareAccountRow
  auth: CloudflareAuth
  cfAccountId: string
}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/
const NAMESPACE_ID = /^[A-Za-z0-9_-]{1,64}$/
const DATABASE_ID = /^[A-Za-z0-9-]{1,64}$/
const KV_BULK_MAX_KEYS = 10_000
const R2_BULK_MAX_KEYS = 1_000
const SQL_MAX_BYTES = 1_000_000

function pathId(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw ApiError.badRequest(`Invalid ${label}`)
  return value
}

function readName(body: Record<string, unknown>, field: string, label: string, max = 64): string {
  const value = body[field]
  if (typeof value !== 'string') throw ApiError.badRequest(`${label} is required`)
  const name = value.trim()
  if (!name) throw ApiError.badRequest(`${label} is required`)
  if (name.length > max) throw ApiError.badRequest(`${label} is too long`)
  return name
}

function readKeys(body: Record<string, unknown>, max: number): string[] {
  const value = body.keys
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest('keys must be a non-empty array')
  }
  if (value.length > max) throw ApiError.badRequest(`At most ${max} keys may be sent at once`)
  return value.map((item) => {
    if (typeof item !== 'string' || !item) throw ApiError.badRequest('Every key must be a non-empty string')
    return item
  })
}

function optionalSeconds(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw ApiError.badRequest(`${field} must be an integer of at least ${minimum}`)
  }
  return parsed
}

async function requireAccount(c: AppContext, accountId: string): Promise<StorageAccount> {
  const userId = c.get('userId')
  pathId(accountId, ACCOUNT_ID, 'account id')
  const { row, auth } = await loadAccount(c.env, userId, accountId)
  if (!accountHasFeature(row, 'storage')) {
    throw ApiError.badRequest('That account does not have the storage feature enabled')
  }
  if (!row.cf_account_id) throw ApiError.badRequest('That account has no Cloudflare account id yet')
  return { row, auth, cfAccountId: row.cf_account_id }
}

async function requireR2Account(c: AppContext, accountId: string): Promise<StorageAccount> {
  const account = await requireAccount(c, accountId)
  const features = (account.row.available_features || '').split(',').map((item) => item.trim())
  if (features.includes('-r2')) throw ApiError.forbidden('R2 is not enabled for this account')
  return account
}

function audit(
  c: AppContext,
  accountId: string,
  action: string,
  target: string | null,
  detail: string | null,
): Promise<void> {
  return createAuditLog(c.env, c.get('userId'), accountId, action, target, detail, 'success')
}

// ---------------------------------------------------------------------------------------------
// KV
// ---------------------------------------------------------------------------------------------

storageRouter.get('/:accountId/kv', async (c) => {
  const { auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  return c.json({ namespaces: await listKvNamespaces(auth, cfAccountId) })
})

storageRouter.post('/:accountId/kv', async (c) => {
  const { row, auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const body = await readJson<Record<string, unknown>>(c)
  const title = readName(body, 'title', 'Namespace title')
  await assertNotDemo(c.env, c.get('userId'), row.id)
  return c.json(await createKvNamespace(auth, cfAccountId, title), 201)
})

storageRouter.delete('/:accountId/kv/:nsId', async (c) => {
  const { row, auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const nsId = pathId(c.req.param('nsId'), NAMESPACE_ID, 'namespace id')
  await assertNotDemo(c.env, c.get('userId'), row.id)
  await deleteKvNamespace(auth, cfAccountId, nsId)
  await audit(c, row.id, 'delete_kv_namespace', nsId, 'namespace deleted')
  return c.json({ deleted: true })
})

storageRouter.get('/:accountId/kv/:nsId/keys', async (c) => {
  const { auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const nsId = pathId(c.req.param('nsId'), NAMESPACE_ID, 'namespace id')
  const prefix = c.req.query('prefix') ?? ''
  if (prefix.length > 512) throw ApiError.badRequest('A KV prefix may be at most 512 characters')
  const options: KvKeyListOptions = {
    ...(prefix ? { prefix } : {}),
    ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
    limit: clampInt(c.req.query('limit'), 1, 1_000, 100),
  }
  return c.json(await listKvKeys(auth, cfAccountId, nsId, options))
})

storageRouter.get('/:accountId/kv/:nsId/values/:key', async (c) => {
  const { auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const nsId = pathId(c.req.param('nsId'), NAMESPACE_ID, 'namespace id')
  return c.json({ value: await getKvValue(auth, cfAccountId, nsId, c.req.param('key')) })
})

storageRouter.put('/:accountId/kv/:nsId/values/:key', async (c) => {
  const { row, auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const nsId = pathId(c.req.param('nsId'), NAMESPACE_ID, 'namespace id')
  const body = await readJson<Record<string, unknown>>(c, 26 * 1024 * 1024)
  if (typeof body.value !== 'string') throw ApiError.badRequest('A string value is required')
  const expiration = optionalSeconds(body.expiration, 'expiration', 1)
  const expirationTtl = optionalSeconds(body.expiration_ttl, 'expiration_ttl', 60)
  await assertNotDemo(c.env, c.get('userId'), row.id)
  await putKvValue(auth, cfAccountId, nsId, c.req.param('key'), body.value, {
    ...(expiration !== undefined ? { expiration } : {}),
    ...(expirationTtl !== undefined ? { expirationTtl } : {}),
  })
  return c.json({ saved: true })
})

storageRouter.delete('/:accountId/kv/:nsId/values/:key', async (c) => {
  const { row, auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const nsId = pathId(c.req.param('nsId'), NAMESPACE_ID, 'namespace id')
  const key = c.req.param('key')
  await assertNotDemo(c.env, c.get('userId'), row.id)
  await deleteKvKey(auth, cfAccountId, nsId, key)
  await audit(c, row.id, 'delete_kv_key', `${nsId}/${key}`, 'key deleted')
  return c.json({ deleted: true })
})

storageRouter.post('/:accountId/kv/:nsId/bulk-delete', async (c) => {
  const { row, auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const nsId = pathId(c.req.param('nsId'), NAMESPACE_ID, 'namespace id')
  const body = await readJson<Record<string, unknown>>(c)
  const keys = readKeys(body, KV_BULK_MAX_KEYS)
  await assertNotDemo(c.env, c.get('userId'), row.id)
  const deleted = await bulkDeleteKvKeys(auth, cfAccountId, nsId, keys)
  await audit(c, row.id, 'bulk_delete_kv_keys', nsId, `${deleted} keys`)
  return c.json({ deleted })
})

// ---------------------------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------------------------

storageRouter.get('/:accountId/d1', async (c) => {
  const { auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  return c.json({ databases: await listD1Databases(auth, cfAccountId) })
})

storageRouter.post('/:accountId/d1', async (c) => {
  const { row, auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const body = await readJson<Record<string, unknown>>(c)
  const name = readName(body, 'name', 'Database name')
  await assertNotDemo(c.env, c.get('userId'), row.id)
  return c.json(await createD1Database(auth, cfAccountId, name), 201)
})

storageRouter.delete('/:accountId/d1/:dbId', async (c) => {
  const { row, auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const dbId = pathId(c.req.param('dbId'), DATABASE_ID, 'database id')
  await assertNotDemo(c.env, c.get('userId'), row.id)
  await deleteD1Database(auth, cfAccountId, dbId)
  await audit(c, row.id, 'delete_d1_database', dbId, 'database deleted')
  return c.json({ deleted: true })
})

storageRouter.get('/:accountId/d1/:dbId/tables', async (c) => {
  const { auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const dbId = pathId(c.req.param('dbId'), DATABASE_ID, 'database id')
  return c.json({ tables: await listD1Tables(auth, cfAccountId, dbId) })
})

storageRouter.get('/:accountId/d1/:dbId/tables/:tableName/schema', async (c) => {
  const { auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const dbId = pathId(c.req.param('dbId'), DATABASE_ID, 'database id')
  const tableName = c.req.param('tableName')
  return c.json({ schema: await getD1TableSchema(auth, cfAccountId, dbId, tableName) })
})

storageRouter.post('/:accountId/d1/:dbId/query', async (c) => {
  const { row, auth, cfAccountId } = await requireAccount(c, c.req.param('accountId'))
  const dbId = pathId(c.req.param('dbId'), DATABASE_ID, 'database id')
  const body = await readJson<Record<string, unknown>>(c, SQL_MAX_BYTES + 64 * 1024)
  if (typeof body.sql !== 'string' || !body.sql.trim()) throw ApiError.badRequest('SQL is required')
  if (body.sql.length > SQL_MAX_BYTES) throw ApiError.tooLarge('The SQL statement is too large')
  const allowWrite = body.allowWrite === true
  const writes = isWriteSql(body.sql)
  if (writes && !allowWrite) {
    throw ApiError.forbidden('Write statements need the allow-write switch')
  }
  if (writes) await assertNotDemo(c.env, c.get('userId'), row.id)
  const result = await runD1Query(auth, cfAccountId, dbId, body.sql)
  if (writes) {
    await audit(c, row.id, 'd1_write', dbId, body.sql.slice(0, 300))
  }
  return c.json(result)
})

// ---------------------------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------------------------

storageRouter.get('/:accountId/r2', async (c) => {
  const { auth, cfAccountId } = await requireR2Account(c, c.req.param('accountId'))
  return c.json({ buckets: await listR2Buckets(auth, cfAccountId) })
})

storageRouter.post('/:accountId/r2', async (c) => {
  const { row, auth, cfAccountId } = await requireR2Account(c, c.req.param('accountId'))
  const body = await readJson<Record<string, unknown>>(c)
  const name = readName(body, 'name', 'Bucket name', 63)
  assertValidBucketName(name)
  await assertNotDemo(c.env, c.get('userId'), row.id)
  return c.json(await createR2Bucket(auth, cfAccountId, name), 201)
})

storageRouter.delete('/:accountId/r2/:bucket', async (c) => {
  const { row, auth, cfAccountId } = await requireR2Account(c, c.req.param('accountId'))
  const bucket = c.req.param('bucket')
  assertValidBucketName(bucket)
  await assertNotDemo(c.env, c.get('userId'), row.id)
  await deleteR2Bucket(auth, cfAccountId, bucket)
  await audit(c, row.id, 'delete_r2_bucket', bucket, 'bucket deleted')
  return c.json({ deleted: true })
})

storageRouter.get('/:accountId/r2/:bucket/objects', async (c) => {
  const { auth, cfAccountId } = await requireR2Account(c, c.req.param('accountId'))
  const bucket = c.req.param('bucket')
  const prefix = c.req.query('prefix') ?? ''
  if (prefix) assertValidR2Key(prefix, 'prefix')
  const delimiter = c.req.query('delimiter') ?? '/'
  const cursor = c.req.query('cursor') ?? ''
  if (cursor.length > 4_096) throw ApiError.badRequest('Invalid cursor')
  return c.json(await listR2Objects(auth, cfAccountId, bucket, {
    ...(prefix ? { prefix } : {}),
    delimiter,
    ...(cursor ? { cursor } : {}),
    limit: clampInt(c.req.query('limit'), 1, 1_000, 100),
  }))
})

storageRouter.get('/:accountId/r2/:bucket/download', async (c) => {
  const { auth, cfAccountId } = await requireR2Account(c, c.req.param('accountId'))
  const bucket = c.req.param('bucket')
  const key = c.req.query('key') ?? ''
  assertValidR2Key(key)
  const upstream = await fetchR2Object(auth, cfAccountId, bucket, key)
  const filename = key.split('/').pop() || 'download'
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_') || 'download'
  const headers = new Headers()
  headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'application/octet-stream')
  headers.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
  headers.set('Cache-Control', 'private, no-store')
  const length = upstream.headers.get('Content-Length')
  if (length) headers.set('Content-Length', length)
  return new Response(upstream.body, { status: 200, headers })
})

storageRouter.put('/:accountId/r2/:bucket/upload', async (c) => {
  const { row, auth, cfAccountId } = await requireR2Account(c, c.req.param('accountId'))
  const bucket = c.req.param('bucket')
  assertValidBucketName(bucket)
  await assertNotDemo(c.env, c.get('userId'), row.id)
  const form = await readFormDataWithinLimit(c.req, R2_UPLOAD_MAX_BYTES + 1024 * 1024)
  const keyValue = form.get('key')
  const file = form.get('file')
  if (typeof keyValue !== 'string' || !keyValue) throw ApiError.badRequest('A key is required')
  if (!(file instanceof File)) throw ApiError.badRequest('A file is required')
  assertValidR2Key(keyValue)
  if (file.size > R2_UPLOAD_MAX_BYTES) {
    throw ApiError.tooLarge(`An R2 object may be at most ${R2_UPLOAD_MAX_BYTES / (1024 * 1024)} MB`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  await uploadR2Object(auth, cfAccountId, bucket, keyValue, bytes, file.type)
  await audit(c, row.id, 'r2_upload', `${bucket}/${keyValue}`, `${bytes.byteLength} bytes`)
  return c.json({ uploaded: true, key: keyValue, size: bytes.byteLength })
})

storageRouter.delete('/:accountId/r2/:bucket/objects', async (c) => {
  const { row, auth, cfAccountId } = await requireR2Account(c, c.req.param('accountId'))
  const bucket = c.req.param('bucket')
  const key = c.req.query('key') ?? ''
  assertValidR2Key(key)
  await assertNotDemo(c.env, c.get('userId'), row.id)
  await deleteR2Object(auth, cfAccountId, bucket, key)
  await audit(c, row.id, 'delete_r2_object', `${bucket}/${key}`, 'object deleted')
  return c.json({ deleted: true })
})

storageRouter.post('/:accountId/r2/:bucket/bulk-delete', async (c) => {
  const { row, auth, cfAccountId } = await requireR2Account(c, c.req.param('accountId'))
  const bucket = c.req.param('bucket')
  const body = await readJson<Record<string, unknown>>(c)
  const keys = readKeys(body, R2_BULK_MAX_KEYS)
  assertValidBucketName(bucket)
  await assertNotDemo(c.env, c.get('userId'), row.id)
  const deleted = await bulkDeleteR2Objects(auth, cfAccountId, bucket, keys)
  await audit(c, row.id, 'bulk_delete_r2_objects', bucket, `${deleted} objects`)
  return c.json({ deleted })
})
