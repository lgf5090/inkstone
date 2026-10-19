/**
 * Display arithmetic that has one right answer, kept out of the components.
 *
 * Nothing here holds copy. A unit's name, a countdown's sentence and a status pill's word are interface
 * strings and belong to the locale catalogs; what this module decides is the *shape* — which symbol a
 * currency wears, which of three countdown states a number of days means, how much of a billing period
 * has elapsed. That split is what lets the same rules be tested without a language.
 */
import type { MessageKey } from '../locales/en-US'
import type { CurrencyCode, PeriodUnit, ReminderUnit } from './model'

/** The symbol each currency is written with. JPY is prefixed on purpose: `¥` alone is ambiguous. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  TWD: 'NT$',
  JPY: 'JP¥',
  EUR: '€',
  GBP: '£',
  KRW: '₩',
  TRY: '₺',
}

export function currencySymbol(currency: string | undefined): string {
  const code = String(currency || 'CNY').toUpperCase()
  return CURRENCY_SYMBOLS[code] ?? `${code} `
}

/**
 * An amount with its currency symbol, or an empty string when there is no amount.
 *
 * Empty rather than `0`: a subscription whose price was never recorded is not a free one, and printing
 * `¥0.00` would claim it was.
 */
export function formatAmount(amount: number | null | undefined, currency: string | undefined, options: { decimals?: boolean } = {}): string {
  if (amount === null || amount === undefined) return ''
  const value = Number(amount)
  if (!Number.isFinite(value)) return ''
  const symbol = currencySymbol(currency)
  return options.decimals === false ? `${symbol}${Math.round(value)}` : `${symbol}${value.toFixed(2)}`
}

/** Which countdown sentence a number of remaining days calls for, and the number it needs. */
export interface DaysState {
  kind: 'today' | 'overdue' | 'remaining'
  count: number
}

export function daysState(daysRemaining: number): DaysState {
  if (daysRemaining < 0) return { kind: 'overdue', count: Math.abs(daysRemaining) }
  if (daysRemaining === 0) return { kind: 'today', count: 0 }
  return { kind: 'remaining', count: daysRemaining }
}

export function daysStateKey(state: DaysState): MessageKey {
  if (state.kind === 'today') return 'subscriptions.status.due_today'
  if (state.kind === 'overdue') return 'subscriptions.status.days_overdue'
  return 'subscriptions.status.days_left'
}

/** The catalog key for a period unit's name. */
export function periodUnitKey(unit: PeriodUnit): MessageKey {
  if (unit === 'day') return 'subscriptions.unit_day'
  if (unit === 'year') return 'subscriptions.unit_year'
  return 'subscriptions.unit_month'
}

/** The catalog key for a reminder unit's name, which is plural in one language and not the other. */
export function reminderUnitKey(unit: ReminderUnit): MessageKey {
  return unit === 'hours' ? 'subscriptions.rules.unit_hours' : 'subscriptions.rules.unit_days'
}

/**
 * How far through its billing period a subscription is, 0-100.
 *
 * This is the one number the reference project never showed and a reader wants most: "12 days left"
 * means something different on a monthly plan than on a three-year one. Returns null when the period
 * has no start, because a bar with no beginning would be drawn from a guess.
 */
export function periodProgress(periodStart: number | null, periodEnd: number, now = Date.now()): number | null {
  if (periodStart === null || !Number.isFinite(periodStart) || !Number.isFinite(periodEnd)) return null
  const span = periodEnd - periodStart
  if (span <= 0) return null
  const elapsed = Math.min(span, Math.max(0, now - periodStart))
  return Math.round((elapsed / span) * 100)
}

/** `2026-05` to the month's own number, for a chart axis that needs no locale. */
export function monthNumber(month: string): string {
  return month.slice(5)
}

/** A currency's code, or CNY when nothing usable was stored. */
export function currencyOf(value: unknown): CurrencyCode {
  const code = String(value ?? 'CNY').toUpperCase()
  return (Object.keys(CURRENCY_SYMBOLS).includes(code) ? code : 'CNY') as CurrencyCode
}
