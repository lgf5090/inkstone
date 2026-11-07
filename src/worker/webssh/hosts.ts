import type {
  WebsshAuthMethod,
  WebsshEgressConfig,
  WebsshHost,
  WebsshHostBatchInput,
  WebsshHostBatchResult,
  WebsshHostEgress,
  WebsshHostFilters,
  WebsshHostIconKind,
  WebsshHostListResponse,
  WebsshHostQuickView,
  WebsshHostSessionSummary,
  WebsshHostTagCount,
  WebsshProviderCount,
} from '@shared/webssh/types'
import { normalizeProviderId } from '@shared/webssh/providers'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { parseHostEgress } from './egress'
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
  pinned: number
  sort_order: number
  provider: string
  icon_kind: string
  icon_value: string
  icon_key: string
  egress: string
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
/** D1 caps bound parameters per statement, so a bulk read or delete stays under that ceiling. */
const BATCH_CHUNK = 90

export type WebsshHostSort = 'manual' | 'name' | 'recent' | 'created' | 'provider'

export interface WebsshHostListOptions {
  query: string
  groupId: string
  quick: WebsshHostQuickView
  tag: string
  sort: WebsshHostSort
  filters: WebsshHostFilters
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
  pinned: boolean
  provider: string
  iconKind: WebsshHostIconKind
  iconValue: string
  iconKey: string
  egress: WebsshEgressConfig
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
    pinned: row.pinned === 1,
    sortOrder: row.sort_order,
    provider: row.provider || 'other',
    iconKind: (row.icon_kind === 'lucide' || row.icon_kind === 'emoji' || row.icon_kind === 'image' ? row.icon_kind : '') as WebsshHostIconKind,
    iconValue: row.icon_value,
    iconUrl: row.icon_key ? `/api/webssh/icons/${row.id}` : '',
    egress: parseHostEgress(row.egress),
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
  if (value === 'name' || value === 'recent' || value === 'created' || value === 'provider') return value
  return 'manual'
}

export function normalizeHostProvider(value: unknown, fallback?: string): string {
  if (value === undefined || value === null) return normalizeProviderId(fallback ?? '')
  return normalizeProviderId(value)
}

export function normalizeHostIconKind(value: unknown, fallback: WebsshHostIconKind = ''): WebsshHostIconKind {
  if (value === undefined || value === null || value === '') return fallback
  if (value === 'lucide' || value === 'emoji' || value === 'image') return value
  throw ApiError.badRequest('iconKind must be lucide, emoji, image or empty')
}

export function normalizeHostIconValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('iconValue must be a string')
  const icon = value.trim()
  if (icon.length > 64) throw ApiError.badRequest('iconValue cannot exceed 64 characters')
  if (/[\u0000-\u001f\u007f]/.test(icon)) throw ApiError.badRequest('iconValue cannot contain control characters')
  return icon
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

/** A `YYYY-MM-DD` filter value becomes the first or last millisecond of that UTC day. */
function dateBound(value: string, endOfDay: boolean): number | null {
  if (!value) return null
  const parsed = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed)) return null
  return endOfDay ? parsed + 86_399_999 : parsed
}

