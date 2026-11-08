import { ApiError } from '../../../lib/errors'
import type { Env } from '../../../env'

const BASE = 'https://api.cloudflare.com/client/v4'

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
  token: string,
  init: RequestInit = {},
): Promise<T> {
  if (!token) throw new ApiError(503, 'config_unavailable', 'The DNS provider token is not configured')
  const url = `${BASE}${path}`
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  if (text.length > 256 * 1024) throw new ApiError(502, 'dns_error', 'The DNS provider answered with too much data')
  let payload: CloudflareResponse<T>
  try {
    payload = JSON.parse(text) as CloudflareResponse<T>
  } catch {
    throw new ApiError(502, 'dns_error', `The DNS provider answered HTTP ${response.status}`)
  }
  if (!response.ok || !payload.success) {
    const message = payload.errors?.[0]?.message ?? `HTTP ${response.status}`
    throw new ApiError(response.status === 429 ? 429 : 502, 'dns_error', message.slice(0, 160))
  }
  return payload.result
}

export async function verifyCloudflareToken(token: string): Promise<void> {
  await request<{ id: string; status: string }>('/user/tokens/verify', token)
}

export async function verifyCloudflareConnection(token: string, zoneId: string): Promise<void> {
  await verifyCloudflareToken(token)
  await request<{ id: string; name: string }>(`/zones/${zoneId}`, token)
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
