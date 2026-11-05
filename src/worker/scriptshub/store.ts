/**
 * The D1 side of ScriptsHub.
 *
 * Every statement is pinned to the account this store was built for, and the routes never hold a
 * ready-made `WHERE` clause of their own: a row that belongs to somebody else is not "not found",
 * it is unreachable. Snippet bodies are read for the one detail the reader opened, never for a list —
 * a list row carries the file count and a short language, not megabytes of code.
 */

import { defaultFileNames, languageFor, type ScriptLanguageId } from '@shared/scriptshub/languages'
import { diffLines } from 'diff'
import { publicationPathProblem } from '@shared/scriptshub/path'
import { importTitleDecision } from '@shared/scriptshub/import'
import { publishedShare } from '@shared/scriptshub/stats'
import type {
  ScriptBatchInput,
  ScriptFolder,
  ScriptFolderInput,
  ScriptImportEntry,
  ScriptImportConflict,
  ScriptImportResult,
  ScriptListQuery,
  ScriptListResponse,
  ScriptPublication,
  ScriptPublicationCreated,
  ScriptPublicationInput,
  ScriptPublicationPatch,
  ScriptPublicationSummary,
  ScriptPublicationVisibility,
  ScriptRevisionMeta,
  ScriptRevisionSnapshot,
  ScriptRevisionSource,
  ScriptSnippetDetail,
  ScriptSnippetInput,
  ScriptSnippetSaveInput,
  ScriptSnippetSummary,
  ScriptStatsRange,
  ScriptStatsResponse,
  ScriptTag,
  ScriptTagInput,
  ScriptsHubOverview,
} from '@shared/scriptshub/types'
import { ApiError } from '../lib/errors'
import { newId, newSlug, isValidId } from '../lib/id'
import { sha256Hex, timingSafeEqual } from '../lib/encoding'
import { parseScriptStatsRange, scriptStatsSince } from '@shared/scriptshub/stats'

const TITLE_MAX = 160
const DESCRIPTION_MAX = 400
const NOTES_MAX = 2000
const SOURCE_URL_MAX = 500
const NAME_MAX = 128
const FILE_MAX = 32
const FILE_CHARS_MAX = 512_000
const TOTAL_CHARS_MAX = 1_500_000
const TAG_NAME_MAX = 64
const FOLDER_NAME_MAX = 64
const MAX_REVISIONS = 100
const MAX_BATCH = 100
const LIST_LIMIT_MAX = 100
const SEARCH_TOKENS_MAX = 5
const SEARCH_TOKEN_MAX = 28
const DAY_MS = 24 * 60 * 60 * 1000

export interface ScriptAssetRow {
  id: string
  snippet_id: string
  file_name: string
  content_type: string
  byte_size: number
  r2_key: string
  created_at: number
}

interface SnippetRow {
  id: string
  title: string
  description: string
  folder_id: string | null
  language: string
  source_url: string
  notes: string
  is_favorite: number
  is_pinned: number
  is_deprecated: number
  copy_count: number
  download_count: number
  created_at: number
  updated_at: number
  last_used_at: number | null
  rev: number
  file_count?: number
  char_count?: number
  preview?: string
}

interface FileRow {
  id: string
  name: string
  language: string
  content: string
  position: number
  updated_at: number
}

interface TagRow {
  id: string
  name: string
  parent_id: string | null
  color: string | null
  created_at: number
  updated_at: number
  snippet_count?: number
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function cleanTitle(value: unknown): string {
  const title = clip(value, TITLE_MAX).trim()
  if (!title) throw ApiError.badRequest('A snippet needs a title')
  return title
}

function cleanFolderName(value: unknown): string {
  const name = clip(value, FOLDER_NAME_MAX).replace(/\s+/g, ' ').trim()
  if (!name) throw ApiError.badRequest('A folder needs a name')
  return name
}

function cleanTagName(value: unknown): string {
  const name = clip(value, TAG_NAME_MAX).replace(/^#+/, '').replace(/\s+/g, ' ').trim()
  if (!name) throw ApiError.badRequest('A tag needs a name')
  return name
}

function cleanColor(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw ApiError.badRequest('A colour must be a string')
  const color = value.trim()
  if (!color) return null
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) throw ApiError.badRequest('A colour must be a hex value')
  return color.toLowerCase()
}

function cleanSourceUrl(value: unknown): string {
  const url = clip(value, SOURCE_URL_MAX).trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) throw ApiError.badRequest('A source URL must begin with http:// or https://')
  return url
}

function snippetRow(row: SnippetRow): ScriptSnippetSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    folderId: row.folder_id,
    language: languageFor(row.language).id,
    isFavorite: row.is_favorite === 1,
    isPinned: row.is_pinned === 1,
    isDeprecated: row.is_deprecated === 1,
    copyCount: row.copy_count,
    downloadCount: row.download_count,
    fileCount: Number(row.file_count ?? 0),
    preview: row.preview ?? '',
    charCount: Number(row.char_count ?? 0),
    tags: [],
    publications: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }
}

function tagRow(row: TagRow): ScriptTag {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snippetCount: Number(row.snippet_count ?? 0),
  }
}

function folderRow(row: {
  id: string
  parent_id: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  created_at: number
  updated_at: number
  snippet_count?: number
}): ScriptFolder {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snippetCount: Number(row.snippet_count ?? 0),
  }
}

function publicationRow(row: {
  id: string
  snippet_id: string
  file_id: string
  path: string
  is_enabled: number
  visibility: string
  token_hash: string | null
  expires_at: number | null
  short_slug: string | null
  created_at: number
  updated_at: number
  last_served_at: number | null
}): ScriptPublicationSummary {
  return {
    id: row.id,
    path: row.path,
    isEnabled: row.is_enabled === 1,
    visibility: row.visibility === 'token' ? 'token' : 'public',
    hasToken: Boolean(row.token_hash),
    expiresAt: row.expires_at,
    shortSlug: row.short_slug,
    fileId: row.file_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastServedAt: row.last_served_at,
  }
}

function clampedLimit(value: unknown): number {
  const number = typeof value === 'number' ? Math.trunc(value) : LIST_LIMIT_MAX
  return Math.min(LIST_LIMIT_MAX, Math.max(1, number))
}

/**
 * The words a search is built from, and the SQL it is built with.
 *
 * `instr(lower(text), token)` is deliberately used instead of `LIKE '%token%'`: SQLite's LIKE pattern
 * has a length ceiling, and a pasted paragraph of Chinese used to push a request over it with a
 * "LIKE or GLOB pattern too complex" error. `instr` has no pattern, so the only bound is the one the
 * route applies here — five tokens, twenty-eight characters each, the rest ignored.
 */
