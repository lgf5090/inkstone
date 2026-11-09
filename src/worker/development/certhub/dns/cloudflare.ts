import { ApiError } from '../../../lib/errors'
import type { Env } from '../../../env'

const BASE = 'https://api.cloudflare.com/client/v4'

/**
 * The token as Cloudflare will receive it.
 *
 * Pasting a token is not the same as typing it: it arrives with a trailing newline, a `Bearer ` prefix
 * copied from the docs, or spaces a terminal added around it. Any of those turns into the same
 * `Invalid request headers` (6003) as a revoked token, so the shape is fixed once, at the boundary.
 * Cloudflare tokens never contain whitespace, so removing all of it is safe.
 */
export function normalizeCloudflareToken(value: string): string {
  return value.trim().replace(/^bearer\s+/i, '').replace(/\s+/g, '')
}

/**
 * A Global API Key is 37 hex characters; an API Token is a different shape and is what Bearer auth
 * accepts. Catching the paste here names the mistake instead of forwarding it and reporting 6003.
 */
export function looksLikeGlobalApiKey(value: string): boolean {
  return /^[0-9a-f]{37}$/i.test(normalizeCloudflareToken(value))
}


export interface CloudflareRecord {
  id: string
  name: string
  type: string
  content: string
  comment?: string
}

interface CloudflareResponse<T> {
  success: boolean
  result: T
  errors?: Array<{ code?: number; message?: string }>
}

