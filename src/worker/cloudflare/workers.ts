/**
 * Workers and Pages, read the way the screen needs them.
 *
 * One Cloudflare account is one upstream fan-out: a script list and a Pages project list, each of
 * which may fail on its own. A failed half is logged and left out, because an account with a revoked
 * Pages scope still has usable Workers, and a screen that shows nothing tells the reader less than one
 * that shows the half that answered.
 */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import {
  accountHasFeature,
  loadActiveAccounts,
  loadAccount,
  type LoadedAccount,
} from './accounts'
import { cfFetch } from './cf-api'
import { getWorkersUsageToday, type WorkersUsage } from './usage'

export type WorkerKind = 'worker' | 'pages'

export interface WorkerListRow {
  type: WorkerKind
  name: string
  status: string
  accountId: string
  accountName: string
  createdOn: string | null
  modifiedOn: string | null
}

export interface WorkerSummaryRow extends WorkersUsage {
  accountId: string
  accountName: string
  workerCount: number
  pagesCount: number
}

export interface WorkerUsageRow extends WorkersUsage {
  accountId: string
  accountName: string
}

const WORKER_NAME_RE = /^[a-z0-9-]{1,63}$/
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SECRET_NAME_RE = /^[A-Za-z0-9_]{1,255}$/
const BINDING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/** A name ends up in a URL path; the alphabet comes from Cloudflare's own worker-name rule. */
export function assertWorkerName(value: string): string {
  if (!WORKER_NAME_RE.test(value)) {
    throw ApiError.badRequest('Worker and Pages names must be 1-63 lowercase letters, digits or hyphens')
  }
  return value
}

export function assertSafeId(value: string, label: string): string {
  if (!SAFE_ID_RE.test(value)) throw ApiError.badRequest(`Invalid ${label}`)
  return value
}

export function assertSecretName(value: string): string {
  if (!SECRET_NAME_RE.test(value)) throw ApiError.badRequest('Invalid secret name')
  return value
}

export function assertBindingName(value: string): string {
  if (!BINDING_NAME_RE.test(value)) throw ApiError.badRequest(`Invalid binding name: ${value}`)
  return value
}

export function assertHostname(value: string): string {
  if (!HOSTNAME_RE.test(value)) throw ApiError.badRequest('Invalid hostname')
  return value
}

export function assertRoutePattern(value: string): string {
  if (!value || value.length > 500 || /[\s\r\n]/.test(value)) {
    throw ApiError.badRequest('Invalid route pattern')
  }
  return value
}

export function assertCronExpression(value: string): string {
  const parts = value.trim().split(/\s+/)
  if (parts.length !== 5 || value.length > 100 || /[^\d*/,\-?LW# ]/.test(value)) {
    throw ApiError.badRequest('Invalid cron expression')
  }
  return parts.join(' ')
}

/** The account row plus its decrypted credential, or 404 when it is not this reader's. */
export async function loadWorkerAccount(
  env: Env,
  userId: string,
  accountId: string,
): Promise<LoadedAccount> {
  const account = await loadAccount(env, userId, accountId)
  if (!account.row.cf_account_id) {
    throw ApiError.badRequest('That account has no Cloudflare account id yet')
  }
  return account
}

export function scriptPath(account: LoadedAccount, name: string): string {
  return `/accounts/${encodeURIComponent(account.row.cf_account_id ?? '')}/workers/scripts/${encodeURIComponent(name)}`
}

function pageTimestamp(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function pagesModified(project: Record<string, unknown>): string | null {
  const latest = project.latest_deployment
  if (latest && typeof latest === 'object') {
    const deployment = latest as Record<string, unknown>
    return pageTimestamp(deployment.modified_on) ?? pageTimestamp(deployment.created_on)
  }
  return pageTimestamp(project.modified_on) ?? pageTimestamp(project.created_on)
}

/**
 * Every Worker script and Pages project this reader can see.
 *
 * With an account id the list is that one account (and an account belonging to somebody else is a
 * 404); without one it is every active account with the Workers feature on.
 */
export async function listWorkers(
  env: Env,
  userId: string,
  accountId?: string | null,
): Promise<WorkerListRow[]> {
  const accounts = accountId
    ? [await loadWorkerAccount(env, userId, accountId)]
    : (await loadActiveAccounts(env, userId)).filter(({ row }) => accountHasFeature(row, 'workers'))

  const perAccount = await Promise.all(accounts.map(async ({ row, auth }) => {
    const cfId = row.cf_account_id ?? ''
    const [scripts, projects] = await Promise.allSettled([
      cfFetch<{ result?: Array<Record<string, unknown>> }>(
        auth,
        `/accounts/${encodeURIComponent(cfId)}/workers/scripts`,
      ),
      cfFetch<{ result?: Array<Record<string, unknown>> }>(
        auth,
        `/accounts/${encodeURIComponent(cfId)}/pages/projects`,
      ),
    ])

    const rows: WorkerListRow[] = []
    if (scripts.status === 'fulfilled') {
      for (const script of scripts.value.result ?? []) {
        rows.push({
          type: 'worker',
          name: String(script.id ?? ''),
          status: 'deployed',
          accountId: row.id,
          accountName: row.name,
          createdOn: pageTimestamp(script.created_on),
          modifiedOn: pageTimestamp(script.modified_on) ?? pageTimestamp(script.created_on),
        })
      }
    } else {
      console.warn(`[inkstone] Worker scripts could not be listed for ${row.name}:`, errorText(scripts.reason))
    }
    if (projects.status === 'fulfilled') {
      for (const project of projects.value.result ?? []) {
        rows.push({
          type: 'pages',
          name: String(project.name ?? project.id ?? ''),
          status: 'active',
          accountId: row.id,
          accountName: row.name,
          createdOn: pageTimestamp(project.created_on),
          modifiedOn: pagesModified(project),
        })
      }
    } else {
      console.warn(`[inkstone] Pages projects could not be listed for ${row.name}:`, errorText(projects.reason))
    }
    return rows
  }))
  return perAccount.flat()
}

/** Per-account totals: what the cards show above the table. One failing account is still a card. */
export async function workerSummary(env: Env, userId: string): Promise<WorkerSummaryRow[]> {
  const accounts = (await loadActiveAccounts(env, userId))
    .filter(({ row }) => accountHasFeature(row, 'workers'))

  return await Promise.all(accounts.map(async ({ row, auth }) => {
    const cfId = row.cf_account_id ?? ''
    const [usage, scripts, projects] = await Promise.allSettled([
      getWorkersUsageToday(auth, row.cf_account_id),
      cfFetch<{ result?: unknown[] }>(auth, `/accounts/${encodeURIComponent(cfId)}/workers/scripts`),
      cfFetch<{ result?: unknown[] }>(auth, `/accounts/${encodeURIComponent(cfId)}/pages/projects`),
    ])
    const numbers = usage.status === 'fulfilled'
      ? usage.value
      : { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 }
    return {
      accountId: row.id,
      accountName: row.name,
      ...numbers,
      workerCount: scripts.status === 'fulfilled' ? (scripts.value.result ?? []).length : 0,
      pagesCount: projects.status === 'fulfilled' ? (projects.value.result ?? []).length : 0,
    }
  }))
}

/** Today's usage per account. A failed query is left out rather than shown as zero. */
export async function workersUsage(env: Env, userId: string): Promise<WorkerUsageRow[]> {
  const accounts = (await loadActiveAccounts(env, userId))
    .filter(({ row }) => accountHasFeature(row, 'workers'))
  const results = await Promise.allSettled(accounts.map(async ({ row, auth }) => ({
    accountId: row.id,
    accountName: row.name,
    ...await getWorkersUsageToday(auth, row.cf_account_id),
  })))
  return results
    .filter((result): result is PromiseFulfilledResult<WorkerUsageRow> => result.status === 'fulfilled')
    .map((result) => result.value)
}

export interface MultipartPart {
  name: string
  contentType: string
  bytes: Uint8Array
}

const CRLF_CRLF = new Uint8Array([13, 10, 13, 10])

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from
  outer: for (let index = from; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer
    }
    return index
  }
  return -1
}

