// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { exportAssistant } from '../src/worker/assistant/backup'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * Where a browser says "push me here", and what it takes to do so.
 *
 * The triple is a credential: an endpoint plus these two keys lets anybody who holds them put a
 * notification on that device. So every assertion below about logs, exports and cross-account reads is
 * the privacy requirement being enforced, not a detail of the fixture.
 */
const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABx0197tPQY0kq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3n'
const OTHER_ENDPOINT = 'https://web.push.apple.com/DAQs1c0hKm3nPo5qRs7tUv9wXy1Za3Bc5De7Fg9Hi1Jk3Lm5No7Pq9Rs1Tu3Vw5Xy7Za1Bc3De'
const P256DH = 'BKwRvYJ0mMVaDBHn8lPMZ3wqZ3xq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3nPo'
const AUTH = '7Q9rUxF7Vh1sQYb1W1pZ9A'

let sqlite: DatabaseSync
let env: Env

function storeFor(userId: string): AssistantStore {
  return new AssistantStore(env.DB, userId, env)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite))
})

describe('the push subscription table', () => {
  it('exists with a unique index that leads with the account column', () => {
    const table = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_push_subscriptions'`).get() as { sql: string } | undefined
    expect(table?.sql, 'the boot did not create the subscription table').toContain('endpoint')
    const indexes = sqlite.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_push_subscriptions'`).all() as { name: string, sql: string }[]
    const scoped = indexes.filter((index) => /\(user_id\b/i.test(index.sql))
    expect(scoped.length, 'no index on the table starts with user_id, so every read of one account scans').toBeGreaterThan(0)
    expect(indexes.some((index) => /UNIQUE/i.test(index.sql) && /\(user_id, endpoint\)/i.test(index.sql)),
      'endpoint is not unique per account, so a browser that renews its keys stacks up duplicates').toBe(true)
  })

  it('keeps one row per (account, endpoint) and refreshes the keys of a renewed subscription', async () => {
    const store = storeFor(USER)
    const first = await store.upsertPushSubscription({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH })
    expect(first.endpoint).toBe(ENDPOINT)
    expect(first.failures).toBe(0)
    const renewed = await store.upsertPushSubscription({ endpoint: ENDPOINT, p256dh: `${P256DH}X`.slice(0, P256DH.length), auth: 'AAAAAAAAAAAAAAAAAAAAAAAA' })
    expect(renewed.id).toBe(first.id)
    expect(await store.listPushSubscriptions()).toHaveLength(1)
    expect((await store.listPushSubscriptions())[0]?.p256dh).toBe(`${P256DH}X`.slice(0, P256DH.length))
  })

  it('lists only the account\'s own subscriptions', async () => {
    await storeFor(USER).upsertPushSubscription({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH })
    await storeFor(OTHER).upsertPushSubscription({ endpoint: OTHER_ENDPOINT, p256dh: P256DH, auth: AUTH })
    expect((await storeFor(USER).listPushSubscriptions()).map((row) => row.endpoint)).toEqual([ENDPOINT])
    expect((await storeFor(OTHER).listPushSubscriptions()).map((row) => row.endpoint),
      'a second account must see its own endpoint and never its neighbour\'s').toEqual([OTHER_ENDPOINT])
  })

  it('deletes one endpoint of one account and answers whether anything was there', async () => {
    await storeFor(USER).upsertPushSubscription({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH })
    await storeFor(OTHER).upsertPushSubscription({ endpoint: OTHER_ENDPOINT, p256dh: P256DH, auth: AUTH })
    expect(await storeFor(USER).deletePushSubscription(ENDPOINT)).toBe(true)
    expect(await storeFor(USER).deletePushSubscription(ENDPOINT)).toBe(false)
    // The whole point of binding the account into the delete: one reader removing a device cannot reach
    // another's credential, even holding the other's exact endpoint string.
    expect(await storeFor(USER).deletePushSubscription(OTHER_ENDPOINT),
      'a delete scoped to the wrong account removed a row it does not own').toBe(false)
    expect((await storeFor(OTHER).listPushSubscriptions())).toHaveLength(1)
  })

  it('deletes one row by its id and never a neighbour account\'s row', async () => {
    const mine = await storeFor(USER).upsertPushSubscription({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH })
    const theirs = await storeFor(OTHER).upsertPushSubscription({ endpoint: OTHER_ENDPOINT, p256dh: P256DH, auth: AUTH })
    expect(await storeFor(USER).deletePushSubscriptionById(mine.id)).toBe(true)
    // The id is what the redacted list hands out, so it had better not be a capability: another account
    // naming this one's row deletes nothing and is answered with false, not with an error that says whose
    // row it was.
    expect(await storeFor(USER).deletePushSubscriptionById(theirs.id),
      'a row id let one account delete another account\'s subscription').toBe(false)
    expect((await storeFor(OTHER).listPushSubscriptions()).map((row) => row.endpoint)).toEqual([OTHER_ENDPOINT])
    // A second ask for a row already gone is false, not a crash: the surface retries it after a 404.
    expect(await storeFor(USER).deletePushSubscriptionById(mine.id)).toBe(false)
    expect(await storeFor(USER).listPushSubscriptions()).toEqual([])
  })

  it('counts failures and drops the subscription once they reach the limit', async () => {
    const store = storeFor(USER)
    await store.upsertPushSubscription({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH })
    for (let attempt = 1; attempt <= 4; attempt++) {
      const outcome = await store.notePushFailure(ENDPOINT, `push service answered ${attempt === 4 ? '500' : '429'}`)
      expect(outcome.dropped).toBe(false)
      expect(outcome.failures).toBe(attempt)
    }
    const last = await store.notePushFailure(ENDPOINT, 'push service answered 500')
    expect(last.dropped).toBe(true)
    expect(await store.listPushSubscriptions()).toEqual([])
    // A failure recorded against an endpoint nobody holds is not a crash and not a phantom drop.
    const missing = await store.notePushFailure('https://updates.push.services.mozilla.com/wpush/v2/gone', '410 Gone')
    expect(missing.failures).toBe(0)
    expect(missing.dropped).toBe(false)
  })

  it('clears the failure count when the same endpoint renews its keys', async () => {
    const store = storeFor(USER)
    await store.upsertPushSubscription({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH })
    await store.notePushFailure(ENDPOINT, 'push service answered 429')
    await store.upsertPushSubscription({ endpoint: ENDPOINT, p256dh: `${P256DH}Y`.slice(0, P256DH.length), auth: 'BBBBBBBBBBBBBBBBBBBBBBBB' })
    const [row] = await store.listPushSubscriptions()
    expect(row?.failures).toBe(0)
    expect(row?.lastError).toBeNull()
  })
})

describe('push subscriptions stay out of every export path', () => {
  beforeEach(async () => {
    await storeFor(USER).upsertPushSubscription({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH })
  })

  it('exports no push table at all', async () => {
    const tables = await storeFor(USER).exportTables()
    expect(Object.keys(tables).filter((key) => /push/i.test(key)),
      'a push key joined the backup payload: the export hands somebody else the right to notify this device').toEqual([])
    expect(JSON.stringify(tables)).not.toContain(ENDPOINT)
    expect(JSON.stringify(tables)).not.toContain(P256DH)
    expect(JSON.stringify(tables)).not.toContain(AUTH)
  })

  it('carries no subscription material through the whole assistant backup document', async () => {
    const backup = JSON.stringify(await exportAssistant(storeFor(USER)))
    expect(backup).not.toContain(ENDPOINT)
    expect(backup).not.toContain(P256DH)
    expect(backup).not.toContain(AUTH)
    expect(backup).not.toContain('chat_push_subscriptions')
  })

  it('refuses to import rows named as the subscription table', async () => {
    // The import column whitelist is what stops a hostile backup file naming a table; a row for this one
    // has to be refused before any SQL is assembled, not written and then noticed.
    await expect(storeFor(USER).importRows('chat_push_subscriptions', [{ id: 'x', endpoint: ENDPOINT }]))
      .rejects.toThrow(/unknown assistant export table/)
    expect((await storeFor(USER).listPushSubscriptions()).map((row) => row.endpoint)).toEqual([ENDPOINT])
  })
})
