// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { buildNoteDerivedStatements } from '../src/worker/db/writes'
import { NotesStore } from '../src/worker/notes/store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const FOREIGN = 'user-b'
const A = 'a'.repeat(26)
const B = 'b'.repeat(26)
const C = 'c'.repeat(26)
const D = 'd'.repeat(26)

let sqlite: DatabaseSync
let db: D1Database

function seed(id: string, title: string, content: string, userId = USER, encrypted = 0): void {
  sqlite.prepare(`INSERT INTO notes
    (id, user_id, title, content, excerpt, rev, word_count, char_count, is_encrypted, position, content_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', 1, 1, 1, ?, 0, '', 1, 1)`).run(id, userId, title, content, encrypted)
}

async function derive(id: string, title: string, content: string): Promise<void> {
  const built = buildNoteDerivedStatements({ db, userId: USER, noteId: id, title, content, ftsEnabled: false })
  await db.batch(built.statements)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  seed(A, 'Alpha', '---\nstatus: active\nrating: 4\npublished: true\naliases: [one]\n---\nBody')
  seed(B, 'Beta', '---\nstatus: draft\n---\nBody')
  seed(C, 'Gamma', 'Body')
  seed(D, 'Foreign', '---\nstatus: active\n---\nBody', FOREIGN)
  seed('e'.repeat(26), 'Sealed', 'memoenc:v2:salt:iv:data', USER, 1)
})

describe('notes property table', () => {
  it('pages readable notes and reconstructs scalar, boolean and single-item array values', async () => {
    await derive(A, 'Alpha', sqlite.prepare('SELECT content FROM notes WHERE id = ?').get(A)!.content as string)
    await derive(B, 'Beta', sqlite.prepare('SELECT content FROM notes WHERE id = ?').get(B)!.content as string)
    const store = new NotesStore(db, USER, false)
    const first = await store.propertyTablePage('', 2)
    expect(first.rows.map((row) => row.note.id)).toEqual([A, B])
    expect(first.nextCursor).toBe(B)
    expect(first.rows[0]?.properties).toEqual({ status: 'active', rating: 4, published: true, aliases: ['one'] })
    const second = await store.propertyTablePage(first.nextCursor!, 2)
    expect(second.rows.map((row) => row.note.id)).toEqual([C])
    expect(second.nextCursor).toBeNull()
  })

  it('filters by title without crossing account or encryption boundaries', async () => {
    const store = new NotesStore(db, USER, false)
    expect((await store.propertyTablePage('', 20, 'alpha')).rows.map((row) => row.note.id)).toEqual([A])
    expect((await store.propertyTablePage('', 20, 'foreign')).rows).toEqual([])
    expect((await store.propertyTablePage('', 20, 'sealed')).rows).toEqual([])
  })
})
