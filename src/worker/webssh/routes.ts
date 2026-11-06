import { Hono } from 'hono'
import type { WebsshHealth } from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { websshSessionRoutes } from './routes-session'
import { websshSftpRoutes } from './routes-sftp'

export const websshRoutes = new Hono<AppBindings>()

websshRoutes.use('*', requireAuth)

websshRoutes.get('/health', (c) => c.json<WebsshHealth>({ ok: true, module: 'webssh' }))

websshRoutes.route('/', websshSessionRoutes)
websshRoutes.route('/', websshSftpRoutes)
