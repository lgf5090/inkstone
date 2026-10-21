/**
 * Money: what a month cost, what a year cost, and where it went.
 *
 * Every figure the dashboard prints is derived from payment records rather than from subscription
 * prices, because a subscription's price is what it costs *now* while its history is what was actually
 * charged — a plan that went up in March should not rewrite January.
 *
 * Everything is converted to one base currency for the totals — the account picks it, and CNY is where
 * the rate feed is anchored. A total that mixed currencies would be a number with no unit. The
 * per-currency amount stays beside each row for the reader who wants it.
 */
import { MS_PER_DAY, formatLocalDate, getDaysBetween, getNowInTimezone, getTimezoneDateParts } from './time'
import { labelNamesOf, roundMoney, type CurrencyCode, type ExpenseShare, type MonthExpense, type PriceChange, type RateOverrides, type SubscriptionItem, type TrialEnding, type UpcomingRenewal, type YearSpend } from './model'

/**
 * `1 unit of the currency = N CNY`, with CNY itself as the base. Used when the rate service is down.
 *
 * The direction matters and is the whole reason this table is written out: a reader's 100 USD is ¥698,
 * not ¥14.30.
 */
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

/**
 * `1 unit of the currency = N base units`, so the base itself is always exactly 1.
 *
 * Everything that adds money up works in one currency, and this is the only shape it may read.
 */
export type RateTable = Readonly<Record<string, number>>

/** One payment as the aggregates need it: an instant, an amount, and which subscription it paid for. */
export interface PaymentSample {
  subscriptionId: string
  paidAt: number
  amount: number
  currency: CurrencyCode
  note?: string
}

/** Whether this table can price one unit of `code` at all. */
export function hasRate(code: string | undefined, rates: RateTable): boolean {
  const rate = rates[code || 'CNY']
  return Number.isFinite(rate) && (rate as number) > 0
}

export function convertToBase(amount: number, currency: string | undefined, rates: RateTable): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const rate = rates[currency || 'CNY']
  // Nothing to multiply by is not a licence to add the money in unchanged: a hundred Singapore dollars
  // counted as a hundred yuan is a made-up number, while leaving it out only makes the total small.
  // The omission has to be seen, though, so every surface that prints one of these totals names the
  // currencies `unpricedCurrencies` finds beside it.
  if (!rate || rate <= 0) return 0
  return amount * rate
}

/**
 * Which currencies this table cannot price, out of the ones an account actually uses.
 *
 * Computed from the same table the totals were added with, so a total and its disclaimer cannot disagree
 * about what was left out.
 */
export function unpricedCurrencies(currencies: Iterable<string>, rates: RateTable): string[] {
  const missing = new Set<string>()
  for (const code of currencies) {
    const normalized = String(code || 'CNY').toUpperCase()
    if (!hasRate(normalized, rates)) missing.add(normalized)
  }
  return [...missing].sort()
}

/**
 * The live feed merged over the built-in table, still expressed per CNY.
 *
 * Frankfurter is asked with `base=CNY`, so each value it returns is *foreign units per one yuan* — the
 * reciprocal of how this app stores rates. Inverting here is what lets the fallback table and the live
 * one mean the same thing, which they previously did not: the fallback was read as though it were
 * already inverted, so every currency it covered — and every hour the service was down — was converted
 * the wrong way round, off by the square of the rate.
 */
export function mergeCnyRates(live: unknown): RateTable {
  const merged: Record<string, number> = { ...FALLBACK_RATES }
  if (live && typeof live === 'object') {
    for (const [code, value] of Object.entries(live as Record<string, unknown>)) {
      const numeric = Number(value)
      if (Number.isFinite(numeric) && numeric > 0) merged[code.toUpperCase()] = 1 / numeric
    }
  }
  merged.CNY = 1
  return merged
}

/**
 * Re-express a per-CNY table against whichever currency the account counts in.
 *
 * Done per request rather than in the cache: the base is a setting, and a table baked to one base would
 * go stale the moment a reader changes it.
 */
export function rateTableFor(cnyRates: RateTable, base: string): RateTable {
  const perBase = cnyRates[base]
  if (!perBase || perBase <= 0) return cnyRates
  const out: Record<string, number> = {}
  for (const [code, perCny] of Object.entries(cnyRates)) out[code] = perCny / perBase
  return out
}