export class WebsshHostsStore extends WebsshStore {
  async list(options: WebsshHostListOptions): Promise<WebsshHostListResponse> {
    const where: string[] = ['user_id = ?1', 'deleted_at IS NULL']
    const binds: Array<string | number> = [this.userId]
    if (options.groupId) {
      where.push(`group_id = ?${binds.length + 1}`)
      binds.push(options.groupId)
    }
    if (options.quick === 'favorites') where.push('favorite = 1')
    if (options.quick === 'pinned') where.push('pinned = 1')
    if (options.quick === 'recent') where.push('last_connected_at IS NOT NULL')
    if (options.tag) {
      where.push(`EXISTS (SELECT 1 FROM json_each(webssh_hosts.tags) AS host_tag WHERE host_tag.value = ?${binds.length + 1})`)
      binds.push(options.tag)
    }
    const query = options.query.trim()
    if (query) {
      where.push(`(name_folded LIKE ?${binds.length + 1} ESCAPE '\\' OR host LIKE ?${binds.length + 1} ESCAPE '\\' OR username LIKE ?${binds.length + 1} ESCAPE '\\')`)
      binds.push(`%${escapeLikePattern(query.toLowerCase())}%`)
    }
    const filters = options.filters
    if (filters.provider) {
      where.push(`provider = ?${binds.length + 1}`)
      binds.push(filters.provider)
    }
    if (filters.pinned) where.push('pinned = 1')
    if (filters.status === 'connected') where.push('last_connected_at IS NOT NULL')
    if (filters.status === 'never') where.push('last_connected_at IS NULL')
    const connectedFrom = dateBound(filters.connected.from, false)
    const connectedTo = dateBound(filters.connected.to, true)
    if (connectedFrom !== null) {
      where.push(`last_connected_at >= ?${binds.length + 1}`)
      binds.push(connectedFrom)
    }
    if (connectedTo !== null) {
      where.push(`last_connected_at <= ?${binds.length + 1}`)
      binds.push(connectedTo)
    }
    const createdFrom = dateBound(filters.created.from, false)
    const createdTo = dateBound(filters.created.to, true)
    if (createdFrom !== null) {
      where.push(`created_at >= ?${binds.length + 1}`)
      binds.push(createdFrom)
    }
    if (createdTo !== null) {
      where.push(`created_at <= ?${binds.length + 1}`)
      binds.push(createdTo)
    }
    const clause = where.join(' AND ')
    const totalRow = await this.db.prepare(`SELECT COUNT(*) AS total FROM webssh_hosts WHERE ${clause}`)
      .bind(...binds)
      .first<{ total: number }>()
    const total = Number(totalRow?.total ?? 0)
    const page = Math.min(options.page, Math.max(1, Math.ceil(total / options.pageSize) || 1))
    const offset = (page - 1) * options.pageSize
    const order = options.sort === 'name'
      ? 'name_folded, created_at DESC'
      : options.sort === 'recent'
        ? 'COALESCE(last_connected_at, 0) DESC, name_folded'
        : options.sort === 'created'
          ? 'created_at DESC, name_folded'
          : options.sort === 'provider'
            ? 'provider, sort_order, name_folded'
            : 'sort_order, created_at DESC'
    const rows = await this.db.prepare(
      `SELECT id, name, host, port, username, group_id, auth_method, credential_id, key_id,
              encoding, term_type, initial_command, color, tags, notes, favorite, pinned, sort_order,
              provider, icon_kind, icon_value, icon_key, last_connected_at, created_at, updated_at
         FROM webssh_hosts
        WHERE ${clause}
        ORDER BY ${order}
        LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
    )
      .bind(...binds, options.pageSize, offset)
      .all<WebsshHostRow>()
    return { items: rows.results.map(toHost), total, page, pageSize: options.pageSize }
  }

  /** Counts and tag names for the rail; no host rows travel, so the rail stays cheap. */
  async overview(): Promise<{
    total: number
    favorites: number
    pinned: number
    connected: number
    never: number
    tags: WebsshHostTagCount[]
    providers: WebsshProviderCount[]
  }> {
    const counts = await this.db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END), 0) AS favorites,
              COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0) AS pinned,
              COALESCE(SUM(CASE WHEN last_connected_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS connected
         FROM webssh_hosts WHERE user_id = ?1 AND deleted_at IS NULL`,
    )
      .bind(this.userId)
      .first<{ total: number; favorites: number; pinned: number; connected: number }>()
    const tagRows = await this.db.prepare(
      `SELECT host_tag.value AS name, COUNT(*) AS count
         FROM webssh_hosts, json_each(webssh_hosts.tags) AS host_tag
        WHERE user_id = ?1 AND deleted_at IS NULL
        GROUP BY host_tag.value
        ORDER BY count DESC, name`,
    )
      .bind(this.userId)
      .all<{ name: string; count: number }>()
    const providerRows = await this.db.prepare(
      `SELECT h.provider AS id, COUNT(*) AS hostCount,
              COALESCE((SELECT COUNT(*) FROM webssh_sessions s
                WHERE s.user_id = ?1 AND s.host_id IN (
                  SELECT h2.id FROM webssh_hosts h2
                  WHERE h2.user_id = ?1 AND h2.deleted_at IS NULL AND h2.provider = h.provider
                )), 0) AS connectionCount
         FROM webssh_hosts h
        WHERE h.user_id = ?1 AND h.deleted_at IS NULL
        GROUP BY h.provider`,
    )
      .bind(this.userId)
      .all<{ id: string; hostCount: number; connectionCount: number }>()
    const total = Number(counts?.total ?? 0)
    const connected = Number(counts?.connected ?? 0)
    return {
      total,
      favorites: Number(counts?.favorites ?? 0),
      pinned: Number(counts?.pinned ?? 0),
      connected,
      never: total - connected,
      tags: tagRows.results.map((row) => ({ name: row.name, count: Number(row.count) })),
      providers: providerRows.results.map((row) => ({
        id: row.id || 'other',
        hostCount: Number(row.hostCount),
        connectionCount: Number(row.connectionCount),
      })),
    }
  }

