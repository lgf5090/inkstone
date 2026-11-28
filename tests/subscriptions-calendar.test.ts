// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import ICAL from 'ical.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { subscriptionInboundRoutes } from '../src/worker/routes/subscriptions-inbound'
import { buildEvents, toICal } from '../src/worker/subscriptions/calendar'
import { parseIcsCalendar } from '../src/worker/calendar/ics'
import { rotateCalendarToken, rotateInboundToken } from '../src/worker/subscriptions/settings'
import { SubscriptionsStore, storeContext } from '../src/worker/subscriptions/store'
import { DEFAULT_SETTINGS } from '../src/shared/subscriptions/model'
import type { ReminderRule, SubscriptionItem } from '../src/shared/subscriptions/model'
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
    trialEndsAt: null, paymentMethod: '', managementUrl: '', pausedUntil: null, fixedTerm: false, introPrice: null,
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

function rule(overrides: Partial<ReminderRule> = {}): ReminderRule {
  return {
    id: 'rule-1',
    type: 'before_expiry',
    value: 7,
    unit: 'days',
    repeatInterval: null,
    repeatUntil: 'renewed',
    acknowledgedAt: null,
    isEnabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function document(items: Partial<SubscriptionItem>[], now = STAMP): string {
  return toICal(buildEvents(items.map((overrides) => item(overrides)), 'UTC', now), { name: 'Inkstone', stamp: now })
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

  it('uses the account timezone for the all-day date', () => {
    const [event] = buildEvents([item({ expiryDate: '2026-11-01T00:00:00.000Z' })], 'America/New_York')
    expect(event?.day).toBe('2026-10-31')
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
      expect(Buffer.byteLength(line, 'utf8'), `line over the limit: ${line.slice(0, 20)}`).toBeLessThanOrEqual(75)
    }
  })

  it('round-trips reserved text through ical.js without losing slashes or line breaks', () => {
    const title = 'Path C:\\media, semi; quote " and\r\nnext line'
    const detail = '1 month · 60 CNY\\legacy\nrenewal'
    const text = toICal([{
      uid: 'sub-9@inkstone.subscriptions', day: '2026-11-01', title, detail,
    }], { name: 'Inkstone', stamp: STAMP })

    const parsed = parseIcsCalendar({ content: text, defaultTimeZone: 'UTC', maxEvents: 10 })
    expect(parsed.events).toHaveLength(1)
    expect(parsed.events[0]).toMatchObject({
      title: title.replace(/\r\n/g, '\n'),
      description: detail.replace(/\r\n/g, '\n'),
      start: { value: '2026-11-01', type: 'date' },
      end: { value: '2026-11-02', type: 'date' },
    })
  })

  it('escapes an injected uid and refuses a day that is not a plain date', () => {
    const text = toICal([
      { uid: 'x\r\nBEGIN:VEVENT\r\nSUMMARY:injected', day: '2026-11-01', title: 'Safe', detail: '' },
      { uid: 'bad-day', day: '2026-11-01\r\nATTACH:http://evil', title: 'Bad', detail: '' },
    ], { name: 'Inkstone', stamp: STAMP })
    const lines = text.split('\r\n')
    expect(lines.filter((entry) => entry === 'BEGIN:VEVENT')).toHaveLength(1)
    expect(lines.some((entry) => entry.startsWith('ATTACH:'))).toBe(false)
    expect(text).toContain('UID:x\\nBEGIN:VEVENT\\nSUMMARY:injected')
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

  it('publishes a solar cycle from its current expiry with the requested frequency and interval', () => {
    const cases = [
      { periodUnit: 'day', periodValue: 3, expected: 'RRULE:FREQ=DAILY;INTERVAL=3' },
      { periodUnit: 'week', periodValue: 2, expected: 'RRULE:FREQ=WEEKLY;INTERVAL=2' },
      { periodUnit: 'month', periodValue: 4, expected: 'RRULE:FREQ=MONTHLY;INTERVAL=4' },
      { periodUnit: 'year', periodValue: 1, expected: 'RRULE:FREQ=YEARLY' },
    ] as const
    for (const entry of cases) {
      const text = document([item({
        ...entry,
        startDate: '2025-01-01T00:00:00.000Z',
        expiryDate: '2026-11-01T00:00:00.000Z',
      })])
      expect(text).toContain('DTSTART;VALUE=DATE:20261101')
      expect(text).toContain(entry.expected)
      expect(text).toContain('METHOD:PUBLISH')
    }
  })

  it('does not invent recurrence for lunar, reset, fixed-term, or manually renewed plans', () => {
    for (const overrides of [
      { useLunar: true },
      { subscriptionMode: 'reset' as const },
      { fixedTerm: true },
      { autoRenew: false },
    ]) {
      const text = document([item(overrides)])
      expect(text).toContain('DTSTART;VALUE=DATE:20261101')
      expect(text).toContain('DTEND;VALUE=DATE:20261102')
      expect(text).not.toContain('RRULE:')
    }
  })

  it('turns enabled future before/on rules into alarms and leaves disabled, past, and after rules out', () => {
    const text = document([item({
      reminderRules: [
        rule(),
        rule({ id: 'hours', value: 2, unit: 'hours' }),
        rule({ id: 'on', type: 'on_expiry', value: 0 }),
        rule({ id: 'off', value: 5, isEnabled: false }),
        rule({ id: 'past', value: 30 }),
        rule({ id: 'after', type: 'after_expiry', value: 1 }),
      ],
    })])
    expect(text).toContain('BEGIN:VALARM')
    expect(text).toContain('ACTION:DISPLAY')
    expect(text).toContain('TRIGGER:-P7D')
    expect(text).toContain('TRIGGER:-PT2H')
    expect(text).toContain('TRIGGER:0')
    expect(text.match(/BEGIN:VALARM/g)).toHaveLength(3)
    expect(text).not.toContain('TRIGGER:-P5D')
    expect(text).not.toContain('TRIGGER:-P30D')
  })

  it('anchors future trial alarms to a separate single event rather than the expiry series', () => {
    const text = document([item({
      expiryDate: '2026-12-01T00:00:00.000Z',
      trialEndsAt: '2026-11-10T00:00:00.000Z',
      reminderRules: [
        rule({ id: 'trial', type: 'before_trial_end', value: 3 }),
        rule({ id: 'expired-trial', type: 'before_trial_end', value: 30 }),
      ],
    })])
    expect(text).toContain('UID:sub-1@inkstone.subscriptions')
    expect(text).toContain('UID:sub-1-trial@inkstone.subscriptions')
    expect(text).toContain('DTSTART;VALUE=DATE:20261110')
    expect(text).toContain('TRIGGER:-P3D')
    expect(text).not.toContain('TRIGGER:-P30D')
    expect(text.match(/RRULE:/g)).toHaveLength(1)
    const parsed = ICAL.Component.fromString(text)
    const trial = parsed.getAllSubcomponents('vevent')
      .find(event => event.getFirstPropertyValue('uid') === 'sub-1-trial@inkstone.subscriptions')
    expect(trial?.getFirstProperty('rrule')).toBeNull()
  })

  it('omits plans paused beyond the feed clock but keeps active past dates as recurrence anchors', () => {
    const text = document([
      item({ id: 'live' }),
      item({ id: 'past', expiryDate: '2026-10-20T23:59:59.000Z' }),
      item({ id: 'paused', pausedUntil: '2026-10-22T00:00:00.000Z' }),
      item({ id: 'resumed', pausedUntil: '2026-10-20T00:00:00.000Z' }),
    ])
    expect(text).toContain('UID:live@inkstone.subscriptions')
    expect(text).toContain('UID:past@inkstone.subscriptions')
    expect(text).toContain('UID:resumed@inkstone.subscriptions')
    expect(text).not.toContain('UID:paused@inkstone.subscriptions')
  })

  it('keeps expiry alarms but not trial events once the trial target has passed', () => {
    const text = document([item({
      trialEndsAt: '2026-10-20T00:00:00.000Z',
      reminderRules: [rule({ id: 'trial', type: 'before_trial_end', value: 3 }), rule()],
    })])
    expect(text).not.toContain('UID:sub-1-trial@inkstone.subscriptions')
    expect(text).toContain('TRIGGER:-P7D')
  })
})

describe('the calendar link', () => {
  function env() {
    return { DB: db } as unknown as AppBindings['Bindings']
  }

  async function token(): Promise<string> {
    const created = await rotateCalendarToken(db, ALICE)
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
    const other = await rotateCalendarToken(db, 'user-bob')
    const response = await app.request(`/hooks/subscriptions/calendar/${other.token}`, undefined, env())
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('MineOnly')
  })

  it('keeps calendar read tokens and webhook write tokens separate', async () => {
    const calendar = await rotateCalendarToken(db, ALICE)
    const inbound = await rotateInboundToken(db, ALICE)
    expect((await app.request(`/hooks/subscriptions/calendar/${inbound.token}`, undefined, env())).status).toBe(404)
    expect((await app.request(`/hooks/subscriptions/${calendar.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'must not send' }),
    }, env())).status).toBe(404)
    expect((await app.request(`/hooks/subscriptions/calendar/${calendar.token}`, undefined, env())).status).toBe(200)
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
    const neighbour = await rotateCalendarToken(db, 'user-carol')
    expect((await app.request(`/hooks/subscriptions/calendar/${neighbour.token}`, undefined, env())).status).toBe(200)
  })
})
