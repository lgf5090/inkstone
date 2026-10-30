import { Hono, type Context } from 'hono'
import { AwsClient } from 'aws4fetch'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { encryptCloudDriveCredentials, decryptCloudDriveCredentials } from '../lib/crypto'
import { checkTarget } from '../lib/outbound'
import { requireOwner } from '../middleware/auth'
import { s3RequestUrl, webdavCollectionUrl } from './storage-urls'

export const clouddriveMountRoutes = new Hono<AppBindings>()

clouddriveMountRoutes.use('/storages', requireOwner)
clouddriveMountRoutes.use('/storages/*', requireOwner)
clouddriveMountRoutes.use('/mounts', requireOwner)
clouddriveMountRoutes.use('/mounts/*', requireOwner)

const STORAGE_TYPES = ['s3', 'webdav', 'telegram', 'discord', 'huggingface', 'github', 'onedrive', 'googledrive'] as const
type StorageType = (typeof STORAGE_TYPES)[number]
const WRITABLE_EXTERNAL_TYPES: ReadonlySet<string> = new Set(['s3', 'webdav'])

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
  sign_expires: number | null
  weight: number
  sort_order: number
  enabled: number
  remark: string
  folder_summary: number
  created_at: number
  updated_at: number
}


clouddriveMountRoutes.get('/storages', async (c) => {
  const userId = c.get('userId')
  const rows = await storages(c)
  const usage = await storageUsage(c.env.DB, userId)
  return c.json({ storages: rows.map((row) => toStorageView(row, usage.get(row.id) ?? 0)) })
})

