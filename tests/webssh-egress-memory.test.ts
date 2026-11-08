// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { rememberRegionFailure, rememberRegionSuccess } from '../src/worker/webssh/egress-memory'
import { makeD1 } from './doubles/d1-sqlite'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE webssh_hosts (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      egress TEXT NOT NULL DEFAULT '{}',
      deleted_at INTEGER,
      PRIMARY KEY (user_id, id)
    )
  `)
  sqlite.prepare(`INSERT INTO webssh_hosts (user_id, id, egress) VALUES ('u', 'h', '{}')`).run()
  sqlite.prepare(`INSERT INTO webssh_hosts (user_id, id, egress) VALUES ('u', 'n', '{"regionResolved":null}')`).run()
  db = makeD1(sqlite)
})

function egress(): Record<string, unknown> {
  const row = sqlite.prepare(`SELECT egress FROM webssh_hosts WHERE user_id = 'u' AND id = 'h'`).get() as { egress: string }
  return JSON.parse(row.egress) as Record<string, unknown>
}

describe('region memory', () => {
  it('remembers a successful region and clears the failure streak', async () => {
    await rememberRegionSuccess(db, 'u', 'h', 'apac', 1_000)
    expect(egress().regionResolved).toEqual({ region: 'apac', at: 1_000, failures: 0 })
  })

  it('replaces a JSON null memory instead of trying to descend into it', async () => {
    await rememberRegionSuccess(db, 'u', 'n', 'weur', 1_000)
    const row = sqlite.prepare(`SELECT egress FROM webssh_hosts WHERE user_id = 'u' AND id = 'n'`).get() as { egress: string }
    expect(JSON.parse(row.egress).regionResolved).toEqual({ region: 'weur', at: 1_000, failures: 0 })
  })

  it('forgets the remembered region after two consecutive failures', async () => {
    await rememberRegionSuccess(db, 'u', 'h', 'apac', 1_000)
    await rememberRegionFailure(db, 'u', 'h', 'apac', 2_000)
    expect(egress().regionResolved).toEqual({ region: 'apac', at: 2_000, failures: 1 })
    await rememberRegionFailure(db, 'u', 'h', 'apac', 3_000)
    expect(egress().regionResolved).toBeUndefined()
  })

  it('does not let a failure in another region erase the memory', async () => {
    await rememberRegionSuccess(db, 'u', 'h', 'apac', 1_000)
    await rememberRegionFailure(db, 'u', 'h', 'weur', 2_000)
    expect(egress().regionResolved).toEqual({ region: 'apac', at: 1_000, failures: 0 })
  })

  it('ignores a session without a hint', async () => {
    await rememberRegionSuccess(db, 'u', 'h', '', 1_000)
    await rememberRegionFailure(db, 'u', 'h', '', 2_000)
    expect(egress().regionResolved).toBeUndefined()
  })
})
