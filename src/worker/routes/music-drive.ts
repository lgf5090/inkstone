/**
 * The music cloud's read-only first slice: how much R2 storage the account uses, whether a WebDAV
 * target is available, and one folder of that target.
 *
 * Writes (import, upload, delete) arrive with the provider extension; this router deliberately owns
 * none of them yet, so a deployment that has not configured WebDAV still answers a useful summary
 * instead of a 404.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { MusicStore } from '../music/store'
import { resolveMusicWebdav } from '../music/cloud/config'
import { listMusicDirectory, normalizeCloudPath } from '../music/cloud/webdav'

export const musicDriveRoutes = new Hono<AppBindings>()

musicDriveRoutes.get('/', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const [quota, mounts] = await Promise.all([store.quotaUsage(), store.listMounts()])
  const settings = await store.getSettings()
  return c.json({
    r2: { bytes: quota.bytes, objects: quota.count },
    webdav: { configured: Boolean(settings?.cloudWebdavTargetId) },
    mounts: mounts.length,
  })
})

musicDriveRoutes.get('/webdav', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  let path: string
  try {
    path = normalizeCloudPath(c.req.query('path') ?? '', { allowEmpty: true })
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('That folder path is not valid.')
  }
  try {
    const ctx = await resolveMusicWebdav(c.env, store, c.get('userId'))
    const listing = await listMusicDirectory(ctx, path)
    return c.json({
      configured: true,
      dir: ctx.dir,
      path,
      entries: listing.entries,
      truncated: listing.truncated,
      reason: null,
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) {
      return c.json({
        configured: false,
        dir: '',
        path,
        entries: [],
        truncated: false,
        reason: error.message,
      })
    }
    throw error
  }
})
