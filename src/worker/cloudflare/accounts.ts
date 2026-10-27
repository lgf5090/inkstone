/**
 * Cloudflare accounts: the rows, the credential bundle beside them, and what Cloudflare says about
 * the credential when it is first offered.
 *
 * The reference module kept credentials inside its account row, encrypted with a key derived from the
 * reader's login password. That key does not exist here: a reader's session is an opaque cookie, and
 * the only encryption key this deployment has is the credential vault's. So the rows keep identity
 * and preferences, and the secrets live in R2 (`credentials.ts`). `has_credentials` is the join
 * between the two.
 */
import { newId } from '../lib/id'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { CF_API_BASE, cfFetch, CloudflareApiError, type CloudflareAuth } from './cf-api'
import {
  deleteAccountCredentials,
  readAccountCredentials,
  writeAccountCredentials,
  type CloudflareCredentials,
} from './credentials'
import { readSettings, DEMO_ACCOUNT_IDS_KEY } from './settings'

export type CloudflareAuthType = 'token' | 'global_key'
export type CloudflareFeature = 'ai' | 'workers' | 'browser_render' | 'dns' | 'storage'

export const ALL_FEATURES: readonly CloudflareFeature[] = ['ai', 'workers', 'browser_render', 'dns', 'storage']
export const DEFAULT_FEATURES = 'ai,workers,browser_render,dns,storage'

export interface CloudflareAccountRow {
  id: string
  user_id: string
  name: string
  auth_type: CloudflareAuthType
  email: string | null
  cf_account_id: string | null
  is_active: number
  enabled_features: string
  available_features: string
  has_credentials: number
  created_at: number
  updated_at: number
}

export interface CloudflareAccountView extends CloudflareAccountRow {
  is_demo: boolean
}

export interface AccountListFilter {
  filter?: 'all' | 'active' | 'unverified'
  search?: string
  limit?: number
  offset?: number
}

export interface AccountCounts {
  all: number
  active: number
  unverified: number
}

export interface AccountPage {
  accounts: CloudflareAccountView[]
  total: number
  counts: AccountCounts
}

export interface CreateAccountInput {
  name: string
  auth_type: CloudflareAuthType
  email?: string | null
  cf_account_id?: string | null
  enabled_features?: string
  is_active?: boolean
  api_token?: string
  api_key?: string
  password?: string
}

export interface UpdateAccountInput {
  name?: string
  auth_type?: CloudflareAuthType
  email?: string | null
  cf_account_id?: string | null
  is_active?: boolean
  enabled_features?: string
  available_features?: string
  api_token?: string
  api_key?: string
  password?: string
}

/** The auth material one upstream call needs, decrypted for this request only. */
export interface LoadedAccount {
  row: CloudflareAccountRow
  auth: CloudflareAuth
}

const ACCOUNT_COLUMNS = `id, user_id, name, auth_type, email, cf_account_id, is_active,
  enabled_features, available_features, has_credentials, created_at, updated_at`

