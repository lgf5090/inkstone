/**
 * `/api/cloudflare/dashboard` — the account's resources, today's usage and a zone's traffic.
 *
 * A count that Cloudflare would not answer is `null`, not zero: "no number" is a fact the screen can
 * show honestly, while a zero is a claim that the account has none. The same rule applies to each
 * usage figure, which is why their queries are issued separately.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { loadAccount } from '../../cloudflare/accounts'
import { cfFetch, cfFetchAll, cfGraphQL, type CloudflareAuth } from '../../cloudflare/cf-api'
import {
  buildTrafficQuery,
  fetchD1WritesToday,
  fetchKvReadsToday,
  fetchR2Storage,
  fetchWorkersRequestsToday,
  listAccountZones,
  loadZoneForAccount,
  mapTrafficGroups,
  type DashboardZone,
  type TrafficDataset,
  type TrafficGroup,
} from '../../cloudflare/dashboard'

export const dashboardRouter = new Hono<AppBindings>()

export type ResourceCountKey = 'domains' | 'workers' | 'pages' | 'dns' | 'r2' | 'kv' | 'd1'
export type UsageKey = 'workers_requests' | 'kv_reads' | 'd1_writes' | 'r2_storage'

export interface ResourceCount {
  key: ResourceCountKey
  count: number | null
}

export interface ResourceUsage {
  key: UsageKey
  value: number | null
  limit: number
  isBytes: boolean
}

const USAGE_LIMITS: Record<UsageKey, { limit: number; isBytes: boolean }> = {
  workers_requests: { limit: 100_000, isBytes: false },
  kv_reads: { limit: 100_000, isBytes: false },
  d1_writes: { limit: 100_000, isBytes: false },
  r2_storage: { limit: 10 * 1024 * 1024 * 1024, isBytes: true },
}

/** Cloudflare's DNS record count needs one call per zone; beyond this the dashboard shows no total. */
const MAX_DNS_ZONES = 50

async function attempt<T>(
  label: string,
  accountName: string,
  task: () => Promise<T>,
): Promise<T | null> {
  try {
    return await task()
  } catch (error) {
    console.warn(
      `[inkstone] Cloudflare ${label} failed for ${accountName}:`,
      error instanceof Error ? error.message : String(error),
    )
    return null
  }
}

async function loadAccountForRequest(c: Context<AppBindings>) {
  const accountId = (c.req.query('accountId') ?? '').trim()
  if (!accountId) throw ApiError.badRequest('accountId is required')
  const loaded = await loadAccount(c.env, c.get('userId'), accountId)
  const cfAccountId = loaded.row.cf_account_id?.trim()
  if (!cfAccountId) {
    throw new ApiError(400, 'cloudflare_not_configured', 'This account has no Cloudflare account id')
  }
  return { ...loaded, cfAccountId }
}

async function listR2Buckets(auth: CloudflareAuth, cfAccountId: string): Promise<unknown[]> {
  const body = await cfFetch<{ result?: unknown[] | { buckets?: unknown[] } }>(
    auth,
    `/accounts/${cfAccountId}/r2/buckets?per_page=100`,
  )
  if (Array.isArray(body.result)) return body.result
  return body.result?.buckets ?? []
}

async function countDnsRecords(
  auth: CloudflareAuth,
  zones: readonly DashboardZone[],
  accountName: string,
): Promise<number | null> {
  if (zones.length === 0) return 0
  if (zones.length > MAX_DNS_ZONES) {
    console.warn(
      `[inkstone] DNS record count skipped for ${accountName}: ${zones.length} zones exceeds ${MAX_DNS_ZONES}`,
    )
    return null
  }
  const counts = await Promise.all(zones.map(async (zone) => {
    try {
      const body = await cfFetch<{ result_info?: { total_count?: number } }>(
        auth,
        `/zones/${encodeURIComponent(zone.id)}/dns_records?per_page=1`,
      )
      return body.result_info?.total_count ?? 0
    } catch (error) {
      console.warn(
        `[inkstone] DNS record count failed for ${accountName}/${zone.name}:`,
        error instanceof Error ? error.message : String(error),
      )
      return null
    }
  }))
  if (counts.some((count) => count === null)) return null
  return counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
}

