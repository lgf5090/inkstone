/**
 * Money: what a month cost, what a year cost, and where it went.
 *
 * Every figure the dashboard prints is derived from payment records rather than from subscription
 * prices, because a subscription's price is what it costs *now* while its history is what was actually
 * charged — a plan that went up in March should not rewrite January.
 *
 * Everything is converted to CNY for the totals. That is the reference project's choice and it is the
 * right one for a single-number headline: a total that mixed currencies would be a number with no unit.
 * The per-currency amount stays beside each row for the reader who wants it.
 */
import { MS_PER_DAY, formatLocalDate, getDaysBetween, getNowInTimezone, getTimezoneDateParts } from './time'
import { roundMoney, type CurrencyCode, type ExpenseShare, type MonthExpense, type SubscriptionItem, type UpcomingRenewal } from './model'

/** `1 unit of the currency = N CNY`, with CNY itself as the base. Used when the rate service is down. */
export const FALLBACK_RATES: Readonly<Record<string, number>> = {
  CNY: 1,
  USD: 6.98,
  HKD: 0.90,
  TWD: 0.22,
  JPY: 0.044,
  EUR: 8.16,
  GBP: 9.40,
  KRW: 0.0048,
  TRY: 0.16,
}

export type RateTable = Readonly<Record<string, number>>

/** One payment as the aggregates need it: an instant, an amount, and which subscription it paid for. */
export interface PaymentSample {
  subscriptionId: string
  paidAt: number
  amount: number
  currency: CurrencyCode
  note?: string
}

/** The category field may name several labels; the reference project split on any of these. */
export const CATEGORY_SEPARATOR = /[/\uFF0C,\s]+/

export function convertToCNY(amount: number, currency: string | undefined, rates: RateTable): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const code = currency || 'CNY'
  if (code === 'CNY') return amount
  const rate = rates[code]
  if (!rate || rate <= 0) return amount
  return amount / rate
}

/** Merge a live rate table over the built-in one, keeping CNY pinned at 1. */
export function mergeRates(live: unknown): RateTable {
  const merged: Record<string, number> = { ...FALLBACK_RATES }
  if (live && typeof live === 'object') {
    for (const [code, value] of Object.entries(live as Record<string, unknown>)) {
      const numeric = Number(value)
      if (Number.isFinite(numeric) && numeric > 0) merged[code.toUpperCase()] = numeric
    }
  }
  merged.CNY = 1
  return merged
}

export interface MonthlyExpense {
  amount: number
  trend: number
  direction: 'up' | 'down' | 'flat'
}

/**
 * This calendar month's spending, and how it compares with last month's.
 *
 * The comparison is against the same-length period one month back, not against the same day count:
 * "this month" on the 3rd is three days of payments, and dividing by a full month would make every
 * dashboard read as a collapse on the 1st.
 */
export function calculateMonthlyExpense(
  payments: readonly PaymentSample[],
  timezone: string,
  rates: RateTable,
  now: Date = new Date(),
): MonthlyExpense {
  const current = getTimezoneDateParts(now, timezone)
  const previousMonth = current.month === 1 ? 12 : current.month - 1
  const previousYear = current.month === 1 ? current.year - 1 : current.year

  let amount = 0
  let lastAmount = 0
  for (const payment of payments) {
    if (!(payment.amount > 0)) continue
    const parts = getTimezoneDateParts(payment.paidAt, timezone)
    if (parts.year === current.year && parts.month === current.month) {
      amount += convertToCNY(payment.amount, payment.currency, rates)
    } else if (parts.year === previousYear && parts.month === previousMonth) {
      lastAmount += convertToCNY(payment.amount, payment.currency, rates)
    }
  }

  let trend = 0
  let direction: MonthlyExpense['direction'] = 'flat'
  if (lastAmount > 0) {
    trend = Math.round(((amount - lastAmount) / lastAmount) * 100)
    if (trend > 0) direction = 'up'
    else if (trend < 0) direction = 'down'
  } else if (amount > 0) {
    trend = 100
    direction = 'up'
  }
  return { amount: roundMoney(amount), trend: Math.abs(trend), direction }
}

export interface YearlyExpense {
  amount: number
  monthlyAverage: number
}

/** This calendar year's spending, and the average per month elapsed so far. */
export function calculateYearlyExpense(
  payments: readonly PaymentSample[],
  timezone: string,
  rates: RateTable,
  now: Date = new Date(),
): YearlyExpense {
  const current = getTimezoneDateParts(now, timezone)
  let amount = 0
  for (const payment of payments) {
    if (!(payment.amount > 0)) continue
    const parts = getTimezoneDateParts(payment.paidAt, timezone)
    if (parts.year === current.year) amount += convertToCNY(payment.amount, payment.currency, rates)
  }
  return { amount: roundMoney(amount), monthlyAverage: roundMoney(amount / Math.max(1, current.month)) }
}

/** Payments made in the last `days` days, newest first, with the subscription's name attached. */
export function getRecentPayments(
  items: readonly SubscriptionItem[],
  payments: readonly PaymentSample[],
  timezone: string,
  now: Date = new Date(),
  days = 7,
) {
  const since = now.getTime() - days * MS_PER_DAY
  const byId = new Map(items.map((item) => [item.id, item]))
  return payments
    .filter((payment) => payment.amount > 0 && payment.paidAt >= since && payment.paidAt <= now.getTime())
    .sort((left, right) => right.paidAt - left.paidAt)
    .map((payment) => {
      const item = byId.get(payment.subscriptionId)
      return {
        name: item?.name ?? '',
        amount: roundMoney(payment.amount),
        currency: payment.currency,
        customType: item?.customType ?? '',
        paymentDate: formatLocalDate(payment.paidAt, timezone, 'date'),
        note: payment.note ?? '',
      }
    })
}

