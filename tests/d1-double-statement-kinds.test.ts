// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The double has to answer the way D1 does, or a route tested against it proves nothing.
 *
 * Forty-odd suites build their database through `makeD1`, and the one decision it has to make for
 * them is the one node:sqlite does not: whether a statement is a read, which answers with rows, or a
 * write, which answers with `meta`. A common-table expression is the case that used to be misjudged,
 * because `WITH` opens the statement while the verb that follows decides its kind. Misjudge it and the
 * failure lands somewhere unrelated — a store reading `meta.changes` gets `undefined` and the caller
 * crashes on a line of production code that was never wrong.
 */
let sqlite: DatabaseSync
let db: D1Database

const ITEMS = 'items'

async function answer(sql: string, ...binds: unknown[]) {
  return db.prepare(sql).bind(...binds).all()
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE ${ITEMS} (id TEXT PRIMARY KEY, user_id TEXT, label TEXT)`)
  sqlite.exec('CREATE TABLE log (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, op TEXT)')
  sqlite.exec(`INSERT INTO ${ITEMS} VALUES ('a', 'u1', 'first'), ('b', 'u1', 'second'), ('c', 'u2', 'third')`)
  db = makeD1(sqlite)
})

describe('reading a statement the way D1 reads it', () => {
  it('hands a plain select back as rows', async () => {
    const result = await answer(`SELECT id FROM ${ITEMS} WHERE user_id = ?1`, 'u1')
    expect(result.results).toHaveLength(2)
    expect(result.meta).toBeUndefined()
  })

  it('hands a select that reads from a common-table expression back as rows', async () => {
    const sql = `WITH picked AS (SELECT id FROM ${ITEMS} WHERE user_id = ?1)
                  SELECT count(*) AS n FROM picked`
    const result = await answer(sql, 'u1')
    expect(result.results).toEqual([{ n: 2 }])
  })

  it('is not fooled by the word of a verb written into a literal', async () => {
    sqlite.exec(`INSERT INTO ${ITEMS} VALUES ('d', 'u1', 'delete')`)
    const result = await answer(`SELECT id FROM ${ITEMS} WHERE label = 'delete'`)
    expect(result.results).toEqual([{ id: 'd' }])
    expect(result.meta).toBeUndefined()
  })
})

describe('writing a statement the way D1 writes it', () => {
  it('hands a plain insert back as meta', async () => {
    const result = await answer(`INSERT INTO ${ITEMS} VALUES (?1, ?2, ?3)`, 'x', 'u1', 'fourth',)
    expect(result.meta?.changes).toBe(1)
    expect(result.results).toEqual([])
  })

  it('counts the rows a common-table expression inserted', async () => {
    const sql = `WITH picked AS (SELECT user_id FROM ${ITEMS} WHERE user_id = ?1)
                  INSERT INTO log (user_id, op) SELECT user_id, 'delete' FROM picked`
    const result = await answer(sql, 'u1')
    expect(result.meta?.changes).toBe(2)
    expect(sqlite.prepare('SELECT count(*) AS n FROM log').get()).toEqual({ n: 2 })
  })

  it('counts the rows a common-table expression deleted', async () => {
    const sql = `WITH picked AS (SELECT id FROM ${ITEMS} WHERE user_id = ?1)
                  DELETE FROM ${ITEMS} WHERE id IN (SELECT id FROM picked)`
    const result = await answer(sql, 'u1')
    expect(result.meta?.changes).toBe(2)
    expect((await answer(`SELECT id FROM ${ITEMS}`)).results).toEqual([{ id: 'c' }])
  })

  it('answers a write with RETURNING with both the rows and the count', async () => {
    const result = await answer('INSERT INTO log (user_id, op) VALUES (?1, ?2) RETURNING seq', 'u1', 'upsert')
    expect(result.results).toHaveLength(1)
    expect(result.meta?.changes).toBe(1)
  })

  it('reports a change that never happened as zero rather than as a read', async () => {
    const result = await answer(`UPDATE ${ITEMS} SET label = 'none' WHERE user_id = ?1`, 'nobody')
    expect(result.meta?.changes).toBe(0)
  })
})
