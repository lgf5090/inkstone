// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { buildNoteDerivedStatements } from '../src/worker/db/writes'
import { backfillNoteTaskReminders } from '../src/worker/db/note-task-reminders'
import type { Env } from '../src/worker/env'
import { sweepNoteTaskReminders } from '../src/worker/notes/task-reminders'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const NOTE = 'a'.repeat(26)
const NOW = Date.parse('2026-11-25T12:00:00Z')
const OPEN_TASK = '- [ ] 提交周报 [due:: 2026-11-25]'

let sqlite: DatabaseSync
let db: D1Database
let env: Env

async function derive(content: string): Promise<void> {
  const built = buildNoteDerivedStatements({ db, userId: USER, noteId: NOTE, title: 'Tasks', content, ftsEnabled: false })
  await db.batch(built.statements)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  env = testBindings(db)
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
    VALUES (?, 'owner', 'hash', 'owner', 'Owner', '', 'owner', '{}', 1, 1)`).run(USER)
  sqlite.prepare(`INSERT INTO chat_settings (user_id, config, updated_at)
    VALUES (?, '{"language":"zh-CN","timezone":"UTC"}', 1)`).run(USER)
  sqlite.prepare(`INSERT INTO notes
    (id, user_id, title, content, excerpt, rev, word_count, char_count, position, content_hash, created_at, updated_at)
    VALUES (?, ?, 'Tasks', ?, '', 1, 1, 1, 0, '', 1, 1)`).run(NOTE, USER, OPEN_TASK)
})

describe('note task reminders', () => {
  it('backfills reminders for notes written before the feature existed', async () => {
    await backfillNoteTaskReminders(db)
    expect(sqlite.prepare('SELECT note_id, due_day FROM note_task_reminders').get())
      .toEqual({ note_id: NOTE, due_day: '2026-11-25' })
    await backfillNoteTaskReminders(db)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM note_task_reminders').get()).toEqual({ count: 1 })
  })

  it('derives due checkboxes and delivers each reminder only once', async () => {
    await derive(OPEN_TASK)
    expect(sqlite.prepare('SELECT title, due_day, completed FROM note_task_reminders').get())
      .toEqual({ title: '提交周报', due_day: '2026-11-25', completed: 0 })

    const first = await sweepNoteTaskReminders(env, NOW)
    expect(first.sent).toBe(1)
    expect(sqlite.prepare('SELECT link, title FROM chat_notifications').get())
      .toEqual({ link: `note:${NOTE}`, title: '笔记任务到期 · 提交周报' })
    const second = await sweepNoteTaskReminders(env, NOW + 60_000)
    expect(second.sent).toBe(0)
  })

  it('removes stale reminders and does not notify completed or deleted tasks', async () => {
    await derive(OPEN_TASK)
    await derive('- [x] 提交周报 [due:: 2026-11-25]')
    expect((await sweepNoteTaskReminders(env, NOW)).sent).toBe(0)

    await derive('- [ ] 提交周报 [due:: 2026-11-25]')
    sqlite.prepare('UPDATE notes SET deleted_at = 2 WHERE id = ?').run(NOTE)
    expect((await sweepNoteTaskReminders(env, NOW)).sent).toBe(0)
    await derive('No tasks left')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM note_task_reminders').get()).toEqual({ count: 0 })
  })

  it('waits until the due day in the account timezone', async () => {
    sqlite.prepare("UPDATE chat_settings SET config = json_set(config, '$.timezone', 'America/Los_Angeles') WHERE user_id = ?").run(USER)
    await derive('- [ ] 明天任务 📅 2026-11-26')
    const result = await sweepNoteTaskReminders(env, NOW)
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
  })
})
