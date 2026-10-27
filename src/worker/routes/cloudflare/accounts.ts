/**
 * `/api/cloudflare/accounts` — the account list, its credential bundle, and the batch operations the
 * screen's buttons call.
 *
 * Hono answers in registration order, so every fixed path (`/test-batch`, `/import-csv`, `/batch/*`)
 * is registered before the `/:id` arms. Every query carries the reader's id; another reader's account
 * is answered as missing rather than forbidden, so an id cannot be used to prove it exists.
 *
 * Every write is paired with an audit row. The route owns those for edits and deletes because the
 * store functions are also called by other screens and should not guess a reader's intent; CSV rows
 * are audited one by one because each creates an account of its own.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings, Env } from '../../env'
import { ApiError } from '../../lib/errors'
import {
  ALL_FEATURES,
  DEFAULT_FEATURES,
  assertNotDemo,
  createAccount,
  deleteAccount,
  demoAccountIds,
  getAccountRow,
  listAccounts,
  testAccount,
  updateAccount,
  type CloudflareAuthType,
  type CreateAccountInput,
  type UpdateAccountInput,
} from '../../cloudflare/accounts'
import { createUnverifiedAccount } from '../../cloudflare/account-probe'
import {
  CsvFormatError,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  accountNameFromEmail,
  parseAccountsCsv,
  type CsvAccountRow,
} from '../../cloudflare/accounts-csv'
import { createAuditLog, type AuditStatus } from '../../cloudflare/audit'
import { readAccountCredentials } from '../../cloudflare/credentials'
import { clearExhausted, quotaSummary } from '../../cloudflare/quota'

export const accountsRouter = new Hono<AppBindings>()

type ListFilter = 'all' | 'active' | 'unverified'
type BatchStatus = 'success' | 'skipped' | 'error'

interface BatchSummary {
  total: number
  success: number
  skipped: number
  error: number
}

interface BatchRow {
  id: string
  name: string
  status: BatchStatus
  message?: string
}

interface ImportRow {
  email: string
  name: string
  status: BatchStatus
  message?: string
}

interface TestTarget {
  id: string
  name: string
}

const MAX_BATCH_IDS = 200
const BATCH_TEST_CONCURRENCY = 5
const CSV_VERIFY_CONCURRENCY = 5
const CSV_SKIP_VERIFY_CONCURRENCY = 20
const MAX_SEARCH_CHARS = 200

// ---------------------------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------------------------

async function jsonObject(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => null) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('A JSON object is required')
  }
  return value as Record<string, unknown>
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest(`${key} must be a string`)
  return value
}

function optionalSecret(body: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(body, key)
  return value === undefined ? undefined : value.trim()
}

function optionalNullableString(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw ApiError.badRequest(`${key} must be a string`)
  return value
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${key} must be a boolean`)
  return value
}

function readAuthType(body: Record<string, unknown>): CloudflareAuthType {
  const value = optionalString(body, 'auth_type')
  if (value !== 'token' && value !== 'global_key') {
    throw ApiError.badRequest('auth_type must be token or global_key')
  }
  return value
}

/**
 * The feature string the row stores.
 *
 * An empty selection means "all", which is also what `accountHasFeature` reads from an empty string;
 * unknown names are refused rather than silently dropped, because a typo would otherwise turn into a
 * feature the reader thinks they switched on.
 */
function normalizeFeatures(raw: string): string {
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean)
  for (const part of parts) {
    if (!(ALL_FEATURES as readonly string[]).includes(part)) {
      throw ApiError.badRequest(`Unknown feature: ${part}`)
    }
  }
  const unique = [...new Set(parts)]
  return unique.length > 0 ? unique.join(',') : DEFAULT_FEATURES
}

function readIds(body: Record<string, unknown>): string[] {
  const value = body.ids
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest('ids must be a non-empty array of account ids')
  }
  if (value.length > MAX_BATCH_IDS) {
    throw ApiError.badRequest(`At most ${MAX_BATCH_IDS} accounts can be changed at once`)
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry) {
      throw ApiError.badRequest('ids must contain account ids')
    }
    if (!seen.has(entry)) {
      seen.add(entry)
      ids.push(entry)
    }
  }
  return ids
}