clouddriveMountRoutes.post('/storages', async (c) => {
  const userId = c.get('userId')
  const body = await readJson(c)
  const name = cleanName(body.name)
  const type = storageType(body.type)
  const config = storageConfig(type, body.config)
  const credentials = credentialRecord(body.credentials)
  const now = Date.now()
  const id = newId()
  const secret = Object.keys(credentials).length > 0 ? await encryptCloudDriveCredentials(c.env, id, credentials) : ''
  const existing = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM CloudDrive_storages WHERE user_id = ?1`).bind(userId).first<{ n: number }>()
  const isDefault = body.isDefault === true || (existing?.n ?? 0) === 0
  try {
    const statements = [
      ...(isDefault ? [c.env.DB.prepare(`UPDATE CloudDrive_storages SET is_default = 0 WHERE user_id = ?1`).bind(userId)] : []),
      c.env.DB.prepare(
        `INSERT INTO CloudDrive_storages
           (user_id, id, name, type, config, credentials, status, is_default, api_key_visible, read_quota,
            default_path, last_used_at, last_test_at, last_test_status, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,NULL,NULL,?12,?12)`,
      ).bind(
        userId, id, name, type, JSON.stringify(config), secret,
        body.status === 'disabled' ? 'disabled' : 'enabled',
        isDefault ? 1 : 0, body.apiKeyVisible ? 1 : 0, body.readQuota ? 1 : 0,
        cleanRootPath(body.defaultPath), now,
      ),
    ]
    await c.env.DB.batch(statements)
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
  if (body.type !== undefined && storageType(body.type) !== row.type) {
    throw ApiError.badRequest('A storage configuration cannot change its type')
  }
  const sets: string[] = []
  const values: unknown[] = []
  const put = (sql: string, value: unknown) => { sets.push(sql); values.push(value) }
  if (body.name !== undefined) put('name = ?', cleanName(body.name))
  if (body.status !== undefined) {
    if (body.status !== 'enabled' && body.status !== 'disabled') throw ApiError.badRequest('Storage status must be enabled or disabled')
    put('status = ?', body.status)
  }
  if (body.config !== undefined) put('config = ?', JSON.stringify(storageConfig(row.type as StorageType, body.config)))
  if (body.credentials !== undefined) put('credentials = ?', await mergedCredentials(c, row, body.credentials))
  if (body.apiKeyVisible !== undefined) put('api_key_visible = ?', body.apiKeyVisible ? 1 : 0)
  if (body.readQuota !== undefined) put('read_quota = ?', body.readQuota ? 1 : 0)
  if (body.defaultPath !== undefined) put('default_path = ?', cleanRootPath(body.defaultPath))
  if (body.isDefault !== undefined) put('is_default = ?', body.isDefault ? 1 : 0)
  if (!sets.length) return c.json({ storage: toStorageView(row) })
  values.push(Date.now(), userId, row.id)
  const statements = [
    ...(body.isDefault === true ? [c.env.DB.prepare(`UPDATE CloudDrive_storages SET is_default = 0 WHERE user_id = ?1`).bind(userId)] : []),
    c.env.DB.prepare(`UPDATE CloudDrive_storages SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ? AND id = ?`).bind(...values),
  ]
  await c.env.DB.batch(statements)
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
  const storage = storageId === 'primary' ? null : await storageById(c, storageId)
  if (storageId !== 'primary' && !storage) throw ApiError.badRequest('Storage not found')
  if (storage && storage.status !== 'enabled') throw ApiError.badRequest('The storage is disabled')
  const writableExternal = storage !== null && WRITABLE_EXTERNAL_TYPES.has(storage.type)
  const readOnly = storageId === 'primary'
    ? (body.readOnly ? 1 : 0)
    : writableExternal ? (body.readOnly ? 1 : 0) : 1
  const now = Date.now()
  const id = newId()
  try {
    await c.env.DB.prepare(
      `INSERT INTO CloudDrive_mounts
         (user_id, id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy, weight, sort_order, enabled, remark, folder_summary, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,?11,?12,?13,?14,?14)`,
    ).bind(
      userId, id, storageId, name, mountPath, readOnly,
      clampInt(body.cacheTtl, 0, 86400, 300), body.webProxy ? 1 : 0, webdavPolicy(body.webdavPolicy),
      clampInt(body.sortOrder, -10000, 10000, 0),
      body.enabled === false ? 0 : 1, cleanRemark(body.remark), body.folderSummary ? 1 : 0, now,
    ).run()
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
  const body = await readJson(c)
  if (row.id === 'primary') {
    if (body.mountPath !== undefined && body.mountPath !== '/') throw ApiError.badRequest('The primary mount path cannot change')
    if (body.storageId !== undefined && body.storageId !== 'primary') throw ApiError.badRequest('The primary mount storage cannot change')
    await c.env.DB.prepare(
      `UPDATE CloudDrive_mounts SET name = ?3, read_only = ?4, cache_ttl = ?5, sort_order = ?6, remark = ?7,
              web_proxy = ?8, webdav_policy = ?9, folder_summary = ?10, updated_at = ?11
        WHERE user_id = ?1 AND id = ?2`,
    ).bind(
      userId, row.id,
      body.name === undefined ? row.name : cleanName(body.name),
      body.readOnly === undefined ? row.read_only : (body.readOnly ? 1 : 0),
      body.cacheTtl === undefined ? row.cache_ttl : clampInt(body.cacheTtl, 0, 86400, row.cache_ttl),
      body.sortOrder === undefined ? row.sort_order : clampInt(body.sortOrder, -10000, 10000, row.sort_order),
      body.remark === undefined ? row.remark : cleanRemark(body.remark),
      body.webProxy === undefined ? row.web_proxy : (body.webProxy ? 1 : 0),
      body.webdavPolicy === undefined ? row.webdav_policy : webdavPolicy(body.webdavPolicy),
      body.folderSummary === undefined ? row.folder_summary : (body.folderSummary ? 1 : 0),
      Date.now(),
    ).run()
    return c.json({ mount: toMountView((await mountById(c, row.id))!) })
  }
  const sets: string[] = []
  const values: unknown[] = []
  const put = (sql: string, value: unknown) => { sets.push(sql); values.push(value) }
  if (body.name !== undefined) put('name = ?', cleanName(body.name))
  let nextStorageId = row.storage_id
  if (body.storageId !== undefined) {
    if (typeof body.storageId !== 'string' || !body.storageId) throw ApiError.badRequest('Storage not found')
    const storage = await storageById(c, body.storageId)
    if (!storage) throw ApiError.badRequest('Storage not found')
    if (body.storageId !== row.storage_id) {
      if (storage.status !== 'enabled') throw ApiError.badRequest('The storage is disabled')
      const used = await c.env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM CloudDrive_files WHERE user_id = ?1 AND mount_id = ?2)
              + (SELECT COUNT(*) FROM CloudDrive_file_parts WHERE user_id = ?1 AND mount_id = ?2)
              + (SELECT COUNT(*) FROM CloudDrive_upload_part_objects WHERE mount_id = ?2)
              + (SELECT COUNT(*) FROM CloudDrive_shares WHERE user_id = ?1 AND mount_id = ?2 AND revoked_at IS NULL) AS count`,
      ).bind(userId, row.id).first<{ count: number }>()
      if ((used?.count ?? 0) > 0) throw ApiError.conflict('A mount that holds files, file parts or active shares cannot switch storage')
      nextStorageId = body.storageId
      put('storage_id = ?', nextStorageId)
    }
  }
  if (body.mountPath !== undefined) {
    if (typeof body.mountPath !== 'string' || !/^\/[^/]+$/.test(body.mountPath)) throw ApiError.badRequest('A mount path is one segment, such as /photos')
    if (body.mountPath !== row.mount_path) {
      const shared = await c.env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM CloudDrive_files WHERE user_id = ?1 AND mount_id = ?2)
              + (SELECT COUNT(*) FROM CloudDrive_shares WHERE user_id = ?1 AND mount_id = ?2 AND revoked_at IS NULL) AS n`,
      ).bind(userId, row.id).first<{ n: number }>()
      if ((shared?.n ?? 0) > 0) throw ApiError.conflict('A mount that holds files or active shares cannot change its path')
      put('mount_path = ?', body.mountPath)
    }
  }
  const storageChanged = nextStorageId !== row.storage_id
  if (body.readOnly !== undefined || storageChanged) {
    const storage = await storageById(c, nextStorageId)
    const writableExternal = storage !== null && WRITABLE_EXTERNAL_TYPES.has(storage.type)
    const readOnly = nextStorageId === 'primary'
      ? (body.readOnly === undefined ? 0 : body.readOnly ? 1 : 0)
      : writableExternal
        ? (body.readOnly === undefined ? 0 : body.readOnly ? 1 : 0)
        : 1
    put('read_only = ?', readOnly)
  }
  if (body.cacheTtl !== undefined) put('cache_ttl = ?', clampInt(body.cacheTtl, 0, 86400, 300))
  if (body.sortOrder !== undefined) put('sort_order = ?', clampInt(body.sortOrder, -10000, 10000, 0))
  if (body.enabled !== undefined) put('enabled = ?', body.enabled ? 1 : 0)
  if (body.remark !== undefined) put('remark = ?', cleanRemark(body.remark))
  if (body.folderSummary !== undefined) put('folder_summary = ?', body.folderSummary ? 1 : 0)
  if (body.webProxy !== undefined) put('web_proxy = ?', body.webProxy ? 1 : 0)
  if (body.webdavPolicy !== undefined) put('webdav_policy = ?', webdavPolicy(body.webdavPolicy))
  if (!sets.length) return c.json({ mount: toMountView(row) })
  values.push(Date.now(), userId, row.id)
  try {
    await c.env.DB.prepare(`UPDATE CloudDrive_mounts SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ? AND id = ?`).bind(...values).run()
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw ApiError.conflict('That mount path is already used')
    throw error
  }
  return c.json({ mount: toMountView((await mountById(c, row.id))!) })
})

clouddriveMountRoutes.delete('/mounts/:id', async (c) => {
  const userId = c.get('userId')
  const row = await mountById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Mount not found')
  if (row.id === 'primary' || row.mount_path === '/') throw ApiError.badRequest('The primary mount cannot be removed')
  const used = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM CloudDrive_files WHERE user_id = ?1 AND mount_id = ?2)
       + (SELECT COUNT(*) FROM CloudDrive_file_parts WHERE user_id = ?1 AND mount_id = ?2)
       + (SELECT COUNT(*) FROM CloudDrive_upload_part_objects WHERE mount_id = ?2)
       + (SELECT COUNT(*) FROM CloudDrive_shares WHERE user_id = ?1 AND mount_id = ?2 AND revoked_at IS NULL) AS count`,
  ).bind(userId, row.id).first<{ count: number }>()
  if ((used?.count ?? 0) > 0) throw ApiError.conflict('This mount still holds files, file parts or active shares')
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

