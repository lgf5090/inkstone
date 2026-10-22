import { MEMO_PAT_BYTES, MEMO_PAT_PREFIX } from '@shared/memos/constants'
import type { MemoToken, MemoTokenCreateInput, MemoTokenCreateResult } from '@shared/memos/types'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { createOpaqueToken, hashOpaqueToken, tokenPrefix } from './tokens'

export const MEMO_TOKEN_DESCRIPTION_MAX_LENGTH = 128

const MAX_TOKEN_ID_ATTEMPTS = 5

const TOKEN_COLUMNS = 'id, description, prefix, expires_at, created_at, last_used_at'

interface TokenRow {
  id: string
  description: string
  prefix: string
  expires_at: number | null
  created_at: number
  last_used_at: number | null
}

export interface MemoTokenOwner {
  id: string
  userId: string
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function toToken(row: TokenRow): MemoToken {
  return {
    id: row.id,
    description: row.description,
    prefix: row.prefix,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

function tokenDescription(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('Token description must be a string')
  const description = value.trim()
  if (description.length > MEMO_TOKEN_DESCRIPTION_MAX_LENGTH) {
    throw ApiError.badRequest(
      `Token description cannot exceed ${MEMO_TOKEN_DESCRIPTION_MAX_LENGTH} characters`,
    )
  }
  return description
}

function tokenExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw ApiError.badRequest('expiresAt must be a Unix timestamp in seconds')
  }
  if (value <= nowSeconds()) throw ApiError.badRequest('expiresAt must be in the future')
  return value
}

export async function createToken(
  db: D1Database,
  userId: string,
  input: MemoTokenCreateInput,
): Promise<MemoTokenCreateResult> {
  const description = tokenDescription(input.description)
  const expiresAt = tokenExpiry(input.expiresAt)
  const now = nowSeconds()

  for (let attempt = 0; attempt < MAX_TOKEN_ID_ATTEMPTS; attempt++) {
    const id = newId()
    const token = createOpaqueToken(MEMO_PAT_PREFIX, MEMO_PAT_BYTES)
    const prefix = tokenPrefix(token)
    const tokenHash = await hashOpaqueToken(token)
    const { meta } = await db
      .prepare(
        `INSERT OR IGNORE INTO memos_tokens
           (id, user_id, token_hash, prefix, description, expires_at, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)`,
      )
      .bind(id, userId, tokenHash, prefix, description, expiresAt, now)
      .run()
    if (meta.changes > 0) {
      return {
        token,
        tokenInfo: { id, description, prefix, expiresAt, createdAt: now, lastUsedAt: null },
      }
    }
  }
  throw ApiError.conflict('Could not allocate a token id. Try again')
}

export async function listTokens(db: D1Database, userId: string): Promise<MemoToken[]> {
  const { results } = await db
    .prepare(
      `SELECT ${TOKEN_COLUMNS}
         FROM memos_tokens
        WHERE user_id = ?1
        ORDER BY created_at DESC, id DESC`,
    )
    .bind(userId)
    .all<TokenRow>()
  return results.map(toToken)
}

export async function revokeToken(db: D1Database, userId: string, id: string): Promise<boolean> {
  const { meta } = await db
    .prepare('DELETE FROM memos_tokens WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .run()
  return meta.changes > 0
}

export async function findToken(db: D1Database, token: string): Promise<MemoTokenOwner | null> {
  if (!token.startsWith(MEMO_PAT_PREFIX)) return null
  const now = nowSeconds()
  const row = await db
    .prepare(
      `SELECT id, user_id
         FROM memos_tokens
        WHERE token_hash = ?1 AND (expires_at IS NULL OR expires_at > ?2)
        LIMIT 1`,
    )
    .bind(await hashOpaqueToken(token), now)
    .first<{ id: string; user_id: string }>()
  if (!row) return null
  await db
    .prepare('UPDATE memos_tokens SET last_used_at = ?1 WHERE id = ?2')
    .bind(now, row.id)
    .run()
  return { id: row.id, userId: row.user_id }
}
