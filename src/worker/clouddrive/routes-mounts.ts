import { Hono, type Context } from 'hono'
import { AwsClient } from 'aws4fetch'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { encryptSecret, decryptSecret } from '../lib/crypto'
import { checkTarget } from '../lib/outbound'
import { requireOwner } from '../middleware/auth'

export const clouddriveMountRoutes = new Hono<AppBindings>()

clouddriveMountRoutes.use('*', requireOwner)

const STORAGE_TYPES = ['s3', 'webdav'] as const
type StorageType = (typeof STORAGE_TYPES)[number]

interface StorageRow {
  id: string
  name: string
  type: string
  config: string
  credentials: string
  status: string
  is_default: number
  api_key_visible: number
  read_quota: number
  default_path: string
  last_used_at: number | null
  last_test_at: number | null
  last_test_status: string | null
  created_at: number
  updated_at: number
}

interface MountRow {
  id: string
  storage_id: string
  name: string
  mount_path: string
  read_only: number
  cache_ttl: number
  web_proxy: number
  webdav_policy: string
  weight: number
  sort_order: number
  enabled: number
  created_at: number
  updated_at: number
}


clouddriveMountRoutes.get('/storages', async (c) => {
  const rows = await storages(c)
  return c.json({ storages: rows.map(toStorageView) })
})

clouddriveMountRoutes.post('/storages', async (c) => {
  const userId = c.get('userId')
  const body = await readJson(c)
  const name = cleanName(body.name)
  const type = storageType(body.type)
  const config = objectValue(body.config)
  const credentials = objectValue(body.credentials)
  const now = Date.now()
  const id = newId()
  const secret = await encryptSecret(c.env, `clouddrive:${id}`, credentials)
  try {
    await c.env.DB.prepare(
      `INSERT INTO CloudDrive_storages
         (user_id, id, name, type, config, credentials, status, is_default, api_key_visible, read_quota,
          default_path, last_used_at, last_test_at, last_test_status, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,'enabled',?7,?8,?9,?10,NULL,NULL,NULL,?11,?11)`,
    ).bind(
      userId, id, name, type, JSON.stringify(config), secret,
      body.isDefault ? 1 : 0, body.apiKeyVisible ? 1 : 0, body.readQuota ? 1 : 0,
      typeof body.defaultPath === 'string' && body.defaultPath.startsWith('/') ? body.defaultPath : '/', now,
    ).run()
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw ApiError.conflict('A storage with this name already exists')
    throw error
  }
  const row = await storageById(c, id)
  return c.json({ storage: toStorageView(row!) })
})

clouddriveMountRoutes.patch('/storages/:id', async (c) => {
  const userId = c.get('userId')
  const row = await storageById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Storage not found')
  const body = await readJson(c)
  const sets: string[] = []
  const values: unknown[] = []
  const put = (sql: string, value: unknown) => { sets.push(sql); values.push(value) }
  if (body.name !== undefined) put('name = ?', cleanName(body.name))
  if (body.status !== undefined) put('status = ?', body.status === 'disabled' ? 'disabled' : 'enabled')
  if (body.config !== undefined) put('config = ?', JSON.stringify(objectValue(body.config)))
  if (body.credentials !== undefined) put('credentials = ?', await encryptSecret(c.env, `clouddrive:${row.id}`, objectValue(body.credentials)))
  if (body.isDefault !== undefined) put('is_default = ?', body.isDefault ? 1 : 0)
  if (body.apiKeyVisible !== undefined) put('api_key_visible = ?', body.apiKeyVisible ? 1 : 0)
  if (body.readQuota !== undefined) put('read_quota = ?', body.readQuota ? 1 : 0)
  if (body.defaultPath !== undefined) put('default_path = ?', typeof body.defaultPath === 'string' && body.defaultPath.startsWith('/') ? body.defaultPath : '/')
  if (!sets.length) return c.json({ storage: toStorageView(row) })
  values.push(Date.now(), userId, row.id)
  await c.env.DB.prepare(`UPDATE CloudDrive_storages SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ? AND id = ?`).bind(...values).run()
  return c.json({ storage: toStorageView((await storageById(c, row.id))!) })
})

clouddriveMountRoutes.post('/storages/:id/default', async (c) => {
  const userId = c.get('userId')
  const row = await storageById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Storage not found')
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE CloudDrive_storages SET is_default = 0 WHERE user_id = ?1`).bind(userId),
    c.env.DB.prepare(`UPDATE CloudDrive_storages SET is_default = 1, updated_at = ?3 WHERE user_id = ?1 AND id = ?2`).bind(userId, row.id, Date.now()),
  ])
  return c.json({ ok: true })
})

clouddriveMountRoutes.delete('/storages/:id', async (c) => {
  const userId = c.get('userId')
  const row = await storageById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Storage not found')
  const used = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM CloudDrive_mounts WHERE user_id = ?1 AND storage_id = ?2`).bind(userId, row.id).first<{ n: number }>()
  if ((used?.n ?? 0) > 0) throw ApiError.conflict('Remove the mounts that use this storage first')
  await c.env.DB.prepare(`DELETE FROM CloudDrive_storages WHERE user_id = ?1 AND id = ?2`).bind(userId, row.id).run()
  return c.json({ ok: true })
})

