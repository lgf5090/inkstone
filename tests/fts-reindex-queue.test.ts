import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { queueAllNotesForFtsIndex } from '../src/worker/db/fts'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-1'

function seed() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, deleted_at INTEGER);
    CREATE TABLE fts_index_queue (user_id TEXT NOT NULL, note_id TEXT NOT NULL, kind TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (user_id, note_id));
  `)
  const insert = sqlite.prepare('INSERT INTO notes VALUES (?, ?, ?)')
  insert.run('a', USER, null)
  insert.run('b', USER, null)
  insert.run('c', USER, 1_700_000_000_000)
  insert.run('d', 'other-user', null)
  return { sqlite, db: makeD1(sqlite) }
}

const queued = (sqlite: DatabaseSync) => (sqlite.prepare(
  'SELECT note_id, kind, created_at FROM fts_index_queue WHERE user_id = ?1 ORDER BY note_id',
).all(USER) as { note_id: string; kind: string; created_at: number }[])

it('queues the live notes of one account only', async () => {
  const { sqlite, db } = seed()
  expect(await queueAllNotesForFtsIndex(db, USER)).toBe(2)
  expect(queued(sqlite).map((row) => row.note_id)).toEqual(['a', 'b'])
})

it('refreshes a pending row instead of stacking duplicates', async () => {
  const { sqlite, db } = seed()
  sqlite.prepare('INSERT INTO fts_index_queue VALUES (?, ?, ?, ?)').run(USER, 'a', 'upsert', 1)
  const first = await queueAllNotesForFtsIndex(db, USER)
  const rows = queued(sqlite)
  expect(first).toBe(2)
  expect(rows).toHaveLength(2)
  expect(rows.find((row) => row.note_id === 'a')!.created_at).toBeGreaterThan(1)
})
