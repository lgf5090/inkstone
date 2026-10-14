import { Hono } from 'hono'
import { mergeSettings, mergeSettingsPatch } from '@shared/constants'
import type { UserSettings } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { commitChange } from '../lib/notify'
import { setAllowRegistration } from '../lib/instance-settings'
import { requireCurrentPassword } from '../lib/reauth'
import { storedObject } from '../lib/json'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { SettingsStore } from '../settings/store'
import { requireAuth } from '../middleware/auth'

export const settingsRoutes = new Hono<AppBindings>()

settingsRoutes.use('*', requireAuth)


settingsRoutes.put('/registration', async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') throw ApiError.forbidden('Only the owner can change this setting')
  const body = await readJson<{ enabled?: boolean; password?: string }>(c, 4096)
  if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('Missing enabled parameter')
  await requireCurrentPassword(c.env.DB, user.id, body.password)
  await setAllowRegistration(c.env.DB, body.enabled)
  await commitChange(c, 'site', user.id, 'upsert')
  return c.json({ ok: true, registrationOpen: body.enabled })
})

settingsRoutes.get('/', (c) => {
  const user = c.get('user')
  return c.json(mergeSettings(parse(user.settingsRaw)))
})

settingsRoutes.put('/', async (c) => {
  const store = new SettingsStore(c.env.DB, c.get('userId'))
  const incoming = await readJson<Partial<UserSettings>>(c, JSON_BODY_LIMITS.settings)
  let previousRaw = c.get('user').settingsRaw
  for (let attempt = 0; attempt < 5; attempt++) {

    const merged = mergeSettingsPatch(parse(previousRaw), incoming)
    const nextRaw = JSON.stringify(merged)
    if (await store.writeSettingsIfUnchanged(nextRaw, previousRaw)) {
      await commitChange(c, 'settings', store.userId, 'upsert')
      return c.json(merged)
    }
    const latest = await store.readSettings()
    if (latest === null) throw ApiError.unauthenticated()
    previousRaw = latest
  }
  throw new ApiError(409, 'conflict', 'Settings keep changing elsewhere. Try again shortly')
})


settingsRoutes.get('/stats', async (c) => {
  const store = new SettingsStore(c.env.DB, c.get('userId'))
  const row = await store.stats()

  return c.json({
    notes: row?.notes ?? 0,
    trashed: row?.trashed ?? 0,
    folders: row?.folders ?? 0,
    tags: row?.tags ?? 0,
    attachments: row?.attachments ?? 0,
    attachmentBytes: row?.attachmentBytes ?? 0,
    chars: row?.chars ?? 0,
    words: row?.words ?? 0,
    versions: row?.versions ?? 0,
    links: row?.links ?? 0,
  })
})

function parse(raw: string): Record<string, unknown> {
  return storedObject(raw)
}
