/**
 * Comments of one library track or podcast episode.
 *
 * The browser names a track, never a thread: the worker resolves the stored snapshot and derives the
 * upstream thread itself. Comments are read-through and never persisted; the like endpoint forwards
 * the listener's own session to the provider and reports its refusal unchanged.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readOptionalJson } from '../lib/request'
import { MusicStore } from '../music/store'
import { commentThread } from '../music/comments'
import type { MusicRouteDeps } from './music'

const COMMENT_ID_MAX = 32
const COMMENT_OFFSET_MAX = 10_000

function trackIdOf(c: Context<AppBindings>): string {
  const id = c.req.param('trackId') ?? ''
  if (!id || id.length > 128) throw ApiError.notFound('That track does not exist')
  return id
}

function offsetOf(value: string | undefined): number {
  const parsed = Number(value ?? 0)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > COMMENT_OFFSET_MAX) {
    throw ApiError.badRequest('The comment offset is not valid')
  }
  return Math.trunc(parsed)
}

function limitOf(value: string | undefined): number {
  const parsed = Number(value ?? 30)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
    throw ApiError.badRequest('The comment limit must be between 1 and 50')
  }
  return Math.trunc(parsed)
}

export function createMusicCommentsRoutes(deps: MusicRouteDeps): Hono<AppBindings> {
  const routes = new Hono<AppBindings>()

  async function trackFor(c: Context<AppBindings>) {
    const id = trackIdOf(c)
    const store = new MusicStore(c.env.DB, c.get('userId'))
    const track = await store.getTrack(id) ?? await store.findTrack('netease', id)
    if (!track) throw ApiError.notFound('That track does not exist')
    return track
  }

  routes.get('/comments/:trackId', async (c) => {
    const track = await trackFor(c)
    const thread = commentThread(track)
    const offset = offsetOf(c.req.query('offset'))
    const limit = limitOf(c.req.query('limit'))
    if (!thread) {
      return c.json({ hot: [], latest: [], total: 0, hasMore: false })
    }
    try {
      const provider = await deps.provider(c)
      return c.json(await provider.comments({ thread, offset, limit }))
    } catch (error) {
      throw deps.translate(error)
    }
  })

  routes.post('/comments/:trackId/like', async (c) => {
    const track = await trackFor(c)
    const thread = commentThread(track)
    if (!thread) throw ApiError.badRequest('This track has no comment thread')
    const body = await readOptionalJson<{ commentId?: unknown; liked?: unknown }>(c, 4 * 1024, {})
    const commentId = typeof body.commentId === 'string' ? body.commentId.trim() : ''
    if (!commentId || commentId.length > COMMENT_ID_MAX) {
      throw ApiError.badRequest('The comment id is not valid')
    }
    if (typeof body.liked !== 'boolean') throw ApiError.badRequest('liked must be a boolean')
    try {
      const provider = await deps.provider(c)
      await provider.likeComment({ thread, commentId, liked: body.liked })
      return c.json({ ok: true })
    } catch (error) {
      throw deps.translate(error)
    }
  })

  return routes
}