const SENSITIVE_CONFIG_KEY = /(token|secret|password|credential|accesskey|private)/i

function toStorageView(row: StorageRow, usedBytes = 0) {
  const config = Object.fromEntries(
    Object.entries(safeObject(row.config)).filter(([key]) => !SENSITIVE_CONFIG_KEY.test(key)),
  )
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config,
    status: row.status,
    isDefault: row.is_default === 1,
    apiKeyVisible: row.api_key_visible === 1,
    readQuota: row.read_quota === 1,
    defaultPath: row.default_path,
    hasCredentials: row.credentials.length > 0,
    usedBytes,
    lastUsedAt: row.last_used_at,
    lastTestAt: row.last_test_at,
    lastTestStatus: row.last_test_status,
    createdAt: row.created_at,
  }
}

async function storageUsage(db: D1Database, userId: string): Promise<Map<string, number>> {
  const usage = new Map<string, number>()
  const [files, pending] = await Promise.all([
    db.prepare(
      `SELECT m.storage_id AS storage_id, COALESCE(SUM(p.size), 0) AS bytes
         FROM CloudDrive_file_parts p
         JOIN CloudDrive_mounts m ON m.user_id = p.user_id AND m.id = p.mount_id
        WHERE p.user_id = ?1
        GROUP BY m.storage_id`,
    ).bind(userId).all<{ storage_id: string; bytes: number }>(),
    db.prepare(
      `SELECT m.storage_id AS storage_id, COALESCE(SUM(u.size), 0) AS bytes
         FROM CloudDrive_upload_part_objects u
         JOIN CloudDrive_mounts m ON m.user_id = ?1 AND m.id = u.mount_id
        GROUP BY m.storage_id`,
    ).bind(userId).all<{ storage_id: string; bytes: number }>(),
  ])
  for (const row of files.results ?? []) usage.set(row.storage_id, (usage.get(row.storage_id) ?? 0) + Number(row.bytes))
  for (const row of pending.results ?? []) usage.set(row.storage_id, (usage.get(row.storage_id) ?? 0) + Number(row.bytes))
  return usage
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
    remark: row.remark,
    folderSummary: row.folder_summary === 1,
    webProxy: row.web_proxy === 1,
    webdavPolicy: row.webdav_policy,
    createdAt: row.created_at,
  }
}

