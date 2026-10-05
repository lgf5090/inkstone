import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { isMcpEnabledOnce, setMcpEnabled } from '../src/worker/mcp/settings'
import { makeD1 } from './doubles/d1-sqlite'

let sqlite: DatabaseSync
let reads: number
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const raw = makeD1(sqlite)
  const prepare = raw.prepare.bind(raw)
  db = Object.assign({}, raw, {
    prepare: (sql: string) => {
      if (sql.startsWith('SELECT value FROM app_meta')) reads++
      return prepare(sql)
    },
  }) as unknown as D1Database
  reads = 0
})

describe('isMcpEnabledOnce', () => {
  it('serves the switch from one read per window', async () => {
    expect(await isMcpEnabledOnce(db)).toBe(true)
    await isMcpEnabledOnce(db)
    await isMcpEnabledOnce(db)
    expect(reads).toBe(1)
  })

  it('picks up a switch flipped in this isolate without waiting for the window', async () => {
    expect(await isMcpEnabledOnce(db)).toBe(true)
    await setMcpEnabled(db, false)
    expect(await isMcpEnabledOnce(db)).toBe(false)
    expect(reads).toBe(2)
  })

  it('does not cache a failed read', async () => {
    sqlite.exec('DROP TABLE app_meta')
    await expect(isMcpEnabledOnce(db)).rejects.toThrow()
    sqlite.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    expect(await isMcpEnabledOnce(db)).toBe(true)
  })
})
