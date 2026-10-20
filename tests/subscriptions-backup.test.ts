// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  applyBackupSubscriptions,
  readBackupSubscriptions,
} from '../src/worker/subscriptions/backup'
import { saveSettings } from '../src/worker/subscriptions/settings'
import { SubscriptionsStore } from '../src/worker/subscriptions/store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * The subscription archive, and what it must and must not carry.
 *
 * A restore is the only code path in this app that deletes an account's rows in bulk, so "it round-trips"
 * is the minimum: the interesting claims are that a credential never enters the file, that a restore
 * replaces rather than accumulates, and that a file which cannot be honoured is refused before it
 * touches anything.
 */

const USER = 'user-1'
const OTHER = 'user-2'
const DAY = 86_400_000
const NOW = Date.parse('2026-05-24T04:00:00Z')

let sqlite: DatabaseSync
let env: Env
let store: SubscriptionsStore
const context = { timezone: 'Asia/Shanghai', paymentLimit: 100, now: NOW }

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.exec(`INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, template_library, quickadd, rss, created_at, last_seen_at)
    VALUES ('${USER}', 'u', 'h', 'u', 'U', '', 'owner', '{}', NULL, NULL, NULL, 1, 1)`)
  sqlite.exec(`INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, template_library, quickadd, rss, created_at, last_seen_at)
    VALUES ('${OTHER}', 'o', 'h', 'o', 'O', '', 'owner', '{}', NULL, NULL, NULL, 1, 1)`)
  env = testBindings(makeD1(sqlite))
  store = new SubscriptionsStore(env.DB, USER)
})

async function seed(): Promise<void> {
  await store.create({
    name: 'Netflix',
    customType: '流媒体',
    category: '娱乐/家庭',
    amount: 60,
    currency: 'CNY',
    expiryDate: new Date(NOW + 5 * DAY).toISOString(),
    periodValue: 1,
    periodUnit: 'month',
    notes: 'family plan',
    reminderRules: [
      { type: 'before_expiry', value: 7, unit: 'days' },
      { type: 'after_expiry', value: 0, unit: 'days', repeatInterval: 24, repeatUntil: 'acknowledged' },
    ],
  }, context)
  await store.create({
    name: 'Free tier',
    amount: null,
    currency: 'USD',
    expiryDate: new Date(NOW + 40 * DAY).toISOString(),
    periodValue: 1,
    periodUnit: 'year',
  }, context)
  await saveSettings(env.DB, USER, { timezone: 'Asia/Tokyo', notificationHours: ['08', '20'], baseCurrency: 'JPY', budgetMonthly: 5000 })
  await store.setLabelStyle('type', '流媒体', { icon: 'lucide:Tv', color: '#e11d48' })
}

/** A channel row with a sentinel in the encrypted column, needing no vault. */
function plantChannel(): void {
  sqlite.prepare(
    `INSERT INTO sub_channel (user_id, id, kind, enabled, config_ciphertext, config_hint, last_test_at, last_test_status, last_test_error, created_at, updated_at)
     VALUES (?, ?, 'telegram', 1, 'SECRET-BOT-TOKEN-CIPHERTEXT', '…4242', NULL, '', '', 1, 1)`,
  ).run(USER, `chan-${rows('sub_channel').length}`)
}

function rows(table: string, userId = USER): Array<Record<string, unknown>> {
  return sqlite.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(userId) as Array<Record<string, unknown>>
}

describe('export', () => {
  it('carries nothing for an account that never used the app', async () => {
    expect(await readBackupSubscriptions(env.DB, USER)).toBeNull()
  })

  it('exports plans, receipts, rules, both registries and the settings', async () => {
    await seed()
    const payload = JSON.parse((await readBackupSubscriptions(env.DB, USER))!)
    expect(payload.version).toBe(1)
    expect(payload.items).toHaveLength(2)
    expect(payload.payments.length).toBeGreaterThanOrEqual(1)
    expect(payload.rules).toHaveLength(6)
    expect(payload.types.map((row: { name: string }) => row.name)).toEqual(['流媒体'])
    // Compared as a set: the registry is read back in SQLite's byte collation, which is stable
    // but is not the locale-aware order the rail sorts into.
    expect(payload.categories.map((row: { name: string }) => row.name).sort()).toEqual(['娱乐', '家庭'].sort())
    expect(payload.settings.timezone).toBe('Asia/Tokyo')
    expect(payload.settings.base_currency).toBe('JPY')
    expect(payload.settings.budget_monthly).toBe(5000)
  })

  /**
   * The privacy guarantee, stated as an assertion.
   *
   * A backup leaves the server, lands in a bucket, and gets emailed. If a channel's encrypted
   * configuration rode along, the archive would be a credential bundle wearing a spreadsheet's clothes.
   */
  it('never carries a channel credential or the inbound token', async () => {
    await seed()
    plantChannel()
    const text = await readBackupSubscriptions(env.DB, USER)
    expect(text).not.toContain('SECRET-BOT-TOKEN')
    expect(text).not.toContain('config_ciphertext')
    expect(text).not.toContain('botToken')
    expect(text).not.toContain('SECRET-BOT-TOKEN')
    expect(text).not.toContain('inbound_token')
    // The channel table is not in the document at all, so a restore cannot half-reconnect one.
    expect(JSON.parse(text!).channels).toBeUndefined()
  })

  it('keeps a trashed subscription trashed across the round trip', async () => {
    await seed()
    const [netflix] = await store.list(context)
    await store.trash(netflix.id, context)
    const payload = JSON.parse((await readBackupSubscriptions(env.DB, USER))!)
    expect(payload.items.filter((row: { deleted_at: number | null }) => row.deleted_at !== null)).toHaveLength(1)
  })
})

