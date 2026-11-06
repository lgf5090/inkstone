import type { WebsshCredential } from '@shared/webssh/types'
import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from '../env'
import { decryptWebsshSecret, encryptWebsshSecret } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { countReferences, WebsshStore } from './store'

interface CredentialRow {
  id: string
  label: string
  created_at: number
  updated_at: number
  last_used_at: number | null
}

export const WEBSSH_CREDENTIAL_LABEL_MAX = 80
export const WEBSSH_PASSWORD_MIN = 1
export const WEBSSH_PASSWORD_MAX = 4096

export function normalizeCredentialLabel(value: unknown, required: boolean): string {
  if (typeof value !== 'string') {
    if (required) throw ApiError.badRequest('Credential label is required')
    return ''
  }
  const label = value.trim()
  if (!label) {
    if (required) throw ApiError.badRequest('Credential label cannot be empty')
    return ''
  }
  if (label.length > WEBSSH_CREDENTIAL_LABEL_MAX) throw ApiError.badRequest(`Credential label cannot exceed ${WEBSSH_CREDENTIAL_LABEL_MAX} characters`)
  if (/[\u0000-\u001f\u007f]/.test(label)) throw ApiError.badRequest('Credential label cannot contain control characters')
  return label
}

export function normalizeCredentialPassword(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('Password is required')
  if (value.length < WEBSSH_PASSWORD_MIN || value.length > WEBSSH_PASSWORD_MAX) {
    throw ApiError.badRequest(`Password must be between ${WEBSSH_PASSWORD_MIN} and ${WEBSSH_PASSWORD_MAX} characters`)
  }
  if (/[\u0000]/.test(value)) throw ApiError.badRequest('Password cannot contain NUL bytes')
  return value
}

export function requireCredentialVault(env: Env): void {
  if (!env.CREDENTIAL_VAULT) throw new ApiError(503, 'server_misconfigured', 'CREDENTIAL_VAULT is not bound, so SSH credentials cannot be stored safely')
}

export class WebsshCredentialsStore extends WebsshStore {
  async list(): Promise<WebsshCredential[]> {
    const rows = await this.db.prepare(
      `SELECT id, label, created_at, updated_at, last_used_at
         FROM webssh_credentials
        WHERE user_id = ?1 AND deleted_at IS NULL
        ORDER BY updated_at DESC, id`,
    )
      .bind(this.userId)
      .all<CredentialRow>()
    const ids = rows.results.map((row) => row.id)
    const { counts } = await countReferences(this.db, this.userId, 'credential_id', ids)
    return rows.results.map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      hostCount: counts.get(row.id) ?? 0,
    }))
  }

  async get(id: string): Promise<WebsshCredential | null> {
    if (!isValidId(id)) return null
    const row = await this.db.prepare(
      `SELECT id, label, created_at, updated_at, last_used_at
         FROM webssh_credentials
        WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    )
      .bind(this.userId, id)
      .first<CredentialRow>()
    if (!row) return null
    const { counts } = await countReferences(this.db, this.userId, 'credential_id', [id])
    return {
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      hostCount: counts.get(id) ?? 0,
    }
  }

  async create(env: Env, input: { label: string; password: string }): Promise<WebsshCredential> {
    requireCredentialVault(env)
    const id = newId()
    const ciphertext = await encryptWebsshSecret(env, id, { password: input.password })
    await this.db.prepare(
      `INSERT INTO webssh_credentials (user_id, id, label, password_ciphertext, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
      .bind(this.userId, id, input.label, ciphertext, this.now)
      .run()
    return (await this.get(id))!
  }

  async update(env: Env, id: string, patch: { label?: string; password?: string }): Promise<WebsshCredential> {
    const existing = await this.get(id)
    if (!existing) throw ApiError.notFound('Credential not found')
    if (patch.password !== undefined) requireCredentialVault(env)
    const ciphertext = patch.password !== undefined
      ? await encryptWebsshSecret(env, id, { password: patch.password })
      : null
    await this.db.prepare(
      `UPDATE webssh_credentials
          SET label = ?3, password_ciphertext = COALESCE(?4, password_ciphertext), updated_at = ?5
        WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    )
      .bind(this.userId, id, patch.label ?? existing.label, ciphertext, Math.max(this.now, existing.updatedAt + 1))
      .run()
    return (await this.get(id))!
  }

  async remove(id: string): Promise<void> {
    const existing = await this.get(id)
    if (!existing) throw ApiError.notFound('Credential not found')
    if (existing.hostCount > 0) {
      throw ApiError.conflict('This credential is still used by a host. Change or delete those hosts first', {
        hostCount: existing.hostCount,
      })
    }
    await this.db.prepare(
      'UPDATE webssh_credentials SET deleted_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, id, Math.max(this.now, existing.updatedAt + 1))
      .run()
  }

  async openSecret(env: Env, id: string): Promise<string> {
    requireCredentialVault(env)
    const row = await this.db.prepare(
      'SELECT password_ciphertext FROM webssh_credentials WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, id)
      .first<{ password_ciphertext: string }>()
    if (!row) throw ApiError.notFound('Credential not found')
    const secret = await decryptWebsshSecret(env, id, row.password_ciphertext)
    if (!secret?.password) throw new ApiError(422, 'bad_request', 'The stored password could not be opened')
    return secret.password
  }

  async markUsed(id: string): Promise<void> {
    await this.db.prepare(
      'UPDATE webssh_credentials SET last_used_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, id, this.now)
      .run()
  }
}

export function credentialStore(db: D1Database, userId: string, now?: number): WebsshCredentialsStore {
  return new WebsshCredentialsStore(db, userId, now)
}