export async function listAccounts(
  env: Env,
  userId: string,
  options: AccountListFilter = {},
): Promise<AccountPage> {
  await purgeDeletedAccounts(env, userId)
  const filter = options.filter ?? 'all'
  const conditions = ['user_id = ?']
  const values: unknown[] = [userId]
  if (filter === 'active') conditions.push('is_active = 1')
  if (filter === 'unverified') conditions.push("(cf_account_id IS NULL OR cf_account_id = '')")
  const search = (options.search ?? '').trim()
  if (search) {
    conditions.push('(name LIKE ? OR email LIKE ?)')
    values.push(`%${search}%`, `%${search}%`)
  }
  const where = conditions.join(' AND ')
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  const offset = Math.max(options.offset ?? 0, 0)

  const total = await env.DB.prepare(`SELECT count(*) AS n FROM cloudflare_account WHERE ${where}`)
    .bind(...values)
    .first<{ n: number }>()
  const rows = await env.DB.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM cloudflare_account WHERE ${where}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...values, limit, offset)
    .all<CloudflareAccountRow>()
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM cloudflare_account WHERE user_id = ?1) AS "all",
       (SELECT count(*) FROM cloudflare_account WHERE user_id = ?1 AND is_active = 1) AS active,
       (SELECT count(*) FROM cloudflare_account WHERE user_id = ?1
          AND (cf_account_id IS NULL OR cf_account_id = '')) AS unverified`,
  )
    .bind(userId)
    .first<AccountCounts>()

  const demo = await demoAccountIds(env, userId)
  return {
    accounts: (rows.results ?? []).map((row) => toView(row, demo)),
    total: total?.n ?? 0,
    counts: counts ?? { all: 0, active: 0, unverified: 0 },
  }
}

/** Every target a batch test can run against; the unverified filter is the screen's own. */
export async function listAccountTargets(
  env: Env,
  userId: string,
  onlyUnverified: boolean,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await env.DB.prepare(
    `SELECT id, name FROM cloudflare_account
      WHERE user_id = ?${onlyUnverified ? " AND (cf_account_id IS NULL OR cf_account_id = '')" : ''}
      ORDER BY created_at ASC, id ASC`,
  )
    .bind(userId)
    .all<{ id: string; name: string }>()
  return rows.results ?? []
}

/** The emails a CSV import may not duplicate, lower-cased. */
export async function listAccountEmails(env: Env, userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT lower(email) AS email FROM cloudflare_account
      WHERE user_id = ? AND email IS NOT NULL AND email <> ''`,
  )
    .bind(userId)
    .all<{ email: string }>()
  return (rows.results ?? []).map((row) => row.email)
}

export async function setAccountFeatures(
  env: Env,
  userId: string,
  id: string,
  features: string,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE cloudflare_account SET enabled_features = ?, updated_at = ? WHERE user_id = ? AND id = ?',
  )
    .bind(features, Date.now(), userId, id)
    .run()
}

