/**
 * Board-scoped machine credentials. The token is shown once and only its SHA-256 is stored, so a
 * database export cannot be replayed as a credential; verification joins `users` so a deleted or
 * disabled account stops authenticating immediately.
 */
import { newProjectId } from '@shared/project/limits'
import { PROJECT_TOKEN_PREFIX, type ProjectTokenScope } from '@shared/project/integrations'
import type { ProjectApiTokenCreateInput } from '@shared/project/validation'
import { sha256Hex, toBase64Url } from '../lib/encoding'

const TOKEN_PATTERN = `${PROJECT_TOKEN_PREFIX}[A-Za-z0-9_-]{43}`
const BEARER = new RegExp(`^Bearer\\s+(${TOKEN_PATTERN})$`, 'i')

export interface ProjectApiToken {
  id: string
  name: string
  scope: ProjectTokenScope
  boardId: string
  expiresAt: number | null
  createdAt: number
  revokedAt: number | null
}

export interface ProjectApiTokenAuth {
  id: string
  userId: string
  boardId: string
  scope: ProjectTokenScope
}

interface TokenRow {
  id: string
  user_id: string
  board_id: string
  name: string
  scope: string
  expires_at: number | null
  created_at: number
  revoked_at: number | null
}

export function projectTokenFromAuthorization(header: string | undefined): string | null {
  return BEARER.exec(header ?? '')?.[1] ?? null
}

function rowToToken(row: TokenRow): ProjectApiToken {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope === 'write' ? 'write' : 'read',
    boardId: row.board_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }
}

export async function listProjectApiTokens(db: D1Database, userId: string): Promise<ProjectApiToken[]> {
  const { results } = await db.prepare(
    `SELECT id, user_id, board_id, name, scope, expires_at, created_at, revoked_at
       FROM project_api_tokens WHERE user_id = ?1 ORDER BY created_at DESC, id`,
  ).bind(userId).all<TokenRow>()
  return results.map(rowToToken)
}

export async function createProjectApiToken(
  db: D1Database, userId: string, input: ProjectApiTokenCreateInput, now: number,
): Promise<{ token: ProjectApiToken, secret: string }> {
  const secret = `${PROJECT_TOKEN_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`
  const id = newProjectId('token')
  const hash = await sha256Hex(secret)
  await db.prepare(
    `INSERT INTO project_api_tokens (id, user_id, board_id, name, scope, token_hash, expires_at, created_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)`,
  ).bind(
    id, userId, input.boardId ?? '', input.name, input.scope, hash,
    input.expiresAt ?? null, now,
  ).run()
  const token: ProjectApiToken = {
    id, name: input.name, scope: input.scope, boardId: input.boardId ?? '',
    expiresAt: input.expiresAt ?? null, createdAt: now, revokedAt: null,
  }
  return { token, secret }
}

export async function revokeProjectApiToken(db: D1Database, userId: string, id: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    'UPDATE project_api_tokens SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL',
  ).bind(now, id, userId).run()
  return (result.meta?.changes ?? 0) > 0
}

export async function verifyProjectApiToken(
  db: D1Database, secret: string, now: number,
): Promise<ProjectApiTokenAuth | null> {
  if (!new RegExp(`^${TOKEN_PATTERN}$`).test(secret)) return null
  const hash = await sha256Hex(secret)
  const row = await db.prepare(
    `SELECT t.id, t.user_id, t.board_id, t.scope, t.expires_at
       FROM project_api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?1 AND t.revoked_at IS NULL`,
  ).bind(hash).first<Pick<TokenRow, 'id' | 'user_id' | 'board_id' | 'scope' | 'expires_at'>>()
  if (!row || (row.expires_at !== null && row.expires_at <= now)) return null
  return {
    id: row.id,
    userId: row.user_id,
    boardId: row.board_id,
    scope: row.scope === 'write' ? 'write' : 'read',
  }
}
