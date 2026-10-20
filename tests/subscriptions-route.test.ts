// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { subscriptionRoutes } from '../src/worker/routes/subscriptions'
import { enabledChannels } from '../src/worker/subscriptions/settings'
import { BULK_LIMIT } from '../src/shared/subscriptions/model'
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
  it('answers with items, labels, settings, channels and the overview', async () => {
    await create()
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.items).toHaveLength(1)
    expect(bundle.categories).toEqual([{ name: 'family', icon: '', color: '' }])
    expect(bundle.types).toEqual([{ name: 'streaming', icon: '', color: '' }])
    expect(bundle.settings.timezone).toBe('Asia/Shanghai')
    // Named rather than counted: a settings screen that lost a row, or gained one the sweep cannot send
    // to, is the thing a reader notices, and a count answers neither.
    expect(bundle.channels.map((channel: { kind: string }) => channel.kind)).toEqual([
      'inapp', 'telegram', 'notifyx', 'webhook', 'wechatbot', 'email', 'bark', 'gotify', 'serverchan', 'pushplus',
    ])
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

  /**
   * Deletion is two steps now, and this is the test that says which one destroys what.
   *
   * It used to assert that one `DELETE` cleared `sub_payment` too — which is precisely the behaviour the
   * trash exists to remove, since a mis-tap was erasing years of receipts with the row.
   */
  it('trashes the subscription, and only a purge takes the receipts with it', async () => {
    const created = await create({ amount: 60 })
    expect((await send('DELETE', `/${created.item.id}`)).status).toBe(200)
    const before = sqlite.prepare(`SELECT COUNT(*) AS count FROM sub_payment`).get() as { count: number }
    expect(before.count).toBe(1)

    expect((await send('DELETE', `/${created.item.id}/purge`)).status).toBe(200)
    expect((await send('GET', `/${created.item.id}`)).status).toBe(404)
    const after = sqlite.prepare(`SELECT COUNT(*) AS count FROM sub_payment`).get() as { count: number }
    expect(after.count).toBe(0)
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

  it('turns the in-app channel on when there is no vault to ask', async () => {
    // Nothing about this channel is a credential, so a deployment that cannot encrypt must still be able to
    // deliver into the reader's own inbox. A kind that does hold a token must still refuse — that is the
    // other half of the same rule, and the reason this is not simply "skip the vault".
    const noVault = { DB: db } as unknown as AppBindings['Bindings']
    const response = await app.request('/api/subscriptions/channels/inapp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }, noVault)
    expect(response.status).toBe(200)
    const saved = await json<{ channel: { enabled: boolean, configured: boolean, hint: string } }>(response)
    expect(saved.channel.enabled).toBe(true)
    expect(saved.channel.configured).toBe(true)
    expect(saved.channel.hint).toBe('')

    const telegram = await app.request('/api/subscriptions/channels/telegram', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, config: { botToken: 'x'.repeat(12), chatId: '42' } }),
    }, noVault)
    expect(telegram.status).not.toBe(200)
  })

  it('hands the sweep an in-app channel that has nothing to decrypt', async () => {
    await send('PUT', '/channels/inapp', { enabled: true })
    const noVault = { DB: db } as unknown as AppBindings['Bindings']
    const channels = await enabledChannels(noVault, db, mocks.userId)
    expect(channels.map((channel) => channel.kind)).toContain('inapp')
    // A row that was never saved is not a channel that can send, and an account's rows stay its own.
    const other = await enabledChannels(noVault, db, BOB)
    expect(other).toEqual([])
  })
})

describe('bulk actions', () => {
  it('changes every subscription the call names', async () => {
    const first = await create({ name: 'First' })
    const second = await create({ name: 'Second' })
    const response = await send('POST', '/bulk', { action: 'deactivate', ids: [first.item.id, second.item.id] })
    expect(response.status).toBe(200)
    expect((await json<any>(response)).changed).toBe(2)
  })

  it('refuses a list past the cap instead of quietly doing the first two hundred', async () => {
    const ids = Array.from({ length: BULK_LIMIT + 1 }, (_, index) => `sub-${index}`)
    const response = await send('POST', '/bulk', { action: 'deactivate', ids })
    expect(response.status).toBe(400)
    expect((await json<any>(response)).error.message).toContain(String(BULK_LIMIT))
  })
})

