// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, it } from 'vitest'
import { consumeAttemptBudget, ThrottleError } from '../src/worker/lib/throttle'
import { makeD1 } from './doubles/d1-sqlite'

// The per-slug global work budget from shareVerifyThrottleTargets: 60 attempts per ten
// minutes, punished with a fixed 60 second lock.
const TARGET = { key: 'share-work:slug1234', maxAttempts: 60, windowMs: 600_000, lockMs: 60_000 }

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  Date.now = realNow
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE login_attempts (
    key TEXT PRIMARY KEY, fails INTEGER NOT NULL, last_fail_at INTEGER NOT NULL, locked_until INTEGER
  )`)
  db = makeD1(sqlite)
})

const realNow = Date.now

async function attempt(now: number): Promise<{ locked: boolean; fails: number }> {
  Date.now = () => now
  try {
    await consumeAttemptBudget(db, [TARGET])
  } catch (error) {
    if (!(error instanceof ThrottleError)) throw error
  }
  Date.now = realNow
  const row = sqlite.prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ?')
    .get(TARGET.key) as { fails: number; locked_until: number | null }
  return { locked: Boolean(row.locked_until && row.locked_until > now), fails: row.fails }
}

it('burns the counter off once a served lock expires', async () => {
  const start = 1_770_000_000_000
  for (let index = 1; index <= 60; index++) {
    expect((await attempt(start + index * 1_000)).locked).toBe(false)
  }
  // The 61st failure inside the window locks the shared slug key.
  expect((await attempt(start + 61_000)).locked).toBe(true)

  // Without the restart, one request per minute kept the slug locked indefinitely:
  // a lock freezes last_fail_at, so the window never rolls over while traffic continues.
  expect((await attempt(start + 61_000 + 60_000)).locked).toBe(false)
  expect((await attempt(start + 61_000 + 120_000)).locked).toBe(false)

  const after = await attempt(start + 61_000 + 180_000)
  expect(after.fails).toBeLessThan(TARGET.maxAttempts)
})

it('keeps sustained traffic from locking the slug for most of the run', async () => {
  const start = 1_770_000_000_000
  let locked = 0
  for (let minute = 1; minute <= 240; minute++) {
    if ((await attempt(start + minute * 60_000)).locked) locked += 1
  }
  // Work stays bounded, but the lock is no longer self-sustaining across four hours.
  expect(locked).toBeGreaterThan(0)
  expect(locked).toBeLessThan(30)
})

it('checks the lock before spending work, on both entries', async () => {
  const { readFileSync } = await import('node:fs')
  const share = readFileSync(new URL('../src/worker/routes/share.ts', import.meta.url), 'utf8')
  const login = readFileSync(new URL('../src/worker/routes/auth.ts', import.meta.url), 'utf8')
  const ordered = /await assertNotLocked\([\s\S]{0,160}?\n\s*await consumeAttemptBudget\(/
  expect(share).toMatch(ordered)
  expect(login).toMatch(ordered)
})
