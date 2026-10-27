/**
 * `/api/cloudflare/workers` — Workers and Pages, their settings, deployments and batch operations.
 *
 * Every account-addressed route starts by loading the row under the reader's own id, so an account
 * that belongs to somebody else is a 404 rather than a request made with their credential. Names that
 * end up in upstream paths are validated here before a URL is built.
 *
 * Static addresses (`/summary`, `/usage`, `/batch-deploy`, `/batch-deploy-pages`, `/env-sync/*`) are
 * registered before the `/:accountId` arm. Hono answers in registration order, and a `summary`
 * swallowed as an account id would make the screen's first request a 404.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { assertNotDemo, type LoadedAccount } from '../../cloudflare/accounts'
import { createAuditLog } from '../../cloudflare/audit'
import { CloudflareApiError, cfFetch, cfFetchRaw, upstreamApiError } from '../../cloudflare/cf-api'
import {
  assertCronExpression,
  assertHostname,
  assertRoutePattern,
  assertSafeId,
  assertSecretName,
  assertWorkerName,
  errorText,
  extractWorkerSource,
  listWorkers,
  loadWorkerAccount,
  scriptPath,
  workerSummary,
  workersUsage,
} from '../../cloudflare/workers'
import {
  deployPagesProject,
  deployWorkerScript,
  executeEnvSync,
  fetchScriptFromUrl,
  parseDeployBindings,
  parseDeployTargets,
  parseDeployVars,
  previewEnvSync,
  type DeployBinding,
  type DeployVar,
} from '../../cloudflare/deploy'

export const workersRouter = new Hono<AppBindings>()

type AppContext = Context<AppBindings>
type DeployOutcomeRow = {
  accountId: string
  workerName: string
  success: boolean
  url?: string
  error?: string
}

const MAX_BATCH_TARGETS = 50
const MAX_DELETE_IDS = 100
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

async function readBody(c: AppContext): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw ApiError.badRequest('A JSON object body is required')
  }
  return body as Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function requiredText(body: Record<string, unknown>, key: string): string {
  const value = textOf(body[key]).trim()
  if (!value) throw ApiError.badRequest(`${key} is required`)
  return value
}

function formValue(form: Record<string, unknown>, key: string): string | File | undefined {
  const value = form[key]
  if (typeof value === 'string' || value instanceof File) return value
  if (Array.isArray(value)) {
    const first = value[0]
    if (typeof first === 'string' || first instanceof File) return first
  }
  return undefined
}

function formText(form: Record<string, unknown>, key: string): string {
  const value = formValue(form, key)
  return typeof value === 'string' ? value : ''
}

function formFile(form: Record<string, unknown>, key: string): File | null {
  const value = formValue(form, key)
  return value instanceof File ? value : null
}

function jsonField(form: Record<string, unknown>, key: string): unknown {
  const raw = formText(form, key)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw ApiError.badRequest(`${key} is not valid JSON`)
  }
}

async function audited<T>(
  c: AppContext,
  account: LoadedAccount | null,
  action: string,
  target: string | null,
  run: () => Promise<T>,
  detail: string | null = null,
): Promise<T> {
  try {
    const result = await run()
    await createAuditLog(c.env, c.get('userId'), account?.row.id ?? null, action, target, detail, 'success')
    return result
  } catch (error) {
    await createAuditLog(
      c.env,
      c.get('userId'),
      account?.row.id ?? null,
      action,
      target,
      detail ?? errorText(error),
      'error',
    )
    throw error
  }
}

async function workerTarget(c: AppContext): Promise<{ account: LoadedAccount; name: string }> {
  const account = await loadWorkerAccount(c.env, c.get('userId'), c.req.param('accountId') ?? '')
  return { account, name: assertWorkerName(c.req.param('name') ?? '') }
}

async function pagesTarget(c: AppContext): Promise<{ account: LoadedAccount; name: string }> {
  const account = await loadWorkerAccount(c.env, c.get('userId'), c.req.param('accountId') ?? '')
  return { account, name: assertWorkerName(c.req.param('name') ?? '') }
}

/** A listing route whose path carries no worker name: only the notebook account is needed. */
async function resourceAccount(c: AppContext): Promise<LoadedAccount> {
  return loadWorkerAccount(c.env, c.get('userId'), c.req.param('accountId') ?? '')
}

async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await task(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function batchSummary(results: readonly DeployOutcomeRow[]) {
  const succeeded = results.filter((result) => result.success).length
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  }
}