describe('the rate table behind the dashboard', () => {
  /**
   * Which of the two ways the numbers came in is asserted as a set rather than a value because the suite
   * does not stand between this test and the currency service: an account read with the network up answers
   * `feed`, one read with it down answers `approximate`, and both are honest answers.
   */
  it('says where the totals got their rates, and which currency they are added up in', async () => {
    const bundle = await json<any>(await send('GET', '/'))
    expect(['feed', 'approximate']).toContain(bundle.overview.rates.source)
    expect(bundle.overview.rates.base).toBe('CNY')
    expect(bundle.overview.rates.basePriced).toBe(true)
    expect(bundle.overview.rates.unpriced).toEqual([])
  })

  it('forgets the cached day when asked and answers with what it holds now', async () => {
    const response = await send('POST', '/rates/refresh')
    expect(response.status).toBe(200)
    const body = await json<{ source: string, at: number | null }>(response)
    expect(['feed', 'approximate']).toContain(body.source)
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

describe('the label registry', () => {
  /**
   * The bug this exists for: the reference project stored the whole composite string as one category,
   * so a two-tag value came back as a single suggestion while the filter rail had split it into two rows.
   * The registry has to learn the tokens, because that is what every consumer matches on.
   */
  it('registers each category token rather than the whole string', async () => {
    await create({ category: 'video / music' })
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.categories.map((entry: any) => entry.name)).toEqual(['music', 'video'])
  })

  it('never splits a type, which is one label and not a pile of tags', async () => {
    await create({ customType: 'video/music' })
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.types.map((entry: any) => entry.name)).toEqual(['video/music'])
  })

  it('keeps a face the reader chose', async () => {
    await create()
    const styled = await json<any>(await send('PUT', '/labels/category/style', {
      name: 'family',
      icon: 'lucide:Home',
      color: '#059669',
    }))
    expect(styled.label).toEqual({ name: 'family', icon: 'lucide:Home', color: '#059669' })
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.categories).toEqual([{ name: 'family', icon: 'lucide:Home', color: '#059669' }])
  })

  it('refuses an icon outside the offered set and a colour outside the palette', async () => {
    await create()
    expect((await send('PUT', '/labels/category/style', { name: 'family', icon: 'lucide:NotAnIcon' })).status).toBe(400)
    expect((await send('PUT', '/labels/category/style', { name: 'family', color: '#123456' })).status).toBe(400)
    expect((await send('PUT', '/labels/category/style', { name: 'family', icon: 'Home' })).status).toBe(400)
    expect((await send('PUT', '/labels/category/style', { name: 'family' })).status).toBe(400)
  })

  /**
   * The axis nobody mentions is the axis nobody wants touched.
   *
   * A picker that sent the *resolved* icon alongside a colour change would store the default as a
   * decision, and from that moment a preset change could never reach the label again — the reader would
   * be stuck with whatever the app guessed on the day they only wanted a different colour.
   */
  it('changes one axis without disturbing the other', async () => {
    await create()
    await send('PUT', '/labels/category/style', { name: 'family', icon: 'lucide:Home' })
    const recoloured = await json<any>(await send('PUT', '/labels/category/style', { name: 'family', color: '#059669' }))
    expect(recoloured.label).toEqual({ name: 'family', icon: 'lucide:Home', color: '#059669' })
    const repainted = await json<any>(await send('PUT', '/labels/category/style', { name: 'family', icon: 'lucide:User' }))
    expect(repainted.label).toEqual({ name: 'family', icon: 'lucide:User', color: '#059669' })
  })

  it('clears one axis on request without clearing the other', async () => {
    await create()
    await send('PUT', '/labels/category/style', { name: 'family', icon: 'lucide:Home', color: '#059669' })
    const cleared = await json<any>(await send('PUT', '/labels/category/style', { name: 'family', icon: null }))
    expect(cleared.label).toEqual({ name: 'family', icon: '', color: '#059669' })
  })

  it('carries a rename into the subscriptions that used the old name', async () => {
    const created = await create({ category: 'video / music' })
    const after = await json<any>(await send('PUT', '/labels/category/rename', { name: 'video', to: 'film' }))
    expect(after.labels.map((entry: any) => entry.name)).toEqual(['film', 'music'])
    const detail = await json<any>(await send('GET', `/${created.item.id}`))
    expect(detail.item.category).toBe('film/music')
  })

  it('leaves the subscription text alone when a name is removed', async () => {
    const created = await create()
    const after = await json<any>(await send('DELETE', '/labels/category?name=family'))
    expect(after.labels).toEqual([])
    const detail = await json<any>(await send('GET', `/${created.item.id}`))
    expect(detail.item.category).toBe('family')
  })

  it('refuses a rename onto a name already taken', async () => {
    await create({ category: 'family' })
    await send('POST', '/labels/category', { name: 'work' })
    const response = await send('PUT', '/labels/category/rename', { name: 'work', to: 'family' })
    expect(response.status).toBe(400)
  })

  it('is nobody else\'s registry', async () => {
    await create()
    mocks.userId = BOB
    expect((await json<any>(await send('GET', '/labels/category'))).labels).toEqual([])
    expect((await send('DELETE', '/labels/category?name=family')).status).toBe(200)
    mocks.userId = ALICE
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.categories.map((entry: any) => entry.name)).toEqual(['family'])
  })
})