/** Active subscriptions expiring within `days` days, soonest first. */
export function getUpcomingRenewals(
  items: readonly SubscriptionItem[],
  timezone: string,
  now: Date = new Date(),
  days = 7,
): UpcomingRenewal[] {
  const nowMs = now.getTime()
  const limit = nowMs + days * MS_PER_DAY
  return items
    .filter((item) => item.isActive)
    .map((item) => ({ item, expiry: Date.parse(item.expiryDate) }))
    .filter((entry) => Number.isFinite(entry.expiry) && entry.expiry >= nowMs && entry.expiry <= limit)
    .map((entry) => ({
      id: entry.item.id,
      name: entry.item.name,
      amount: roundMoney(entry.item.amount ?? 0),
      currency: entry.item.currency,
      customType: entry.item.customType,
      renewalDate: entry.item.expiryDate,
      // Counted between local midnights, the same way the list counts the days it prints beside a
      // subscription — a difference of one here would have the overview and the row disagree.
      daysUntilRenewal: getDaysBetween(now, entry.expiry, timezone),
    }))
    .sort((left, right) => left.daysUntilRenewal - right.daysUntilRenewal)
}

/** This year's spending grouped by the free-text type, largest first. */
export function getExpenseByType(
  items: readonly SubscriptionItem[],
  payments: readonly PaymentSample[],
  timezone: string,
  rates: RateTable,
  now: Date = new Date(),
): ExpenseShare[] {
  const current = getTimezoneDateParts(now, timezone)
  const byId = new Map(items.map((item) => [item.id, item]))
  const totals = new Map<string, number>()
  let total = 0
  for (const payment of payments) {
    if (!(payment.amount > 0)) continue
    const parts = getTimezoneDateParts(payment.paidAt, timezone)
    if (parts.year !== current.year) continue
    const label = byId.get(payment.subscriptionId)?.customType?.trim() || ''
    const key = label || 'other'
    const amount = convertToCNY(payment.amount, payment.currency, rates)
    totals.set(key, (totals.get(key) ?? 0) + amount)
    total += amount
  }
  return [...totals.entries()]
    .map(([label, amount]) => ({
      label,
      amount: roundMoney(amount),
      percentage: total > 0 ? Math.round((amount / total) * 100) : 0,
    }))
    .sort((left, right) => right.amount - left.amount)
}

/**
 * This year's spending grouped by category, with a subscription that names two categories charged
 * half to each.
 *
 * Splitting rather than double-counting keeps the shares adding up to the total; the alternative would
 * report a category total larger than what the reader actually spent.
 */
export function getExpenseByCategory(
  items: readonly SubscriptionItem[],
  payments: readonly PaymentSample[],
  timezone: string,
  rates: RateTable,
  now: Date = new Date(),
): ExpenseShare[] {
  const current = getTimezoneDateParts(now, timezone)
  const byId = new Map(items.map((item) => [item.id, item]))
  const totals = new Map<string, number>()
  let total = 0
  for (const payment of payments) {
    if (!(payment.amount > 0)) continue
    const parts = getTimezoneDateParts(payment.paidAt, timezone)
    if (parts.year !== current.year) continue
    const item = byId.get(payment.subscriptionId)
    const labels = (item?.category ?? '')
      .split(CATEGORY_SEPARATOR)
      .map((label) => label.trim())
      .filter(Boolean)
    const share = labels.length ? labels : ['']
    const amount = convertToCNY(payment.amount, payment.currency, rates)
    for (const label of share) {
      const key = label || 'uncategorized'
      totals.set(key, (totals.get(key) ?? 0) + amount / share.length)
    }
    total += amount
  }
  return [...totals.entries()]
    .map(([label, amount]) => ({
      label,
      amount: roundMoney(amount),
      percentage: total > 0 ? Math.round((amount / total) * 100) : 0,
    }))
    .sort((left, right) => right.amount - left.amount)
}

/**
 * The last `months` calendar months of spending, oldest first, for the dashboard's small chart.
 *
 * A month with no payment is a zero rather than a gap: a bar chart that silently drops empty months
 * compresses a quiet period into a single step and reads as steady spending.
 */
export function expenseByMonth(
  payments: readonly PaymentSample[],
  timezone: string,
  rates: RateTable,
  now: Date = new Date(),
  months = 6,
): MonthExpense[] {
  const current = getTimezoneDateParts(now, timezone)
  const buckets: MonthExpense[] = []
  const index = new Map<string, number>()
  for (let offset = months - 1; offset >= 0; offset--) {
    const date = new Date(Date.UTC(current.year, current.month - 1 - offset, 1))
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    index.set(key, buckets.length)
    buckets.push({ month: key, amount: 0 })
  }
  for (const payment of payments) {
    if (!(payment.amount > 0)) continue
    const parts = getTimezoneDateParts(payment.paidAt, timezone)
    const key = `${parts.year}-${String(parts.month).padStart(2, '0')}`
    const slot = index.get(key)
    if (slot === undefined) continue
    buckets[slot]!.amount += convertToCNY(payment.amount, payment.currency, rates)
  }
  return buckets.map((bucket) => ({ month: bucket.month, amount: roundMoney(bucket.amount) }))
}

/** Today, in the account's zone, as the dashboard's own clock reads it. */
export function todayLabel(timezone: string, now: Date = new Date()): string {
  return getNowInTimezone(timezone, now).isoLocal.slice(0, 10)
}
