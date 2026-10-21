/**
 * The dashboard, as one answer.
 *
 * Every number here is derived rather than stored: a total that was written down would be wrong the
 * moment a receipt was edited, and a subscription app is exactly the place where a reader goes back and
 * fixes a typo in last month's amount.
 *
 * The exchange rates are the one thing fetched from outside. They are cached in `app_meta` for a day
 * because they move slowly, and a failed fetch falls back to a table rather than failing the dashboard
 * — a reader opening the app on a plane should still see what they spent.
 */
import { getMeta, setMeta } from '../db/metadata'
import type { Env } from '../env'
import {
  annualisedCost,
  applyRateOverrides,
  calculateMonthlyExpense,
  calculateYearlyExpense,
  expenseByMonth,
  findPriceChanges,
  getExpenseByCategory,
  getExpenseByType,
  getRecentPayments,
  getUpcomingRenewals,
  hasRate,
  mergeCnyRates,
  rateTableFor,
  trialsEnding,
  unpricedCurrencies,
  type PaymentSample,
  type RateTable,
} from '@shared/subscriptions/currency'
import { SOON_DAYS, type SubscriptionOverview, type SubscriptionSettings } from '@shared/subscriptions/model'
import { recentScheduleLogs } from './logs'
import { SubscriptionsStore } from './store'

const RATES_KEY = 'subscriptions:rates-v2'
const RATES_TTL_MS = 24 * 60 * 60 * 1000
const RATES_ENDPOINT = 'https://api.frankfurter.dev/v1/latest?base=CNY'
const RATES_TIMEOUT_MS = 10_000

/**
 * The day's rates against CNY, and how much they can be trusted.
 *
 * The host is fixed, so there is nothing here for a caller to steer; the timeout is what keeps a slow
 * currency service from holding up a dashboard that only wanted a number.
 *
 * Cached in this app's own convention (`1 unit = N CNY`) rather than the feed's, so a cache hit is a
 * read rather than a second translation. The key carries a version because the entry written before
 * this inversion was fixed is the wrong way round, and a twenty-four-hour TTL is the only migration a
 * cache gets.
 *
 * Which of the two ways the numbers came in — a day somebody published, or our own table after nobody
 * could be reached — travels with them, because a dashboard that adds foreign money up has to be able to
 * say how good the rate behind the sum is.
 */
export interface RatesResult {
  table: RateTable
  /** `feed`: published by the rate service. `approximate`: ours, because the fetch failed. */
  source: 'feed' | 'approximate'
  /** When those numbers were taken, in epoch milliseconds; null for the built-in table. */
  at: number | null
}

export async function loadRates(env: Env, now = Date.now()): Promise<RatesResult> {
  try {
    const cached = await getMeta(env.DB, RATES_KEY)
    if (cached) {
      const parsed = JSON.parse(cached) as { at?: number; rates?: unknown }
      if (typeof parsed.at === 'number' && now - parsed.at < RATES_TTL_MS && parsed.rates) {
        return { table: parsed.rates as RateTable, source: 'feed', at: parsed.at }
      }
    }
  } catch {
    // A cache that cannot be read is a cache miss; the fetch below is the answer either way.
  }

  try {
    const response = await fetch(RATES_ENDPOINT, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(RATES_TIMEOUT_MS),
    })
    if (!response.ok) return { table: mergeCnyRates(null), source: 'approximate', at: null }
    const body = await response.json() as { rates?: unknown }
    const rates = mergeCnyRates(body.rates)
    await setMeta(env.DB, RATES_KEY, JSON.stringify({ at: now, rates }))
    return { table: rates, source: 'feed', at: now }
  } catch {
    return { table: mergeCnyRates(null), source: 'approximate', at: null }
  }
}

/**
 * Forget the cached day, so the next read goes to the feed.
 *
 * Writing an empty value rather than deleting the row is what `getMeta` treats as no entry: the refresh
 * button is a reader saying "the day I have is not the day I want", and it must not need a TTL to pass.
 */
export async function refreshRates(env: Env, now = Date.now()): Promise<RatesResult> {
  await setMeta(env.DB, RATES_KEY, '')
  return loadRates(env, now)
}

export async function buildOverview(
  env: Env,
  db: D1Database,
  userId: string,
  settings: SubscriptionSettings,
  now = Date.now(),
): Promise<SubscriptionOverview> {
  const store = new SubscriptionsStore(db, userId)
  const [items, payments, ratesToday, history] = await Promise.all([
    store.list({ timezone: settings.timezone, paymentLimit: settings.paymentHistoryLimit, now }),
    store.allPayments(),
    loadRates(env, now),
    recentScheduleLogs(db, userId, 10),
  ])
  // The feed is one answer for everybody; the pins are this account's, and the base is applied last.
  const cnyRates = applyRateOverrides(ratesToday.table, settings.rateOverrides)
  const rates = rateTableFor(cnyRates, settings.baseCurrency)
  // Every currency the account writes money in, from the two places that can name one. A plan's own
  // currency and a receipt's can differ, and both end up in a total.
  const used = new Set<string>([
    ...items.map((item) => item.currency),
    ...payments.map((payment) => payment.currency),
    settings.baseCurrency,
  ])

  const samples: PaymentSample[] = payments.map((payment) => ({
    subscriptionId: payment.subscriptionId,
    paidAt: payment.paidAt,
    amount: payment.amount,
    currency: payment.currency as PaymentSample['currency'],
    note: payment.note,
  }))
  const at = new Date(now)
  const active = items.filter((item) => item.isActive)
  // Read once and shared with the budget: the headline and the ceiling have to be the same number, and
  // computing the month twice would let them disagree if the clock ticked over between the two.
  const monthly = calculateMonthlyExpense(samples, settings.timezone, rates, at)

  return {
    monthly,
    yearly: calculateYearlyExpense(samples, settings.timezone, rates, at),
    active: {
      active: active.length,
      total: items.length,
      expiringSoon: active.filter((item) => item.daysRemaining >= 0 && item.daysRemaining <= SOON_DAYS).length,
    },
    recentPayments: getRecentPayments(items, samples, settings.timezone, at),
    upcoming: getUpcomingRenewals(items, settings.timezone, at),
    byType: getExpenseByType(items, samples, settings.timezone, rates, at),
    byCategory: getExpenseByCategory(items, samples, settings.timezone, rates, at),
    months: expenseByMonth(samples, settings.timezone, rates, at),
    timezone: settings.timezone,
    scheduler: history[0] ?? null,
    history,
    budget: {
      limit: settings.budgetMonthly,
      amount: monthly.amount,
      // Only an over-budget month is worth a colour, and a limit of 0 is a real one, not an absence.
      over: settings.budgetMonthly !== null && settings.budgetMonthly > 0 && monthly.amount > settings.budgetMonthly,
    },
    committedYearly: annualisedCost(items, rates),
    trials: trialsEnding(items, settings.timezone, at).slice(0, 8),
    priceChanges: findPriceChanges(items, samples).slice(0, 8),
    rates: {
      source: ratesToday.source,
      at: ratesToday.at,
      base: settings.baseCurrency,
      // A base with no rate means `rateTableFor` could not re-base anything, so the totals below are
      // really CNY while the setting names another currency. Said here rather than hidden there.
      basePriced: hasRate(settings.baseCurrency, cnyRates),
      unpriced: unpricedCurrencies(used, rates),
      pinned: Object.keys(settings.rateOverrides),
      table: rates,
    },
  }
}