const WEBDAV_QUOTA_PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:quota-used-bytes/><D:quota-available-bytes/></D:prop></D:propfind>`

function webdavQuota(xml: string): { used: number; total: number | null } | null {
  const numberFor = (name: string): number | null => {
    const match = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>(\\d+)</(?:[A-Za-z_][\\w.-]*:)?${name}>`, 'i').exec(xml)
    if (!match) return null
    const value = Number(match[1])
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  const used = numberFor('quota-used-bytes')
  if (used === null) return null
  const available = numberFor('quota-available-bytes')
  return { used, total: available === null ? null : used + available }
}

async function testStorage(c: Context<AppBindings>, row: StorageRow): Promise<{ ok: boolean; message: string; quota?: { used: number; total: number | null } }> {
  const config = safeObject(row.config)
  const stored = await decryptCloudDriveCredentials(c.env, row.id, row.credentials).catch(() => null)
  if (!stored && row.credentials) return { ok: false, message: 'The stored storage credentials could not be read' }
  const credentials: Record<string, string> = Object.fromEntries(Object.entries(stored ?? {}).map(([key, value]) => [key, String(value)]))
  if (row.type === 's3') {
    const endpoint = String(config.endpoint ?? '')
    const target = checkTarget(endpoint)
    if (!target.url) return { ok: false, message: target.error }
    if (!String(config.bucketName ?? '').trim()) return { ok: false, message: 'An S3 bucket name is required' }
    try {
      const aws = new AwsClient({
        accessKeyId: credentials.accessKeyId ?? '',
        secretAccessKey: credentials.secretAccessKey ?? '',
        region: String(config.region ?? 'auto'),
        service: 's3',
        retries: 1,
      })
      const url = s3RequestUrl(target.url, config, null)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('max-keys', '1')
      const response = await aws.fetch(url.toString(), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000) })
      // A test response has no body worth reading once its status is known.
      await discard(response)
      return { ok: response.ok, message: response.ok ? 'S3 is reachable' : `S3 answered HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, message: testFailure(error, 'S3 test failed') }
    }
  }
  if (row.type === 'webdav') {
    const target = checkTarget(String(config.baseUrl ?? ''))
    if (!target.url) return { ok: false, message: target.error }
    const headers: Record<string, string> = { Depth: '0' }
    if (credentials.username || credentials.password) {
      headers.Authorization = `Basic ${btoa(`${credentials.username ?? ''}:${credentials.password ?? ''}`)}`
    }
    const wantsQuota = row.read_quota === 1
    if (wantsQuota) headers['Content-Type'] = 'application/xml; charset=utf-8'
    try {
      const response = await fetch(webdavCollectionUrl(target.url).toString(), {
        method: 'PROPFIND', headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
        ...(wantsQuota ? { body: WEBDAV_QUOTA_PROPFIND } : {}),
      })
      const xml = wantsQuota && response.ok ? await response.text() : ''
      if (!wantsQuota || !response.ok) await discard(response)
      const quota = wantsQuota ? webdavQuota(xml) : null
      const ok = response.status >= 200 && response.status < 300
      return {
        ok,
        message: ok
          ? quota
            ? `WebDAV is reachable · quota ${quota.used} / ${quota.total ?? 'unknown'} bytes`
            : 'WebDAV is reachable'
          : response.status >= 300 && response.status < 400
            ? 'WebDAV answered a redirect; check that the base URL ends with the collection path'
            : `WebDAV answered HTTP ${response.status}`,
        ...(quota ? { quota } : {}),
      }
    } catch (error) {
      return { ok: false, message: testFailure(error, 'WebDAV test failed') }
    }
  }
  const tokenType = row.type as string
  try {
    return await testTokenStorage(tokenType, config, credentials)
  } catch (error) {
    return { ok: false, message: testFailure(error, 'Storage test failed') }
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch (error) {
    console.warn('[inkstone] CloudDrive could not cancel an unused response body', error)
  }
}

function testFailure(error: unknown, fallback: string): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'The storage did not answer within 15 seconds'
  }
  return error instanceof Error ? error.message : fallback
}

function testFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(15_000) })
}

async function testTokenStorage(
  type: string,
  config: Record<string, unknown>,
  credentials: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  if (type === 'telegram') {
    const token = text(credentials.botToken)
    if (!token) return { ok: false, message: 'A Telegram bot token is required' }
    const response = await testFetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`)
    await discard(response)
    return { ok: response.ok, message: response.ok ? 'Telegram is reachable' : `Telegram answered HTTP ${response.status}` }
  }
  if (type === 'discord') {
    const token = text(credentials.botToken)
    const channelId = text(credentials.channelId) || text(config.channelId)
    if (!token) return { ok: false, message: 'A Discord bot token is required' }
    if (!/^\d{5,32}$/.test(channelId)) return { ok: false, message: 'A Discord channel id is required' }
    const response = await testFetch(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${token}`, 'User-Agent': 'inkstone-clouddrive' },
    })
    await discard(response)
    return { ok: response.ok, message: response.ok ? 'Discord is reachable' : `Discord answered HTTP ${response.status}` }
  }
  if (type === 'huggingface') {
    const token = text(credentials.token)
    const response = await testFetch('https://huggingface.co/api/whoami-v2', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    await discard(response)
    return { ok: response.ok, message: response.ok ? 'Hugging Face is reachable' : `Hugging Face answered HTTP ${response.status}` }
  }
  if (type === 'github') {
    const repo = text(config.repo)
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { ok: false, message: 'A GitHub owner/name repository is required' }
    const token = text(credentials.token)
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'inkstone-clouddrive',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await testFetch(`https://api.github.com/repos/${repo}`, { headers })
    await discard(response)
    return { ok: response.ok, message: response.ok ? 'GitHub is reachable' : `GitHub answered HTTP ${response.status}` }
  }
  if (type === 'onedrive') {
    const token = text(credentials.accessToken)
    if (!token) return { ok: false, message: 'A OneDrive access token is required' }
    const response = await testFetch('https://graph.microsoft.com/v1.0/me/drive?$select=id', {
      headers: { Authorization: `Bearer ${token}` },
    })
    await discard(response)
    return { ok: response.ok, message: response.ok ? 'OneDrive is reachable' : `OneDrive answered HTTP ${response.status}` }
  }
  if (type === 'googledrive') {
    const token = text(credentials.accessToken)
    if (!token) return { ok: false, message: 'A Google Drive access token is required' }
    const response = await testFetch('https://www.googleapis.com/drive/v3/about?fields=user', {
      headers: { Authorization: `Bearer ${token}` },
    })
    await discard(response)
    return { ok: response.ok, message: response.ok ? 'Google Drive is reachable' : `Google Drive answered HTTP ${response.status}` }
  }
  return { ok: false, message: 'Unsupported storage type' }
}

