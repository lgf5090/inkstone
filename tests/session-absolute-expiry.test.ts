import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { SESSION_ABSOLUTE_MAX_MS, SESSION_TTL_MS } from '../src/shared/constants'
import { renewSession } from '../src/worker/lib/session-store'
import { makeD1 } from './doubles/d1-sqlite'

function db() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER, created_at INTEGER)`)
  return {
    sqlite,
    env: makeD1(sqlite),
    insert(id: string, createdAt: number, expiresAt: number) {
      sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(id, 'user', expiresAt, createdAt)
    },
    expiry(id: string): number {
      return Number(sqlite.prepare('SELECT expires_at AS e FROM sessions WHERE id = ?').get(id)!.e)
    },
  }
}

it('renews a young session to the sliding TTL', async () => {
  const d = db()
  const now = Date.now()
  d.insert('fresh', now - 5_000, now + SESSION_TTL_MS - 5_000)
  await renewSession(d.env, 'fresh')
  expect(d.expiry('fresh')).toBeGreaterThanOrEqual(now + SESSION_TTL_MS - 1_000)
})

it('caps renewal at the absolute maximum age', async () => {
  const d = db()
  const now = Date.now()
  const createdAt = now - 200 * 24 * 60 * 60 * 1000
  d.insert('ancient', createdAt, now + 30 * 24 * 60 * 60 * 1000)
  await renewSession(d.env, 'ancient')
  expect(d.expiry('ancient')).toBe(createdAt + SESSION_ABSOLUTE_MAX_MS)
  expect(d.expiry('ancient')).toBeLessThan(now)
})