  /** Direct host counts per folder; the rail adds the folder tree itself. */
  async groupCounts(): Promise<Map<string, number>> {
    const rows = await this.db.prepare(
      `SELECT group_id, COUNT(*) AS count FROM webssh_hosts
        WHERE user_id = ?1 AND deleted_at IS NULL AND group_id <> ''
        GROUP BY group_id`,
    )
      .bind(this.userId)
      .all<{ group_id: string; count: number }>()
    return new Map(rows.results.map((row) => [row.group_id, Number(row.count)]))
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
              encoding, term_type, initial_command, color, tags, notes, favorite, pinned, sort_order,
              provider, icon_kind, icon_value, icon_key, egress, last_connected_at, created_at, updated_at
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

  async hostExists(hostId: string): Promise<boolean> {
    if (!hostId || !isValidId(hostId)) return false
    const row = await this.db.prepare(
      'SELECT 1 AS found FROM webssh_hosts WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    )
      .bind(this.userId, hostId)
      .first<{ found: number }>()
    return Boolean(row)
  }

  async assertReferences(
    input: {
      groupId: string
      authMethod: WebsshAuthMethod
      credentialId: string
      keyId: string
      egress?: WebsshEgressConfig
    },
    selfId = '',
  ): Promise<void> {
    if (!(await this.groupExists(input.groupId))) throw ApiError.badRequest('The selected group does not exist')
    if (input.authMethod === 'password') {
      if (!input.credentialId) throw ApiError.badRequest('Choose a password credential for this host')
      if (!(await this.credentialExists(input.credentialId))) throw ApiError.badRequest('The selected credential does not exist')
    } else {
      if (!input.keyId) throw ApiError.badRequest('Choose a key for this host')
      if (!(await this.keyExists(input.keyId))) throw ApiError.badRequest('The selected key does not exist')
    }
    const egress = input.egress
    if (!egress) return
    if (egress.jumpHostId) {
      if (egress.jumpHostId === selfId) throw ApiError.badRequest('A host cannot use itself as its jump host')
      if (!(await this.hostExists(egress.jumpHostId))) throw ApiError.badRequest('The selected jump host does not exist')
    }
    if (egress.proxy.credentialId && !(await this.credentialExists(egress.proxy.credentialId))) {
      throw ApiError.badRequest('The selected proxy credential does not exist')
    }
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
  async createImported(input: { name: string; host: string; port: number; username: string; tags: string[]; provider?: string }): Promise<WebsshHost> {
    const id = newId()
    const sortOrder = await this.nextSortOrder('')
    await this.db.prepare(
      `INSERT INTO webssh_hosts (
         user_id, id, name, name_folded, host, port, username, group_id, auth_method, credential_id,
         key_id, encoding, term_type, initial_command, color, tags, notes, favorite, pinned, sort_order,
         provider, icon_kind, icon_value, icon_key, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', 'password', '', '', 'utf-8', 'xterm-256color', '',
                 '', ?8, '', 0, 0, ?9, ?10, '', '', '', ?11, ?11)`,
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
        normalizeProviderId(input.provider ?? ''),
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
         key_id, encoding, term_type, initial_command, color, tags, notes, favorite, pinned, sort_order,
         provider, icon_kind, icon_value, icon_key, egress, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                 ?21, ?22, ?23, ?24, ?25, ?26, ?26)`,
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
        input.pinned ? 1 : 0,
        sortOrder,
        input.provider,
        input.iconKind,
        input.iconValue,
        input.iconKey,
        JSON.stringify({ ...input.egress, regionResolved: null }),
        createdAt,
      )
      .run()
    return (await this.get(id))!
  }

  async update(id: string, input: WebsshHostInput): Promise<WebsshHost> {
    const existing = await this.get(id)
    if (!existing) throw ApiError.notFound('Host not found')
    await this.assertReferences(input, id)
    const updatedAt = Math.max(this.now, existing.updatedAt + 1)
    const sortOrder = input.sortOrder ?? (input.groupId !== existing.groupId ? await this.nextSortOrder(input.groupId) : existing.sortOrder)
    const current = await this.row(id)
    const iconKey = input.iconKind === 'image' ? (current?.icon_key ?? '') : ''
    const currentEgress = parseHostEgress(current?.egress)
    const nextEgress: WebsshHostEgress = {
      ...input.egress,
      regionResolved: input.egress.region === currentEgress.region ? currentEgress.regionResolved : null,
    }
    await this.db.prepare(
      `UPDATE webssh_hosts
          SET name = ?3, name_folded = ?4, host = ?5, port = ?6, username = ?7, group_id = ?8,
              auth_method = ?9, credential_id = ?10, key_id = ?11, encoding = ?12, term_type = ?13,
              initial_command = ?14, color = ?15, tags = ?16, notes = ?17, favorite = ?18,
              pinned = ?19, sort_order = ?20, provider = ?21, icon_kind = ?22, icon_value = ?23,
              icon_key = ?24, egress = ?25, updated_at = ?26
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
        input.pinned ? 1 : 0,
        sortOrder,
        input.provider,
        input.iconKind,
        input.iconValue,
        iconKey,
        JSON.stringify(nextEgress),
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

  /** Writes the uploaded icon object key; an empty key returns the row to its provider monogram. */
  async setIcon(id: string, key: string, kind: WebsshHostIconKind): Promise<void> {
    await this.db.prepare(
      `UPDATE webssh_hosts SET icon_key = ?3, icon_kind = ?4, icon_value = '', updated_at = ?5
        WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    )
      .bind(this.userId, id, key, kind, this.now)
      .run()
  }

  /**
   * Applies one action to many hosts. Every statement carries the owner id, so a forged id in the
   * payload is skipped rather than touched; `skipped` tells the caller how many were left out.
   */
  async batch(input: WebsshHostBatchInput): Promise<WebsshHostBatchResult> {
    const ids = [...new Set(input.ids)].filter((id) => isValidId(id)).slice(0, 100)
    if (ids.length === 0) return { affected: 0, skipped: input.ids.length }
    const found: Array<{ id: string; tags: string }> = []
    for (let start = 0; start < ids.length; start += BATCH_CHUNK) {
      const chunk = ids.slice(start, start + BATCH_CHUNK)
      const rows = await this.db.prepare(
        `SELECT id, tags FROM webssh_hosts
          WHERE user_id = ?1 AND deleted_at IS NULL AND id IN (${chunk.map((_, index) => `?${index + 2}`).join(', ')})`,
      )
        .bind(this.userId, ...chunk)
        .all<{ id: string; tags: string }>()
      found.push(...rows.results)
    }
    if (found.length === 0) return { affected: 0, skipped: input.ids.length }
    const now = this.now

    if (input.action === 'move') {
      const groupId = input.groupId ?? ''
      if (!(await this.groupExists(groupId))) throw ApiError.badRequest('The selected group does not exist')
      const base = await this.nextSortOrder(groupId)
      await this.db.batch(found.map((row, index) => this.db.prepare(
        `UPDATE webssh_hosts SET group_id = ?3, sort_order = ?4, updated_at = ?5
          WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
      ).bind(this.userId, row.id, groupId, base + index, now)))
      return { affected: found.length, skipped: input.ids.length - found.length }
    }

    if (input.action === 'tag') {
      const tags = input.tags ?? []
      if (tags.length === 0) throw ApiError.badRequest('Choose at least one tag')
      await this.db.batch(found.map((row) => {
        const merged = [...parseHostTags(row.tags)]
        for (const tag of tags) if (!merged.includes(tag)) merged.push(tag)
        return this.db.prepare(
          'UPDATE webssh_hosts SET tags = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
        ).bind(this.userId, row.id, JSON.stringify(merged.slice(0, WEBSSH_HOST_TAGS_MAX)), now)
      }))
      return { affected: found.length, skipped: input.ids.length - found.length }
    }

    if (input.action === 'provider') {
      const provider = normalizeProviderId(input.provider ?? '')
      await this.db.batch(found.map((row) => this.db.prepare(
        'UPDATE webssh_hosts SET provider = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
      ).bind(this.userId, row.id, provider, now)))
      return { affected: found.length, skipped: input.ids.length - found.length }
    }

    if (input.action === 'favorite' || input.action === 'unfavorite') {
      const favorite = input.action === 'favorite' ? 1 : 0
      await this.db.batch(found.map((row) => this.db.prepare(
        'UPDATE webssh_hosts SET favorite = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
      ).bind(this.userId, row.id, favorite, now)))
      return { affected: found.length, skipped: input.ids.length - found.length }
    }

    const statements = found.map((row) => this.db.prepare(
      'UPDATE webssh_hosts SET deleted_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL',
    ).bind(this.userId, row.id, now))
    for (let start = 0; start < found.length; start += BATCH_CHUNK) {
      const chunk = found.slice(start, start + BATCH_CHUNK)
      statements.push(this.db.prepare(
        `DELETE FROM webssh_host_keys
          WHERE user_id = ?1 AND host_id IN (${chunk.map((_, index) => `?${index + 2}`).join(', ')})`,
      ).bind(this.userId, ...chunk.map((row) => row.id)))
    }
    await this.db.batch(statements)
    return { affected: found.length, skipped: input.ids.length - found.length }
  }

  /** Copies everything a connection needs, leaving the new row unstarred and unlinked history. */
  async duplicate(id: string): Promise<WebsshHost> {
    const source = await this.get(id)
    if (!source) throw ApiError.notFound('Host not found')
    const name = await this.copyName(source.name, source.groupId)
    return await this.create({
      name,
      host: source.host,
      port: source.port,
      username: source.username,
      groupId: source.groupId,
      authMethod: source.authMethod,
      credentialId: source.credentialId,
      keyId: source.keyId,
      encoding: source.encoding,
      termType: source.termType,
      initialCommand: source.initialCommand,
      color: source.color,
      tags: source.tags,
      notes: source.notes,
      favorite: false,
      pinned: false,
      provider: source.provider,
      iconKind: source.iconKind,
      iconValue: source.iconValue,
      iconKey: source.iconUrl ? `webssh/icons/${this.userId}/${id}` : '',
      egress: {
        mode: source.egress.mode,
        region: source.egress.region,
        jumpHostId: source.egress.jumpHostId,
        proxy: source.egress.proxy,
        fallback: source.egress.fallback,
      },
      sortOrder: undefined,
    })
  }

  private async copyName(base: string, groupId: string): Promise<string> {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const suffix = attempt === 1 ? ' (copy)' : ` (copy ${attempt})`
      const candidate = `${base.slice(0, WEBSSH_HOST_NAME_MAX - suffix.length)}${suffix}`
      const taken = await this.db.prepare(
        `SELECT 1 AS found FROM webssh_hosts
          WHERE user_id = ?1 AND group_id = ?2 AND name_folded = ?3 AND deleted_at IS NULL LIMIT 1`,
      )
        .bind(this.userId, groupId, candidate.toLowerCase())
        .first<{ found: number }>()
      if (!taken) return candidate
    }
    return `${base.slice(0, WEBSSH_HOST_NAME_MAX - 8)} (copy)`
  }

