import type { CurrencyDef, CurrencyRates } from '../types'

/**
 * The ECB publishes daily reference rates against the euro. The list below is the subset of that
 * publication we expose; ids are stable so a saved preference survives a rate refresh.
 */
export const CURRENCY_DEFINITIONS: readonly CurrencyDef[] = [
  { id: 1, code: 'USD', region: 'US' },
  { id: 2, code: 'EUR', region: 'EU' },
  { id: 3, code: 'GBP', region: 'GB' },
  { id: 4, code: 'JPY', region: 'JP' },
  { id: 5, code: 'CNY', region: 'CN' },
  { id: 6, code: 'HKD', region: 'HK' },
  { id: 7, code: 'KRW', region: 'KR' },
  { id: 8, code: 'AUD', region: 'AU' },
  { id: 9, code: 'CAD', region: 'CA' },
  { id: 10, code: 'CHF', region: 'CH' },
  { id: 11, code: 'SGD', region: 'SG' },
  { id: 12, code: 'INR', region: 'IN' },
  { id: 13, code: 'NZD', region: 'NZ' },
  { id: 14, code: 'SEK', region: 'SE' },
  { id: 15, code: 'NOK', region: 'NO' },
  { id: 16, code: 'DKK', region: 'DK' },
  { id: 17, code: 'PLN', region: 'PL' },
  { id: 18, code: 'CZK', region: 'CZ' },
  { id: 19, code: 'HUF', region: 'HU' },
  { id: 20, code: 'RON', region: 'RO' },
  { id: 21, code: 'BGN', region: 'BG' },
  { id: 22, code: 'TRY', region: 'TR' },
  { id: 23, code: 'ILS', region: 'IL' },
  { id: 24, code: 'ZAR', region: 'ZA' },
  { id: 25, code: 'BRL', region: 'BR' },
  { id: 26, code: 'MXN', region: 'MX' },
  { id: 27, code: 'MYR', region: 'MY' },
  { id: 28, code: 'PHP', region: 'PH' },
  { id: 29, code: 'THB', region: 'TH' },
  { id: 30, code: 'IDR', region: 'ID' },
  { id: 31, code: 'ISK', region: 'IS' },
] as const

export const CURRENCY_BY_ID: ReadonlyMap<number, CurrencyDef> = new Map(CURRENCY_DEFINITIONS.map((currency) => [currency.id, currency]))
export const CURRENCY_BY_CODE: ReadonlyMap<string, CurrencyDef> = new Map(CURRENCY_DEFINITIONS.map((currency) => [currency.code, currency]))

export function currencyName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { type: 'currency' }).of(code) ?? code
  } catch {
    return code
  }
}

export function currencyRegionName(region: string, locale: string): string {
  try {
    return new Intl.DisplayNames(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { type: 'region' }).of(region) ?? region
  } catch {
    return region
  }
}

export function currencySymbol(code: string, locale: string): string {
  try {
    const parts = new Intl.NumberFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0)
    return parts.find((part) => part.type === 'currency')?.value ?? code
  } catch {
    return code
  }
}

export function currencyFractionDigits(code: string): number {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

export function currencyLabel(code: string, locale: string): string {
  const currency = CURRENCY_BY_CODE.get(code)
  const name = currencyName(code, locale)
  const region = currency ? currencyRegionName(currency.region, locale) : ''
  return region ? `${name} · ${region}` : `${name} · ${code}`
}

export function convertCurrencyValue(value: number, fromCode: string, toCode: string, rates: CurrencyRates | null): number {
  if (!rates || !Number.isFinite(value)) return Number.NaN
  const from = fromCode === rates.base ? 1 : rates.rates[fromCode]
  const to = toCode === rates.base ? 1 : rates.rates[toCode]
  if (!from || !to || !Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN
  return (value / from) * to
}

export function currencyRatioText(fromCode: string, toCode: string, rates: CurrencyRates | null): string {
  const ratio = convertCurrencyValue(1, fromCode, toCode, rates)
  if (!Number.isFinite(ratio)) return ''
  return `1 ${fromCode} = ${ratio.toFixed(4)} ${toCode}`
}

export function truncateCurrencyInput(input: string, code: string): string {
  const digits = currencyFractionDigits(code)
  if (digits === 0) return input.split('.')[0] ?? ''
  const [whole, fraction = ''] = input.split('.')
  return fraction.length > digits ? `${whole}.${fraction.slice(0, digits)}` : input
}

export function formatCurrencyValue(value: number, code: string): string {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(currencyFractionDigits(code))
}
