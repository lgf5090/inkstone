// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { sweepSubscriptions } from '../src/worker/subscriptions/scheduler'
import { saveChannel, saveSettings } from '../src/worker/subscriptions/settings'
import { SubscriptionsStore, storeContext } from '../src/worker/subscriptions/store'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const DAY = 86_400_000
const NOW = Date.parse('2026-05-24T04:00:00Z')

let sqlite: DatabaseSync
let db: D1Database
let deliveries: string[]
const secrets = new Set<string>()

/* The one binding a double cannot describe structurally: only `idFromName`/`get` are ever reached here. */
const vault = {
  idFromName: (name: string) => name,
  get: () => ({
    fetch: async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { value?: unknown; ciphertext?: string }
      if (url.endsWith('/encrypt')) {
        const ciphertext = Buffer.from(JSON.stringify(body.value)).toString('base64')
        secrets.add(ciphertext)
        return Response.json({ ciphertext })
      }
      const stored = body.ciphertext ?? ''
      if (!secrets.has(stored)) return new Response('no', { status: 422 })
      return Response.json({ value: JSON.parse(Buffer.from(stored, 'base64').toString('utf8')) })
    },
  }),
} as unknown as DurableObjectNamespace

function env(): Env {
  return testBindings(db, { CREDENTIAL_VAULT: vault })
}

async function seed(userId: string, options: { name?: string; days: number; hours?: string[] }) {
  await saveSettings(db, userId, {
    timezone: 'Asia/Shanghai',
    notificationHours: options.hours ?? [],
    locale: 'zh-CN',
  })
  const settings = {
    timezone: 'Asia/Shanghai',
    notificationHours: options.hours ?? [],
    showLunar: false,
    paymentHistoryLimit: 100,
    locale: 'zh-CN' as const,
    baseCurrency: 'CNY' as const,
    budgetMonthly: null,
    inboundTokenHint: '',
  }
  const store = new SubscriptionsStore(db, userId)
  return await store.create({
    name: options.name ?? 'Netflix',
    amount: 60,
    expiryDate: new Date(NOW + options.days * DAY).toISOString(),
    periodValue: 1,
    periodUnit: 'month',
  }, storeContext(settings, NOW))
}

async function enableGotify(userId: string) {
  await saveChannel(env(), db, userId, 'gotify', {
    enabled: true,
    config: { serverUrl: 'https://gotify.example.com', appToken: 'token-value' },
  })
}

