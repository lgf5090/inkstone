// The explicit switch that turns recording on. Absent or unreadable settings mean off, never a
// default-on recording of a reader's terminal.

import { Hono } from 'hono'
import type { WebsshRecordingSettingsView } from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import {
  readWebsshSettings,
  setWebsshAutoTrustFirst,
  setWebsshRecordingEnabled,
  websshRecordingSettingsView,
} from './settings'

export const websshSettingsRoutes = new Hono<AppBindings>()

function view(settings: Awaited<ReturnType<typeof readWebsshSettings>>): WebsshRecordingSettingsView {
  return websshRecordingSettingsView(settings.recording.enabled, settings.hostKeys.autoTrustFirst)
}

websshSettingsRoutes.get('/settings', async (c) => {
  return c.json<WebsshRecordingSettingsView>(view(await readWebsshSettings(c.env.DB, c.get('userId'))))
})

websshSettingsRoutes.put('/settings/recording', async (c) => {
  const body = await readJson<{ enabled?: unknown }>(c, 4096)
  if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('`enabled` must be a boolean')
  const now = Date.now()
  await setWebsshRecordingEnabled(c.env.DB, c.get('userId'), body.enabled, now)
  return c.json<WebsshRecordingSettingsView>(view(await readWebsshSettings(c.env.DB, c.get('userId'))))
})

websshSettingsRoutes.put('/settings/host-keys', async (c) => {
  const body = await readJson<{ autoTrustFirst?: unknown }>(c, 4096)
  if (typeof body.autoTrustFirst !== 'boolean') throw ApiError.badRequest('`autoTrustFirst` must be a boolean')
  const now = Date.now()
  await setWebsshAutoTrustFirst(c.env.DB, c.get('userId'), body.autoTrustFirst, now)
  return c.json<WebsshRecordingSettingsView>(view(await readWebsshSettings(c.env.DB, c.get('userId'))))
})
