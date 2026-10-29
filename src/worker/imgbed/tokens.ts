import type { ImgbedTokenScope } from '@shared/imgbed/model'
import { newId } from '../lib/id'
import { sha256Hex, toBase64Url } from '../lib/encoding'

export interface ImgbedTokenRecord {
  id: string
  name: string
  prefix: string
  scopes: ImgbedTokenScope[]
  expiresAt: number | null
  autoDelete: boolean
  createdBy: string
  createdAt: number
  lastUsedAt: number | null
}

interface TokenRow {
  id: string
  name: string
  token_hash: string
  token_prefix: string
  scopes: string
  expires_at: number | null
  auto_delete: number
  created_by: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
  owner_name?: string | null
}

const TOKEN_RE = /^img_[A-Za-z0-9_-]{43}$/
const SCOPES: readonly ImgbedTokenScope[] = ['list', 'upload', 'delete', 'manage']

export function isImgbedToken(value: string): boolean {
  return TOKEN_RE.test(value)
}

export function tokenScopes(value: unknown): ImgbedTokenScope[] {
  if (!Array.isArray(value)) return []
  return SCOPES.filter((scope) => value.includes(scope))
}

export function scopeAllows(scopes: readonly string[], required: ImgbedTokenScope): boolean {
  if (scopes.includes('manage')) return true
  if (required === 'list') return scopes.includes('list') || scopes.includes('upload') || scopes.includes('delete')
  if (required === 'delete') return scopes.includes('delete')
  return scopes.includes(required)
}

export function toTokenRecord(row: TokenRow): ImgbedTokenRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    scopes: row.scopes.split(' ').filter(Boolean) as ImgbedTokenScope[],
    expiresAt: row.expires_at,
    autoDelete: row.auto_delete === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

export async function createToken(
  db: D1Database,
  input: {
    name: string
    scopes: ImgbedTokenScope[]
    expiresAt: number | null
    autoDelete: boolean
    createdBy: string
  },
): Promise<{ record: ImgbedTokenRecord; token: string }> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = `img_${toBase64Url(bytes)}`
  const tokenHash = await sha256Hex(token)
  const now = Date.now()
  const id = newId()
  const prefix = token.slice(0, 8)
  const scopes = SCOPES.filter((scope) => input.scopes.includes(scope))
  if (!scopes.length) throw new Error('token_scope_required')
  await db.prepare(
    `INSERT INTO imgbed_api_tokens
       (id, name, token_hash, token_prefix, scopes, expires_at, auto_delete, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    id, input.name.slice(0, 64), tokenHash, prefix, scopes.join(' '),
    input.expiresAt, input.autoDelete ? 1 : 0, input.createdBy, now,
  ).run()
  return {
    record: {
      id, name: input.name.slice(0, 64), prefix, scopes,
      expiresAt: input.expiresAt, autoDelete: input.autoDelete,
      createdBy: input.createdBy, createdAt: now, lastUsedAt: null,
    },
    token,
  }
}

export async function listTokens(db: D1Database): Promise<(ImgbedTokenRecord & { owner: string })[]> {
  const { results } = await db.prepare(
    `SELECT t.*, COALESCE(u.name, u.username, t.created_by) AS owner_name
       FROM imgbed_api_tokens t LEFT JOIN users u ON u.id = t.created_by
      WHERE t.revoked_at IS NULL ORDER BY t.created_at DESC`,
  ).all<TokenRow>()
  return (results ?? []).map((row) => ({ ...toTokenRecord(row), owner: row.owner_name ?? row.created_by }))
}

export async function updateToken(
  db: D1Database,
  id: string,
  patch: { scopes?: ImgbedTokenScope[]; expiresAt?: number | null; autoDelete?: boolean },
): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM imgbed_api_tokens WHERE id = ?1 AND revoked_at IS NULL')
    .bind(id).first<{ id: string }>()
  if (!row) return false
  const sets: string[] = []
  const binds: unknown[] = [id]
  let index = 2
  if (patch.scopes) { sets.push(`scopes = ?${index++}`); binds.push(SCOPES.filter((scope) => patch.scopes!.includes(scope)).join(' ')) }
  if (patch.expiresAt !== undefined) { sets.push(`expires_at = ?${index++}`); binds.push(patch.expiresAt) }
  if (patch.autoDelete !== undefined) { sets.push(`auto_delete = ?${index++}`); binds.push(patch.autoDelete ? 1 : 0) }
  if (!sets.length) return true
  await db.prepare(`UPDATE imgbed_api_tokens SET ${sets.join(', ')} WHERE id = ?1`)
    .bind(...binds as [unknown, ...unknown[]]).run()
  return true
}

export async function revokeToken(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(
    'UPDATE imgbed_api_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL',
  ).bind(id, Date.now()).run()
  return (result.meta.changes ?? 0) > 0
}

export async function resolveToken(
  db: D1Database,
  token: string,
  now = Date.now(),
): Promise<{ id: string; userId: string; scopes: ImgbedTokenScope[] } | null> {
  if (!isImgbedToken(token)) return null
  const hash = await sha256Hex(token)
  const row = await db.prepare(
    `SELECT id, created_by, scopes, expires_at FROM imgbed_api_tokens
      WHERE token_hash = ?1 AND revoked_at IS NULL`,
  ).bind(hash).first<{ id: string; created_by: string; scopes: string; expires_at: number | null }>()
  if (!row) return null
  if (row.expires_at !== null && row.expires_at <= now) return null
  await db.prepare('UPDATE imgbed_api_tokens SET last_used_at = ?2 WHERE id = ?1').bind(row.id, now).run()
  return {
    id: row.id,
    userId: row.created_by,
    scopes: row.scopes.split(' ').filter(Boolean) as ImgbedTokenScope[],
  }
}

export async function purgeTokens(db: D1Database, now = Date.now()): Promise<number> {
  const expired = await db.prepare(
    'SELECT id FROM imgbed_api_tokens WHERE (expires_at IS NOT NULL AND expires_at <= ?1 AND auto_delete = 1) OR (revoked_at IS NOT NULL AND revoked_at < ?2)',
  ).bind(now, now - 30 * 86_400_000).all<{ id: string }>()
  if (!expired.results?.length) return 0
  await db.batch(expired.results.map((row) => db.prepare('DELETE FROM imgbed_api_tokens WHERE id = ?1').bind(row.id)))
  return expired.results.length
}

export async function isIpBlocked(db: D1Database, ip: string | null): Promise<boolean> {
  if (!ip) return false
  const row = await db.prepare('SELECT 1 AS found FROM imgbed_blocked_ips WHERE ip = ?1').bind(ip).first<{ found: number }>()
  return Boolean(row?.found)
}

export async function blockIp(db: D1Database, ip: string): Promise<void> {
  await db.prepare(
    'INSERT INTO imgbed_blocked_ips (ip, created_at) VALUES (?1, ?2) ON CONFLICT(ip) DO NOTHING',
  ).bind(ip, Date.now()).run()
}

export async function unblockIp(db: D1Database, ip: string): Promise<void> {
  await db.prepare('DELETE FROM imgbed_blocked_ips WHERE ip = ?1').bind(ip).run()
}

export async function blockedIps(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT ip FROM imgbed_blocked_ips ORDER BY created_at DESC')
    .all<{ ip: string }>()
  return (results ?? []).map((row) => row.ip)
}
