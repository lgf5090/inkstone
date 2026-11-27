// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { subscriptionRoutes } from '../src/worker/routes/subscriptions'
import { makeD1 } from './doubles/d1-sqlite'

const mocks = vi.hoisted(() => ({ userId: 'user-alice' }))
vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))
vi.mock('../src/shared/subscriptions/lunar', () => ({
  addLunarPeriod: vi.fn(),
  lunar2solar: vi.fn(),
  solar2lunar: vi.fn(),
}))

let sqlite: DatabaseSync
let db: D1Database
const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/subscriptions', subscriptionRoutes)

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  mocks.userId = 'user-alice'
})

function insertExpiry(id: string, expiryDate: number, user = 'user-alice'): void {
  sqlite.prepare(
    `INSERT INTO sub_item (user_id, id, name, expiry_date, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)`,
  ).run(user, id, id, expiryDate)
}

async function get(path: string): Promise<Response> {
  return await app.request(`/api/subscriptions${path}`, {}, { DB: db } as unknown as AppBindings['Bindings'])
}

describe('GET /api/subscriptions/expiring', () => {
  it('is registered before /:id and returns stable account-zone cursor pages', async () => {
    const at = Date.parse('2026-10-31T16:00:00Z')
    insertExpiry('b', at)
    insertExpiry('a', at)
    insertExpiry('c', at)
    insertExpiry('next-day', Date.parse('2026-11-01T16:00:00Z'))
    insertExpiry('other-account', at, 'user-bob')

    const firstResponse = await get('/expiring?day=2026-11-01&limit=2')
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json() as { items: Array<{ id: string }>; nextCursor: string }
    expect(first.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(first.nextCursor).toEqual(expect.any(String))
    const secondResponse = await get(`/expiring?day=2026-11-01&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    expect(secondResponse.status).toBe(200)
    const second = await secondResponse.json() as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(second.items.map((item) => item.id)).toEqual(['c'])
    expect(second.nextCursor).toBeNull()
  })

  it.each([
    '/expiring',
    '/expiring?day=2026-02-30',
    '/expiring?day=2026-11-01&limit=0',
    '/expiring?day=2026-11-01&limit=501',
    '/expiring?day=2026-11-01&limit=1.5',
    '/expiring?day=2026-11-01&cursor=broken',
  ])('rejects invalid input: %s', async (path) => {
    expect((await get(path)).status).toBe(400)
  })
})
