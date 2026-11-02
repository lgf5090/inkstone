import type { CurrencyRates } from '@shared/tools/calculator/types'

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

export function parseEcbRates(xml: string): CurrencyRates {
  const rates: Record<string, number> = { EUR: 1 }
  const date = /<Cube\s+time=['"]([^'"]+)['"]/.exec(xml)?.[1]
  for (const tag of xml.matchAll(/<Cube\b[^>]*>/g)) {
    const currency = /currency=['"]([A-Z]{3})['"]/.exec(tag[0])?.[1]
    const rate = Number(/rate=['"]([0-9.]+)['"]/.exec(tag[0])?.[1])
    if (currency && Number.isFinite(rate) && rate > 0) rates[currency] = rate
  }
  const count = Object.keys(rates).length
  if (count < 10) throw new Error(`ECB returned only ${count} rates`)
  const fetchedAt = date ? Date.parse(`${date}T00:00:00Z`) : Date.now()
  return {
    base: 'EUR',
    rates,
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : Date.now(),
    cachedAt: Date.now(),
    stale: false,
    source: 'ECB',
  }
}

export async function fetchEcbRates(): Promise<CurrencyRates> {
  const response = await fetch(ECB_URL, {
    headers: { accept: 'application/xml,text/xml' },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`ECB responded ${response.status}`)
  const xml = await response.text()
  return parseEcbRates(xml)
}
