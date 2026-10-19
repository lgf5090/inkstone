// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { subscriptionRoutes } from '../src/worker/routes/subscriptions'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

/**
 * A stand-in for the credential vault: base64 in, base64 out.
 *
 * The real one encrypts; what the routes depend on is only that a value survives the round trip and
 * that the stored form is not the plaintext, which is what this proves without a Durable Object.
 */
const secrets = new Map<string, string>()
const vault = {
  idFromName: (name: string) => name,
  get: () => ({
    fetch: async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { scope: string; value?: unknown; ciphertext?: string }
      if (url.endsWith('/encrypt')) {
        const ciphertext = Buffer.from(JSON.stringify(body.value)).toString('base64')
        secrets.set(ciphertext, body.scope)
        return Response.json({ ciphertext })
      }
      const stored = body.ciphertext ?? ''
      if (!secrets.has(stored)) return new Response('no', { status: 422 })
      return Response.json({ value: JSON.parse(Buffer.from(stored, 'base64').toString('utf8')) })
    },
  }),
}

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/subscriptions', subscriptionRoutes)

function env() {
  return { DB: db, CREDENTIAL_VAULT: vault } as unknown as AppBindings['Bindings']
}

async function send(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return app.request(`/api/subscriptions${path === '/' ? '' : path}`, init, env())
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

const DAY = 86_400_000

function inDays(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString()
}

async function create(overrides: Record<string, unknown> = {}) {
  const response = await send('POST', '/', {
    name: 'Netflix',
    customType: 'streaming',
    category: 'family',
    amount: 60,
    currency: 'CNY',
    expiryDate: inDays(20),
    periodValue: 1,
    periodUnit: 'month',
    ...overrides,
  })
  expect(response.status).toBe(201)
  return await json<any>(response)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  secrets.clear()
  mocks.userId = ALICE
})

describe('creating a subscription', () => {
  it('stores it with the preset rules and an opening receipt', async () => {
    const detail = await create()
    expect(detail.item.name).toBe('Netflix')
    expect(detail.item.amount).toBe(60)
    expect(detail.rules).toHaveLength(4)
    expect(detail.payments).toHaveLength(1)
    expect(detail.payments[0].kind).toBe('initial')
    expect(detail.payments[0].amount).toBe(60)
    expect(detail.item.paymentCount).toBe(1)
    expect(detail.item.paidTotal).toBe(60)
    expect(detail.item.daysRemaining).toBeGreaterThanOrEqual(19)
  })

  it('rolls a past expiry forward instead of storing it', async () => {
    const detail = await create({ expiryDate: inDays(-45) })
    expect(Date.parse(detail.item.expiryDate)).toBeGreaterThan(Date.now())
  })

  it('refuses a nameless subscription', async () => {
    const response = await send('POST', '/', { name: '  ', expiryDate: inDays(3) })
    expect(response.status).toBe(400)
  })

  it('refuses an unknown currency', async () => {
    const response = await send('POST', '/', { name: 'X', expiryDate: inDays(3), currency: 'BTC' })
    expect(response.status).toBe(400)
  })

  it('refuses a lunar date outside the table', async () => {
    const response = await send('POST', '/', {
      name: 'Old',
      expiryDate: '1850-01-01T00:00:00.000Z',
      useLunar: true,
      periodValue: 1,
      periodUnit: 'year',
    })
    expect(response.status).toBe(400)
  })
})

describe('the bundle', () => {
  it('answers with items, categories, settings, channels and the overview', async () => {
    await create()
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.items).toHaveLength(1)
    expect(bundle.categories).toEqual(['family'])
    expect(bundle.settings.timezone).toBe('Asia/Shanghai')
    expect(bundle.channels).toHaveLength(9)
    expect(bundle.channels.every((channel: any) => channel.configured === false)).toBe(true)
    expect(bundle.overview.active.total).toBe(1)
    expect(bundle.overview.months).toHaveLength(6)
    expect(bundle.overview.timezone).toBe('Asia/Shanghai')
  })

  it('counts the month the receipt was written in', async () => {
    await create({ amount: 120 })
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.overview.monthly.amount).toBe(120)
    expect(bundle.overview.yearly.amount).toBe(120)
  })
})

