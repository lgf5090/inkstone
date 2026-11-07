import type { WebsshAuthMethod, WebsshHost, WebsshHostListResponse } from '@shared/webssh/types'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { escapeLikePattern, WebsshStore, WEBSSH_PAGE_SIZE_DEFAULT, WEBSSH_PAGE_SIZE_MAX } from './store'

export interface WebsshHostRow {
  id: string
  name: string
  host: string
  port: number
  username: string
  group_id: string
  auth_method: string
  credential_id: string
  key_id: string
  encoding: string
  term_type: string
  initial_command: string
  color: string
  tags: string
  notes: string
  favorite: number
  sort_order: number
  last_connected_at: number | null
  created_at: number
  updated_at: number
}

export const WEBSSH_HOST_NAME_MAX = 80
export const WEBSSH_HOST_ADDRESS_MAX = 255
export const WEBSSH_HOST_USERNAME_MAX = 64
export const WEBSSH_HOST_TAG_MAX = 32
export const WEBSSH_HOST_TAGS_MAX = 10
export const WEBSSH_HOST_NOTES_MAX = 2000
export const WEBSSH_HOST_INITIAL_COMMAND_MAX = 512
export const WEBSSH_HOST_TERM_MAX = 32
const HOST_COLOR = /^#[0-9a-fA-F]{6}$/
const HOSTNAME_PATTERN = /^[A-Za-z0-9._:[\]-]+$/
const TERM_TYPE_PATTERN = /^[A-Za-z0-9._+-]+$/

export type WebsshHostSort = 'manual' | 'name' | 'recent'

export interface WebsshHostListOptions {
  query: string
  groupId: string
  favoriteOnly: boolean
  sort: WebsshHostSort
  page: number
  pageSize: number
}

export interface WebsshHostInput {
  name: string
  host: string
  port: number
  username: string
  groupId: string
  authMethod: WebsshAuthMethod
  credentialId: string
  keyId: string
  encoding: string
  termType: string
  initialCommand: string
  color: string
  tags: string[]
  notes: string
  favorite: boolean
  sortOrder?: number
}

export function parseHostTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function toHost(row: WebsshHostRow): WebsshHost {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    groupId: row.group_id,
    authMethod: row.auth_method === 'publickey' ? 'publickey' : 'password',
    credentialId: row.credential_id,
    keyId: row.key_id,
    encoding: row.encoding,
    termType: row.term_type,
    initialCommand: row.initial_command,
    color: row.color,
    tags: parseHostTags(row.tags),
    notes: row.notes,
    favorite: row.favorite === 1,
    sortOrder: row.sort_order,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function normalizeHostAddress(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('Host address is required')
  const host = value.trim()
  if (!host) throw ApiError.badRequest('Host address cannot be empty')
  if (host.length > WEBSSH_HOST_ADDRESS_MAX) throw ApiError.badRequest(`Host address cannot exceed ${WEBSSH_HOST_ADDRESS_MAX} characters`)
  if (!HOSTNAME_PATTERN.test(host)) throw ApiError.badRequest('Host address may only contain letters, digits, dots, dashes, colons and brackets')
  if (host.includes('..')) throw ApiError.badRequest('Host address cannot contain consecutive dots')
  if (host.startsWith('.') || host.endsWith('.')) throw ApiError.badRequest('Host address cannot start or end with a dot')
  return host
}

export function normalizeHostName(value: unknown, required: boolean): string {
  if (typeof value !== 'string') {
    if (required) throw ApiError.badRequest('Host name is required')
    return ''
  }
  const name = value.trim()
  if (!name) {
    if (required) throw ApiError.badRequest('Host name cannot be empty')
    return ''
  }
  if (name.length > WEBSSH_HOST_NAME_MAX) throw ApiError.badRequest(`Host name cannot exceed ${WEBSSH_HOST_NAME_MAX} characters`)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw ApiError.badRequest('Host name cannot contain control characters')
  return name
}

export function normalizeHostUsername(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('Username is required')
  const username = value.trim()
  if (!username) throw ApiError.badRequest('Username cannot be empty')
  if (username.length > WEBSSH_HOST_USERNAME_MAX) throw ApiError.badRequest(`Username cannot exceed ${WEBSSH_HOST_USERNAME_MAX} characters`)
  if (/[\s\u0000-\u001f\u007f]/.test(username)) throw ApiError.badRequest('Username cannot contain whitespace or control characters')
  return username
}

export function normalizeHostPort(value: unknown): number {
  if (value === undefined || value === null || value === '') return 22
  const port = typeof value === 'string' ? Number(value) : value
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw ApiError.badRequest('Port must be an integer between 1 and 65535')
  }
  return port
}