function readPage(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readFilter(value: string | undefined): ListFilter {
  return value === 'active' || value === 'unverified' ? value : 'all'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/** Runs `work` over every item with at most `limit` in flight, preserving the caller's order. */
async function mapLimit<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      await work(items[index]!)
    }
  })
  await Promise.all(runners)
}

function summarize(rows: ReadonlyArray<{ status: BatchStatus }>): BatchSummary {
  const summary: BatchSummary = { total: rows.length, success: 0, skipped: 0, error: 0 }
  for (const row of rows) summary[row.status] += 1
  return summary
}

async function audit(
  env: Env,
  userId: string,
  accountId: string | null,
  action: string,
  target: string | null,
  detail: string | null,
  status: AuditStatus = 'success',
): Promise<void> {
  await createAuditLog(env, userId, accountId, action, target, detail, status)
}

interface UploadedFile {
  size: number
  text(): Promise<string>
}

function asUploadedFile(value: unknown): UploadedFile | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { size?: unknown; text?: unknown }
  if (typeof candidate.size !== 'number' || typeof candidate.text !== 'function') return null
  return value as UploadedFile
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

accountsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const page = readPage(c.req.query('page'), 1)
  const pageSize = Math.min(Math.max(readPage(c.req.query('pageSize'), 20), 1), 100)
  const filter = readFilter(c.req.query('filter'))
  const search = (c.req.query('search') ?? '').trim().slice(0, MAX_SEARCH_CHARS)
  const [pageData, quota] = await Promise.all([
    listAccounts(c.env, userId, { filter, search, limit: pageSize, offset: (page - 1) * pageSize }),
    quotaSummary(c.env, userId),
  ])
  return c.json({ ...pageData, quota })
})

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

accountsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const body = await jsonObject(c)
  const name = optionalString(body, 'name') ?? ''
  const authType = readAuthType(body)
  const input: CreateAccountInput = {
    name,
    auth_type: authType,
    email: optionalNullableString(body, 'email') ?? null,
    cf_account_id: optionalNullableString(body, 'cf_account_id') ?? null,
  }
  const token = optionalSecret(body, 'api_token')
  const apiKey = optionalSecret(body, 'api_key')
  const password = optionalString(body, 'password')
  if (token !== undefined) input.api_token = token
  if (apiKey !== undefined) input.api_key = apiKey
  if (password !== undefined) input.password = password
  const features = optionalString(body, 'enabled_features')
  if (features !== undefined) input.enabled_features = normalizeFeatures(features)
  const active = optionalBoolean(body, 'is_active')
  if (active !== undefined) input.is_active = active

  const account = await createAccount(c.env, userId, input)
  await audit(c.env, userId, account.id, 'create_account', account.name, `auth_type=${account.auth_type}`)
  return c.json(account, 201)
})

// ---------------------------------------------------------------------------------------------
// Batch operations — fixed paths, before any `/:id` registration
// ---------------------------------------------------------------------------------------------

