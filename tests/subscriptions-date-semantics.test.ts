// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { SubscriptionsStore, type StoreContext } from '../src/worker/subscriptions/store'
import { formatLocalDate } from '../src/shared/subscriptions/time'
import { makeD1 } from './doubles/d1-sqlite'

let sqlite: DatabaseSync
let db: D1Database
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

function context(timezone: string, now: number): StoreContext {
  return { timezone, paymentLimit: 100, now }
}

describe('subscription date semantics', () => {
  it('stores a bare date as midnight in the account timezone', async () => {
    const store = new SubscriptionsStore(db, 'u1')
    const created = await store.create({
      name: 'Shanghai', amount: 10, expiryDate: '2027-12-21', periodValue: 1, periodUnit: 'month',
    }, context('Asia/Shanghai', Date.parse('2026-11-27T00:00:00Z')))
    expect(created.item.expiryDate).toBe('2027-12-20T16:00:00.000Z')
    expect(formatLocalDate(created.item.expiryDate, 'Asia/Shanghai', 'date')).toBe('2027-12-21')
  })

  it('does not advance a New York date that is still today locally', async () => {
    const now = Date.parse('2026-11-25T14:00:00Z')
    const store = new SubscriptionsStore(db, 'u1')
    const created = await store.create({
      name: 'New York', amount: 10, expiryDate: '2026-11-25', periodValue: 1, periodUnit: 'month',
    }, context('America/New_York', now))
    expect(created.item.expiryDate).toBe('2026-11-25T05:00:00.000Z')
    expect(created.item.daysRemaining).toBe(0)
  })

  it('keeps the local expiry stable through renew and edit', async () => {
    const now = Date.parse('2026-11-25T04:00:00Z')
    const store = new SubscriptionsStore(db, 'u1')
    const created = await store.create({
      name: 'Round trip', amount: 10, expiryDate: '2026-12-21', periodValue: 1, periodUnit: 'month', autoRenew: false,
    }, context('Asia/Shanghai', now))
    const renewed = await store.renew(created.item.id, { paymentDate: '2026-11-25', periodMultiplier: 1 }, context('Asia/Shanghai', now))
    const localDate = formatLocalDate(renewed!.item.expiryDate, 'Asia/Shanghai', 'date')
    const edited = await store.update(created.item.id, {
      name: 'Round trip edited', amount: 10, expiryDate: localDate, periodValue: 1, periodUnit: 'month', autoRenew: false,
    }, context('Asia/Shanghai', now))
    expect(edited!.item.expiryDate).toBe(renewed!.item.expiryDate)
  })
})
