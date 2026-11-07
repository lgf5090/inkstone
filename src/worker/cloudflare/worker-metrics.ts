/**
 * Per-script Worker metrics, read from Cloudflare's documented `workersInvocationsAdaptive` dataset.
 *
 * The field names and the three queries mirror the reference client's analytics service: one summary,
 * one per-status breakdown, and one series whose dimension is hourly for a one-day window and daily
 * otherwise. CPU is reported both as p50/p99 (quantiles) and as a total in microseconds, because
 * Cloudflare exposes them through two separate shapes and neither can be derived from the other.
 */
import { cfGraphQL, type CloudflareAuth } from './cf-api'

export interface WorkerMetrics {
  requests: number
  errors: number
  subrequests: number
  cpuP50Us: number | null
  cpuP99Us: number | null
  cpuTotalUs: number | null
  statusBreakdown: Array<{ status: string; requests: number }>
  series: Array<{ label: string; requests: number; errors: number }>
}

interface SummaryData {
  viewer?: {
    accounts?: Array<{
      summary?: Array<{
        sum?: { requests?: number; errors?: number; subrequests?: number }
        quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number }
      }>
      byStatus?: Array<{ dimensions?: { status?: string }; sum?: { requests?: number } }>
    }>
  }
}

interface CpuData {
  viewer?: { accounts?: Array<{ summary?: Array<{ sum?: { cpuTimeUs?: number } }> }> }
}

interface SeriesData {
  viewer?: {
    accounts?: Array<{
      series?: Array<{
        dimensions?: { date?: string; datetimeHour?: string }
        sum?: { requests?: number; errors?: number }
      }>
    }>
  }
}

function buildSummaryQuery(): string {
  return `query ($accountTag: string!, $scriptName: string!, $since: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        summary: workersInvocationsAdaptive(
          limit: 100,
          filter: { scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { requests errors subrequests }
          quantiles { cpuTimeP50 cpuTimeP99 }
        }
        byStatus: workersInvocationsAdaptive(
          limit: 100,
          filter: { scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until }
        ) {
          dimensions { status }
          sum { requests }
        }
      }
    }
  }`
}

function buildCpuQuery(): string {
  return `query ($accountTag: string!, $scriptName: string!, $since: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        summary: workersInvocationsAdaptive(
          limit: 100,
          filter: { scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { cpuTimeUs }
        }
      }
    }
  }`
}

function buildSeriesQuery(daily: boolean): string {
  const dimension = daily ? 'date' : 'datetimeHour'
  return `query ($accountTag: string!, $scriptName: string!, $since: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        series: workersInvocationsAdaptive(
          limit: 1000,
          orderBy: [${dimension}_ASC],
          filter: { scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until }
        ) {
          dimensions { ${dimension} }
          sum { requests errors }
        }
      }
    }
  }`
}

export async function readWorkerMetrics(
  auth: CloudflareAuth,
  cfAccountId: string,
  scriptName: string,
  days: number,
  now = new Date(),
): Promise<WorkerMetrics> {
  const until = now
  const since = new Date(until.getTime() - days * 86_400_000)
  const variables = {
    accountTag: cfAccountId,
    scriptName,
    since: since.toISOString(),
    until: until.toISOString(),
  }
  const daily = days > 1
  const [summaryData, cpuData, seriesData] = await Promise.all([
    cfGraphQL<SummaryData>(auth, buildSummaryQuery(), variables),
    cfGraphQL<CpuData>(auth, buildCpuQuery(), variables).catch(() => ({}) as CpuData),
    cfGraphQL<SeriesData>(auth, buildSeriesQuery(daily), variables),
  ])

  const account = summaryData.viewer?.accounts?.[0]
  const rows = account?.summary ?? []
  const requests = rows.reduce((sum, row) => sum + (row.sum?.requests ?? 0), 0)
  const errors = rows.reduce((sum, row) => sum + (row.sum?.errors ?? 0), 0)
  const subrequests = rows.reduce((sum, row) => sum + (row.sum?.subrequests ?? 0), 0)
  const quantiles = rows.find((row) => row.quantiles)?.quantiles
  const cpuTotalUs = (cpuData.viewer?.accounts?.[0]?.summary ?? [])
    .reduce((sum, row) => sum + (row.sum?.cpuTimeUs ?? 0), 0)

  return {
    requests,
    errors,
    subrequests,
    cpuP50Us: typeof quantiles?.cpuTimeP50 === 'number' ? quantiles.cpuTimeP50 : null,
    cpuP99Us: typeof quantiles?.cpuTimeP99 === 'number' ? quantiles.cpuTimeP99 : null,
    cpuTotalUs: cpuTotalUs > 0 ? cpuTotalUs : null,
    statusBreakdown: (account?.byStatus ?? [])
      .map((row) => ({ status: row.dimensions?.status ?? '', requests: row.sum?.requests ?? 0 }))
      .filter((row) => row.status)
      .sort((left, right) => right.requests - left.requests),
    series: (seriesData.viewer?.accounts?.[0]?.series ?? [])
      .map((row) => ({
        label: (daily ? row.dimensions?.date : row.dimensions?.datetimeHour) ?? '',
        requests: row.sum?.requests ?? 0,
        errors: row.sum?.errors ?? 0,
      }))
      .filter((row) => row.label),
  }
}
