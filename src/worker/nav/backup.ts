import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { decryptNavSecret, encryptNavSecret } from '../lib/crypto'
import { NavBackupConfigSchema, NavBackupSchema } from '@shared/nav/validation'
import { NAV_LIMITS, type NavBackup } from '@shared/nav/model'
import type { WebdavConfig } from '@shared/types'
import { parseBackupEndpoint } from '../backup/validation'
import { webdavTest } from '../backup/webdav'
import { friendlyError } from '../backup/common'
import { NavStore } from './store'
import {
  applyBackupSettings,
  buildBackup,
  navBackupStatus,
  performNavBackup,
  restoreNavBackup,
} from './backup-service'

export const navBackupRoutes = new Hono<AppBindings>()
navBackupRoutes.use('*', requireAuth)

function userId(c: Context<AppBindings>): string {
  const id = c.get('userId') ?? c.get('user')?.id
  if (!id) throw ApiError.unauthenticated()
  return id
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

navBackupRoutes.get('/webdav/config', async (c) => {
  const nav = new NavStore(c.env.DB, userId(c))
  return c.json(await navBackupStatus(nav))
})

navBackupRoutes.put('/webdav/config', async (c) => {
  const parsed = NavBackupConfigSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw ApiError.badRequest('Invalid backup configuration')
  const input = parsed.data
  const nav = new NavStore(c.env.DB, userId(c))
  const current = await nav.webdavSettings()
  const connectionChanged = input.url !== undefined || input.username !== undefined || input.password !== undefined || input.clearPassword === true
  if (connectionChanged) {
    const url = (input.url ?? current.url).trim()
    const username = (input.username ?? current.username).trim()
    if (!url || !username) throw ApiError.badRequest('WebDAV url and username are required')
    try {
      parseBackupEndpoint(url, 'WebDAV URL')
    } catch (error) {
      throw ApiError.badRequest(error instanceof Error ? error.message : 'Invalid WebDAV URL')
    }
    if (input.clearPassword === true) await nav.clearWebdavSecret()
    if (input.password?.trim()) {
      let ciphertext: string
      try {
        ciphertext = await encryptNavSecret(c.env, userId(c), input.password.trim())
      } catch {
        throw new ApiError(503, 'storage_unavailable', 'The credential vault is not available')
      }
      await nav.saveWebdavSecret(ciphertext)
    }
    if (!(await nav.webdavSecret())) throw new ApiError(401, 'wrong_password', 'A WebDAV password is required')
    await nav.saveWebdavConfig(url, username)
  }
  if (input.schedule !== undefined || input.retention !== undefined) {
    const state = await nav.backupState()
    await nav.saveBackupState({
      ...state,
      schedule: input.schedule ?? state.schedule,
      retention: input.retention ?? state.retention,
    })
  }
  if (!connectionChanged && input.schedule === undefined && input.retention === undefined) {
    throw ApiError.badRequest('Nothing to save')
  }
  return c.json(await navBackupStatus(nav))
})

navBackupRoutes.post('/webdav/backup', async (c) => {
  const raw = await c.req.json().catch(() => null) as RequestConfig | null
  try {
    const result = await performNavBackup(c.env, userId(c), { timestamped: raw?.timestamped !== false })
    return c.json({ ok: true, filename: result.filename, verified: result.verified })
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, 'nav_webdav_failed', friendlyError(error))
  }
})

navBackupRoutes.post('/webdav/restore', async (c) => {
  try {
    const result = await restoreNavBackup(c.env, userId(c))
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
  const state = await nav.backupState()
  await nav.saveBackupState({ ...state, schedule: 'off' })
  return c.json({ ok: true })
})
