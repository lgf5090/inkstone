// The explicit switch that turns recording on. Absent or unreadable settings mean off, never a
// default-on recording of a reader's terminal.

import { Hono } from 'hono'
import type { WebsshRecordingSettingsView } from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import {
  readWebsshSettings,
  setWebsshRecordingEnabled,
  websshRecordingSettingsView,
} from './settings'

export const websshSettingsRoutes = new Hono<AppBindings>()

websshSettingsRoutes.get('/settings', async (c) => {
  const settings = await readWebsshSettings(c.env.DB, c.get('userId'))
  return c.json<WebsshRecordingSettingsView>(websshRecordingSettingsView(settings.recording.enabled))
})

websshSettingsRoutes.put('/settings/recording', async (c) => {
  const body = await readJson<{ enabled?: unknown }>(c, 4096)
  if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('`enabled` must be a boolean')
  const now = Date.now()
  await setWebsshRecordingEnabled(c.env.DB, c.get('userId'), body.enabled, now)
  return c.json<WebsshRecordingSettingsView>(websshRecordingSettingsView(body.enabled))
})
