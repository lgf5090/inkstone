/**
 * CloudDrive API keys.
 *
 * A key is `cdk_` plus 32 random bytes in base64url; only its SHA-256 hash is stored. The plaintext
 * exists once, in the POST response, and the listing shows the short prefix instead. The same lookup
 * authenticates WebDAV (`apikey` + token) and the key owner is then used for every scoped query.
 */
import { sha256Hex, toBase64Url } from '../lib/encoding'
import { newId } from '../lib/id'
import { ApiError } from '../lib/errors'
import { parsePath } from './lib'

export const CLOUDDRIVE_KEY_SCOPES = ['read', 'write', 'webdav'] as const
export type CloudDriveKeyScope = (typeof CLOUDDRIVE_KEY_SCOPES)[number]

const TOKEN_RE = /^cdk_[A-Za-z0-9_-]{43}$/
/** `last_used_at` is a diagnostic, not a write amplifier: at most one update per five minutes. */
const LAST_USED_INTERVAL_MS = 5 * 60 * 1000
const NAME_MAX = 64

export interface CloudDriveApiKeyRow {
  id: string
  user_id: string
  name: string
  token_prefix: string
  scopes: string
  path_prefix: string
  expires_at: number | null
  last_used_at: number | null
  created_at: number
  revoked_at: number | null
}

export interface CloudDriveApiKeyView {
  id: string
  name: string
  prefix: string
  scopes: CloudDriveKeyScope[]
  pathPrefix: string
  expiresAt: number | null
  lastUsedAt: number | null
  createdAt: number
}

export interface CloudDriveKeyActor {
  keyId: string
  userId: string
  scopes: CloudDriveKeyScope[]
  pathPrefix: string
}

export function isCloudDriveApiKey(value: string): boolean {
  return TOKEN_RE.test(value)
}

/** Scopes arrive as a JSON array from the API and as a space-separated string from D1. */
export function parseKeyScopes(value: unknown): CloudDriveKeyScope[] {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(' ') : []
  const found = new Set<CloudDriveKeyScope>()
  for (const part of parts) {
    if (typeof part !== 'string') continue
    if (!(CLOUDDRIVE_KEY_SCOPES as readonly string[]).includes(part)) continue
    found.add(part as CloudDriveKeyScope)
  }
  // `write` necessarily reads, so a write key is stored with both and a caller never has to
  // remember the implication.
  if (found.has('write')) found.add('read')
  return CLOUDDRIVE_KEY_SCOPES.filter((scope) => found.has(scope))
}

export function apiKeyAllows(scopes: readonly CloudDriveKeyScope[], required: CloudDriveKeyScope): boolean {
  if (scopes.includes(required)) return true
  return required === 'read' && scopes.includes('write')
}

/** A prefix of `/` is the whole drive; otherwise the path must be the prefix or live under it. */
export function pathWithinPrefix(prefix: string, path: string): boolean {
  if (prefix === '/' || path === prefix) return true
  return path.startsWith(`${prefix}/`)
}

export function toApiKeyView(row: CloudDriveApiKeyRow): CloudDriveApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    scopes: parseKeyScopes(row.scopes),
    pathPrefix: row.path_prefix,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }
}

export interface CreateApiKeyInput {
  name?: unknown
  scopes?: unknown
  pathPrefix?: unknown
  expiresAt?: unknown
}

