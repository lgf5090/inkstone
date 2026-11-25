import { indexNoteProperties } from '@shared/note-properties'

const BACKFILL_PAGE_SIZE = 500
const BACKFILL_META_KEY = 'note-properties-index-v2'

export async function backfillNoteProperties(db: D1Database): Promise<void> {
  const complete = await db.prepare('SELECT value FROM app_meta WHERE key = ?1').bind(BACKFILL_META_KEY).first<{ value: string }>()
  if (complete?.value === 'done') return
  let cursor = ''
  while (true) {
    const { results } = await db.prepare(
      `SELECT id, user_id, content FROM notes WHERE id > ?1 ORDER BY id ASC LIMIT ?2`,
    ).bind(cursor, BACKFILL_PAGE_SIZE).all<{ id: string; user_id: string; content: string }>()
    if (!results.length) break
    const ids = results.map((row) => row.id)
    const placeholders = ids.map(() => '?').join(', ')
    const rows = results.flatMap((note) => indexNoteProperties(note.content).map((row) => ({
      ...row,
      userId: note.user_id,
      noteId: note.id,
    })))
    await db.batch([
      db.prepare(`DELETE FROM note_properties WHERE note_id IN (${placeholders})`).bind(...ids),
      db.prepare(`INSERT INTO note_properties
        (user_id, note_id, key, key_key, ordinal, kind, is_array, value_text, value_number, value_boolean, value_date)
        SELECT json_extract(value, '$.userId'), json_extract(value, '$.noteId'),
               json_extract(value, '$.key'), json_extract(value, '$.keyKey'),
               json_extract(value, '$.ordinal'), json_extract(value, '$.kind'), json_extract(value, '$.array'),
               json_extract(value, '$.text'), json_extract(value, '$.number'),
               json_extract(value, '$.boolean'), json_extract(value, '$.date')
          FROM json_each(?1)`).bind(JSON.stringify(rows)),
    ])
    cursor = ids[ids.length - 1]!
  }
  await db.prepare(`INSERT INTO app_meta (key, value) VALUES (?1, 'done')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(BACKFILL_META_KEY).run()
}