/**
 * The rates the reader pinned, laid over the day's table before the base is applied.
 *
 * A pin beats the feed for that one currency and changes nothing else: a reader billing in a currency
 * that moves faster than the daily cache does not have to accept yesterday's number, and one whose bank
 * quotes differently from the index does not either. The value means what the table means — `1 unit = N
 * CNY` — so the same pin survives a change of total currency.
 */
export function applyRateOverrides(cnyRates: RateTable, overrides: RateOverrides): RateTable {
  const pinned = Object.entries(overrides).filter(([, value]) => Number.isFinite(value) && (value as number) > 0)
  if (pinned.length === 0) return cnyRates
  return { ...cnyRates, ...Object.fromEntries(pinned) }
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
      amount += convertToBase(payment.amount, payment.currency, rates)
    } else if (parts.year === previousYear && parts.month === previousMonth) {
      lastAmount += convertToBase(payment.amount, payment.currency, rates)
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
    if (parts.year === current.year) amount += convertToBase(payment.amount, payment.currency, rates)
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
    const amount = convertToBase(payment.amount, payment.currency, rates)
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
    const share = labelNamesOf(item?.category, 'category')
    const amount = convertToBase(payment.amount, payment.currency, rates)
    if (!share.length) {
      totals.set('uncategorized', (totals.get('uncategorized') ?? 0) + amount)
      total += amount
      continue
    }
    for (const label of share) {
      totals.set(label, (totals.get(label) ?? 0) + amount / share.length)
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
    buckets[slot]!.amount += convertToBase(payment.amount, payment.currency, rates)
  }
  return buckets.map((bucket) => ({ month: bucket.month, amount: roundMoney(bucket.amount) }))
}

/** How many times a plan charges inside twelve months: a 3-month plan bills four times, an 18-month one twice. */
export function renewalsPerYear(item: Pick<SubscriptionItem, 'periodUnit' | 'periodValue'>): number {
  const periods = Math.max(1, item.periodValue)
  if (item.periodUnit === 'day') return 365 / periods
  if (item.periodUnit === 'month') return 12 / periods
  return 1 / periods
}

/**
 * What one plan costs a month, in the currency the account's totals are added up in.
 *
 * A year at ¥360 and a month at ¥39 are the same decision, and a reader ordering by what hurts least needs
 * them on one scale. Converted rather than compared at face value: twenty Singapore dollars is not twenty
 * yuan, and a list that pretended otherwise would file the cheaper plan last.
 */
export function monthlyEquivalent(
  item: Pick<SubscriptionItem, 'amount' | 'currency' | 'periodUnit' | 'periodValue'>,
  rates: RateTable,
): number {
  if (item.amount === null || item.amount <= 0) return 0
  return roundMoney(convertToBase(item.amount, item.currency, rates) * renewalsPerYear(item) / 12)
}

/**
 * What a plan would cost across a full year at its current price.
 *
 * Deliberately a projection rather than a sum of receipts: "what have I actually spent this year" and
 * "what have I committed to" are different questions, and the second one is what a reader weighs a new
 * subscription against. A cancelled plan drops out immediately because it stops being active, which is
 * the point — the number is meant to move when they act.
 */
export function annualisedCost(
  items: readonly SubscriptionItem[],
  rates: RateTable,
): number {
  let total = 0
  for (const item of items) {
    if (!item.isActive || item.amount === null || item.amount <= 0) continue
    total += convertToBase(item.amount * renewalsPerYear(item), item.currency, rates)
  }
  return roundMoney(total)
}

/** A receipt as the yearly grouping needs it: when it was paid, how much, in what. */
export interface SpendingInput {
  paidAt: number
  amount: number
  currency: CurrencyCode
}

/**
 * What the receipts added up to, year by year.
 *
 * The year is the account's own, read in its zone: a payment stamped an hour past midnight in Shanghai is
 * last year for a reader who counts in UTC, and the app already dates everything else by the account.
 *
 * Split by currency instead of converted, because this runs where the exchange table is not — the store
 * calls it while building one subscription's detail. A total that mixed yuan and dollars would be a
 * number with no unit, so it is not attempted; each line names its own.
 */
