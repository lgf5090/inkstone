import { LIMITS } from '@shared/constants'
import { segmentCJK } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import { selectQueueUsersRoundRobin } from './metadata'

interface IndexableNote {
  id: string
  title: string
  content: string
  rev: number
  content_hash: string
  updated_at: number
}

const FTS_DRAIN_CURSOR_META_KEY = 'fts-index-drain-user-v1'

export const FTS_NOTE_MATCH_SQL = `notes_fts MATCH ('note_id : "' || replace(?1, '"', '""') || '"')`

export const FTS_USER_MATCH_SQL = `notes_fts MATCH ('user_id : "' || replace(?1, '"', '""') || '"')`


/**
 * Queues every live note for re-indexing in one statement. Rebuilding in the request path
 * costs ~3 round trips per 50 notes (600 trips for 10k notes) plus a full-text tokenize
 * pass, which cannot finish inside one invocation; the queue drains in the background.
 */
export async function queueAllNotesForFtsIndex(db: D1Database, userId: string): Promise<number> {
  const results = await db.batch([
    db.prepare(
      `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
       SELECT ?1, id, 'upsert', ?2 FROM notes WHERE user_id = ?1 AND deleted_at IS NULL
       ON CONFLICT(user_id, note_id) DO UPDATE SET kind = 'upsert', created_at = excluded.created_at`,
    ).bind(userId, Date.now()),
    db.prepare(`SELECT COUNT(*) AS n FROM fts_index_queue WHERE user_id = ?1`).bind(userId),
  ])
  return Number((results[1]?.results?.[0] as { n?: number } | undefined)?.n ?? 0)
}

/** Removes search rows whose note no longer exists or was deleted. */
export async function purgeStaleFtsRows(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM notes_fts WHERE ${FTS_USER_MATCH_SQL} AND notes_fts.user_id = ?1 AND NOT EXISTS (
         SELECT 1 FROM notes n WHERE n.id = notes_fts.note_id
           AND n.user_id = ?1 AND n.deleted_at IS NULL
       )`,
    )
    .bind(userId)
    .run()
}


export const FTS_DRAIN_DELAY_MS = 10_000
const FTS_DRAIN_BATCH = 5
export const FTS_DRAIN_ALL_BATCH = 250
const FTS_STATEMENT_BATCH = 75

interface FtsQueueRow {
  note_id: string
  kind: 'upsert' | 'delete'
  created_at: number
}

function buildFtsQueueItemStatements(
  db: D1Database,
  userId: string,
  item: FtsQueueRow,
  note: IndexableNote | undefined,
): D1PreparedStatement[] {
  const noteId = item.note_id
  const { kind, created_at: queueVersion } = item
  if (kind === 'delete' || !note) {
    const queueGuard = `EXISTS (SELECT 1 FROM fts_index_queue
      WHERE user_id = ?3 AND note_id = ?4 AND kind = ?5 AND created_at = ?6)`
    return [
      db.prepare(
        `DELETE FROM notes_fts WHERE ${FTS_NOTE_MATCH_SQL} AND note_id = ?1 AND user_id = ?2 AND ${queueGuard}`,
      ).bind(noteId, userId, userId, noteId, kind, queueVersion),
      db.prepare(
        `DELETE FROM fts_index_queue
          WHERE user_id = ?1 AND note_id = ?2 AND kind = ?3 AND created_at = ?4`,
      ).bind(userId, noteId, kind, queueVersion),
    ]
  }
  const guard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
      AND rev = ?3 AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const guardValues = [noteId, userId, note.rev, note.content_hash, note.title, note.updated_at] as const
  const queueGuard = `EXISTS (SELECT 1 FROM fts_index_queue
    WHERE user_id = ?7 AND note_id = ?8 AND kind = ?9 AND created_at = ?10)`
  const processGuard = `${guard} AND ${queueGuard}`
  const processGuardValues = [...guardValues, userId, noteId, kind, queueVersion] as const
  return [
    db
      .prepare(`DELETE FROM notes_fts WHERE ${FTS_NOTE_MATCH_SQL} AND note_id = ?1 AND user_id = ?2 AND ${shiftPlaceholders(processGuard, 2)}`)
      .bind(noteId, userId, ...processGuardValues),
    db
      .prepare(
        `INSERT INTO notes_fts (note_id, user_id, title, body)
         SELECT ?1, ?2, ?3, ?4 WHERE ${shiftPlaceholders(processGuard, 4)}`,
      )
      .bind(
        noteId,
        userId,
        segmentCJK(note.title),
        segmentCJK(truncateText(note.content, LIMITS.ftsContentChars)),
        ...processGuardValues,
      ),
    db.prepare(
      `DELETE FROM fts_index_queue
        WHERE user_id = ?1 AND note_id = ?2 AND kind = ?3 AND created_at = ?4
          AND ${shiftPlaceholders(guard, 4)}`,
    ).bind(userId, noteId, kind, queueVersion, ...guardValues),
  ]
}

export async function drainFtsQueue(
  db: D1Database,
  userId: string,
  max = FTS_DRAIN_BATCH,
  ignoreDelay = false,
): Promise<number> {
  const cutoff = ignoreDelay ? Date.now() : Date.now() - FTS_DRAIN_DELAY_MS
  const { results } = await db
    .prepare(
      `SELECT note_id, kind, created_at FROM fts_index_queue
        WHERE user_id = ?1 AND created_at <= ?2
        ORDER BY created_at ASC LIMIT ?3`,
    )
    .bind(userId, cutoff, max)
    .all<FtsQueueRow>()
  if (!results.length) return 0

  const upsertIds = results
    .filter((item) => item.kind === 'upsert')
    .map((item) => item.note_id)
  const notes = new Map<string, IndexableNote>()
  if (upsertIds.length) {
    const { results: noteRows } = await db
      .prepare(
        `SELECT id, title, substr(content, 1, ?3) AS content, rev, content_hash, updated_at FROM notes
          WHERE user_id = ?1 AND deleted_at IS NULL
            AND id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(userId, JSON.stringify(upsertIds), LIMITS.ftsContentChars)
      .all<IndexableNote>()
    for (const note of noteRows) notes.set(note.id, note)
  }

  let statements: D1PreparedStatement[] = []
  for (const item of results) {
    const itemStatements = buildFtsQueueItemStatements(db, userId, item, notes.get(item.note_id))
    if (statements.length && statements.length + itemStatements.length > FTS_STATEMENT_BATCH) {
      await db.batch(statements)
      statements = []
    }
    statements.push(...itemStatements)
  }
  if (statements.length) await db.batch(statements)
  return results.length
}

export async function drainAllFtsQueues(db: D1Database, maxUsers = 20): Promise<number> {
  const users = await selectQueueUsersRoundRobin(
    db,
    'fts_index_queue',
    FTS_DRAIN_CURSOR_META_KEY,
    maxUsers,
  )
  let processed = 0
  for (const user_id of users) {
    processed += await drainFtsQueue(db, user_id, FTS_DRAIN_ALL_BATCH)
  }
  return processed
}

function shiftPlaceholders(sql: string, offset: number): string {
  return sql.replace(/\?(\d+)/g, (_match, value: string) => `?${Number(value) + offset}`)
}
