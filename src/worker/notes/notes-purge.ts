import { aiDeleteNeededSql } from '../mcp/ai-search'
import { FTS_QUEUE_CONFLICT_SQL, LINK_TARGET_SUBQUERY } from '../db/writes'

/**
 * The dependent-table cleanup for one page of trashed note ids, in the order the cascade
 * needs: link retargeting before the notes go, share sessions before their shares.
 * Statements bind `?1` = account, `?2` = JSON id page, `?3` = timestamp.
 *
 * Every child-table write re-checks that the note is *still* trashed. The page is read before the
 * batch runs, so another device can restore one of its notes in between; without the guard that
 * batch would strip the tags, versions, shares and links of a note whose row itself survives (the
 * final delete already carries the same `deleted_at IS NOT NULL` predicate).
 *
 * A free function rather than a method because the bulk purge builds it per page and the batch test
 * builds it directly: neither wants a store that exists only to hold a connection.
 */
export function trashPurgeStatements(
  db: D1Database,
  userId: string,
  idsJson: string,
  now: number,
  ftsEnabled: boolean,
): D1PreparedStatement[] {
  const inTrash = `IN (SELECT value FROM json_each(?2))`
  const stillTrashed = (idColumn: string) =>
    `EXISTS (SELECT 1 FROM notes still_trashed
       WHERE still_trashed.user_id = ?1 AND still_trashed.id = ${idColumn}
         AND still_trashed.deleted_at IS NOT NULL)`
  const statements = [
    db.prepare(
      `DELETE FROM mcp_operations WHERE user_id = ?1 AND EXISTS (
         SELECT 1 FROM json_each(?2) e WHERE instr(mcp_operations.response_json, e.value) > 0
           AND ${stillTrashed('e.value')})`,
    ).bind(userId, idsJson),
    db.prepare(
      `DELETE FROM note_tags WHERE note_id ${inTrash} AND ${stillTrashed('note_tags.note_id')}`,
    ).bind(userId, idsJson),
    db.prepare(
      `DELETE FROM links WHERE user_id = ?1 AND source_note_id ${inTrash}
         AND ${stillTrashed('links.source_note_id')}`,
    ).bind(userId, idsJson),
    db.prepare(
      `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
        WHERE user_id = ?1 AND target_note_id ${inTrash}
          AND ${stillTrashed('links.target_note_id')}`,
    ).bind(userId, idsJson),
    db.prepare(
      `DELETE FROM note_versions WHERE user_id = ?1 AND note_id ${inTrash}
         AND ${stillTrashed('note_versions.note_id')}`,
    ).bind(userId, idsJson),
    db.prepare(
      `DELETE FROM share_asset_sessions WHERE slug IN (
         SELECT slug FROM shares WHERE user_id = ?1 AND note_id ${inTrash}
           AND ${stillTrashed('shares.note_id')}
       )`,
    ).bind(userId, idsJson),
    db.prepare(
      `DELETE FROM shares WHERE user_id = ?1 AND note_id ${inTrash}
         AND ${stillTrashed('shares.note_id')}`,
    ).bind(userId, idsJson),
    db.prepare(
      `UPDATE attachments SET note_id = NULL WHERE user_id = ?1 AND note_id ${inTrash}
         AND ${stillTrashed('attachments.note_id')}`,
    ).bind(userId, idsJson),
    // The same chat-side cascade `purge` runs for one note; see the comment there for why each column is
    // nulled and why `chat_note_writes` is deleted instead.
    db.prepare(
      `UPDATE chat_artifacts SET note_id = NULL WHERE user_id = ?1 AND note_id ${inTrash}
         AND ${stillTrashed('chat_artifacts.note_id')}`,
    ).bind(userId, idsJson),
    db.prepare(
      `UPDATE chat_conversations SET note_id = NULL WHERE user_id = ?1 AND note_id ${inTrash}
         AND ${stillTrashed('chat_conversations.note_id')}`,
    ).bind(userId, idsJson),
    db.prepare(
      `DELETE FROM chat_note_writes WHERE user_id = ?1 AND note_id ${inTrash}
         AND ${stillTrashed('chat_note_writes.note_id')}`,
    ).bind(userId, idsJson),
    db.prepare(
      `UPDATE chat_memories SET note_id = NULL WHERE user_id = ?1 AND note_id ${inTrash}
         AND ${stillTrashed('chat_memories.note_id')}`,
    ).bind(userId, idsJson),
    db.prepare(
      `UPDATE chat_runs SET note_id = NULL WHERE user_id = ?1 AND note_id ${inTrash}
         AND ${stillTrashed('chat_runs.note_id')}`,
    ).bind(userId, idsJson),
    db.prepare(
      `DELETE FROM import_mappings WHERE user_id = ?1 AND entity = 'note' AND target_id ${inTrash}
         AND ${stillTrashed('import_mappings.target_id')}`,
    ).bind(userId, idsJson),
  ]
  if (ftsEnabled) {
    statements.push(
      db.prepare(
        `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
         SELECT ?1, id, 'delete', ?3
           FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id ${inTrash}
         ${FTS_QUEUE_CONFLICT_SQL}`,
      ).bind(userId, idsJson, now),
    )
  }
  statements.push(
    db.prepare(
      `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
       SELECT ?1, id, 'delete', ?3
         FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id ${inTrash}
           AND ${aiDeleteNeededSql('?1', 'notes.id')}`,
    ).bind(userId, idsJson, now),
    db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', id, 'delete', ?3
         FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id ${inTrash}`,
    ).bind(userId, idsJson, now),
    db.prepare(
      `DELETE FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id ${inTrash}`,
    ).bind(userId, idsJson),
  )
  return statements
}
