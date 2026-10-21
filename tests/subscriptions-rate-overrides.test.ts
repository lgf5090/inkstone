// @vitest-environment node
/**
 * The rates an account states for itself.
 *
 * The feed answers once a day for everybody, which is the right default and the wrong answer for a reader
 * whose currency moves faster than that or whose bank quotes elsewhere. What this file pins is the whole
 * promise: a pin is stored, a pin survives a change of total currency, a pin reaches the money the
 * dashboard prints, and a request the app cannot honour is refused by name rather than quietly ignored.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SubscriptionSettings } from '../src/shared/subscriptions/model'
import { applyRateOverrides, rateTableFor } from '../src/shared/subscriptions/currency'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { loadSettings, saveSettings } from '../src/worker/subscriptions/settings'
import { buildOverview } from '../src/worker/subscriptions/overview'
import { SubscriptionsStore } from '../src/worker/subscriptions/store'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import type { Env } from '../src/worker/env'

const USER = 'user-1'
const NOW = Date.parse('2026-05-24T04:00:00Z')
/** What the feed answers for the day, as Frankfurter does: foreign units per one yuan. */
const FEED = { USD: 1 / 6.993 }

let sqlite: DatabaseSync
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite))
  vi.stubGlobal('fetch', async () => Response.json({ rates: FEED }))
})

function settings(overrides: Partial<SubscriptionSettings> = {}): SubscriptionSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

describe('the pins an account keeps', () => {
  it('stores what was pinned and reads it back', async () => {
    await saveSettings(env.DB, USER, { rateOverrides: { USD: 7.2, JPY: 0.0451 } })
    expect(await loadSettings(env.DB, USER)).toMatchObject({ rateOverrides: { USD: 7.2, JPY: 0.0451 } })
  })

  it('keeps every pin a later patch does not mention, and clears them when the map is sent empty', async () => {
    await saveSettings(env.DB, USER, { rateOverrides: { USD: 7.2, JPY: 0.045 } })
    await saveSettings(env.DB, USER, { baseCurrency: 'USD' })
    expect((await loadSettings(env.DB, USER)).rateOverrides).toEqual({ USD: 7.2, JPY: 0.045 })

    await saveSettings(env.DB, USER, { rateOverrides: {} })
    expect((await loadSettings(env.DB, USER)).rateOverrides).toEqual({})
  })

  it('rounds a rate to the precision a small currency needs, and no further', async () => {
    await saveSettings(env.DB, USER, { rateOverrides: { KRW: 0.00481267 } })
    expect((await loadSettings(env.DB, USER)).rateOverrides).toEqual({ KRW: 0.004813 })
  })

  it('refuses a currency it does not convert, including the anchor it measures against', async () => {
    await expect(saveSettings(env.DB, USER, { rateOverrides: { GBP: 9.4, XYZ: 1 } })).rejects.toThrow(/invalid_rate_currency:XYZ/)
    await expect(saveSettings(env.DB, USER, { rateOverrides: { CNY: 1 } })).rejects.toThrow(/invalid_rate_currency:CNY/)
    // The refusal is not a half write: what was already pinned is still there.
    expect((await loadSettings(env.DB, USER)).rateOverrides).toEqual({})
  })

  it('refuses a number it cannot multiply by', async () => {
    await expect(saveSettings(env.DB, USER, { rateOverrides: { USD: 0 } })).rejects.toThrow(/invalid_rate_value:USD/)
    await expect(saveSettings(env.DB, USER, { rateOverrides: { USD: 'seven' } })).rejects.toThrow(/invalid_rate_value:USD/)
  })

  /**
   * Text that is not a rate map reads as "nothing pinned".
   *
   * The column is written by one statement today, but it outlives this file: a hand-restored row, or an
   * archive that carried something else in its place, must not become a dashboard that throws. Dropping the
   * pins is also the right answer rather than guessing at a rate nobody chose.
   */
  it('reads settings text it cannot parse as no pins', async () => {
    await saveSettings(env.DB, USER, { rateOverrides: { USD: 7.2 } })
    sqlite.exec(`UPDATE sub_settings SET rate_overrides = 'not json'`)
    expect((await loadSettings(env.DB, USER)).rateOverrides).toEqual({})
  })
})

describe('the table the money is converted with', () => {
  it('leaves the feed alone when nothing is pinned', () => {
    const cny = { CNY: 1, USD: 6.993, JPY: 0.044 }
    expect(applyRateOverrides(cny, {})).toBe(cny)
  })

  it('replaces one currency without disturbing the others', () => {
    const table = applyRateOverrides({ CNY: 1, USD: 6.993, JPY: 0.044 }, { USD: 7.4 })
    expect(table).toEqual({ CNY: 1, USD: 7.4, JPY: 0.044 })
  })

  /**
   * The order matters and is the whole reason the pin is stored per yuan rather than per total currency.
   *
   * A reader who pins the dollar and then moves the dashboard to dollars still means 7.2 yuan: re-basing
   * afterwards makes their own currency exactly 1, which is what a total in it has to be worth.
   */
  it('survives a change of total currency as the same yuan price', () => {
    const pinned = applyRateOverrides({ CNY: 1, USD: 6.993, JPY: 0.044 }, { USD: 7.2 })
    expect(rateTableFor(pinned, 'USD')).toMatchObject({ USD: 1, CNY: 1 / 7.2 })
    expect(rateTableFor(pinned, 'JPY')).toMatchObject({ USD: 7.2 / 0.044 })
  })
})

describe('the dashboard the pin reaches', () => {
  async function overviewWith(overrides: Partial<SubscriptionSettings>) {
    const store = new SubscriptionsStore(env.DB, USER)
    await store.create({
      name: 'Figma',
      amount: 15,
      currency: 'USD',
      expiryDate: new Date(NOW + 30 * 86_400_000).toISOString(),
      periodValue: 1,
      periodUnit: 'month',
    }, { timezone: 'Asia/Shanghai', paymentLimit: 100, now: NOW })
    const saved = await saveSettings(env.DB, USER, overrides)
    return buildOverview(env, env.DB, USER, settings({ ...DEFAULT_SETTINGS, ...saved }), NOW)
  }

  it('converts at the feed when nothing is pinned', async () => {
    const overview = await overviewWith({})
    // 15 a month, twelve times, at 6.993 yuan to the dollar.
    expect(overview.committedYearly).toBeCloseTo(1_258.74, 2)
  })

  it('converts at the number the reader wrote when one is pinned', async () => {
    const overview = await overviewWith({ rateOverrides: { USD: 7.2 } })
    expect(overview.committedYearly).toBe(1_296)
  })
})
