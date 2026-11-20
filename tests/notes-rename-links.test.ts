// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { errorResponse } from '../src/worker/lib/errors'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { notesRoutes } from '../src/worker/routes/notes'
import type { AppBindings } from '../src/worker/env'
import { normalizeLinkKey } from '../src/shared/markdown-utils'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const OLD_TITLE = 'Stable Link Target'
const NEW_TITLE = 'Renamed Link Target'
const id = (code: string) => (code + '0'.repeat(26)).slice(0, 26)
const A = id('aaa')
const B = id('bbb')
const SRC = id('sss')

let sqlite: DatabaseSync
let app: Hono<AppBindings>
const env = { DB: null as unknown as D1Database }
const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
}

function note(noteId: string, title: string, body: string, createdAt: number) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count,
       char_count, is_pinned, is_starred, is_archived, position, content_hash,
       created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, '', 1, 0, 0, 0, 0, 0, 0, '', ?, ?, NULL)`,
  ).run(noteId, USER, title, normalizeLinkKey(title), body, createdAt, createdAt)
}

function link(targetNoteId: string) {
  sqlite.prepare(
    'INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id) VALUES (?, ?, ?, ?, ?)',
  ).run(SRC, normalizeLinkKey(OLD_TITLE), OLD_TITLE, targetNoteId, USER)
}

async function renameWithContent(noteId: string, title: string): Promise<{ status: number, body: unknown }> {
  const response = await app.fetch(
    new Request(`http://localhost/api/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rev: 1, title, content: `# ${title}\n\nrenamed` }),
    }),
    env as never,
    ctx,
  )
  return { status: response.status, body: await response.json().catch(() => null) }
}

const noteRow = (noteId: string) => sqlite.prepare('SELECT title, title_key, content FROM notes WHERE id = ?')
  .get(noteId) as { title: string, title_key: string, content: string }
const linkTarget = () => (sqlite.prepare('SELECT target_note_id FROM links WHERE source_note_id = ?')
  .get(SRC) as { target_note_id: string | null }).target_note_id

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
})

describe('a title saved together with its content', () => {
  it('retargets the old-title link to the remaining duplicate instead of rewriting the source', async () => {
    note(A, OLD_TITLE, '# A', 1)
    note(B, OLD_TITLE, '# B', 2)
    note(SRC, 'Source', `[[${OLD_TITLE}]]`, 3)
    link(A)

    const response = await renameWithContent(A, NEW_TITLE)

    expect(response.status).toBe(200)
    expect(noteRow(A)).toMatchObject({ title: NEW_TITLE, title_key: normalizeLinkKey(NEW_TITLE) })
    expect(linkTarget()).toBe(B)
    expect(noteRow(SRC).content).toBe(`[[${OLD_TITLE}]]`)
  })

  it('rewrites the source text when no other note still answers to the old title', async () => {
    note(A, OLD_TITLE, '# A', 1)
    note(SRC, 'Source', `[[${OLD_TITLE}]]`, 2)
    link(A)

    const response = await renameWithContent(A, NEW_TITLE)

    expect(response.status).toBe(200)
    expect(noteRow(A)).toMatchObject({ title: NEW_TITLE, title_key: normalizeLinkKey(NEW_TITLE) })
    expect(noteRow(SRC).content).toBe(`[[${NEW_TITLE}]]`)
    expect(linkTarget()).toBe(A)
  })

  it('rewrites the source into a title that another note already carries', async () => {
    note(A, OLD_TITLE, '# A', 1)
    note(B, NEW_TITLE, '# B', 2)
    note(SRC, 'Source', `[[${OLD_TITLE}]]`, 3)
    link(A)

    const response = await renameWithContent(A, NEW_TITLE)

    expect(response.status).toBe(200)
    expect(noteRow(SRC).content).toBe(`[[${NEW_TITLE}]]`)
    expect(linkTarget()).toBe(A)
  })
})
