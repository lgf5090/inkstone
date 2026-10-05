import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { rebuildDerivedFields } from '../src/worker/db/writes'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-1'
const TAB_NOTE = ':::: tabs\n::: tab-item Writing\nhello brave world\n:::\n::::'

function seed(noteCount: number) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, deleted_at INTEGER,
      content TEXT NOT NULL, excerpt TEXT NOT NULL, word_count INTEGER NOT NULL,
      char_count INTEGER NOT NULL, rev INTEGER NOT NULL, content_hash TEXT NOT NULL);
  `)
  const insert = sqlite.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (let index = 1; index <= noteCount; index++)
    insert.run(`n${index}`, USER, null, TAB_NOTE, 'stale', 0, 0, 7, 'hash-7')
  insert.run('gone', USER, 1_700_000_000_000, TAB_NOTE, 'stale', 0, 0, 3, 'hash-3')
  insert.run('foreign', 'other-user', null, TAB_NOTE, 'stale', 0, 0, 4, 'hash-4')
  return { sqlite, db: makeD1(sqlite) }
}

const rows = (sqlite: DatabaseSync) => (sqlite.prepare(
  'SELECT id, excerpt, word_count, rev, content_hash FROM notes ORDER BY id',
).all() as { id: string; excerpt: string; word_count: number; rev: number; content_hash: string }[])

it('rewrites the stored excerpt and counts for live notes of one account', async () => {
  const { sqlite, db } = seed(2)
  expect((await rebuildDerivedFields(db, USER, null)).updated).toBe(2)
  const mine = rows(sqlite).filter((row) => row.id.startsWith('n'))
  expect(mine.map((row) => row.excerpt)).toEqual(['hello brave world', 'hello brave world'])
  expect(mine.map((row) => row.word_count)).toEqual([4, 4])
  expect(mine.map((row) => row.rev)).toEqual([7, 7])
  expect(mine.map((row) => row.content_hash)).toEqual(['hash-7', 'hash-7'])
  expect(rows(sqlite).find((row) => row.id === 'gone')!.excerpt).toBe('stale')
  expect(rows(sqlite).find((row) => row.id === 'foreign')!.excerpt).toBe('stale')
})

it('walks one keyset page per call and stops at the end', async () => {
  const { sqlite, db } = seed(7)
  const first = await rebuildDerivedFields(db, USER, null, 3)
  expect([first.updated, first.nextCursor]).toEqual([3, 'n3'])
  const second = await rebuildDerivedFields(db, USER, first.nextCursor, 3)
  expect([second.updated, second.nextCursor]).toEqual([3, 'n6'])
  const third = await rebuildDerivedFields(db, USER, second.nextCursor, 3)
  expect([third.updated, third.nextCursor]).toEqual([1, null])
  expect(rows(sqlite).filter((row) => row.excerpt === 'stale').map((row) => row.id)).toEqual(['foreign', 'gone'])
})