clouddriveMountRoutes.post('/storages/:id/test', async (c) => {
  const row = await storageById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Storage not found')
  const result = await testStorage(c, row)
  await c.env.DB.prepare(`UPDATE CloudDrive_storages SET last_test_at = ?3, last_test_status = ?4 WHERE user_id = ?1 AND id = ?2`)
    .bind(c.get('userId'), row.id, Date.now(), result.ok ? 'ok' : 'failed').run()
  return c.json(result, result.ok ? 200 : 502)
})

clouddriveMountRoutes.get('/mounts', async (c) => {
  const rows = await mounts(c)
  return c.json({ mounts: rows.map(toMountView) })
})

clouddriveMountRoutes.post('/mounts', async (c) => {
  const userId = c.get('userId')
  const body = await readJson(c)
  const name = cleanName(body.name)
  const mountPath = typeof body.mountPath === 'string' ? body.mountPath : ''
  if (!/^\/[^/]+$/.test(mountPath)) throw ApiError.badRequest('A mount path is one segment, such as /photos')
  const storageId = typeof body.storageId === 'string' ? body.storageId : 'primary'
  if (storageId !== 'primary' && !(await storageById(c, storageId))) throw ApiError.badRequest('Storage not found')
  const now = Date.now()
  const id = newId()
  try {
    await c.env.DB.prepare(
      `INSERT INTO CloudDrive_mounts
         (user_id, id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy, weight, sort_order, enabled, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,0,'native_proxy',1,?8,?9,?10,?10)`,
    ).bind(userId, id, storageId, name, mountPath, body.readOnly ? 1 : 0, clampInt(body.cacheTtl, 0, 86400, 300), clampInt(body.sortOrder, -10000, 10000, 0), body.enabled === false ? 0 : 1, now).run()
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw ApiError.conflict('That mount path is already used')
    throw error
  }
  return c.json({ mount: toMountView((await mountById(c, id))!) })
})