function schedules(userId: string) {
  return sqlite.prepare(`SELECT status, reason, matched_count, deduped_count, sent_count, renewed_count, in_window
    FROM sub_schedule_log WHERE user_id = ? ORDER BY started_at DESC`).all(userId) as Array<Record<string, number | string>>
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  deliveries = []
  secrets.clear()
  vi.stubGlobal('fetch', async (url: string) => {
    deliveries.push(String(url))
    return Response.json({ id: 'ok' })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the sweep', () => {
  it('does nothing when no subscription is due', async () => {
    await seed('u1', { name: 'Later', days: 20 })
    await enableGotify('u1')
    const result = await sweepSubscriptions(env(), NOW)
    expect(result.sent).toBe(0)
    expect(deliveries).toEqual([])
    expect(schedules('u1')[0]!.status).toBe('skipped')
  })

  it('sends one aggregated message when a rule comes due', async () => {
    await seed('u1', { name: 'Netflix', days: 7 })
    await seed('u1', { name: 'Spotify', days: 7 })
    await enableGotify('u1')
    const result = await sweepSubscriptions(env(), NOW)
    expect(result.matched).toBe(2)
    expect(result.sent).toBe(1)
    expect(deliveries).toHaveLength(1)

    const logs = sqlite.prepare(`SELECT title, body, status FROM sub_notify_log WHERE user_id = 'u1'`).all() as Array<Record<string, string>>
    expect(logs).toHaveLength(1)
    expect(logs[0]!.status).toBe('success')
    expect(logs[0]!.body).toContain('Netflix')
    expect(logs[0]!.body).toContain('Spotify')
  })

  it('does not send the same hour twice', async () => {
    await seed('u1', { days: 7 })
    await enableGotify('u1')
    await sweepSubscriptions(env(), NOW)
    const second = await sweepSubscriptions(env(), NOW + 15 * 60_000)
    expect(deliveries).toHaveLength(1)
    expect(second.deduped).toBeGreaterThan(0)
    expect(schedules('u1')[0]!.status).toBe('skipped')
  })

  it('stays quiet outside the notification window but still renews', async () => {
    const created = await seed('u1', { days: -3, hours: ['23'] })
    sqlite.prepare(`UPDATE sub_item SET expiry_date = ? WHERE id = ?`).run(NOW - 3 * DAY, created.item.id)
    await enableGotify('u1')

    const result = await sweepSubscriptions(env(), NOW)
    expect(result.renewed).toBe(1)
    expect(result.sent).toBe(0)
    expect(deliveries).toEqual([])
    const log = schedules('u1')[0]!
    expect(log.status).toBe('skipped')
    expect(log.in_window).toBe(0)

    const row = sqlite.prepare(`SELECT expiry_date, auto_renew FROM sub_item WHERE id = ?`).get(created.item.id) as { expiry_date: number }
    expect(row.expiry_date).toBeGreaterThan(NOW)
  })

  it('writes a log line saying no channel is enabled', async () => {
    await seed('u1', { days: 7 })
    const result = await sweepSubscriptions(env(), NOW)
    expect(result.sent).toBe(0)
    const log = schedules('u1')[0]!
    expect(log.status).toBe('ok')
    expect(String(log.reason)).toContain('channel')
  })

  it('keeps two accounts apart', async () => {
    await seed('u1', { name: 'Alice plan', days: 7 })
    await seed('u2', { name: 'Bob plan', days: 7 })
    await enableGotify('u1')
    await sweepSubscriptions(env(), NOW)
    expect(deliveries).toHaveLength(1)
    const alice = sqlite.prepare(`SELECT body FROM sub_notify_log WHERE user_id = 'u1'`).all() as Array<{ body: string }>
    const bob = sqlite.prepare(`SELECT body FROM sub_notify_log WHERE user_id = 'u2'`).all() as Array<{ body: string }>
    expect(alice).toHaveLength(1)
    expect(bob).toHaveLength(0)
  })

  it('waits out an expired rule interval before repeating', async () => {
    const created = await seed('u1', { days: -1 })
    await enableGotify('u1')
    sqlite.prepare(`UPDATE sub_item SET expiry_date = ?, auto_renew = 0 WHERE id = ?`).run(NOW - DAY, created.item.id)
    sqlite.prepare(`DELETE FROM sub_reminder_rule WHERE subscription_id = ?`).run(created.item.id)
    sqlite.prepare(`INSERT INTO sub_reminder_rule (user_id, id, subscription_id, kind, value, unit, repeat_interval, repeat_until, enabled, created_at)
      VALUES ('u1', 'rule-after', ?, 'after_expiry', 0, 'days', 12, 'renewed', 1, ?)`).run(created.item.id, NOW)

    await sweepSubscriptions(env(), NOW)
    expect(deliveries).toHaveLength(1)
    // The next hour is a new claim key, but the interval has not elapsed.
    await sweepSubscriptions(env(), NOW + 60 * 60_000)
    expect(deliveries).toHaveLength(1)
    // Twelve hours later it is due again.
    await sweepSubscriptions(env(), NOW + 13 * 60 * 60_000)
    expect(deliveries).toHaveLength(2)
  })

  it('records the sweep even when it throws', async () => {
    await seed('u1', { days: 7 })
    sqlite.prepare(`UPDATE sub_reminder_rule SET value = 7, enabled = 1`).run()
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom')
    })
    await enableGotify('u1')
    const result = await sweepSubscriptions(env(), NOW)
    expect(result.failed).toBe(1)
    const log = schedules('u1')[0]!
    expect(log.status).toBe('error')
  })
})

describe('the trash', () => {
  /**
   * The scheduler reads through `store.list`, which is live-only, so this passes by construction — and
   * that is exactly why it is worth pinning. A trashed subscription that kept renewing itself would
   * silently spend money on the reader's behalf while they were deciding whether to restore it, and one
   * that kept notifying would make the trash the noisiest place in the app.
   */
  it('leaves a trashed subscription alone', async () => {
    await saveSettings(db, 'u1', { timezone: 'Asia/Shanghai', notificationHours: [], locale: 'zh-CN' })
    const store = new SubscriptionsStore(db, 'u1')
    const context = { timezone: 'Asia/Shanghai', paymentLimit: 100, now: NOW }
    const created = await store.create({
      name: 'Gone',
      amount: 60,
      expiryDate: new Date(NOW - 5 * DAY).toISOString(),
      periodValue: 1,
      periodUnit: 'month',
      autoRenew: true,
    }, context)
    await store.trash(created.item.id, context)
    await enableGotify('u1')

    const result = await sweepSubscriptions(env(), NOW)
    expect(result.renewed).toBe(0)
    expect(result.matched).toBe(0)
    expect(result.sent).toBe(0)
    expect(deliveries).toHaveLength(0)

    // Still where it was left, not rolled forward an hour later by a sweep that could not see it.
    const detail = await store.get(created.item.id, context)
    expect(detail?.item.expiryDate).toBe(created.item.expiryDate)
    expect(detail?.item.deletedAt).toBeTruthy()
  })
})