export function spendingByYear(payments: readonly SpendingInput[], timezone: string): YearSpend[] {
  const byYear = new Map<string, YearSpend>()
  for (const payment of payments) {
    if (!Number.isFinite(payment.amount)) continue
    const { year } = getTimezoneDateParts(payment.paidAt, timezone)
    const key = `${year}|${payment.currency}`
    const entry = byYear.get(key) ?? { year, currency: payment.currency, amount: 0, receipts: 0 }
    entry.amount += payment.amount
    entry.receipts += 1
    byYear.set(key, entry)
  }
  return [...byYear.values()]
    .map((entry) => ({ ...entry, amount: roundMoney(entry.amount) }))
    .sort((left, right) => right.year - left.year || left.currency.localeCompare(right.currency))
}

/**
 * The price rises hiding in the receipt history.
 *
 * A subscription's `amount` is what it costs now, so a plan that went up silently looks exactly as it
 * did the day it was added. The two most recent receipts with different amounts are the evidence, and
 * the older one is the price the reader remembers agreeing to.
 *
 * Only the last two are compared: a plan that went up then back down is not a rise, and reconstructing
 * a full price series would be a chart, not an answer.
 */
export function findPriceChanges(
  items: readonly SubscriptionItem[],
  payments: readonly PaymentSample[],
): PriceChange[] {
  const bySubscription = new Map<string, PaymentSample[]>()
  for (const payment of payments) {
    if (!(payment.amount > 0)) continue
    const list = bySubscription.get(payment.subscriptionId) ?? []
    list.push(payment)
    bySubscription.set(payment.subscriptionId, list)
  }
  const out: PriceChange[] = []
  for (const item of items) {
    const history = (bySubscription.get(item.id) ?? []).sort((left, right) => right.paidAt - left.paidAt)
    if (history.length < 2) continue
    const [latest] = history
    if (!latest) continue
    // Only a receipt in the same currency as the newest one can say the price moved. Comparing a $60
    // charge with the ¥360 before it measures two currencies, not two prices, and reports the gap as a
    // rise the reader never saw.
    const previous = history.slice(1).find((payment) => payment.currency === latest.currency)
    if (!previous || latest.amount === previous.amount) continue
    // A renewal that bought several periods costs more without the plan being dearer, so the comparison
    // is only honest per period.
    const latestPerPeriod = latest.amount
    const previousPerPeriod = previous.amount
    if (previousPerPeriod <= 0) continue
    out.push({
      id: item.id,
      name: item.name,
      currency: latest.currency,
      previous: roundMoney(previousPerPeriod),
      current: roundMoney(latestPerPeriod),
      change: Math.round(((latestPerPeriod - previousPerPeriod) / previousPerPeriod) * 100),
      at: new Date(latest.paidAt).toISOString(),
    })
  }
  return out.sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
}

/** One point on a single plan's price curve: the day it was charged, and what that charge was. */
export interface PricePoint {
  at: string
  amount: number
}

/**
 * The receipts a price curve can honestly connect.
 *
 * One currency only: connecting a dollar bill to a yuan bill draws a line between two units, not a trend
 * in a price. Zero and negative charges are left out for the same reason — a free trial's ¥0.00 is the
 * absence of a price, and a refund is not a discount the plan offered. Oldest first, newest last, and the
 * oldest points fall off when the history is longer than the plot can hold.
 */
export function priceHistory(
  payments: readonly { paidAt: string | number; amount: number; currency: string }[],
  currency: string,
  limit = 12,
): PricePoint[] {
  const points = payments
    .filter((payment) => payment.currency === currency && payment.amount > 0)
    .map((payment) => ({ at: typeof payment.paidAt === 'number' ? new Date(payment.paidAt).toISOString() : payment.paidAt, amount: payment.amount }))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  return points.slice(Math.max(0, points.length - limit))
}

/** Trials still running, soonest to start charging first. */
export function trialsEnding(
  items: readonly SubscriptionItem[],
  timezone: string,
  now: Date = new Date(),
): TrialEnding[] {
  return items
    .filter((item) => item.isActive && item.trialEndsAt)
    .map((item) => ({
      id: item.id,
      name: item.name,
      endsAt: item.trialEndsAt as string,
      daysRemaining: getDaysBetween(now, Date.parse(item.trialEndsAt as string), timezone),
      amount: item.amount,
      currency: item.currency,
    }))
    .sort((left, right) => left.daysRemaining - right.daysRemaining)
}

/** Today, in the account's zone, as the dashboard's own clock reads it. */
export function todayLabel(timezone: string, now: Date = new Date()): string {
  return getNowInTimezone(timezone, now).isoLocal.slice(0, 10)
}
