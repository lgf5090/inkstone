// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { errorResponse } from '../src/worker/lib/errors'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { notesRoutes } from '../src/worker/routes/notes'
import type { AppBindings } from '../src/worker/env'
import type { Note } from '../src/shared/types'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The HTTP shape of "turn this mention into a link", which the function-level tests in
 * `backlink-mentions.test.ts` do not cover: which status the reader gets back, and what is
 * left untouched when the row they clicked has already moved on.
 */
const USER = 'user-a'
const OTHER = 'user-b'
const TARGET_TITLE = 'Quarterly Retro Notes'

// The route checks the source id against the note-id grammar before it looks anything up,
// so every id here has to be shaped like one.
const id = (code: string) => (code + '0'.repeat(26)).slice(0, 26)
const TGT = id('tgt')
const SRC = id('src')
const QRT = id('qrt')
const FRG = id('frg')
const ZZS = id('zzs')

let sqlite: DatabaseSync
let app: Hono<AppBindings>
const env = { DB: null as unknown as D1Database }
const ctx = { waitUntil: () => {} } as ExecutionContext

function note(noteId: string, title: string, body: string, userId = USER) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count,
       char_count, is_pinned, is_starred, is_archived, position, content_hash,
       created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, '', 1, 0, 0, 0, 0, 0, 0, '', 1, 1, NULL)`,
  ).run(noteId, userId, title, title.toLowerCase(), body)
}

async function link(targetId: string, body: unknown) {
  const response = await app.fetch(
    new Request(`http://localhost/api/notes/${targetId}/link-mention`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env as never,
    ctx,
  )
  return { status: response.status, body: await response.json().catch(() => null) as unknown }
}

const contentOf = (noteId: string) => (sqlite.prepare('SELECT content FROM notes WHERE id = ?')
  .get(noteId) as { content: string }).content

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  env.DB = makeD1(sqlite)
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/api/notes', notesRoutes)
  note(TGT, TARGET_TITLE, 'the note being pointed at')
  note(SRC, 'Somewhere else', `notes about ${TARGET_TITLE} and ideas`)
})

describe('linking a mention over the api', () => {
  it('rewrites the source note and answers with the note it wrote', async () => {
    const { status, body } = await link(TGT, { sourceNoteId: SRC })
    expect(status).toBe(200)
    const answer = body as { status: string; note: Note }
    expect(answer.status).toBe('linked')
    expect(answer.note.content).toBe(`notes about [[${TARGET_TITLE}]] and ideas`)
    expect(answer.note.rev).toBe(2)
    expect(contentOf(SRC)).toBe(answer.note.content)
  })

  it('leaves a cursor behind for the other devices to pull', async () => {
    await link(TGT, { sourceNoteId: SRC })
    expect(sqlite.prepare('SELECT entity, entity_id, op FROM changes WHERE user_id = ?').all(USER))
      .toEqual([{ entity: 'note', entity_id: SRC, op: 'upsert' }])
  })

  it('keeps the text that was there before, so the reader can take it back', async () => {
    await link(TGT, { sourceNoteId: SRC })
    expect(sqlite.prepare('SELECT title, content FROM note_versions WHERE note_id = ?').all(SRC))
      .toEqual([{ title: 'Somewhere else', content: `notes about ${TARGET_TITLE} and ideas` }])
  })

  it('answers without touching anything when the mention has gone away', async () => {
    note(QRT, 'No mention', 'nothing relevant at all')
    expect(await link(TGT, { sourceNoteId: QRT })).toEqual({ status: 200, body: { status: 'no-mention' } })
    expect(contentOf(QRT)).toBe('nothing relevant at all')
    expect(sqlite.prepare('SELECT id FROM note_versions WHERE note_id = ?').all(QRT)).toEqual([])
  })

  it('refuses a source that is missing, malformed, or somebody else\'s', async () => {
    note(FRG, 'Not yours', `about ${TARGET_TITLE}`, OTHER)
    expect((await link(TGT, { sourceNoteId: 'short' })).status).toBe(400)
    expect((await link(TGT, {})).status).toBe(400)
    expect((await link(TGT, { sourceNoteId: ZZS })).status).toBe(404)
    expect((await link(TGT, { sourceNoteId: FRG })).status).toBe(404)
    expect(contentOf(FRG)).toBe(`about ${TARGET_TITLE}`)
    expect(contentOf(SRC)).toBe(`notes about ${TARGET_TITLE} and ideas`)
  })

  it('answers 404 for a target note the reader cannot see', async () => {
    expect((await link(ZZS, { sourceNoteId: SRC })).status).toBe(404)
    expect(contentOf(SRC)).toBe(`notes about ${TARGET_TITLE} and ideas`)
  })
})
