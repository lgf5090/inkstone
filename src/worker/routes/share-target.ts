import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import { MAX_TASK_DESCRIPTION_CHARS } from '@shared/todos/model'
import { AssistantStore } from '../assistant/store'
import { assertNoteQuota } from '../db/quota'
import { ApiError } from '../lib/errors'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'
import { broadcastCursor, scheduleFtsDrain } from '../lib/notify'
import { assertContentSize, readFormDataWithinLimit } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { NotesStore } from '../notes/store'
import { scheduleAiDrainForNote } from '../mcp/ai-search'
import type { AppBindings } from '../env'

const SHARE_TARGET_BODY_MAX = 64 * 1024
const SHARE_TARGET_URL_MAX = 2048

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export const shareTargetRoutes = new Hono<AppBindings>()

shareTargetRoutes.post('/', requireAuth, async (c) => {
  const origin = c.req.header('origin')
  if (origin && origin !== new URL(c.req.url).origin) throw ApiError.forbidden('The share target origin is not trusted')

  const form = await readFormDataWithinLimit(c.req, SHARE_TARGET_BODY_MAX)
  const sharedTitle = truncateText(field(form, 'title'), LIMITS.titleMaxLength)
  const sharedText = field(form, 'text')
  const sharedUrl = truncateText(field(form, 'url'), SHARE_TARGET_URL_MAX)
  const content = [sharedText, sharedUrl].filter(Boolean).join('\n\n')
  if (!content) throw ApiError.badRequest('The shared content is empty')
  assertContentSize(content)

  const userId = c.get('userId')
  const target = c.req.query('target') ?? 'note'
  if (target !== 'note' && target !== 'todo') throw ApiError.badRequest('Unknown share target')
  const title = sharedTitle || truncateText(sharedText.split('\n')[0] || sharedUrl, LIMITS.titleMaxLength)
  if (target === 'todo') {
    if (content.length > MAX_TASK_DESCRIPTION_CHARS) {
      throw ApiError.badRequest(`A shared task note cannot exceed ${MAX_TASK_DESCRIPTION_CHARS} characters`)
    }
    const store = new AssistantStore(c.env.DB, userId, c.env)
    const settings = await store.getSettings()
    const task = await store.createTask({ title: title.slice(0, 300), description: content }, settings.timezone)
    await store.recordActivity('task.created', task.title)
    return c.redirect(`/todo/${task.id}`, 303)
  }
  const now = Date.now()
  const id = newId()
  const { words, chars } = countText(content)
  const [contentHash] = await Promise.all([sha256Hex(content), assertNoteQuota(c.env.DB, userId)])
  const store = new NotesStore(c.env.DB, userId, c.get('database').ftsEnabled)
  const created = await store.create({
    id,
    folderId: null,
    title,
    content,
    excerpt: deriveExcerpt(content),
    words,
    chars,
    isStarred: false,
    contentHash,
    now,
  })
  if (!created.row) throw ApiError.conflict('The shared note could not be created')
  await broadcastCursor(c, created.changeSeq)
  scheduleFtsDrain(c)
  scheduleAiDrainForNote(c, userId)
  return c.redirect(`/n/${id}`, 303)
})