export async function createApiKey(
  db: D1Database,
  userId: string,
  input: CreateApiKeyInput,
  now = Date.now(),
): Promise<{ key: CloudDriveApiKeyView; token: string }> {
  const name = typeof input.name === 'string' ? input.name.normalize('NFC').trim() : ''
  if (name.length === 0 || name.length > NAME_MAX) {
    throw ApiError.badRequest(`A key name must contain 1 to ${NAME_MAX} characters`)
  }
  if (/[\u0000-\u001f]/.test(name)) throw ApiError.badRequest('A key name cannot contain a control character')
  const scopes = parseKeyScopes(input.scopes)
  if (scopes.length === 0) throw ApiError.badRequest('A key needs at least one scope')

  let pathPrefix = '/'
  if (input.pathPrefix !== undefined && input.pathPrefix !== null && input.pathPrefix !== '') {
    if (typeof input.pathPrefix !== 'string') throw ApiError.badRequest('pathPrefix must be a string')
    pathPrefix = parsePath(input.pathPrefix)
  }

  let expiresAt: number | null = null
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (typeof input.expiresAt !== 'number' || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
      throw ApiError.badRequest('expiresAt must be a future millisecond timestamp')
    }
    expiresAt = input.expiresAt
  }

  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = `cdk_${toBase64Url(bytes)}`
  const tokenHash = await sha256Hex(token)
  const id = newId()
  await db.prepare(
    `INSERT INTO CloudDrive_api_keys
       (id, user_id, name, token_hash, token_prefix, scopes, path_prefix, expires_at,
        last_used_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
  ).bind(id, userId, name, tokenHash, token.slice(0, 12), scopes.join(' '), pathPrefix, expiresAt, now).run()

  return {
    key: {
      id,
      name,
      prefix: token.slice(0, 12),
      scopes,
      pathPrefix,
      expiresAt,
      lastUsedAt: null,
      createdAt: now,
    },
    token,
  }
}

export async function listApiKeys(db: D1Database, userId: string): Promise<CloudDriveApiKeyView[]> {
  const { results } = await db.prepare(
    `SELECT id, user_id, name, token_prefix, scopes, path_prefix, expires_at, last_used_at,
            created_at, revoked_at
       FROM CloudDrive_api_keys
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC, id DESC`,
  ).bind(userId).all<CloudDriveApiKeyRow>()
  return (results ?? []).map(toApiKeyView)
}

export async function revokeApiKey(db: D1Database, userId: string, id: string, now = Date.now()): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE CloudDrive_api_keys SET revoked_at = ?
      WHERE user_id = ? AND id = ? AND revoked_at IS NULL`,
  ).bind(now, userId, id).run()
  return (result.meta.changes ?? 0) > 0
}

/**
 * Resolve a bearer/DAV token to its owner. Expired, revoked and under-scoped keys answer `null` so
 * every caller responds the same way and no key state leaks through a different status.
 *
 * The hash lookup is the one query that cannot bind `user_id`: the owner is what it is finding. All
 * later work uses the returned id.
 */
export async function authenticateApiKey(
  db: D1Database,
  token: string,
  required: CloudDriveKeyScope,
  now = Date.now(),
): Promise<CloudDriveKeyActor | null> {
  if (!isCloudDriveApiKey(token)) return null
  const tokenHash = await sha256Hex(token)
  const row = await db.prepare(
    `SELECT id, user_id, scopes, path_prefix, expires_at, last_used_at
       FROM CloudDrive_api_keys
      WHERE token_hash = ? AND revoked_at IS NULL`,
  ).bind(tokenHash).first<{
    id: string
    user_id: string
    scopes: string
    path_prefix: string
    expires_at: number | null
    last_used_at: number | null
  }>()
  if (!row) return null
  if (row.expires_at !== null && row.expires_at <= now) return null
  const scopes = parseKeyScopes(row.scopes)
  if (!apiKeyAllows(scopes, required)) return null

  if (row.last_used_at === null || row.last_used_at < now - LAST_USED_INTERVAL_MS) {
    await db.prepare(
      `UPDATE CloudDrive_api_keys SET last_used_at = ?
        WHERE user_id = ? AND id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    ).bind(now, row.user_id, row.id, now - LAST_USED_INTERVAL_MS).run()
  }

  return {
    keyId: row.id,
    userId: row.user_id,
    scopes,
    pathPrefix: row.path_prefix,
  }
}
