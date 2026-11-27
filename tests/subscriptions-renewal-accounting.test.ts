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

  it('limits visible receipts without deleting lifetime totals', async () => {
    const store = new SubscriptionsStore(db, 'u1')
    const limitedContext = { ...context, paymentLimit: 10 }
    const created = await store.create({
      name: 'History', amount: 60, expiryDate: '2026-12-21', periodValue: 1, periodUnit: 'month', autoRenew: false,
    }, limitedContext)
    for (let index = 0; index < 10; index++) {
      await store.renew(created.item.id, { paymentDate: '2026-11-25', amount: 60, periodMultiplier: 1 }, limitedContext)
    }
    const detail = await store.get(created.item.id, limitedContext)
    expect(detail!.payments).toHaveLength(10)
    expect(detail!.item.paymentCount).toBe(11)
    expect(detail!.item.paidByCurrency).toEqual([{ currency: 'CNY', amount: 660 }])
    expect(detail!.yearlySpend).toEqual([{ year: 2026, currency: 'CNY', amount: 660, receipts: 11 }])
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

  it('converts a fixed-term trial once but does not renew it again', async () => {
    const store = new SubscriptionsStore(db, 'u1')
    const created = await store.create({ name: 'Fixed trial', amount: 60, expiryDate: '2026-12-21', trialEndsAt: '2026-11-30', periodValue: 1, periodUnit: 'month', fixedTerm: true }, context)
    const later = { ...context, now: Date.parse('2026-12-01T00:00:00Z') }
    expect(await store.autoRenew(created.item.id, later)).not.toBeNull()
    expect(await store.autoRenew(created.item.id, later)).toBeNull()
    expect((await store.get(created.item.id, later))!.payments).toHaveLength(1)
  })

  it('pauses automatic renewal and never renews a fixed-term plan', async () => {
    const store = new SubscriptionsStore(db, 'u1')
    const paused = await store.create({ name: 'Paused', amount: 60, expiryDate: '2026-05-01', periodValue: 1, periodUnit: 'month', pausedUntil: '2026-06-01' }, context)
    expect(await store.autoRenew(paused.item.id, context)).toBeNull()
    const fixed = await store.create({ name: 'Fixed', amount: 60, expiryDate: '2026-05-01', periodValue: 1, periodUnit: 'month', fixedTerm: true }, context)
    expect(await store.autoRenew(fixed.item.id, context)).toBeNull()
  })

  it('keeps a trial free until it ends, then records exactly one first charge', async () => {
    const store = new SubscriptionsStore(db, 'u1')
    const created = await store.create({
      name: 'Trial', amount: 60, expiryDate: '2026-12-21', trialEndsAt: '2026-11-30',
      periodValue: 1, periodUnit: 'week', autoRenew: true,
    }, context)
    expect(created.payments).toEqual([])
    expect(created.nextReminder).toMatchObject({ type: 'before_trial_end', nextFireTime: '2026-11-27T00:00:00.000Z' })
    expect(created.rules.some((rule) => rule.type === 'before_trial_end')).toBe(true)
    expect(await store.autoRenew(created.item.id, context)).toBeNull()

    const later = { ...context, now: Date.parse('2026-12-01T00:00:00Z') }
    await Promise.all([store.autoRenew(created.item.id, later), store.autoRenew(created.item.id, later)])
    const detail = await store.get(created.item.id, later)
    expect(detail!.payments).toHaveLength(1)
    expect(detail!.payments[0]).toMatchObject({ amount: 60, kind: 'initial', periodCount: 1 })
    expect(detail!.item.expiryDate).toBe('2026-12-07T00:00:00.000Z')
  })
})
