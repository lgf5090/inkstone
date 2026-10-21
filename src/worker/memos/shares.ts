import type { MemoShare, MemoState } from '@shared/memos/types'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { createShareToken, hashOpaqueToken } from './tokens'

const SHARE_URL_PREFIX = '/memos/s/'
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_SHARE_ID_ATTEMPTS = 5
const SHARE_LIST_COLUMNS = 's.id, s.memo_id, s.expires_at, s.created_at'

export interface MemoShareFields {
  expiresAt?: unknown
}

export interface MemoShareRow {
  id: string
  user_id: string
  memo_id: string
  expires_at: number | null
  created_at: number
  revoked_at: number | null
}

interface ShareListRow {
  id: string
  memo_id: string
  expires_at: number | null
  created_at: number
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function shareExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw ApiError.badRequest('expiresAt must be a Unix timestamp in seconds')
  }
  if (value <= nowSeconds()) throw ApiError.badRequest('expiresAt must be in the future')
  return value
}

async function loadOwnedMemo(
  db: D1Database,
  userId: string,
  memoId: string,
): Promise<{ state: MemoState }> {
  const row = await db
    .prepare('SELECT state FROM memos_items WHERE id = ?1 AND user_id = ?2')
    .bind(memoId, userId)
    .first<{ state: MemoState }>()
  if (!row) throw ApiError.notFound('Memo not found')
  return row
}

export async function createShare(
  db: D1Database,
  userId: string,
  memoId: string,
  expiresAt?: unknown,
): Promise<MemoShare> {
  const expiry = shareExpiry(expiresAt)
  const memo = await loadOwnedMemo(db, userId, memoId)
  if (memo.state !== 'normal') throw ApiError.conflict('Archived memos cannot be shared')
  const now = nowSeconds()

  for (let attempt = 0; attempt < MAX_SHARE_ID_ATTEMPTS; attempt++) {
    const id = newId()
    const { token, hash } = await createShareToken()
    const { meta } = await db
      .prepare(
        `INSERT OR IGNORE INTO memos_shares (id, user_id, memo_id, token_hash, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(id, userId, memoId, hash, expiry, now)
      .run()
    if (meta.changes > 0) {
      return {
        id,
        memoId,
        expiresAt: expiry,
        createdAt: now,
        url: `${SHARE_URL_PREFIX}${token}`,
      }
    }
  }
  throw ApiError.conflict('Could not allocate a share id. Try again')
}

export async function listShares(
  db: D1Database,
  userId: string,
  memoId: string,
): Promise<MemoShare[]> {
  await loadOwnedMemo(db, userId, memoId)
  const { results } = await db
    .prepare(
      `SELECT ${SHARE_LIST_COLUMNS}
         FROM memos_shares s
        WHERE s.user_id = ?1 AND s.memo_id = ?2 AND s.revoked_at IS NULL
        ORDER BY s.created_at ASC, s.id ASC`,
    )
    .bind(userId, memoId)
    .all<ShareListRow>()
  return results.map((row) => ({
    id: row.id,
    memoId: row.memo_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }))
}

export async function revokeShare(
  db: D1Database,
  userId: string,
  memoId: string,
  shareId: string,
): Promise<boolean> {
  const { meta } = await db
    .prepare(
      `UPDATE memos_shares
          SET revoked_at = ?4
        WHERE id = ?1 AND user_id = ?2 AND memo_id = ?3 AND revoked_at IS NULL`,
    )
    .bind(shareId, userId, memoId, nowSeconds())
    .run()
  return meta.changes > 0
}

export async function findShareByToken(
  db: D1Database,
  token: unknown,
): Promise<MemoShareRow | null> {
  if (typeof token !== 'string' || !SHARE_TOKEN_PATTERN.test(token)) return null
  const tokenHash = await hashOpaqueToken(token)
  return db
    .prepare(
      `SELECT s.id, s.user_id, s.memo_id, s.expires_at, s.created_at, s.revoked_at
         FROM memos_shares s
         JOIN memos_items m ON m.id = s.memo_id AND m.user_id = s.user_id
        WHERE s.token_hash = ?1 AND s.revoked_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > ?2)
          AND m.state = 'normal'
        LIMIT 1`,
    )
    .bind(tokenHash, nowSeconds())
    .first<MemoShareRow>()
}