export function normalizeHostTags(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw ApiError.badRequest('Tags must be an array of strings')
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw ApiError.badRequest('Tags must be an array of strings')
    const tag = item.trim()
    if (!tag) continue
    if (tag.length > WEBSSH_HOST_TAG_MAX) throw ApiError.badRequest(`A tag cannot exceed ${WEBSSH_HOST_TAG_MAX} characters`)
    if (/[\u0000-\u001f\u007f]/.test(tag)) throw ApiError.badRequest('A tag cannot contain control characters')
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > WEBSSH_HOST_TAGS_MAX) throw ApiError.badRequest(`A host cannot carry more than ${WEBSSH_HOST_TAGS_MAX} tags`)
  return tags
}

export function normalizeHostColor(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !HOST_COLOR.test(value)) throw ApiError.badRequest('Host color must be a six-digit hex value')
  return value
}

export function normalizeTermType(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'xterm-256color'
  if (typeof value !== 'string' || value.length > WEBSSH_HOST_TERM_MAX || !TERM_TYPE_PATTERN.test(value)) {
    throw ApiError.badRequest('Terminal type is invalid')
  }
  return value
}

export function normalizeEncoding(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'utf-8'
  if (value !== 'utf-8') throw ApiError.badRequest('Only UTF-8 encoding is supported in this release')
  return 'utf-8'
}

export function normalizeInitialCommand(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('Initial command must be a string')
  const command = value.replace(/\r\n/g, '\n')
  if (command.length > WEBSSH_HOST_INITIAL_COMMAND_MAX) throw ApiError.badRequest(`Initial command cannot exceed ${WEBSSH_HOST_INITIAL_COMMAND_MAX} characters`)
  if (/[\u0000\u0007\u000b\u000c\u001a]/i.test(command)) throw ApiError.badRequest('Initial command cannot contain NUL or terminal control bytes')
  return command
}

export function normalizeHostNotes(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('Notes must be a string')
  if (value.length > WEBSSH_HOST_NOTES_MAX) throw ApiError.badRequest(`Notes cannot exceed ${WEBSSH_HOST_NOTES_MAX} characters`)
  return value
}

export function parseHostSort(value: string | undefined): WebsshHostSort {
  if (value === 'name' || value === 'recent') return value
  return 'manual'
}

export function clampPage(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.trunc(parsed))
}

export function clampPageSize(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return WEBSSH_PAGE_SIZE_DEFAULT
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return WEBSSH_PAGE_SIZE_DEFAULT
  return Math.min(WEBSSH_PAGE_SIZE_MAX, Math.max(1, Math.trunc(parsed)))
}

export class WebsshHostsStore extends WebsshStore {
  async list(options: WebsshHostListOptions): Promise<WebsshHostListResponse> {
    const where = `user_id = ?1 AND deleted_at IS NULL
        AND (?2 = '' OR group_id = ?2)
        AND (?3 = 0 OR favorite = 1)
        AND (?4 = 0 OR name_folded LIKE ?5 ESCAPE '\\' OR host LIKE ?5 ESCAPE '\\' OR username LIKE ?5 ESCAPE '\\')`
    const query = options.query.trim()
    const pattern = query ? `%${escapeLikePattern(query.toLowerCase())}%` : ''
    const totalRow = await this.db.prepare(`SELECT COUNT(*) AS total FROM webssh_hosts WHERE ${where}`)
      .bind(this.userId, options.groupId, options.favoriteOnly ? 1 : 0, query ? 1 : 0, pattern)
      .first<{ total: number }>()
    const total = Number(totalRow?.total ?? 0)
    const page = Math.min(options.page, Math.max(1, Math.ceil(total / options.pageSize) || 1))
    const offset = (page - 1) * options.pageSize
    const order = options.sort === 'name'
      ? 'name_folded, created_at DESC'
      : options.sort === 'recent'
        ? 'COALESCE(last_connected_at, 0) DESC, name_folded'
        : 'sort_order, created_at DESC'
    const rows = await this.db.prepare(
      `SELECT id, name, host, port, username, group_id, auth_method, credential_id, key_id,
              encoding, term_type, initial_command, color, tags, notes, favorite, sort_order,
              last_connected_at, created_at, updated_at
         FROM webssh_hosts
        WHERE ${where}
        ORDER BY ${order}
        LIMIT ?6 OFFSET ?7`,
    )
      .bind(this.userId, options.groupId, options.favoriteOnly ? 1 : 0, query ? 1 : 0, pattern, options.pageSize, offset)
      .all<WebsshHostRow>()
    return { items: rows.results.map(toHost), total, page, pageSize: options.pageSize }
  }