accountsRouter.post('/test-batch', async (c) => {
  const userId = c.get('userId')
  const body = await jsonObject(c)
  const onlyUnverified = optionalBoolean(body, 'onlyUnverified') ?? false
  const requested = body.ids
  const demo = await demoAccountIds(c.env, userId)

  const results: Array<BatchRow | null> = []
  const pending: Array<{ index: number; target: TestTarget }> = []

  if (requested !== undefined) {
    if (!Array.isArray(requested) || requested.length === 0) {
      throw ApiError.badRequest('ids must be a non-empty array of account ids')
    }
    if (requested.length > MAX_BATCH_IDS) {
      throw ApiError.badRequest(`At most ${MAX_BATCH_IDS} accounts can be tested at once`)
    }
    for (const entry of requested) {
      if (typeof entry !== 'string' || !entry) throw ApiError.badRequest('ids must contain account ids')
      const row = await getAccountRow(c.env, userId, entry)
      if (!row) {
        results.push({ id: entry, name: '', status: 'error', message: 'Account not found' })
        continue
      }
      const index = results.length
      results.push(null)
      pending.push({ index, target: { id: row.id, name: row.name } })
    }
  } else {
    const rows = await c.env.DB.prepare(
      `SELECT id, name FROM cloudflare_account
        WHERE user_id = ?${onlyUnverified ? " AND (cf_account_id IS NULL OR cf_account_id = '')" : ''}
        ORDER BY created_at ASC, id ASC`,
    )
      .bind(userId)
      .all<{ id: string; name: string }>()
    for (const row of rows.results ?? []) {
      const index = results.length
      results.push(null)
      pending.push({ index, target: { id: row.id, name: row.name } })
    }
  }

  await mapLimit(pending, BATCH_TEST_CONCURRENCY, async ({ index, target }) => {
    if (demo.has(target.id)) {
      results[index] = {
        id: target.id,
        name: target.name,
        status: 'skipped',
        message: 'A demo account cannot be changed',
      }
      return
    }
    try {
      const outcome = await testAccount(c.env, userId, target.id)
      await audit(c.env, userId, target.id, 'test_account', target.name, `cf_account_id=${outcome.cf_account_id ?? ''}`)
      results[index] = { id: target.id, name: target.name, status: 'success' }
    } catch (error) {
      const message = errorMessage(error)
      await audit(c.env, userId, target.id, 'test_account', target.name, message, 'error')
      results[index] = { id: target.id, name: target.name, status: 'error', message }
    }
  })

  const rows = results.map((row): BatchRow => row ?? { id: '', name: '', status: 'error', message: 'Not tested' })
  return c.json({ summary: summarize(rows), results: rows })
})

accountsRouter.post('/import-csv', async (c) => {
  const userId = c.get('userId')
  const form = await c.req.formData().catch(() => null)
  if (!form) throw ApiError.badRequest('A multipart form with a CSV file is required')
  const file = asUploadedFile(form.get('file'))
  if (!file) throw ApiError.badRequest('A CSV file is required')
  if (file.size === 0) throw ApiError.badRequest('The CSV file is empty')
  if (file.size > MAX_CSV_BYTES) throw ApiError.tooLarge('The CSV file is larger than 1 MB')
  const skipVerifyValue = form.get('skipVerify')
  const skipVerify = typeof skipVerifyValue === 'string' && /^(1|true|on|yes)$/i.test(skipVerifyValue.trim())

  let rows: CsvAccountRow[]
  try {
    rows = parseAccountsCsv(await file.text())
  } catch (error) {
    if (error instanceof CsvFormatError) throw ApiError.badRequest(error.message)
    throw error
  }
  if (rows.length === 0) throw ApiError.badRequest('The CSV file has no data rows')
  if (rows.length > MAX_CSV_ROWS) {
    throw ApiError.badRequest(`At most ${MAX_CSV_ROWS} rows can be imported at once`)
  }

  const existing = await c.env.DB.prepare(
    `SELECT lower(email) AS email FROM cloudflare_account
      WHERE user_id = ? AND email IS NOT NULL AND email <> ''`,
  )
    .bind(userId)
    .all<{ email: string }>()
  const seen = new Set((existing.results ?? []).map((row) => row.email.trim().toLowerCase()))

  const results: Array<ImportRow | null> = new Array(rows.length).fill(null)
  const pending: Array<{ index: number; row: CsvAccountRow; name: string }> = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (!row.email || !row.email.includes('@')) {
      results[index] = { email: row.email, name: '', status: 'error', message: 'A valid email is required' }
      continue
    }
    if (!row.apiKey) {
      results[index] = { email: row.email, name: accountNameFromEmail(row.email), status: 'error', message: 'An API key is required' }
      continue
    }
    if (seen.has(row.email)) {
      results[index] = { email: row.email, name: accountNameFromEmail(row.email), status: 'skipped', message: 'Duplicate email' }
      continue
    }
    seen.add(row.email)
    pending.push({ index, row, name: accountNameFromEmail(row.email) })
  }

  await mapLimit(
    pending,
    skipVerify ? CSV_SKIP_VERIFY_CONCURRENCY : CSV_VERIFY_CONCURRENCY,
    async ({ index, row, name }) => {
      try {
        const accountId = skipVerify
          ? await createUnverifiedAccount(c.env, userId, {
            name,
            email: row.email,
            apiKey: row.apiKey,
            password: row.password,
          })
          : (await createAccount(c.env, userId, {
            name,
            auth_type: 'global_key',
            email: row.email,
            api_key: row.apiKey,
            ...(row.password ? { password: row.password } : {}),
          })).id
        await audit(c.env, userId, accountId, 'create_account', name, `source=csv${skipVerify ? ' skip_verify' : ''}`)
        results[index] = { email: row.email, name, status: 'success' }
      } catch (error) {
        results[index] = { email: row.email, name, status: 'error', message: errorMessage(error) }
      }
    },
  )

  const finalRows = results.map((row): ImportRow => row ?? {
    email: '',
    name: '',
    status: 'error',
    message: 'Not imported',
  })
  return c.json({ summary: summarize(finalRows), results: finalRows })
})