describe('updating', () => {
  it('keeps the opening receipt in step with a corrected price', async () => {
    const created = await create()
    const detail = await json<any>(await send('PUT', `/${created.item.id}`, {
      name: 'Netflix',
      amount: 88,
      expiryDate: created.item.expiryDate,
    }))
    expect(detail.item.amount).toBe(88)
    expect(detail.payments).toHaveLength(1)
    expect(detail.payments[0].amount).toBe(88)
  })

  it('toggles the subscription off without touching its dates', async () => {
    const created = await create()
    const detail = await json<any>(await send('POST', `/${created.item.id}/toggle`, { isActive: false }))
    expect(detail.item.isActive).toBe(false)
    expect(detail.item.expiryDate).toBe(created.item.expiryDate)
  })

  it('removes the subscription and everything under it', async () => {
    const created = await create()
    expect((await send('DELETE', `/${created.item.id}`)).status).toBe(200)
    expect((await send('GET', `/${created.item.id}`)).status).toBe(404)
    const rows = sqlite.prepare(`SELECT COUNT(*) AS count FROM sub_payment`).get() as { count: number }
    expect(rows.count).toBe(0)
  })
})

describe('renewing', () => {
  it('extends from the current expiry in cycle mode', async () => {
    const created = await create()
    const detail = await json<any>(await send('POST', `/${created.item.id}/renew`, { periodMultiplier: 2 }))
    const before = Date.parse(created.item.expiryDate)
    const after = Date.parse(detail.item.expiryDate)
    expect(after).toBeGreaterThan(before)
    expect(detail.payments).toHaveLength(2)
    expect(detail.payments[0].kind).toBe('manual')
  })

  it('starts a fresh term from the payment date in reset mode', async () => {
    const created = await create({ subscriptionMode: 'reset', expiryDate: inDays(40) })
    const detail = await json<any>(await send('POST', `/${created.item.id}/renew`, {}))
    const months = detail.item.expiryDate.slice(0, 7)
    const expected = new Date(Date.now())
    expected.setMonth(expected.getMonth() + 1)
    expect(months).toBe(expected.toISOString().slice(0, 7))
  })
})

describe('payment history', () => {
  it('reverts the expiry date when a receipt is removed', async () => {
    const created = await create()
    const renewed = await json<any>(await send('POST', `/${created.item.id}/renew`, {}))
    const manual = renewed.payments.find((payment: any) => payment.kind === 'manual')
    const reverted = await json<any>(await send('DELETE', `/${created.item.id}/payments/${manual.id}`))
    expect(Date.parse(reverted.item.expiryDate)).toBe(Date.parse(created.item.expiryDate))
    expect(reverted.payments).toHaveLength(1)
  })

  it('edits a receipt without moving the expiry date', async () => {
    const created = await create()
    const initial = created.payments[0]
    const detail = await json<any>(await send('PUT', `/${created.item.id}/payments/${initial.id}`, { amount: 42 }))
    expect(detail.payments[0].amount).toBe(42)
    expect(detail.item.expiryDate).toBe(created.item.expiryDate)
  })
})

describe('reminder rules', () => {
  it('applies the preset over whatever was there', async () => {
    const created = await create()
    await send('PUT', `/${created.item.id}/reminders`, { rules: [{ type: 'on_expiry', value: 0, unit: 'days' }] })
    const after = await json<any>(await send('POST', `/${created.item.id}/reminders`, { preset: true }))
    expect(after.rules).toHaveLength(4)
    expect(after.rules.map((rule: any) => rule.value)).toEqual([7, 3, 1, 0])
  })

  it('reports the next reminder', async () => {
    const created = await create({ expiryDate: inDays(10) })
    const answer = await json<any>(await send('GET', `/${created.item.id}/next-reminder`))
    expect(answer.nextReminder).not.toBeNull()
    expect(answer.allUpcoming.length).toBeGreaterThan(0)
  })

  it('refuses a rule that does not exist', async () => {
    const created = await create()
    expect((await send('DELETE', `/${created.item.id}/reminders/nope`)).status).toBe(404)
  })
})

