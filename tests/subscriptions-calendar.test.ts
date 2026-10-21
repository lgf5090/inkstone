// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { subscriptionInboundRoutes } from '../src/worker/routes/subscriptions-inbound'
import { buildEvents, toICal } from '../src/worker/subscriptions/calendar'
import { rotateInboundToken } from '../src/worker/subscriptions/settings'
import { SubscriptionsStore, storeContext } from '../src/worker/subscriptions/store'
import { DEFAULT_SETTINGS } from '../src/shared/subscriptions/model'
import type { SubscriptionItem } from '../src/shared/subscriptions/model'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The calendar a reader pastes into a calendar app.
 *
 * Two things are worth holding still here. The file has to parse in a client nobody in this repository
 * controls, which means the format's own rules — CRLF, escaped text, folded lines — are features rather
 * than pedantry; and the link carries a token, so what it hands out has to stop at the plan's name,
 * price and date. A note is the one field a reader may have used for anything.
 */

const ALICE = 'user-alice'

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/hooks/subscriptions', subscriptionInboundRoutes)

function item(overrides: Partial<SubscriptionItem> = {}): SubscriptionItem {
  return {
    id: 'sub-1',
    name: 'Netflix',
    customType: 'streaming',
    category: 'family',
    amount: 60,
    currency: 'CNY',
    startDate: null,
    expiryDate: '2026-11-01T00:00:00.000Z',
    periodValue: 1,
    periodUnit: 'month',
    subscriptionMode: 'cycle',
    useLunar: false,
    isActive: true,
    autoRenew: true,
    notes: '',
    lastPaymentDate: null,
    trialEndsAt: null,
    trialDaysRemaining: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    daysRemaining: 10,
    hoursRemaining: 240,
    nextReminderAt: null,
    paymentCount: 1,
    paidByCurrency: [{ currency: 'CNY', amount: 60 }],
    ...overrides,
  }
}

const STAMP = Date.parse('2026-10-21T00:00:00.000Z')

function document(items: Partial<SubscriptionItem>[]): string {
  return toICal(buildEvents(items.map((overrides) => item(overrides))), { name: 'Inkstone', stamp: STAMP })
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

describe('the calendar file', () => {
  it('is CRLF, opens with the header the format asks for, and closes the envelope', () => {
    const text = document([item()])
    expect(text.endsWith('\r\n')).toBe(true)
    expect(text.split('\r\n').filter((line) => line.length).length).toBeGreaterThan(10)
    expect(text).not.toMatch(/[^\r]\n/)
    expect(text).toContain('BEGIN:VCALENDAR')
    expect(text).toContain('VERSION:2.0')
    expect(text).toContain('END:VCALENDAR')
    expect(text).toContain('DTSTAMP:20261021T000000Z')
  })

  it('spans one whole day: the expiry is the start, and the day after is the exclusive end', () => {
    const text = document([item({ expiryDate: '2026-11-01T00:00:00.000Z' })])
    expect(text).toContain('DTSTART;VALUE=DATE:20261101')
    expect(text).toContain('DTEND;VALUE=DATE:20261102')
    // A floating event would be drawn at some hour the reader never chose.
    expect(text).not.toMatch(/DTSTART:(?!;VALUE=DATE)/)
  })

  it('escapes what the format reserves, and folds a long line at the byte limit', () => {
    const text = document([item({ name: 'Disney, Plus; "deluxe"' })])
    expect(text).toContain('SUMMARY:Disney\\, Plus\\; "deluxe"')

    const long = document([item({ name: '一'.repeat(60) })])
    const folded = long.split('\r\n').filter((line) => line.startsWith(' '))
    expect(folded.length, 'a 60-character Han name should have to fold').toBeGreaterThan(0)
    for (const line of long.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8'), `line over the limit: ${line.slice(0, 20)}`).toBeLessThanOrEqual(74)
    }
  })

  it('gives each plan the same identifier every time, so a client updates rather than duplicates', () => {
    const first = document([item({ id: 'sub-9' })])
    const second = document([item({ id: 'sub-9' })])
    expect(first).toContain('UID:sub-9@inkstone.subscriptions')
    expect(first.replace('DTSTAMP:20261021T000000Z', '')).toBe(second.replace('DTSTAMP:20261021T000000Z', ''))
  })

  it('leaves out a plan that is switched off, and never carries a note', () => {
    const text = document([
      item({ id: 'live' }),
      item({ id: 'off', isActive: false, name: 'Stopped' }),
      item({ id: 'noted', name: 'WithNotes', notes: 'shared with 张伟, 密码在邮箱里' }),
    ])
    expect(text).toContain('UID:live@inkstone.subscriptions')
    expect(text).toContain('UID:noted@inkstone.subscriptions')
    expect(text).not.toContain('Stopped')
    // The link is a bearer credential; the note is the one field a reader may have used for anything.
    expect(text).not.toContain('张伟')
    expect(text).not.toContain('密码')
  })
})

describe('the calendar link', () => {
  function env() {
    return { DB: db } as unknown as AppBindings['Bindings']
  }

  async function token(): Promise<string> {
    const created = await rotateInboundToken(db, ALICE)
    return created.token
  }

  async function seed(name: string): Promise<void> {
    const store = new SubscriptionsStore(db, ALICE)
    await store.create({
      name,
      amount: 60,
      currency: 'CNY',
      expiryDate: '2026-11-05T00:00:00.000Z',
      periodValue: 1,
      periodUnit: 'month',
      subscriptionMode: 'cycle',
    }, storeContext({ ...DEFAULT_SETTINGS, timezone: 'Asia/Shanghai' }, Date.parse('2026-10-21T00:00:00Z')))
  }

  it('answers a good token with a calendar and says it must not be cached', async () => {
    await seed('Netflix')
    const response = await app.request(`/hooks/subscriptions/calendar/${await token()}`, undefined, env())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/calendar')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).toContain('BEGIN:VCALENDAR')
    expect(body).toContain('SUMMARY:Netflix')
  })

  it('refuses a token that is not one, and does not say why in a way that maps accounts', async () => {
    const response = await app.request('/hooks/subscriptions/calendar/not-a-token', undefined, env())
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('alice')
  })

  it('hands out no plan of anybody else to a token from another account', async () => {
    await seed('MineOnly')
    const other = await rotateInboundToken(db, 'user-bob')
    const response = await app.request(`/hooks/subscriptions/calendar/${other.token}`, undefined, env())
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('MineOnly')
  })

  it('brakes a client that polls the same link past the minute, and leaves the neighbours alone', async () => {
    await seed('Polled')
    const presented = await token()
    const statuses: number[] = []
    for (let fetch = 0; fetch < 31; fetch += 1) {
      const response = await app.request(`/hooks/subscriptions/calendar/${presented}`, undefined, env())
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => 200))
    expect(statuses[30]).toBe(429)
    // The brake is keyed by link, so a second device with its own token is not punished for the first.
    const neighbour = await rotateInboundToken(db, 'user-carol')
    expect((await app.request(`/hooks/subscriptions/calendar/${neighbour.token}`, undefined, env())).status).toBe(200)
  })
})