export async function getAccountRow(
  env: Env,
  userId: string,
  id: string,
): Promise<CloudflareAccountRow | null> {
  return await env.DB.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM cloudflare_account WHERE user_id = ? AND id = ?`,
  )
    .bind(userId, id)
    .first<CloudflareAccountRow>()
}

/** Row plus its decrypted auth material. 404 covers both "no such row" and "another reader's row". */
export async function loadAccount(env: Env, userId: string, id: string): Promise<LoadedAccount> {
  const row = await getAccountRow(env, userId, id)
  if (!row) throw ApiError.notFound('That Cloudflare account does not exist')
  const credentials = (await readAccountCredentials(env, id)) ?? {}
  const auth: CloudflareAuth = {
    auth_type: row.auth_type,
    api_token: credentials.api_token ?? null,
    api_key: credentials.api_key ?? null,
    email: row.email,
  }
  return { row, auth }
}

/** List every active account with its credentials; callers that fan out (DNS zones, quota) use this. */
export async function loadActiveAccounts(env: Env, userId: string): Promise<LoadedAccount[]> {
  const rows = await env.DB.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM cloudflare_account WHERE user_id = ? AND is_active = 1 ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all<CloudflareAccountRow>()
  // Every account needs its own R2 read and vault decrypt; awaiting them one by one made the
  // dashboard wait for the slowest of them in sequence.
  const loaded = await Promise.all((rows.results ?? []).map(async (row): Promise<LoadedAccount> => {
    const credentials = (await readAccountCredentials(env, row.id)) ?? {}
    return {
      row,
      auth: {
        auth_type: row.auth_type,
        api_token: credentials.api_token ?? null,
        api_key: credentials.api_key ?? null,
        email: row.email,
      },
    }
  }))
  return loaded
}

export function accountHasFeature(
  row: Pick<CloudflareAccountRow, 'enabled_features'>,
  feature: CloudflareFeature,
): boolean {
  const raw = (row.enabled_features || DEFAULT_FEATURES).split(',').map((item) => item.trim()).filter(Boolean)
  if (raw.length === 0) return ALL_FEATURES.includes(feature)
  return raw.includes(feature)
}

export async function createAccount(
  env: Env,
  userId: string,
  input: CreateAccountInput,
): Promise<CloudflareAccountView> {
  const name = input.name.trim()
  if (!name) throw ApiError.badRequest('A name is required')
  const authType = input.auth_type
  if (authType !== 'token' && authType !== 'global_key') {
    throw ApiError.badRequest('auth_type must be token or global_key')
  }
  const apiToken = input.api_token?.trim() || undefined
  const apiKey = input.api_key?.trim() || undefined
  const email = input.email?.trim() || null
  if (authType === 'token' && !apiToken) throw ApiError.badRequest('A token account needs an API token')
  if (authType === 'global_key' && (!apiKey || !email)) {
    throw ApiError.badRequest('A global-key account needs an API key and an email')
  }

  const auth: CloudflareAuth = {
    auth_type: authType,
    api_token: apiToken ?? null,
    api_key: apiKey ?? null,
    email,
  }
  await verifyCredential(auth)

  const id = newId()
  const credentials: CloudflareCredentials = {}
  if (apiToken) credentials.api_token = apiToken
  if (apiKey) credentials.api_key = apiKey
  if (input.password?.trim()) credentials.password = input.password.trim()

  // The file is written first: a row that says it has a credential must have one, and a file without
  // a row is invisible garbage rather than a lie the screens would show.
  const hasCredentials = await writeAccountCredentials(env, id, credentials)
  const now = Date.now()
  try {
    await env.DB.prepare(
      `INSERT INTO cloudflare_account
        (id, user_id, name, auth_type, email, cf_account_id, is_active, enabled_features,
         available_features, has_credentials, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
    )
      .bind(
        id,
        userId,
        name,
        authType,
        email,
        input.cf_account_id?.trim() || null,
        input.is_active === false ? 0 : 1,
        input.enabled_features?.trim() || DEFAULT_FEATURES,
        hasCredentials ? 1 : 0,
        now,
        now,
      )
      .run()
  } catch (error) {
    await deleteAccountCredentials(env, id).catch(() => undefined)
    throw error
  }

  // Both follow-ups are best-effort facts about the credential, not the write itself: a token that
  // verified but cannot list accounts is still a usable token for some products.
  const detected = await detectAccountId(auth)
  if (detected && !input.cf_account_id) {
    await env.DB.prepare('UPDATE cloudflare_account SET cf_account_id = ?, updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(detected, Date.now(), userId, id)
      .run()
  }
  const available = await probeFeatures(auth, detected ?? input.cf_account_id?.trim() ?? null)
  if (available) {
    await env.DB.prepare('UPDATE cloudflare_account SET available_features = ?, updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(available, Date.now(), userId, id)
      .run()
  }

  const row = await getAccountRow(env, userId, id)
  if (!row) throw new ApiError(500, 'internal', 'The account was written but cannot be read back')
  return toView(row, await demoAccountIds(env, userId))
}

export async function updateAccount(
  env: Env,
  userId: string,
  id: string,
  input: UpdateAccountInput,
): Promise<CloudflareAccountView> {
  const row = await getAccountRow(env, userId, id)
  if (!row) throw ApiError.notFound('That Cloudflare account does not exist')

  const nextAuthType = input.auth_type ?? row.auth_type
  if (nextAuthType !== 'token' && nextAuthType !== 'global_key') {
    throw ApiError.badRequest('auth_type must be token or global_key')
  }
  const switching = nextAuthType !== row.auth_type
  const newToken = input.api_token?.trim() || undefined
  const newKey = input.api_key?.trim() || undefined
  const nextEmail = input.email === undefined ? row.email : (input.email?.trim() || null)
  if (switching && nextAuthType === 'token' && !newToken) {
    throw ApiError.badRequest('Switching to a token account needs an API token')
  }
  if (switching && nextAuthType === 'global_key' && (!newKey || !nextEmail)) {
    throw ApiError.badRequest('Switching to a global-key account needs an API key and an email')
  }

  const existing = (await readAccountCredentials(env, id)) ?? {}
  if (newToken || newKey) {
    await verifyCredential({
      auth_type: nextAuthType,
      api_token: newToken ?? (switching ? null : existing.api_token ?? null),
      api_key: newKey ?? (switching ? null : existing.api_key ?? null),
      email: nextEmail,
    })
  }

  const patch: CloudflareCredentials = {}
  if (switching) patch.api_token = ''
  if (switching) patch.api_key = ''
  if (input.api_token !== undefined) patch.api_token = input.api_token
  if (input.api_key !== undefined) patch.api_key = input.api_key
  if (input.password !== undefined) patch.password = input.password
  const hasCredentials = await writeAccountCredentials(env, id, patch)

  const sets: string[] = ['auth_type = ?', 'has_credentials = ?', 'updated_at = ?']
  const values: unknown[] = [nextAuthType, hasCredentials ? 1 : 0, Date.now()]
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('A name is required')
    sets.push('name = ?')
    values.push(name)
  }
  if (input.email !== undefined) {
    sets.push('email = ?')
    values.push(nextEmail)
  }
  if (input.cf_account_id !== undefined) {
    sets.push('cf_account_id = ?')
    values.push((input.cf_account_id ?? '').trim() || null)
  }
  if (input.is_active !== undefined) {
    sets.push('is_active = ?')
    values.push(input.is_active ? 1 : 0)
  }
  if (input.enabled_features !== undefined) {
    sets.push('enabled_features = ?')
    values.push(input.enabled_features.trim() || DEFAULT_FEATURES)
  }
  if (input.available_features !== undefined) {
    sets.push('available_features = ?')
    values.push(input.available_features)
  }
  await env.DB.prepare(`UPDATE cloudflare_account SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`)
    .bind(...values, userId, id)
    .run()

  let fresh = await getAccountRow(env, userId, id)
  if (fresh && !fresh.cf_account_id) {
    const credentials = (await readAccountCredentials(env, id)) ?? {}
    const detected = await detectAccountId({
      auth_type: fresh.auth_type,
      api_token: credentials.api_token ?? null,
      api_key: credentials.api_key ?? null,
      email: fresh.email,
    })
    if (detected) {
      await env.DB.prepare('UPDATE cloudflare_account SET cf_account_id = ?, updated_at = ? WHERE user_id = ? AND id = ?')
        .bind(detected, Date.now(), userId, id)
        .run()
      fresh = await getAccountRow(env, userId, id)
    }
  }
  if (!fresh) throw new ApiError(500, 'internal', 'The account was written but cannot be read back')
  return toView(fresh, await demoAccountIds(env, userId))
}

