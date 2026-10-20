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
  calculateMonthlyExpense,
  calculateYearlyExpense,
  expenseByMonth,
  findPriceChanges,
  getExpenseByCategory,
  getExpenseByType,
  getRecentPayments,
  getUpcomingRenewals,
  mergeCnyRates,
  rateTableFor,
  trialsEnding,
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
 * The day's rates against CNY, or the built-in table when they cannot be had.
 *
 * The host is fixed, so there is nothing here for a caller to steer; the timeout is what keeps a slow
 * currency service from holding up a dashboard that only wanted a number.
 *
 * Cached in this app's own convention (`1 unit = N CNY`) rather than the feed's, so a cache hit is a
 * read rather than a second translation. The key carries a version because the entry written before
 * this inversion was fixed is the wrong way round, and a twenty-four-hour TTL is the only migration a
 * cache gets.
 */
export async function loadRates(env: Env, now = Date.now()): Promise<RateTable> {
  try {
    const cached = await getMeta(env.DB, RATES_KEY)
    if (cached) {
      const parsed = JSON.parse(cached) as { at?: number; rates?: unknown }
      if (typeof parsed.at === 'number' && now - parsed.at < RATES_TTL_MS && parsed.rates) {
        return parsed.rates as RateTable
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
    if (!response.ok) return mergeCnyRates(null)
    const body = await response.json() as { rates?: unknown }
    const rates = mergeCnyRates(body.rates)
    await setMeta(env.DB, RATES_KEY, JSON.stringify({ at: now, rates }))
    return rates
  } catch {
    return mergeCnyRates(null)
  }
}

export async function buildOverview(
  env: Env,
  db: D1Database,
  userId: string,
  settings: SubscriptionSettings,
  now = Date.now(),
): Promise<SubscriptionOverview> {
  const store = new SubscriptionsStore(db, userId)
  const [items, payments, cnyRates, history] = await Promise.all([
    store.list({ timezone: settings.timezone, paymentLimit: settings.paymentHistoryLimit, now }),
    store.allPayments(),
    loadRates(env, now),
    recentScheduleLogs(db, userId, 10),
  ])
  // The feed is one answer for everybody; the base is this account's, so it is applied afterwards.
  const rates = rateTableFor(cnyRates, settings.baseCurrency)

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
  }
}
