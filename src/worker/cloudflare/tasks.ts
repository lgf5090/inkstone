/**
 * Scheduled Cloudflare maintenance: four task kinds a reader can put on a cron.
 *
 * The reference module wrote the rows and never ran them; here the platform's every-minute trigger
 * calls `runDueCloudflareTasks`, which finds the tasks whose expression includes this minute and runs
 * them one by one. Every run is recorded, including a refusal — a task that silently stops is worse
 * than one that fails loudly.
 *
 * Each executor is deliberately bounded: a Worker request (and the cron tick) has a finite budget, so
 * a cleanup deletes at most a batch and the next fire continues. The bound is part of the contract,
 * and the detail line says what was done.
 */
import type { Env } from '../env'
import { newId } from '../lib/id'
import { cfFetch, cfFetchRaw, upstreamApiError, type CloudflareAuth } from './cf-api'
import { loadAccount } from './accounts'
import { createAuditLog } from './audit'
import { cronMatches, isValidCron } from './cron'
import { quotaSummary, syncQuotaFromCloudflare } from './quota'
import { utcDay } from './usage'

export const TASK_TYPES = ['quota_report', 'kv_cleanup', 'd1_backup', 'r2_cleanup'] as const
export type CloudflareTaskType = typeof TASK_TYPES[number]

export interface CloudflareTask {
  id: string
  user_id: string
  name: string
  type: CloudflareTaskType
  cron: string
  config: string | null
  enabled: number
  created_at: number
  updated_at: number
}

export interface TaskConfig {
  account_id?: string
  namespace_id?: string
  database_id?: string
  bucket?: string
  key_prefix?: string
  prefix?: string
  max_age_days?: number
}

export interface TaskExecution {
  id: string
  task_id: string
  status: 'running' | 'success' | 'error'
  detail: string | null
  started_at: number
  finished_at: number | null
}

const CLEANUP_BATCH = 100
const KV_BATCH = 1000
const BACKUP_ROW_LIMIT = 5_000
const BACKUP_TABLE_LIMIT = 20

function parseConfig(task: CloudflareTask): TaskConfig {
  if (!task.config) return {}
  try {
    const parsed: unknown = JSON.parse(task.config)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as TaskConfig : {}
  } catch {
    return {}
  }
}

function requireString(config: TaskConfig, key: keyof TaskConfig, message: string): string {
  const value = config[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(message)
  return value.trim()
}

export async function listTasks(env: Env, userId: string): Promise<CloudflareTask[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM cloudflare_scheduled_task WHERE user_id = ? ORDER BY created_at DESC, id DESC',
  )
    .bind(userId)
    .all<CloudflareTask>()
  return rows.results ?? []
}

export async function getTask(env: Env, userId: string, id: string): Promise<CloudflareTask | null> {
  return await env.DB.prepare('SELECT * FROM cloudflare_scheduled_task WHERE user_id = ? AND id = ?')
    .bind(userId, id)
    .first<CloudflareTask>()
}

export async function createTask(
  env: Env,
  userId: string,
  input: { name: string; type: string; cron: string; config?: unknown },
): Promise<string> {
  const name = input.name.trim()
  if (!name) throw new Error('A task needs a name')
  if (!TASK_TYPES.includes(input.type as CloudflareTaskType)) throw new Error(`Unknown task type: ${input.type}`)
  if (!isValidCron(input.cron)) throw new Error(`Invalid cron expression: ${input.cron}`)
  const id = newId()
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO cloudflare_scheduled_task (id, user_id, name, type, cron, config, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(id, userId, name, input.type, input.cron.trim(), input.config === undefined ? null : JSON.stringify(input.config), now, now)
    .run()
  return id
}

export async function updateTask(
  env: Env,
  userId: string,
  id: string,
  patch: { name?: string; cron?: string; config?: unknown; enabled?: boolean },
): Promise<void> {
  const task = await getTask(env, userId, id)
  if (!task) throw new Error('That task does not exist')
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('A task needs a name')
    sets.push('name = ?')
    values.push(name)
  }
  if (patch.cron !== undefined) {
    if (!isValidCron(patch.cron)) throw new Error(`Invalid cron expression: ${patch.cron}`)
    sets.push('cron = ?')
    values.push(patch.cron.trim())
  }
  if (patch.config !== undefined) {
    sets.push('config = ?')
    values.push(JSON.stringify(patch.config))
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    values.push(patch.enabled ? 1 : 0)
  }
  if (sets.length === 0) return
  sets.push('updated_at = ?')
  values.push(Date.now(), userId, id)
  await env.DB.prepare(`UPDATE cloudflare_scheduled_task SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`)
    .bind(...values)
    .run()
}