export function searchTokens(query: string | undefined): string[] {
  if (!query) return []
  const withoutQuotes = query.replace(/["']/g, ' ')
  return withoutQuotes
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase().slice(0, SEARCH_TOKEN_MAX))
    .filter(Boolean)
    .slice(0, SEARCH_TOKENS_MAX)
}

export class ScriptsHubStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  private get user(): string {
    return this.userId
  }

  // ---------------------------------------------------------------- folders

  async listFolders(): Promise<ScriptFolder[]> {
    const { results } = await this.db.prepare(
      `SELECT f.id, f.parent_id, f.name, f.icon, f.color, f.position, f.created_at, f.updated_at,
              (SELECT COUNT(*) FROM scriptshub_snippets s
                WHERE s.user_id = f.user_id AND s.folder_id = f.id) AS snippet_count
         FROM scriptshub_folders f
        WHERE f.user_id = ?
        ORDER BY f.position, f.name COLLATE NOCASE`,
    ).bind(this.user).all<Parameters<typeof folderRow>[0]>()
    return results.map(folderRow)
  }

  async createFolder(input: ScriptFolderInput): Promise<ScriptFolder> {
    const name = cleanFolderName(input.name)
    const now = Date.now()
    const parentId = input.parentId ?? null
    if (parentId) await this.assertFolder(parentId)
    const siblings = await this.db.prepare(
      `SELECT id FROM scriptshub_folders WHERE user_id = ? AND parent_id IS ?`,
    ).bind(this.user, parentId).all<{ id: string }>()
    if (await this.siblingFolderNamed(parentId, name, null)) {
      throw ApiError.conflict('A folder with this name already exists here')
    }
    const id = input.id && isValidId(input.id) ? input.id : newId()
    const position = siblings.results.length
    const icon = input.icon === undefined ? null : clip(input.icon, 32) || null
    const color = cleanColor(input.color)
    await this.db.prepare(
      `INSERT INTO scriptshub_folders (user_id, id, parent_id, name, position, icon, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(this.user, id, parentId, name, position, icon, color, now, now).run()
    const folder = (await this.listFolders()).find((entry) => entry.id === id)
    return folder ?? {
      id, parentId, name, icon, color, position, createdAt: now, updatedAt: now, snippetCount: 0,
    }
  }

  async updateFolder(id: string, input: Partial<ScriptFolderInput>): Promise<ScriptFolder> {
    const existing = await this.folderState(id)
    if (!existing) throw ApiError.notFound('Folder not found')
    const sets: string[] = []
    const binds: Array<string | number | null> = []
    const parentId = input.parentId !== undefined ? input.parentId : existing.parent_id
    if (input.name !== undefined) {
      const name = cleanFolderName(input.name)
      if (await this.siblingFolderNamed(parentId, name, id)) {
        throw ApiError.conflict('A folder with this name already exists here')
      }
      sets.push('name = ?')
      binds.push(name)
    }
    if (input.parentId !== undefined) {
      if (parentId === id) throw ApiError.badRequest('A folder cannot sit inside itself')
      if (parentId) {
        await this.assertFolder(parentId)
        const descendants = await this.folderDescendants(id)
        if (descendants.includes(parentId)) throw ApiError.badRequest('A folder cannot move into its own subtree')
      }
      sets.push('parent_id = ?')
      binds.push(parentId)
    }
    if (input.icon !== undefined) {
      sets.push('icon = ?')
      binds.push(clip(input.icon, 32) || null)
    }
    if (input.color !== undefined) {
      sets.push('color = ?')
      binds.push(cleanColor(input.color))
    }
    // A move into another parent appends at the end; an explicit slot (the "move earlier/later"
    // menu) inserts at that index. The rows after the slot shift right first, in the same batch, so
    // two folders never share a position and the ordering survives the next read.
    const placing = input.position !== undefined || (input.parentId !== undefined && input.parentId !== existing.parent_id)
    if (!sets.length && !placing) throw ApiError.badRequest('Nothing to change')
    const statements: D1PreparedStatement[] = []
    if (placing) {
      const siblings = await this.db.prepare(
        `SELECT id, position FROM scriptshub_folders
          WHERE user_id = ? AND parent_id IS ? AND id <> ?
          ORDER BY position, name COLLATE NOCASE`,
      ).bind(this.user, parentId, id).all<{ id: string; position: number }>()
      const target = input.position === undefined
        ? siblings.results.length
        : Math.min(Math.max(0, Math.trunc(input.position)), siblings.results.length)
      // Renumber every remaining sibling to its final slot, leaving `target` for the moved row. This
      // also repairs slots that drifted (two folders at the same position) instead of inheriting them.
      siblings.results.forEach((sibling, slot) => {
        const next = slot >= target ? slot + 1 : slot
        if (sibling.position === next) return
        statements.push(this.db.prepare(
          'UPDATE scriptshub_folders SET position = ? WHERE user_id = ? AND id = ?',
        ).bind(next, this.user, sibling.id))
      })
      sets.push('position = ?')
      binds.push(target)
    }
    sets.push('updated_at = ?')
    binds.push(Date.now())
    statements.push(this.db.prepare(
      `UPDATE scriptshub_folders SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`,
    ).bind(...binds, this.user, id))
    if (statements.length === 1) await statements[0]!.run()
    else await this.db.batch(statements)
    const folder = (await this.listFolders()).find((entry) => entry.id === id)
    if (!folder) throw ApiError.notFound('Folder not found')
    return folder
  }

  /**
   * Delete a folder without orphaning what it held: its nested folders and snippets move up to the
   * folder's own parent, and the move and the delete are one batch. A snippet left pointing at a
   * deleted folder would be invisible in every folder view, which is worse than a moved one.
   */
  async deleteFolder(id: string): Promise<void> {
    const folder = await this.folderState(id)
    if (!folder) throw ApiError.notFound('Folder not found')
    const now = Date.now()
    await this.db.batch([
      this.db.prepare(
        'UPDATE scriptshub_folders SET parent_id = ?, updated_at = ? WHERE user_id = ? AND parent_id = ?',
      ).bind(folder.parent_id, now, this.user, id),
      this.db.prepare(
        'UPDATE scriptshub_snippets SET folder_id = ?, updated_at = ? WHERE user_id = ? AND folder_id = ?',
      ).bind(folder.parent_id, now, this.user, id),
      this.db.prepare('DELETE FROM scriptshub_folders WHERE user_id = ? AND id = ?').bind(this.user, id),
    ])
  }

  private async folderState(id: string): Promise<{ parent_id: string | null; position: number } | null> {
    return this.db.prepare('SELECT parent_id, position FROM scriptshub_folders WHERE user_id = ? AND id = ?')
      .bind(this.user, id).first<{ parent_id: string | null; position: number }>()
  }

  private async assertFolder(id: string): Promise<void> {
    const row = await this.folderState(id)
    if (!row) throw ApiError.badRequest('The folder does not exist')
  }

  private async siblingFolderNamed(parentId: string | null, name: string, exceptId: string | null): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS present FROM scriptshub_folders
        WHERE user_id = ? AND parent_id IS ? AND lower(name) = lower(?) AND id <> ? LIMIT 1`,
    ).bind(this.user, parentId, name, exceptId ?? '').first<{ present: number }>()
    return Boolean(row)
  }

  private async folderDescendants(id: string): Promise<string[]> {
    const folders = await this.listFolders()
    const out: string[] = []
    const pending = [id]
    while (pending.length) {
      const current = pending.pop()!
      if (out.includes(current)) continue
      out.push(current)
      for (const folder of folders) {
        if (folder.parentId === current) pending.push(folder.id)
      }
    }
    return out
  }

  // ------------------------------------------------------------------- tags

  async listTags(): Promise<ScriptTag[]> {
    const { results } = await this.db.prepare(
      `SELECT t.id, t.name, t.parent_id, t.color, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM scriptshub_snippet_tags st
                WHERE st.user_id = t.user_id AND st.tag_id = t.id) AS snippet_count
         FROM scriptshub_tags t
        WHERE t.user_id = ?
        ORDER BY t.name COLLATE NOCASE`,
    ).bind(this.user).all<TagRow>()
    return results.map(tagRow)
  }

  async createTag(input: ScriptTagInput): Promise<ScriptTag> {
    const name = cleanTagName(input.name)
    const parentId = input.parentId ?? null
    if (parentId) await this.assertTag(parentId)
    if (await this.siblingTagNamed(parentId, name, null)) {
      throw ApiError.conflict('A tag with this name already exists here')
    }
    const id = input.id && isValidId(input.id) ? input.id : newId()
    const now = Date.now()
    const color = cleanColor(input.color)
    await this.db.prepare(
      `INSERT INTO scriptshub_tags (user_id, id, name, parent_id, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(this.user, id, name, parentId, color, now, now).run()
    const tag = (await this.listTags()).find((entry) => entry.id === id)
    return tag ?? {
      id, name, parentId, color, createdAt: now, updatedAt: now, snippetCount: 0,
    }
  }

  async updateTag(id: string, input: Partial<ScriptTagInput>): Promise<ScriptTag> {
    const existing = await this.db.prepare('SELECT parent_id FROM scriptshub_tags WHERE user_id = ? AND id = ?')
      .bind(this.user, id).first<{ parent_id: string | null }>()
    if (!existing) throw ApiError.notFound('Tag not found')
    const sets: string[] = []
    const binds: Array<string | number | null> = []
    if (input.name !== undefined) {
      const name = cleanTagName(input.name)
      const parentId = input.parentId !== undefined ? input.parentId : existing.parent_id
      if (await this.siblingTagNamed(parentId, name, id)) throw ApiError.conflict('A tag with this name already exists here')
      sets.push('name = ?')
      binds.push(name)
    }
    if (input.parentId !== undefined) {
      const parentId = input.parentId
      if (parentId === id) throw ApiError.badRequest('A tag cannot sit inside itself')
      if (parentId) await this.assertTag(parentId)
      const descendants = await this.tagDescendants(id)
      if (parentId && descendants.includes(parentId)) throw ApiError.badRequest('A tag cannot move into its own subtree')
      sets.push('parent_id = ?')
      binds.push(parentId)
    }
    if (input.color !== undefined) {
      sets.push('color = ?')
      binds.push(cleanColor(input.color))
    }
    if (!sets.length) throw ApiError.badRequest('Nothing to change')
    sets.push('updated_at = ?')
    binds.push(Date.now())
    await this.db.prepare(
      `UPDATE scriptshub_tags SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`,
    ).bind(...binds, this.user, id).run()
    const tag = (await this.listTags()).find((entry) => entry.id === id)
    if (!tag) throw ApiError.notFound('Tag not found')
    return tag
  }

  async deleteTag(id: string): Promise<void> {
    const existing = await this.db.prepare('SELECT parent_id FROM scriptshub_tags WHERE user_id = ? AND id = ?')
      .bind(this.user, id).first<{ parent_id: string | null }>()
    if (!existing) throw ApiError.notFound('Tag not found')
    await this.db.batch([
      this.db.prepare('UPDATE scriptshub_tags SET parent_id = ? WHERE user_id = ? AND parent_id = ?')
        .bind(existing.parent_id, this.user, id),
      this.db.prepare('DELETE FROM scriptshub_snippet_tags WHERE user_id = ? AND tag_id = ?').bind(this.user, id),
      this.db.prepare('DELETE FROM scriptshub_tags WHERE user_id = ? AND id = ?').bind(this.user, id),
    ])
  }

  private async assertTag(id: string): Promise<void> {
    const row = await this.db.prepare('SELECT 1 AS present FROM scriptshub_tags WHERE user_id = ? AND id = ?')
      .bind(this.user, id).first<{ present: number }>()
    if (!row) throw ApiError.badRequest('The tag does not exist')
  }

  private async siblingTagNamed(parentId: string | null, name: string, exceptId: string | null): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS present FROM scriptshub_tags
        WHERE user_id = ? AND parent_id IS ? AND lower(name) = lower(?) AND id <> ? LIMIT 1`,
    ).bind(this.user, parentId, name, exceptId ?? '').first<{ present: number }>()
    return Boolean(row)
  }

  private async tagDescendants(id: string): Promise<string[]> {
    const tags = await this.listTags()
    const out: string[] = []
    const pending = [id]
    while (pending.length) {
      const current = pending.pop()!
      if (out.includes(current)) continue
      out.push(current)
      for (const tag of tags) {
        if (tag.parentId === current) pending.push(tag.id)
      }
    }
    return out
  }

  // --------------------------------------------------------------- overview

  async overview(): Promise<ScriptsHubOverview> {
    const [folders, tags, counts] = await Promise.all([
      this.listFolders(),
      this.listTags(),
      this.counts(),
    ])
    return { folders, tags, counts }
  }

  private async counts(): Promise<ScriptsHubOverview['counts']> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS snippets,
              SUM(CASE WHEN is_favorite = 1 THEN 1 ELSE 0 END) AS favorites,
              SUM(CASE WHEN is_pinned = 1 THEN 1 ELSE 0 END) AS pinned,
              SUM(CASE WHEN is_deprecated = 1 THEN 1 ELSE 0 END) AS deprecated
         FROM scriptshub_snippets WHERE user_id = ?`,
    ).bind(this.user).first<{ snippets: number; favorites: number; pinned: number; deprecated: number }>()
    const published = await this.db.prepare(
      `SELECT COUNT(DISTINCT snippet_id) AS published FROM scriptshub_publications WHERE user_id = ?`,
    ).bind(this.user).first<{ published: number }>()
    return {
      snippets: Number(row?.snippets ?? 0),
      favorites: Number(row?.favorites ?? 0),
      pinned: Number(row?.pinned ?? 0),
      deprecated: Number(row?.deprecated ?? 0),
      published: Number(published?.published ?? 0),
    }
  }

  // --------------------------------------------------------------- snippets

  async listSnippets(query: ScriptListQuery): Promise<ScriptListResponse> {
    const limit = clampedLimit(query.limit)
    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const where = ['s.user_id = ?']
    const binds: Array<string | number> = [this.user]
    if (query.folderId) {
      const descendants = await this.folderDescendants(query.folderId)
      if (!descendants.length) return { items: [], total: 0, limit, offset }
      where.push(`s.folder_id IN (${descendants.map(() => '?').join(', ')})`)
      binds.push(...descendants)
    }
    if (query.tagId) {
      where.push('EXISTS (SELECT 1 FROM scriptshub_snippet_tags st WHERE st.user_id = s.user_id AND st.snippet_id = s.id AND st.tag_id = ?)')
      binds.push(query.tagId)
    }
    if (query.quick === 'favorites') where.push('s.is_favorite = 1')
    if (query.quick === 'pinned') where.push('s.is_pinned = 1')
    if (query.quick === 'deprecated') where.push('s.is_deprecated = 1')
    if (query.quick === 'published') {
      where.push('EXISTS (SELECT 1 FROM scriptshub_publications p WHERE p.user_id = s.user_id AND p.snippet_id = s.id)')
    }
    for (const token of searchTokens(query.search)) {
      where.push(`(instr(lower(s.title), ?) > 0 OR instr(lower(s.description), ?) > 0
        OR EXISTS (SELECT 1 FROM scriptshub_files f
                    WHERE f.user_id = s.user_id AND f.snippet_id = s.id AND instr(lower(f.content), ?) > 0))`)
      binds.push(token, token, token)
    }
    const totalRow = await this.db.prepare(
      `SELECT COUNT(*) AS total FROM scriptshub_snippets s WHERE ${where.join(' AND ')}`,
    ).bind(...binds).first<{ total: number }>()

    const order = query.sort === 'created'
      ? 's.created_at DESC, s.id'
      : query.sort === 'title'
        ? 's.title COLLATE NOCASE, s.id'
        : query.sort === 'uses'
          ? '(s.copy_count + s.download_count) DESC, s.updated_at DESC'
          : 's.updated_at DESC, s.id'
    const { results } = await this.db.prepare(
      `SELECT s.id, s.title, s.description, s.folder_id, s.language, s.source_url, s.notes,
              s.is_favorite, s.is_pinned, s.is_deprecated, s.copy_count, s.download_count,
              s.created_at, s.updated_at, s.last_used_at,
              (SELECT COUNT(*) FROM scriptshub_files f WHERE f.user_id = s.user_id AND f.snippet_id = s.id) AS file_count,
              (SELECT COALESCE(SUM(length(f.content)), 0) FROM scriptshub_files f
                WHERE f.user_id = s.user_id AND f.snippet_id = s.id) AS char_count,
              (SELECT substr(replace(replace(f.content, char(13), ' '), char(10), ' '), 1, 200)
                 FROM scriptshub_files f
                WHERE f.user_id = s.user_id AND f.snippet_id = s.id
                ORDER BY f.position, f.created_at LIMIT 1) AS preview
         FROM scriptshub_snippets s
        WHERE ${where.join(' AND ')}
        ORDER BY s.is_pinned DESC, ${order}
        LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset).all<SnippetRow>()

    const items = results.map(snippetRow)
    if (items.length) await this.attachListRelations(items)
    return { items, total: Number(totalRow?.total ?? 0), limit, offset }
  }

  private async attachListRelations(items: ScriptSnippetSummary[]): Promise<void> {
    const ids = items.map((item) => item.id)
    const placeholders = ids.map(() => '?').join(', ')
    const [{ results: tagRows }, { results: publicationRows }] = await Promise.all([
      this.db.prepare(
        `SELECT st.snippet_id, t.id, t.name, t.parent_id, t.color, t.created_at, t.updated_at
           FROM scriptshub_snippet_tags st
           JOIN scriptshub_tags t ON t.user_id = st.user_id AND t.id = st.tag_id
          WHERE st.user_id = ? AND st.snippet_id IN (${placeholders})
          ORDER BY t.name COLLATE NOCASE`,
      ).bind(this.user, ...ids).all<{ snippet_id: string } & TagRow>(),
      this.db.prepare(
        `SELECT id, snippet_id, file_id, path, is_enabled, visibility, token_hash, expires_at, short_slug,
                created_at, updated_at, last_served_at
           FROM scriptshub_publications
          WHERE user_id = ? AND snippet_id IN (${placeholders})
          ORDER BY created_at DESC`,
      ).bind(this.user, ...ids).all<{ snippet_id: string } & Parameters<typeof publicationRow>[0]>(),
    ])
    const tagById = new Map(items.map((item) => [item.id, [] as ScriptTag[]]))
    for (const row of tagRows) tagById.get(row.snippet_id)?.push(tagRow(row))
    const publicationBySnippet = new Map<string, ScriptPublicationSummary[]>()
    for (const row of publicationRows) {
      const list = publicationBySnippet.get(row.snippet_id) ?? []
      list.push(publicationRow(row))
      publicationBySnippet.set(row.snippet_id, list)
    }
    for (const item of items) {
      item.tags = tagById.get(item.id) ?? []
      item.publications = publicationBySnippet.get(item.id) ?? []
    }
  }

  async getSnippet(id: string): Promise<ScriptSnippetDetail> {
    const row = await this.db.prepare(
      `SELECT s.id, s.title, s.description, s.folder_id, s.language, s.source_url, s.notes,
              s.is_favorite, s.is_pinned, s.is_deprecated, s.copy_count, s.download_count,
              s.created_at, s.updated_at, s.last_used_at, s.rev,
              (SELECT COUNT(*) FROM scriptshub_files f WHERE f.user_id = s.user_id AND f.snippet_id = s.id) AS file_count,
              (SELECT COALESCE(SUM(length(f.content)), 0) FROM scriptshub_files f
                WHERE f.user_id = s.user_id AND f.snippet_id = s.id) AS char_count,
              (SELECT substr(replace(replace(f.content, char(13), ' '), char(10), ' '), 1, 200)
                 FROM scriptshub_files f
                WHERE f.user_id = s.user_id AND f.snippet_id = s.id
                ORDER BY f.position, f.created_at LIMIT 1) AS preview
         FROM scriptshub_snippets s
        WHERE s.user_id = ? AND s.id = ?`,
    ).bind(this.user, id).first<SnippetRow>()
    if (!row) throw ApiError.notFound('Snippet not found')
    const summary = snippetRow(row)
    await this.attachListRelations([summary])
    const [{ results: files }, revisionCount, publication] = await Promise.all([
      this.db.prepare(
        `SELECT id, name, language, content, position, updated_at
           FROM scriptshub_files WHERE user_id = ? AND snippet_id = ?
          ORDER BY position, created_at`,
      ).bind(this.user, id).all<FileRow>(),
      this.db.prepare('SELECT COUNT(*) AS n FROM scriptshub_revisions WHERE user_id = ? AND snippet_id = ?')
        .bind(this.user, id).first<{ n: number }>(),
      this.db.prepare(
        `SELECT id, snippet_id, file_id, path, is_enabled, visibility, token_hash, expires_at, short_slug,
                created_at, updated_at, last_served_at
           FROM scriptshub_publications WHERE user_id = ? AND snippet_id = ?
          ORDER BY created_at DESC`,
      ).bind(this.user, id).all<Parameters<typeof publicationRow>[0]>(),
    ])
    return {
      ...summary,
      sourceUrl: row.source_url,
      notes: row.notes,
      files: files.map((file) => ({
        id: file.id,
        name: file.name,
        language: languageFor(file.language).id,
        content: file.content,
        position: file.position,
        updatedAt: file.updated_at,
      })),
      revisionCount: Number(revisionCount?.n ?? 0),
      publications: publication.results.map(publicationRow),
    }
  }

  async createSnippet(input: ScriptSnippetInput): Promise<ScriptSnippetDetail> {
    const title = cleanTitle(input.title)
    const language = input.language ?? 'shell'
    if (input.folderId) await this.assertFolder(input.folderId)
    const tagIds = await this.validTagIds(input.tags ?? [])
    const now = Date.now()
    const id = newId()
    const fileId = newId()
    const fileName = defaultFileNames(language)[0]!
    const description = clip(input.description, DESCRIPTION_MAX)
    const sourceUrl = cleanSourceUrl(input.sourceUrl)
    const notes = clip(input.notes, NOTES_MAX)
    const statements = [
      this.db.prepare(
        `INSERT INTO scriptshub_snippets
          (user_id, id, title, description, folder_id, language, source_url, notes, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(this.user, id, title, description, input.folderId ?? null, language, sourceUrl, notes, now, now),
      this.db.prepare(
        `INSERT INTO scriptshub_files (user_id, id, snippet_id, name, language, content, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', 0, ?, ?)`,
      ).bind(this.user, fileId, id, fileName, language, now, now),
    ]
    for (const tagId of tagIds) {
      statements.push(
        this.db.prepare('INSERT INTO scriptshub_snippet_tags (user_id, snippet_id, tag_id) VALUES (?, ?, ?)')
          .bind(this.user, id, tagId),
      )
    }
    const emptyRevision = JSON.stringify([{ id: fileId, name: fileName, language, content: '', position: 0, updatedAt: now }])
    statements.push(
      this.db.prepare(
        `INSERT INTO scriptshub_revisions
          (user_id, snippet_id, version, title, description, files_json, file_count, char_count, source, created_at)
         VALUES (?, ?, 1, ?, ?, ?, 1, 0, 'create', ?)`,
      ).bind(this.user, id, title, description, emptyRevision, now),
    )
    await this.db.batch(statements)
    return this.getSnippet(id)
  }

  async updateSnippet(id: string, patch: Partial<ScriptSnippetInput> & {
    isFavorite?: boolean
    isPinned?: boolean
    isDeprecated?: boolean
  }): Promise<ScriptSnippetDetail> {
    const existing = await this.snippetState(id)
    if (!existing) throw ApiError.notFound('Snippet not found')
    const sets: string[] = []
    const binds: Array<string | number | null> = []
    if (patch.title !== undefined) {
      sets.push('title = ?')
      binds.push(cleanTitle(patch.title))
    }
    if (patch.description !== undefined) {
      sets.push('description = ?')
      binds.push(clip(patch.description, DESCRIPTION_MAX))
    }
    if (patch.folderId !== undefined) {
      if (patch.folderId) await this.assertFolder(patch.folderId)
      sets.push('folder_id = ?')
      binds.push(patch.folderId)
    }
    if (patch.language !== undefined) {
      sets.push('language = ?')
      binds.push(languageFor(patch.language).id)
    }
    if (patch.sourceUrl !== undefined) {
      sets.push('source_url = ?')
      binds.push(cleanSourceUrl(patch.sourceUrl))
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?')
      binds.push(clip(patch.notes, NOTES_MAX))
    }
    if (patch.isFavorite !== undefined) {
      sets.push('is_favorite = ?')
      binds.push(patch.isFavorite ? 1 : 0)
    }
    if (patch.isPinned !== undefined) {
      sets.push('is_pinned = ?')
      binds.push(patch.isPinned ? 1 : 0)
    }
    if (patch.isDeprecated !== undefined) {
      sets.push('is_deprecated = ?')
      binds.push(patch.isDeprecated ? 1 : 0)
    }
    if (!sets.length && patch.tags === undefined) throw ApiError.badRequest('Nothing to change')
    const statements = []
    if (sets.length) {
      sets.push('updated_at = ?')
      binds.push(Date.now())
      statements.push(
        this.db.prepare(`UPDATE scriptshub_snippets SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`)
          .bind(...binds, this.user, id),
      )
    }
    if (patch.tags !== undefined) {
      const tagIds = await this.validTagIds(patch.tags)
      statements.push(this.db.prepare('DELETE FROM scriptshub_snippet_tags WHERE user_id = ? AND snippet_id = ?').bind(this.user, id))
      for (const tagId of tagIds) {
        statements.push(
          this.db.prepare('INSERT INTO scriptshub_snippet_tags (user_id, snippet_id, tag_id) VALUES (?, ?, ?)')
            .bind(this.user, id, tagId),
        )
      }
    }
    await this.db.batch(statements)
    return this.getSnippet(id)
  }

  /**
   * The one save that writes files and a revision.
   *
   * The revision is a snapshot of the whole snippet rather than a diff: a restore has to be able to
   * put back a file a later save deleted, and the version list must survive a rename.
   */
  async saveSnippet(id: string, input: ScriptSnippetSaveInput, source: ScriptRevisionSource = 'save'): Promise<ScriptSnippetDetail> {
    const existing = await this.snippetState(id)
    if (!existing) throw ApiError.notFound('Snippet not found')
    if (input.folderId) await this.assertFolder(input.folderId)
    const title = cleanTitle(input.title)
    if (!Array.isArray(input.files) || input.files.length === 0) throw ApiError.badRequest('A snippet needs at least one file')
    if (input.files.length > FILE_MAX) throw ApiError.badRequest(`A snippet may hold at most ${FILE_MAX} files`)
    const files = input.files.map((file, index) => {
      const name = clip(file.name, NAME_MAX).trim()
      if (!name) throw ApiError.badRequest('Every file needs a name')
      if (name.includes('/') || name.includes('\\')) throw ApiError.badRequest('A file name cannot contain a path separator')
      const content = typeof file.content === 'string' ? file.content : ''
      if (content.length > FILE_CHARS_MAX) throw ApiError.badRequest(`A file may hold at most ${FILE_CHARS_MAX} characters`)
      const language = languageFor(file.language).id
      const fileId = file.id && isValidId(file.id) ? file.id : newId()
      return { id: fileId, name, language, content, position: index }
    })
    const names = new Set(files.map((file) => file.name.toLowerCase()))
    if (names.size !== files.length) throw ApiError.badRequest('Two files in one snippet cannot share a name')
    if (new Set(files.map((file) => file.id)).size !== files.length) throw ApiError.badRequest('Two files in one snippet cannot share an id')
    if (files.reduce((total, file) => total + file.content.length, 0) > TOTAL_CHARS_MAX) {
      throw ApiError.badRequest('This snippet is too large to save in one piece')
    }
    const tagIds = await this.validTagIds(input.tags)
    const now = Date.now()
    const description = clip(input.description, DESCRIPTION_MAX)
    const language = languageFor(input.language).id
    const sourceUrl = cleanSourceUrl(input.sourceUrl)
    const notes = clip(input.notes, NOTES_MAX)
    const latest = await this.latestRevision(id)
    const metadata = await this.saveState(id)
    const contentSame = latest !== null && revisionMatches(latest, { title, description, files })
    const metadataSame = metadata !== null
      && metadata.title === title
      && metadata.description === description
      && metadata.folder_id === input.folderId
      && metadata.language === language
      && metadata.source_url === sourceUrl
      && metadata.notes === notes
      && sameIds(metadata.tags, tagIds)
    if (contentSame && metadataSame) {
      // Nothing a reader could see has changed, so no version is written and the row is not
      // re-dated. A save that only toggled a tag still writes below, with the same `rev`.
      return this.getSnippet(id)
    }
    const nextVersion = contentSame ? existing.rev : existing.rev + 1
    const diff = contentSame ? { added: 0, removed: 0 } : lineChanges(latest?.files_json ?? '', files)
    const snapshot = JSON.stringify(files.map((file) => ({
      id: file.id,
      name: file.name,
      language: file.language,
      content: file.content,
      position: file.position,
      updatedAt: now,
    })))
    const charCount = files.reduce((total, file) => total + file.content.length, 0)
    const statements = [
      this.db.prepare(
        `UPDATE scriptshub_snippets
            SET title = ?, description = ?, folder_id = ?, language = ?, source_url = ?, notes = ?,
                rev = ?, updated_at = ?
          WHERE user_id = ? AND id = ?`,
      ).bind(
        title,
        description,
        input.folderId,
        language,
        sourceUrl,
        notes,
        nextVersion,
        now,
        this.user,
        id,
      ),
    ]
    if (!contentSame) {
      statements.push(this.db.prepare('DELETE FROM scriptshub_files WHERE user_id = ? AND snippet_id = ?').bind(this.user, id))
      for (const file of files) {
        statements.push(
          this.db.prepare(
            `INSERT INTO scriptshub_files (user_id, id, snippet_id, name, language, content, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(this.user, file.id, id, file.name, file.language, file.content, file.position, now, now),
        )
      }
      // A publication names a file. When the save removes that file, the address has nothing left to
      // serve, so it is removed with it; the removed id can never be resurrected by a later save.
      statements.push(
        this.db.prepare(
          `DELETE FROM scriptshub_publications
            WHERE user_id = ? AND snippet_id = ? AND file_id NOT IN (${files.map(() => '?').join(', ')})`,
        ).bind(this.user, id, ...files.map((file) => file.id)),
      )
    }
    statements.push(this.db.prepare('DELETE FROM scriptshub_snippet_tags WHERE user_id = ? AND snippet_id = ?').bind(this.user, id))
    for (const tagId of tagIds) {
      statements.push(
        this.db.prepare('INSERT INTO scriptshub_snippet_tags (user_id, snippet_id, tag_id) VALUES (?, ?, ?)')
          .bind(this.user, id, tagId),
      )
    }
    if (!contentSame) {
      statements.push(
        this.db.prepare(
          `INSERT INTO scriptshub_revisions
            (user_id, snippet_id, version, title, description, files_json, file_count, char_count, diff_stat, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          this.user,
          id,
          nextVersion,
          title,
          description,
          snapshot,
          files.length,
          charCount,
          JSON.stringify(diff),
          source,
          now,
        ),
      )
    }
    await this.db.batch(statements)
    if (!contentSame) await this.pruneRevisions(id)
    return this.getSnippet(id)
  }

  private async pruneRevisions(snippetId: string): Promise<void> {
    const keep = await this.db.prepare(
      `SELECT version FROM scriptshub_revisions WHERE user_id = ? AND snippet_id = ?
        ORDER BY version DESC LIMIT 1 OFFSET ?`,
    ).bind(this.user, snippetId, MAX_REVISIONS - 1).first<{ version: number }>()
    if (!keep) return
    await this.db.prepare(
      'DELETE FROM scriptshub_revisions WHERE user_id = ? AND snippet_id = ? AND version < ?',
    ).bind(this.user, snippetId, keep.version).run()
  }

  async deleteSnippet(id: string): Promise<void> {
    const existing = await this.snippetState(id)
    if (!existing) throw ApiError.notFound('Snippet not found')
    await this.db.batch([
      this.db.prepare('DELETE FROM scriptshub_snippet_tags WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
      this.db.prepare('DELETE FROM scriptshub_files WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
      this.db.prepare('DELETE FROM scriptshub_revisions WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
      this.db.prepare('DELETE FROM scriptshub_publications WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
      this.db.prepare('DELETE FROM scriptshub_copy_events WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
      this.db.prepare('DELETE FROM scriptshub_assets WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
      this.db.prepare('DELETE FROM scriptshub_snippets WHERE user_id = ? AND id = ?').bind(this.user, id),
    ])
  }

  async batch(input: ScriptBatchInput): Promise<{ affected: number; skipped: number }> {
    const ids = (input.ids ?? []).filter((id) => isValidId(id)).slice(0, MAX_BATCH)
    if (!ids.length) throw ApiError.badRequest('Select at least one snippet')
    const rows = await this.db.prepare(
      `SELECT id FROM scriptshub_snippets WHERE user_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    ).bind(this.user, ...ids).all<{ id: string }>()
    const found = new Set(rows.results.map((row) => row.id))
    if (!found.size) throw ApiError.notFound('No selected snippet was found')
    if (input.action === 'tag') {
      const tagIds = await this.validTagIds(input.tagIds ?? [])
      const statements = []
      for (const id of found) {
        for (const tagId of tagIds) {
          statements.push(
            this.db.prepare('INSERT OR IGNORE INTO scriptshub_snippet_tags (user_id, snippet_id, tag_id) VALUES (?, ?, ?)')
              .bind(this.user, id, tagId),
          )
        }
        statements.push(this.db.prepare('UPDATE scriptshub_snippets SET updated_at = ? WHERE user_id = ? AND id = ?')
          .bind(Date.now(), this.user, id))
      }
      await this.db.batch(statements)
    } else if (input.action === 'move') {
      if (input.folderId) await this.assertFolder(input.folderId)
      await this.db.prepare(
        `UPDATE scriptshub_snippets SET folder_id = ?, updated_at = ?
          WHERE user_id = ? AND id IN (${[...found].map(() => '?').join(', ')})`,
      ).bind(input.folderId ?? null, Date.now(), this.user, ...found).run()
    } else {
      // One batch for every selected snippet: D1 runs it as a transaction, so a failure halfway does
      // not leave the account with half of the selection deleted.
      const statements: D1PreparedStatement[] = []
      for (const id of found) {
        statements.push(
          this.db.prepare('DELETE FROM scriptshub_snippet_tags WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
          this.db.prepare('DELETE FROM scriptshub_files WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
          this.db.prepare('DELETE FROM scriptshub_revisions WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
          this.db.prepare('DELETE FROM scriptshub_publications WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
          this.db.prepare('DELETE FROM scriptshub_copy_events WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
          this.db.prepare('DELETE FROM scriptshub_assets WHERE user_id = ? AND snippet_id = ?').bind(this.user, id),
          this.db.prepare('DELETE FROM scriptshub_snippets WHERE user_id = ? AND id = ?').bind(this.user, id),
        )
      }
      await this.db.batch(statements)
    }
    return { affected: found.size, skipped: ids.length - found.size }
  }

  private async snippetState(id: string): Promise<{ rev: number } | null> {
    return this.db.prepare('SELECT rev FROM scriptshub_snippets WHERE user_id = ? AND id = ?')
      .bind(this.user, id).first<{ rev: number }>()
  }

  /** The newest snapshot, used to decide whether a save would add anything to the history. */
  private async latestRevision(snippetId: string): Promise<{ title: string; description: string; files_json: string } | null> {
    return this.db.prepare(
      `SELECT title, description, files_json FROM scriptshub_revisions
        WHERE user_id = ? AND snippet_id = ? ORDER BY version DESC LIMIT 1`,
    ).bind(this.user, snippetId).first<{ title: string; description: string; files_json: string }>()
  }

  /** The snippet's own metadata and tags, for the same "did anything change" question. */
  private async saveState(snippetId: string): Promise<{
    title: string
    description: string
    folder_id: string | null
    language: string
    source_url: string
    notes: string
    tags: string[]
  } | null> {
    const row = await this.db.prepare(
      `SELECT title, description, folder_id, language, source_url, notes
         FROM scriptshub_snippets WHERE user_id = ? AND id = ?`,
    ).bind(this.user, snippetId).first<{
      title: string
      description: string
      folder_id: string | null
      language: string
      source_url: string
      notes: string
    }>()
    if (!row) return null
    const { results } = await this.db.prepare(
      'SELECT tag_id FROM scriptshub_snippet_tags WHERE user_id = ? AND snippet_id = ?',
    ).bind(this.user, snippetId).all<{ tag_id: string }>()
    return { ...row, tags: results.map((entry) => entry.tag_id) }
  }

  private async validTagIds(ids: readonly string[]): Promise<string[]> {
    const unique = [...new Set(ids.filter((id) => isValidId(id)))]
    if (!unique.length) return []
    const { results } = await this.db.prepare(
      `SELECT id FROM scriptshub_tags WHERE user_id = ? AND id IN (${unique.map(() => '?').join(', ')})`,
    ).bind(this.user, ...unique).all<{ id: string }>()
    if (results.length !== unique.length) throw ApiError.badRequest('One or more tags do not exist')
    return unique
  }

  // -------------------------------------------------------------- revisions

  async listRevisions(snippetId: string): Promise<ScriptRevisionMeta[]> {
    const { results } = await this.db.prepare(
      `SELECT version, title, description, source, file_count, char_count, diff_stat, created_at
         FROM scriptshub_revisions WHERE user_id = ? AND snippet_id = ?
        ORDER BY version DESC`,
    ).bind(this.user, snippetId).all<{
      version: number
      title: string
      description: string
      source: string
      file_count: number
      char_count: number
      diff_stat: string
      created_at: number
    }>()
    return results.map((row) => ({
      version: row.version,
      title: row.title,
      description: row.description,
      source: revisionSource(row.source),
      fileCount: row.file_count,
      charCount: row.char_count,
      ...revisionDiff(row.diff_stat),
      createdAt: row.created_at,
    }))
  }

  async readRevision(snippetId: string, version: number): Promise<ScriptRevisionSnapshot> {
    const row = await this.db.prepare(
      `SELECT version, title, description, source, files_json, file_count, char_count, diff_stat, created_at
         FROM scriptshub_revisions WHERE user_id = ? AND snippet_id = ? AND version = ?`,
    ).bind(this.user, snippetId, version).first<{
      version: number
      title: string
      description: string
      source: string
      files_json: string
      file_count: number
      char_count: number
      diff_stat: string
      created_at: number
    }>()
    if (!row) throw ApiError.notFound('Revision not found')
    return {
      version: row.version,
      title: row.title,
      description: row.description,
      source: revisionSource(row.source),
      fileCount: row.file_count,
      charCount: row.char_count,
      ...revisionDiff(row.diff_stat),
      createdAt: row.created_at,
      files: parseFilesJson(row.files_json),
    }
  }

  /** Put a snapshot back, as a new version: the way forward stays in the history. */
  async restoreRevision(snippetId: string, version: number): Promise<ScriptSnippetDetail> {
    const snapshot = await this.readRevision(snippetId, version)
    const detail = await this.getSnippet(snippetId)
    await this.saveSnippet(snippetId, {
      title: snapshot.title,
      description: snapshot.description,
      folderId: detail.folderId,
      language: snapshot.files[0]?.language ?? detail.language,
      sourceUrl: detail.sourceUrl,
      notes: detail.notes,
      tags: detail.tags.map((tag) => tag.id),
      files: snapshot.files.map((file) => ({
        id: file.id,
        name: file.name,
        language: file.language,
        content: file.content,
      })),
    }, 'restore')
    return this.getSnippet(snippetId)
  }

  // ------------------------------------------------------------- publications

  async listPublications(): Promise<ScriptPublication[]> {
    const { results } = await this.db.prepare(
      `SELECT p.id, p.snippet_id, p.file_id, p.path, p.is_enabled, p.visibility, p.token_hash, p.expires_at,
              p.short_slug, p.created_at, p.updated_at, p.last_served_at,
              s.title AS snippet_title,
              f.name AS file_name,
              (SELECT COUNT(*) FROM scriptshub_events e WHERE e.user_id = p.user_id AND e.publication_id = p.id AND e.kind = 'download') AS downloads,
              (SELECT COUNT(DISTINCT e.visitor_fp) FROM scriptshub_events e WHERE e.user_id = p.user_id AND e.publication_id = p.id AND e.kind = 'download' AND e.visitor_fp IS NOT NULL) AS visitors
         FROM scriptshub_publications p
         JOIN scriptshub_snippets s ON s.user_id = p.user_id AND s.id = p.snippet_id
         LEFT JOIN scriptshub_files f ON f.user_id = p.user_id AND f.id = p.file_id
        WHERE p.user_id = ?
        ORDER BY p.created_at DESC`,
    ).bind(this.user).all<Parameters<typeof publicationRow>[0] & {
      snippet_title: string
      file_name: string | null
      downloads: number
      visitors: number
    }>()
    return results.map((row) => ({
      ...publicationRow(row),
      snippetId: row.snippet_id,
      snippetTitle: row.snippet_title,
      fileName: row.file_name ?? '',
      fileCount: 1,
      downloadCount: Number(row.downloads ?? 0),
      uniqueVisitors: Number(row.visitors ?? 0),
    }))
  }

  async createPublication(snippetId: string, input: ScriptPublicationInput): Promise<ScriptPublicationCreated> {
    const snippet = await this.getSnippet(snippetId)
    if (!snippet.files.some((file) => file.id === input.fileId)) throw ApiError.badRequest('The file to publish does not exist')
    const pathProblem = publicationPathProblem(input.path)
    if (pathProblem) throw ApiError.badRequest(pathProblem)
    const already = await this.db.prepare(
      'SELECT id FROM scriptshub_publications WHERE user_id = ? AND snippet_id = ? AND file_id = ?',
    ).bind(this.user, snippetId, input.fileId).first<{ id: string }>()
    if (already) throw ApiError.conflict('This file already has a distribution; edit it instead')
    const visibility = normalizeVisibility(input.visibility)
    const taken = await this.db.prepare(
      'SELECT 1 AS present FROM scriptshub_publications WHERE lower(path) = lower(?) LIMIT 1',
    ).bind(input.path).first<{ present: number }>()
    if (taken) throw ApiError.conflict('That distribution path is already in use')
    const expires = validExpiresAt(input.expiresAt)
    const now = Date.now()
    const id = newId()
    const token = visibility === 'token' ? newSlug() : null
    const tokenHash = token ? await sha256Hex(token) : null
    await this.db.prepare(
      `INSERT INTO scriptshub_publications
        (user_id, id, snippet_id, file_id, path, is_enabled, visibility, token_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(this.user, id, snippetId, input.fileId, input.path, visibility, tokenHash, expires, now, now).run()
    const publication = (await this.listPublications()).find((entry) => entry.id === id)
    if (!publication) throw ApiError.notFound('Publication not found')
    return { ...publication, ...(token ? { token } : {}) }
  }

  async updatePublication(id: string, patch: ScriptPublicationPatch): Promise<ScriptPublication> {
    const existing = await this.db.prepare(
      'SELECT id, visibility FROM scriptshub_publications WHERE user_id = ? AND id = ?',
    ).bind(this.user, id).first<{ id: string; visibility: string }>()
    if (!existing) throw ApiError.notFound('Publication not found')
    const sets: string[] = []
    const binds: Array<string | number | null> = []
    if (patch.path !== undefined) {
      const problem = publicationPathProblem(patch.path)
      if (problem) throw ApiError.badRequest(problem)
      const taken = await this.db.prepare(
        'SELECT 1 AS present FROM scriptshub_publications WHERE lower(path) = lower(?) AND id <> ? LIMIT 1',
      ).bind(patch.path, id).first<{ present: number }>()
      if (taken) throw ApiError.conflict('That distribution path is already in use')
      sets.push('path = ?')
      binds.push(patch.path)
    }
    if (patch.visibility !== undefined) {
      sets.push('visibility = ?')
      binds.push(normalizeVisibility(patch.visibility))
      if (patch.visibility === 'public') {
        sets.push('token_hash = NULL')
      }
    }
    if (patch.expiresAt !== undefined) {
      sets.push('expires_at = ?')
      binds.push(validExpiresAt(patch.expiresAt))
    }
    if (patch.isEnabled !== undefined) {
      sets.push('is_enabled = ?')
      binds.push(patch.isEnabled ? 1 : 0)
    }
    if (!sets.length) throw ApiError.badRequest('Nothing to change')
    sets.push('updated_at = ?')
    binds.push(Date.now())
    await this.db.prepare(
      `UPDATE scriptshub_publications SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`,
    ).bind(...binds, this.user, id).run()
    const publication = (await this.listPublications()).find((entry) => entry.id === id)
    if (!publication) throw ApiError.notFound('Publication not found')
    return publication
  }

  /** Mint a new gate token and return the plaintext once; the row keeps only its hash. */
  async rotatePublicationToken(id: string): Promise<{ publication: ScriptPublication; token: string }> {
    const existing = await this.db.prepare(
      'SELECT id FROM scriptshub_publications WHERE user_id = ? AND id = ?',
    ).bind(this.user, id).first<{ id: string }>()
    if (!existing) throw ApiError.notFound('Publication not found')
    const token = newSlug()
    const tokenHash = await sha256Hex(token)
    await this.db.prepare(
      `UPDATE scriptshub_publications SET visibility = 'token', token_hash = ?, updated_at = ?
        WHERE user_id = ? AND id = ?`,
    ).bind(tokenHash, Date.now(), this.user, id).run()
    const publication = (await this.listPublications()).find((entry) => entry.id === id)
    if (!publication) throw ApiError.notFound('Publication not found')
    return { publication, token }
  }

  async deletePublication(id: string): Promise<void> {
    const existing = await this.db.prepare(
      'SELECT id FROM scriptshub_publications WHERE user_id = ? AND id = ?',
    ).bind(this.user, id).first<{ id: string }>()
    if (!existing) throw ApiError.notFound('Publication not found')
    await this.db.prepare('DELETE FROM scriptshub_publications WHERE user_id = ? AND id = ?').bind(this.user, id).run()
  }

  /** Attach a short link's slug once, so a publication has one stable short address. */
  async setShortSlug(publicationId: string, slug: string): Promise<void> {
    await this.db.prepare(
      'UPDATE scriptshub_publications SET short_slug = ? WHERE user_id = ? AND id = ?',
    ).bind(slug, this.user, publicationId).run()
  }

  // --------------------------------------------------------------- analytics

  async recordCopy(snippetId: string, fileId: string | null, surface: string): Promise<void> {
    const now = Date.now()
    await this.db.batch([
      this.db.prepare(
        'UPDATE scriptshub_snippets SET copy_count = copy_count + 1, last_used_at = ? WHERE user_id = ? AND id = ?',
      ).bind(now, this.user, snippetId),
      this.db.prepare(
        'INSERT INTO scriptshub_copy_events (user_id, id, snippet_id, file_id, surface, at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(this.user, newId(), snippetId, fileId, surface.slice(0, 16), now),
    ])
  }

  async stats(range: ScriptStatsRange): Promise<ScriptStatsResponse> {
    const normalized = parseScriptStatsRange(range)
    const now = Date.now()
    const since = scriptStatsSince(normalized, now)
    const sinceSeconds = Math.floor(since / 1000)
    const [overview, distribution, snippets] = await Promise.all([
      this.statsOverview(now),
      this.statsDistribution(sinceSeconds, now),
      this.statsSnippets(sinceSeconds),
    ])
    return { range: normalized, since, generatedAt: now, overview, distribution, snippets }
  }

  private async statsOverview(now: number): Promise<ScriptStatsResponse['overview']> {
    const [snippetCount, fileCount, languageRows, folderRows, tagRows, addedRows] = await Promise.all([
      this.db.prepare('SELECT COUNT(*) AS n FROM scriptshub_snippets WHERE user_id = ?').bind(this.user).first<{ n: number }>(),
      this.db.prepare('SELECT COUNT(*) AS n FROM scriptshub_files WHERE user_id = ?').bind(this.user).first<{ n: number }>(),
      this.db.prepare(
        `SELECT language AS label, COUNT(*) AS value FROM scriptshub_snippets
          WHERE user_id = ? GROUP BY language ORDER BY value DESC LIMIT 20`,
      ).bind(this.user).all<{ label: string; value: number }>(),
      this.db.prepare(
        `SELECT COALESCE(f.name, ?) AS label, COUNT(*) AS value
           FROM scriptshub_snippets s
           LEFT JOIN scriptshub_folders f ON f.user_id = s.user_id AND f.id = s.folder_id
          WHERE s.user_id = ? GROUP BY s.folder_id ORDER BY value DESC LIMIT 20`,
      ).bind('', this.user).all<{ label: string; value: number }>(),
      this.db.prepare(
        `SELECT t.name AS label, t.color AS color, COUNT(*) AS value
           FROM scriptshub_snippet_tags st
           JOIN scriptshub_tags t ON t.user_id = st.user_id AND t.id = st.tag_id
          WHERE st.user_id = ? GROUP BY t.id ORDER BY value DESC LIMIT 20`,
      ).bind(this.user).all<{ label: string; color: string | null; value: number }>(),
      this.db.prepare(
        `SELECT
           SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS d7,
           SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS d30,
           SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS d365
         FROM scriptshub_snippets WHERE user_id = ?`,
      ).bind(now - 7 * DAY_MS, now - 30 * DAY_MS, now - 365 * DAY_MS, this.user).first<{ d7: number; d30: number; d365: number }>(),
    ])
    const published = await this.db.prepare(
      'SELECT COUNT(DISTINCT snippet_id) AS n FROM scriptshub_publications WHERE user_id = ?',
    ).bind(this.user).first<{ n: number }>()
    const snippets = Number(snippetCount?.n ?? 0)
    const publishedCount = Number(published?.n ?? 0)
    return {
      snippets,
      files: Number(fileCount?.n ?? 0),
      languages: languageRows.results.map((row) => ({ label: row.label, value: Number(row.value) })),
      folders: folderRows.results.map((row) => ({ label: row.label, value: Number(row.value) })),
      tags: tagRows.results.map((row) => ({ label: row.label, value: Number(row.value), color: row.color })),
      published: publishedCount,
      publishedShare: publishedShare(publishedCount, snippets),
      added: {
        '7d': Number(addedRows?.d7 ?? 0),
        '30d': Number(addedRows?.d30 ?? 0),
        '365d': Number(addedRows?.d365 ?? 0),
      },
    }
  }

  private async statsDistribution(since: number, now: number): Promise<ScriptStatsResponse['distribution']> {
    const [totals, daily, top, referrers, browsers, devices, failures] = await Promise.all([
      this.db.prepare(
        `SELECT
           SUM(CASE WHEN kind = 'download' THEN 1 ELSE 0 END) AS downloads,
           COUNT(DISTINCT CASE WHEN kind = 'download' THEN visitor_fp END) AS visitors
         FROM scriptshub_events
        WHERE user_id = ? AND at >= ? AND at <= ?`,
      ).bind(this.user, since, Math.floor(now / 1000)).first<{ downloads: number; visitors: number }>(),
      this.db.prepare(
        `SELECT date(at, 'unixepoch') AS day,
                SUM(CASE WHEN kind = 'download' THEN 1 ELSE 0 END) AS downloads,
                COUNT(DISTINCT CASE WHEN kind = 'download' THEN visitor_fp END) AS visitors,
                SUM(CASE WHEN kind <> 'download' AND status IN (403, 404) THEN 1 ELSE 0 END) AS failures
           FROM scriptshub_events
          WHERE user_id = ? AND at >= ? AND at <= ?
          GROUP BY day ORDER BY day`,
      ).bind(this.user, since, Math.floor(now / 1000)).all<{ day: string; downloads: number; visitors: number; failures: number }>(),
      this.db.prepare(
        `SELECT p.snippet_id AS id, s.title AS title, p.path AS path,
                p.file_id AS file_id, f.name AS file_name,
                COUNT(*) AS downloads,
                COUNT(DISTINCT e.visitor_fp) AS visitors
           FROM scriptshub_events e
           JOIN scriptshub_publications p ON p.user_id = e.user_id AND p.id = e.publication_id
           JOIN scriptshub_snippets s ON s.user_id = p.user_id AND s.id = p.snippet_id
           LEFT JOIN scriptshub_files f ON f.user_id = p.user_id AND f.id = p.file_id
          WHERE e.user_id = ? AND e.kind = 'download' AND e.at >= ? AND e.at <= ?
          GROUP BY p.id
          ORDER BY downloads DESC LIMIT 10`,
      ).bind(this.user, since, Math.floor(now / 1000)).all<{ id: string; title: string; path: string | null; file_id: string | null; file_name: string | null; downloads: number; visitors: number }>(),
      this.db.prepare(
        `SELECT COALESCE(NULLIF(referrer_host, ''), 'direct') AS label, COUNT(*) AS value
           FROM scriptshub_events WHERE user_id = ? AND kind = 'download' AND at >= ? AND at <= ?
          GROUP BY label ORDER BY value DESC LIMIT 10`,
      ).bind(this.user, since, Math.floor(now / 1000)).all<{ label: string; value: number }>(),
      this.db.prepare(
        `SELECT COALESCE(NULLIF(ua_family, ''), 'unknown') AS label, COUNT(*) AS value
           FROM scriptshub_events WHERE user_id = ? AND kind = 'download' AND at >= ? AND at <= ?
          GROUP BY label ORDER BY value DESC LIMIT 10`,
      ).bind(this.user, since, Math.floor(now / 1000)).all<{ label: string; value: number }>(),
      this.db.prepare(
        `SELECT COALESCE(NULLIF(device_type, ''), 'unknown') AS label, COUNT(*) AS value
           FROM scriptshub_events WHERE user_id = ? AND kind = 'download' AND at >= ? AND at <= ?
          GROUP BY label ORDER BY value DESC LIMIT 10`,
      ).bind(this.user, since, Math.floor(now / 1000)).all<{ label: string; value: number }>(),
      this.db.prepare(
        `SELECT COALESCE(NULLIF(path, ''), '(unknown)') AS label, COUNT(*) AS value
           FROM scriptshub_events WHERE user_id = ? AND kind <> 'download' AND status IN (403, 404) AND at >= ? AND at <= ?
          GROUP BY path ORDER BY value DESC LIMIT 10`,
      ).bind(this.user, since, Math.floor(now / 1000)).all<{ label: string; value: number }>(),
    ])
    return {
      downloads: Number(totals?.downloads ?? 0),
      uniqueVisitors: Number(totals?.visitors ?? 0),
      daily: daily.results.map((row) => ({
        day: row.day,
        downloads: Number(row.downloads),
        visitors: Number(row.visitors),
        failures: Number(row.failures),
      })),
      topScripts: top.results.map((row) => ({
        id: row.id,
        title: row.title,
        path: row.path,
        fileId: row.file_id,
        fileName: row.file_name ?? '',
        downloads: Number(row.downloads),
        uniqueVisitors: Number(row.visitors),
      })),
      referrers: countRows(referrers.results),
      browsers: countRows(browsers.results),
      devices: countRows(devices.results),
      failures: countRows(failures.results),
    }
  }

  private async statsSnippets(since: number): Promise<ScriptStatsResponse['snippets']> {
    const [copies, recent, revisions] = await Promise.all([
      this.db.prepare(
        `SELECT s.id AS id, s.title AS title, COUNT(*) AS copies
           FROM scriptshub_copy_events c
           JOIN scriptshub_snippets s ON s.user_id = c.user_id AND s.id = c.snippet_id
          WHERE c.user_id = ? AND c.at >= ?
          GROUP BY s.id ORDER BY copies DESC LIMIT 10`,
      ).bind(this.user, since).all<{ id: string; title: string; copies: number }>(),
      this.db.prepare(
        `SELECT s.id AS id, s.title AS title, s.updated_at AS updated_at,
                (SELECT COUNT(*) FROM scriptshub_revisions r WHERE r.user_id = s.user_id AND r.snippet_id = s.id) AS revision_count
           FROM scriptshub_snippets s
          WHERE s.user_id = ? ORDER BY s.updated_at DESC LIMIT 6`,
      ).bind(this.user).all<{ id: string; title: string; updated_at: number; revision_count: number }>(),
      this.db.prepare('SELECT COUNT(*) AS n FROM scriptshub_revisions WHERE user_id = ?')
        .bind(this.user).first<{ n: number }>(),
    ])
    return {
      hotCopies: copies.results.map((row) => ({ id: row.id, title: row.title, copies: Number(row.copies) })),
      recentEdits: recent.results.map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
        revisionCount: Number(row.revision_count),
      })),
      revisions: Number(revisions?.n ?? 0),
    }
  }

  // ----------------------------------------------------------------- assets

  async listAssets(snippetId: string): Promise<Array<Omit<ScriptAssetRow, 'r2_key'>>> {
    const { results } = await this.db.prepare(
      `SELECT id, snippet_id, file_name, content_type, byte_size, created_at
         FROM scriptshub_assets WHERE user_id = ? AND snippet_id = ?
        ORDER BY created_at DESC`,
    ).bind(this.user, snippetId).all<Omit<ScriptAssetRow, 'r2_key'>>()
    return results
  }

  async assetRow(id: string): Promise<ScriptAssetRow | null> {
    return this.db.prepare(
      `SELECT id, snippet_id, file_name, content_type, byte_size, r2_key, created_at
         FROM scriptshub_assets WHERE user_id = ? AND id = ?`,
    ).bind(this.user, id).first<ScriptAssetRow>()
  }

  async createAsset(input: {
    snippetId: string
    id: string
    fileName: string
    contentType: string
    byteSize: number
    r2Key: string
  }): Promise<void> {
    await this.db.prepare(
      `INSERT INTO scriptshub_assets (user_id, id, snippet_id, file_name, content_type, byte_size, r2_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(this.user, input.id, input.snippetId, input.fileName, input.contentType, input.byteSize, input.r2Key, Date.now()).run()
  }

  async deleteAsset(id: string): Promise<ScriptAssetRow | null> {
    const row = await this.assetRow(id)
    if (!row) return null
    await this.db.prepare('DELETE FROM scriptshub_assets WHERE user_id = ? AND id = ?').bind(this.user, id).run()
    return row
  }

  async assetKeysForSnippet(snippetId: string): Promise<string[]> {
    const { results } = await this.db.prepare(
      'SELECT r2_key FROM scriptshub_assets WHERE user_id = ? AND snippet_id = ?',
    ).bind(this.user, snippetId).all<{ r2_key: string }>()
    return results.map((row) => row.r2_key)
  }

  // ------------------------------------------------------------------ import

  async importEntries(
    entries: readonly ScriptImportEntry[],
    conflict: ScriptImportConflict,
    folderId: string | null,
  ): Promise<ScriptImportResult> {
    const result: ScriptImportResult = { created: 0, overwritten: 0, skipped: 0, renamed: 0, tags: 0 }
    if (entries.length > 500) throw ApiError.badRequest('An import may hold at most 500 snippets')
    if (folderId) await this.assertFolder(folderId)
    const existingTags = await this.listTags()
    const tagsBefore = new Set(existingTags.map((tag) => tag.name.toLowerCase()))
    // One read of the account's tags serves the whole import; asking per entry made a 500-snippet
    // file 500 queries against the same table.
    const knownTags = new Map(
      existingTags.filter((tag) => !tag.parentId).map((tag) => [tag.name.toLowerCase(), tag]),
    )
    for (const entry of entries) {
      const title = entry.title.trim().slice(0, TITLE_MAX)
      if (!title || !entry.files.length) {
        result.skipped += 1
        continue
      }
      const language = entry.files[0]!.language
      const existing = await this.db.prepare(
        `SELECT id FROM scriptshub_snippets
          WHERE user_id = ? AND lower(title) = lower(?) AND language = ? LIMIT 1`,
      ).bind(this.user, title, language).first<{ id: string }>()
      const decision = importTitleDecision(title, conflict, Boolean(existing))
      if (decision.action === 'skip') {
        result.skipped += 1
        continue
      }
      const tagIds = await this.ensureTags(entry.tags, tagsBefore, knownTags, result)
      if (decision.action === 'overwrite') {
        await this.saveSnippet(existing!.id, {
          title,
          description: entry.description,
          folderId,
          language,
          sourceUrl: '',
          notes: '',
          tags: tagIds,
          files: entry.files.map((file) => ({ name: file.name, language: file.language, content: file.content })),
        }, 'overwrite')
        result.overwritten += 1
        continue
      }
      let finalTitle = title
      if (decision.action === 'rename') {
        finalTitle = await this.nextAvailableTitle(title, language)
        result.renamed += 1
      }
      await this.createSnippet({
        title: finalTitle,
        description: entry.description,
        folderId,
        language,
        tags: tagIds,
      })
      const created = await this.latestSnippetByTitle(finalTitle)
      if (created) {
        await this.saveSnippet(created, {
          title: finalTitle,
          description: entry.description,
          folderId,
          language,
          sourceUrl: '',
          notes: '',
          tags: tagIds,
          files: entry.files.map((file) => ({ name: file.name, language: file.language, content: file.content })),
        }, 'import')
      }
      result.created += 1
    }
    return result
  }

  private async ensureTags(
    names: readonly string[],
    known: Set<string>,
    existing: Map<string, ScriptTag>,
    result: ScriptImportResult,
  ): Promise<string[]> {
    const ids: string[] = []
    for (const raw of names) {
      const name = cleanTagName(raw)
      const key = name.toLowerCase()
      let tag = existing.get(key)
      if (!tag) {
        tag = await this.createTag({ name })
        existing.set(key, tag)
      }
      if (!known.has(key)) {
        known.add(key)
        result.tags += 1
      }
      ids.push(tag.id)
    }
    return ids
  }

  private async nextAvailableTitle(title: string, language: string): Promise<string> {
    for (let index = 2; index < 100; index++) {
      const candidate = `${title} (${index})`
      const row = await this.db.prepare(
        'SELECT 1 AS present FROM scriptshub_snippets WHERE user_id = ? AND lower(title) = lower(?) AND language = ? LIMIT 1',
      ).bind(this.user, candidate, language).first<{ present: number }>()
      if (!row) return candidate
    }
    return `${title} (${Date.now()})`
  }

  private async latestSnippetByTitle(title: string): Promise<string | null> {
    const row = await this.db.prepare(
      `SELECT id FROM scriptshub_snippets WHERE user_id = ? AND title = ?
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(this.user, title).first<{ id: string }>()
    return row?.id ?? null
  }

  // ---------------------------------------------------------------- export

  async exportEntries(): Promise<Array<{
    title: string
    description: string
    tags: string[]
    folder: string | null
    files: Array<{ name: string; language: ScriptLanguageId; content: string }>
  }>> {
    const { results } = await this.db.prepare(
      `SELECT id, title, description, folder_id, language FROM scriptshub_snippets
        WHERE user_id = ? ORDER BY created_at`,
    ).bind(this.user).all<{ id: string; title: string; description: string; folder_id: string | null; language: string }>()
    const folders = await this.listFolders()
    const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]))
    const out = []
    for (const row of results) {
      const detail = await this.getSnippet(row.id)
      out.push({
        title: row.title,
        description: row.description,
        tags: detail.tags.map((tag) => tag.name),
        folder: row.folder_id ? folderNames.get(row.folder_id) ?? null : null,
        files: detail.files.map((file) => ({ name: file.name, language: file.language, content: file.content })),
      })
    }
    return out
  }

  /** The publication route's own token check, isolated so the public route cannot borrow a session. */
  static async tokenMatches(token: string, hash: string | null): Promise<boolean> {
    if (!hash) return false
    return timingSafeEqual(await sha256Hex(token), hash)
  }
}

function normalizeVisibility(value: unknown): ScriptPublicationVisibility {
  return value === 'token' ? 'token' : 'public'
}

function validExpiresAt(value: unknown): number | null {
  if (value === undefined || value === null || value === 0) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw ApiError.badRequest('An expiry must be a timestamp')
  if (value < Date.now()) throw ApiError.badRequest('An expiry cannot be in the past')
  return Math.trunc(value)
}

/**
 * Whether a save would write the snapshot already at the head of the history.
 *
 * Only the fields a version owns are compared: title, description and the files themselves. Folder,
 * tags, source and notes live on the snippet and never made a version, so changing them alone must
 * not add an empty one.
 */
function revisionMatches(
  latest: { title: string; description: string; files_json: string },
  next: {
    title: string
    description: string
    files: ReadonlyArray<{ id: string; name: string; language: string; content: string; position: number }>
  },
): boolean {
  if (latest.title !== next.title || latest.description !== next.description) return false
  let stored: unknown
  try {
    stored = JSON.parse(latest.files_json)
  } catch {
    return false
  }
  if (!Array.isArray(stored) || stored.length !== next.files.length) return false
  return next.files.every((file, index) => {
    const entry = stored[index] as Record<string, unknown> | null
    return Boolean(entry)
      && entry!.id === file.id
      && entry!.name === file.name
      && entry!.language === file.language
      && entry!.content === file.content
      && Number(entry!.position) === file.position
  })
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((id) => set.has(id))
}

/**
 * The +x/−y a version is worth, counted per file identity rather than per name: renaming a file
 * changes no line, and a file deleted by this save removes every line it held.
 */
function lineChanges(
  previousJson: string,
  files: ReadonlyArray<{ id: string; content: string }>,
): { added: number; removed: number } {
  let before: unknown
  try {
    before = JSON.parse(previousJson || '[]')
  } catch {
    before = []
  }
  const previous = new Map<string, string>()
  if (Array.isArray(before)) {
    for (const entry of before) {
      const file = entry as Record<string, unknown>
      if (typeof file.id === 'string' && typeof file.content === 'string') previous.set(file.id, file.content)
    }
  }
  let added = 0
  let removed = 0
  for (const file of files) {
    const old = previous.get(file.id)
    if (old === undefined) {
      added += countedLines(file.content)
      continue
    }
    previous.delete(file.id)
    for (const change of diffLines(old, file.content)) {
      if (change.added) added += countedLines(change.value)
      else if (change.removed) removed += countedLines(change.value)
    }
  }
  for (const content of previous.values()) removed += countedLines(content)
  return { added, removed }
}

function countedLines(value: string): number {
  if (!value) return 0
  return value.replace(/\n$/, '').split('\n').length
}

function revisionDiff(stat: string): { added: number; removed: number } {
  try {
    const parsed = JSON.parse(stat) as { added?: unknown; removed?: unknown }
    return {
      added: Number.isFinite(Number(parsed.added)) ? Math.max(0, Number(parsed.added)) : 0,
      removed: Number.isFinite(Number(parsed.removed)) ? Math.max(0, Number(parsed.removed)) : 0,
    }
  } catch {
    return { added: 0, removed: 0 }
  }
}

function revisionSource(value: string): ScriptRevisionSource {
  return value === 'create' || value === 'restore' || value === 'import' || value === 'overwrite'
    ? value
    : 'save'
}

function parseFilesJson(json: string): ScriptRevisionSnapshot['files'] {
  try {
    const value = JSON.parse(json) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((item, index) => {
      if (!item || typeof item !== 'object') return []
      const file = item as Record<string, unknown>
      if (typeof file.name !== 'string' || typeof file.content !== 'string') return []
      return [{
        id: typeof file.id === 'string' ? file.id : newId(),
        name: file.name,
        language: languageFor(typeof file.language === 'string' ? file.language : 'text').id,
        content: file.content,
        position: typeof file.position === 'number' ? file.position : index,
        updatedAt: typeof file.updatedAt === 'number' ? file.updatedAt : Date.now(),
      }]
    })
  } catch {
    return []
  }
}

function countRows(rows: Array<{ label: string; value: number }>): Array<{ label: string; value: number }> {
  return rows.map((row) => ({ label: row.label, value: Number(row.value) }))
}
