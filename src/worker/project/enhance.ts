/**
 * Board activity trail (X-7) and card dependencies (X-3). Activity rows are append-only facts about
 * who changed what; the dependency graph is a set of directed 'blocks' edges with cycle detection so
 * a board can never deadlock itself. Both reuse tables created with the core schema.
 */
import type { ProjectActivityEntry, ProjectBoard, ProjectCard, ProjectCardLink, ProjectCardLinkKind } from '@shared/project/model'
import { newProjectId } from '@shared/project/limits'
import { ApiError } from '../lib/errors'
import { createProjectCard, getProjectCard } from './cards'
import { createProjectContent } from './contents'

export type { ProjectActivityEntry, ProjectCardLink }

export async function saveCardAsTemplate(db: D1Database, cardId: string, now: number): Promise<void> {
  await db.prepare('UPDATE project_cards SET is_template = 1, update_at = ?1 WHERE id = ?2').bind(now, cardId).run()
}

/** New card from a template card: copies its values and content blocks into a fresh live card. */
export async function createCardFromTemplate(db: D1Database, board: ProjectBoard, userId: string, templateId: string, now: number): Promise<ProjectCard> {
  const template = await getProjectCard(db, templateId)
  if (!template || !template.isTemplate || template.boardId !== board.id) throw ApiError.notFound('Template not found')
  const card = await createProjectCard(db, board, userId, { title: template.title, icon: template.icon, parentId: '', isTemplate: false, values: template.values }, now)
  const { results } = await db.prepare('SELECT * FROM project_card_contents WHERE card_id = ?1 AND delete_at = 0 ORDER BY position, id').bind(templateId).all<{ type: string, title: string, fields: string }>()
  for (const row of results) {
    await createProjectContent(db, card, userId, { type: row.type as 'text', title: row.title, fields: JSON.parse(row.fields) as { checked?: boolean } }, now)
  }
  return card
}

