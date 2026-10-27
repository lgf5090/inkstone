/**
 * `/api/cloudflare/ai/chat/sessions` — the conversation history the AI chat sidebar reads.
 *
 * The route owns the HTTP shape: bodies, limits and which refusal becomes which status. The rows and
 * their SQL live in `cloudflare/chat-sessions.ts`, so this file never names a table. A session that
 * does not belong to the reader is answered as missing, never forbidden.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'
import {
  appendMessages,
  clearMessages,
  createSession,
  deleteSession,
  listMessages,
  listSessions,
  removeLastAssistant,
  sessionExists,
  updateSession,
  type ChatSessionPatch,
} from '../../cloudflare/chat-sessions'

export const chatSessionsRouter = new Hono<AppBindings>()

const MAX_TITLE_CHARS = 200
const MAX_SEARCH_CHARS = 200
const MAX_MESSAGES_PER_APPEND = 200
const MAX_MESSAGE_CHARS = 100_000

function sessionId(c: Context<AppBindings>): string {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('That conversation does not exist')
  return id
}

async function optionalJson(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => null)
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('A JSON object body is required')
  }
  return value as Record<string, unknown>
}

function readTitle(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('title must be a string')
  const title = value.trim()
  if (title.length > MAX_TITLE_CHARS) throw ApiError.tooLarge('title is too long')
  return title
}

async function requireSession(env: AppBindings['Bindings'], userId: string, id: string): Promise<void> {
  if (!(await sessionExists(env, userId, id))) throw ApiError.notFound('That conversation does not exist')
}

chatSessionsRouter.get('/', async (c) => {
  const q = c.req.query('q')?.trim() ?? ''
  if (q.length > MAX_SEARCH_CHARS) throw ApiError.badRequest('q is too long')
  const tab = c.req.query('tab')?.trim() ?? ''
  if (tab && tab !== 'pinned' && tab !== 'favorite') {
    throw ApiError.badRequest('tab must be pinned or favorite')
  }
  return c.json(await listSessions(c.env, c.get('userId'), { q, tab: tab as '' | 'pinned' | 'favorite' }))
})

chatSessionsRouter.post('/', async (c) => {
  const body = await optionalJson(c)
  const title = readTitle(body.title)
  return c.json(await createSession(c.env, c.get('userId'), title), 201)
})

chatSessionsRouter.put('/:id', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  const body = await optionalJson(c)
  const patch: ChatSessionPatch = {}
  if (body.title !== undefined) patch.title = readTitle(body.title)
  for (const field of ['pinned', 'favorite'] as const) {
    if (body[field] === undefined) continue
    if (typeof body[field] !== 'boolean') throw ApiError.badRequest(`${field} must be a boolean`)
    patch[field] = body[field]
  }
  if (Object.keys(patch).length === 0) throw ApiError.badRequest('Nothing to update')
  const updated = await updateSession(c.env, userId, id, patch)
  if (!updated) throw ApiError.notFound('That conversation does not exist')
  return c.json(updated)
})

chatSessionsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  await requireSession(c.env, userId, id)
  await deleteSession(c.env, userId, id)
  return c.json({ ok: true })
})

chatSessionsRouter.get('/:id/messages', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  await requireSession(c.env, userId, id)
  return c.json(await listMessages(c.env, userId, id))
})

chatSessionsRouter.post('/:id/messages', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  const body = await optionalJson(c)
  const entries = body.messages
  if (!Array.isArray(entries) || entries.length === 0) {
    throw ApiError.badRequest('messages must be a non-empty array')
  }
  if (entries.length > MAX_MESSAGES_PER_APPEND) {
    throw ApiError.badRequest(`messages cannot exceed ${MAX_MESSAGES_PER_APPEND} entries`)
  }
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw ApiError.badRequest(`messages[${index}] must be an object`)
    }
    const record = entry as Record<string, unknown>
    const role = record.role
    if (role !== 'user' && role !== 'assistant') {
      throw ApiError.badRequest(`messages[${index}].role must be user or assistant`)
    }
    if (typeof record.content !== 'string') {
      throw ApiError.badRequest(`messages[${index}].content must be a string`)
    }
    if (record.content.length > MAX_MESSAGE_CHARS) {
      throw ApiError.tooLarge(`messages[${index}].content is too long`)
    }
    return { role, content: record.content }
  })
  await requireSession(c.env, userId, id)
  return c.json(await appendMessages(c.env, userId, id, messages))
})

chatSessionsRouter.delete('/:id/messages/last-assistant', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  await requireSession(c.env, userId, id)
  await removeLastAssistant(c.env, userId, id)
  return c.json({ ok: true })
})

chatSessionsRouter.delete('/:id/messages', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  await requireSession(c.env, userId, id)
  await clearMessages(c.env, userId, id)
  return c.json({ ok: true })
})

