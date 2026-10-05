// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { consumeAttemptBudget, ThrottleError } from '../src/worker/lib/throttle'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE login_attempts (
    key TEXT PRIMARY KEY, fails INTEGER NOT NULL, last_fail_at INTEGER NOT NULL, locked_until INTEGER
  )`)
  db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              const args = Object.fromEntries(values.map((value, i) => [String(i + 1), value]))
              return { results: sqlite!.prepare(sql).all(args as never) }
            },
            async run() {
              const args = Object.fromEntries(values.map((value, i) => [String(i + 1), value]))
              sqlite!.prepare(sql).run(args as never)
              return { meta: { changes: 1 } }
            },
            async first() {
              const args = Object.fromEntries(values.map((value, i) => [String(i + 1), value]))
              return sqlite!.prepare(sql).get(args as never) ?? null
            },
          }
        },
      }
    },
    async batch<T>(statements: unknown[]): Promise<T[]> {
      const results = [] as unknown as T[]
      for (const statement of statements) {
        const bound = statement as unknown as { all(): Promise<{ results: unknown[] }> }
        results.push(await bound.all() as T)
      }
      return results
    },
  } as unknown as D1Database
})

afterEach(() => sqlite.close())

const target = { key: 'login-work:ip:user', maxAttempts: 2, windowMs: 600_000, lockMs: 60_000 }

it('locks after exceeding the attempt budget using the RETURNING verdict', async () => {
  await consumeAttemptBudget(db, [target])
  await consumeAttemptBudget(db, [target])
  await expect(consumeAttemptBudget(db, [target])).rejects.toBeInstanceOf(ThrottleError)
  const row = sqlite.prepare(`SELECT fails, locked_until FROM login_attempts WHERE key = ?`)
    .get(target.key) as { fails: number; locked_until: number }
  expect(row.fails).toBe(3)
  expect(row.locked_until).toBeGreaterThan(Date.now())
})

it('keeps rejecting and preserves lock state while locked', async () => {
  await consumeAttemptBudget(db, [target])
  await consumeAttemptBudget(db, [target])
  await expect(consumeAttemptBudget(db, [target])).rejects.toBeInstanceOf(ThrottleError)
  const locked = (sqlite.prepare(`SELECT locked_until FROM login_attempts WHERE key = ?`)
    .get(target.key) as { locked_until: number }).locked_until
  const error = await consumeAttemptBudget(db, [target]).catch((err) => err) as ThrottleError
  expect(error).toBeInstanceOf(ThrottleError)
  expect(error.retryAfterSec).toBeGreaterThanOrEqual(1)
  const after = (sqlite.prepare(`SELECT locked_until, fails FROM login_attempts WHERE key = ?`)
    .get(target.key) as { locked_until: number; fails: number })
  expect(after.locked_until).toBe(locked)
})

it('resets the counter when the attempt window elapsed', async () => {
  sqlite.prepare(`INSERT INTO login_attempts (key, fails, last_fail_at, locked_until) VALUES (?, 2, ?, NULL)`)
    .run(target.key, Date.now() - 700_000)
  await consumeAttemptBudget(db, [target])
  const row = sqlite.prepare(`SELECT fails, locked_until FROM login_attempts WHERE key = ?`)
    .get(target.key) as { fails: number; locked_until: number | null }
  expect(row.fails).toBe(1)
  expect(row.locked_until).toBeNull()
})
