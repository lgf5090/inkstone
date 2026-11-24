// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'
import { ApiError } from '../src/worker/lib/errors'
import { listMcpAttachments } from '../src/worker/mcp/library'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const NOTE_A = 'a'.repeat(26)
const NOTE_B = 'b'.repeat(26)
const OTHER_USER = 'c'.repeat(26)
const id = (index: number) => String(index).padStart(26, '0')

function database(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, deleted_at INTEGER,
      is_archived INTEGER NOT NULL DEFAULT 0, is_encrypted INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0, folder_id TEXT,
      title TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '', rev INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, note_id TEXT,
      filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER, height INTEGER,
      created_at INTEGER NOT NULL);
    CREATE INDEX idx_attachments_user ON attachments(user_id, created_at DESC);
    CREATE INDEX idx_attachments_note ON attachments(note_id);
    CREATE INDEX idx_notes_user_updated ON notes(user_id, deleted_at, is_archived, updated_at DESC);
    CREATE TABLE ai_note_embeddings (user_id TEXT NOT NULL, note_id TEXT NOT NULL, vector BLOB NOT NULL,
      norm REAL, indexed_at INTEGER NOT NULL, PRIMARY KEY (user_id, note_id));
    CREATE INDEX idx_ai_embeddings_indexed ON ai_note_embeddings(user_id, indexed_at);
  `)
  return sqlite
}

function migrate(sqlite: DatabaseSync): void {
  const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 421)
  expect(migration).toBeDefined()
  sqlite.exec(migration!.statements.join(';\n'))
}

function seed(sqlite: DatabaseSync): void {
  sqlite.prepare('INSERT INTO notes (id, user_id) VALUES (?1, ?2)').run(NOTE_A, USER)
  sqlite.prepare('INSERT INTO notes (id, user_id) VALUES (?1, ?2)').run(NOTE_B, USER)
  const insert = sqlite.prepare(`INSERT INTO attachments
    (id, user_id, note_id, filename, mime, size, width, height, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
  for (let index = 0; index < 65; index++) {
    insert.run(id(index), USER, index % 3 === 0 ? NOTE_A : index % 3 === 1 ? NOTE_B : null,
      `file-${index}.bin`, 'application/octet-stream', index + 1, null, null, Math.floor(index / 3))
  }
  insert.run(id(100), OTHER_USER, NOTE_A, 'foreign.bin', 'application/octet-stream', 1, null, null, 999)
}

describe('MCP attachment keyset pagination', () => {
  it('walks tied timestamps exactly once and keeps working when newer rows arrive', async () => {
    const sqlite = database()
    migrate(sqlite)
    seed(sqlite)
    const db = makeD1(sqlite)
    const expected = sqlite.prepare(`SELECT id FROM attachments WHERE user_id = ?
      ORDER BY created_at DESC, id DESC`).all(USER).map((row) => (row as { id: string }).id)

    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await listMcpAttachments(db, USER, { limit: 7, cursor })
      seen.push(...page.attachments.map((entry) => entry.id))
      cursor = page.next_cursor ?? undefined
      if (seen.length === 7) {
        sqlite.prepare(`INSERT INTO attachments (id, user_id, note_id, filename, mime, size, created_at)
          VALUES (?1, ?2, NULL, 'new.bin', 'application/octet-stream', 1, 9999)`).run(id(101), USER)
      }
      expect(cursor === undefined || (typeof cursor === 'string' && cursor.startsWith('a1.created-desc.'))).toBe(true)
    } while (cursor)

    expect(seen).toEqual(expected)
    expect(new Set(seen).size).toBe(65)
  })

  it('accepts the original numeric and numeric-string offset cursors', async () => {
    const sqlite = database()
    migrate(sqlite)
    seed(sqlite)
    const db = makeD1(sqlite)
    const expected = sqlite.prepare(`SELECT id FROM attachments WHERE user_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 9 OFFSET 14`).all(USER).map((row) => (row as { id: string }).id)

    const numeric = await listMcpAttachments(db, USER, { limit: 9, cursor: 14 })
    const legacyString = await listMcpAttachments(db, USER, { limit: 9, cursor: '14' })
    expect(numeric.attachments.map((entry) => entry.id)).toEqual(expected)
    expect(legacyString.attachments.map((entry) => entry.id)).toEqual(expected)
  })

  it('binds a keyset cursor to its note filter and rejects malformed cursors', async () => {
    const sqlite = database()
    migrate(sqlite)
    seed(sqlite)
    const db = makeD1(sqlite)
    const first = await listMcpAttachments(db, USER, { noteId: NOTE_A, limit: 2 })
    expect(first.next_cursor).not.toBeNull()
    const second = await listMcpAttachments(db, USER, { noteId: NOTE_A, limit: 2, cursor: first.next_cursor! })
    expect(second.attachments.every((entry) => entry.note_id === NOTE_A)).toBe(true)

    await expect(listMcpAttachments(db, USER, { noteId: NOTE_B, cursor: first.next_cursor! }))
      .rejects.toMatchObject({ status: 400 })
    await expect(listMcpAttachments(db, USER, { cursor: 'a1.wrong-sort.1.abc.' }))
      .rejects.toBeInstanceOf(ApiError)
    await expect(listMcpAttachments(db, USER, { cursor: -1 }))
      .rejects.toMatchObject({ status: 400 })
  })
})

describe('WP-10 query plans', () => {
  it('removes the temporary ordering B-trees proved by EXPLAIN before migration 421', async () => {
    const sqlite = database()
    const db = makeD1(sqlite)
    const queries = [
      `SELECT id FROM attachments WHERE user_id = ?1
        AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
        ORDER BY created_at DESC, id DESC LIMIT ?4`,
      `SELECT id FROM attachments WHERE user_id = ?1 AND note_id = ?2
        AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))
        ORDER BY created_at DESC, id DESC LIMIT ?5`,
      `SELECT id FROM notes WHERE user_id = ?1 AND deleted_at IS NULL AND is_archived = 0
        AND (updated_at < ?2 OR (updated_at = ?2 AND id > ?3))
        ORDER BY updated_at DESC, id ASC LIMIT ?4`,
      `SELECT n.id, e.vector, e.norm, e.indexed_at, e.note_id
         FROM ai_note_embeddings e JOIN notes n ON n.id = e.note_id AND n.user_id = e.user_id
        WHERE e.user_id = ?1 AND n.deleted_at IS NULL AND n.is_encrypted = 0
          AND (e.indexed_at < ?2 OR (e.indexed_at = ?2 AND e.note_id > ?3))
        ORDER BY e.indexed_at DESC, e.note_id ASC LIMIT ?4`,
    ]
    const explain = async (query: string) => {
      const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${query}`)
        .bind(USER, 10, id(1), 20).all<{ detail: string }>()
      return results.map((row) => row.detail).join('\n')
    }
    const before = await Promise.all(queries.map(explain))
    expect(before.every((text) => text.includes('TEMP B-TREE FOR LAST TERM OF ORDER BY')), JSON.stringify(before)).toBe(true)

    migrate(sqlite)
    const after = await Promise.all(queries.map(explain))
    expect(after.every((text) => !text.includes('TEMP B-TREE FOR ORDER BY'))).toBe(true)
    expect(after[0]).toContain('idx_attachments_user')
    expect(after[1]).toContain('idx_attachments_note')
    expect(after[2]).toContain('idx_notes_user_updated')
    expect(after[3]).toContain('idx_ai_embeddings_indexed')
  })
})
