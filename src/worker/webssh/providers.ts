import type { WebsshProvider } from '@shared/webssh/types'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { WebsshStore } from './store'

interface ProviderRow {
  id: string
  label: string
  color: string
  created_at: number
  updated_at: number
}

const PROVIDER_LABEL_MAX = 40
const PROVIDER_COLOR = /^#[0-9a-fA-F]{6}$/

export function normalizeProviderLabel(value: unknown, required: boolean): string {
  if (typeof value !== 'string') {
    if (required) throw ApiError.badRequest('Provider name is required')
    return ''
  }
  const label = value.trim()
  if (!label) {
    if (required) throw ApiError.badRequest('Provider name cannot be empty')
    return ''
  }
  if (label.length > PROVIDER_LABEL_MAX) throw ApiError.badRequest(`Provider name cannot exceed ${PROVIDER_LABEL_MAX} characters`)
  if (/[\u0000-\u001f\u007f]/.test(label)) throw ApiError.badRequest('Provider name cannot contain control characters')
  return label
}

export function normalizeProviderColor(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !PROVIDER_COLOR.test(value)) throw ApiError.badRequest('Provider color must be a six-digit hex value')
  return value
}

function toProvider(row: ProviderRow): WebsshProvider {
  return {
    id: row.id,
    label: row.label,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class WebsshProvidersStore extends WebsshStore {
  async list(): Promise<WebsshProvider[]> {
    const rows = await this.db.prepare(
      'SELECT id, label, color, created_at, updated_at FROM webssh_providers WHERE user_id = ?1 ORDER BY lower(label)',
    )
      .bind(this.userId)
      .all<ProviderRow>()
    return rows.results.map(toProvider)
  }

  async create(input: { label: string; color: string }): Promise<WebsshProvider> {
    await this.assertNameFree(input.label)
    const id = `custom:${newId()}`
    await this.db.prepare(
      `INSERT INTO webssh_providers (user_id, id, label, color, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
      .bind(this.userId, id, input.label, input.color, this.now)
      .run()
    return { id, label: input.label, color: input.color, createdAt: this.now, updatedAt: this.now }
  }

  async update(id: string, patch: { label?: string; color?: string }): Promise<WebsshProvider> {
    const rows = await this.list()
    const existing = rows.find((provider) => provider.id === id)
    if (!existing) throw ApiError.notFound('Provider not found')
    const label = patch.label ?? existing.label
    if (patch.label !== undefined) await this.assertNameFree(label, id)
    const color = patch.color ?? existing.color
    const updatedAt = Math.max(this.now, existing.updatedAt + 1)
    await this.db.prepare(
      'UPDATE webssh_providers SET label = ?3, color = ?4, updated_at = ?5 WHERE user_id = ?1 AND id = ?2',
    )
      .bind(this.userId, id, label, color, updatedAt)
      .run()
    return { ...existing, label, color, updatedAt }
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.list()
    if (!rows.some((provider) => provider.id === id)) return false
    const now = this.now
    await this.db.batch([
      this.db.prepare('UPDATE webssh_hosts SET provider = \'other\', updated_at = ?3 WHERE user_id = ?1 AND provider = ?2 AND deleted_at IS NULL')
        .bind(this.userId, id, now),
      this.db.prepare('DELETE FROM webssh_providers WHERE user_id = ?1 AND id = ?2').bind(this.userId, id),
    ])
    return true
  }

  private async assertNameFree(label: string, exceptId?: string): Promise<void> {
    const row = await this.db.prepare(
      `SELECT 1 AS found FROM webssh_providers
        WHERE user_id = ?1 AND lower(label) = lower(?2) AND (?3 = '' OR id <> ?3) LIMIT 1`,
    )
      .bind(this.userId, label, exceptId ?? '')
      .first<{ found: number }>()
    if (row) throw ApiError.conflict('A provider with this name already exists')
  }
}

export function isValidProviderId(id: string): boolean {
  return id.startsWith('custom:') && isValidId(id.slice('custom:'.length))
}
