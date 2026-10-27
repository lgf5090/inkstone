/**
 * The dashboard's Cloudflare queries.
 *
 * Resource counts are REST listings; usage and traffic are GraphQL. The queries live here so the
 * routes stay about HTTP and so the tests can assert exactly what Cloudflare is asked for.
 *
 * Every usage query is its own request. The reference module combined Workers, KV and D1 into one
 * query, which meant a single unsupported field blanked all three numbers. One product failing must
 * cost only its own number.
 */
import { ApiError } from '../lib/errors'
import {
  cfFetchAll,
  cfFetchRaw,
  cfGraphQL,
  CloudflareApiError,
  upstreamApiError,
  type CloudflareAuth,
} from './cf-api'
import { utcDay, utcDayStart } from './usage'

export interface DashboardZone {
  id: string
  name: string
}

interface ZoneListRow {
  id?: string
  name?: string
  account?: { id?: string }
}

/** Zones the token can see, narrowed to the one Cloudflare account this notebook account names. */
export async function listAccountZones(
  auth: CloudflareAuth,
  cfAccountId: string,
): Promise<DashboardZone[]> {
  const rows = await cfFetchAll<ZoneListRow>(auth, '/zones')
  return rows
    .filter((row) => row.id && row.account?.id === cfAccountId)
    .map((row) => ({ id: row.id as string, name: row.name ?? (row.id as string) }))
}

/**
 * One zone, only if it belongs to the account being asked about.
 *
 * A zone that exists under another account answers 404 rather than 403: the reader asked about this
 * account, and confirming that an id exists elsewhere is a detail they have no use for.
 */
export async function loadZoneForAccount(
  auth: CloudflareAuth,
  cfAccountId: string,
  zoneId: string,
): Promise<DashboardZone> {
  const response = await cfFetchRaw(auth, `/zones/${encodeURIComponent(zoneId)}`)
  const body = await response.text()
  if (response.status === 403 || response.status === 404) {
    throw ApiError.notFound('That domain does not belong to this account')
  }
  if (!response.ok) {
    throw upstreamApiError(new CloudflareApiError({ status: response.status, body }))
  }
  let payload: { result?: { id?: string; name?: string; account?: { id?: string } } }
  try {
    payload = JSON.parse(body) as { result?: { id?: string; name?: string; account?: { id?: string } } }
  } catch {
    throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare answered with something that is not JSON')
  }
  const row = payload.result
  if (!row?.id || row.account?.id !== cfAccountId) {
    throw ApiError.notFound('That domain does not belong to this account')
  }
  return { id: row.id, name: row.name ?? row.id }
}

export interface UsageQuery {
  query: string
  variables: Record<string, string>
}

interface WorkersRequestsData {
  viewer?: {
    accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }> }>
  }
}

interface KvReadsData {
  viewer?: {
    accounts?: Array<{
      kvOperationsAdaptiveGroups?: Array<{
        sum?: { requests?: number }
        dimensions?: { actionType?: string }
      }>
    }>
  }
}

interface D1WritesData {
  viewer?: {
    accounts?: Array<{
      d1AnalyticsAdaptiveGroups?: Array<{ sum?: { writeQueries?: number } }>
    }>
  }
}

interface R2StorageData {
  viewer?: {
    accounts?: Array<{
      r2StorageAdaptiveGroups?: Array<{
        dimensions?: { bucketName?: string; datetime?: string }
        max?: { payloadSize?: number }
      }>
    }>
  }
}

export function workersRequestsQuery(cfAccountId: string, now = new Date()): UsageQuery {
  return {
    query: `query CfWorkersRequestsToday($accountTag: String!, $start: Time!, $end: Time!) {
      viewer { accounts(filter: {accountTag: $accountTag}) {
        workersInvocationsAdaptive(filter: { datetime_geq: $start, datetime_lt: $end }, limit: 10000) {
          sum { requests }
        }
      } }
    }`,
    variables: {
      accountTag: cfAccountId,
      start: utcDayStart(now),
      end: now.toISOString(),
    },
  }
}

export function kvReadsQuery(cfAccountId: string, now = new Date()): UsageQuery {
  return {
    query: `query CfKvReadsToday($accountTag: String!, $dateStart: Date!, $dateEnd: Date!) {
      viewer { accounts(filter: {accountTag: $accountTag}) {
        kvOperationsAdaptiveGroups(filter: { date_geq: $dateStart, date_leq: $dateEnd }, limit: 10000) {
          sum { requests }
          dimensions { actionType }
        }
      } }
    }`,
    variables: { accountTag: cfAccountId, dateStart: utcDay(now), dateEnd: utcDay(now) },
  }
}

export function d1WritesQuery(cfAccountId: string, now = new Date()): UsageQuery {
  return {
    query: `query CfD1WritesToday($accountTag: String!, $dateStart: Date!, $dateEnd: Date!) {
      viewer { accounts(filter: {accountTag: $accountTag}) {
        d1AnalyticsAdaptiveGroups(filter: { date_geq: $dateStart, date_leq: $dateEnd }, limit: 10000) {
          sum { writeQueries }
        }
      } }
    }`,
    variables: { accountTag: cfAccountId, dateStart: utcDay(now), dateEnd: utcDay(now) },
  }
}

export function r2StorageQuery(cfAccountId: string, now = new Date()): UsageQuery {
  const since = new Date(now.getTime() - 7 * 86_400_000)
  return {
    query: `query CfR2Storage($accountTag: String!, $since: Time!) {
      viewer { accounts(filter: {accountTag: $accountTag}) {
        r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $since }, orderBy: [datetime_DESC]) {
          dimensions { bucketName datetime }
          max { payloadSize }
        }
      } }
    }`,
    variables: { accountTag: cfAccountId, since: since.toISOString() },
  }
}

