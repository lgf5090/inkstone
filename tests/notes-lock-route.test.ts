// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { notesRoutes } from '../src/worker/routes/notes'
import { SearchStore } from '../src/worker/search/store'
import { emptyParsedQuery } from '../src/shared/search-query'
import { NoteLockSession, sealNote } from '../src/shared/crypto'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: { DB: D1Database }
const ctx: ExecutionContext = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} }

function seedNote(): void {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, is_encrypted, position, content_hash, created_at, updated_at)
     VALUES ('n1', ?, 'Secret title', 'visible body\nmore words', 'visible body', 1, 2, 12, 0, 0, 0, 0, 0, '', 1, 1)`,
  ).run(USER)
  sqlite.prepare(
    `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
     VALUES ('v1', 'n1', ?, 'Secret title', 'older plaintext', 15, 1)`,
  ).run(USER)
  sqlite.prepare(
    `INSERT INTO shares (slug, note_id, user_id, created_at) VALUES ('s1', 'n1', ?, 1)`,
  ).run(USER)
  sqlite.prepare(
    `INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id)
     VALUES ('n2', 'secret-title', 'Secret title', 'n1', ?)`,
  ).run(USER)
  sqlite.prepare(
    `INSERT INTO ai_note_embeddings (user_id, note_id, model, vector, indexed_at)
     VALUES (?, 'n1', 'test', '[]', 1)`,
  ).run(USER)
  sqlite.prepare(
    `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at) VALUES (?, 'n1', 'upsert', 1)`,
  ).run(USER)
  sqlite.prepare(`INSERT INTO notes_fts (note_id, user_id, title, body) VALUES ('n1', ?, 'Secret title', 'visible body')`).run(USER)
}

async function patch(body: Record<string, unknown>): Promise<Response> {
  return app.fetch(new Request('http://localhost/api/notes/n1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env as never, ctx)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.exec('CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(note_id, user_id, title, body, tokenize = "unicode61 remove_diacritics 2")')
  env = { DB: makeD1(sqlite) }
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: true })
    await next()
  })
  app.route('/api/notes', notesRoutes)
  seedNote()
})

describe('a sealed note writes only ciphertext', () => {
  it('stores envelopes, clears the derived row, and removes plaintext projections', async () => {
    const session = await NoteLockSession.create('pw', { iterations: 1_000 })
    const sealed = await sealNote(session, 'n1', { title: 'Secret title', content: 'visible body\nmore words' })

    const response = await patch({
      rev: 1,
      title: sealed.title,
      content: sealed.content,
      isEncrypted: true,
      quiet: true,
    })
    expect(response.status).toBe(200)
    const note = await response.json() as { isEncrypted: boolean; title: string; content: string; excerpt: string; wordCount: number }
    expect(note.isEncrypted).toBe(true)
    expect(note.title).toBe(sealed.title)
    expect(note.content).toBe(sealed.content)
    expect(note.excerpt).toBe('')
    expect(note.wordCount).toBe(0)

    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM note_versions WHERE note_id = 'n1'`).get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM links WHERE target_note_id = 'n1'`).get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ai_note_embeddings WHERE note_id = 'n1'`).get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM fts_index_queue WHERE note_id = 'n1'`).get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare(`SELECT is_enabled AS enabled FROM shares WHERE note_id = 'n1'`).get()).toMatchObject({ enabled: 0 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM notes_fts WHERE note_id = 'n1'`).get()).toMatchObject({ n: 0 })
  })

  it('refuses a plaintext text edit while the note is locked', async () => {
    const session = await NoteLockSession.create('pw', { iterations: 1_000 })
    const sealed = await sealNote(session, 'n1', { title: 'Secret title', content: 'visible body\nmore words' })
    expect((await patch({ rev: 1, title: sealed.title, content: sealed.content, isEncrypted: true })).status).toBe(200)

    const refused = await patch({ rev: 2, content: 'attacker plaintext' })
    expect(refused.status).toBe(409)
    const body = await refused.json() as { error: { details: { server: { content: string } } } }
    expect(body.error.details.server.content).toBe(sealed.content)
  })

  it('refuses an "encrypted" write whose fields are not envelopes', async () => {
    const response = await patch({ rev: 1, title: 'plain', content: 'plain', isEncrypted: true })
    expect(response.status).toBe(400)
  })

  it('refuses to duplicate a locked note', async () => {
    const session = await NoteLockSession.create('pw', { iterations: 1_000 })
    const sealed = await sealNote(session, 'n1', { title: 'Secret title', content: 'visible body' })
    expect((await patch({ rev: 1, title: sealed.title, content: sealed.content, isEncrypted: true })).status).toBe(200)
    const response = await app.fetch(new Request('http://localhost/api/notes/n1/duplicate', { method: 'POST' }), env as never, ctx)
    expect(response.status).toBe(409)
  })
})

describe('removing a lock returns the note to plaintext', () => {
  it('writes the decrypted text back and rebuilds the derived row', async () => {
    const session = await NoteLockSession.create('pw', { iterations: 1_000 })
    const sealed = await sealNote(session, 'n1', { title: 'Secret title', content: 'visible body\nmore words' })
    expect((await patch({ rev: 1, title: sealed.title, content: sealed.content, isEncrypted: true })).status).toBe(200)

    const opened = await patch({ rev: 2, title: 'Secret title', content: 'visible body\nmore words', isEncrypted: false })
    expect(opened.status).toBe(200)
    const note = await opened.json() as { isEncrypted: boolean; title: string; content: string; excerpt: string; wordCount: number }
    expect(note.isEncrypted).toBe(false)
    expect(note.title).toBe('Secret title')
    expect(note.content).toBe('visible body\nmore words')
    expect(note.excerpt).toBe('more words')
    expect(note.wordCount).toBeGreaterThan(0)
  })
})

describe('search ignores locked notes', () => {
  it('does not match an encrypted note by its title or body', async () => {
    const session = await NoteLockSession.create('pw', { iterations: 1_000 })
    const sealed = await sealNote(session, 'n1', { title: 'Secret title', content: 'visible body' })
    expect((await patch({ rev: 1, title: sealed.title, content: sealed.content, isEncrypted: true })).status).toBe(200)
    const store = new SearchStore(env.DB, USER)
    const rows = await store.likeNoteRows({ ...emptyParsedQuery(), terms: ['secret'] }, 10)
    expect(rows).toEqual([])
  })
})

describe('the lock column migration', () => {
  it('adds the column once under its own guarded number', () => {
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 266)
    expect(migration).toMatchObject({
      skipIfColumnExists: { table: 'notes', column: 'is_encrypted' },
      statements: ['ALTER TABLE notes ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0'],
    })
    // The fresh boot already builds the shape; the migration is the step for an existing database.
    expect(SCHEMA_STATEMENTS.join(';')).toMatch(/CREATE TABLE IF NOT EXISTS notes[\s\S]*is_encrypted/)
  })
})
