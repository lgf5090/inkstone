import { ApiError } from '../../../lib/errors'

const DOH_ENDPOINTS = [
  'https://dns.google/resolve',
  'https://cloudflare-dns.com/dns-query',
] as const

export interface DohAnswer {
  name: string
  type: number
  data: string
}

export async function queryDns(name: string, type: 'TXT' | 'CNAME', override?: string): Promise<string[]> {
  const endpoints = override ? [override] : DOH_ENDPOINTS
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint)
      url.searchParams.set('name', name)
      url.searchParams.set('type', type)
      const response = await fetch(url, {
        headers: { Accept: 'application/dns-json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) continue
      const text = await response.text()
      if (text.length > 32 * 1024) continue
      const payload = JSON.parse(text) as { Answer?: DohAnswer[] }
      if (!Array.isArray(payload.Answer)) continue
      return payload.Answer
        .filter((answer) => answer.type === (type === 'TXT' ? 16 : 5))
        .map((answer) => answer.data.replace(/^"|"$/g, '').replace(/"\s*"$/g, ''))
    } catch {
      continue
    }
  }
  return []
}

export function assertDnsName(value: string): string {
  if (!/^[a-z0-9._-]{1,253}$/i.test(value)) throw ApiError.badRequest('The DNS name is not valid')
  return value
}
