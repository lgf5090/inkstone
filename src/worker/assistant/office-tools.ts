/**
 * Office tools for the assistant.
 *
 * Reads and metadata writes run against D1. Content edits are returned as an `OfficeEditPlan` inside a
 * tool-effect envelope: the Univer model lives in the reader's tab, not in this Worker, and the office
 * bridge applies the plan through the Facade. Every query is scoped to the account in `ToolContext`.
 */
import {
  OFFICE_FILE_TYPES,
  OFFICE_LIMITS,
  normalizeOfficeTitle,
  officeSnapshotKey,
  type OfficeFileType,
} from '@shared/office/constants'
import type { OfficeFileSummary } from '@shared/office/model'
import { extractOfficeText, validateOfficeEditPlan } from '@shared/office/ai'
import { newId } from '../lib/id'
import { tool, ToolError } from './tool-kit'
import type { ToolContext, ToolDefinition } from './tools'

interface OfficeRow {
  id: string
  type: OfficeFileType
  title: string
  folder_id: string | null
  snapshot_key: string
  rev: number
  size: number
  is_pinned: number
  is_starred: number
  last_opened_at: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

const FILE_COLUMNS = `id, type, title, folder_id, snapshot_key, rev, size, is_pinned, is_starred, last_opened_at, created_at, updated_at, deleted_at`

function summaryOf(row: OfficeRow): OfficeFileSummary {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    folderId: row.folder_id,
    rev: row.rev,
    size: row.size,
    isPinned: Boolean(row.is_pinned),
    isStarred: Boolean(row.is_starred),
    position: 0,
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

async function rowFor(ctx: ToolContext, id: string, includeDeleted = false): Promise<OfficeRow> {
  const row = await ctx.env.DB.prepare(
    `SELECT ${FILE_COLUMNS} FROM office_file WHERE user_id = ?1 AND id = ?2${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
  ).bind(ctx.store.userId, id).first<OfficeRow>()
  if (!row) throw new ToolError('No office file matches that id.')
  return row
}

async function folderExists(ctx: ToolContext, folderId: string): Promise<boolean> {
  const row = await ctx.env.DB.prepare(
    `SELECT 1 AS present FROM office_folder WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  ).bind(ctx.store.userId, folderId).first<{ present: number }>()
  return Boolean(row?.present)
}

async function ownedTagIds(ctx: ToolContext, tagIds: readonly string[]): Promise<string[]> {
  if (!tagIds.length) return []
  const placeholders = tagIds.map((_, index) => `?${index + 2}`).join(', ')
  const { results } = await ctx.env.DB.prepare(
    `SELECT id FROM office_tag WHERE user_id = ?1 AND id IN (${placeholders})`,
  ).bind(ctx.store.userId, ...tagIds).all<{ id: string }>()
  return results.map((row) => row.id)
}

export const OFFICE_TOOLS: ToolDefinition[] = [
  tool({
    name: 'office_list_files',
    permission: 'read',
    maxCallsPerTurn: 4,
    description: 'List the reader\'s office files, optionally by product, folder, tag, favourites or recents.',
    fields: {
      type: { type: 'string', enum: OFFICE_FILE_TYPES, description: 'Only this product.', optional: true },
      folderId: { type: 'string', maxLength: 26, description: 'Only files directly in this folder.', optional: true },
      tag: { type: 'string', maxLength: 60, description: 'Only files carrying this tag (a slash path is allowed).', optional: true },
      starred: { type: 'boolean', description: 'Only favourites.', optional: true },
      recent: { type: 'boolean', description: 'Order by recently opened.', optional: true },
      trash: { type: 'boolean', description: 'List the trash instead of live files.', optional: true },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many files to return.', optional: true },
    },
    async run(args, ctx) {
      const where: string[] = ['f.user_id = ?1']
      const binds: Array<string | number> = [ctx.store.userId]
      if (typeof args.type === 'string') {
        where.push(`f.type = ?${binds.length + 1}`)
        binds.push(args.type)
      }
      if (typeof args.folderId === 'string' && args.folderId) {
        where.push(`f.folder_id = ?${binds.length + 1}`)
        binds.push(args.folderId)
      }
      if (typeof args.tag === 'string' && args.tag.trim()) {
        where.push(`EXISTS (SELECT 1 FROM office_file_tag ft JOIN office_tag t ON t.user_id = ft.user_id AND t.id = ft.tag_id
          WHERE ft.user_id = f.user_id AND ft.file_id = f.id AND (t.name = ?${binds.length + 1} OR t.name LIKE ?${binds.length + 2} ESCAPE '\\'))`)
        const tag = args.tag.replace(/^#/, '').trim()
        binds.push(tag, likePattern(`${tag}/`))
      }
      if (args.starred === true) where.push('f.is_starred = 1')
      where.push(args.trash === true ? 'f.deleted_at IS NOT NULL' : 'f.deleted_at IS NULL')
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 50) : 25
      const { results } = await ctx.env.DB.prepare(
        `SELECT f.id, f.type, f.title, f.folder_id, f.snapshot_key, f.rev, f.size, f.is_pinned, f.is_starred,
                f.last_opened_at, f.created_at, f.updated_at, f.deleted_at
           FROM office_file f
          WHERE ${where.join(' AND ')}
          ORDER BY f.is_pinned DESC, ${args.recent === true ? 'f.last_opened_at DESC' : 'f.updated_at DESC'}
          LIMIT ?${binds.length + 1}`,
      ).bind(...binds, limit).all<OfficeRow>()
      return { files: results.map(summaryOf) }
    },
  }),

  tool({
    name: 'office_search_files',
    permission: 'read',
    maxCallsPerTurn: 4,
    description: 'Search the reader\'s office files by title.',
    fields: {
      query: { type: 'string', minLength: 1, maxLength: 120, description: 'Words from the title.' },
      type: { type: 'string', enum: OFFICE_FILE_TYPES, description: 'Only this product.', optional: true },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many files to return.', optional: true },
    },
    async run(args, ctx) {
      const query = String(args.query).trim()
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 50) : 20
      const typeClause = typeof args.type === 'string' ? ' AND type = ?4' : ''
      const statement = ctx.env.DB.prepare(
        `SELECT ${FILE_COLUMNS} FROM office_file
          WHERE user_id = ?1 AND deleted_at IS NULL AND lower(title) LIKE ?2 ESCAPE '\\'${typeClause}
          ORDER BY updated_at DESC LIMIT ?3`,
      )
      const { results } = typeof args.type === 'string'
        ? await statement.bind(ctx.store.userId, likePattern(query.toLowerCase()), limit, args.type).all<OfficeRow>()
        : await statement.bind(ctx.store.userId, likePattern(query.toLowerCase()), limit).all<OfficeRow>()
      return { files: results.map(summaryOf) }
    },
  }),

  tool({
    name: 'office_read_file',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'Read a bounded plain-text view of one office file. Binary assets are never returned.',
    fields: {
      id: { type: 'string', minLength: 1, maxLength: 26, description: 'The file id from office_list_files.' },
    },
    async run(args, ctx) {
      const row = await rowFor(ctx, String(args.id))
      if (!row.snapshot_key) {
        return { file: summaryOf(row), text: '', truncated: false }
      }
      if (!ctx.env.FILES) throw new ToolError('This deployment has no office storage.')
      const object = await ctx.env.FILES.get(row.snapshot_key)
      if (!object) throw new ToolError('The stored snapshot is missing.')
      let snapshot: unknown
      try {
        snapshot = JSON.parse(await object.text())
      } catch {
        throw new ToolError('The stored snapshot is not readable.')
      }
      const extracted = extractOfficeText(row.type, snapshot as Record<string, unknown>, OFFICE_LIMITS.aiReadChars)
      return { file: summaryOf(row), text: extracted.text, truncated: extracted.truncated }
    },
  }),

  tool({
    name: 'office_list_folders',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'List the reader\'s office folder tree, flattened with parent ids.',
    fields: {},
    async run(_args, ctx) {
      const { results } = await ctx.env.DB.prepare(
        `SELECT id, parent_id, name, icon, color, position FROM office_folder
          WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`,
      ).bind(ctx.store.userId).all<{
        id: string; parent_id: string | null; name: string; icon: string | null; color: string | null; position: number
      }>()
      return { folders: results }
    },
  }),

  tool({
    name: 'office_list_tags',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'List the reader\'s office tags. Slash paths express hierarchy.',
    fields: {},
    async run(_args, ctx) {
      const { results } = await ctx.env.DB.prepare(
        `SELECT t.id, t.name, t.color, t.is_pinned,
                (SELECT COUNT(*) FROM office_file_tag ft JOIN office_file f
                  ON f.user_id = ft.user_id AND f.id = ft.file_id AND f.deleted_at IS NULL
                 WHERE ft.user_id = t.user_id AND ft.tag_id = t.id) AS count
           FROM office_tag t WHERE t.user_id = ?1 ORDER BY t.name COLLATE NOCASE`,
      ).bind(ctx.store.userId).all<{ id: string; name: string; color: string | null; is_pinned: number; count: number }>()
      return { tags: results.map((row) => ({ ...row, isPinned: Boolean(row.is_pinned) })) }
    },
  }),

  tool({
    name: 'office_create_file',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Create an empty office file and open it in the reader\'s Office tab.',
    fields: {
      type: { type: 'string', enum: OFFICE_FILE_TYPES, description: 'The product to create.' },
      title: { type: 'string', minLength: 1, maxLength: 120, description: 'The file name.' },
      folderId: { type: 'string', maxLength: 26, description: 'The destination folder.', optional: true },
    },
    async run(args, ctx) {
      const type = args.type as OfficeFileType
      const title = normalizeOfficeTitle(args.title)
      if (!title) throw new ToolError('The title is empty or too long.')
      if (typeof args.folderId === 'string' && !(await folderExists(ctx, args.folderId))) {
        throw new ToolError('That folder does not exist.')
      }
      const id = newId()
      const now = Date.now()
      await ctx.env.DB.prepare(
        `INSERT INTO office_file (user_id, id, type, title, folder_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      ).bind(ctx.store.userId, id, type, title, typeof args.folderId === 'string' ? args.folderId : null, now).run()
      const file = await rowFor(ctx, id)
      return {
        result: { file: summaryOf(file) },
        effect: { kind: 'office.open', fileId: id, fileType: type },
      }
    },
  }),

  tool({
    name: 'office_update_file',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Rename, move, favourite, pin or tag an office file.',
    fields: {
      id: { type: 'string', minLength: 1, maxLength: 26, description: 'The file id.' },
      title: { type: 'string', minLength: 1, maxLength: 120, description: 'The new name.', optional: true },
      folderId: { type: 'string', maxLength: 26, description: 'Move to this folder; null moves to the root.', nullable: true, optional: true },
      isPinned: { type: 'boolean', description: 'Pin or unpin.', optional: true },
      isStarred: { type: 'boolean', description: 'Favourite or unfavourite.', optional: true },
      tagIds: { type: 'array', items: 'string', maxItems: 20, maxLength: 26, description: 'Replace the file tags with these tag ids.', optional: true },
    },
    async run(args, ctx) {
      const row = await rowFor(ctx, String(args.id))
      const updates: string[] = []
      const binds: Array<string | number | null> = [ctx.store.userId, row.id]
      const push = (column: string, value: string | number | null) => {
        updates.push(`${column} = ?${binds.length + 1}`)
        binds.push(value)
      }
      if (args.title !== undefined) {
        const title = normalizeOfficeTitle(args.title)
        if (!title) throw new ToolError('The title is empty or too long.')
        push('title', title)
      }
      if (args.folderId !== undefined) {
        if (args.folderId !== null && (typeof args.folderId !== 'string' || !(await folderExists(ctx, args.folderId)))) {
          throw new ToolError('That folder does not exist.')
        }
        push('folder_id', typeof args.folderId === 'string' ? args.folderId : null)
      }
      if (typeof args.isPinned === 'boolean') push('is_pinned', args.isPinned ? 1 : 0)
      if (typeof args.isStarred === 'boolean') push('is_starred', args.isStarred ? 1 : 0)
      if (updates.length) {
        updates.push(`updated_at = ?${binds.length + 1}`)
        binds.push(Date.now())
        await ctx.env.DB.prepare(
          `UPDATE office_file SET ${updates.join(', ')} WHERE user_id = ?1 AND id = ?2`,
        ).bind(...binds).run()
      }
      if (Array.isArray(args.tagIds)) {
        const tagIds = args.tagIds.filter((value): value is string => typeof value === 'string')
        const owned = await ownedTagIds(ctx, tagIds)
        if (owned.length !== tagIds.length) throw new ToolError('One of those tags does not exist.')
        await ctx.env.DB.batch([
          ctx.env.DB.prepare(`DELETE FROM office_file_tag WHERE user_id = ?1 AND file_id = ?2`).bind(ctx.store.userId, row.id),
          ...owned.map((tagId) => ctx.env.DB.prepare(
            `INSERT OR IGNORE INTO office_file_tag (user_id, file_id, tag_id) VALUES (?1, ?2, ?3)`,
          ).bind(ctx.store.userId, row.id, tagId)),
        ])
      }
      return { result: { file: summaryOf(await rowFor(ctx, row.id)) }, effect: { kind: 'office.refresh', fileId: row.id } }
    },
  }),

  tool({
    name: 'office_duplicate_file',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Duplicate an office file, including its current snapshot.',
    fields: { id: { type: 'string', minLength: 1, maxLength: 26, description: 'The source file id.' } },
    async run(args, ctx) {
      const source = await rowFor(ctx, String(args.id))
      const id = newId()
      const now = Date.now()
      let snapshotKey = ''
      if (source.snapshot_key) {
        if (!ctx.env.FILES) throw new ToolError('This deployment has no office storage.')
        const object = await ctx.env.FILES.get(source.snapshot_key)
        if (object) {
          snapshotKey = officeSnapshotKey(ctx.store.userId, id, 1)
          const text = await object.text()
          await ctx.env.FILES.put(snapshotKey, text, { httpMetadata: { contentType: 'application/json' } })
        }
      }
      const title = `${source.title} copy`.slice(0, OFFICE_LIMITS.titleMax)
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `INSERT INTO office_file (user_id, id, type, title, folder_id, snapshot_key, rev, size, content_hash, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
        ).bind(ctx.store.userId, id, source.type, title, source.folder_id, snapshotKey, snapshotKey ? 1 : 0, source.size, '', now),
        ...(snapshotKey
          ? [ctx.env.DB.prepare(
            `INSERT OR IGNORE INTO office_file_version (user_id, file_id, rev, object_key, size, content_hash, created_at)
             VALUES (?1, ?2, 1, ?3, ?4, '', ?5)`,
          ).bind(ctx.store.userId, id, snapshotKey, source.size, now)]
          : []),
      ])
      return { result: { file: summaryOf(await rowFor(ctx, id)) }, effect: { kind: 'office.refresh' } }
    },
  }),

