import { Hono } from 'hono'
import type { WebsshHealth } from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { websshHostRoutes } from './routes-hosts'
import { websshKeyRoutes } from './routes-keys'
import { websshSessionRoutes } from './routes-session'
import { websshSftpRoutes } from './routes-sftp'
import { websshSettingsRoutes } from './routes-settings'
import { websshRecordingRoutes } from './routes-recordings'

export const websshRoutes = new Hono<AppBindings>()

websshRoutes.use('*', requireAuth)

websshRoutes.get('/health', (c) => c.json<WebsshHealth>({ ok: true, module: 'webssh' }))

websshRoutes.route('/', websshHostRoutes)
websshRoutes.route('/', websshKeyRoutes)
websshRoutes.route('/', websshSessionRoutes)
websshRoutes.route('/', websshSftpRoutes)
websshRoutes.route('/', websshSettingsRoutes)
websshRoutes.route('/', websshRecordingRoutes)