accountsRouter.post('/batch/features', async (c) => {
  const userId = c.get('userId')
  const body = await jsonObject(c)
  const ids = readIds(body)
  const raw = optionalString(body, 'enabled_features')
  if (raw === undefined) throw ApiError.badRequest('enabled_features is required')
  const enabledFeatures = normalizeFeatures(raw)
  const demo = await demoAccountIds(c.env, userId)

  const results: BatchRow[] = []
  for (const id of ids) {
    const row = await getAccountRow(c.env, userId, id)
    if (!row) {
      results.push({ id, name: '', status: 'error', message: 'Account not found' })
      continue
    }
    if (demo.has(id)) {
      results.push({ id, name: row.name, status: 'skipped', message: 'A demo account cannot be changed' })
      continue
    }
    try {
      await c.env.DB.prepare(
        'UPDATE cloudflare_account SET enabled_features = ?, updated_at = ? WHERE user_id = ? AND id = ?',
      )
        .bind(enabledFeatures, Date.now(), userId, id)
        .run()
      await audit(c.env, userId, id, 'update_features', row.name, enabledFeatures)
      results.push({ id, name: row.name, status: 'success' })
    } catch (error) {
      results.push({ id, name: row.name, status: 'error', message: errorMessage(error) })
    }
  }
  return c.json({ summary: summarize(results), results })
})

accountsRouter.post('/batch/delete', async (c) => {
  const userId = c.get('userId')
  const body = await jsonObject(c)
  const ids = readIds(body)
  const demo = await demoAccountIds(c.env, userId)

  const results: BatchRow[] = []
  for (const id of ids) {
    const row = await getAccountRow(c.env, userId, id)
    if (!row) {
      results.push({ id, name: '', status: 'error', message: 'Account not found' })
      continue
    }
    if (demo.has(id)) {
      results.push({ id, name: row.name, status: 'skipped', message: 'A demo account cannot be changed' })
      continue
    }
    try {
      await deleteAccount(c.env, userId, id)
      await audit(c.env, userId, id, 'delete_account', row.name, null)
      results.push({ id, name: row.name, status: 'success' })
    } catch (error) {
      const message = errorMessage(error)
      await audit(c.env, userId, id, 'delete_account', row.name, message, 'error')
      results.push({ id, name: row.name, status: 'error', message })
    }
  }
  return c.json({ summary: summarize(results), results })
})

accountsRouter.post('/batch/proxy', async (c) => {
  // Outbound proxies are a Node capability; workerd has no HTTP/SOCKS agent, so the reference module's
  // proxy switch would be a control that silently does nothing. Answered for completeness: every row
  // is skipped and no setting is written.
  const body = await jsonObject(c)
  const ids = readIds(body)
  const results: BatchRow[] = ids.map((id) => ({
    id,
    name: '',
    status: 'skipped',
    message: 'Outbound proxies are not available on Workers',
  }))
  return c.json({ summary: summarize(results), results })
})

// ---------------------------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------------------------

accountsRouter.get('/:id/credentials', async (c) => {
  const userId = c.get('userId')
  const row = await getAccountRow(c.env, userId, c.req.param('id'))
  if (!row) throw ApiError.notFound('That Cloudflare account does not exist')
  const credentials = (await readAccountCredentials(c.env, row.id)) ?? {}
  await audit(c.env, userId, row.id, 'view_credentials', row.name, `auth_type=${row.auth_type}`)
  return c.json({
    id: row.id,
    name: row.name,
    auth_type: row.auth_type,
    email: row.email,
    cf_account_id: row.cf_account_id,
    api_token: credentials.api_token ?? null,
    api_key: credentials.api_key ?? null,
    password: credentials.password ?? null,
  })
})