function parseSecretValues(value: unknown): Record<string, string> {
  const record = asRecord(value)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    assertSecretName(key)
    if (typeof item !== 'string') throw ApiError.badRequest(`Secret ${key} must be a string`)
    if (item.length > 16_384) throw ApiError.badRequest(`Secret ${key} is larger than 16384 characters`)
    out[key] = item
  }
  return out
}

function parseSyncKeys(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string')) {
    throw ApiError.badRequest('keys must be an array of strings')
  }
  if (value.length === 0) throw ApiError.badRequest('Select at least one key to sync')
  return value as string[]
}

function parseSyncTargets(value: unknown): Array<{ accountId: string; workerName: string }> {
  if (!Array.isArray(value) || value.length === 0) throw ApiError.badRequest('targets is required')
  if (value.length > MAX_BATCH_TARGETS) {
    throw ApiError.badRequest(`At most ${MAX_BATCH_TARGETS} targets can be sent`)
  }
  return value.map((item) => {
    const row = asRecord(item)
    const accountId = textOf(row.accountId).trim()
    if (!accountId) throw ApiError.badRequest('Every target needs an accountId')
    return { accountId, workerName: assertWorkerName(textOf(row.workerName).trim()) }
  })
}

function parseSyncSource(value: unknown): { accountId: string; workerName: string } {
  const row = asRecord(value)
  const accountId = textOf(row.accountId).trim()
  if (!accountId) throw ApiError.badRequest('source.accountId is required')
  return { accountId, workerName: assertWorkerName(textOf(row.workerName).trim()) }
}

async function loadSyncAccounts(
  c: AppContext,
  source: { accountId: string; workerName: string },
  targets: Array<{ accountId: string; workerName: string }>,
): Promise<{
  sourceAccount: LoadedAccount
  targets: Array<{ account: LoadedAccount; workerName: string }>
}> {
  const sourceAccount = await loadWorkerAccount(c.env, c.get('userId'), source.accountId)
  const loaded = await Promise.all(targets.map(async (target) => ({
    account: await loadWorkerAccount(c.env, c.get('userId'), target.accountId),
    workerName: target.workerName,
  })))
  return { sourceAccount, targets: loaded }
}

function settingsBindings(settings: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(settings.bindings)
    .map((item) => asRecord(item))
    .filter((binding) => typeof binding.type === 'string' && typeof binding.name === 'string')
}

function configVars(settings: Record<string, unknown>): Array<{ name: string; value: string; secret: boolean }> {
  return settingsBindings(settings)
    .filter((binding) => binding.type === 'plain_text' || binding.type === 'secret_text')
    .map((binding) => ({
      name: String(binding.name),
      value: binding.type === 'plain_text' ? textOf(binding.text) : '',
      secret: binding.type === 'secret_text',
    }))
}

function configBindings(settings: Record<string, unknown>): DeployBinding[] {
  const out: DeployBinding[] = []
  for (const binding of settingsBindings(settings)) {
    const name = String(binding.name)
    switch (binding.type) {
      case 'kv_namespace':
        out.push({ type: 'kv', name, mode: 'existing', existingId: textOf(binding.namespace_id) })
        break
      case 'd1':
        out.push({ type: 'd1', name, mode: 'existing', existingId: textOf(binding.id) })
        break
      case 'r2_bucket':
        out.push({ type: 'r2', name, mode: 'existing', existingId: textOf(binding.bucket_name) })
        break
      case 'ai':
        out.push({ type: 'ai', name })
        break
      case 'durable_object_namespace':
        out.push({
          type: 'durable_object',
          name,
          className: textOf(binding.class_name),
          ...(textOf(binding.script_name) ? { scriptName: textOf(binding.script_name) } : {}),
        })
        break
      case 'service':
        out.push({
          type: 'service',
          name,
          service: textOf(binding.service),
          ...(textOf(binding.environment) ? { environment: textOf(binding.environment) } : {}),
        })
        break
      case 'queue':
        out.push({ type: 'queue', name, queueName: textOf(binding.queue_name) })
        break
      default:
        break
    }
  }
  return out
}

async function readWorkerSettings(account: LoadedAccount, name: string): Promise<Record<string, unknown>> {
  const body = await cfFetch<{ result?: Record<string, unknown> }>(
    account.auth,
    `${scriptPath(account, name)}/settings`,
  )
  return asRecord(body.result)
}

async function readWorkerDeployments(account: LoadedAccount, name: string): Promise<Record<string, unknown> | unknown[]> {
  const body = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(account.auth, `${scriptPath(account, name)}/deployments`)
  return body.result ?? []
}

