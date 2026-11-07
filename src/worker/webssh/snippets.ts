// Personal command snippets (plan §4/W7-02). The table predates this module in migration 298 and
// keys every row by `(user_id, id)`, so a snippet can never be read or written across accounts.
// A snippet has no host column: it belongs to the account and is inserted into whichever session the
// user is looking at, which is also why `touch` records use rather than ownership.

import type { WebsshSnippet, WebsshSnippetListResponse } from '@shared/webssh/types'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { escapeLikePattern, WebsshStore } from './store'

export const WEBSSH_SNIPPET_TITLE_MAX = 120
export const WEBSSH_SNIPPET_COMMAND_MAX = 4096
export const WEBSSH_SNIPPET_DESCRIPTION_MAX = 1000
export const WEBSSH_SNIPPET_TAG_MAX = 32
export const WEBSSH_SNIPPET_TAGS_MAX = 10
export const WEBSSH_SNIPPET_SHELL_MAX = 64

export interface WebsshSnippetRow {
  id: string
  title: string
  command: string
  description: string
  tags: string
  shell: string
  favorite: number
  sort_order: number
  created_at: number
  updated_at: number
  last_used_at: number | null
}

export const SNIPPET_COLUMNS =
  'id, title, command, description, tags, shell, favorite, sort_order, created_at, updated_at, last_used_at'

export interface WebsshSnippetInput {
  title: string
  command: string
  description: string
  tags: string[]
  shell: string
  favorite: boolean
  sortOrder?: number
}

export interface WebsshSnippetListOptions {
  query: string
  favoriteOnly: boolean
  page: number
  pageSize: number
}

function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function toSnippet(row: WebsshSnippetRow): WebsshSnippet {
  return {
    id: row.id,
    title: row.title,
    command: row.command,
    description: row.description,
    tags: parseTags(row.tags),
    shell: row.shell,
    favorite: row.favorite === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }
}

export function normalizeSnippetTitle(value: unknown, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw ApiError.badRequest('Snippet title is required')
    return ''
  }
  if (typeof value !== 'string') throw ApiError.badRequest('Snippet title must be a string')
  const title = value.trim()
  if (!title) {
    if (required) throw ApiError.badRequest('Snippet title cannot be empty')
    return ''
  }
  if (title.length > WEBSSH_SNIPPET_TITLE_MAX) {
    throw ApiError.badRequest(`Snippet title cannot exceed ${WEBSSH_SNIPPET_TITLE_MAX} characters`)
  }
  if (/[\u0000-\u001f\u007f]/.test(title)) throw ApiError.badRequest('Snippet title cannot contain control characters')
  return title
}

export function normalizeSnippetCommand(value: unknown, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw ApiError.badRequest('Snippet command is required')
    return ''
  }
  if (typeof value !== 'string') throw ApiError.badRequest('Snippet command must be a string')
  const command = value.replace(/\r\n/g, '\n')
  if (!command) {
    if (required) throw ApiError.badRequest('Snippet command cannot be empty')
    return ''
  }
  if (command.length > WEBSSH_SNIPPET_COMMAND_MAX) {
    throw ApiError.badRequest(`Snippet command cannot exceed ${WEBSSH_SNIPPET_COMMAND_MAX} characters`)
  }
  if (/[\u0000\u0007\u000b\u000c\u001a]/i.test(command)) {
    throw ApiError.badRequest('Snippet command cannot contain NUL or terminal control bytes')
  }
  return command
}

export function normalizeSnippetDescription(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('Snippet description must be a string')
  if (value.length > WEBSSH_SNIPPET_DESCRIPTION_MAX) {
    throw ApiError.badRequest(`Snippet description cannot exceed ${WEBSSH_SNIPPET_DESCRIPTION_MAX} characters`)
  }
  return value
}

export function normalizeSnippetTags(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw ApiError.badRequest('Snippet tags must be an array of strings')
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw ApiError.badRequest('Snippet tags must be an array of strings')
    const tag = item.trim()
    if (!tag) continue
    if (tag.length > WEBSSH_SNIPPET_TAG_MAX) throw ApiError.badRequest(`A snippet tag cannot exceed ${WEBSSH_SNIPPET_TAG_MAX} characters`)
    if (/[\u0000-\u001f\u007f]/.test(tag)) throw ApiError.badRequest('A snippet tag cannot contain control characters')
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > WEBSSH_SNIPPET_TAGS_MAX) {
    throw ApiError.badRequest(`A snippet cannot carry more than ${WEBSSH_SNIPPET_TAGS_MAX} tags`)
  }
  return tags
}

export function normalizeSnippetShell(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > WEBSSH_SNIPPET_SHELL_MAX) {
    throw ApiError.badRequest('Snippet shell is invalid')
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw ApiError.badRequest('Snippet shell cannot contain control characters')
  return value.trim()
}