  async get(id: string): Promise<WebsshHost | null> {
    if (!isValidId(id)) return null
    const row = await this.row(id)
    return row ? toHost(row) : null
  }

  async row(id: string): Promise<WebsshHostRow | null> {
    if (!isValidId(id)) return null
    return await this.db.prepare(
      `SELECT id, name, host, port, username, group_id, auth_method, credential_id, key_id,
              encoding, term_type, initial_command, color, tags, notes, favorite, sort_order,
              last_connected_at, created_at, updated_at
         FROM webssh_hosts
        WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    )
      .bind(this.userId, id)
      .first<WebsshHostRow>()
  }

  async groupExists(groupId: string): Promise<boolean> {
    if (!groupId) return true
    const row = await this.db.prepare(
      'SELECT 1 AS found FROM webssh_host_groups WHERE user_id = ?1 AND id = ?2',
    )
      .bind(this.userId, groupId)
      .first<{ found: number }>()
    return Boolean(row)
  }

  async credentialExists(credentialId: string): Promise<boolean> {
    if (!credentialId) return false
    const row = await this.db.prepare(
      'SELECT 1 AS found FROM webssh_credentials WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, credentialId)
      .first<{ found: number }>()
    return Boolean(row)
  }

  async keyExists(keyId: string): Promise<boolean> {
    if (!keyId) return false
    const row = await this.db.prepare(
      'SELECT 1 AS found FROM webssh_keys WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, keyId)
      .first<{ found: number }>()
    return Boolean(row)
  }

  async assertReferences(input: { groupId: string; authMethod: WebsshAuthMethod; credentialId: string; keyId: string }): Promise<void> {
    if (!(await this.groupExists(input.groupId))) throw ApiError.badRequest('The selected group does not exist')
    if (input.authMethod === 'password') {
      if (!input.credentialId) throw ApiError.badRequest('Choose a password credential for this host')
      if (!(await this.credentialExists(input.credentialId))) throw ApiError.badRequest('The selected credential does not exist')
      return
    }
    if (!input.keyId) throw ApiError.badRequest('Choose a key for this host')
    if (!(await this.keyExists(input.keyId))) throw ApiError.badRequest('The selected key does not exist')
  }

  async nextSortOrder(groupId: string): Promise<number> {
    const row = await this.db.prepare(
      `SELECT MAX(sort_order) AS sort_order FROM webssh_hosts
        WHERE user_id = ?1 AND group_id = ?2 AND deleted_at IS NULL`,
    )
      .bind(this.userId, groupId)
      .first<{ sort_order: number | null }>()
    return (row?.sort_order ?? 0) + 1000
  }

  /**
   * Creates a host from an import without a credential or key. The row is deliberately usable only
   * after the owner attaches a secret, so a bulk import never invents an authentication method.
   */
  async createImported(input: { name: string; host: string; port: number; username: string; tags: string[] }): Promise<WebsshHost> {
    const id = newId()
    const sortOrder = await this.nextSortOrder('')
    await this.db.prepare(
      `INSERT INTO webssh_hosts (
         user_id, id, name, name_folded, host, port, username, group_id, auth_method, credential_id,
         key_id, encoding, term_type, initial_command, color, tags, notes, favorite, sort_order,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', 'password', '', '', 'utf-8', 'xterm-256color', '',
                 '', ?8, '', 0, ?9, ?10, ?10)`,
    )
      .bind(
        this.userId,
        id,
        input.name,
        input.name.toLowerCase(),
        input.host,
        input.port,
        input.username,
        JSON.stringify(input.tags),
        sortOrder,
        this.now,
      )
      .run()
    return (await this.get(id))!
  }

  /** An import is a convenience, not a merge: an identical name/address/user row is left alone. */
  async hasDuplicate(input: { name: string; host: string; port: number; username: string }): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS found FROM webssh_hosts
        WHERE user_id = ?1 AND deleted_at IS NULL AND name_folded = ?2
          AND host = ?3 AND port = ?4 AND username = ?5`,
    )
      .bind(this.userId, input.name.toLowerCase(), input.host, input.port, input.username)
      .first<{ found: number }>()
    return Boolean(row)
  }