async function readPagesProject(account: LoadedAccount, name: string): Promise<Record<string, unknown> | unknown[] | null> {
  const cfId = account.row.cf_account_id ?? ''
  const body = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(
    account.auth,
    `/accounts/${encodeURIComponent(cfId)}/pages/projects/${encodeURIComponent(name)}`,
  )
  return body.result ?? null
}

function parseSettingsPatch(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (body.observability !== undefined) {
    const observability = asRecord(body.observability)
    patch.observability = { ...observability, enabled: observability.enabled === true }
  }
  if (body.logpush !== undefined) {
    if (typeof body.logpush !== 'boolean') throw ApiError.badRequest('logpush must be a boolean')
    patch.logpush = body.logpush
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
      throw ApiError.badRequest('tags must be an array of strings')
    }
    patch.tags = body.tags.map((tag) => String(tag).trim()).filter(Boolean)
  }
  if (body.compatibility_date !== undefined) {
    const date = textOf(body.compatibility_date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw ApiError.badRequest('Invalid compatibility date')
    patch.compatibility_date = date
  }
  if (body.compatibility_flags !== undefined) {
    if (!Array.isArray(body.compatibility_flags) || body.compatibility_flags.some((flag) => typeof flag !== 'string')) {
      throw ApiError.badRequest('compatibility_flags must be an array of strings')
    }
    patch.compatibility_flags = body.compatibility_flags
  }
  if (Object.keys(patch).length === 0) throw ApiError.badRequest('No settings were supplied')
  return patch
}

// ---------------------------------------------------------------------------------------------
// Static addresses. They must be registered before any `/:accountId` arm.
// ---------------------------------------------------------------------------------------------

workersRouter.get('/', async (c) => {
  const accountId = c.req.query('accountId')?.trim() || null
  return c.json(await listWorkers(c.env, c.get('userId'), accountId))
})

workersRouter.get('/summary', async (c) => {
  return c.json(await workerSummary(c.env, c.get('userId')))
})

workersRouter.get('/usage', async (c) => {
  return c.json(await workersUsage(c.env, c.get('userId')))
})

function resolveTargets(
  c: AppContext,
  targets: ReturnType<typeof parseDeployTargets>,
  vars: DeployVar[],
  bindings: DeployBinding[],
  script: Uint8Array | undefined,
  zip: Uint8Array | undefined,
  mainModule: string | undefined,
  compatibilityDate: string | undefined,
  isRedeploy: boolean,
): Promise<DeployOutcomeRow[]> {
  return runLimited(targets, 3, async (target) => {
    let account: LoadedAccount | null = null
    try {
      account = await loadWorkerAccount(c.env, c.get('userId'), target.accountId)
      await assertNotDemo(c.env, c.get('userId'), account.row.id)
      const outcome = await deployWorkerScript({
        account,
        name: target.workerName,
        script,
        zip,
        mainModule,
        vars,
        bindings,
        compatibilityDate,
        isRedeploy,
      })
      await createAuditLog(
        c.env,
        c.get('userId'),
        account.row.id,
        'deploy_worker',
        target.workerName,
        outcome.url ?? null,
        'success',
      )
      return {
        accountId: target.accountId,
        workerName: target.workerName,
        success: true,
        ...(outcome.url ? { url: outcome.url } : {}),
      }
    } catch (error) {
      await createAuditLog(
        c.env,
        c.get('userId'),
        account?.row.id ?? null,
        'deploy_worker',
        target.workerName,
        errorText(error),
        'error',
      )
      return {
        accountId: target.accountId,
        workerName: target.workerName,
        success: false,
        error: errorText(error),
      }
    }
  })
}

workersRouter.post('/batch-deploy', async (c) => {
  const form = await c.req.parseBody()
  const targets = parseDeployTargets(jsonField(form, 'targets'))
  const vars = parseDeployVars(jsonField(form, 'vars'))
  const bindings = parseDeployBindings(jsonField(form, 'bindings'))
  const isRedeploy = formText(form, 'isRedeploy') === 'true'
  const mainModule = formText(form, 'mainModule').trim() || undefined
  const compatibilityDate = formText(form, 'compatibilityDate').trim() || undefined

  let script: Uint8Array | undefined
  let zip: Uint8Array | undefined
  const file = formFile(form, 'script')
  if (file) {
    if (file.size > MAX_UPLOAD_BYTES) throw ApiError.tooLarge('The script is larger than 10 MB')
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (/\.zip$/i.test(file.name)) zip = bytes
    else script = bytes
  } else {
    const url = formText(form, 'url').trim()
    if (url) script = await fetchScriptFromUrl(url)
    else if (!isRedeploy) throw ApiError.badRequest('A script file or a script URL is required')
  }

  const results = await resolveTargets(
    c,
    targets,
    vars,
    bindings,
    script,
    zip,
    mainModule,
    compatibilityDate,
    isRedeploy,
  )
  return c.json(batchSummary(results))
})

