/**
 * CloudDrive user settings and the capacity card.
 *
 * Settings are per-user key/value rows. The WebDAV password arrives as plain text, is hashed here
 * with the same scrypt helper the login flow uses, and only the hash is stored — the response is the
 * public projection, which has no hash field at all.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { publicCloudDriveSettings, normalizeCloudDriveSettingsPatch, type CloudDriveSettingsPatch } from '@shared/clouddrive/settings'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { hashPassword, PASSWORD_MAX_LENGTH } from '../lib/password'
import { readJson } from '../lib/request'
import { cloudDriveUsage, listMounts, readCloudDriveSettings } from './store'
import { PRIMARY_MOUNT } from './lib'

export const cloudDriveSettingsRoutes = new Hono<AppBindings>()

cloudDriveSettingsRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const SETTINGS_BODY_LIMIT = 256 * 1024

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

cloudDriveSettingsRoutes.get('/settings', async (c) => {
  const settings = await readCloudDriveSettings(c.env.DB, userIdOf(c))
  return c.json({ settings: publicCloudDriveSettings(settings) })
})

cloudDriveSettingsRoutes.patch('/settings', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<CloudDriveSettingsPatch & { webdavPassword?: unknown }>(
    c,
    SETTINGS_BODY_LIMIT,
  )

  const normalized = normalizeCloudDriveSettingsPatch(body)
  if ('error' in normalized) throw ApiError.badRequest(normalized.error)
  const rows = normalized.rows

  if (body.webdavPassword !== undefined) {
    if (typeof body.webdavPassword !== 'string') throw ApiError.badRequest('webdavPassword must be a string')
    if (body.webdavPassword.length > PASSWORD_MAX_LENGTH) throw ApiError.badRequest('The WebDAV password is too long')
    rows['webdav.passwordHash'] = body.webdavPassword.length > 0
      ? await hashPassword(body.webdavPassword)
      : ''
  }

  const now = Date.now()
  const entries = Object.entries(rows)
  if (entries.length > 0) {
    await c.env.DB.batch(entries.map(([key, value]) => c.env.DB.prepare(
      `INSERT INTO CloudDrive_settings (user_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(userId, key, value, now)))
  }

  const settings = await readCloudDriveSettings(c.env.DB, userId)
  return c.json({ settings: publicCloudDriveSettings(settings) })
})

cloudDriveSettingsRoutes.get('/capacity', async (c) => {
  const userId = userIdOf(c)
  const [usage, mounts] = await Promise.all([
    cloudDriveUsage(c.env.DB, userId, c.env),
    listMounts(c.env.DB, userId),
  ])
  return c.json({
    used: usage.usedBytes,
    trashBytes: usage.trashBytes,
    quota: usage.quotaBytes,
    mounts: mounts.map((mount) => ({
      id: mount.id,
      name: mount.name,
      type: mount.storageType,
      used: mount.id === PRIMARY_MOUNT ? usage.usedBytes : 0,
      quota: mount.id === PRIMARY_MOUNT ? usage.quotaBytes : null,
      online: mount.online,
      lastTest: null,
    })),
  })
})