/**
 * Delete an account the way a reader expects a delete next to an undo to behave.
 *
 * The row leaves every list at once, but the row itself and its sealed credential file wait in the
 * trash for the grace window: restoring is a plain insert, and nothing about the credential has to be
 * re-entered. Today's counters wait as well, so an undo does not bring back a blank card.
 */
export async function deleteAccount(env: Env, userId: string, id: string): Promise<void> {
  const row = await getAccountRow(env, userId, id)
  if (!row) throw ApiError.notFound('That Cloudflare account does not exist')
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO cloudflare_account_trash
        (id, user_id, name, auth_type, email, cf_account_id, is_active, enabled_features,
         available_features, has_credentials, created_at, updated_at, deleted_at)
       SELECT id, user_id, name, auth_type, email, cf_account_id, is_active, enabled_features,
              available_features, has_credentials, created_at, updated_at, ?
         FROM cloudflare_account WHERE user_id = ? AND id = ?`,
    ).bind(Date.now(), userId, id),
    env.DB.prepare('DELETE FROM cloudflare_account WHERE user_id = ? AND id = ?').bind(userId, id),
  ])
}

/** How long a deleted account can be brought back before its credential file goes with it. */
export const ACCOUNT_UNDO_GRACE_MS = 60_000

/** Take a deletion back, within the grace window only: past it the row has been purged. */
export async function restoreAccount(
  env: Env,
  userId: string,
  id: string,
): Promise<CloudflareAccountRow> {
  const trashed = await env.DB.prepare(
    'SELECT * FROM cloudflare_account_trash WHERE user_id = ? AND id = ?',
  )
    .bind(userId, id)
    .first<CloudflareAccountRow & { deleted_at: number }>()
  if (!trashed) throw ApiError.notFound('That deleted account can no longer be restored')
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cloudflare_account
        (id, user_id, name, auth_type, email, cf_account_id, is_active, enabled_features,
         available_features, has_credentials, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      trashed.id,
      trashed.user_id,
      trashed.name,
      trashed.auth_type,
      trashed.email,
      trashed.cf_account_id,
      trashed.is_active,
      trashed.enabled_features,
      trashed.available_features,
      trashed.has_credentials,
      trashed.created_at,
      trashed.updated_at,
    ),
    env.DB.prepare('DELETE FROM cloudflare_account_trash WHERE user_id = ? AND id = ?').bind(userId, id),
  ])
  const row = await getAccountRow(env, userId, id)
  if (!row) throw new ApiError(500, 'internal', 'The account was restored but cannot be read back')
  return row
}

/**
 * Drop whatever outlived the undo window, credential file included.
 *
 * Runs on the account list rather than on a timer: the list is where a reader notices the trash, and a
 * deployment that never opens it has nothing to leak.
 */
export async function purgeDeletedAccounts(env: Env, userId: string): Promise<void> {
  const stale = await env.DB.prepare(
    'SELECT id FROM cloudflare_account_trash WHERE user_id = ? AND deleted_at < ?',
  )
    .bind(userId, Date.now() - ACCOUNT_UNDO_GRACE_MS)
    .all<{ id: string }>()
  for (const row of stale.results ?? []) {
    await deleteAccountCredentials(env, row.id)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM cloudflare_quota_usage WHERE user_id = ? AND account_id = ?').bind(userId, row.id),
      env.DB.prepare('DELETE FROM cloudflare_account_trash WHERE user_id = ? AND id = ?').bind(userId, row.id),
    ])
  }
}

/** Re-check a stored credential against Cloudflare, and refresh what the account can do. */
export async function testAccount(
  env: Env,
  userId: string,
  id: string,
): Promise<{ ok: true; cf_account_id: string | null; available_features: string }> {
  const { row, auth } = await loadAccount(env, userId, id)
  await verifyCredential(auth)
  const detected = row.cf_account_id ?? (await detectAccountId(auth))
  const available = (await probeFeatures(auth, detected)) ?? ''
  await env.DB.prepare(
    'UPDATE cloudflare_account SET cf_account_id = ?, available_features = ?, updated_at = ? WHERE user_id = ? AND id = ?',
  )
    .bind(detected, available, Date.now(), userId, id)
    .run()
  return { ok: true, cf_account_id: detected, available_features: available }
}

/**
 * Verify one credential pair against `/user`.
 *
 * This is deliberately the only verification call: every Cloudflare product answers 403 for a token
 * scoped to another product, and using a product endpoint here would refuse valid narrow tokens.
 */
export async function verifyCredential(auth: CloudflareAuth): Promise<void> {
  try {
    await cfFetch<{ result?: unknown }>(auth, '/user')
  } catch (error) {
    const message = error instanceof CloudflareApiError ? error.message : (error as Error)?.message
    throw ApiError.badRequest(`Cloudflare refused this credential: ${message ?? 'unknown error'}`)
  }
}

async function detectAccountId(auth: CloudflareAuth): Promise<string | null> {
  try {
    const body = await cfFetch<{ result?: Array<{ id?: string }> }>(auth, '/accounts?per_page=1')
    return body.result?.[0]?.id ?? null
  } catch (error) {
    console.warn('[inkstone] Cloudflare account discovery failed:', (error as Error)?.message)
    return null
  }
}

/** Whether R2 is switched on for this account, as the string the account row stores. */
async function probeFeatures(auth: CloudflareAuth, cfAccountId: string | null): Promise<string | null> {
  if (!cfAccountId) return null
  try {
    await cfFetch<{ result?: unknown }>(auth, `/accounts/${cfAccountId}/r2/buckets?per_page=1`)
    return 'r2'
  } catch (error) {
    const message = (error as Error)?.message ?? ''
    if (/10042|enable R2|Please enable R2/i.test(message)) return '-r2'
    console.warn('[inkstone] Cloudflare feature probe failed:', message)
    return null
  }
}

export async function demoAccountIds(env: Env, userId: string): Promise<Set<string>> {
  const settings = await readSettings(env, userId)
  return new Set(settings[DEMO_ACCOUNT_IDS_KEY] ? settings[DEMO_ACCOUNT_IDS_KEY]!.split(',').map((id) => id.trim()).filter(Boolean) : [])
}

export async function assertNotDemo(env: Env, userId: string, accountId: string): Promise<void> {
  const demo = await demoAccountIds(env, userId)
  if (demo.has(accountId)) throw ApiError.forbidden('A demo account cannot be changed')
}

export function toView(row: CloudflareAccountRow, demo: Set<string>): CloudflareAccountView {
  return { ...row, is_demo: demo.has(row.id) }
}

export { CF_API_BASE }