describe('restore', () => {
  it('puts back exactly what it took', async () => {
    await seed()
    const before = {
      items: rows('sub_item'),
      payments: rows('sub_payment'),
      rules: rows('sub_reminder_rule'),
      types: rows('sub_type'),
    }
    const text = await readBackupSubscriptions(env.DB, USER)!

    // Wipe through the public path so the restore is not measured against a database it half-wrote.
    for (const id of before.items.map((row) => String(row.id))) await store.purge(id)
    expect(rows('sub_item')).toHaveLength(0)

    const summary = await applyBackupSubscriptions(env.DB, USER, text)
    expect(summary.items).toBe(2)
    expect(rows('sub_item')).toHaveLength(2)
    expect(rows('sub_payment')).toHaveLength(before.payments.length)
    expect(rows('sub_reminder_rule')).toHaveLength(6)
    expect(rows('sub_type')).toEqual(before.types)
  })

  it('replaces the current library rather than adding to it', async () => {
    await seed()
    const text = await readBackupSubscriptions(env.DB, USER)!
    await store.create({ name: 'Added later', expiryDate: new Date(NOW + DAY).toISOString() }, context)
    expect(rows('sub_item')).toHaveLength(3)
    await applyBackupSubscriptions(env.DB, USER, text)
    expect(rows('sub_item')).toHaveLength(2)
    expect(rows('sub_item').map((row) => row.name).sort()).toEqual(['Free tier', 'Netflix'])
  })

  it('drops a credential the archive should not have had, and clears the channel table', async () => {
    await seed()
    const text = await readBackupSubscriptions(env.DB, USER)!
    plantChannel()
    expect(rows('sub_channel')).toHaveLength(1)
    await applyBackupSubscriptions(env.DB, USER, text)
    // The reader reconnects it. What must not happen is a restore that quietly re-arms a channel from
    // a file that should never have held the key in the first place.
    expect(rows('sub_channel')).toHaveLength(0)
  })

  it('refuses a document it cannot honour, without touching the database', async () => {
    await seed()
    const before = rows('sub_item')
    await expect(applyBackupSubscriptions(env.DB, USER, 'not json')).rejects.toThrow(/readable/)
    await expect(applyBackupSubscriptions(env.DB, USER, JSON.stringify({ version: 99 })))
      .rejects.toThrow(/version/)
    await expect(applyBackupSubscriptions(env.DB, USER, JSON.stringify({ version: 1, items: 'nope' })))
      .rejects.toThrow(/not a list/)
    expect(rows('sub_item')).toEqual(before)
  })

  it('refuses an archive over the size a personal library can be', async () => {
    const items = Array.from({ length: 5_001 }, (_, index) => ({ id: `s${index}`, name: `n${index}`, expiry_date: NOW }))
    await expect(applyBackupSubscriptions(env.DB, USER, JSON.stringify({ version: 1, items })))
      .rejects.toThrow(/over the/)
  })

  it('keeps only the receipts and rules whose subscription came with them', async () => {
    await seed()
    const payload = JSON.parse((await readBackupSubscriptions(env.DB, USER))!)
    payload.payments.push({ id: 'orphan', subscription_id: 'gone', paid_at: NOW, amount: 5, currency: 'CNY' })
    payload.rules.push({ id: 'orphan-rule', subscription_id: 'gone', kind: 'on_expiry', value: 0, unit: 'days' })
    const summary = await applyBackupSubscriptions(env.DB, USER, JSON.stringify(payload))
    expect(summary.payments).toBe(payload.payments.length - 1)
    expect(summary.rules).toBe(6)
    expect(rows('sub_payment').some((row) => row.subscription_id === 'gone')).toBe(false)
  })

  it('restores one account without reaching another', async () => {
    await seed()
    const text = await readBackupSubscriptions(env.DB, USER)!
    const other = new SubscriptionsStore(env.DB, OTHER)
    await other.create({ name: 'Bob-only', expiryDate: new Date(NOW + DAY).toISOString() }, context)
    await applyBackupSubscriptions(env.DB, USER, text)
    expect(rows('sub_item', OTHER).map((row) => row.name)).toEqual(['Bob-only'])
  })

  it('normalises a hostile row instead of storing what it was handed', async () => {
    const text = JSON.stringify({
      version: 1,
      items: [{
        id: 'x'.repeat(200),
        name: `${'long'.repeat(200)}!`,
        currency: 'LIRA',
        period_unit: 'fortnight',
        subscription_mode: 'whatever',
        expiry_date: NOW,
        notes: 'n'.repeat(9000),
      }],
    })
    await applyBackupSubscriptions(env.DB, USER, text)
    const [row] = rows('sub_item')
    expect(String(row.id).length).toBeLessThanOrEqual(64)
    expect(String(row.name).length).toBeLessThanOrEqual(120)
    expect(String(row.notes).length).toBeLessThanOrEqual(2000)
    expect(row.currency).toBe('CNY')
    expect(row.period_unit).toBe('month')
    expect(row.subscription_mode).toBe('cycle')
  })
})