/**
 * The parts of a multipart body, without Node's Buffer or a streaming parser.
 *
 * Cloudflare's script download is multipart for module workers. The body is small enough for the
 * Worker's memory (scripts are capped well below it), so one pass over the bytes is the whole job.
 */
export function parseMultipart(payload: ArrayBuffer, contentType: string): MultipartPart[] | null {
  if (!/multipart\/form-data/i.test(contentType)) return null
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim()
  if (!boundary) return null
  const delimiter = new TextEncoder().encode(`--${boundary}`)
  const bytes = new Uint8Array(payload)
  const parts: MultipartPart[] = []
  let cursor = indexOfBytes(bytes, delimiter, 0)
  while (cursor !== -1) {
    let start = cursor + delimiter.length
    if (bytes[start] === 13 && bytes[start + 1] === 10) start += 2
    const next = indexOfBytes(bytes, delimiter, start)
    let end = next === -1 ? bytes.length : next
    if (end >= 2 && bytes[end - 2] === 13 && bytes[end - 1] === 10) end -= 2
    const segment = bytes.subarray(start, end)
    const headerEnd = indexOfBytes(segment, CRLF_CRLF, 0)
    if (headerEnd >= 0) {
      const header = new TextDecoder().decode(segment.subarray(0, headerEnd))
      const name = /name="([^"]+)"/i.exec(header)?.[1]
      if (name) {
        parts.push({
          name,
          contentType: /content-type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() ?? '',
          bytes: segment.subarray(headerEnd + 4),
        })
      }
    }
    if (next === -1) break
    cursor = next
  }
  return parts
}

/** The entry module of a script download, preferring an explicit name, then the conventional ones. */
export function pickEntryModule(parts: readonly MultipartPart[], preferred?: string): MultipartPart | null {
  const modules = parts.filter((part) => /\.(?:m?js|wasm)$/i.test(part.name))
  if (preferred) {
    const exact = modules.find((part) => part.name === preferred)
    if (exact) return exact
  }
  return modules.find((part) => part.name === 'worker.js')
    ?? modules.find((part) => part.name === 'index.js')
    ?? modules.find((part) => !part.name.startsWith('assets/'))
    ?? null
}

/** The script text of a module download, or null when there is no JavaScript part. */
export function extractWorkerSource(payload: ArrayBuffer, contentType: string): string | null {
  const parts = parseMultipart(payload, contentType)
  if (!parts) return null
  const entry = pickEntryModule(parts)
  return entry ? new TextDecoder().decode(entry.bytes) : null
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Cloudflare refused the request'
}
