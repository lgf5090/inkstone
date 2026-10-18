/**
 * Asking a provider what it is owed, once per key.
 *
 * The reader with three keys has three wallets, and the settings screen showed none of them. This is the
 * whole of the asking: build the one GET the vendor's own row in `@shared/provider-balance` describes, hand
 * it the credential that provider already holds, and read a number out of the answer. Nothing is stored —
 * a balance is a fact about a moment, and a balance kept in a database becomes a number a reader mistakes
 * for a current one.
 *
 * Three things keep this from being a way to make the worker fetch arbitrary places with somebody's key:
 *  - the address is the provider's own origin plus a path from a table this build owns. No reader input
 *    reaches either half, and the row is chosen by matching the provider's host exactly, so a relay at an
 *    address of the reader's own never receives a billing request aimed at a vendor;
 *  - the same relay guard every other outbound address passes through, and the same refusal to follow a
 *    redirect, which is what stops a public address from being a public address only until it is followed;
 *  - one attempt, a short deadline, a byte ceiling, and no retry: this answers a question a screen asked,
 *    and it is never worth a second one.
 *
 * A reading is cached in this isolate for a few minutes so that opening the same panel twice does not ask
 * the vendor twice. The cache key is the account and the key row, never the credential.
 */

import { assertRelayableEndpoint } from '@shared/ai-proxy-guard'
import { balanceFromPayload, type BalanceReading, type BalanceSpec } from '@shared/provider-balance'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'

/** How long a reading is treated as current. A wallet empties during a working day; a panel does not. */
const READING_TTL_MS = 5 * 60_000

/** How long the vendor may take. This is a nicety on a settings screen, not a turn waiting to answer. */
const BALANCE_TIMEOUT_MS = 6_000

/** A billing answer is a few hundred bytes; past this the address is not answering the question asked. */
const MAX_BALANCE_BYTES = 64 * 1024

/** How many readings one isolate remembers before it starts over. */
const CACHE_LIMIT = 64

const cache = new Map<string, { at: number, reading: BalanceReading }>()

/**
 * One provider key's balance, from the vendor that row's provider points at.
 *
 * `cacheKey` names the account and the key row — it is never derived from the credential, and a reading for
 * one key is not shown beside another.
 */
export async function fetchProviderBalance(
  spec: BalanceSpec,
  baseUrl: string,
  apiKey: string,
  cacheKey: string,
): Promise<BalanceReading> {
  const held = cache.get(cacheKey)
  if (held && Date.now() - held.at < READING_TTL_MS) return held.reading
  const reading = await askVendor(spec, baseUrl, apiKey)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(cacheKey, { at: Date.now(), reading })
  return reading
}

/** Drop what a key rotation or a deleted provider left behind. */
export function forgetBalances(prefix: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key)
}

async function askVendor(spec: BalanceSpec, baseUrl: string, apiKey: string): Promise<BalanceReading> {
  let target: URL
  try {
    // The provider's own origin, with the table's path. `assertRelayableEndpoint` re-checks the result, so
    // an address that was public when it was saved and is a private host now still cannot be reached.
    const origin = new URL(baseUrl)
    target = new URL(`${origin.origin}${spec.path}`)
    assertRelayableEndpoint(target.toString())
  } catch {
    return { ok: false, reason: 'unsupported' }
  }
  const key = apiKey.trim()
  if (!key) return { ok: false, reason: 'unauthorized' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(target.toString(), {
      method: 'GET',
      redirect: NO_REDIRECT,
      headers: {
        accept: 'application/json',
        'user-agent': 'Inkstone-Balance/1.0',
        // Two shapes across every vendor listed: a bearer value, and the one that sends the bare key.
        ...(spec.keyCarrier === 'raw' ? { authorization: key } : { authorization: `Bearer ${key}` }),
      },
      signal: controller.signal,
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
  if (isRedirectResponse(response)) return { ok: false, reason: 'unsupported' }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'unauthorized' }
  if (response.status === 404 || response.status === 405) return { ok: false, reason: 'unsupported' }
  if (response.status === 429 || response.status >= 500) return { ok: false, reason: 'unreachable' }
  if (!response.ok) return { ok: false, reason: 'unreadable' }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_BALANCE_BYTES) return { ok: false, reason: 'unreadable' }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_BALANCE_BYTES) return { ok: false, reason: 'unreadable' }
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  const amount = balanceFromPayload(spec, payload)
  // An answer that carried no number is not a zero balance: the key was accepted and this endpoint did not
  // say what was left, which are different sentences and get shown as one of them.
  return amount ? { ok: true, ...amount } : { ok: false, reason: 'unreadable' }
}