dashboardRouter.get('/resources', async (c) => {
  const { row, auth, cfAccountId } = await loadAccountForRequest(c)
  const now = new Date()

  const [zones, workers, pages, r2, kv, d1] = await Promise.all([
    attempt('zone list', row.name, () => listAccountZones(auth, cfAccountId)),
    attempt('Worker list', row.name, () => cfFetchAll<unknown>(auth, `/accounts/${cfAccountId}/workers/scripts`)),
    attempt('Pages list', row.name, () => cfFetchAll<unknown>(auth, `/accounts/${cfAccountId}/pages/projects`)),
    attempt('R2 list', row.name, () => listR2Buckets(auth, cfAccountId)),
    attempt('KV list', row.name, () => cfFetchAll<unknown>(auth, `/accounts/${cfAccountId}/storage/kv/namespaces`)),
    attempt('D1 list', row.name, () => cfFetchAll<unknown>(auth, `/accounts/${cfAccountId}/d1/database`)),
  ])
  const dnsCount = zones === null ? null : await countDnsRecords(auth, zones, row.name)

  const [workersRequests, kvReads, d1Writes, r2Storage] = await Promise.all([
    attempt('Workers usage', row.name, () => fetchWorkersRequestsToday(auth, cfAccountId, now)),
    attempt('KV usage', row.name, () => fetchKvReadsToday(auth, cfAccountId, now)),
    attempt('D1 usage', row.name, () => fetchD1WritesToday(auth, cfAccountId, now)),
    attempt('R2 usage', row.name, () => fetchR2Storage(auth, cfAccountId, now)),
  ])
  const values: Record<UsageKey, number | null> = {
    workers_requests: workersRequests,
    kv_reads: kvReads,
    d1_writes: d1Writes,
    r2_storage: r2Storage,
  }

  const counts: ResourceCount[] = [
    { key: 'domains', count: zones?.length ?? null },
    { key: 'workers', count: workers?.length ?? null },
    { key: 'pages', count: pages?.length ?? null },
    { key: 'dns', count: dnsCount },
    { key: 'r2', count: r2?.length ?? null },
    { key: 'kv', count: kv?.length ?? null },
    { key: 'd1', count: d1?.length ?? null },
  ]
  const usage: ResourceUsage[] = (Object.keys(USAGE_LIMITS) as UsageKey[]).map((key) => ({
    key,
    value: values[key],
    ...USAGE_LIMITS[key],
  }))
  return c.json({ accountId: row.id, counts, usage })
})

dashboardRouter.get('/zones', async (c) => {
  const { auth, cfAccountId } = await loadAccountForRequest(c)
  return c.json({ zones: await listAccountZones(auth, cfAccountId) })
})

dashboardRouter.get('/traffic', async (c) => {
  const { row, auth, cfAccountId } = await loadAccountForRequest(c)
  const zoneId = (c.req.query('zoneId') ?? '').trim()
  if (!zoneId) throw ApiError.badRequest('zoneId is required')
  const daysRaw = c.req.query('days')
  const days = Number(daysRaw ?? 14)
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw ApiError.badRequest('days must be a whole number between 1 and 90')
  }

  const zone = await loadZoneForAccount(auth, cfAccountId, zoneId)
  const query = buildTrafficQuery(zone.id, days, new Date())
  const data = await cfGraphQL<{
    viewer?: { zones?: Array<Partial<Record<TrafficDataset, TrafficGroup[]>>> }
  }>(auth, query.query, query.variables)
  const points = mapTrafficGroups(
    query.granularity,
    data.viewer?.zones?.[0]?.[query.dataset] ?? [],
  )
  return c.json({
    zoneId: zone.id,
    zoneName: zone.name,
    accountId: row.id,
    granularity: query.granularity,
    labels: points.labels,
    series: points.series,
  })
})