describe('the trash', () => {
  it('moves a subscription out of the list without losing its history', async () => {
    const created = await create({ amount: 60 })
    expect((await send('DELETE', `/${created.item.id}`)).status).toBe(200)

    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.items).toHaveLength(0)
    expect(bundle.trashCount).toBe(1)
    expect(bundle.overview.active.total).toBe(0)
    // The headline is the reason the row is worth keeping: six months of receipts, still there.
    expect(bundle.overview.monthly.amount).toBeGreaterThan(0)

    const trashed = await json<any>(await send('GET', '/trash'))
    expect(trashed.items).toHaveLength(1)
    expect(trashed.items[0].deletedAt).toBeTruthy()
    const detail = await json<any>(await send('GET', `/${created.item.id}`))
    expect(detail.payments).toHaveLength(1)
    expect(detail.rules.length).toBeGreaterThan(0)
  })

  it('restores a subscription with its receipts intact', async () => {
    const created = await create({ amount: 60 })
    await send('DELETE', `/${created.item.id}`)
    const restored = await json<any>(await send('POST', `/${created.item.id}/restore`))
    expect(restored.item.deletedAt).toBeNull()
    expect(restored.payments).toHaveLength(1)

    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.items).toHaveLength(1)
    expect(bundle.trashCount).toBe(0)
  })

  it('refuses to restore something that is not in the trash', async () => {
    const created = await create()
    expect((await send('POST', `/${created.item.id}/restore`)).status).toBe(404)
  })

  it('erases a subscription and everything under it only when told to', async () => {
    const created = await create({ amount: 60 })
    await send('DELETE', `/${created.item.id}`)
    expect((await send('DELETE', `/${created.item.id}/purge`)).status).toBe(200)

    const trashed = await json<any>(await send('GET', '/trash'))
    expect(trashed.items).toHaveLength(0)
    // The receipts went with it, so the money total went too.
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.overview.monthly.amount).toBe(0)
    expect((await send('GET', `/${created.item.id}`)).status).toBe(404)
  })

  it('empties the trash in one go', async () => {
    const first = await create({ name: 'One' })
    const second = await create({ name: 'Two' })
    await send('DELETE', `/${first.item.id}`)
    await send('DELETE', `/${second.item.id}`)
    const emptied = await json<any>(await send('POST', '/trash/empty'))
    expect(emptied.purged).toBe(2)
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.trashCount).toBe(0)
    expect(bundle.items).toHaveLength(0)
  })

  it('keeps another account out of the trash', async () => {
    const created = await create()
    await send('DELETE', `/${created.item.id}`)
    mocks.userId = BOB
    expect((await json<any>(await send('GET', '/trash'))).items).toEqual([])
    expect((await send('POST', `/${created.item.id}/restore`)).status).toBe(404)
    expect((await send('DELETE', `/${created.item.id}/purge`)).status).toBe(404)
    mocks.userId = ALICE
    const bundle = await json<any>(await send('GET', '/'))
    expect(bundle.trashCount).toBe(1)
  })
})

describe('the global search over subscriptions', () => {
  it('finds a plan by name, type, category or note, whatever case it was typed in', async () => {
    await create({ name: 'Netflix', customType: 'streaming', category: 'family', notes: 'shared with 弟弟' })
    for (const q of ['netfl', 'STREAMING', 'FAMILY', '弟弟']) {
      const answer = await json<any>(await send('GET', `/search?q=${encodeURIComponent(q)}`))
      expect(answer.items.map((item: any) => item.name), `"${q}" should have matched`).toEqual(['Netflix'])
    }
  })

  it('answers nothing for an empty query, because the reader has not asked yet', async () => {
    await create()
    const answer = await json<any>(await send('GET', '/search?q='))
    expect(answer.items).toEqual([])
  })

  it('keeps a trashed plan out of the results', async () => {
    const created = await create({ name: 'Figma' })
    await send('DELETE', `/${created.item.id}`)
    const answer = await json<any>(await send('GET', '/search?q=figma'))
    expect(answer.items).toEqual([])
  })

  it('orders soonest first and stops at the limit, under a path that the id route would otherwise take', async () => {
    await create({ name: 'Far Plan', expiryDate: inDays(200) })
    await create({ name: 'Soon Plan', expiryDate: inDays(2) })
    await create({ name: 'Middle Plan', expiryDate: inDays(30) })
    const answer = await json<any>(await send('GET', '/search?q=plan&limit=2'))
    expect(answer.items.map((item: any) => item.name)).toEqual(['Soon Plan', 'Middle Plan'])
  })
})