async function request<T>(
  path: string,
  rawToken: string,
  init: RequestInit = {},
): Promise<T> {
  const token = normalizeCloudflareToken(rawToken)
  if (!token) throw new ApiError(422, 'dns_token_invalid', 'The DNS provider token is empty', { endpoint: path, reason: 'empty_token' })
  if (looksLikeGlobalApiKey(token)) {
    throw new ApiError(422, 'dns_global_key', 'A Global API Key was pasted; Cloudflare requires an API Token', {
      endpoint: path,
      reason: 'global_api_key',
    })
  }
  const url = `${BASE}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    const name = (error as Error)?.name
    throw new ApiError(
      503,
      'dns_network',
      name === 'TimeoutError' || name === 'AbortError'
        ? 'The DNS provider did not answer in time'
        : 'The DNS provider could not be reached',
      { endpoint: path, cause: String((error as Error)?.message ?? error).slice(0, 120) },
    )
  }
  const text = await response.text()
  if (text.length > 256 * 1024) {
    throw new ApiError(502, 'dns_error', 'The DNS provider answered with too much data', { endpoint: path, upstreamStatus: response.status })
  }
  let payload: CloudflareResponse<T>
  try {
    payload = JSON.parse(text) as CloudflareResponse<T>
  } catch {
    throw new ApiError(502, 'dns_error', `The DNS provider answered HTTP ${response.status}`, {
      endpoint: path,
      upstreamStatus: response.status,
      upstreamMessage: text.slice(0, 120),
    })
  }
  if (!response.ok || !payload.success) {
    // The category is the part a reader can act on; the upstream status/code/message ride along in
    // `details` so a blanket 502 never hides which Cloudflare check refused the request.
    const codes = (payload.errors ?? []).map((entry) => entry.code).filter((code): code is number => typeof code === 'number')
    const messages = (payload.errors ?? []).map((entry) => entry.message).filter((message): message is string => Boolean(message))
    const upstreamMessage = (messages[0] ?? `HTTP ${response.status}`).slice(0, 160)
    const details = { endpoint: path, upstreamStatus: response.status, upstreamCodes: codes, upstreamMessage }
    const authLike = response.status === 401 || response.status === 403 || codes.includes(10000)
      || /authentication error|invalid request headers|unauthorized|forbidden|permission/i.test(upstreamMessage)
    // A refused credential is a bad configuration value, not a bad platform session: 422 keeps the
    // reader signed in and leaves 401 to the auth middleware. The category stays machine-readable.
    let status: 401 | 403 | 422 | 429 | 502 = 502
    let code: 'dns_token_invalid' | 'dns_zone_forbidden' | 'dns_zone_mismatch' | 'dns_rate_limited' | 'dns_error' = 'dns_error'
    if (response.status === 429) {
      status = 429
      code = 'dns_rate_limited'
    } else if (authLike && path.startsWith('/user/tokens/verify')) {
      status = 422
      code = 'dns_token_invalid'
    } else if (authLike) {
      status = 422
      code = 'dns_zone_forbidden'
    }
    throw new ApiError(status, code, upstreamMessage, details)
  }
  return payload.result
}

export async function verifyCloudflareToken(token: string): Promise<void> {
  await request<{ id: string; status: string }>('/user/tokens/verify', token)
}

/**
 * Resolves the zone id the token can actually write to, by the zone's name.
 *
 * The id a reader pasted is a fact they cannot verify; a token that belongs to another account, or a
 * zone id copied from elsewhere, answers "Authentication error" on every record call while
 * `/user/tokens/verify` still succeeds. Asking Cloudflare for the zone by name turns that into either
 * the correct id or a readable "this token cannot see this zone" refusal.
 */
export async function resolveZoneId(token: string, zoneName: string): Promise<string> {
  const name = zoneName.trim().toLowerCase().replace(/\.$/, '')
  if (!name) return ''
  const zones = await request<Array<{ id: string; name: string }>>(
    `/zones?name=${encodeURIComponent(name)}&per_page=20`,
    token,
  )
  const exact = zones.find((zone) => zone.name.toLowerCase() === name)
  if (!exact) {
    throw new ApiError(422, 'dns_zone_mismatch', `The API token cannot access the zone ${name}`, {
      endpoint: `/zones?name=${name}`,
      upstreamStatus: 200,
      upstreamCodes: [],
      upstreamMessage: `No zone named ${name} is visible to this token`,
    })
  }
  return exact.id
}

/**
 * Proves the token can write DNS records, by creating and removing a temporary TXT record.
 *
 * `/user/tokens/verify` answers for a token with any scope, so a Zone:Read token passes every earlier
 * check and then fails every issuance at the first record write. The probe is the only honest test;
 * its name is unique and it is deleted immediately, so a successful probe leaves nothing behind.
 */
export async function probeDnsWrite(token: string, zoneId: string): Promise<void> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  const recordId = await createTxtRecord(
    token,
    zoneId,
    `_certhub-permission-probe-${suffix}`,
    'certhub-permission-probe',
    'certhub:permission-probe',
  )
  await deleteDnsRecord(token, zoneId, recordId)
}

export async function verifyCloudflareConnection(token: string, zoneId: string): Promise<void> {
  await verifyCloudflareToken(token)
  await request<{ id: string; name: string }>(`/zones/${zoneId}`, token)
  await probeDnsWrite(token, zoneId)
}

export async function listDnsRecords(
  token: string,
  zoneId: string,
  name?: string,
): Promise<CloudflareRecord[]> {
  const records: CloudflareRecord[] = []
  for (let page = 1; page <= 20; page += 1) {
    const query = new URLSearchParams({ per_page: '100', page: String(page) })
    if (name) query.set('name', name)
    const batch = await request<CloudflareRecord[]>(`/zones/${zoneId}/dns_records?${query.toString()}`, token)
    records.push(...batch)
    if (batch.length < 100) break
  }
  return records
}

export async function createTxtRecord(
  token: string,
  zoneId: string,
  name: string,
  content: string,
  comment: string,
): Promise<string> {
  const created = await request<CloudflareRecord>(`/zones/${zoneId}/dns_records`, token, {
    method: 'POST',
    body: JSON.stringify({ type: 'TXT', name, content, ttl: 60, comment }),
  })
  return created.id
}

/**
 * Writes the TXT record this order owns, or returns the id of the one it already owns.
 *
 * Two orders for the same name (`example.com` and `*.example.com`) need two values at
 * `_acme-challenge.example.com`, so the write must never replace an existing record. An interrupted
 * attempt, though, can leave the record already there, and retrying would stack a duplicate value.
 * The comment carries the order id: a record with this name, value and comment is this order's own
 * record, while another order's value at the same name is left untouched.
 */
export async function ensureTxtRecord(
  token: string,
  zoneId: string,
  name: string,
  content: string,
  comment: string,
): Promise<string> {
  const existing = await listDnsRecords(token, zoneId, name)
  const owned = existing.find((record) => record.type === 'TXT' && record.content === content && record.comment === comment)
  if (owned) return owned.id
  return createTxtRecord(token, zoneId, name, content, comment)
}

export async function deleteDnsRecord(token: string, zoneId: string, recordId: string): Promise<void> {
  if (!recordId) return
  try {
    await request<unknown>(`/zones/${zoneId}/dns_records/${recordId}`, token, { method: 'DELETE' })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return
    throw error
  }
}

export function cloudflareConfig(env: Env): { zone: string; token: string; email: string } {
  return {
    zone: env.CERTHUB_DCV_ZONE?.trim() ?? '',
    token: env.CERTHUB_DCV_TOKEN?.trim() ?? '',
    email: env.CERTHUB_DCV_EMAIL?.trim() ?? '',
  }
}
