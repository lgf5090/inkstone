// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { notesRoutes } from '../src/worker/routes/notes'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const TARGET = 't'.repeat(26)
const SOURCE_A = 'a'.repeat(26)
const SOURCE_B = 'b'.repeat(26)
const OTHER_USER = 'c'.repeat(26)

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: { DB: D1Database }
const ctx: ExecutionContext = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} }

function seedNote(id: string, title: string, content: string, userId = USER): void {
  sqlite.prepare(`INSERT INTO notes
    (id, user_id, title, content, excerpt, rev, word_count, char_count, position, content_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', 1, 1, 1, 0, '', 1, 1)`).run(id, userId, title, content)
}

async function merge(body: Record<string, unknown>): Promise<Response> {
  return app.fetch(new Request(`http://localhost/api/notes/${TARGET}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env as never, ctx)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = { DB: makeD1(sqlite) }
  app = new Hono<AppBindings>()
  app.onError((error, context) => errorResponse(context, error))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/api/notes', notesRoutes)
  seedNote(TARGET, 'Target', '---\ntags: [target]\n---\nTarget body')
  seedNote(SOURCE_A, 'Source A', '---\ntags: [source]\nstatus: active\n---\nSource body A')
  seedNote(SOURCE_B, 'Source B', 'Source body B\n\n[[Source A]]')
  seedNote(OTHER_USER, 'Foreign', 'Foreign body', OTHER_USER)
  sqlite.prepare(`INSERT INTO attachments
    (id, user_id, note_id, filename, mime, size, sha256, object_key, storage, created_at)
    VALUES ('attachment-a', ?, ?, 'a.txt', 'text/plain', 1, 'hash-a', 'key-a', 'r2', 1)`).run(USER, SOURCE_A)
  sqlite.prepare(`INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
    VALUES ('version-a', ?, ?, 'Source A', 'Old A', 5, 1)`).run(SOURCE_A, USER)
  sqlite.prepare(`INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id)
    VALUES (?, 'source-a', 'Source A', ?, ?)`).run(SOURCE_B, SOURCE_A, USER)
  sqlite.prepare(`INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id)
    VALUES (?, 'target', 'Target', ?, ?)`).run(SOURCE_A, TARGET, USER)
})

describe('note merge', () => {
  it('merges bodies and tags, moves dependents, retargets links and purges sources atomically', async () => {
    const response = await merge({ rev: 1, sources: [{ id: SOURCE_A, rev: 1 }, { id: SOURCE_B, rev: 1 }] })
    expect(response.status).toBe(200)
    const body = await response.json() as { note: { content: string; rev: number; tags: string[] }; merged: number }
    expect(body.merged).toBe(2)
    expect(body.note.rev).toBe(2)
    expect(body.note.tags).toEqual(['source', 'target'])
    expect(body.note.content.match(/- merged/g)).toBeNull()
    expect(body.note.content.match(/- source/g)).toHaveLength(1)
    expect(body.note.content).toContain('Target body')
    expect(body.note.content).toContain('## Source A\n\nSource body A')
    expect(body.note.content).toContain('## Source B\n\nSource body B')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM notes WHERE id IN (?, ?)').get(SOURCE_A, SOURCE_B)).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT note_id FROM attachments WHERE id = ?').get('attachment-a')).toEqual({ note_id: TARGET })
    expect(sqlite.prepare('SELECT note_id FROM note_versions WHERE id = ?').get('version-a')).toEqual({ note_id: TARGET })
    expect(sqlite.prepare('SELECT target_note_id, target_key, target_title FROM links WHERE source_note_id = ?').get(TARGET))
      .toEqual({ target_note_id: TARGET, target_key: 'target', target_title: 'Target' })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM links WHERE source_note_id = ?').get(SOURCE_A)).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM note_properties WHERE note_id IN (?, ?)').get(SOURCE_A, SOURCE_B)).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM notes WHERE id = ? AND user_id = ?').get(OTHER_USER, OTHER_USER)).toEqual({ n: 1 })
  })

  it('rejects a stale source without changing the target or deleting anything', async () => {
    const response = await merge({ rev: 1, sources: [{ id: SOURCE_A, rev: 2 }] })
    expect(response.status).toBe(409)
    expect(sqlite.prepare('SELECT rev, content FROM notes WHERE id = ?').get(TARGET)).toEqual({
      rev: 1,
      content: '---\ntags: [target]\n---\nTarget body',
    })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM notes WHERE id = ?').get(SOURCE_A)).toEqual({ n: 1 })
  })

  it('refuses encrypted sources and foreign source ids', async () => {
    sqlite.prepare('UPDATE notes SET is_encrypted = 1 WHERE id = ?').run(SOURCE_A)
    expect((await merge({ rev: 1, sources: [{ id: SOURCE_A, rev: 1 }] })).status).toBe(409)
    expect((await merge({ rev: 1, sources: [{ id: OTHER_USER, rev: 1 }] })).status).toBe(404)
  })
})
