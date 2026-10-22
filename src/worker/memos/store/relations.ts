import type { MemoRelation } from '@shared/memos/types'
import { ApiError } from '../../lib/errors'
import { parseIdList } from './fields'
import {
  BATCH_ID_CHUNK,
  chunkValues,
  loadMemoRow,
  type RelationRow,
} from './hydrate'

export interface MemoRelationsFields {
  relatedMemoIds?: unknown
}

export interface MemoRelationsPair {
  outgoing: MemoRelation[]
  incoming: MemoRelation[]
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export async function resolveRelatedMemoIds(
  db: D1Database,
  userId: string,
  value: unknown,
  memoId: string,
): Promise<string[]> {
  const ids = parseIdList(value, 'relatedMemoIds').filter((id) => id !== memoId)
  if (!ids.length) return []
  const found = new Set<string>()
  for (const chunk of chunkValues(ids, BATCH_ID_CHUNK)) {
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const { results } = await db
      .prepare(`SELECT id FROM memos_items WHERE user_id = ?1 AND id IN (${placeholders})`)
      .bind(userId, ...chunk)
      .all<{ id: string }>()
    for (const row of results) found.add(row.id)
  }
  for (const id of ids) {
    if (!found.has(id)) throw ApiError.badRequest(`Related memo ${id} was not found`)
  }
  return ids
}

async function loadRelations(
  db: D1Database,
  userId: string,
  id: string,
): Promise<MemoRelationsPair> {
  const results = await db.batch([
    db
      .prepare(
        `SELECT r.memo_id, r.related_memo_id, r.created_at, m.snippet AS related_snippet
           FROM memos_relations r
           JOIN memos_items m ON m.id = r.related_memo_id AND m.user_id = ?2
          WHERE r.memo_id = ?1
          ORDER BY r.created_at ASC, r.related_memo_id ASC`,
      )
      .bind(id, userId),
    db
      .prepare(
        `SELECT r.memo_id, r.related_memo_id, r.created_at, m.snippet AS related_snippet
           FROM memos_relations r
           JOIN memos_items m ON m.id = r.memo_id AND m.user_id = ?2
          WHERE r.related_memo_id = ?1
          ORDER BY r.created_at ASC, r.memo_id ASC`,
      )
      .bind(id, userId),
  ])
  const outgoingRows = (results[0]?.results as RelationRow[] | undefined) ?? []
  const incomingRows = (results[1]?.results as RelationRow[] | undefined) ?? []
  return {
    outgoing: outgoingRows.map((row) => ({
      memoId: row.memo_id,
      relatedMemoId: row.related_memo_id,
      relatedSnippet: row.related_snippet ?? '',
      createdAt: row.created_at,
    })),
    incoming: incomingRows.map((row) => ({
      memoId: row.memo_id,
      relatedMemoId: row.related_memo_id,
      relatedSnippet: row.related_snippet ?? '',
      createdAt: row.created_at,
    })),
  }
}

export async function getMemoRelations(
  db: D1Database,
  userId: string,
  id: string,
): Promise<MemoRelationsPair | null> {
  if (!(await loadMemoRow(db, userId, id))) return null
  return loadRelations(db, userId, id)
}

export async function replaceMemoRelations(
  db: D1Database,
  userId: string,
  id: string,
  fields: MemoRelationsFields,
): Promise<MemoRelationsPair | null> {
  if (!(await loadMemoRow(db, userId, id))) return null
  if (fields.relatedMemoIds === undefined) {
    throw ApiError.badRequest('relatedMemoIds is required')
  }
  const relatedMemoIds = await resolveRelatedMemoIds(db, userId, fields.relatedMemoIds, id)
  const now = nowSeconds()
  await db.batch([
    db.prepare('DELETE FROM memos_relations WHERE memo_id = ?1').bind(id),
    ...relatedMemoIds.map((relatedMemoId) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO memos_relations (memo_id, related_memo_id, created_at) VALUES (?1, ?2, ?3)',
        )
        .bind(id, relatedMemoId, now),
    ),
    db
      .prepare('INSERT INTO memos_changes (user_id, kind, memo_id, at) VALUES (?1, ?2, ?3, ?4)')
      .bind(userId, 'memo', id, now),
  ])
  return loadRelations(db, userId, id)
}
