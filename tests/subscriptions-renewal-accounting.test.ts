// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { SubscriptionsStore, type StoreContext } from '../src/worker/subscriptions/store'
import { makeD1 } from './doubles/d1-sqlite'

let sqlite: DatabaseSync
let db: D1Database
const NOW = Date.parse('2026-05-24T04:00:00Z')
const context: StoreContext = { timezone: 'UTC', paymentLimit: 100, now: NOW }
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

async function create() {
  return new SubscriptionsStore(db, 'u1').create({
    name: 'Audit', amount: 60, expiryDate: '2026-12-21', periodValue: 1, periodUnit: 'month', autoRenew: true,
  }, context)
}

describe('renewal accounting', () => {
  it('charges every manually purchased period and starts the final period correctly', async () => {
    const store = new SubscriptionsStore(db, 'u1')
    const created = await create()
    const renewed = await store.renew(created.item.id, { paymentDate: '2026-11-25', periodMultiplier: 2 }, context)
    expect(renewed!.payments[0]).toMatchObject({ amount: 120, periodCount: 2, kind: 'manual', note: '' })
    expect(renewed!.item.expiryDate).toBe('2027-02-21T00:00:00.000Z')
    expect(renewed!.item.startDate).toBe('2027-01-21T00:00:00.000Z')
  })

  it('charges every caught-up automatic period and records the final period start', async () => {
    const store = new SubscriptionsStore(db, 'u1')
    const created = await create()
    sqlite.prepare('UPDATE sub_item SET expiry_date = ? WHERE id = ?').run(Date.parse('2026-03-01T00:00:00Z'), created.item.id)
    const renewed = await store.autoRenew(created.item.id, context)
    expect(renewed!.expiryDate).toBe('2026-06-01T00:00:00.000Z')
    expect(renewed!.startDate).toBe('2026-05-01T00:00:00.000Z')
    const detail = await store.get(created.item.id, context)
    expect(detail!.payments.find((payment) => payment.kind === 'auto')).toMatchObject({ amount: 180, periodCount: 3, kind: 'auto', note: '' })
  })

  it('does not duplicate an automatic renewal when two sweeps overlap', async () => {
    const store = new SubscriptionsStore(db, 'u1')
    const created = await create()
    sqlite.prepare('UPDATE sub_item SET expiry_date = ? WHERE id = ?').run(Date.parse('2026-03-01T00:00:00Z'), created.item.id)
    await Promise.all([store.autoRenew(created.item.id, context), store.autoRenew(created.item.id, context)])
    const detail = await store.get(created.item.id, context)
    expect(detail!.payments).toHaveLength(2)
    expect(detail!.payments.filter((payment) => payment.kind === 'auto')).toHaveLength(1)
  })
})