accountsRouter.put('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const row = await getAccountRow(c.env, userId, id)
  if (!row) throw ApiError.notFound('That Cloudflare account does not exist')
  await assertNotDemo(c.env, userId, id)

  const body = await jsonObject(c)
  const input: UpdateAccountInput = {}
  const changed: string[] = []
  const name = optionalString(body, 'name')
  if (name !== undefined) {
    input.name = name
    changed.push('name')
  }
  if (body.auth_type !== undefined) {
    input.auth_type = readAuthType(body)
    changed.push('auth_type')
  }
  const email = optionalNullableString(body, 'email')
  if (email !== undefined) {
    input.email = email
    changed.push('email')
  }
  const cfAccountId = optionalNullableString(body, 'cf_account_id')
  if (cfAccountId !== undefined) {
    input.cf_account_id = cfAccountId
    changed.push('cf_account_id')
  }
  const active = optionalBoolean(body, 'is_active')
  if (active !== undefined) {
    input.is_active = active
    changed.push('is_active')
  }
  const features = optionalString(body, 'enabled_features')
  if (features !== undefined) {
    input.enabled_features = normalizeFeatures(features)
    changed.push('enabled_features')
  }
  const available = optionalString(body, 'available_features')
  if (available !== undefined) input.available_features = available
  const token = optionalSecret(body, 'api_token')
  if (token !== undefined) {
    input.api_token = token
    changed.push('api_token')
  }
  const apiKey = optionalSecret(body, 'api_key')
  if (apiKey !== undefined) {
    input.api_key = apiKey
    changed.push('api_key')
  }
  const password = optionalString(body, 'password')
  if (password !== undefined) {
    input.password = password
    changed.push('password')
  }
  if (changed.length === 0) throw ApiError.badRequest('No fields to update')

  const account = await updateAccount(c.env, userId, id, input)
  await audit(c.env, userId, id, 'update_account', account.name, `fields=${changed.join(',')}`)
  return c.json(account)
})

accountsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const row = await getAccountRow(c.env, userId, id)
  if (!row) throw ApiError.notFound('That Cloudflare account does not exist')
  await assertNotDemo(c.env, userId, id)
  await deleteAccount(c.env, userId, id)
  await audit(c.env, userId, id, 'delete_account', row.name, null)
  return c.json({ id })
})

accountsRouter.patch('/:id/features', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const row = await getAccountRow(c.env, userId, id)
  if (!row) throw ApiError.notFound('That Cloudflare account does not exist')
  await assertNotDemo(c.env, userId, id)
  const body = await jsonObject(c)
  const raw = optionalString(body, 'enabled_features')
  if (raw === undefined) throw ApiError.badRequest('enabled_features is required')
  const enabledFeatures = normalizeFeatures(raw)
  await c.env.DB.prepare(
    'UPDATE cloudflare_account SET enabled_features = ?, updated_at = ? WHERE user_id = ? AND id = ?',
  )
    .bind(enabledFeatures, Date.now(), userId, id)
    .run()
  await audit(c.env, userId, id, 'update_features', row.name, enabledFeatures)
  return c.json({ id, enabled_features: enabledFeatures })
})

accountsRouter.post('/:id/clear-exhausted', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const row = await getAccountRow(c.env, userId, id)
  if (!row) throw ApiError.notFound('That Cloudflare account does not exist')
  await assertNotDemo(c.env, userId, id)
  await clearExhausted(c.env, userId, id)
  await audit(c.env, userId, id, 'clear_exhausted', row.name, null)
  return c.json({ id })
})

accountsRouter.post('/:id/test', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const row = await getAccountRow(c.env, userId, id)
  if (!row) throw ApiError.notFound('That Cloudflare account does not exist')
  await assertNotDemo(c.env, userId, id)
  try {
    const outcome = await testAccount(c.env, userId, id)
    await audit(c.env, userId, id, 'test_account', row.name, `cf_account_id=${outcome.cf_account_id ?? ''}`)
    return c.json(outcome)
  } catch (error) {
    await audit(c.env, userId, id, 'test_account', row.name, errorMessage(error), 'error')
    throw error
  }
})