function storageType(value: unknown): StorageType {
  if (!STORAGE_TYPES.includes(value as StorageType)) throw ApiError.badRequest('Unsupported storage type')
  return value as StorageType
}

function httpUrl(value: string, label: string): void {
  if (!value) throw ApiError.badRequest(`${label} is required`)
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
  } catch {
    throw ApiError.badRequest(`${label} must be an http(s) URL`)
  }
}

function storageConfig(type: StorageType, value: unknown): Record<string, unknown> {
  const config = objectValue(value)
  if (JSON.stringify(config).length > 16 * 1024) throw ApiError.badRequest('The storage configuration is too large')
  const text = (key: string) => typeof config[key] === 'string' ? config[key].trim() : ''
  if (config.capacityBytes !== undefined && config.capacityBytes !== null) {
    const capacity = Number(config.capacityBytes)
    if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 10 * 1024 ** 4) {
      throw ApiError.badRequest('The storage capacity limit must be a byte count')
    }
    config.capacityBytes = capacity
  }
  if (text('urlProxy')) httpUrl(text('urlProxy'), 'The proxy URL')
  if (text('customHost')) httpUrl(text('customHost'), 'The custom host')
  if (type === 's3') {
    httpUrl(text('endpoint'), 'S3 endpoint')
    if (!text('bucketName')) throw ApiError.badRequest('An S3 bucket name is required')
  } else if (type === 'webdav') {
    httpUrl(text('baseUrl'), 'WebDAV base URL')
  } else if (type === 'github') {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text('repo'))) throw ApiError.badRequest('A GitHub owner/name repository is required')
  } else if (type === 'huggingface') {
    if (!text('repo')) throw ApiError.badRequest('A Hugging Face repository is required')
    if (config.repoType !== undefined && config.repoType !== 'model' && config.repoType !== 'dataset') {
      throw ApiError.badRequest('The Hugging Face repository type must be model or dataset')
    }
  } else if (type === 'discord') {
    if (!/^\d{5,32}$/.test(text('channelId'))) throw ApiError.badRequest('A Discord channel id is required')
  } else if (type === 'telegram') {
    if (!text('chatId')) throw ApiError.badRequest('A Telegram chat id is required')
  }
  return config
}