export function parseWorkersRequests(data: WorkersRequestsData): number {
  return (data.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [])
    .reduce((sum, group) => sum + (group.sum?.requests ?? 0), 0)
}

/** Reads only count against the KV allowance; writes have their own line and are not summed here. */
export function parseKvReads(data: KvReadsData): number {
  return (data.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups ?? [])
    .reduce((sum, group) => (
      sum + (group.dimensions?.actionType === 'read' ? group.sum?.requests ?? 0 : 0)
    ), 0)
}

export function parseD1Writes(data: D1WritesData): number {
  return (data.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [])
    .reduce((sum, group) => sum + (group.sum?.writeQueries ?? 0), 0)
}

/** The latest snapshot per bucket, summed: an R2 bucket reports its size on every sampled day. */
export function parseR2Storage(data: R2StorageData): number {
  const groups = [...(data.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [])]
    .sort((left, right) => (
      (right.dimensions?.datetime ?? '').localeCompare(left.dimensions?.datetime ?? '')
    ))
  const seen = new Set<string>()
  let total = 0
  for (const group of groups) {
    const bucket = group.dimensions?.bucketName
    if (!bucket || seen.has(bucket)) continue
    seen.add(bucket)
    total += group.max?.payloadSize ?? 0
  }
  return total
}

export async function fetchWorkersRequestsToday(
  auth: CloudflareAuth,
  cfAccountId: string,
  now = new Date(),
): Promise<number> {
  const query = workersRequestsQuery(cfAccountId, now)
  return parseWorkersRequests(await cfGraphQL<WorkersRequestsData>(auth, query.query, query.variables))
}

export async function fetchKvReadsToday(
  auth: CloudflareAuth,
  cfAccountId: string,
  now = new Date(),
): Promise<number> {
  const query = kvReadsQuery(cfAccountId, now)
  return parseKvReads(await cfGraphQL<KvReadsData>(auth, query.query, query.variables))
}

export async function fetchD1WritesToday(
  auth: CloudflareAuth,
  cfAccountId: string,
  now = new Date(),
): Promise<number> {
  const query = d1WritesQuery(cfAccountId, now)
  return parseD1Writes(await cfGraphQL<D1WritesData>(auth, query.query, query.variables))
}

export async function fetchR2Storage(
  auth: CloudflareAuth,
  cfAccountId: string,
  now = new Date(),
): Promise<number> {
  const query = r2StorageQuery(cfAccountId, now)
  return parseR2Storage(await cfGraphQL<R2StorageData>(auth, query.query, query.variables))
}

export type TrafficGranularity = 'hour' | 'day'

export interface TrafficGroup {
  dimensions?: { datetimeHour?: string; date?: string }
  sum?: { requests?: number; pageViews?: number; edgeResponseBytes?: number }
  uniq?: { uniques?: number }
}

export interface TrafficQuery extends UsageQuery {
  granularity: TrafficGranularity
}

export interface TrafficSeries {
  requests: number[]
  visitors: number[]
  pageViews: number[]
  bytes: number[]
}

export interface TrafficSeriesResponse {
  labels: string[]
  series: TrafficSeries
}

/**
 * One day is read by the hour and anything longer by the day; the source module switched the same
 * way, because an hourly series over a month is a line nobody can read.
 */
export function buildTrafficQuery(zoneId: string, days: number, now = new Date()): TrafficQuery {
  const since = new Date(now.getTime() - days * 86_400_000)
  if (days <= 1) {
    return {
      query: `query CfTraffic24h($zoneTag: String!, $since: Time!, $until: Time!) {
        viewer { zones(filter: {zoneTag: $zoneTag}) {
          httpRequestsAdaptiveGroups(
            limit: 48
            filter: { datetime_geq: $since, datetime_lt: $until }
            orderBy: [datetimeHour_ASC]
          ) {
            dimensions { datetimeHour }
            sum { requests pageViews edgeResponseBytes }
            uniq { uniques }
          }
        } }
      }`,
      variables: { zoneTag: zoneId, since: since.toISOString(), until: now.toISOString() },
      granularity: 'hour',
    }
  }
  return {
    query: `query CfTrafficDays($zoneTag: String!, $since: Time!, $until: Time!) {
      viewer { zones(filter: {zoneTag: $zoneTag}) {
        httpRequestsAdaptiveGroups(
          limit: ${days + 2}
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [date_ASC]
        ) {
          dimensions { date }
          sum { requests pageViews edgeResponseBytes }
          uniq { uniques }
        }
      } }
    }`,
    variables: { zoneTag: zoneId, since: since.toISOString(), until: now.toISOString() },
    granularity: 'day',
  }
}

/** Groups become parallel arrays because that is the shape `LineChart` reads. */
export function mapTrafficGroups(
  granularity: TrafficGranularity,
  groups: readonly TrafficGroup[],
): TrafficSeriesResponse {
  const raw = granularity === 'hour'
    ? (group: TrafficGroup) => group.dimensions?.datetimeHour ?? ''
    : (group: TrafficGroup) => group.dimensions?.date ?? ''
  const sorted = [...groups].sort((left, right) => raw(left).localeCompare(raw(right)))

  const labels = sorted.map((group) => {
    const value = raw(group)
    if (granularity === 'hour') {
      return /T(\d{2}:\d{2})/.exec(value)?.[1] ?? value
    }
    return value.slice(5)
  })
  return {
    labels,
    series: {
      requests: sorted.map((group) => group.sum?.requests ?? 0),
      visitors: sorted.map((group) => group.uniq?.uniques ?? 0),
      pageViews: sorted.map((group) => group.sum?.pageViews ?? 0),
      bytes: sorted.map((group) => group.sum?.edgeResponseBytes ?? 0),
    },
  }
}