export async function deleteTask(env: Env, userId: string, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cloudflare_task_execution WHERE user_id = ? AND task_id = ?').bind(userId, id),
    env.DB.prepare('DELETE FROM cloudflare_scheduled_task WHERE user_id = ? AND id = ?').bind(userId, id),
  ])
}

export async function listExecutions(env: Env, userId: string, taskId: string, limit = 20): Promise<TaskExecution[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM cloudflare_task_execution WHERE user_id = ? AND task_id = ? ORDER BY started_at DESC, id DESC LIMIT ?',
  )
    .bind(userId, taskId, Math.min(Math.max(limit, 1), 200))
    .all<TaskExecution>()
  return rows.results ?? []
}

async function beginExecution(env: Env, task: CloudflareTask): Promise<string> {
  const id = newId()
  await env.DB.prepare(
    `INSERT INTO cloudflare_task_execution (id, user_id, task_id, status, detail, started_at)
     VALUES (?, ?, ?, 'running', NULL, ?)`,
  )
    .bind(id, task.user_id, task.id, Date.now())
    .run()
  return id
}

async function finishExecution(env: Env, executionId: string, status: 'success' | 'error', detail: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE cloudflare_task_execution SET status = ?, detail = ?, finished_at = ? WHERE id = ?',
  )
    .bind(status, detail.slice(0, 2_000), Date.now(), executionId)
    .run()
}

export async function runTaskNow(env: Env, userId: string, id: string): Promise<{ status: 'success' | 'error'; detail: string }> {
  const task = await getTask(env, userId, id)
  if (!task) throw new Error('That task does not exist')
  return await executeTask(env, task)
}

export async function executeTask(env: Env, task: CloudflareTask): Promise<{ status: 'success' | 'error'; detail: string }> {
  const executionId = await beginExecution(env, task)
  try {
    const detail = await runExecutor(env, task)
    await finishExecution(env, executionId, 'success', detail)
    await createAuditLog(env, task.user_id, null, 'task_run', task.name, detail, 'success')
    return { status: 'success', detail }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    await finishExecution(env, executionId, 'error', detail)
    await createAuditLog(env, task.user_id, null, 'task_run', task.name, detail, 'error')
    return { status: 'error', detail }
  }
}

async function runExecutor(env: Env, task: CloudflareTask): Promise<string> {
  const config = parseConfig(task)
  switch (task.type) {
    case 'quota_report': {
      await syncQuotaFromCloudflare(env, task.user_id)
      const accounts = await quotaSummary(env, task.user_id)
      const resources = accounts.reduce((sum, account) => sum + account.resources.length, 0)
      return `Reported ${resources} allowances across ${accounts.length} accounts`
    }
    case 'kv_cleanup': return await runKvCleanup(env, task, config)
    case 'd1_backup': return await runD1Backup(env, task, config)
    case 'r2_cleanup': return await runR2Cleanup(env, task, config)
    default: throw new Error(`Unknown task type: ${String(task.type)}`)
  }
}

async function runKvCleanup(env: Env, task: CloudflareTask, config: TaskConfig): Promise<string> {
  const accountId = requireString(config, 'account_id', 'Pick the account to clean')
  const namespaceId = requireString(config, 'namespace_id', 'Pick the KV namespace to clean')
  // The KV listing carries no timestamp, so age cannot decide this batch; the prefix is the only
  // safe selector, and it is required so a misconfigured task cannot empty the namespace.
  const prefix = requireString(config, 'key_prefix', 'A key prefix is required so a task cannot empty a namespace')
  const { row, auth } = await loadAccount(env, task.user_id, accountId)
  if (!row.cf_account_id) throw new Error('That account has no Cloudflare account id')
  const listed = await cfFetch<{ result?: Array<{ name?: string }> }>(
    auth,
    `/accounts/${row.cf_account_id}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/keys?limit=${KV_BATCH}&prefix=${encodeURIComponent(prefix)}`,
  )
  const keys = (listed.result ?? []).map((entry) => entry.name).filter((name): name is string => Boolean(name))
  if (keys.length === 0) return `No keys under ${prefix}`
  await cfFetch(
    auth,
    `/accounts/${row.cf_account_id}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/bulk`,
    { method: 'DELETE', body: keys },
  )
  return `Deleted ${keys.length} keys under ${prefix}`
}

