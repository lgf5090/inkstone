import { MAX_ACCOUNTS } from '@shared/development/github/limits'
import type { GithubAccountView } from '@shared/development/github/types'
import type { Env } from '../../env'
import { CryptoUnavailableError, decryptGithubToken, encryptGithubToken } from '../../lib/crypto'
import { ApiError } from '../../lib/errors'
import { newId } from '../../lib/id'
import { fetchGithubUser } from './github-http'

interface AccountRow {
  id: string
  username: string
  avatar_url: string
  token_ciphertext: string
  created_at: number
  updated_at: number
}

export interface GithubAccountRecord extends GithubAccountView {
  tokenCiphertext: string
}

const VIEW_COLUMNS = 'id, username, avatar_url, created_at, updated_at'
const RECORD_COLUMNS = `${VIEW_COLUMNS}, token_ciphertext`

function toView(row: AccountRow): GithubAccountView {
  return {
    id: row.id,
    username: row.username,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRecord(row: AccountRow): GithubAccountRecord {
  return {
    ...toView(row),
    tokenCiphertext: row.token_ciphertext,
  }
}

function tokenInvalid(): ApiError {
  return new ApiError(
    400,
    'github_token_invalid',
    'The saved GitHub token could not be read. Add the account again',
  )
}

export async function listAccountViews(db: D1Database, userId: string): Promise<GithubAccountView[]> {
  const { results } = await db
    .prepare(
      `SELECT ${VIEW_COLUMNS} FROM development_github_accounts
        WHERE user_id = ?1
        ORDER BY updated_at DESC`,
    )
    .bind(userId)
    .all<AccountRow>()
  return results.map(toView)
}

export async function listAccountRecords(
  db: D1Database,
  userId: string,
): Promise<GithubAccountRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM development_github_accounts
        WHERE user_id = ?1
        ORDER BY updated_at DESC`,
    )
    .bind(userId)
    .all<AccountRow>()
  return results.map(toRecord)
}

export async function findAccountById(
  db: D1Database,
  userId: string,
  id: string,
): Promise<GithubAccountRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM development_github_accounts WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<AccountRow>()
  return row ? toRecord(row) : null
}

export async function findAccountByUsername(
  db: D1Database,
  userId: string,
  username: string,
): Promise<GithubAccountRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM development_github_accounts
        WHERE user_id = ?1 AND username = ?2 COLLATE NOCASE`,
    )
    .bind(userId, username)
    .first<AccountRow>()
  return row ? toRecord(row) : null
}

export async function countAccounts(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM development_github_accounts WHERE user_id = ?1')
    .bind(userId)
    .first<{ count: number }>()
  return Number(row?.count ?? 0)
}

export async function addGithubAccount(
  env: Env,
  db: D1Database,
  userId: string,
  token: string,
): Promise<GithubAccountView> {
  const trimmed = token.trim()
  if (!trimmed) throw new ApiError(400, 'github_token_required', 'A GitHub token is required')
  const user = await fetchGithubUser(trimmed)
  const existing = await findAccountByUsername(db, userId, user.login)
  if (!existing && (await countAccounts(db, userId)) >= MAX_ACCOUNTS) {
    throw ApiError.badRequest(`GitHub accounts are limited to ${MAX_ACCOUNTS} per account`)
  }
  const id = existing?.id ?? newId()
  const ciphertext = await encryptGithubToken(env, id, trimmed)
  const now = Date.now()
  await db
    .prepare(
      `INSERT INTO development_github_accounts
         (user_id, id, username, avatar_url, token_ciphertext, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (user_id, id) DO UPDATE SET
         username = excluded.username,
         avatar_url = excluded.avatar_url,
         token_ciphertext = excluded.token_ciphertext,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, id, user.login, user.avatarUrl, ciphertext, existing?.createdAt ?? now, now)
    .run()
  return {
    id,
    username: user.login,
    avatarUrl: user.avatarUrl,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(user.scopes === null ? {} : { gistScope: user.scopes.includes('gist') }),
  }
}

export async function deleteGithubAccount(
  db: D1Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM development_github_accounts WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function decryptAccountToken(
  env: Env,
  record: GithubAccountRecord,
): Promise<string | null> {
  try {
    return await decryptGithubToken(env, record.id, record.tokenCiphertext)
  } catch (error) {
    if (error instanceof CryptoUnavailableError) throw error
    console.warn('[inkstone] Opening a development github account token failed:', error)
    return null
  }
}

export async function effectiveGithubToken(
  env: Env,
  db: D1Database,
  userId: string,
  accountId?: string,
): Promise<string | null> {
  if (accountId) {
    const record = await findAccountById(db, userId, accountId)
    if (!record) {
      throw new ApiError(404, 'github_not_found', 'The GitHub account was not found')
    }
    const token = await decryptAccountToken(env, record)
    if (!token) throw tokenInvalid()
    return token
  }
  const records = await listAccountRecords(db, userId)
  if (records.length === 0) return null
  for (const record of records) {
    const token = await decryptAccountToken(env, record)
    if (token) return token
  }
  throw tokenInvalid()
}

export async function githubTokenForUsername(
  env: Env,
  db: D1Database,
  userId: string,
  username: string,
): Promise<string | null> {
  const record = await findAccountByUsername(db, userId, username)
  if (!record) return null
  return await decryptAccountToken(env, record)
}
