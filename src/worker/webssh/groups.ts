import type { WebsshHostGroup } from '@shared/webssh/types'
import type { D1Database } from '@cloudflare/workers-types'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { WebsshStore } from './store'

interface GroupRow {
  id: string
  parent_id: string
  name: string
  color: string
  icon: string
  position: number
  created_at: number
  updated_at: number
}

export const WEBSSH_GROUP_NAME_MAX = 80
const GROUP_COLOR = /^#[0-9a-fA-F]{6}$/
const GROUP_ICON_MAX = 64

export function toHostGroup(row: GroupRow): WebsshHostGroup {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function normalizeGroupColor(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !GROUP_COLOR.test(value)) throw ApiError.badRequest('Group color must be a six-digit hex value')
  return value
}

export function normalizeGroupIcon(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > GROUP_ICON_MAX || /[\u0000-\u001f\u007f]/.test(value)) {
    throw ApiError.badRequest('Group icon name is invalid')
  }
  return value
}

export function normalizeGroupName(value: unknown, required: boolean): string {
  if (typeof value !== 'string') {
    if (required) throw ApiError.badRequest('Group name is required')
    return ''
  }
  const name = value.trim()
  if (!name) {
    if (required) throw ApiError.badRequest('Group name cannot be empty')
    return ''
  }
  if (name.length > WEBSSH_GROUP_NAME_MAX) throw ApiError.badRequest(`Group name cannot exceed ${WEBSSH_GROUP_NAME_MAX} characters`)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw ApiError.badRequest('Group name cannot contain control characters')
  return name
}

export class WebsshGroupsStore extends WebsshStore {
  async list(): Promise<WebsshHostGroup[]> {
    const rows = await this.db.prepare(
      `SELECT id, parent_id, name, color, icon, position, created_at, updated_at
         FROM webssh_host_groups
        WHERE user_id = ?1
        ORDER BY parent_id, position, created_at, id`,
    )
      .bind(this.userId)
      .all<GroupRow>()
    return rows.results.map(toHostGroup)
  }

  async get(id: string): Promise<WebsshHostGroup | null> {
    if (!isValidId(id)) return null
    const row = await this.db.prepare(
      `SELECT id, parent_id, name, color, icon, position, created_at, updated_at
         FROM webssh_host_groups
        WHERE user_id = ?1 AND id = ?2`,
    )
      .bind(this.userId, id)
      .first<GroupRow>()
    return row ? toHostGroup(row) : null
  }

  async parentOf(id: string): Promise<string | null> {
    const row = await this.db.prepare(
      'SELECT parent_id FROM webssh_host_groups WHERE user_id = ?1 AND id = ?2',
    )
      .bind(this.userId, id)
      .first<{ parent_id: string }>()
    return row ? row.parent_id : null
  }

  async nameTaken(parentId: string, name: string, exceptId?: string): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS found FROM webssh_host_groups
        WHERE user_id = ?1 AND parent_id = ?2 AND lower(name) = lower(?3)
          AND (?4 = '' OR id <> ?4)
        LIMIT 1`,
    )
      .bind(this.userId, parentId, name, exceptId ?? '')
      .first<{ found: number }>()
    return Boolean(row)
  }

  async nextPosition(parentId: string): Promise<number> {
    const row = await this.db.prepare(
      `SELECT MAX(position) AS position FROM webssh_host_groups
        WHERE user_id = ?1 AND parent_id = ?2`,
    )
      .bind(this.userId, parentId)
      .first<{ position: number | null }>()
    return (row?.position ?? 0) + 1000
  }

  async assertUsableParent(parentId: string, selfId?: string): Promise<void> {
    if (!parentId) return
    if (selfId === parentId) throw ApiError.badRequest('A group cannot be its own parent')
    const parent = await this.get(parentId)
    if (!parent) throw ApiError.badRequest('The parent group does not exist')
    const visited = new Set<string>([selfId ?? ''])
    let cursor: string | null = parentId
    while (cursor) {
      if (cursor === selfId) throw ApiError.badRequest('A group cannot be moved into its own descendant')
      if (visited.has(cursor)) throw ApiError.badRequest('The group hierarchy contains a cycle')
      visited.add(cursor)
      cursor = await this.parentOf(cursor)
    }
  }

  async create(input: { parentId: string; name: string; color: string; icon: string }): Promise<WebsshHostGroup> {
    await this.assertUsableParent(input.parentId)
    if (await this.nameTaken(input.parentId, input.name)) throw ApiError.conflict('A group with this name already exists here')
    const id = newId()
    const position = await this.nextPosition(input.parentId)
    const now = this.now
    await this.db.prepare(
      `INSERT INTO webssh_host_groups (user_id, id, parent_id, name, color, icon, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    )
      .bind(this.userId, id, input.parentId, input.name, input.color, input.icon, position, now)
      .run()
    return (await this.get(id))!
  }

  async update(id: string, patch: { name?: string; parentId?: string; color?: string; icon?: string; position?: number }): Promise<WebsshHostGroup> {
    const existing = await this.get(id)
    if (!existing) throw ApiError.notFound('Group not found')
    const parentId = patch.parentId ?? existing.parentId
    if (patch.parentId !== undefined) await this.assertUsableParent(parentId, id)
    const name = patch.name ?? existing.name
    if (await this.nameTaken(parentId, name, id)) throw ApiError.conflict('A group with this name already exists here')
    const moved = parentId !== existing.parentId
    const position = moved
      ? (patch.position ?? await this.nextPosition(parentId))
      : (patch.position ?? existing.position)
    await this.db.prepare(
      `UPDATE webssh_host_groups
          SET parent_id = ?3, name = ?4, color = ?5, icon = ?6, position = ?7, updated_at = ?8
        WHERE user_id = ?1 AND id = ?2`,
    )
      .bind(this.userId, id, parentId, name, patch.color ?? existing.color, patch.icon ?? existing.icon, position, Math.max(this.now, existing.updatedAt + 1))
      .run()
    return (await this.get(id))!
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.get(id)
    if (!existing) return false
    const updatedAt = Math.max(this.now, existing.updatedAt + 1)
    await this.db.batch([
      this.db.prepare(
        `UPDATE webssh_host_groups SET parent_id = ?3, updated_at = ?4
          WHERE user_id = ?1 AND parent_id = ?2`,
      ).bind(this.userId, id, existing.parentId, updatedAt),
      this.db.prepare(
        `UPDATE webssh_hosts SET group_id = '', updated_at = ?3
          WHERE user_id = ?1 AND group_id = ?2 AND deleted_at IS NULL`,
      ).bind(this.userId, id, updatedAt),
      this.db.prepare(
        'DELETE FROM webssh_host_groups WHERE user_id = ?1 AND id = ?2',
      ).bind(this.userId, id),
    ])
    return true
  }
}

export function groupStore(db: D1Database, userId: string, now?: number): WebsshGroupsStore {
  return new WebsshGroupsStore(db, userId, now)
}