export class WebsshSnippetsStore extends WebsshStore {
  async list(options: WebsshSnippetListOptions): Promise<WebsshSnippetListResponse> {
    const query = options.query.trim()
    const pattern = query ? `%${escapeLikePattern(query.toLowerCase())}%` : ''
    const where = `user_id = ?1
        AND (?2 = 0 OR favorite = 1)
        AND (?3 = 0 OR title_folded LIKE ?4 ESCAPE '\\' OR command LIKE ?4 ESCAPE '\\' OR tags LIKE ?4 ESCAPE '\\')`
    const totalRow = await this.db.prepare(`SELECT COUNT(*) AS total FROM webssh_snippets WHERE ${where}`)
      .bind(this.userId, options.favoriteOnly ? 1 : 0, query ? 1 : 0, pattern)
      .first<{ total: number }>()
    const total = Number(totalRow?.total ?? 0)
    const page = Math.min(options.page, Math.max(1, Math.ceil(total / options.pageSize) || 1))
    const offset = (page - 1) * options.pageSize
    const rows = await this.db.prepare(
      `SELECT ${SNIPPET_COLUMNS} FROM webssh_snippets
        WHERE ${where}
        ORDER BY favorite DESC, sort_order, created_at DESC
        LIMIT ?5 OFFSET ?6`,
    )
      .bind(this.userId, options.favoriteOnly ? 1 : 0, query ? 1 : 0, pattern, options.pageSize, offset)
      .all<WebsshSnippetRow>()
    return { items: rows.results.map(toSnippet), total, page, pageSize: options.pageSize }
  }

  async get(id: string): Promise<WebsshSnippet | null> {
    const row = await this.row(id)
    return row ? toSnippet(row) : null
  }

  async row(id: string): Promise<WebsshSnippetRow | null> {
    if (!isValidId(id)) return null
    return await this.db.prepare(
      `SELECT ${SNIPPET_COLUMNS} FROM webssh_snippets WHERE user_id = ?1 AND id = ?2`,
    )
      .bind(this.userId, id)
      .first<WebsshSnippetRow>()
  }

  async nextSortOrder(): Promise<number> {
    const row = await this.db.prepare(
      'SELECT MAX(sort_order) AS sort_order FROM webssh_snippets WHERE user_id = ?1',
    )
      .bind(this.userId)
      .first<{ sort_order: number | null }>()
    return (row?.sort_order ?? 0) + 1000
  }

  async create(input: WebsshSnippetInput): Promise<WebsshSnippet> {
    const id = newId()
    const sortOrder = input.sortOrder ?? await this.nextSortOrder()
    await this.db.prepare(
      `INSERT INTO webssh_snippets (
         user_id, id, title, title_folded, command, description, tags, shell, favorite, sort_order,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
    )
      .bind(
        this.userId,
        id,
        input.title,
        input.title.toLowerCase(),
        input.command,
        input.description,
        JSON.stringify(input.tags),
        input.shell,
        input.favorite ? 1 : 0,
        sortOrder,
        this.now,
      )
      .run()
    return (await this.get(id))!
  }

  async update(id: string, input: WebsshSnippetInput): Promise<WebsshSnippet> {
    const existing = await this.get(id)
    if (!existing) throw ApiError.notFound('Snippet not found')
    const updatedAt = Math.max(this.now, existing.updatedAt + 1)
    await this.db.prepare(
      `UPDATE webssh_snippets
          SET title = ?3, title_folded = ?4, command = ?5, description = ?6, tags = ?7, shell = ?8,
              favorite = ?9, sort_order = ?10, updated_at = ?11
        WHERE user_id = ?1 AND id = ?2`,
    )
      .bind(
        this.userId,
        id,
        input.title,
        input.title.toLowerCase(),
        input.command,
        input.description,
        JSON.stringify(input.tags),
        input.shell,
        input.favorite ? 1 : 0,
        input.sortOrder ?? existing.sortOrder,
        updatedAt,
      )
      .run()
    return (await this.get(id))!
  }

  async remove(id: string): Promise<boolean> {
    if (!isValidId(id)) return false
    const result = await this.db.prepare(
      'DELETE FROM webssh_snippets WHERE user_id = ?1 AND id = ?2',
    )
      .bind(this.userId, id)
      .run()
    return Number(result.meta.changes ?? 0) > 0
  }

  /** Records that the snippet was inserted into a terminal; history is informational only. */
  async touch(id: string): Promise<WebsshSnippet | null> {
    const existing = await this.get(id)
    if (!existing) return null
    await this.db.prepare(
      'UPDATE webssh_snippets SET last_used_at = ?3 WHERE user_id = ?1 AND id = ?2',
    )
      .bind(this.userId, id, this.now)
      .run()
    return await this.get(id)
  }
}