export async function recordProjectActivity(
  db: D1Database,
  boardId: string,
  actorId: string,
  type: string,
  targetId: string,
  summary: string,
  now: number,
): Promise<void> {
  await db.prepare(
    'INSERT INTO project_activity (board_id, id, actor_id, type, target_id, summary, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  ).bind(boardId, newProjectId('activity'), actorId, type, targetId, summary, now).run()
}

export async function listProjectActivity(db: D1Database, boardId: string, limit: number): Promise<ProjectActivityEntry[]> {
  const { results } = await db
    .prepare('SELECT id, actor_id, type, target_id, summary, created_at FROM project_activity WHERE board_id = ?1 ORDER BY created_at DESC LIMIT ?2')
    .bind(boardId, limit)
    .all<{ id: string, actor_id: string, type: string, target_id: string, summary: string, created_at: number }>()
  return results.map((row) => ({ id: row.id, actorId: row.actor_id, type: row.type, targetId: row.target_id, summary: row.summary, createdAt: row.created_at }))
}

export async function listCardLinks(db: D1Database, cardId: string): Promise<ProjectCardLink[]> {
  const { results } = await db
    .prepare('SELECT from_card_id, to_card_id, kind FROM project_card_links WHERE from_card_id = ?1 OR to_card_id = ?1')
    .bind(cardId)
    .all<{ from_card_id: string, to_card_id: string, kind: string }>()
  return results.map((row) => ({ fromCardId: row.from_card_id, toCardId: row.to_card_id, kind: row.kind as ProjectCardLinkKind }))
}

export async function listBoardLinks(db: D1Database, boardId: string): Promise<ProjectCardLink[]> {
  const { results } = await db
    .prepare('SELECT from_card_id, to_card_id, kind FROM project_card_links WHERE board_id = ?1')
    .bind(boardId)
    .all<{ from_card_id: string, to_card_id: string, kind: string }>()
  return results.map((row) => ({ fromCardId: row.from_card_id, toCardId: row.to_card_id, kind: row.kind as ProjectCardLinkKind }))
}

/** Adding a 'blocks' edge that would close a cycle is refused, keeping the dependency graph acyclic. */
export async function addCardLink(db: D1Database, boardId: string, fromId: string, toId: string, kind: ProjectCardLinkKind, now: number): Promise<void> {
  if (fromId === toId) throw ApiError.badRequest('a card cannot depend on itself')
  if (kind === 'blocks') {
    const { results } = await db.prepare('SELECT from_card_id, to_card_id FROM project_card_links WHERE board_id = ?1 AND kind = ?2').bind(boardId, 'blocks').all<{ from_card_id: string, to_card_id: string }>()
    const edges = new Map<string, string[]>()
    for (const row of results) edges.set(row.from_card_id, [...(edges.get(row.from_card_id) ?? []), row.to_card_id])
    edges.set(fromId, [...(edges.get(fromId) ?? []), toId])
    const seen = new Set<string>()
    const stack = [toId]
    while (stack.length) {
      const node = stack.pop()!
      if (node === fromId) throw ApiError.conflict('dependency would create a cycle')
      if (seen.has(node)) continue
      seen.add(node)
      for (const next of edges.get(node) ?? []) stack.push(next)
    }
  }
  await db.prepare(
    'INSERT INTO project_card_links (from_card_id, to_card_id, kind, board_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(from_card_id, to_card_id, kind) DO NOTHING',
  ).bind(fromId, toId, kind, boardId, now).run()
}

export async function removeCardLink(db: D1Database, fromId: string, toId: string, kind: ProjectCardLinkKind): Promise<void> {
  await db.prepare('DELETE FROM project_card_links WHERE from_card_id = ?1 AND to_card_id = ?2 AND kind = ?3').bind(fromId, toId, kind).run()
}

/** X-5: a card ↔ /todo task mapping, one task per card. */
export async function linkCardTodo(db: D1Database, cardId: string, todoId: string, userId: string, now: number): Promise<void> {
  await db.prepare(
    'INSERT INTO project_todo_links (card_id, todo_id, user_id, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(card_id, todo_id) DO NOTHING',
  ).bind(cardId, todoId, userId, now).run()
}

export async function unlinkCardTodo(db: D1Database, cardId: string): Promise<void> {
  await db.prepare('DELETE FROM project_todo_links WHERE card_id = ?1').bind(cardId).run()
}

export async function getCardTodoLink(db: D1Database, cardId: string): Promise<string | null> {
  const row = await db.prepare('SELECT todo_id FROM project_todo_links WHERE card_id = ?1').bind(cardId).first<{ todo_id: string }>()
  return row?.todo_id ?? null
}

const DONE_PATTERN = /done|complete|finished/i

/** A card reads as done when a checkbox property is ticked or its status option names completion. */
export function cardIsDone(card: ProjectCard, properties: readonly { id: string, type: string, options: { id: string, value: string }[] }[]): boolean {
  for (const property of properties) {
    const raw = card.values[property.id]
    if (!raw) continue
    if (property.type === 'checkbox' && raw === 'true') return true
    if (property.type === 'select') {
      const option = property.options.find((o) => o.id === raw)
      if (option && DONE_PATTERN.test(option.value)) return true
    }
  }
  return false
}

/** X-5 card→todo: mirror the card's completion onto its linked task. */
export async function syncCardCompletionToTodo(db: D1Database, card: ProjectCard, properties: readonly { id: string, type: string, options: { id: string, value: string }[] }[], now: number): Promise<void> {
  const row = await db.prepare('SELECT todo_id, user_id FROM project_todo_links WHERE card_id = ?1').bind(card.id).first<{ todo_id: string, user_id: string }>()
  if (!row) return
  const done = cardIsDone(card, properties)
  await db.prepare('UPDATE todos_tasks SET status = ?1, completed_at = ?2 WHERE id = ?3 AND user_id = ?4')
    .bind(done ? 'done' : 'todo', done ? now : null, row.todo_id, row.user_id).run()
}

/** X-5 todo→card: mirror a task's completion onto the linked card's checkbox/status property. */
export async function syncTodoCompletionToCard(db: D1Database, todoId: string, done: boolean, now: number): Promise<void> {
  const row = await db.prepare('SELECT card_id FROM project_todo_links WHERE todo_id = ?1').bind(todoId).first<{ card_id: string }>()
  if (!row) return
  const card = await getProjectCard(db, row.card_id)
  if (!card) return
  const { results } = await db.prepare('SELECT id, type, options FROM project_properties WHERE board_id = ?1').bind(card.boardId).all<{ id: string, type: string, options: string }>()
  const checkbox = results.find((p) => p.type === 'checkbox')
  if (checkbox) {
    await db.prepare(
      'INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(card_id, property_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).bind(card.id, checkbox.id, done ? 'true' : 'false', now).run()
    return
  }
  const select = results.find((p) => p.type === 'select')
  if (select) {
    const options = JSON.parse(select.options) as { id: string, value: string }[]
    const doneOption = options.find((o) => DONE_PATTERN.test(o.value))
    const target = done ? doneOption : options.find((o) => !DONE_PATTERN.test(o.value))
    if (target) {
      await db.prepare(
        'INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(card_id, property_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).bind(card.id, select.id, target.id, now).run()
    }
  }
}