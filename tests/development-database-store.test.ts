// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEVELOPMENT_DATABASE_SCHEMA_STATEMENTS } from '../src/worker/development/database/schema'
import {
  clearHistory,
  countConnections,
  countSavedQueries,
  deleteConnection,
  deleteExport,
  deleteExpiredExports,
  deleteSavedQuery,
  findConnection,
  findExport,
  findMissingConnectionIds,
  findSavedQuery,
  getSettings,
  insertConnection,
  insertExport,
  insertHistory,
  insertSavedQuery,
  listConnections,
  listExpiredExports,
  listHistory,
  listSavedQueries,
  recordHistory,
  saveSettings,
  toConnectionView,
  trimHistory,
  updateConnection,
  updateConnectionFlags,
  updateConnectionOrder,
  updateSavedQuery,
} from '../src/worker/development/database/store'
import type { ConnectionInsert } from '../src/worker/development/database/store'
import { makeD1 } from './doubles/d1-sqlite'

const USER_A = 'user-a'
const USER_B = 'user-b'

let sqlite: DatabaseSync
let db: D1Database

function connection(id: string, name: string): ConnectionInsert {
  return {
    id,
    name,
    type: 'd1',
    d1AccountId: 'account',
    d1DatabaseId: 'database',
    d1DatabaseName: 'main',
    secretCiphertext: 'v1.ciphertext',
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_DATABASE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

describe('connection store', () => {
  it('keeps connections per user and never exposes the ciphertext in a view', async () => {
    await insertConnection(db, USER_A, connection('conn-a', 'Alpha'))

    const rowsA = await listConnections(db, USER_A)
    const rowsB = await listConnections(db, USER_B)
    expect(rowsA).toHaveLength(1)
    expect(rowsB).toHaveLength(0)
    expect(await findConnection(db, USER_B, 'conn-a')).toBeNull()

    const view = toConnectionView(rowsA[0]!)
    expect(view.hasSecret).toBe(true)
    expect(JSON.stringify(view)).not.toContain('v1.ciphertext')
    expect('secretCiphertext' in view).toBe(false)
    expect(await countConnections(db, USER_A)).toBe(1)
    expect(await countConnections(db, USER_B)).toBe(0)
  })

  it('orders pinned then favorite then sort and applies drag order', async () => {
    await insertConnection(db, USER_A, connection('conn-1', 'One'))
    await insertConnection(db, USER_A, connection('conn-2', 'Two'))
    await insertConnection(db, USER_A, connection('conn-3', 'Three'))
    await updateConnectionFlags(db, USER_A, 'conn-3', { isPinned: true }, 2_000)
    await updateConnectionFlags(db, USER_A, 'conn-2', { isFavorite: true }, 2_000)

    let rows = await listConnections(db, USER_A)
    expect(rows.map((row) => row.id)).toEqual(['conn-3', 'conn-2', 'conn-1'])

    await updateConnectionOrder(db, USER_A, ['conn-2', 'conn-1', 'conn-3'])
    rows = await listConnections(db, USER_A)
    expect(rows.map((row) => row.id)).toEqual(['conn-3', 'conn-2', 'conn-1'])

    await updateConnectionFlags(db, USER_A, 'conn-3', { isPinned: false }, 3_000)
    rows = await listConnections(db, USER_A)
    expect(rows.map((row) => row.id)).toEqual(['conn-2', 'conn-1', 'conn-3'])
    expect(rows.map((row) => row.sort)).toEqual([0, 1, 2])
  })

  it('patches only the given fields and reports ids that do not belong to the user', async () => {
    await insertConnection(db, USER_A, connection('conn-a', 'Alpha'))

    expect(
      await updateConnection(db, USER_A, 'conn-a', { name: 'Renamed', secretCiphertext: '' }, 5_000),
    ).toBe(true)
    const updated = await findConnection(db, USER_A, 'conn-a')
    expect(updated?.name).toBe('Renamed')
    expect(updated?.secretCiphertext).toBe('')
    expect(updated?.updatedAt).toBe(5_000)
    expect(updated?.d1AccountId).toBe('account')

    expect(await updateConnection(db, USER_B, 'conn-a', { name: 'Nope' }, 6_000)).toBe(false)
    expect(await updateConnectionFlags(db, USER_B, 'conn-a', { isPinned: true }, 6_000)).toBe(false)

    expect(await findMissingConnectionIds(db, USER_A, ['conn-a'])).toEqual([])
    expect(await findMissingConnectionIds(db, USER_A, ['conn-a', 'conn-x'])).toEqual(['conn-x'])
  })

  it('cascades saved queries and history when a connection is deleted', async () => {
    await insertConnection(db, USER_A, connection('conn-a', 'Alpha'))
    await insertSavedQuery(db, USER_A, {
      id: 'saved-1',
      connectionId: 'conn-a',
      name: 'Query',
      sql: 'select 1',
      namespace: 'default',
      createdAt: 1,
      updatedAt: 1,
    })
    await insertHistory(
      db,
      USER_A,
      { id: 'hist-1', connectionId: 'conn-a', query: 'select 1', executedAt: 1, durationMs: 2, error: null },
      1,
    )

    expect(await deleteConnection(db, USER_B, 'conn-a')).toBe(false)
    expect(await deleteConnection(db, USER_A, 'conn-a')).toBe(true)
    expect(await findConnection(db, USER_A, 'conn-a')).toBeNull()
    expect(await listSavedQueries(db, USER_A)).toEqual([])
    expect(await listHistory(db, USER_A, 'conn-a', 10)).toEqual([])
  })
})

describe('saved query store', () => {
  it('creates, lists, updates and deletes per user with namespace defaults', async () => {
    await insertConnection(db, USER_A, connection('conn-a', 'Alpha'))
    await insertSavedQuery(db, USER_A, {
      id: 'saved-1',
      connectionId: 'conn-a',
      name: 'First',
      sql: 'select 1',
      namespace: '',
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    await insertSavedQuery(db, USER_A, {
      id: 'saved-2',
      connectionId: 'conn-a',
      name: 'Second',
      sql: 'select 2',
      namespace: 'reports',
      createdAt: 2_000,
      updatedAt: 2_000,
    })

    const listed = await listSavedQueries(db, USER_A, 'conn-a')
    expect(listed.map((query) => query.id)).toEqual(['saved-2', 'saved-1'])
    expect(listed[1]!.namespace).toBe('default')
    expect(await listSavedQueries(db, USER_B)).toEqual([])
    expect(await countSavedQueries(db, USER_A)).toBe(2)

    const updated = await updateSavedQuery(
      db,
      USER_A,
      'saved-1',
      { name: 'Renamed', sql: 'select 3', namespace: '' },
      3_000,
    )
    expect(updated?.name).toBe('Renamed')
    expect(updated?.sql).toBe('select 3')
    expect(updated?.namespace).toBe('default')
    expect(updated?.updatedAt).toBe(3_000)

    expect(await updateSavedQuery(db, USER_B, 'saved-1', { name: 'Nope' }, 4_000)).toBeNull()
    expect(await deleteSavedQuery(db, USER_B, 'saved-1')).toBe(false)
    expect(await deleteSavedQuery(db, USER_A, 'saved-1')).toBe(true)
    expect(await findSavedQuery(db, USER_A, 'saved-1')).toBeNull()
  })
})

describe('history store', () => {
  it('trims each connection to the configured limit and keeps failures', async () => {
    await insertConnection(db, USER_A, connection('conn-a', 'Alpha'))
    await insertConnection(db, USER_A, connection('conn-b', 'Beta'))

    for (let index = 0; index < 7; index++) {
      await recordHistory(
        db,
        USER_A,
        {
          id: `hist-${index}`,
          connectionId: 'conn-a',
          query: `select ${index}`,
          executedAt: 1_000 + index,
          durationMs: index,
          error: index === 6 ? 'boom' : null,
        },
        5,
        1_000 + index,
      )
    }
    await insertHistory(
      db,
      USER_A,
      { id: 'other', connectionId: 'conn-b', query: 'select 9', executedAt: 2_000, durationMs: 1, error: null },
      2_000,
    )

    const history = await listHistory(db, USER_A, 'conn-a', 10)
    expect(history.map((entry) => entry.id)).toEqual(['hist-6', 'hist-5', 'hist-4', 'hist-3', 'hist-2'])
    expect(history[0]!.error).toBe('boom')
    expect(await listHistory(db, USER_A, 'conn-b', 10)).toHaveLength(1)
    expect(await listHistory(db, USER_B, 'conn-a', 10)).toEqual([])

    await trimHistory(db, USER_A, 'conn-a', 2)
    expect((await listHistory(db, USER_A, 'conn-a', 10)).map((entry) => entry.id)).toEqual([
      'hist-6',
      'hist-5',
    ])

    await clearHistory(db, USER_A, 'conn-a')
    expect(await listHistory(db, USER_A, 'conn-a', 10)).toEqual([])
    expect(await listHistory(db, USER_A, 'conn-b', 10)).toHaveLength(1)
    expect(await clearHistory(db, USER_B, 'conn-b')).toBeUndefined()
  })
})

describe('settings store', () => {
  it('defaults to 30 and upserts the user limit', async () => {
    expect(await getSettings(db, USER_A)).toEqual({ historyLimit: 30 })
    expect(await getSettings(db, USER_B)).toEqual({ historyLimit: 30 })

    expect(await saveSettings(db, USER_A, 12, 1_000)).toEqual({ historyLimit: 12 })
    expect(await getSettings(db, USER_A)).toEqual({ historyLimit: 12 })
    expect(await getSettings(db, USER_B)).toEqual({ historyLimit: 30 })

    expect(await saveSettings(db, USER_A, 7, 2_000)).toEqual({ historyLimit: 7 })
    expect(await getSettings(db, USER_A)).toEqual({ historyLimit: 7 })
  })
})

describe('export store', () => {
  it('stores, lists expired records and deletes per user', async () => {
    await insertExport(db, USER_A, {
      id: 'exp-1',
      filename: 'one.csv',
      format: 'csv',
      r2Key: 'development/database/csv/user-a/exp-1.csv',
      size: 10,
      createdAt: 1_000,
    })
    await insertExport(db, USER_A, {
      id: 'exp-2',
      filename: 'two.json',
      format: 'json',
      r2Key: 'development/database/json/user-a/exp-2.json',
      size: 20,
      createdAt: 5_000,
    })
    await insertExport(db, USER_B, {
      id: 'exp-3',
      filename: 'other.txt',
      format: 'txt',
      r2Key: 'development/database/txt/user-b/exp-3.txt',
      size: 30,
      createdAt: 1_000,
    })

    const found = await findExport(db, USER_A, 'exp-1')
    expect(found?.r2Key).toBe('development/database/csv/user-a/exp-1.csv')
    expect(await findExport(db, USER_B, 'exp-1')).toBeNull()

    const expired = await listExpiredExports(db, USER_A, 2_000)
    expect(expired.map((record) => record.id)).toEqual(['exp-1'])
    expect(await listExpiredExports(db, USER_B, 2_000)).toHaveLength(1)

    await deleteExpiredExports(db, USER_A, 2_000)
    expect(await findExport(db, USER_A, 'exp-1')).toBeNull()
    expect(await findExport(db, USER_A, 'exp-2')).not.toBeNull()

    expect(await deleteExport(db, USER_B, 'exp-2')).toBe(false)
    expect(await deleteExport(db, USER_A, 'exp-2')).toBe(true)
    expect(await findExport(db, USER_A, 'exp-2')).toBeNull()
  })

  it('checks connection existence in chunks below the D1 bind limit', async () => {
    const bindLimited = {
      prepare: (sql: string) => {
        const statement = db.prepare(sql)
        return {
          bind: (...values: unknown[]) => {
            if (values.length > 100) throw new Error(`too many SQL variables: ${values.length}`)
            return statement.bind(...(values as never[]))
          },
        }
      },
    } as unknown as D1Database
    const ids: string[] = []
    for (let index = 0; index < 120; index++) {
      const id = `conn-many-${index}`
      await insertConnection(db, USER_A, connection(id, id))
      ids.push(id)
    }
    await expect(findMissingConnectionIds(bindLimited, USER_A, ids)).resolves.toEqual([])
    await expect(findMissingConnectionIds(bindLimited, USER_A, [...ids, 'conn-missing'])).resolves.toEqual(['conn-missing'])
  })
})