workersRouter.post('/batch-deploy-pages', async (c) => {
  const form = await c.req.parseBody()
  const targets = parseDeployTargets(jsonField(form, 'targets'))
  const vars = parseDeployVars(jsonField(form, 'vars'))
  const bindings = parseDeployBindings(jsonField(form, 'bindings'))
  const file = formFile(form, 'zipFile')
  if (!file) throw ApiError.badRequest('zipFile is required')
  if (file.size > MAX_UPLOAD_BYTES) throw ApiError.tooLarge('The archive is larger than 10 MB')
  const zip = new Uint8Array(await file.arrayBuffer())

  const results = await runLimited(targets, 3, async (target): Promise<DeployOutcomeRow> => {
    let account: LoadedAccount | null = null
    try {
      account = await loadWorkerAccount(c.env, c.get('userId'), target.accountId)
      await assertNotDemo(c.env, c.get('userId'), account.row.id)
      const outcome = await deployPagesProject({
        account,
        name: target.workerName,
        zip,
        vars,
        bindings,
      })
      await createAuditLog(
        c.env,
        c.get('userId'),
        account.row.id,
        'deploy_pages',
        target.workerName,
        outcome.url ?? null,
        'success',
      )
      return {
        accountId: target.accountId,
        workerName: target.workerName,
        success: true,
        ...(outcome.url ? { url: outcome.url } : {}),
      }
    } catch (error) {
      await createAuditLog(
        c.env,
        c.get('userId'),
        account?.row.id ?? null,
        'deploy_pages',
        target.workerName,
        errorText(error),
        'error',
      )
      return {
        accountId: target.accountId,
        workerName: target.workerName,
        success: false,
        error: errorText(error),
      }
    }
  })
  return c.json(batchSummary(results))
})

workersRouter.post('/env-sync/preview', async (c) => {
  const body = await readBody(c)
  const source = parseSyncSource(body.source)
  const targets = parseSyncTargets(body.targets)
  const loaded = await loadSyncAccounts(c, source, targets)
  return c.json(await previewEnvSync(loaded.sourceAccount, source.workerName, loaded.targets))
})

workersRouter.post('/env-sync/execute', async (c) => {
  const body = await readBody(c)
  const source = parseSyncSource(body.source)
  const targets = parseSyncTargets(body.targets)
  const keys = parseSyncKeys(body.keys)
  const secretValues = parseSecretValues(body.secretValues)
  const loaded = await loadSyncAccounts(c, source, targets)
  const results = await executeEnvSync(
    loaded.sourceAccount,
    source.workerName,
    loaded.targets,
    keys,
    secretValues,
  )
  for (const result of results) {
    await createAuditLog(
      c.env,
      c.get('userId'),
      result.accountId,
      'env_sync',
      `${source.workerName} -> ${result.workerName}`,
      result.success ? `keys=${result.applied.join(',')}` : errorText(result.error),
      result.success ? 'success' : 'error',
    )
  }
  return c.json(results)
})

// ---------------------------------------------------------------------------------------------
// Worker detail and settings.
// ---------------------------------------------------------------------------------------------

workersRouter.get('/:accountId/workers/:name', async (c) => {
  const { account, name } = await workerTarget(c)
  const body = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(account.auth, scriptPath(account, name))
  return c.json(body.result ?? null)
})

workersRouter.delete('/:accountId/workers/:name', async (c) => {
  const { account, name } = await workerTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await audited(c, account, 'delete_worker', name, async () => {
    await cfFetch(account.auth, scriptPath(account, name), { method: 'DELETE' })
  })
  return c.json({ success: true })
})

workersRouter.get('/:accountId/workers/:name/deployments', async (c) => {
  const { account, name } = await workerTarget(c)
  return c.json(await readWorkerDeployments(account, name))
})

workersRouter.get('/:accountId/workers/:name/schedules', async (c) => {
  const { account, name } = await workerTarget(c)
  const body = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(account.auth, `${scriptPath(account, name)}/schedules`)
  return c.json(body.result ?? { schedules: [] })
})

