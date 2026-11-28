import type { ProjectCardNoteLink, ProjectNoteCardLink } from '@shared/project/model'
import { ApiError } from '../lib/errors'
import { ProjectStore } from './store'
import { projectIdChunks, projectPlaceholders } from './d1'

interface NoteRow {
  id: string
  title: string
  updated_at: number
  is_encrypted: number
  deleted_at: number | null
}

async function requireLinkableNote(db: D1Database, userId: string, noteId: string): Promise<NoteRow> {
  const note = await db.prepare(
    'SELECT id, title, updated_at, is_encrypted, deleted_at FROM notes WHERE id = ?1 AND user_id = ?2',
  ).bind(noteId, userId).first<NoteRow>()
  if (!note || note.deleted_at !== null) throw ApiError.notFound('Note not found')
  if (note.is_encrypted === 1) throw ApiError.conflict('This note is locked; unlock it before linking to a card')
  return note
}

export async function listCardNotes(db: D1Database, cardId: string, userId: string): Promise<ProjectCardNoteLink[]> {
  const { results } = await db.prepare(
    `SELECT l.card_id, l.note_id, n.title, n.updated_at
     FROM project_card_notes l
     JOIN notes n ON n.id = l.note_id AND n.user_id = l.user_id AND n.deleted_at IS NULL AND n.is_encrypted = 0
     WHERE l.card_id = ?1 AND l.user_id = ?2
     ORDER BY n.updated_at DESC, n.id DESC`,
  ).bind(cardId, userId).all<{ card_id: string, note_id: string, title: string, updated_at: number }>()
  return results.map((row) => ({ cardId: row.card_id, noteId: row.note_id, title: row.title, updatedAt: row.updated_at }))
}

export async function linkCardNote(db: D1Database, cardId: string, noteId: string, userId: string, now: number): Promise<ProjectCardNoteLink> {
  const note = await requireLinkableNote(db, userId, noteId)
  await db.prepare(
    'INSERT INTO project_card_notes (card_id, note_id, user_id, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(card_id, note_id) DO NOTHING',
  ).bind(cardId, noteId, userId, now).run()
  return { cardId, noteId, title: note.title, updatedAt: note.updated_at }
}

export async function unlinkCardNote(db: D1Database, cardId: string, noteId: string, userId: string): Promise<void> {
  await db.prepare('DELETE FROM project_card_notes WHERE card_id = ?1 AND note_id = ?2 AND user_id = ?3')
    .bind(cardId, noteId, userId).run()
}

export async function listNoteProjectCards(db: D1Database, noteId: string, userId: string): Promise<ProjectNoteCardLink[]> {
  const boards = await new ProjectStore(db, userId).boards()
  const cards: ProjectNoteCardLink[] = []
  for (const chunk of projectIdChunks(boards.map((board) => board.id))) {
    const marks = projectPlaceholders(chunk.length, 3)
    const { results } = await db.prepare(
      `SELECT c.id AS card_id, c.board_id, c.title, b.title AS board_title
       FROM project_card_notes l
       JOIN project_cards c ON c.id = l.card_id AND c.delete_at = 0
       JOIN project_boards b ON b.id = c.board_id
       WHERE l.note_id = ?1 AND l.user_id = ?2 AND c.board_id IN (${marks})
       ORDER BY c.update_at DESC, c.id DESC
       LIMIT 100`,
    ).bind(noteId, userId, ...chunk).all<{ card_id: string, board_id: string, title: string, board_title: string }>()
    cards.push(...results.map((row) => ({ cardId: row.card_id, boardId: row.board_id, boardTitle: row.board_title, title: row.title })))
  }
  return cards.slice(0, 100)
}
