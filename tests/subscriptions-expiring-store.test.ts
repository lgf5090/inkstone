// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { SubscriptionsStore } from '../src/worker/subscriptions/store'
import { makeD1 } from './doubles/d1-sqlite'

vi.mock('../src/shared/subscriptions/lunar', () => ({
  addLunarPeriod: vi.fn(),
  lunar2solar: vi.fn(),
  solar2lunar: vi.fn(),
}))

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

function insert(id: string, expiryDate: number, options: { user?: string; deleted?: boolean } = {}): void {
  sqlite.prepare(
    `INSERT INTO sub_item (user_id, id, name, expiry_date, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
  ).run(options.user ?? 'u1', id, id, expiryDate, options.deleted ? 2 : null)
}

describe('SubscriptionsStore.listExpiring', () => {
  it('uses account-zone half-open bounds and stable expiry/id cursor pages', async () => {
    const start = Date.parse('2026-10-31T16:00:00Z')
    const end = Date.parse('2026-11-01T16:00:00Z')
    insert('c', start)
    insert('a', start)
    insert('b', start)
    insert('before', start - 1)
    insert('at-end', end)
    insert('trashed', start, { deleted: true })
    insert('other-account', start, { user: 'u2' })
    const store = new SubscriptionsStore(db, 'u1')
    const context = { timezone: 'Asia/Shanghai', paymentLimit: 50 }

    const first = await store.listExpiring(context, '2026-11-01', 2)
    expect(first.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(first.nextCursor).not.toBeNull()
    const second = await store.listExpiring(context, '2026-11-01', 2, first.nextCursor!)
    expect(second.items.map((item) => item.id)).toEqual(['c'])
    expect(second.nextCursor).toBeNull()
  })

  it.each([
    ['2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
  ])('cuts the DST day %s at its real local midnights', async (day, from, to) => {
    insert('start', Date.parse(from))
    insert('end', Date.parse(to))
    insert('before', Date.parse(from) - 1)
    const store = new SubscriptionsStore(db, 'u1')
    const page = await store.listExpiring({ timezone: 'America/New_York', paymentLimit: 50 }, day)
    expect(page.items.map((item) => item.id)).toEqual(['start'])
  })

  it('rejects invalid days, limits and cursors', async () => {
    const store = new SubscriptionsStore(db, 'u1')
    const context = { timezone: 'UTC', paymentLimit: 50 }
    await expect(store.listExpiring(context, '2026-02-30')).rejects.toThrow('invalid_day')
    await expect(store.listExpiring(context, '2026-11-01', 0)).rejects.toThrow('invalid_limit')
    await expect(store.listExpiring(context, '2026-11-01', 1.5)).rejects.toThrow('invalid_limit')
    await expect(store.listExpiring(context, '2026-11-01', 10, 'not-a-cursor')).rejects.toThrow('invalid_cursor')
  })

  it('creates the expiry/day/id lookup index', () => {
    const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sub_item_expiring'`).get()
    expect(row).toBeDefined()
  })
})
