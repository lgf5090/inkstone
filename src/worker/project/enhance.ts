/**
 * Board activity trail (X-7) and card dependencies (X-3). Activity rows are append-only facts about
 * who changed what; the dependency graph is a set of directed 'blocks' edges with cycle detection so
 * a board can never deadlock itself. Both reuse tables created with the core schema.
 */
import type { ProjectActivityEntry, ProjectCardLink, ProjectCardLinkKind } from '@shared/project/model'
import { newProjectId } from '@shared/project/limits'
import { ApiError } from '../lib/errors'

export type { ProjectActivityEntry, ProjectCardLink }

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