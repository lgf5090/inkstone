import { describe, expect, it } from 'vitest'
import {
  CURRENCY_DEFINITIONS,
  convertCurrencyValue,
  currencyFractionDigits,
  currencyLabel,
  currencyRatioText,
  truncateCurrencyInput,
} from '@shared/tools/calculator/converters/currency'
import { parseEcbRates } from '../src/worker/tools/calculator/rates'

describe('real currency rates', () => {
  it('has unique ids and codes', () => {
    expect(new Set(CURRENCY_DEFINITIONS.map((currency) => currency.id)).size).toBe(CURRENCY_DEFINITIONS.length)
    expect(new Set(CURRENCY_DEFINITIONS.map((currency) => currency.code)).size).toBe(CURRENCY_DEFINITIONS.length)
  })

  it('parses ECB XML into euro-based rates', () => {
    const xml = `<Cube time="2026-11-01"><Cube currency="USD" rate="1.10"/><Cube currency="CNY" rate="8.00"/><Cube currency="JPY" rate="170"/><Cube currency="GBP" rate="0.85"/><Cube currency="CHF" rate="0.94"/><Cube currency="AUD" rate="1.7"/><Cube currency="CAD" rate="1.5"/><Cube currency="HKD" rate="8.6"/><Cube currency="KRW" rate="1500"/><Cube currency="SGD" rate="1.4"/><Cube currency="INR" rate="93"/></Cube>`
    const rates = parseEcbRates(xml)
    expect(rates.base).toBe('EUR')
    expect(rates.rates.EUR).toBe(1)
    expect(rates.rates.USD).toBe(1.1)
    expect(rates.fetchedAt).toBe(Date.parse('2026-11-01T00:00:00Z'))
    expect(rates.cachedAt).toBeGreaterThan(0)
  })

  it('converts through the euro base', () => {
    const rates = { base: 'EUR', rates: { EUR: 1, USD: 1.1, CNY: 8 }, fetchedAt: 1, cachedAt: 1, stale: false, source: 'test' }
    expect(convertCurrencyValue(1, 'USD', 'EUR', rates)).toBeCloseTo(1 / 1.1, 12)
    expect(convertCurrencyValue(1, 'EUR', 'USD', rates)).toBeCloseTo(1.1, 12)
    expect(convertCurrencyValue(8, 'CNY', 'USD', rates)).toBeCloseTo(1.1, 12)
    expect(currencyRatioText('USD', 'EUR', rates)).toBe('1 USD = 0.9091 EUR')
  })

  it('uses Intl for names, symbols and fraction digits', () => {
    expect(currencyFractionDigits('JPY')).toBe(0)
    expect(currencyFractionDigits('USD')).toBe(2)
    expect(currencyLabel('USD', 'en-US')).toContain('US Dollar')
    expect(currencyLabel('CNY', 'zh-CN')).toContain('人民币')
    expect(truncateCurrencyInput('12.345', 'JPY')).toBe('12')
    expect(truncateCurrencyInput('12.345', 'USD')).toBe('12.34')
  })
})