describe('settings', () => {
  it('saves a time zone and normalises the hours', async () => {
    const answer = await json<any>(await send('PUT', '/settings', {
      timezone: 'Europe/London',
      notificationHours: ['8', '20', '8'],
    }))
    expect(answer.settings.timezone).toBe('Europe/London')
    expect(answer.settings.notificationHours).toEqual(['08', '20'])
  })

  it('refuses a time zone that does not exist', async () => {
    expect((await send('PUT', '/settings', { timezone: 'Mars/Olympus' })).status).toBe(400)
  })

  it('rotates an inbound token and never stores it in the clear', async () => {
    const first = await json<any>(await send('POST', '/inbound-token'))
    expect(first.token).toHaveLength(20)
    const row = sqlite.prepare(`SELECT inbound_token_hash, inbound_token_hint FROM sub_settings`).get() as {
      inbound_token_hash: string
      inbound_token_hint: string
    }
    expect(row.inbound_token_hash).not.toBe(first.token)
    expect(row.inbound_token_hint).toBe(first.token.slice(-4))
  })
})

describe('channels', () => {
  it('stores a configuration encrypted and reports only a hint', async () => {
    const saved = await json<any>(await send('PUT', '/channels/telegram', {
      enabled: true,
      config: { botToken: 'secret-token-1234', chatId: '42' },
    }))
    expect(saved.channel.enabled).toBe(true)
    expect(saved.channel.configured).toBe(true)
    expect(saved.channel.hint).toBe('••••1234')

    const listed = await json<any>(await send('GET', '/channels'))
    const telegram = listed.channels.find((channel: any) => channel.kind === 'telegram')
    expect(JSON.stringify(listed)).not.toContain('secret-token-1234')
    expect(telegram.configured).toBe(true)

    const row = sqlite.prepare(`SELECT config_ciphertext FROM sub_channel WHERE kind = 'telegram'`).get() as {
      config_ciphertext: string
    }
    expect(row.config_ciphertext).not.toContain('secret-token-1234')
  })

  it('keeps a stored secret when the form leaves it blank', async () => {
    await send('PUT', '/channels/telegram', { config: { botToken: 'secret-token-1234', chatId: '42' } })
    const second = await send('PUT', '/channels/telegram', { config: { botToken: '', chatId: '43' } })
    expect(second.status).toBe(200)
    const stored = await json<any>(await send('GET', '/channels'))
    expect(stored.channels.find((channel: any) => channel.kind === 'telegram').hint).toBe('••••1234')
    const decrypted = secrets.size
    expect(decrypted).toBeGreaterThan(0)
  })

  it('refuses a channel missing a required field', async () => {
    expect((await send('PUT', '/channels/webhook', { config: { url: '' } })).status).toBe(400)
  })

  it('refuses a field that is not a URL', async () => {
    expect((await send('PUT', '/channels/webhook', { config: { url: 'not-a-url' } })).status).toBe(400)
  })

  it('clears a channel without deleting its row', async () => {
    await send('PUT', '/channels/telegram', { config: { botToken: 'x'.repeat(12), chatId: '42' } })
    const after = await json<any>(await send('DELETE', '/channels/telegram'))
    expect(after.channels.find((channel: any) => channel.kind === 'telegram').configured).toBe(false)
  })
})

describe('one account cannot see another', () => {
  it('answers 404 for somebody else id', async () => {
    const created = await create()
    mocks.userId = BOB
    expect((await send('GET', `/${created.item.id}`)).status).toBe(404)
    expect((await send('PUT', `/${created.item.id}`, { name: 'Mine now', expiryDate: inDays(3) })).status).toBe(404)
    expect((await send('DELETE', `/${created.item.id}`)).status).toBe(404)
    expect((await send('POST', `/${created.item.id}/renew`, {})).status).toBe(404)
    expect((await send('GET', `/${created.item.id}/payments`)).status).toBe(404)
  })

  it('gives each account its own list', async () => {
    await create()
    mocks.userId = BOB
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.items).toEqual([])
  })
})

describe('logs', () => {
  it('starts empty and answers a filter', async () => {
    const notify = await json<any>(await send('GET', '/logs/notify?status=failed&limit=5'))
    expect(notify.logs).toEqual([])
    const schedule = await json<any>(await send('GET', '/logs/schedule?limit=5'))
    expect(schedule.logs).toEqual([])
  })
})
