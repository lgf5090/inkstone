import { Hono } from 'hono'
import type { WebsshHealth } from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { websshHostRoutes } from './routes-hosts'
import { websshKeyRoutes } from './routes-keys'
import { websshSessionRoutes } from './routes-session'
import { websshSftpRoutes } from './routes-sftp'
import { websshForwardRoutes } from './routes-forward'
import { websshSettingsRoutes } from './routes-settings'
import { websshRecordingRoutes } from './routes-recordings'
import { websshShareRoutes } from './routes-share'
import { websshSnippetRoutes } from './routes-snippets'
import { websshAuditRoutes } from './routes-audit'
import { websshMonitorRoutes } from './routes-monitor'
import { websshDashboardRoutes } from './routes-dashboards'
import { websshAiRoutes } from './routes-ai'

export const websshRoutes = new Hono<AppBindings>()

websshRoutes.use('*', requireAuth)

websshRoutes.get('/health', (c) => c.json<WebsshHealth>({ ok: true, module: 'webssh' }))

// The AI surface is its own sub-app so every route under `/ai` shares one validation and metering
// boundary; the session, SFTP, recording and audit routers stay unaware of it.
websshRoutes.route('/ai', websshAiRoutes)

websshRoutes.route('/', websshHostRoutes)
websshRoutes.route('/', websshKeyRoutes)
websshRoutes.route('/', websshSessionRoutes)
websshRoutes.route('/', websshSftpRoutes)
websshRoutes.route('/', websshForwardRoutes)
websshRoutes.route('/', websshSettingsRoutes)
websshRoutes.route('/', websshRecordingRoutes)
websshRoutes.route('/', websshShareRoutes)
websshRoutes.route('/', websshSnippetRoutes)
websshRoutes.route('/', websshAuditRoutes)
websshRoutes.route('/', websshMonitorRoutes)
websshRoutes.route('/', websshDashboardRoutes)