  tool({
    name: 'office_delete_file',
    permission: 'destructive',
    maxCallsPerTurn: 2,
    description: 'Propose moving an office file to the trash. Nothing changes until the reader approves.',
    fields: { id: { type: 'string', minLength: 1, maxLength: 26, description: 'The file id.' } },
    async prepare(args, ctx) {
      const row = await rowFor(ctx, String(args.id))
      return { targetId: row.id, targetLabel: row.title }
    },
    async commit(targetId, ctx) {
      await ctx.env.DB.prepare(
        `UPDATE office_file SET deleted_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
      ).bind(ctx.store.userId, targetId, Date.now()).run()
      return { ok: true }
    },
  }),

  tool({
    name: 'office_propose_edit',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Propose structured edits for an open office file. The Office tab applies them through the editor.',
    fields: {
      fileId: { type: 'string', minLength: 26, maxLength: 26, description: 'The target file id.' },
      type: { type: 'string', enum: OFFICE_FILE_TYPES, description: 'The target product.' },
      summary: { type: 'string', minLength: 1, maxLength: 500, description: 'One sentence the reader sees with the edit.' },
      ops: { type: 'array', items: 'object', maxItems: 200, description: 'Product-specific operations from the office edit-plan vocabulary.' },
    },
    async run(args, ctx) {
      const row = await rowFor(ctx, String(args.fileId))
      const validation = validateOfficeEditPlan(
        { type: args.type, fileId: args.fileId, summary: args.summary, ops: args.ops },
        { type: row.type, fileId: row.id },
      )
      if (!validation.ok) throw new ToolError(validation.error)
      return {
        result: { summary: validation.plan.summary, operations: validation.plan.ops.length },
        effect: {
          kind: 'office.apply-plan',
          fileId: row.id,
          fileType: row.type,
          plan: validation.plan,
        },
      }
    },
  }),
]