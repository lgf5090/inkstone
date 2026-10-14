import { Hono } from 'hono'
import { parseStoredAvatarUrl } from '@shared/avatar'
import { hasAttachmentStorage, readAttachmentObject } from '../attachments/backend'
import { avatarOwnerMatchesPreference } from '../avatars/store'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'

export const avatarRoutes = new Hono<AppBindings>()

avatarRoutes.get('/:storage/:userId/:file', async (c) => {
  const preference = `/api/avatars/${c.req.param('storage')}/${c.req.param('userId')}/${c.req.param('file')}`
  const location = parseStoredAvatarUrl(preference)
  if (!location) throw ApiError.notFound('Avatar not found')

  if (!(await avatarOwnerMatchesPreference(c.env.DB, location.userId, preference))) {
    throw ApiError.notFound('Avatar not found')
  }
  if (!hasAttachmentStorage(c.env, location.storage)) {
    throw new ApiError(
      503,
      'storage_unavailable',
      `${location.storage === 'r2' ? 'R2' : 'Workers KV'} avatar storage is not bound`,
    )
  }

  const bytes = await readAttachmentObject(c.env, location.storage, location.key)
  if (!bytes) throw ApiError.notFound('Avatar data is missing')
  const contentType = location.extension === 'jpg' ? 'image/jpeg' : `image/${location.extension}`
  return new Response(bytes as BodyInit, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
