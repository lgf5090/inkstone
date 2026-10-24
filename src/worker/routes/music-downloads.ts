/**
 * The download queue surface.
 *
 * A download is a server-side copy into the R2 library, not a file on the reader's device, so these
 * routes only ever name a track this account already saved. Every handler is owner-scoped through the
 * session's `user_id`: a foreign or unknown task id is a 404, and a task in another account is never
 * reported as existing. The bytes are moved by `music/queue.ts`; this file validates the request,
 * checks the quota, records the intent and wakes the queue.
 */
import { Hono } from 'hono'
import type { AppBindings, Env } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { MusicStore } from '../music/store'
import { assertMusicQuota, discardMusicObjects, requireMusicStorage } from '../music/storage'
import {
  MusicDownloadStore,
  normalizeDownloadFormat,
  normalizeDownloadQuality,
  type MusicDownloadTransition,
} from '../music/download-store'
import { kickMusicQueue, requireMusicQueue } from '../music/queue'

const DOWNLOAD_ACTIONS = ['pause', 'resume', 'retry', 'cancel'] as const
type DownloadAction = (typeof DOWNLOAD_ACTIONS)[number]

export const musicDownloadRoutes = new Hono<AppBindings>()

musicDownloadRoutes.use('*', requireAuth)

musicDownloadRoutes.get('/downloads', async (c) => {
  const downloads = new MusicDownloadStore(c.env.DB, c.get('userId'))
  return c.json({ items: await downloads.list() })
})

musicDownloadRoutes.post('/downloads', async (c) => {
  requireMusicStorage(c.env)
  // Checked before the row exists: a deployment that forgot the binding must not queue a task it can
  // never run. The row would otherwise sit at `queued` with nothing to wake it.
  requireMusicQueue(c.env)

  const userId = c.get('userId')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const trackId = typeof body.trackId === 'string' && isValidId(body.trackId) ? body.trackId : null
  if (!trackId) throw ApiError.badRequest('A track id is required')
  const quality = normalizeDownloadQuality(body.quality)
  const format = normalizeDownloadFormat(body.format)

  const musicStore = new MusicStore(c.env.DB, userId)
  const track = await musicStore.getTrack(trackId)
  if (!track) throw ApiError.notFound('Track not found')
  if (track.provider !== 'netease') {
    throw new ApiError(409, 'conflict', 'This track has no downloadable source')
  }

  // The provider's own size is the closest estimate available before the first byte arrives; without
  // it the check still refuses an account that has no room left at all. Completion checks again.
  const expected = track.size && track.size > 0 ? track.size : 1
  await assertMusicQuota(c.env, musicStore, expected)

  const downloads = new MusicDownloadStore(c.env.DB, userId)
  const { download, created } = await downloads.enqueue({ trackId, quality, format })
  if (download.status === 'queued') await kickMusicQueue(c.env, userId, download.id)
  return c.json({ download }, created ? 201 : 200)
})

musicDownloadRoutes.patch('/downloads/:id', async (c) => {
  const id = downloadId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const action = downloadAction(body.action)
  const userId = c.get('userId')
  const downloads = new MusicDownloadStore(c.env.DB, userId)

  const result = await applyAction(downloads, id, action)
  if (!result.download) throw ApiError.notFound('Download not found')
  if (!result.changed) {
    throw ApiError.conflict(`The download is ${result.download.status} and cannot ${action} now`)
  }

  if (action === 'resume' || action === 'retry') {
    await kickMusicQueue(c.env, userId, id)
  } else if (action === 'cancel') {
    await nudgeQueue(c.env, userId, id)
  }
  return c.json({ download: result.download })
})

musicDownloadRoutes.delete('/downloads/:id', async (c) => {
  const id = downloadId(c.req.param('id'))
  const userId = c.get('userId')
  const downloads = new MusicDownloadStore(c.env.DB, userId)
  const removed = await downloads.remove(id)
  if (!removed.deleted) throw ApiError.notFound('Download not found')

  // The row is gone first. The object stays when a track or another task still names the key; the
  // ledger decides that, and a failed delete is queued for the maintenance sweep rather than hidden.
  if (removed.r2Key) {
    const musicStore = new MusicStore(c.env.DB, userId)
    if (await musicStore.removeObject(removed.r2Key)) {
      await discardMusicObjects(c.env, musicStore, [removed.r2Key])
    }
  }
  return c.json({ ok: true })
})

function downloadId(value: string | undefined): string {
  if (!value || !isValidId(value)) throw ApiError.notFound('Download not found')
  return value
}

function downloadAction(value: unknown): DownloadAction {
  if (typeof value === 'string' && (DOWNLOAD_ACTIONS as readonly string[]).includes(value)) {
    return value as DownloadAction
  }
  throw ApiError.badRequest('The download action is not supported')
}

async function applyAction(
  downloads: MusicDownloadStore,
  id: string,
  action: DownloadAction,
): Promise<MusicDownloadTransition> {
  switch (action) {
    case 'pause':
      return await downloads.requestPause(id)
    case 'resume':
      return await downloads.requestResume(id)
    case 'retry':
      return await downloads.requestRetry(id)
    case 'cancel':
      return await downloads.requestCancel(id)
  }
}

/**
 * Canceling is already done once the row says so. Waking the queue only releases a parked multipart
 * earlier; a queue that cannot be reached leaves that to the alarm already running the task.
 */
async function nudgeQueue(
  env: Env,
  userId: string,
  downloadId: string,
): Promise<void> {
  try {
    await kickMusicQueue(env, userId, downloadId)
  } catch (error) {
    console.warn('[inkstone] Music download cancel could not wake the queue:', error)
  }
}