workersRouter.get('/:accountId/workers/:name/logs', async (c) => {
  const { account, name } = await workerTarget(c)
  const body = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(account.auth, `${scriptPath(account, name)}/tails`)
  return c.json(body.result ?? null)
})

workersRouter.put('/:accountId/workers/:name/schedules', async (c) => {
  const { account, name } = await workerTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const body = await readBody(c)
  if (!Array.isArray(body.crons)) throw ApiError.badRequest('crons must be an array')
  if (body.crons.length > 20) throw ApiError.badRequest('At most 20 cron expressions can be saved')
  const crons = body.crons.map((cron) => assertCronExpression(textOf(cron)))
  const result = await audited(c, account, 'update_schedules', name, async () => {
    const answer = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(account.auth, `${scriptPath(account, name)}/schedules`, {
      method: 'PUT',
      body: crons.map((cron) => ({ cron })),
    })
    return answer.result ?? answer
  })
  return c.json(result)
})

workersRouter.get('/:accountId/workers/:name/secrets', async (c) => {
  const { account, name } = await workerTarget(c)
  const body = await cfFetch<{ result?: unknown[] }>(account.auth, `${scriptPath(account, name)}/secrets`)
  return c.json(body.result ?? [])
})

workersRouter.put('/:accountId/workers/:name/secrets', async (c) => {
  const { account, name } = await workerTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const body = await readBody(c)
  const secretName = assertSecretName(requiredText(body, 'name'))
  const type = textOf(body.type)
  if (type !== 'secret_text' && type !== 'plain_text' && type !== 'key_base64') {
    throw ApiError.badRequest('Invalid secret type')
  }
  const value = type === 'key_base64' ? textOf(body.key_base64) : textOf(body.text)
  if (!value) throw ApiError.badRequest('A secret value is required')
  const result = await audited(c, account, 'update_secret', `${name}/${secretName}`, async () => {
    const answer = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(account.auth, `${scriptPath(account, name)}/secrets`, {
      method: 'PUT',
      body: {
        name: secretName,
        type,
        ...(type === 'key_base64' ? { key_base64: value } : { text: value }),
      },
    })
    return answer.result ?? answer
  }, `type=${type}`)
  return c.json(result)
})

workersRouter.delete('/:accountId/workers/:name/secrets/:secretName', async (c) => {
  const { account, name } = await workerTarget(c)
  const secretName = assertSecretName(c.req.param('secretName'))
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await audited(c, account, 'delete_secret', `${name}/${secretName}`, async () => {
    await cfFetch(
      account.auth,
      `${scriptPath(account, name)}/secrets/${encodeURIComponent(secretName)}`,
      { method: 'DELETE' },
    )
  })
  return c.json({ success: true })
})

workersRouter.get('/:accountId/workers/:name/domains', async (c) => {
  const { account, name } = await workerTarget(c)
  const cfId = account.row.cf_account_id ?? ''
  const body = await cfFetch<{ result?: unknown[] }>(
    account.auth,
    `/accounts/${encodeURIComponent(cfId)}/workers/domains?service=${encodeURIComponent(name)}`,
  )
  return c.json(body.result ?? [])
})

workersRouter.post('/:accountId/workers/:name/domains', async (c) => {
  const { account, name } = await workerTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const body = await readBody(c)
  const hostname = assertHostname(requiredText(body, 'hostname'))
  const environment = textOf(body.environment) || 'production'
  if (environment !== 'production' && environment !== 'staging') {
    throw ApiError.badRequest('environment must be production or staging')
  }
  const cfId = account.row.cf_account_id ?? ''
  const result = await audited(c, account, 'create_worker_domain', `${name}/${hostname}`, async () => {
    const answer = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(
      account.auth,
      `/accounts/${encodeURIComponent(cfId)}/workers/domains`,
      { method: 'PUT', body: { hostname, service: name, environment } },
    )
    return answer.result ?? answer
  })
  return c.json(result, 201)
})