async function runD1Backup(env: Env, task: CloudflareTask, config: TaskConfig): Promise<string> {
  const accountId = requireString(config, 'account_id', 'Pick the account to back up')
  const databaseId = requireString(config, 'database_id', 'Pick the D1 database to back up')
  const { row, auth } = await loadAccount(env, task.user_id, accountId)
  if (!row.cf_account_id) throw new Error('That account has no Cloudflare account id')
  if (!env.FILES) throw new Error('This deployment has no R2 bucket to write the backup into')

  const tables = await d1Query<{ name?: string }>(
    auth, row.cf_account_id, databaseId,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  )
  const names = tables.map((entry) => entry.name).filter((name): name is string => Boolean(name)).slice(0, BACKUP_TABLE_LIMIT)
  const day = utcDay()
  let exported = 0
  let rows = 0
  for (const name of names) {
    const escaped = name.replaceAll('"', '""')
    const data = await d1Query<Record<string, unknown>>(auth, row.cf_account_id, databaseId, `SELECT * FROM "${escaped}" LIMIT ${BACKUP_ROW_LIMIT}`)
    const body = data.map((entry) => JSON.stringify(entry)).join('\n')
    await env.FILES.put(
      `cloudflare/d1-backups/${databaseId}/${day}/${name}.jsonl`,
      body,
      { httpMetadata: { contentType: 'application/x-ndjson' } },
    )
    exported += 1
    rows += data.length
  }
  return `Backed up ${exported} tables (${rows} rows) to cloudflare/d1-backups/${databaseId}/${day}/`
}

async function runR2Cleanup(env: Env, task: CloudflareTask, config: TaskConfig): Promise<string> {
  const accountId = requireString(config, 'account_id', 'Pick the account to clean')
  const bucket = requireString(config, 'bucket', 'Pick the R2 bucket to clean')
  const prefix = requireString(config, 'prefix', 'A key prefix is required so a task cannot empty a bucket')
  const days = Number(config.max_age_days ?? 30)
  if (!Number.isFinite(days) || days < 1) throw new Error('max_age_days must be at least 1')
  const { row, auth } = await loadAccount(env, task.user_id, accountId)
  if (!row.cf_account_id) throw new Error('That account has no Cloudflare account id')

  const response = await cfFetchRaw(
    auth,
    `/accounts/${row.cf_account_id}/r2/buckets/${encodeURIComponent(bucket)}/objects?prefix=${encodeURIComponent(prefix)}&per_page=1000`,
  )
  const text = await response.text()
  if (!response.ok) throw upstreamApiError(new Error(text.slice(0, 300)))
  const payload = JSON.parse(text) as { result?: Array<{ key?: string; uploaded?: string }> }
  const cutoff = Date.now() - days * 86_400_000
  const stale = (payload.result ?? [])
    .filter((entry) => entry.key && entry.uploaded && Date.parse(entry.uploaded) < cutoff)
    .map((entry) => entry.key!)
    .slice(0, CLEANUP_BATCH)
  for (const key of stale) {
    await cfFetchRaw(
      auth,
      `/accounts/${row.cf_account_id}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    )
  }
  return stale.length === 0
    ? `No objects under ${prefix} older than ${days} days`
    : `Deleted ${stale.length} objects under ${prefix} older than ${days} days`
}

async function d1Query<T>(auth: CloudflareAuth, cfAccountId: string, databaseId: string, sql: string): Promise<T[]> {
  const payload = await cfFetch<{ result?: unknown }>(auth, `/accounts/${cfAccountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: { sql },
  })
  const first = Array.isArray(payload.result) ? payload.result[0] : payload.result
  return ((first as { results?: T[] } | undefined)?.results ?? [])
}

/**
 * The every-minute entry point: run the tasks whose expression includes this minute.
 *
 * A task already executed in this minute is skipped, so a retried cron fire (or two isolates racing)
 * cannot double-run it. One task failing never stops the next: each has its own execution row saying
 * what happened.
 */
export async function runDueCloudflareTasks(env: Env, scheduledTime: number): Promise<void> {
  const now = new Date(scheduledTime)
  // The claim is against the wall-clock minute the run happens in, not the fire's timestamp: the two
  // can differ when a retried event arrives late, and the run is what must not happen twice.
  const minuteStart = Math.floor(Date.now() / 60_000) * 60_000
  const due = await env.DB.prepare(
    'SELECT * FROM cloudflare_scheduled_task WHERE enabled = 1 ORDER BY created_at ASC LIMIT 50',
  ).all<CloudflareTask>()
  for (const task of due.results ?? []) {
    if (!cronMatches(task.cron, now)) continue
    const already = await env.DB.prepare(
      'SELECT id FROM cloudflare_task_execution WHERE user_id = ? AND task_id = ? AND started_at >= ? LIMIT 1',
    )
      .bind(task.user_id, task.id, minuteStart)
      .first<{ id: string }>()
    if (already) continue
    await executeTask(env, task)
  }
}