  async create(input: WebsshHostInput): Promise<WebsshHost> {
    await this.assertReferences(input)
    const id = newId()
    const sortOrder = input.sortOrder ?? await this.nextSortOrder(input.groupId)
    const createdAt = this.now
    await this.db.prepare(
      `INSERT INTO webssh_hosts (
         user_id, id, name, name_folded, host, port, username, group_id, auth_method, credential_id,
         key_id, encoding, term_type, initial_command, color, tags, notes, favorite, sort_order,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20)`,
    )
      .bind(
        this.userId,
        id,
        input.name,
        input.name.toLowerCase(),
        input.host,
        input.port,
        input.username,
        input.groupId,
        input.authMethod,
        input.authMethod === 'password' ? input.credentialId : '',
        input.authMethod === 'publickey' ? input.keyId : '',
        input.encoding,
        input.termType,
        input.initialCommand,
        input.color,
        JSON.stringify(input.tags),
        input.notes,
        input.favorite ? 1 : 0,
        sortOrder,
        createdAt,
      )
      .run()
    return (await this.get(id))!
  }

  async update(id: string, input: WebsshHostInput): Promise<WebsshHost> {
    const existing = await this.get(id)
    if (!existing) throw ApiError.notFound('Host not found')
    await this.assertReferences(input)
    const updatedAt = Math.max(this.now, existing.updatedAt + 1)
    const sortOrder = input.sortOrder ?? (input.groupId !== existing.groupId ? await this.nextSortOrder(input.groupId) : existing.sortOrder)
    await this.db.prepare(
      `UPDATE webssh_hosts
          SET name = ?3, name_folded = ?4, host = ?5, port = ?6, username = ?7, group_id = ?8,
              auth_method = ?9, credential_id = ?10, key_id = ?11, encoding = ?12, term_type = ?13,
              initial_command = ?14, color = ?15, tags = ?16, notes = ?17, favorite = ?18,
              sort_order = ?19, updated_at = ?20
        WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    )
      .bind(
        this.userId,
        id,
        input.name,
        input.name.toLowerCase(),
        input.host,
        input.port,
        input.username,
        input.groupId,
        input.authMethod,
        input.authMethod === 'password' ? input.credentialId : '',
        input.authMethod === 'publickey' ? input.keyId : '',
        input.encoding,
        input.termType,
        input.initialCommand,
        input.color,
        JSON.stringify(input.tags),
        input.notes,
        input.favorite ? 1 : 0,
        sortOrder,
        updatedAt,
      )
      .run()
    return (await this.get(id))!
  }

  async softDelete(id: string): Promise<boolean> {
    const existing = await this.get(id)
    if (!existing) return false
    const updatedAt = Math.max(this.now, existing.updatedAt + 1)
    await this.db.batch([
      this.db.prepare(
        'UPDATE webssh_hosts SET deleted_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
      ).bind(this.userId, id, updatedAt),
      this.db.prepare(
        'DELETE FROM webssh_host_keys WHERE user_id = ?1 AND host_id = ?2',
      ).bind(this.userId, id),
    ])
    return true
  }

  async markConnected(id: string, at: number): Promise<void> {
    await this.db.prepare(
      'UPDATE webssh_hosts SET last_connected_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, id, at)
      .run()
  }
}
