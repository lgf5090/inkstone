import type { ProjectBoard, ProjectCard, ProjectCardVersion, ProjectCardVersionDetail, ProjectCardVersionSnapshot, ProjectContent } from '@shared/project/model'
import type { ProjectCardPatchInput } from '@shared/project/validation'
import { ProjectCardVersionSnapshotSchema } from '@shared/project/validation'
import { newProjectId, PROJECT_LIMITS } from '@shared/project/limits'
import type { ProjectContentOrder } from '@shared/project/content-order'
import { ApiError } from '../lib/errors'
import type { AppBindings } from '../env'
import { getProjectCard, cardPatchStatements, assertProjectParent } from './cards'
import { rowToContent, type ContentRow } from './bundle'
import { readBoardProperties } from './boards'
import { projectRelationTargets } from './relations'
import { applyCardValueEffects } from './enhance'
import { assertProjectBatchStatementLimit, projectIdChunks, projectPlaceholders } from './d1'

const MAX_VERSION_BYTES = 1_500_000

interface VersionRow {
  id: string
  card_id: string
  board_id: string
  actor_id: string
  title: string
  payload: string
  size: number
  created_at: number
}

function toVersion(row: VersionRow): ProjectCardVersion {
  return { id: row.id, cardId: row.card_id, title: row.title, actorId: row.actor_id, size: row.size, createdAt: row.created_at }
}

async function readVersionSnapshot(db: D1Database, cardId: string): Promise<{ card: ProjectCard, snapshot: ProjectCardVersionSnapshot }> {
  const card = await getProjectCard(db, cardId)
  if (!card) throw ApiError.notFound('Card not found')
  const { results } = await db
    .prepare('SELECT * FROM project_card_contents WHERE card_id = ?1 AND delete_at = 0 ORDER BY position, id')
    .bind(cardId)
    .all<ContentRow>()
  const snapshot: ProjectCardVersionSnapshot = {
    card: {
      title: card.title,
      icon: card.icon,
      parentId: card.parentId,
      contentOrder: card.contentOrder,
      values: card.values,
      recurrence: card.recurrence ?? null,
    },
    contents: results.map(rowToContent),
  }
  return { card, snapshot }
}

export async function createProjectCardVersion(
  db: D1Database,
  cardId: string,
  actorId: string,
  now: number,
): Promise<ProjectCardVersion | null> {
  const { card, snapshot } = await readVersionSnapshot(db, cardId)
  const payload = JSON.stringify(snapshot)
  const size = new TextEncoder().encode(payload).byteLength
  if (size > MAX_VERSION_BYTES) {
    console.warn('[inkstone] project card version skipped because the snapshot is too large:', cardId, size)
    return null
  }
  const id = newProjectId('activity')
  await db.prepare(
    'INSERT INTO project_card_versions (id, card_id, board_id, actor_id, title, payload, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
  ).bind(id, card.id, card.boardId, actorId, card.title, payload, size, now).run()
  await db.prepare(
    `DELETE FROM project_card_versions WHERE card_id = ?1 AND id NOT IN (
       SELECT id FROM project_card_versions WHERE card_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2
     )`,
  ).bind(card.id, PROJECT_LIMITS.cardVersions).run()
  return { id, cardId: card.id, title: card.title, actorId, size, createdAt: now }
}

export async function listProjectCardVersions(db: D1Database, cardId: string): Promise<ProjectCardVersion[]> {
  const { results } = await db
    .prepare('SELECT id, card_id, board_id, actor_id, title, payload, size, created_at FROM project_card_versions WHERE card_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2')
    .bind(cardId, PROJECT_LIMITS.cardVersions)
    .all<VersionRow>()
  return results.map(toVersion)
}

export async function getProjectCardVersion(db: D1Database, cardId: string, versionId: string): Promise<ProjectCardVersionDetail | null> {
  const row = await db.prepare('SELECT * FROM project_card_versions WHERE card_id = ?1 AND id = ?2').bind(cardId, versionId).first<VersionRow>()
  if (!row) return null
  const parsed = ProjectCardVersionSnapshotSchema.safeParse(JSON.parse(row.payload) as unknown)
  if (!parsed.success) throw ApiError.conflict('Card version snapshot is invalid')
  return { ...toVersion(row), snapshot: parsed.data }
}

