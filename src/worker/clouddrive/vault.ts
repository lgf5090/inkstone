import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'

export const VAULT_UNLOCK_HEADER = 'X-CloudDrive-Vault-Unlock'
export const VAULT_UNLOCK_TTL_MS = 10 * 60 * 1000

export async function issueVaultUnlock(
  db: D1Database,
  userId: string,
  mountId: string,
  path: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = newId()
  const now = Date.now()
  const expiresAt = now + VAULT_UNLOCK_TTL_MS
  await db.batch([
    db.prepare(`DELETE FROM CloudDrive_vault_unlocks WHERE user_id = ? AND expires_at <= ?`).bind(userId, now),
    db.prepare(
      `INSERT INTO CloudDrive_vault_unlocks (token_hash, user_id, mount_id, path, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(await sha256Hex(token), userId, mountId, path, expiresAt, now),
  ])
  return { token, expiresAt }
}

export async function isVaultUnlocked(
  db: D1Database,
  userId: string,
  mountId: string,
  path: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token || token.length > 200) return false
  const row = await db.prepare(
    `SELECT 1 AS found FROM CloudDrive_vault_unlocks
      WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3 AND token_hash = ?4 AND expires_at > ?5`,
  ).bind(userId, mountId, path, await sha256Hex(token), Date.now()).first<{ found: number }>()
  return Boolean(row?.found)
}

export async function revokeVaultUnlocks(db: D1Database, userId: string, mountId: string, path: string): Promise<void> {
  await db.prepare(
    `DELETE FROM CloudDrive_vault_unlocks WHERE user_id = ? AND mount_id = ? AND path = ?`,
  ).bind(userId, mountId, path).run()
}
