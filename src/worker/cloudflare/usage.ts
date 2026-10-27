/**
 * Today's usage, read from Cloudflare's analytics rather than guessed from request counts.
 *
 * Both queries are the reference module's own: Workers/Pagess invocations and AI neurons, filtered to
 * one Cloudflare account and the current UTC day. The screens treat a failed query as "no number",
 * which is why the workers query answers zeros on failure while the AI query throws — the AI tab has
 * somewhere to show the failure, the resource cards only have a number slot.
 */
import type { CloudflareAuth } from './cf-api'
import { cfGraphQL } from './cf-api'

export interface WorkersUsage {
  requests: number
  errors: number
  subrequests: number
  cpuTimeMs: number
}

export interface AiUsage {
  totalNeurons: number
  models: Array<{ modelId: string; neurons: number; requests: number }>
}

export function utcDayStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export async function getWorkersUsageToday(auth: CloudflareAuth, cfAccountId: string | null): Promise<WorkersUsage> {
  if (!cfAccountId) return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 }
  const now = new Date()
  try {
    const data = await cfGraphQL<{
      viewer?: {
        accounts?: Array<{
          workers?: Array<{ sum?: { requests?: number; errors?: number; subrequests?: number; cpuTimeUs?: number } }>
          pages?: Array<{ sum?: { requests?: number; errors?: number } }>
        }>
      }
    }>(
      auth,
      `query CfWorkersUsage($accountTag: string!, $datetimeStart: Time!, $datetimeEnd: Time!, $todayDate: Date!) {
        viewer {
          accounts(filter: {accountTag: $accountTag}) {
            workers: workersInvocationsAdaptive(
              filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }
              limit: 10000
            ) { sum { requests errors subrequests cpuTimeUs } }
            pages: pagesFunctionsInvocationsAdaptiveGroups(
              filter: { date: $todayDate }
              limit: 1
            ) { sum { requests errors } }
          }
        }
      }`,
      {
        accountTag: cfAccountId,
        datetimeStart: utcDayStart(now),
        datetimeEnd: now.toISOString(),
        todayDate: utcDay(now),
      },
    )
    const account = data.viewer?.accounts?.[0]
    let requests = 0
    let errors = 0
    let subrequests = 0
    let cpuUs = 0
    for (const record of account?.workers ?? []) {
      requests += record.sum?.requests ?? 0
      errors += record.sum?.errors ?? 0
      subrequests += record.sum?.subrequests ?? 0
      cpuUs += record.sum?.cpuTimeUs ?? 0
    }
    for (const record of account?.pages ?? []) {
      requests += record.sum?.requests ?? 0
      errors += record.sum?.errors ?? 0
    }
    return { requests, errors, subrequests, cpuTimeMs: Math.round(cpuUs / 1000) }
  } catch (error) {
    console.warn('[inkstone] Workers usage query failed:', (error as Error)?.message)
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 }
  }
}

export async function getAiUsageToday(auth: CloudflareAuth, cfAccountId: string | null): Promise<AiUsage> {
  if (!cfAccountId) throw new Error('The account has no Cloudflare account id')
  const now = new Date()
  const data = await cfGraphQL<{
    viewer?: {
      accounts?: Array<{
        total?: Array<{ sum?: { totalNeurons?: number } }>
        byModel?: Array<{ count?: number; sum?: { totalNeurons?: number }; dimensions?: { modelId?: string } }>
      }>
    }
  }>(
    auth,
    `query CfAiUsage($accountTag: string!, $start: Time!, $end: Time!) {
      viewer { accounts(filter: {accountTag: $accountTag}) {
        total: aiInferenceAdaptiveGroups(filter: { datetime_geq: $start, datetime_leq: $end }, limit: 1) {
          sum { totalNeurons }
        }
        byModel: aiInferenceAdaptiveGroups(
          filter: { datetime_geq: $start, datetime_leq: $end }
          limit: 100
          orderBy: [sum_totalNeurons_DESC]
        ) {
          count
          sum { totalNeurons }
          dimensions { modelId }
        }
      } }
    }`,
    { accountTag: cfAccountId, start: utcDayStart(now), end: now.toISOString() },
  )
  const account = data.viewer?.accounts?.[0]
  const totalNeurons = account?.total?.[0]?.sum?.totalNeurons ?? 0
  const models = (account?.byModel ?? [])
    .filter((row) => row.dimensions?.modelId)
    .map((row) => ({
      modelId: row.dimensions?.modelId as string,
      neurons: row.sum?.totalNeurons ?? 0,
      requests: row.count ?? 0,
    }))
  // The total is left unrounded: the model rows below are not rounded either, and a share taken
  // against a rounded whole can exceed 100%.
  return { totalNeurons, models }
}
