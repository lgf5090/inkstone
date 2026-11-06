import type { WebsshHostKey, WebsshHostKeyCheck, WebsshHostKeyState } from '@shared/webssh/types'
import { ApiError } from '../lib/errors'
import { WebsshStore } from './store'

interface HostKeyRow {
  algorithm: string
  fingerprint: string
  first_seen_at: number
  last_seen_at: number
  trusted_at: number | null
  revoked_at: number | null
}

const SHA256_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/
const SSH_ALGORITHM = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)$/

export function normalizeHostKeyAlgorithm(value: unknown): string {
  if (typeof value !== 'string' || !SSH_ALGORITHM.test(value)) {
    throw ApiError.badRequest('Unsupported host key algorithm')
  }
  return value
}

export function normalizeFingerprint(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('A fingerprint is required')
  const trimmed = value.trim()
  if (!trimmed) throw ApiError.badRequest('A fingerprint is required')
  if (trimmed.length === 43 && /^[A-Za-z0-9+/]{43}$/.test(trimmed)) return `SHA256:${trimmed}`
  if (!SHA256_FINGERPRINT.test(trimmed)) throw ApiError.badRequest('A fingerprint must be an OpenSSH SHA256 fingerprint')
  return trimmed
}

function toHostKey(row: HostKeyRow): WebsshHostKey {
  return {
    algorithm: row.algorithm,
    fingerprint: row.fingerprint,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    trustedAt: row.trusted_at,
    revokedAt: row.revoked_at,
  }
}

function decide(rows: HostKeyRow[], algorithm: string, fingerprint: string): WebsshHostKeyCheck {
  const presented = rows.find((row) => row.algorithm === algorithm && row.fingerprint === fingerprint)
  const trusted = rows.filter((row) => row.trusted_at !== null && row.revoked_at === null)
  const matchingTrusted = trusted.find((row) => row.fingerprint === fingerprint)
  let state: WebsshHostKeyState
  if (presented?.revoked_at !== null && presented?.revoked_at !== undefined) state = 'revoked'
  else if (matchingTrusted) state = 'trusted'
  else if (trusted.length) state = 'changed'
  else state = 'untrusted'
  return {
    state,
    algorithm,
    fingerprint,
    trustedFingerprint: state === 'changed' ? trusted[0]!.fingerprint : matchingTrusted?.fingerprint ?? null,
  }
}

export class WebsshHostKeysStore extends WebsshStore {
  async list(hostId: string): Promise<WebsshHostKey[]> {
    const rows = await this.rows(hostId)
    return rows.map(toHostKey)
  }

  async check(hostId: string, algorithm: string, fingerprint: string): Promise<WebsshHostKeyCheck> {
    return decide(await this.rows(hostId), algorithm, fingerprint)
  }

  async recordSighting(hostId: string, algorithm: string, fingerprint: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO webssh_host_keys (user_id, host_id, algorithm, fingerprint, first_seen_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(user_id, host_id, fingerprint) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
      .bind(this.userId, hostId, algorithm, fingerprint, this.now)
      .run()
  }

  async trust(hostId: string, algorithm: string, fingerprint: string): Promise<WebsshHostKeyCheck> {
    await this.db.batch([
      this.db.prepare(
        `UPDATE webssh_host_keys SET revoked_at = ?4
          WHERE user_id = ?1 AND host_id = ?2 AND trusted_at IS NOT NULL AND revoked_at IS NULL
            AND fingerprint <> ?3`,
      ).bind(this.userId, hostId, fingerprint, this.now),
      this.db.prepare(
        `INSERT INTO webssh_host_keys (user_id, host_id, algorithm, fingerprint, first_seen_at, last_seen_at, trusted_at, revoked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5, NULL)
         ON CONFLICT(user_id, host_id, fingerprint) DO UPDATE SET
           algorithm = excluded.algorithm,
           last_seen_at = excluded.last_seen_at,
           trusted_at = excluded.trusted_at,
           revoked_at = NULL`,
      ).bind(this.userId, hostId, algorithm, fingerprint, this.now),
    ])
    return this.check(hostId, algorithm, fingerprint)
  }

  async revoke(hostId: string, fingerprint: string): Promise<WebsshHostKeyCheck> {
    const row = await this.db.prepare(
      `SELECT algorithm FROM webssh_host_keys
        WHERE user_id = ?1 AND host_id = ?2 AND fingerprint = ?3`,
    )
      .bind(this.userId, hostId, fingerprint)
      .first<{ algorithm: string }>()
    if (!row) throw ApiError.notFound('That fingerprint is not recorded for this host')
    await this.db.prepare(
      `UPDATE webssh_host_keys SET revoked_at = ?4
        WHERE user_id = ?1 AND host_id = ?2 AND fingerprint = ?3`,
    )
      .bind(this.userId, hostId, fingerprint, this.now)
      .run()
    return this.check(hostId, row.algorithm, fingerprint)
  }

  async anyTrusted(hostId: string): Promise<string | null> {
    const row = await this.db.prepare(
      `SELECT fingerprint FROM webssh_host_keys
        WHERE user_id = ?1 AND host_id = ?2 AND trusted_at IS NOT NULL AND revoked_at IS NULL
        ORDER BY trusted_at DESC LIMIT 1`,
    )
      .bind(this.userId, hostId)
      .first<{ fingerprint: string }>()
    return row?.fingerprint ?? null
  }

  private async rows(hostId: string): Promise<HostKeyRow[]> {
    const result = await this.db.prepare(
      `SELECT algorithm, fingerprint, first_seen_at, last_seen_at, trusted_at, revoked_at
         FROM webssh_host_keys
        WHERE user_id = ?1 AND host_id = ?2
        ORDER BY last_seen_at DESC, fingerprint`,
    )
      .bind(this.userId, hostId)
      .all<HostKeyRow>()
    return result.results
  }
}
