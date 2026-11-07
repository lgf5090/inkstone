import type { WebsshKey } from '@shared/webssh/types'
import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from '../env'
import { decryptWebsshSecret, encryptWebsshSecret } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { inspectOpenSshPrivateKey, OpenSshKeyError } from './openssh-key'
import { requireCredentialVault } from './credentials'
import { countReferences, WebsshStore } from './store'

interface KeyRow {
  id: string
  label: string
  algorithm: string
  public_key: string
  fingerprint: string
  created_at: number
  updated_at: number
  last_used_at: number | null
}

export const WEBSSH_KEY_LABEL_MAX = 80
export const WEBSSH_PRIVATE_KEY_MAX = 16 * 1024
export const WEBSSH_PASSPHRASE_MAX = 1024

export function normalizeKeyLabel(value: unknown, required: boolean): string {
  if (typeof value !== 'string') {
    if (required) throw ApiError.badRequest('Key label is required')
    return ''
  }
  const label = value.trim()
  if (!label) {
    if (required) throw ApiError.badRequest('Key label cannot be empty')
    return ''
  }
  if (label.length > WEBSSH_KEY_LABEL_MAX) throw ApiError.badRequest(`Key label cannot exceed ${WEBSSH_KEY_LABEL_MAX} characters`)
  if (/[\u0000-\u001f\u007f]/.test(label)) throw ApiError.badRequest('Key label cannot contain control characters')
  return label
}

export function normalizePrivateKeyText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw ApiError.badRequest('A private key is required')
  if (value.length > WEBSSH_PRIVATE_KEY_MAX) throw ApiError.badRequest('The private key is too large')
  return value.trim()
}

export function normalizePassphrase(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw ApiError.badRequest('The passphrase must be a string')
  if (value.length > WEBSSH_PASSPHRASE_MAX) throw ApiError.badRequest(`The passphrase cannot exceed ${WEBSSH_PASSPHRASE_MAX} characters`)
  return value
}

function toKeyError(error: OpenSshKeyError): ApiError {
  return new ApiError(422, 'bad_request', error.message, { reason: error.reason })
}

export class WebsshKeysStore extends WebsshStore {
  async list(): Promise<WebsshKey[]> {
    const rows = await this.db.prepare(
      `SELECT id, label, algorithm, public_key, fingerprint, created_at, updated_at, last_used_at
         FROM webssh_keys
        WHERE user_id = ?1 AND deleted_at IS NULL
        ORDER BY updated_at DESC, id`,
    )
      .bind(this.userId)
      .all<KeyRow>()
    const ids = rows.results.map((row) => row.id)
    const { counts } = await countReferences(this.db, this.userId, 'key_id', ids)
    return rows.results.map((row) => ({
      id: row.id,
      label: row.label,
      algorithm: row.algorithm,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      hostCount: counts.get(row.id) ?? 0,
    }))
  }

  async get(id: string): Promise<WebsshKey | null> {
    if (!isValidId(id)) return null
    const row = await this.db.prepare(
      `SELECT id, label, algorithm, public_key, fingerprint, created_at, updated_at, last_used_at
         FROM webssh_keys
        WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    )
      .bind(this.userId, id)
      .first<KeyRow>()
    if (!row) return null
    const { counts } = await countReferences(this.db, this.userId, 'key_id', [id])
    return {
      id: row.id,
      label: row.label,
      algorithm: row.algorithm,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      hostCount: counts.get(row.id) ?? 0,
    }
  }

  async create(env: Env, input: { label: string; privateKey: string; passphrase: string }): Promise<{ key: WebsshKey; encrypted: boolean }> {
    requireCredentialVault(env)
    let info
    try {
      info = await inspectOpenSshPrivateKey(input.privateKey, input.passphrase || undefined)
    } catch (error) {
      if (error instanceof OpenSshKeyError) throw toKeyError(error)
      throw ApiError.badRequest('The private key could not be read')
    }
    if (!info.encrypted && input.passphrase) {
      throw ApiError.badRequest('This key is not encrypted, so it must not carry a passphrase')
    }
    const duplicate = await this.db.prepare(
      'SELECT id FROM webssh_keys WHERE user_id = ?1 AND fingerprint = ?2 LIMIT 1',
    )
      .bind(this.userId, info.fingerprint)
      .first<{ id: string }>()
    if (duplicate) {
      throw ApiError.conflict('A key with the same fingerprint is already in your keychain', { keyId: duplicate.id })
    }
    const id = newId()
    const payload = info.encrypted
      ? { privateKey: input.privateKey, passphrase: input.passphrase }
      : { privateKey: input.privateKey }
    const privateKeyCiphertext = await encryptWebsshSecret(env, id, payload)
    const passphraseCiphertext = info.encrypted
      ? await encryptWebsshSecret(env, id, { passphrase: input.passphrase })
      : ''
    await this.db.prepare(
      `INSERT INTO webssh_keys (
         user_id, id, label, algorithm, public_key, fingerprint, private_key_ciphertext,
         passphrase_ciphertext, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    )
      .bind(
        this.userId,
        id,
        input.label,
        info.algorithm,
        info.publicKey,
        info.fingerprint,
        privateKeyCiphertext,
        passphraseCiphertext,
        this.now,
      )
      .run()
    return { key: (await this.get(id))!, encrypted: info.encrypted }
  }

  async rename(id: string, label: string): Promise<WebsshKey> {
    const existing = await this.get(id)
    if (!existing) throw ApiError.notFound('Key not found')
    await this.db.prepare(
      'UPDATE webssh_keys SET label = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, id, label, Math.max(this.now, existing.updatedAt + 1))
      .run()
    return (await this.get(id))!
  }

  async remove(id: string): Promise<void> {
    const existing = await this.get(id)
    if (!existing) throw ApiError.notFound('Key not found')
    if (existing.hostCount > 0) {
      throw ApiError.conflict('This key is still used by a host. Change or delete those hosts first', {
        hostCount: existing.hostCount,
      })
    }
    await this.db.prepare(
      'UPDATE webssh_keys SET deleted_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, id, Math.max(this.now, existing.updatedAt + 1))
      .run()
  }

  async openSecret(env: Env, id: string): Promise<{ privateKey: string; passphrase: string | null }> {
    requireCredentialVault(env)
    const row = await this.db.prepare(
      'SELECT private_key_ciphertext, passphrase_ciphertext FROM webssh_keys WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, id)
      .first<{ private_key_ciphertext: string; passphrase_ciphertext: string }>()
    if (!row) throw ApiError.notFound('Key not found')
    const secret = await decryptWebsshSecret(env, id, row.private_key_ciphertext)
    if (!secret?.privateKey) throw new ApiError(422, 'bad_request', 'The stored private key could not be opened')
    let passphrase: string | null = null
    if (row.passphrase_ciphertext) {
      const opened = await decryptWebsshSecret(env, id, row.passphrase_ciphertext)
      if (!opened?.passphrase) throw new ApiError(422, 'bad_request', 'The stored key passphrase could not be opened')
      passphrase = opened.passphrase
    }
    return { privateKey: secret.privateKey, passphrase }
  }

  async markUsed(id: string): Promise<void> {
    await this.db.prepare(
      'UPDATE webssh_keys SET last_used_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, id, this.now)
      .run()
  }
}

export function keyStore(db: D1Database, userId: string, now?: number): WebsshKeysStore {
  return new WebsshKeysStore(db, userId, now)
}
