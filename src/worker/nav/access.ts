import { ApiError } from '../lib/errors'
import { hashPassword, verifyPassword } from '../lib/password'
import { sha256Hex, timingSafeEqual, toBase64Url } from '../lib/encoding'
import { NAV_LIMITS, type NavCategory, type NavPasswordMode } from '@shared/nav/model'

export interface NavCategoryRow {
  id: string
  user_id: string
  name: string
  icon: string
  parent_id: string | null
  password_hash: string | null
  use_default_password: number
  sort_order: number
  created_at: number
  updated_at: number
}

export function passwordModeOf(row: Pick<NavCategoryRow, 'password_hash' | 'use_default_password'>): NavPasswordMode {
  if (row.use_default_password) return 'default'
  return row.password_hash ? 'custom' : 'none'
}

export function rowToCategory(row: NavCategoryRow): NavCategory {
  const mode = passwordModeOf(row)
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    parentId: row.parent_id,
    hasPassword: mode !== 'none',
    passwordMode: mode,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  }
}

export const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000
const ATTEMPT_LIMIT = 10
const attempts = new Map<string, { count: number; resetAt: number }>()

function attemptKey(userId: string, categoryId: string): string {
  return `${userId}:${categoryId}`
}

export function assertUnlockAllowed(userId: string, categoryId: string): void {
  const now = Date.now()
  const entry = attempts.get(attemptKey(userId, categoryId))
  if (!entry || entry.resetAt <= now) {
    if (attempts.size > 2048) {
      for (const [key, value] of attempts) {
        if (value.resetAt <= now) attempts.delete(key)
      }
      if (attempts.size > 2048) attempts.clear()
    }
    attempts.set(attemptKey(userId, categoryId), { count: 0, resetAt: now + ATTEMPT_WINDOW_MS })
    return
  }
  if (entry.count >= ATTEMPT_LIMIT) throw new ApiError(429, 'too_many_attempts', 'Too many attempts, try again later')
}

export function recordUnlockFailure(userId: string, categoryId: string): void {
  const now = Date.now()
  const key = attemptKey(userId, categoryId)
  const entry = attempts.get(key)
  if (!entry || entry.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS })
  else entry.count += 1
}

export async function verifyCategoryPassword(
  row: Pick<NavCategoryRow, 'password_hash' | 'use_default_password'>,
  input: string,
  defaultPassword: string | undefined,
): Promise<boolean> {
  if (row.use_default_password) {
    if (!defaultPassword) {
      throw new ApiError(503, 'nav_default_password_not_configured', 'The server has no default category password configured')
    }
    return timingSafeEqual(input, defaultPassword)
  }
  if (!row.password_hash) return true
  return verifyPassword(input, row.password_hash)
}

export async function newCategoryPasswordHash(password: string): Promise<string> {
  return hashPassword(password)
}

export function parseUnlockTokens(header: string | undefined): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((token) => token.trim())
    .filter((token) => /^[A-Za-z0-9_-]{43}$/.test(token))
    .slice(0, NAV_LIMITS.unlockTokens)
}

export async function resolveUnlockedCategoryIds(
  db: D1Database,
  userId: string,
  tokens: readonly string[],
): Promise<Set<string>> {
  if (!tokens.length) return new Set()
  const hashes = await Promise.all(tokens.map((token) => sha256Hex(token)))
  const placeholders = hashes.map((_, index) => `?${index + 3}`).join(', ')
  const { results } = await db
    .prepare(`SELECT category_id FROM nav_category_unlocks WHERE user_id = ?1 AND expires_at > ?2 AND token_hash IN (${placeholders})`)
    .bind(userId, Date.now(), ...hashes)
    .all<{ category_id: string }>()
  return new Set(results.map((row) => row.category_id))
}

export async function createCategoryUnlock(
  db: D1Database,
  userId: string,
  categoryId: string,
): Promise<{ token: string; expiresAt: number }> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = toBase64Url(bytes)
  const expiresAt = Date.now() + UNLOCK_TTL_MS
  await db
    .prepare(`INSERT INTO nav_category_unlocks (user_id, category_id, token_hash, expires_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(user_id, category_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, created_at = excluded.created_at`)
    .bind(userId, categoryId, await sha256Hex(token), expiresAt, Date.now())
    .run()
  return { token, expiresAt }
}

export async function clearCategoryUnlocks(db: D1Database, userId: string, categoryId: string): Promise<void> {
  await db.prepare('DELETE FROM nav_category_unlocks WHERE user_id = ?1 AND category_id = ?2').bind(userId, categoryId).run()
}