clouddriveMountRoutes.patch('/mounts/:id', async (c) => {
  const userId = c.get('userId')
  const row = await mountById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Mount not found')
  if (row.id === 'primary') {
    const body = await readJson(c)
    await c.env.DB.prepare(`UPDATE CloudDrive_mounts SET name = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, row.id, cleanName(body.name ?? row.name), Date.now()).run()
    return c.json({ mount: toMountView((await mountById(c, row.id))!) })
  }
  const body = await readJson(c)
  const sets: string[] = []
  const values: unknown[] = []
  const put = (sql: string, value: unknown) => { sets.push(sql); values.push(value) }
  if (body.name !== undefined) put('name = ?', cleanName(body.name))
  if (body.readOnly !== undefined) put('read_only = ?', body.readOnly ? 1 : 0)
  if (body.cacheTtl !== undefined) put('cache_ttl = ?', clampInt(body.cacheTtl, 0, 86400, 300))
  if (body.sortOrder !== undefined) put('sort_order = ?', clampInt(body.sortOrder, -10000, 10000, 0))
  if (body.enabled !== undefined) put('enabled = ?', body.enabled ? 1 : 0)
  if (!sets.length) return c.json({ mount: toMountView(row) })
  values.push(Date.now(), userId, row.id)
  await c.env.DB.prepare(`UPDATE CloudDrive_mounts SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ? AND id = ?`).bind(...values).run()
  return c.json({ mount: toMountView((await mountById(c, row.id))!) })
})

clouddriveMountRoutes.delete('/mounts/:id', async (c) => {
  const userId = c.get('userId')
  const row = await mountById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Mount not found')
  if (row.id === 'primary' || row.mount_path === '/') throw ApiError.badRequest('The primary mount cannot be removed')
  await c.env.DB.prepare(`DELETE FROM CloudDrive_mounts WHERE user_id = ?1 AND id = ?2`).bind(userId, row.id).run()
  return c.json({ ok: true })
})

clouddriveMountRoutes.post('/mounts/:id/test', async (c) => {
  const row = await mountById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Mount not found')
  if (row.id === 'primary') {
    if (!c.env.FILES) return c.json({ ok: false, message: 'R2 is not bound' }, 502)
    await c.env.FILES.list({ limit: 1 })
    return c.json({ ok: true, message: 'R2 is reachable' })
  }
  const storage = await storageById(c, row.storage_id)
  if (!storage) throw ApiError.notFound('Storage not found')
  const result = await testStorage(c, storage)
  return c.json(result, result.ok ? 200 : 502)
})

async function storages(c: Context<AppBindings>): Promise<StorageRow[]> {
  const { results } = await c.env.DB.prepare(`SELECT * FROM CloudDrive_storages WHERE user_id = ?1 ORDER BY is_default DESC, created_at`).bind(c.get('userId')).all<StorageRow>()
  return results ?? []
}
async function storageById(c: Context<AppBindings>, id: string): Promise<StorageRow | null> {
  return await c.env.DB.prepare(`SELECT * FROM CloudDrive_storages WHERE user_id = ?1 AND id = ?2`).bind(c.get('userId'), id).first<StorageRow>()
}
async function mounts(c: Context<AppBindings>): Promise<MountRow[]> {
  const { results } = await c.env.DB.prepare(`SELECT * FROM CloudDrive_mounts WHERE user_id = ?1 ORDER BY sort_order, created_at`).bind(c.get('userId')).all<MountRow>()
  return results ?? []
}
async function mountById(c: Context<AppBindings>, id: string): Promise<MountRow | null> {
  return await c.env.DB.prepare(`SELECT * FROM CloudDrive_mounts WHERE user_id = ?1 AND id = ?2`).bind(c.get('userId'), id).first<MountRow>()
}

function toStorageView(row: StorageRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: safeObject(row.config),
    status: row.status,
    isDefault: row.is_default === 1,
    apiKeyVisible: row.api_key_visible === 1,
    readQuota: row.read_quota === 1,
    defaultPath: row.default_path,
    hasCredentials: row.credentials.length > 0,
    lastUsedAt: row.last_used_at,
    lastTestAt: row.last_test_at,
    lastTestStatus: row.last_test_status,
    createdAt: row.created_at,
  }
}

function toMountView(row: MountRow) {
  return {
    id: row.id,
    storageId: row.storage_id,
    name: row.name,
    mountPath: row.mount_path,
    readOnly: row.read_only === 1,
    cacheTtl: row.cache_ttl,
    sortOrder: row.sort_order,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  }
}

async function testStorage(c: Context<AppBindings>, row: StorageRow): Promise<{ ok: boolean; message: string; quota?: { used: number; total: number | null } }> {
  const config = safeObject(row.config)
  const credentials = await decryptSecret<Record<string, string>>(c.env, `clouddrive:${row.id}`, row.credentials).catch(() => null) ?? {}
  if (row.type === 's3') {
    const endpoint = String(config.endpoint ?? '')
    const target = checkTarget(endpoint)
    if (!target.url) return { ok: false, message: target.error }
    try {
      const aws = new AwsClient({
        accessKeyId: credentials.accessKeyId ?? '',
        secretAccessKey: credentials.secretAccessKey ?? '',
        region: String(config.region ?? 'auto'),
        service: 's3',
        retries: 1,
      })
      const bucket = String(config.bucketName ?? '')
      const url = new URL(`${target.url.origin.replace(/\/$/, '')}${config.pathStyle ? `/${bucket}` : `/${bucket}`}`)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('max-keys', '1')
      const response = await aws.fetch(url.toString(), { method: 'GET', redirect: 'manual' })
      // A test response has no body worth reading once its status is known.
      await response.body?.cancel().catch(() => {})
      return { ok: response.ok, message: response.ok ? 'S3 is reachable' : `S3 answered HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'S3 test failed' }
    }
  }
  if (row.type === 'webdav') {
    const target = checkTarget(String(config.baseUrl ?? ''))
    if (!target.url) return { ok: false, message: target.error }
    const headers: Record<string, string> = { Depth: '0' }
    if (credentials.username || credentials.password) {
      headers.Authorization = `Basic ${btoa(`${credentials.username ?? ''}:${credentials.password ?? ''}`)}`
    }
    try {
      const response = await fetch(target.url.toString(), { method: 'PROPFIND', headers, redirect: 'manual' })
      // A test response has no body worth reading once its status is known.
      await response.body?.cancel().catch(() => {})
      return { ok: response.status < 500 && response.status !== 401, message: `WebDAV answered HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'WebDAV test failed' }
    }
  }
  return { ok: false, message: 'Unsupported storage type' }
}

function storageType(value: unknown): StorageType {
  if (!STORAGE_TYPES.includes(value as StorageType)) throw ApiError.badRequest('Unsupported storage type')
  return value as StorageType
}
function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().slice(0, 64) : ''
  if (!name) throw ApiError.badRequest('A name is required')
  return name
}
function safeObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback
}
async function readJson(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw ApiError.badRequest('A JSON object is required')
  return body as Record<string, unknown>
}
