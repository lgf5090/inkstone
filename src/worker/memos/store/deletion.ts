import type { AttachmentObjectStorage } from '../../attachments'
import { loadMemoRow } from './hydrate'

export interface MemoAttachmentObjectRef {
  storage: AttachmentObjectStorage
  key: string
}

export interface MemoDeleteResult {
  attachmentObjects: MemoAttachmentObjectRef[]
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export async function deleteMemo(
  db: D1Database,
  userId: string,
  id: string,
): Promise<MemoDeleteResult | null> {
  const current = await loadMemoRow(db, userId, id)
  if (!current) return null

  const scope = `(SELECT id FROM memos_items WHERE user_id = ?1 AND (id = ?2 OR parent_id = ?2))`
  const { results: attachmentRows } = await db
    .prepare(
      `SELECT a.storage, a.storage_key, a.thumbnail_key
         FROM memos_attachments a
        WHERE a.user_id = ?1 AND a.memo_id IN ${scope}`,
    )
    .bind(userId, id)
    .all<{ storage: AttachmentObjectStorage; storage_key: string; thumbnail_key: string | null }>()

  const results = await db.batch([
    db
      .prepare(`DELETE FROM memos_attachments WHERE user_id = ?1 AND memo_id IN ${scope}`)
      .bind(userId, id),
    db
      .prepare(
        `DELETE FROM memos_relations
          WHERE memo_id IN ${scope} OR related_memo_id IN (SELECT id FROM memos_items
            WHERE user_id = ?3 AND (id = ?4 OR parent_id = ?4))`,
      )
      .bind(userId, id, userId, id),
    db.prepare(`DELETE FROM memos_reactions WHERE memo_id IN ${scope}`).bind(userId, id),
    db.prepare(`DELETE FROM memos_shares WHERE memo_id IN ${scope}`).bind(userId, id),
    db.prepare(`DELETE FROM memos_tags WHERE memo_id IN ${scope}`).bind(userId, id),
    db
      .prepare(
        `INSERT INTO memos_changes (user_id, kind, memo_id, at)
         SELECT ?1, ?3, ?2, ?4
          WHERE EXISTS (SELECT 1 FROM memos_items WHERE id = ?2 AND user_id = ?1)`,
      )
      .bind(userId, id, current.parent_id ? 'comment' : 'memo', nowSeconds()),
    db
      .prepare(`DELETE FROM memos_items WHERE user_id = ?1 AND (id = ?2 OR parent_id = ?2)`)
      .bind(userId, id),
  ])

  if (!results[6]?.meta.changes) return null

  const attachmentObjects: MemoAttachmentObjectRef[] = []
  for (const row of attachmentRows) {
    attachmentObjects.push({ storage: row.storage, key: row.storage_key })
    if (row.thumbnail_key) attachmentObjects.push({ storage: row.storage, key: row.thumbnail_key })
  }
  return { attachmentObjects }
}
