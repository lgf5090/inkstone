/**
 * Same-origin image endpoints for the YouTube rows.
 *
 * The images are public thumbnails, but they are fetched through this deployment so the browser
 * never talks to Google directly and the bytes can be cached once for every reader. A video
 * thumbnail has a fixed source; a channel icon has to come from the account's saved snapshot, so
 * the row is read with `user_id` in the predicate and its address is checked against the host
 * whitelist before anything leaves the worker.
 */
import { Hono } from 'hono'
import { isYoutubeId } from '@shared/youtube/validate'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import {
  channelIconKey,
  channelIconSource,
  serveYouTubeImage,
  thumbnailKey,
  thumbnailSource,
  youtubeImageBase,
} from './media'

export const youtubeMediaRoutes = new Hono<AppBindings>()

function idParam(value: string | undefined, label: string): string {
  if (!isYoutubeId(value)) throw ApiError.badRequest(`The ${label} id is not valid`)
  return value
}

youtubeMediaRoutes.get('/thumbnail/:id', async (c) => {
  const videoId = idParam(c.req.param('id'), 'video')
  return await serveYouTubeImage(c.env, thumbnailKey(videoId), thumbnailSource(videoId, youtubeImageBase(c.env)))
})

youtubeMediaRoutes.get('/channel/:id', async (c) => {
  const channelId = idParam(c.req.param('id'), 'channel')
  const row = await c.env.DB.prepare(
    'SELECT data_json FROM youtube_channels WHERE user_id = ? AND id = ?',
  )
    .bind(c.get('userId'), channelId)
    .first<{ data_json: string }>()
  if (!row) throw new ApiError(404, 'youtube_not_found', 'The saved channel was not found')

  let snapshot: unknown
  try {
    snapshot = JSON.parse(row.data_json)
  }
  catch {
    snapshot = null
  }
  const icon = snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>).thumbnailUrl
    : null
  return await serveYouTubeImage(c.env, channelIconKey(channelId), channelIconSource(icon))
})
