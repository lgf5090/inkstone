import { parseNoteCheckboxes } from '@shared/todos/note-parse'

const PAGE_SIZE = 500
const META_KEY = 'note-task-reminders-v1'

export function noteTaskReminderRows(content: string, noteId: string, deleted = false) {
  return deleted ? [] : parseNoteCheckboxes(content)
    .filter((box) => box.title && box.due)
    .map((box) => ({
      id: `ntr_${noteId}_${box.line}`,
      noteId,
      lineNumber: box.line,
      title: box.title.slice(0, 500),
      dueDay: box.due,
      completed: box.done,
    }))
}

export async function backfillNoteTaskReminders(db: D1Database): Promise<void> {
  const complete = await db.prepare('SELECT value FROM app_meta WHERE key = ?1').bind(META_KEY).first<{ value: string }>()
  if (complete?.value === 'done') return
  let cursor = ''
  while (true) {
    const { results } = await db.prepare(
      `SELECT id, user_id, content FROM notes WHERE id > ?1 ORDER BY id ASC LIMIT ?2`,
    ).bind(cursor, PAGE_SIZE).all<{ id: string; user_id: string; content: string }>()
    if (!results.length) break
    const statements: D1PreparedStatement[] = []
    for (const note of results) {
      const rows = noteTaskReminderRows(note.content, note.id)
      statements.push(
        db.prepare('DELETE FROM note_task_reminders WHERE user_id = ?1 AND note_id = ?2').bind(note.user_id, note.id),
        db.prepare(`INSERT INTO note_task_reminders
          (user_id, id, note_id, line_number, title, due_day, completed, updated_at)
          SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.noteId'),
                 json_extract(value, '$.lineNumber'), json_extract(value, '$.title'),
                 json_extract(value, '$.dueDay'), json_extract(value, '$.completed'), 1
            FROM json_each(?2)`).bind(note.user_id, JSON.stringify(rows)),
      )
    }
    for (let offset = 0; offset < statements.length; offset += 80) {
      await db.batch(statements.slice(offset, offset + 80))
    }
    cursor = results[results.length - 1]!.id
  }
  await db.prepare(`INSERT INTO app_meta (key, value) VALUES (?1, 'done')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(META_KEY).run()
}
