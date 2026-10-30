import { Hono } from 'hono'
import { publicCloudDriveSettings } from '@shared/clouddrive/settings'
import type { CloudDriveBootstrap } from '@shared/clouddrive/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { cloudDriveFilesRoutes } from './routes-files'
import { cloudDriveSettingsRoutes } from './routes-settings'
import { clouddriveUploadRoutes } from './routes-upload'
import { clouddriveContentRoutes } from './routes-content'
import { clouddrivePublicShareRoutes, clouddriveShareRoutes } from './routes-shares'
import { clouddriveMountRoutes } from './routes-mounts'
import { clouddriveKeyRoutes } from './routes-keys'
import { clouddriveClipboardRoutes } from './routes-clipboard'
import { clouddriveTaskRoutes } from './routes-tasks'
import { clouddriveSyncRoutes } from './routes-sync'
import { clouddriveVersionRoutes } from './routes-versions'
import { clouddriveMaintenanceRoutes } from './routes-maintenance'
import { clouddriveAdminRoutes } from './routes-admin'
import { clouddriveJobRoutes } from './routes-jobs'
import { cloudDriveUsage, ensurePrimaryMount, listMounts, readCloudDriveSettings } from './store'

export const clouddriveRoutes = new Hono<AppBindings>()

clouddriveRoutes.use('*', async (c, next) => {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  await ensurePrimaryMount(c.env.DB, userId)
  await next()
})

clouddriveRoutes.get('/bootstrap', async (c) => {
  const userId = c.get('userId')
  const user = c.get('user')
  const [mounts, settings, usage] = await Promise.all([
    listMounts(c.env.DB, userId),
    readCloudDriveSettings(c.env.DB, userId),
    cloudDriveUsage(c.env.DB, userId, c.env),
  ])
  const primaryMount = mounts.find((mount) => mount.id === 'primary') ?? null
  const body: CloudDriveBootstrap = {
    user: { id: userId, role: user.role },
    primaryMount,
    mounts,
    settings: publicCloudDriveSettings(settings) as unknown as Record<string, unknown>,
    usage,
    prefsVersion: 1,
    capabilities: { fsAccess: true, notifications: true },
  }
  return c.json(body)
})

clouddriveRoutes.get('/health', async (c) => {
  const usage = await cloudDriveUsage(c.env.DB, c.get('userId'), c.env)
  return c.json({ ok: true, primaryAvailable: usage.primaryAvailable, usedBytes: usage.usedBytes })
})

clouddriveRoutes.route('/', cloudDriveFilesRoutes)
clouddriveRoutes.route('/', cloudDriveSettingsRoutes)
clouddriveRoutes.route('/', clouddriveUploadRoutes)
clouddriveRoutes.route('/', clouddriveContentRoutes)
clouddriveRoutes.route('/', clouddriveShareRoutes)
clouddriveRoutes.route('/', clouddriveMountRoutes)
clouddriveRoutes.route('/', clouddriveKeyRoutes)
clouddriveRoutes.route('/', clouddriveClipboardRoutes)
clouddriveRoutes.route('/', clouddriveTaskRoutes)
clouddriveRoutes.route('/', clouddriveSyncRoutes)
clouddriveRoutes.route('/', clouddriveVersionRoutes)
clouddriveRoutes.route('/', clouddriveMaintenanceRoutes)
clouddriveRoutes.route('/', clouddriveAdminRoutes)
clouddriveRoutes.route('/', clouddriveJobRoutes)

clouddriveRoutes.all('*', () => {
  throw ApiError.notFound('CloudDrive endpoint not found')
})

export const clouddrivePublicRoutes = clouddrivePublicShareRoutes

export const clouddriveSharePageRoutes = new Hono<AppBindings>()
clouddriveSharePageRoutes.get('/:slug', async (c) => {
  const url = new URL(c.req.url)
  return c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)))
})

export const clouddriveDavRoutes = new Hono<AppBindings>()
clouddriveDavRoutes.on(['OPTIONS'], '*', () => new Response(null, {
  status: 200,
  headers: { Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY', DAV: '1', 'MS-Author-Via': 'DAV' },
}))
clouddriveDavRoutes.all('*', () => new Response('WebDAV is not configured', { status: 503 }))
