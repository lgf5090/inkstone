import { isBlockedTarget, isIpLiteralHost } from '@shared/ai-proxy-guard'

export type HostVerdict = 'ok' | 'blocked' | 'unresolved' | 'failed'
export type HostLookup = (hostname: string, type: 'A' | 'AAAA') => Promise<string[]>

const DOH_PROVIDERS = [
  (host: string, type: 'A' | 'AAAA') => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
  (host: string, type: 'A' | 'AAAA') => `https://doh.pub/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
  (host: string, type: 'A' | 'AAAA') => `https://dns.alidns.com/resolve?name=${encodeURIComponent(host)}&type=${type}`,
] as const
let preferredProvider = 0
let hasPreferredProvider = false
const CACHE_LIMIT = 512
const PUBLIC_TTL_MS = 5 * 60_000
const FAILURE_TTL_MS = 30_000

const cache = new Map<string, { verdict: HostVerdict; expiresAt: number }>()

async function fetchDoh(url: string, type: 'A' | 'AAAA'): Promise<string[]> {
  const response = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(1500),
  })
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => null)
    throw new Error(`DNS lookup failed: HTTP ${response.status}`)
  }
  const body = await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> }
  if (body.Status !== 0 || !Array.isArray(body.Answer)) return []
  const wanted = type === 'A' ? 1 : 28
  return body.Answer
    .filter((answer) => answer.type === wanted && typeof answer.data === 'string')
    .map((answer) => answer.data!)
}

async function dohLookup(hostname: string, type: 'A' | 'AAAA'): Promise<string[]> {
  if (!hasPreferredProvider) {
    const winner = await Promise.any(DOH_PROVIDERS.map(async (provider, index) => {
      const answers = await fetchDoh(provider(hostname, type), type)
      if (!answers.length) throw new Error('DNS response had no address')
      return { index, answers }
    }))
    preferredProvider = winner.index
    hasPreferredProvider = true
    return winner.answers
  }
  let lastError: unknown = null
  // An authoritative empty answer and a resolver that never answered are different facts, and the caller
  // has to be able to tell them apart: the first means the name has no address, the second means we do
  // not know. Collapsing them made every link under a resolver outage read as a dead bookmark.
  let answered = false
  for (let offset = 0; offset < DOH_PROVIDERS.length; offset += 1) {
    const index = (preferredProvider + offset) % DOH_PROVIDERS.length
    try {
      const answers = await fetchDoh(DOH_PROVIDERS[index]!(hostname, type), type)
      answered = true
      if (answers.length) {
        preferredProvider = index
        return answers
      }
    } catch (error) {
      lastError = error
    }
  }
  if (answered) return []
  throw lastError instanceof Error ? lastError : new Error('DNS lookup returned no address')
}

function remember(host: string, verdict: HostVerdict): void {
  // A resolver outage says nothing about the name, and the cache is shared by every account in this
  // isolate: holding that answer for the failure TTL turned one provider's hiccup into a wave of
  // false "dead link" verdicts across unrelated users.
  if (verdict === 'failed') return
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(host, {
    verdict,
    expiresAt: Date.now() + (verdict === 'ok' ? PUBLIC_TTL_MS : FAILURE_TTL_MS),
  })
}

export async function resolvePublicHost(hostname: string, lookup: HostLookup = dohLookup): Promise<HostVerdict> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || isBlockedTarget(host)) return 'blocked'
  if (isIpLiteralHost(host)) return 'ok'

  if (lookup === dohLookup) {
    const cached = cache.get(host)
    if (cached && cached.expiresAt > Date.now()) return cached.verdict
  }

  const a = await settledAnswers(lookup, host, 'A')
  if (a.addresses.some((address) => isBlockedTarget(address))) {
    if (lookup === dohLookup) remember(host, 'blocked')
    return 'blocked'
  }
  const aaaa = await settledAnswers(lookup, host, 'AAAA')
  const answers = [...a.addresses, ...aaaa.addresses]
  const verdict: HostVerdict = answers.some((address) => isBlockedTarget(address))
    ? 'blocked'
    : answers.length > 0
      ? 'ok'
      : a.answered && aaaa.answered ? 'unresolved' : 'failed'

  if (lookup === dohLookup) remember(host, verdict)
  return verdict
}

interface SettledAnswers {
  addresses: string[]
  /** False only when the resolver itself could not be reached, which is not an answer about the name. */
  answered: boolean
}

async function settledAnswers(lookup: HostLookup, host: string, type: 'A' | 'AAAA'): Promise<SettledAnswers> {
  const [result] = await Promise.allSettled([lookup(host, type)])
  return result?.status === 'fulfilled' ? { addresses: result.value, answered: true } : { addresses: [], answered: false }
}
