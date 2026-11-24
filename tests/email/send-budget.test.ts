// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_SEND_RATE_LIMIT_HOUR } from '../../src/shared/email/model'
import type { Env } from '../../src/worker/env'
import { reserveEmailSendBudget } from '../../src/worker/email/send-budget'
import { testBindings } from '../doubles/bindings'
import { seedUser, testDatabase, type TestDatabase } from '../fixtures/email/harness'

const OWNER = 'owner-user'
const HOUR_MS = 60 * 60 * 1000

let database: TestDatabase
let env: Env

beforeEach(() => {
  database = testDatabase()
  seedUser(database.sqlite, OWNER, 'owner')
  env = testBindings(database.db)
})

describe('email send budget', () => {
  it('enforces the hourly limit independently of sent message deletion', async () => {
    const now = Date.UTC(2026, 10, 24, 12)
    expect(await reserveEmailSendBudget(env, OWNER, now)).toBeNull()
    expect(await env.DB.prepare("SELECT bucket, count FROM email_send_budget WHERE user_id = ?1 ORDER BY bucket").bind(OWNER).all()).toEqual({
      results: [
        { bucket: 'day', count: 1 },
        { bucket: 'hour', count: 1 },
      ],
    })
    for (let index = 1; index < EMAIL_SEND_RATE_LIMIT_HOUR; index++) {
      expect(await reserveEmailSendBudget(env, OWNER, now)).toBeNull()
    }
    expect((await env.DB.prepare("SELECT count FROM email_send_budget WHERE user_id = ?1 AND bucket = 'hour'").bind(OWNER).first<{ count: number }>())?.count).toBe(20)
    expect(await reserveEmailSendBudget(env, OWNER, now)).toContain('20 emails per hour')
    expect(await reserveEmailSendBudget(env, OWNER, now + HOUR_MS)).toBeNull()
  })

  it('serializes concurrent sends so only the hourly quota gets through', async () => {
    const now = Date.UTC(2026, 10, 24, 12)
    const results = await Promise.all(
      Array.from({ length: EMAIL_SEND_RATE_LIMIT_HOUR + 5 }, () => reserveEmailSendBudget(env, OWNER, now)),
    )
    expect(results.filter((result) => result === null)).toHaveLength(EMAIL_SEND_RATE_LIMIT_HOUR)
    expect(results.filter((result) => result !== null)).toHaveLength(5)
  })
})
