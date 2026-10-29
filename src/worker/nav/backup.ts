import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { decryptNavSecret, encryptNavSecret } from '../lib/crypto'
import { NavBackupSchema, type NavBackupSettings } from '@shared/nav/validation'
import { NAV_LIMITS, type NavBackup } from '@shared/nav/model'
import type { WebdavConfig } from '@shared/types'
import { parseBackupEndpoint } from '../backup/validation'
import { authHeader, baseUrl, childUrl, ensureDirs, webdavFetch, webdavTest } from '../backup/webdav'
import { friendlyError, readResponseBytesWithinLimit } from '../backup/common'
import { NavStore } from './store'

export const navBackupRoutes = new Hono<AppBindings>()
navBackupRoutes.use('*', requireAuth)

function userId(c: Context<AppBindings>): string {
  const id = c.get('userId') ?? c.get('user')?.id
  if (!id) throw ApiError.unauthenticated()
  return id
}

async function buildBackup(nav: NavStore): Promise<NavBackup> {
  const [categories, links, visits, settings] = await Promise.all([
    nav.categories(),
    nav.links(),
    nav.visits(),
    nav.settings(),
  ])
  return {
    format: 'inkstone-nav-backup',
    version: 1,
    createdAt: Date.now(),
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      icon: category.icon,
      parentId: category.parentId,
      sortOrder: category.sortOrder,
      createdAt: category.createdAt,
      hasPassword: category.hasPassword,
      passwordMode: category.passwordMode,
    })),
    links: links.map((link) => ({
      id: link.id,
      title: link.title,
      url: link.url,
      icon: link.icon,
      description: link.description,
      categoryId: link.categoryId,
      pinned: link.pinned,
      pinnedOrder: link.pinnedOrder,
      sortOrder: link.sortOrder,
      createdAt: link.createdAt,
    })),
    visits,
    settings,
  }
}

async function applyBackupSettings(nav: NavStore, settings: NavBackupSettings | undefined): Promise<void> {
  if (settings?.display) await nav.saveSettingsGroup('display', settings.display)
  if (settings?.search) await nav.saveSettingsGroup('search', settings.search)
  if (settings?.ai) await nav.saveSettingsGroup('ai', settings.ai)
}

interface RequestConfig {
  url?: string
  username?: string
  password?: string
  timestamped?: boolean
}

async function resolveConfig(c: Context<AppBindings>, raw: RequestConfig | null): Promise<{ config: WebdavConfig; password: string }> {
  const nav = new NavStore(c.env.DB, userId(c))
  const stored = await nav.webdavConfig()
  const url = (raw?.url ?? stored.url).trim()
  const username = (raw?.username ?? stored.username).trim()
  if (!url || !username) throw ApiError.badRequest('WebDAV url and username are required')
  let config: WebdavConfig
  try {
    const parsed = parseBackupEndpoint(url, 'WebDAV URL')
    config = { url: parsed.toString(), username, prefix: '', mode: 'archive' }
  } catch (error) {
    throw ApiError.badRequest(error instanceof Error ? error.message : 'Invalid WebDAV URL')
  }
  const storedSecret = await nav.webdavSecret()
  const password = raw?.password?.trim()
    || (storedSecret ? await decryptNavSecret(c.env, userId(c), storedSecret) : null)
    || ''
  if (!password) throw new ApiError(401, 'wrong_password', 'A WebDAV password is required')
  return { config, password }
}

async function verifyFile(base: URL, auth: string, filename: string, signal?: AbortSignal): Promise<boolean> {
  const response = await webdavFetch(childUrl(base, filename), {
    method: 'PROPFIND',
    headers: { Authorization: auth, Depth: '0' },
    signal,
  }, base.origin)
  await response.body?.cancel().catch(() => null)
  return response.status === 207 || response.ok
}

navBackupRoutes.post('/webdav/test', async (c) => {
  const raw = await c.req.json().catch(() => null) as RequestConfig | null
  try {
    const { config, password } = await resolveConfig(c, raw)
    const result = await webdavTest(config, { password }, AbortSignal.timeout(15000))
    return c.json({ ok: result.ok, error: result.ok ? undefined : result.message })
  } catch (error) {
    if (error instanceof ApiError) throw error
    return c.json({ ok: false, error: error instanceof Error ? error.message : 'WebDAV test failed' })
  }
})

