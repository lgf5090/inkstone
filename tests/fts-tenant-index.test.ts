// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { FTS_USER_MATCH_SQL } from '../src/worker/db/fts'

let sqlite: DatabaseSync
let db: D1Database

// Mirrors the shipped schema: user_id must be an indexed FTS5 column so the
// tenant phrase filter runs inside the inverted index, not as an UNINDEXED
// post-scan.
function createSchema(indexedTenant: boolean) {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(
    `CREATE VIRTUAL TABLE notes_fts USING fts5(note_id, user_id${indexedTenant ? '' : ' UNINDEXED'}, `
    + `title, body, tokenize = "unicode61 remove_diacritics 2")`,
  )
  sqlite.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT, deleted_at INTEGER)`)
}

function mockDb(handle: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              const args = Object.fromEntries(values.map((value, i) => [String(i + 1), value]))
              return { results: handle.prepare(sql).all(args as never) }
            },
            async run() {
              const args = Object.fromEntries(values.map((value, i) => [String(i + 1), value]))
              handle.prepare(sql).run(args as never)
              return {}
            },
            async first() {
              const args = Object.fromEntries(values.map((value, i) => [String(i + 1), value]))
              return { result: handle.prepare(sql).get(args as never) ?? null }
            },
          }
        },
      }
    },
    async batch<T>(statements: unknown[]): Promise<T[]> {
      const results = [] as unknown as T[]
      for (const statement of statements) {
        results.push(await (statement as { all(): Promise<unknown> }).all() as T)
      }
      return results
    },
  } as unknown as D1Database
}

const userA = '00000000000000000000000001'
const userB = '00000000000000000000000002'

beforeEach(() => {
  createSchema(true)
  sqlite.prepare(
    `INSERT INTO notes_fts (note_id, user_id, title, body) VALUES (?, ?, ?, ?)`,
  ).run('n-a1', userA, 'release notes', 'alpha body')
  sqlite.prepare(
    `INSERT INTO notes_fts (note_id, user_id, title, body) VALUES (?, ?, ?, ?)`,
  ).run('n-b1', userB, 'release notes', 'beta body')
  sqlite.prepare(`INSERT INTO notes VALUES (?, ?, ?)`).run('n-a1', userA, null)
  db = mockDb(sqlite)
})

afterEach(() => sqlite.close())

it('filters tenants inside the MATCH expression', async () => {
  const { results } = await db.prepare(
    `SELECT note_id FROM notes_fts
      WHERE notes_fts MATCH ('user_id : "' || replace(?1, '"', '""') || '" AND {title body} : ("release"*)')
        AND user_id = ?1`,
  ).bind(userA).all<{ note_id: string }>()
  expect(results.map((row) => row.note_id)).toEqual(['n-a1'])
})

it('supports per-tenant DELETE through the same indexed column', async () => {
  await db.prepare(
    `DELETE FROM notes_fts WHERE ${FTS_USER_MATCH_SQL} AND notes_fts.user_id = ?1 AND NOT EXISTS (
       SELECT 1 FROM notes n WHERE n.id = notes_fts.note_id
         AND n.user_id = ?1 AND n.deleted_at IS NULL
     )`,
  ).bind(userA).run()
  const remaining = sqlite.prepare(`SELECT note_id FROM notes_fts ORDER BY note_id`).all()
  expect(remaining.map((row) => (row as { note_id: string }).note_id)).toEqual(['n-a1', 'n-b1'])

  sqlite.prepare(`UPDATE notes SET deleted_at = 1 WHERE id = 'n-a1'`).run()
  await db.prepare(
    `DELETE FROM notes_fts WHERE ${FTS_USER_MATCH_SQL} AND notes_fts.user_id = ?1 AND NOT EXISTS (
       SELECT 1 FROM notes n WHERE n.id = notes_fts.note_id
         AND n.user_id = ?1 AND n.deleted_at IS NULL
     )`,
  ).bind(userA).run()
  const after = sqlite.prepare(`SELECT note_id FROM notes_fts ORDER BY note_id`).all()
  expect(after.map((row) => (row as { note_id: string }).note_id)).toEqual(['n-b1'])
})

it('regression guard: shipped schema keeps notes_fts.user_id indexed', async () => {
  const src = await readFile(new URL('../src/worker/db/schema.ts', import.meta.url), 'utf8')
  expect(src).toMatch(/CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5\(\n  note_id,\n  user_id,\n/)
  expect(src).not.toMatch(/CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts[\s\S]{0,120}?user_id UNINDEXED/)
})
