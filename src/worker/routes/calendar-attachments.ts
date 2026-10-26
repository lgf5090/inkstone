/**
 * The HTTP surface of event attachments: put a file on an event, list what it shows, take one off.
 *
 * There is no second upload path. The bytes go through the same `attachments/storage.ts` the note and
 * task files use — the same hourly budget, multipart ceiling, 25 MB limit, MIME sniffing, filename
 * cleanup, per-account quota and R2/KV choice — because a parallel reader of `LIMITS` would be a second
 * set of limits to keep in step. This file adds the link row and the category folder the object is
 * filed under (`calendar/images/…`).
 *
 * Attaching is a write to the event, so it obeys the event's own write permission: a read-only provider
 * calendar refuses it for the same reason it refuses an edit. Removing a file removes the link, the
 * attachment row and the object; deleting the event does the same for every file it holds.
 */
import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { MAX_ATTACHMENTS_PER_EVENT } from '@shared/calendar/model'
import { calendarAttachmentObjectKey } from '../attachments/keys'
import { persistAttachmentWithinQuota, rollbackPersistedAttachments } from '../attachments/storage'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { FORM_BODY_LIMITS, readFormDataWithinLimit } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import { CalendarStore } from '../calendar/store'
import {
  calendarAttachmentDto,
  countEventAttachments,
  deleteEventAttachment,
  linkEventAttachment,
  listEventAttachments,
} from '../calendar/attachments'
import { parseEntityId } from '../calendar/validation'

export const calendarAttachmentRoutes = new Hono<AppBindings>()

calendarAttachmentRoutes.use('*', requireAuth)

calendarAttachmentRoutes.post('/events/:id/attachments', async (c) => {
  const userId = c.get('userId')
  const eventId = parseEntityId(c.req.param('id'), 'id')
  const store = new CalendarStore(c.env.DB, userId)
  // Proven before the body is read: an event this account cannot see, or cannot write, is refused even
  // when the caller brought a 25 MB upload with them.
  if (!(await store.getEvent(eventId))) throw ApiError.notFound('Event not found')
  await store.assertEventWritable(eventId)
  if (await countEventAttachments(c.env.DB, userId, eventId) >= MAX_ATTACHMENTS_PER_EVENT) {
    throw ApiError.conflict('That event already holds the maximum number of files')
  }

  await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [{
    key: `attachment-upload:${userId}`,
    maxAttempts: LIMITS.attachmentUploadsPerHour,
    windowMs: 60 * 60 * 1000,
    lockMs: 60 * 60 * 1000,
  }]), 'Too many uploads')

  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.attachment)
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing file field')
  if (file.size > LIMITS.attachmentMaxBytes) {
    throw ApiError.tooLarge('The file exceeds the 25 MB limit')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const id = newId()
  const now = Date.now()
  const stored = await persistAttachmentWithinQuota(c.env, {
    id,
    userId,
    scope: 'calendar',
    noteId: null,
    filename: file.name || 'file',
    reportedMime: file.type,
    bytes,
    createdAt: now,
    objectKey: calendarAttachmentObjectKey({
      user_id: userId,
      id,
      mime: file.type || 'application/octet-stream',
      filename: file.name || 'file',
    }),
  })

  try {
    if (!(await linkEventAttachment(c.env.DB, userId, eventId, id, now))) {
      throw ApiError.notFound('Event not found')
    }
  } catch (error) {
    // The upload already landed; a link that cannot be written must not leave a file nothing names.
    await rollbackPersistedAttachments(c.env, [stored]).catch((rollbackError) => {
      console.warn('[inkstone] Calendar attachment rollback will retry later:', rollbackError)
    })
    throw error
  }

  return c.json({ attachment: calendarAttachmentDto(stored) }, 201)
})

calendarAttachmentRoutes.get('/events/:id/attachments', async (c) => {
  const userId = c.get('userId')
  const eventId = parseEntityId(c.req.param('id'), 'id')
  if (!(await new CalendarStore(c.env.DB, userId).getEvent(eventId))) {
    throw ApiError.notFound('Event not found')
  }
  return c.json({ attachments: await listEventAttachments(c.env.DB, userId, eventId) })
})

calendarAttachmentRoutes.delete('/events/:id/attachments/:attachmentId', async (c) => {
  const userId = c.get('userId')
  const eventId = parseEntityId(c.req.param('id'), 'id')
  const attachmentId = c.req.param('attachmentId')
  if (!isValidId(attachmentId)) throw ApiError.notFound('Attachment not found')
  if (!(await new CalendarStore(c.env.DB, userId).getEvent(eventId))) {
    throw ApiError.notFound('Event not found')
  }
  if (!(await deleteEventAttachment(c.env.DB, userId, eventId, attachmentId))) {
    throw ApiError.notFound('Attachment not found')
  }
  return c.body(null, 204)
})