function cleanRootPath(value: unknown): string {
  const path = typeof value === 'string' ? value.trim().slice(0, 256) : ''
  return path.startsWith('/') ? path : '/'
}

function cleanRemark(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 200) : ''
}

const WEBDAV_POLICIES = ['native_proxy', '302_redirect', 'use_proxy_url'] as const

function webdavPolicy(value: unknown): string {
  if (value === undefined) return 'native_proxy'
  if (typeof value === 'string' && (WEBDAV_POLICIES as readonly string[]).includes(value)) return value
  throw ApiError.badRequest('The WebDAV policy is not supported')
}

async function mergedCredentials(
  c: Context<AppBindings>,
  row: StorageRow,
  value: unknown,
): Promise<string> {
  const provided = credentialRecord(value)
  let existing: Record<string, string | number> = {}
  if (row.credentials) {
    try {
      const stored = await decryptCloudDriveCredentials(c.env, row.id, row.credentials)
      existing = Object.fromEntries(Object.entries(stored ?? {}).map(([key, field]) => [key, field]))
    } catch (error) {
      console.warn('[inkstone] CloudDrive could not read existing storage credentials while editing; they will be replaced', error)
    }
  }
  const merged = { ...existing, ...provided }
  return Object.keys(merged).length > 0 ? await encryptCloudDriveCredentials(c.env, row.id, merged) : ''
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
function credentialRecord(value: unknown): Record<string, string | number> {
  const source = objectValue(value)
  const entries = Object.entries(source)
  if (entries.length > 16) throw ApiError.badRequest('credentials holds at most 16 fields')
  const record: Record<string, string | number> = {}
  for (const [key, field] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)) throw ApiError.badRequest('credentials contains an unsupported field name')
    if (typeof field === 'string') {
      if (field.length > 8192) throw ApiError.badRequest('A credential field is too long')
      if (field.length > 0) record[key] = field
    } else if (typeof field === 'number' && Number.isFinite(field)) {
      record[key] = field
    } else {
      throw ApiError.badRequest('Credential values must be strings or numbers')
    }
  }
  return record
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