function restoredContentOrder(
  order: ProjectContentOrder,
  contents: readonly ProjectContent[],
  commentIds: readonly string[],
): ProjectContentOrder {
  const contentIds = new Set(contents.map((content) => content.id))
  const comments = new Set(commentIds)
  const seen = new Set<string>()
  const allowed = (id: string): boolean => {
    if (seen.has(id) || (!contentIds.has(id) && !comments.has(id))) return false
    seen.add(id)
    return true
  }
  const restored = order
    .map((entry) => Array.isArray(entry) ? entry.filter(allowed) : allowed(entry) ? entry : null)
    .filter((entry): entry is string | string[] => entry !== null && (!Array.isArray(entry) || entry.length > 0))
  for (const commentId of commentIds) if (!seen.has(commentId)) restored.push(commentId)
  return restored
}

export async function restoreProjectCardVersion(
  db: D1Database,
  env: AppBindings['Bindings'],
  board: ProjectBoard,
  card: ProjectCard,
  version: ProjectCardVersionDetail,
  userId: string,
  now: number,
): Promise<ProjectCard> {
  const snapshot = version.snapshot
  if (snapshot.contents.some((content) => content.cardId !== card.id || content.boardId !== card.boardId)) {
    throw ApiError.conflict('Card version snapshot is invalid')
  }
  if (snapshot.card.parentId) await assertProjectParent(db, card, snapshot.card.parentId)
  const properties = await readBoardProperties(db, card.boardId)
  const relationTargets = projectRelationTargets(properties)
  const [{ results: commentRows }, { results: currentRows }] = await Promise.all([
    db.prepare('SELECT id FROM project_comments WHERE card_id = ?1 AND delete_at = 0 ORDER BY create_at, id').bind(card.id).all<{ id: string }>(),
    db.prepare('SELECT id FROM project_card_contents WHERE card_id = ?1 AND delete_at = 0').bind(card.id).all<{ id: string }>(),
  ])
  const snapshotIds = new Set(snapshot.contents.map((content) => content.id))
  const values: Record<string, string | null> = {}
  for (const propertyId of Object.keys(card.values)) if (!(propertyId in snapshot.card.values)) values[propertyId] = null
  Object.assign(values, snapshot.card.values)
  const patch: ProjectCardPatchInput = {
    title: snapshot.card.title,
    icon: snapshot.card.icon,
    parentId: snapshot.card.parentId,
    contentOrder: restoredContentOrder(snapshot.card.contentOrder, snapshot.contents, commentRows.map((row) => row.id)),
    values,
    recurrence: snapshot.card.recurrence,
  }
  const { contentOrder, ...cardPatch } = patch
  const statements = cardPatchStatements(db, card, cardPatch, userId, now, relationTargets)
  statements.push(db.prepare('UPDATE project_cards SET content_order = ?1, content_order_revision = content_order_revision + 1 WHERE id = ?2')
    .bind(JSON.stringify(contentOrder), card.id))
  const extraIds = currentRows.filter((row) => !snapshotIds.has(row.id)).map((row) => row.id)
  for (const chunk of projectIdChunks(extraIds)) {
    statements.push(db.prepare(`UPDATE project_card_contents SET delete_at = ?1, modified_by = ?2, update_at = ?1 WHERE id IN (${projectPlaceholders(chunk.length, 3)}) AND card_id = ?${chunk.length + 3}`)
      .bind(now, userId, ...chunk, card.id))
  }
  for (const content of snapshot.contents) {
    statements.push(db.prepare(
      `INSERT INTO project_card_contents
        (id, card_id, board_id, type, title, fields, position, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type, title = excluded.title, fields = excluded.fields, position = excluded.position,
         modified_by = excluded.modified_by, update_at = excluded.update_at, delete_at = 0
       WHERE project_card_contents.card_id = excluded.card_id`,
    ).bind(
      content.id, content.cardId, content.boardId, content.type, content.title, JSON.stringify(content.fields),
      content.position, content.createdBy, userId, content.createAt, now,
    ))
  }
  assertProjectBatchStatementLimit(statements.length)
  await db.batch(statements)
  const restored = await getProjectCard(db, card.id)
  if (!restored) throw ApiError.notFound('Card not found')
  await applyCardValueEffects(db, env, board, card, restored, properties, userId, now, new Set())
  return restored
}