workersRouter.delete('/:accountId/workers/:name/domains/:domainId', async (c) => {
  const { account, name } = await workerTarget(c)
  const domainId = assertSafeId(c.req.param('domainId'), 'domain id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const cfId = account.row.cf_account_id ?? ''
  await audited(c, account, 'delete_worker_domain', `${name}/${domainId}`, async () => {
    await cfFetch(
      account.auth,
      `/accounts/${encodeURIComponent(cfId)}/workers/domains/${encodeURIComponent(domainId)}`,
      { method: 'DELETE' },
    )
  })
  return c.json({ success: true })
})

workersRouter.get('/:accountId/workers/:name/subdomain', async (c) => {
  const { account, name } = await workerTarget(c)
  const cfId = account.row.cf_account_id ?? ''
  const body = await cfFetch<{ result?: Record<string, unknown> }>(account.auth, `${scriptPath(account, name)}/subdomain`)
  const scriptSubdomain = asRecord(body.result)
  let accountSubdomain = ''
  try {
    const answer = await cfFetch<{ result?: { subdomain?: string } }>(
      account.auth,
      `/accounts/${encodeURIComponent(cfId)}/workers/subdomain`,
    )
    accountSubdomain = textOf(answer.result?.subdomain)
  } catch (error) {
    console.warn('[inkstone] Workers account subdomain lookup failed:', errorText(error))
  }
  const enabled = scriptSubdomain.enabled === true
  return c.json({
    ...scriptSubdomain,
    accountSubdomain,
    url: enabled && accountSubdomain ? `https://${name}.${accountSubdomain}.workers.dev` : '',
  })
})

workersRouter.put('/:accountId/workers/:name/subdomain', async (c) => {
  const { account, name } = await workerTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const body = await readBody(c)
  if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('enabled must be a boolean')
  const result = await audited(c, account, 'update_subdomain', name, async () => {
    const answer = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(account.auth, `${scriptPath(account, name)}/subdomain`, {
      method: 'POST',
      body: { enabled: body.enabled },
    })
    return answer.result ?? answer
  }, `enabled=${body.enabled}`)
  return c.json(result)
})

workersRouter.get('/:accountId/workers/:name/settings', async (c) => {
  const { account, name } = await workerTarget(c)
  return c.json(await readWorkerSettings(account, name))
})

workersRouter.patch('/:accountId/workers/:name/settings', async (c) => {
  const { account, name } = await workerTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const patch = parseSettingsPatch(await readBody(c))
  const result = await audited(c, account, 'update_worker_settings', name, async () => {
    const answer = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(account.auth, `${scriptPath(account, name)}/settings`, {
      method: 'PATCH',
      body: patch,
    })
    return answer.result ?? answer
  }, `keys=${Object.keys(patch).join(',')}`)
  return c.json(result)
})

workersRouter.get('/:accountId/workers/:name/content', async (c) => {
  const { account, name } = await workerTarget(c)
  const response = await cfFetchRaw(account.auth, scriptPath(account, name), {
    headers: { Accept: '*/*' },
  })
  if (!response.ok) {
    throw upstreamApiError(new CloudflareApiError({ status: response.status, body: await response.text() }))
  }
  const contentType = response.headers.get('content-type') ?? ''
  const buffer = await response.arrayBuffer()
  if (!/multipart\/form-data/i.test(contentType)) {
    return c.json(new TextDecoder().decode(buffer))
  }
  const source = extractWorkerSource(buffer, contentType)
  return c.json(source ?? 'No Worker entry module (worker.js / index.js) was found')
})

workersRouter.get('/:accountId/workers/:name/config', async (c) => {
  const { account, name } = await workerTarget(c)
  const [settings, deployments] = await Promise.all([
    readWorkerSettings(account, name),
    readWorkerDeployments(account, name),
  ])
  return c.json({
    settings,
    deployments,
    vars: configVars(settings),
    bindings: configBindings(settings),
  })
})

workersRouter.get('/:accountId/workers/:name/routes', async (c) => {
  const { account } = await workerTarget(c)
  const zoneId = assertSafeId(c.req.query('zone_id')?.trim() ?? '', 'zone id')
  const body = await cfFetch<{ result?: unknown[] }>(
    account.auth,
    `/zones/${encodeURIComponent(zoneId)}/workers/routes`,
  )
  return c.json(body.result ?? [])
})

workersRouter.post('/:accountId/workers/:name/routes', async (c) => {
  const { account, name } = await workerTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const body = await readBody(c)
  const zoneId = assertSafeId(requiredText(body, 'zone_id'), 'zone id')
  const pattern = assertRoutePattern(requiredText(body, 'pattern'))
  const script = textOf(body.script).trim() || name
  assertWorkerName(script)
  const result = await audited(c, account, 'create_worker_route', `${name}/${pattern}`, async () => {
    const answer = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(
      account.auth,
      `/zones/${encodeURIComponent(zoneId)}/workers/routes`,
      { method: 'POST', body: { pattern, script } },
    )
    return answer.result ?? answer
  }, `zone=${zoneId}`)
  return c.json(result, 201)
})

workersRouter.delete('/:accountId/workers/:name/routes/:routeId', async (c) => {
  const { account, name } = await workerTarget(c)
  const routeId = assertSafeId(c.req.param('routeId'), 'route id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const zoneId = assertSafeId(c.req.query('zone_id')?.trim() ?? '', 'zone id')
  await audited(c, account, 'delete_worker_route', `${name}/${routeId}`, async () => {
    await cfFetch(
      account.auth,
      `/zones/${encodeURIComponent(zoneId)}/workers/routes/${encodeURIComponent(routeId)}`,
      { method: 'DELETE' },
    )
  }, `zone=${zoneId}`)
  return c.json({ success: true })
})

// ---------------------------------------------------------------------------------------------
// Resources used by the deploy dialog.
// ---------------------------------------------------------------------------------------------

workersRouter.get('/:accountId/resources/kv', async (c) => {
  const account = await resourceAccount(c)
  const cfId = account.row.cf_account_id ?? ''
  const body = await cfFetch<{ result?: unknown[] }>(
    account.auth,
    `/accounts/${encodeURIComponent(cfId)}/storage/kv/namespaces`,
  )
  return c.json(body.result ?? [])
})

workersRouter.get('/:accountId/resources/d1', async (c) => {
  const account = await resourceAccount(c)
  const cfId = account.row.cf_account_id ?? ''
  const body = await cfFetch<{ result?: unknown[] }>(
    account.auth,
    `/accounts/${encodeURIComponent(cfId)}/d1/database`,
  )
  return c.json(body.result ?? [])
})

workersRouter.get('/:accountId/resources/r2', async (c) => {
  const account = await resourceAccount(c)
  const cfId = account.row.cf_account_id ?? ''
  try {
    const body = await cfFetch<{ result?: { buckets?: unknown[] } }>(
      account.auth,
      `/accounts/${encodeURIComponent(cfId)}/r2/buckets`,
    )
    return c.json({ buckets: body.result?.buckets ?? [], r2_not_enabled: false })
  } catch (error) {
    if (/10042|enable R2|Please enable R2/i.test(errorText(error))) {
      return c.json({ buckets: [], r2_not_enabled: true })
    }
    throw error
  }
})

workersRouter.get('/:accountId/resources/zones', async (c) => {
  const account = await resourceAccount(c)
  const cfId = account.row.cf_account_id ?? ''
  const zones = await cfFetchAllJson(account, `/zones`, 100)
  return c.json(zones.filter((zone) => asRecord(zone.account).id === cfId))
})

async function cfFetchAllJson(account: LoadedAccount, path: string, perPage: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let page = 1; page <= 20; page++) {
    const separator = path.includes('?') ? '&' : '?'
    const body = await cfFetch<{ result?: unknown[]; result_info?: { total_pages?: number } }>(
      account.auth,
      `${path}${separator}page=${page}&per_page=${perPage}`,
    )
    const items = asArray(body.result).map((item) => asRecord(item))
    out.push(...items)
    if (items.length === 0 || page >= (body.result_info?.total_pages ?? 1)) break
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Pages.
// ---------------------------------------------------------------------------------------------

workersRouter.get('/:accountId/pages/:name/project', async (c) => {
  const { account, name } = await pagesTarget(c)
  return c.json(await readPagesProject(account, name))
})

workersRouter.patch('/:accountId/pages/:name/project', async (c) => {
  const { account, name } = await pagesTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const body = await readBody(c)
  const patch: Record<string, unknown> = {}
  for (const key of ['deployment_configs', 'production_branch', 'build_config', 'source']) {
    if (body[key] === undefined) continue
    patch[key] = body[key]
  }
  if (Object.keys(patch).length === 0) throw ApiError.badRequest('No project fields were supplied')
  if (patch.deployment_configs !== undefined && Object.keys(asRecord(patch.deployment_configs)).length === 0) {
    throw ApiError.badRequest('deployment_configs is required')
  }
  const result = await audited(c, account, 'update_pages_project', name, async () => {
    const cfId = account.row.cf_account_id ?? ''
    const answer = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(
      account.auth,
      `/accounts/${encodeURIComponent(cfId)}/pages/projects/${encodeURIComponent(name)}`,
      { method: 'PATCH', body: patch },
    )
    return answer.result ?? answer
  })
  return c.json(result)
})

workersRouter.delete('/:accountId/pages/:name', async (c) => {
  const { account, name } = await pagesTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await audited(c, account, 'delete_pages_project', name, async () => {
    const cfId = account.row.cf_account_id ?? ''
    await cfFetch(
      account.auth,
      `/accounts/${encodeURIComponent(cfId)}/pages/projects/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    )
  })
  return c.json({ success: true })
})

workersRouter.get('/:accountId/pages/:name/domains', async (c) => {
  const { account, name } = await pagesTarget(c)
  const cfId = account.row.cf_account_id ?? ''
  const body = await cfFetch<{ result?: unknown[] }>(
    account.auth,
    `/accounts/${encodeURIComponent(cfId)}/pages/projects/${encodeURIComponent(name)}/domains`,
  )
  return c.json(body.result ?? [])
})

workersRouter.post('/:accountId/pages/:name/domains', async (c) => {
  const { account, name } = await pagesTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const body = await readBody(c)
  const hostname = assertHostname(requiredText(body, 'hostname'))
  const result = await audited(c, account, 'create_pages_domain', `${name}/${hostname}`, async () => {
    const cfId = account.row.cf_account_id ?? ''
    const answer = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(
      account.auth,
      `/accounts/${encodeURIComponent(cfId)}/pages/projects/${encodeURIComponent(name)}/domains`,
      { method: 'POST', body: { name: hostname } },
    )
    return answer.result ?? answer
  })
  return c.json(result, 201)
})

workersRouter.delete('/:accountId/pages/:name/domains/:hostname', async (c) => {
  const { account, name } = await pagesTarget(c)
  const hostname = assertHostname(c.req.param('hostname'))
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await audited(c, account, 'delete_pages_domain', `${name}/${hostname}`, async () => {
    const cfId = account.row.cf_account_id ?? ''
    await cfFetch(
      account.auth,
      `/accounts/${encodeURIComponent(cfId)}/pages/projects/${encodeURIComponent(name)}/domains/${encodeURIComponent(hostname)}`,
      { method: 'DELETE' },
    )
  })
  return c.json({ success: true })
})

workersRouter.get('/:accountId/pages/:name/deployments', async (c) => {
  const { account, name } = await pagesTarget(c)
  const cfId = account.row.cf_account_id ?? ''
  const body = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(
    account.auth,
    `/accounts/${encodeURIComponent(cfId)}/pages/projects/${encodeURIComponent(name)}/deployments`,
  )
  return c.json(body.result ?? [])
})

workersRouter.delete('/:accountId/pages/:name/deployments', async (c) => {
  const { account, name } = await pagesTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const body = await readBody(c)
  if (!Array.isArray(body.ids) || body.ids.length === 0) throw ApiError.badRequest('ids must be a non-empty array')
  if (body.ids.length > MAX_DELETE_IDS) throw ApiError.badRequest(`At most ${MAX_DELETE_IDS} deployments can be deleted at once`)
  const ids = body.ids.map((id) => assertSafeId(textOf(id), 'deployment id'))
  const cfId = account.row.cf_account_id ?? ''
  const results = await Promise.all(ids.map(async (id) => {
    try {
      await cfFetch(
        account.auth,
        `/accounts/${encodeURIComponent(cfId)}/pages/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      )
      return { id, success: true }
    } catch (error) {
      return { id, success: false, error: errorText(error) }
    }
  }))
  const succeeded = results.filter((result) => result.success).length
  await createAuditLog(
    c.env,
    c.get('userId'),
    account.row.id,
    'delete_pages_deployments',
    name,
    `deleted ${succeeded}/${ids.length}`,
    succeeded > 0 ? 'success' : 'error',
  )
  return c.json({ total: ids.length, succeeded, failed: ids.length - succeeded, results })
})

workersRouter.get('/:accountId/pages/:name/config', async (c) => {
  const { account, name } = await pagesTarget(c)
  return c.json(await readPagesProject(account, name))
})

workersRouter.put('/:accountId/pages/:name/bindings', async (c) => {
  const { account, name } = await pagesTarget(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const body = await readBody(c)
  const deploymentConfigs = asRecord(body.deployment_configs)
  if (!deploymentConfigs.production && !deploymentConfigs.preview) {
    throw ApiError.badRequest('deployment_configs is required')
  }
  const result = await audited(c, account, 'update_pages_bindings', name, async () => {
    const cfId = account.row.cf_account_id ?? ''
    const answer = await cfFetch<{ result?: Record<string, unknown> | unknown[] }>(
      account.auth,
      `/accounts/${encodeURIComponent(cfId)}/pages/projects/${encodeURIComponent(name)}`,
      { method: 'PATCH', body: { deployment_configs: deploymentConfigs } },
    )
    return answer.result ?? answer
  }, `sections=${Object.keys(deploymentConfigs).join(',')}`)
  return c.json(result)
})
