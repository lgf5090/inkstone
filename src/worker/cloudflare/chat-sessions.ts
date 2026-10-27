/**
 * The AI conversation history, as rows.
 *
 * Every statement carries the reader's id; the session id alone never proves ownership, and a query
 * that finds nothing is answered as missing rather than forbidden so ids cannot be probed. The route
 * above this module parses bodies and maps refusals to HTTP; it does not know the schema.
 */
import type { Env } from '../env'
import { newId } from '../lib/id'

export interface ChatSessionRow {
  id: string
  title: string
  pinned: number
  favorite: number
  created_at: number
  updated_at: number
  message_count?: number
}

export interface ChatMessageRow {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: number
}

export interface ChatSessionListQuery {
  q?: string
  tab?: '' | 'pinned' | 'favorite'
}

export interface ChatSessionPatch {
  title?: string
  pinned?: boolean
  favorite?: boolean
}

const SESSION_COLUMNS = `s.id, s.title, s.pinned, s.favorite, s.created_at, s.updated_at,
  (SELECT count(*) FROM cloudflare_chat_message m
    WHERE m.user_id = s.user_id AND m.session_id = s.id) AS message_count`

export async function listSessions(
  env: Env,
  userId: string,
  query: ChatSessionListQuery,
): Promise<ChatSessionRow[]> {
  const conditions = ['s.user_id = ?']
  const values: unknown[] = [userId]
  if (query.q) {
    conditions.push(`(s.title LIKE ? OR EXISTS (
      SELECT 1 FROM cloudflare_chat_message m
      WHERE m.user_id = s.user_id AND m.session_id = s.id AND m.content LIKE ?
    ))`)
    values.push(`%${query.q}%`, `%${query.q}%`)
  }
  if (query.tab === 'pinned') conditions.push('s.pinned = 1')
  if (query.tab === 'favorite') conditions.push('s.favorite = 1')
  const rows = await env.DB.prepare(
    `SELECT ${SESSION_COLUMNS} FROM cloudflare_chat_session s
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.pinned DESC, s.updated_at DESC, s.id DESC`,
  )
    .bind(...values)
    .all<ChatSessionRow>()
  return rows.results ?? []
}

export async function createSession(env: Env, userId: string, title: string): Promise<ChatSessionRow> {
  const id = newId()
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO cloudflare_chat_session (id, user_id, title, pinned, favorite, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`,
  )
    .bind(id, userId, title, now, now)
    .run()
  return { id, title, pinned: 0, favorite: 0, created_at: now, updated_at: now, message_count: 0 }
}

/** Null means the row is not this reader's (or does not exist); the route answers 404 either way. */
export async function loadSession(env: Env, userId: string, id: string): Promise<ChatSessionRow | null> {
  return await env.DB.prepare(
    `SELECT ${SESSION_COLUMNS} FROM cloudflare_chat_session s WHERE s.user_id = ? AND s.id = ?`,
  )
    .bind(userId, id)
    .first<ChatSessionRow>()
}

export async function updateSession(
  env: Env,
  userId: string,
  id: string,
  patch: ChatSessionPatch,
): Promise<ChatSessionRow | null> {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.title !== undefined) {
    sets.push('title = ?')
    values.push(patch.title)
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?')
    values.push(patch.pinned ? 1 : 0)
  }
  if (patch.favorite !== undefined) {
    sets.push('favorite = ?')
    values.push(patch.favorite ? 1 : 0)
  }
  if (sets.length === 0) return loadSession(env, userId, id)
  sets.push('updated_at = ?')
  values.push(Date.now())
  const result = await env.DB.prepare(
    `UPDATE cloudflare_chat_session SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`,
  )
    .bind(...values, userId, id)
    .run()
  if (!result.meta.changes) return null
  return await loadSession(env, userId, id)
}

export async function sessionExists(env: Env, userId: string, id: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM cloudflare_chat_session WHERE user_id = ? AND id = ?')
    .bind(userId, id)
    .first<{ id: string }>()
  return Boolean(row)
}

export async function deleteSession(env: Env, userId: string, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cloudflare_chat_message WHERE user_id = ? AND session_id = ?').bind(userId, id),
    env.DB.prepare('DELETE FROM cloudflare_chat_session WHERE user_id = ? AND id = ?').bind(userId, id),
  ])
}

export async function listMessages(env: Env, userId: string, sessionId: string): Promise<ChatMessageRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, session_id, role, content, created_at FROM cloudflare_chat_message
      WHERE user_id = ? AND session_id = ? ORDER BY created_at ASC, rowid ASC`,
  )
    .bind(userId, sessionId)
    .all<ChatMessageRow>()
  return rows.results ?? []
}

export async function appendMessages(
  env: Env,
  userId: string,
  sessionId: string,
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): Promise<ChatMessageRow[]> {
  const now = Date.now()
  // A batch keeps its order even when two messages share a millisecond.
  const rows: ChatMessageRow[] = messages.map((message, index) => ({
    id: newId(),
    session_id: sessionId,
    role: message.role,
    content: message.content,
    created_at: now + index,
  }))
  await env.DB.batch([
    ...rows.map((row) => env.DB.prepare(
      `INSERT INTO cloudflare_chat_message (id, user_id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(row.id, userId, row.session_id, row.role, row.content, row.created_at)),
    env.DB.prepare('UPDATE cloudflare_chat_session SET updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(now + rows.length, userId, sessionId),
  ])
  return rows
}

export async function clearMessages(env: Env, userId: string, sessionId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cloudflare_chat_message WHERE user_id = ? AND session_id = ?')
      .bind(userId, sessionId),
    env.DB.prepare('UPDATE cloudflare_chat_session SET updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(Date.now(), userId, sessionId),
  ])
}

export async function removeLastAssistant(env: Env, userId: string, sessionId: string): Promise<void> {
  const last = await env.DB.prepare(
    `SELECT id FROM cloudflare_chat_message
      WHERE user_id = ? AND session_id = ? AND role = 'assistant'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(userId, sessionId)
    .first<{ id: string }>()
  if (!last) return
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cloudflare_chat_message WHERE user_id = ? AND id = ?').bind(userId, last.id),
    env.DB.prepare('UPDATE cloudflare_chat_session SET updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(Date.now(), userId, sessionId),
  ])
}
