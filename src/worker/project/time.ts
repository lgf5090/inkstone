/**
 * Time tracking as intervals rather than a counter: starting writes a row, stopping stamps its end,
 * so a correction is an edit and two people timing one card never overwrite each other. Only the
 * person who started a running timer may stop it; a board editor may remove any row.
 */
import type { ProjectTimeEntry } from '@shared/project/model'
import { newProjectId } from '@shared/project/limits'
import { ApiError } from '../lib/errors'

interface TimeRow {
  id: string
  board_id: string
  card_id: string
  user_id: string
  note: string
  started_at: number
  ended_at: number | null
  created_at: number
}

function rowToEntry(row: TimeRow): ProjectTimeEntry {
  return {
    id: row.id, boardId: row.board_id, cardId: row.card_id, userId: row.user_id, note: row.note,
    startedAt: row.started_at, endedAt: row.ended_at, createdAt: row.created_at,
  }
}

export async function listCardTime(db: D1Database, cardId: string): Promise<ProjectTimeEntry[]> {
  const { results } = await db
    .prepare('SELECT * FROM project_time_entries WHERE card_id = ?1 ORDER BY started_at DESC LIMIT 200')
    .bind(cardId)
    .all<TimeRow>()
  return results.map(rowToEntry)
}

export async function startCardTime(
  db: D1Database,
  input: { boardId: string, cardId: string, userId: string, note?: string },
  now: number,
): Promise<ProjectTimeEntry> {
  const running = await db
    .prepare('SELECT id FROM project_time_entries WHERE card_id = ?1 AND user_id = ?2 AND ended_at IS NULL LIMIT 1')
    .bind(input.cardId, input.userId)
    .first<{ id: string }>()
  if (running) throw ApiError.conflict('a timer is already running on this card')
  const entry: ProjectTimeEntry = {
    id: newProjectId('time'), boardId: input.boardId, cardId: input.cardId, userId: input.userId,
    note: (input.note ?? '').slice(0, 500), startedAt: now, endedAt: null, createdAt: now,
  }
  await db.prepare(
    `INSERT INTO project_time_entries (id, board_id, card_id, user_id, note, started_at, ended_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)`,
  ).bind(entry.id, entry.boardId, entry.cardId, entry.userId, entry.note, entry.startedAt, entry.createdAt).run()
  return entry
}

export async function stopCardTime(
  db: D1Database,
  cardId: string,
  userId: string,
  now: number,
): Promise<ProjectTimeEntry | null> {
  const row = await db
    .prepare('SELECT * FROM project_time_entries WHERE card_id = ?1 AND user_id = ?2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .bind(cardId, userId)
    .first<TimeRow>()
  if (!row) return null
  const endedAt = Math.max(now, row.started_at)
  await db.prepare('UPDATE project_time_entries SET ended_at = ?1 WHERE id = ?2').bind(endedAt, row.id).run()
  return rowToEntry({ ...row, ended_at: endedAt })
}

export async function deleteTimeEntry(db: D1Database, cardId: string, entryId: string): Promise<void> {
  await db.prepare('DELETE FROM project_time_entries WHERE id = ?1 AND card_id = ?2').bind(entryId, cardId).run()
}
