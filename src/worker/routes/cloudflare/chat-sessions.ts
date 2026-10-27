/**
 * `/api/cloudflare/ai/chat/sessions` — the conversation history the AI chat sidebar reads.
 *
 * A session belongs to one reader, and so does every message. The id alone never proves ownership:
 * each query carries the reader's id, and another reader's session is answered as missing rather
 * than forbidden, so ids cannot be used to discover what exists.
 *
 * A new session starts with an empty title. The client fills it from the first answer, which keeps
 * the server out of the naming business and out of the reader's language.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings, Env } from '../../env'
import { ApiError } from '../../lib/errors'
import { isValidId, newId } from '../../lib/id'

export const chatSessionsRouter = new Hono<AppBindings>()

const MAX_TITLE_CHARS = 200
const MAX_SEARCH_CHARS = 200
const MAX_MESSAGES_PER_APPEND = 200
const MAX_MESSAGE_CHARS = 100_000

interface ChatSessionRow {
  id: string
  title: string
  pinned: number
  favorite: number
  created_at: number
  updated_at: number
  message_count?: number
}

interface ChatMessageRow {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: number
}

const SESSION_COLUMNS = `s.id, s.title, s.pinned, s.favorite, s.created_at, s.updated_at,
  (SELECT count(*) FROM cloudflare_chat_message m
    WHERE m.user_id = s.user_id AND m.session_id = s.id) AS message_count`

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

async function assertSession(env: Env, userId: string, id: string): Promise<void> {
  const row = await env.DB.prepare('SELECT id FROM cloudflare_chat_session WHERE user_id = ? AND id = ?')
    .bind(userId, id)
    .first<{ id: string }>()
  if (!row) throw ApiError.notFound('That conversation does not exist')
}

async function loadSession(c: Context<AppBindings>, userId: string, id: string): Promise<ChatSessionRow> {
  const row = await c.env.DB.prepare(
    `SELECT ${SESSION_COLUMNS} FROM cloudflare_chat_session s WHERE s.user_id = ? AND s.id = ?`,
  )
    .bind(userId, id)
    .first<ChatSessionRow>()
  if (!row) throw ApiError.notFound('That conversation does not exist')
  return row
}

function readTitle(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('title must be a string')
  const title = value.trim()
  if (title.length > MAX_TITLE_CHARS) throw ApiError.tooLarge('title is too long')
  return title
}

chatSessionsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const q = c.req.query('q')?.trim() ?? ''
  if (q.length > MAX_SEARCH_CHARS) throw ApiError.badRequest('q is too long')
  const tab = c.req.query('tab')?.trim() ?? ''
  if (tab && tab !== 'pinned' && tab !== 'favorite') {
    throw ApiError.badRequest('tab must be pinned or favorite')
  }

  const conditions = ['s.user_id = ?']
  const values: unknown[] = [userId]
  if (q) {
    conditions.push(`(s.title LIKE ? OR EXISTS (
      SELECT 1 FROM cloudflare_chat_message m
      WHERE m.user_id = s.user_id AND m.session_id = s.id AND m.content LIKE ?
    ))`)
    values.push(`%${q}%`, `%${q}%`)
  }
  if (tab) {
    conditions.push(tab === 'pinned' ? 's.pinned = 1' : 's.favorite = 1')
  }

  const rows = await c.env.DB.prepare(
    `SELECT ${SESSION_COLUMNS} FROM cloudflare_chat_session s
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.pinned DESC, s.updated_at DESC, s.id DESC`,
  )
    .bind(...values)
    .all<ChatSessionRow>()
  return c.json(rows.results ?? [])
})

chatSessionsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const body = await optionalJson(c)
  const title = readTitle(body.title)
  const id = newId()
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO cloudflare_chat_session (id, user_id, title, pinned, favorite, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`,
  )
    .bind(id, userId, title, now, now)
    .run()
  return c.json({
    id,
    title,
    pinned: 0,
    favorite: 0,
    created_at: now,
    updated_at: now,
    message_count: 0,
  } satisfies ChatSessionRow, 201)
})

chatSessionsRouter.put('/:id', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  const body = await optionalJson(c)
  const sets: string[] = []
  const values: unknown[] = []

  if (body.title !== undefined) {
    const title = readTitle(body.title)
    sets.push('title = ?')
    values.push(title)
  }
  for (const field of ['pinned', 'favorite'] as const) {
    if (body[field] === undefined) continue
    if (typeof body[field] !== 'boolean') throw ApiError.badRequest(`${field} must be a boolean`)
    sets.push(`${field} = ?`)
    values.push(body[field] ? 1 : 0)
  }
  if (sets.length === 0) throw ApiError.badRequest('Nothing to update')
  sets.push('updated_at = ?')
  values.push(Date.now())

  const result = await c.env.DB.prepare(
    `UPDATE cloudflare_chat_session SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`,
  )
    .bind(...values, userId, id)
    .run()
  if (!result.meta.changes) throw ApiError.notFound('That conversation does not exist')
  return c.json(await loadSession(c, userId, id))
})

chatSessionsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  await assertSession(c.env, userId, id)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM cloudflare_chat_message WHERE user_id = ? AND session_id = ?')
      .bind(userId, id),
    c.env.DB.prepare('DELETE FROM cloudflare_chat_session WHERE user_id = ? AND id = ?')
      .bind(userId, id),
  ])
  return c.json({ ok: true })
})

chatSessionsRouter.get('/:id/messages', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  await assertSession(c.env, userId, id)
  const rows = await c.env.DB.prepare(
    `SELECT id, session_id, role, content, created_at FROM cloudflare_chat_message
      WHERE user_id = ? AND session_id = ? ORDER BY created_at ASC, rowid ASC`,
  )
    .bind(userId, id)
    .all<ChatMessageRow>()
  return c.json(rows.results ?? [])
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

  await assertSession(c.env, userId, id)
  const now = Date.now()
  // A batch keeps its order even when two messages share a millisecond.
  const rows: ChatMessageRow[] = messages.map((message, index) => ({
    id: newId(),
    session_id: id,
    role: message.role,
    content: message.content,
    created_at: now + index,
  }))
  await c.env.DB.batch([
    ...rows.map((row) => c.env.DB.prepare(
      `INSERT INTO cloudflare_chat_message (id, user_id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(row.id, userId, row.session_id, row.role, row.content, row.created_at)),
    c.env.DB.prepare('UPDATE cloudflare_chat_session SET updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(now + rows.length, userId, id),
  ])
  return c.json(rows)
})

chatSessionsRouter.delete('/:id/messages/last-assistant', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  await assertSession(c.env, userId, id)
  const last = await c.env.DB.prepare(
    `SELECT id FROM cloudflare_chat_message
      WHERE user_id = ? AND session_id = ? AND role = 'assistant'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(userId, id)
    .first<{ id: string }>()
  if (last) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM cloudflare_chat_message WHERE user_id = ? AND id = ?')
        .bind(userId, last.id),
      c.env.DB.prepare('UPDATE cloudflare_chat_session SET updated_at = ? WHERE user_id = ? AND id = ?')
        .bind(Date.now(), userId, id),
    ])
  }
  return c.json({ ok: true })
})

chatSessionsRouter.delete('/:id/messages', async (c) => {
  const userId = c.get('userId')
  const id = sessionId(c)
  await assertSession(c.env, userId, id)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM cloudflare_chat_message WHERE user_id = ? AND session_id = ?')
      .bind(userId, id),
    c.env.DB.prepare('UPDATE cloudflare_chat_session SET updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(Date.now(), userId, id),
  ])
  return c.json({ ok: true })
})
