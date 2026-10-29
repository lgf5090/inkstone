/**
 * Saved-library routes, mounted at `/api/youtube/library` behind the app's session middleware.
 *
 * The handlers stay thin: read the body within the YouTube body ceiling, hand it to the store, and
 * answer with the row the store wrote. Ownership comes only from `userId`; a `user_id` in the body is
 * never read.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import {
  createTag,
  deleteChannel,
  deletePlaylist,
  deleteTag,
  deleteVideo,
  readLibrary,
  reorderChannels,
  reorderPlaylists,
  reorderTags,
  saveChannel,
  savePlaylist,
  saveVideo,
  updateTag,
} from './store'

type LibraryBody = Record<string, unknown>

function idsField(body: LibraryBody): string[] {
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
    throw ApiError.badRequest('ids must be a list of strings')
  }
  return body.ids as string[]
}

export const youtubeLibraryRoutes = new Hono<AppBindings>()

youtubeLibraryRoutes.get('/', async (c) => {
  return c.json(await readLibrary(c.env.DB, c.get('userId')))
})

youtubeLibraryRoutes.put('/videos/:id', async (c) => {
  const body = await readJson<LibraryBody>(c, JSON_BODY_LIMITS.youtube)
  const video = await saveVideo(c.env.DB, c.get('userId'), c.req.param('id'), body)
  return c.json({ video })
})

youtubeLibraryRoutes.delete('/videos/:id', async (c) => {
  await deleteVideo(c.env.DB, c.get('userId'), c.req.param('id'))
  return c.body(null, 204)
})

youtubeLibraryRoutes.put('/channels/:id', async (c) => {
  const body = await readJson<LibraryBody>(c, JSON_BODY_LIMITS.youtube)
  const channel = await saveChannel(c.env.DB, c.get('userId'), c.req.param('id'), body)
  return c.json({ channel })
})

youtubeLibraryRoutes.patch('/channels/order', async (c) => {
  const body = await readJson<LibraryBody>(c, JSON_BODY_LIMITS.youtube)
  await reorderChannels(c.env.DB, c.get('userId'), idsField(body))
  return c.body(null, 204)
})

youtubeLibraryRoutes.delete('/channels/:id', async (c) => {
  await deleteChannel(c.env.DB, c.get('userId'), c.req.param('id'))
  return c.body(null, 204)
})

youtubeLibraryRoutes.patch('/playlists/order', async (c) => {
  const body = await readJson<LibraryBody>(c, JSON_BODY_LIMITS.youtube)
  await reorderPlaylists(c.env.DB, c.get('userId'), idsField(body))
  return c.body(null, 204)
})

youtubeLibraryRoutes.put('/playlists/:id', async (c) => {
  const body = await readJson<LibraryBody>(c, JSON_BODY_LIMITS.youtube)
  const playlist = await savePlaylist(c.env.DB, c.get('userId'), c.req.param('id'), body)
  return c.json({ playlist })
})

youtubeLibraryRoutes.delete('/playlists/:id', async (c) => {
  await deletePlaylist(c.env.DB, c.get('userId'), c.req.param('id'))
  return c.body(null, 204)
})

youtubeLibraryRoutes.post('/tags', async (c) => {
  const body = await readJson<LibraryBody>(c, JSON_BODY_LIMITS.youtube)
  const tag = await createTag(c.env.DB, c.get('userId'), body)
  return c.json({ tag })
})

youtubeLibraryRoutes.patch('/tags/order', async (c) => {
  const body = await readJson<LibraryBody>(c, JSON_BODY_LIMITS.youtube)
  await reorderTags(c.env.DB, c.get('userId'), idsField(body))
  return c.body(null, 204)
})

youtubeLibraryRoutes.patch('/tags/:id', async (c) => {
  const body = await readJson<LibraryBody>(c, JSON_BODY_LIMITS.youtube)
  const tag = await updateTag(c.env.DB, c.get('userId'), c.req.param('id'), body)
  return c.json({ tag })
})

youtubeLibraryRoutes.delete('/tags/:id', async (c) => {
  const result = await deleteTag(c.env.DB, c.get('userId'), c.req.param('id'))
  return c.json(result)
})