  /**
   * Moves one host inside a folder, optionally just before another row. The midpoint between the
   * neighbours keeps the move to one statement instead of renumbering every sibling.
   */
  async move(id: string, groupId: string, beforeId: string): Promise<WebsshHost> {
    const existing = await this.get(id)
    if (!existing) throw ApiError.notFound('Host not found')
    if (!(await this.groupExists(groupId))) throw ApiError.badRequest('The selected group does not exist')
    let position: number
    const target = beforeId && isValidId(beforeId) ? await this.row(beforeId) : null
    if (target && target.group_id === groupId) {
      const previous = await this.db.prepare(
        `SELECT sort_order FROM webssh_hosts
          WHERE user_id = ?1 AND deleted_at IS NULL AND group_id = ?2 AND id <> ?3
            AND sort_order < ?4
          ORDER BY sort_order DESC LIMIT 1`,
      )
        .bind(this.userId, groupId, id, target.sort_order)
        .first<{ sort_order: number }>()
      position = previous ? (Number(previous.sort_order) + Number(target.sort_order)) / 2 : Number(target.sort_order) - 1000
    } else {
      position = await this.nextSortOrder(groupId)
    }
    await this.db.prepare(
      `UPDATE webssh_hosts SET group_id = ?3, sort_order = ?4, updated_at = ?5
        WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    )
      .bind(this.userId, id, groupId, position, Math.max(this.now, existing.updatedAt + 1))
      .run()
    return (await this.get(id))!
  }

  /** Every live host in one ordered pass; export is the one caller that needs no page. */
  async allForExport(): Promise<WebsshHost[]> {
    const rows = await this.db.prepare(
      `SELECT id, name, host, port, username, group_id, auth_method, credential_id, key_id,
              encoding, term_type, initial_command, color, tags, notes, favorite, pinned, sort_order,
              provider, icon_kind, icon_value, icon_key, last_connected_at, created_at, updated_at
         FROM webssh_hosts
        WHERE user_id = ?1 AND deleted_at IS NULL
        ORDER BY group_id, sort_order, name_folded`,
    )
      .bind(this.userId)
      .all<WebsshHostRow>()
    return rows.results.map(toHost)
  }

  async sessionHistory(hostId: string, limit: number): Promise<WebsshHostSessionSummary[]> {
    const rows = await this.db.prepare(
      `SELECT id, status, started_at, connected_at, ended_at, close_reason, error_code, recording_id
         FROM webssh_sessions
        WHERE user_id = ?1 AND host_id = ?2
        ORDER BY started_at DESC
        LIMIT ?3`,
    )
      .bind(this.userId, hostId, limit)
      .all<{
        id: string
        status: WebsshHostSessionSummary['status']
        started_at: number
        connected_at: number | null
        ended_at: number | null
        close_reason: string
        error_code: string
        recording_id: string
      }>()
    return rows.results.map((row) => ({
      id: row.id,
      status: row.status,
      startedAt: Number(row.started_at),
      connectedAt: row.connected_at === null ? null : Number(row.connected_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
      closeReason: row.close_reason,
      errorCode: row.error_code,
      recordingId: row.recording_id,
    }))
  }
}