navBackupRoutes.post('/webdav/backup', async (c) => {
  const raw = await c.req.json().catch(() => null) as RequestConfig | null
  try {
  const { config, password } = await resolveConfig(c, raw)
  const nav = new NavStore(c.env.DB, userId(c))
  const backup = await buildBackup(nav)
  const now = new Date()
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const filename = raw?.timestamped ? `inkstone-nav-backup_${stamp}.json` : 'inkstone-nav-backup.json'
  const base = baseUrl(config)
  const auth = authHeader(config, { password })
  const signal = AbortSignal.timeout(20000)
  await ensureDirs(base, auth, [], new Set(), signal)
  const payload = new TextEncoder().encode(JSON.stringify(backup))
  const response = await webdavFetch(childUrl(base, filename), {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Overwrite: 'T' },
    body: payload as unknown as BodyInit,
    signal,
  }, base.origin)
  await response.body?.cancel().catch(() => null)
  if (!response.ok) throw new ApiError(502, 'nav_webdav_failed', `WebDAV upload failed: HTTP ${response.status}`)
  const verified = await verifyFile(base, auth, filename, signal)
  return c.json({ ok: true, filename, verified })
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, 'nav_webdav_failed', friendlyError(error))
  }
})

navBackupRoutes.post('/webdav/restore', async (c) => {
  const raw = await c.req.json().catch(() => null) as RequestConfig | null
  try {
  const { config, password } = await resolveConfig(c, raw)
  const base = baseUrl(config)
  const auth = authHeader(config, { password })
  const response = await webdavFetch(childUrl(base, 'inkstone-nav-backup.json'), {
    method: 'GET',
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(20000),
  }, base.origin)
  if (response.status === 404) throw new ApiError(404, 'not_found', 'Backup file not found')
  if (!response.ok) {
    await response.body?.cancel().catch(() => null)
    throw new ApiError(502, 'nav_webdav_failed', `WebDAV download failed: HTTP ${response.status}`)
  }
  const bytes = await readResponseBytesWithinLimit(response, 20 * 1024 * 1024)
  let rawBackup: unknown
  try {
    rawBackup = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw ApiError.badRequest('Backup file is not valid JSON')
  }
  const parsed = NavBackupSchema.safeParse(rawBackup)
  if (!parsed.success) throw ApiError.badRequest('Backup file has an unsupported format')
  const nav = new NavStore(c.env.DB, userId(c))
  const result = await nav.restore(parsed.data as NavBackup)
  await applyBackupSettings(nav, parsed.data.settings)
  return c.json(result)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, 'nav_webdav_failed', friendlyError(error))
  }
})

navBackupRoutes.get('/backup', async (c) => {
  const nav = new NavStore(c.env.DB, userId(c))
  return c.json(await buildBackup(nav), 200, { 'Cache-Control': 'no-store' })
})

navBackupRoutes.post('/backup/restore', async (c) => {
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > NAV_LIMITS.restoreBytes + 64 * 1024) throw new ApiError(413, 'payload_too_large', 'Backup file is too large')
  const raw = await c.req.json().catch(() => null)
  if (!raw) throw ApiError.badRequest('Backup file is not valid JSON')
  const parsed = NavBackupSchema.safeParse(raw)
  if (!parsed.success) throw ApiError.badRequest('Backup file has an unsupported format')
  const nav = new NavStore(c.env.DB, userId(c))
  const result = await nav.restore(parsed.data as NavBackup)
  await applyBackupSettings(nav, parsed.data.settings)
  return c.json(result)
})

navBackupRoutes.put('/webdav/secret', async (c) => {
  const raw = await c.req.json().catch(() => null) as { password?: unknown; clear?: unknown } | null
  const nav = new NavStore(c.env.DB, userId(c))
  if (raw?.clear === true) {
    await nav.clearWebdavSecret()
    return c.json({ hasPassword: false })
  }
  if (typeof raw?.password !== 'string' || !raw.password.trim()) throw ApiError.badRequest('A password is required')
  let ciphertext: string
  try {
    ciphertext = await encryptNavSecret(c.env, userId(c), raw.password)
  } catch {
    throw new ApiError(503, 'storage_unavailable', 'The credential vault is not available')
  }
  await nav.saveWebdavSecret(ciphertext)
  return c.json({ hasPassword: true })
})

navBackupRoutes.post('/webdav/forget', async (c) => {
  const nav = new NavStore(c.env.DB, userId(c))
  await nav.clearWebdavSecret()
  await nav.saveWebdavConfig('', '')
  return c.json({ ok: true })
})

