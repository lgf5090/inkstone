import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import type { HubFolder, HubTag } from '@shared/attachment-hub'
import {
  attachmentScope,
  scopeColumnFilter,
  type AttachmentScope,
} from './scopes'



/**
 * Folders and tags for the attachment hub.
 *
 * Both tables carry a `scope` column rather than being one table pair per application, because the
 * row shape, the ordering rules and the detach-on-delete behaviour are identical across all four —
 * the only thing that differs is which application's sidebar is drawing them. Scoping by a column
 * keeps that to one implementation; four table pairs would mean four copies of the same eight
 * statements to keep honest.
 *
 * Names are scoped, not global: a "Screenshots" folder in notes and one in chat are unrelated
 * things that happen to share a name, and a rename in one must not reach into the other.
 */

const FOLDER_NAME_MAX = 100
const TAG_NAME_MAX = 50
const FOLDER_NOT_FOUND = 'Folder not found'
const TAG_NOT_FOUND = 'Tag not found'
const TAG_NAME_REQUIRED = 'Tag name is required'

const FOLDER_COLUMNS =
  'id, parent_id, name, icon, color, position, created_at, updated_at'
const TAG_COLUMNS = 'id, name, color, is_pinned, created_at'

interface FolderRow {
  id: string
  parent_id: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  created_at: number
  updated_at: number
}

interface TagRow {
  id: string
  name: string
  color: string | null
  is_pinned: number
  created_at: number
}

function toFolder(row: FolderRow): HubFolder {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toTag(row: TagRow): HubTag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isPinned: Boolean(row.is_pinned),
    createdAt: row.created_at,
  }
}

function trimmedName(value: unknown, max: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : ''
}

export async function listHubFolders(
  db: D1Database,
  userId: string,
  scope: AttachmentScope,
): Promise<HubFolder[]> {
  const { results } = await db
    .prepare(
      `SELECT ${FOLDER_COLUMNS} FROM attachment_folders
        WHERE user_id = ?1 AND scope = ?2 ORDER BY position ASC, created_at ASC`,
    )
    .bind(userId, scope)
    .all<FolderRow>()
  return results.map(toFolder)
}

export interface HubFolderInput {
  id?: string
  name?: string
  parentId?: string | null
  color?: string | null
  icon?: string | null
  position?: number
}

export async function createHubFolder(
  db: D1Database,
  userId: string,
  scope: AttachmentScope,
  input: HubFolderInput,
): Promise<HubFolder> {
  const id = input.id && isValidId(input.id) ? input.id : newId()
  const name = trimmedName(input.name, FOLDER_NAME_MAX) || 'New Folder'
  const parentId = input.parentId && isValidId(input.parentId) ? input.parentId : null
  const now = Date.now()
  const position = typeof input.position === 'number' ? input.position : now
  const icon = input.icon ?? null
  const color = input.color ?? null

  await db
    .prepare(
      `INSERT INTO attachment_folders
         (user_id, id, scope, parent_id, name, icon, color, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(userId, id, scope, parentId, name, icon, color, position, now, now)
    .run()

  return { id, parentId, name, icon, color, position, createdAt: now, updatedAt: now }
}

export async function updateHubFolder(
  db: D1Database,
  userId: string,
  scope: AttachmentScope,
  id: string,
  input: HubFolderInput,
): Promise<HubFolder> {
  const existing = await loadFolder(db, userId, scope, id)

  const name = input.name !== undefined ? trimmedName(input.name, FOLDER_NAME_MAX) || existing.name : existing.name
  const parentId =
    input.parentId !== undefined
      ? input.parentId && isValidId(input.parentId)
        ? input.parentId
        : null
      : existing.parent_id
  const color = input.color !== undefined ? input.color : existing.color
  const icon = input.icon !== undefined ? input.icon : existing.icon
  const position = typeof input.position === 'number' ? input.position : existing.position
  const now = Date.now()

  await db
    .prepare(
      `UPDATE attachment_folders
          SET name = ?1, parent_id = ?2, color = ?3, icon = ?4, position = ?5, updated_at = ?6
        WHERE user_id = ?7 AND scope = ?8 AND id = ?9`,
    )
    .bind(name, parentId, color, icon, position, now, userId, scope, id)
    .run()

  return {
    id,
    parentId,
    name,
    icon,
    color,
    position,
    createdAt: existing.created_at,
    updatedAt: now,
  }
}

/**
 * Deletes a folder by detaching first.
 *
 * Both the files that were in it and the folders that were under it move to the root rather than
 * going with it: a folder is a way of looking at files, and deleting the view must not delete the
 * thing viewed.
 */
export async function deleteHubFolder(
  db: D1Database,
  userId: string,
  scope: AttachmentScope,
  id: string,
): Promise<boolean> {
  if (!isValidId(id)) throw ApiError.notFound(FOLDER_NOT_FOUND)
  const descriptor = attachmentScope(scope)
  const outcome = await db.batch([
    db.prepare(
      `UPDATE ${descriptor.table} SET folder_id = NULL
        WHERE folder_id = ?1 AND user_id = ?2 AND ${scopeColumnFilter(scope)}`,
    ).bind(id, userId),
    db.prepare(
      `UPDATE attachment_folders SET parent_id = NULL
        WHERE parent_id = ?1 AND user_id = ?2 AND scope = ?3`,
    ).bind(id, userId, scope),
    db.prepare(
      `DELETE FROM attachment_folders WHERE user_id = ?1 AND scope = ?2 AND id = ?3`,
    ).bind(userId, scope, id),
  ])
  return Boolean(outcome.at(-1)?.meta.changes)
}


async function loadFolder(
  db: D1Database,
  userId: string,
  scope: AttachmentScope,
  id: string,
): Promise<FolderRow> {
  if (!isValidId(id)) throw ApiError.notFound(FOLDER_NOT_FOUND)
  const row = await db
    .prepare(
      `SELECT ${FOLDER_COLUMNS} FROM attachment_folders
        WHERE user_id = ?1 AND scope = ?2 AND id = ?3`,
    )
    .bind(userId, scope, id)
    .first<FolderRow>()
  if (!row) throw ApiError.notFound(FOLDER_NOT_FOUND)
  return row
}

export async function listHubTags(
  db: D1Database,
  userId: string,
  scope: AttachmentScope,
): Promise<HubTag[]> {
  const { results } = await db
    .prepare(
      `SELECT ${TAG_COLUMNS} FROM attachment_tags
        WHERE user_id = ?1 AND scope = ?2 ORDER BY is_pinned DESC, name ASC`,
    )
    .bind(userId, scope)
    .all<TagRow>()
  return results.map(toTag)
}

export interface HubTagInput {
  id?: string
  name?: string
  color?: string | null
  isPinned?: boolean
}

/**
 * Creates a tag, reusing the row when the scope already has that name.
 *
 * The unique index is on (user_id, scope, name), and the hub's tag chips are drawn from names
 * rather than ids, so a second create for a name already present is a double-click and not a
 * request to have two indistinguishable tags.
 */
export async function createHubTag(
  db: D1Database,
  userId: string,
  scope: AttachmentScope,
  input: HubTagInput,
): Promise<HubTag> {
  const name = trimmedName(input.name, TAG_NAME_MAX)
  if (!name) throw ApiError.badRequest(TAG_NAME_REQUIRED)
  const id = input.id && isValidId(input.id) ? input.id : newId()
  const now = Date.now()
  const color = input.color ?? null

  await db
    .prepare(
      `INSERT INTO attachment_tags (user_id, id, scope, name, color, is_pinned, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
       ON CONFLICT (user_id, scope, name) DO UPDATE SET color = COALESCE(?5, color)`,
    )
    .bind(userId, id, scope, name, color, now)
    .run()

  const row = await db
    .prepare(`SELECT ${TAG_COLUMNS} FROM attachment_tags WHERE user_id = ?1 AND scope = ?2 AND name = ?3`)
    .bind(userId, scope, name)
    .first<TagRow>()
  return row ? toTag(row) : { id, name, color, isPinned: false, createdAt: now }
}

/**
 * Renames a tag and rewrites the name inside every file that carries it.
 *
 * Tags live twice: as a row here, and as a string inside each file's JSON `tags` column. The row is
 * the definition and the strings are the uses, so a rename that only touches the row would leave
 * every file wearing the old name and the sidebar unable to filter to it.
 *
 * The bodies are rewritten by parsing them rather than by a SQL `replace()`: the column is a JSON
 * array, and cutting one quoted name out of the raw text leaves `["a", "b"]` as `[, "b"]`, which
 * then fails to parse on every read afterwards.
 */
export async function updateHubTag(
  db: D1Database,
  userId: string,
  scope: AttachmentScope,
  id: string,
  input: HubTagInput,
): Promise<HubTag> {
  const existing = await loadTag(db, userId, scope, id)
  const name = input.name !== undefined ? trimmedName(input.name, TAG_NAME_MAX) || existing.name : existing.name
  const color = input.color !== undefined ? input.color : existing.color
  const isPinned = input.isPinned !== undefined ? (input.isPinned ? 1 : 0) : existing.is_pinned

  await db
    .prepare(
      `UPDATE attachment_tags SET name = ?1, color = ?2, is_pinned = ?3
        WHERE user_id = ?4 AND scope = ?5 AND id = ?6`,
    )
    .bind(name, color, isPinned, userId, scope, id)
    .run()

  if (name !== existing.name) {
    await rewriteTaggedRows(db, scope, userId, existing.name, (tags) =>
      tags.map((tag) => (tag === existing.name ? name : tag)),
    )
  }

  return {
    id,
    name,
    color,
    isPinned: Boolean(isPinned),
    createdAt: existing.created_at,
  }
}

export async function deleteHubTag(
  db: D1Database,
  userId: string,
  scope: AttachmentScope,
  id: string,
): Promise<boolean> {
  const existing = await loadTag(db, userId, scope, id)
  const removed = await db
    .prepare(`DELETE FROM attachment_tags WHERE user_id = ?1 AND scope = ?2 AND id = ?3`)
    .bind(userId, scope, id)
    .run()
  await rewriteTaggedRows(db, scope, userId, existing.name, (tags) =>
    tags.filter((tag) => tag !== existing.name),
  )
  return Boolean(removed.meta.changes)
}

const TAG_REWRITE_PAGE_SIZE = 200

/**
 * Applies `edit` to every file in this scope whose tag list mentions `name`.
 *
 * Paged by rowid-ordered id because the whole point is not to hold the account's files in memory at
 * once, and the `instr` prefilter means the JSON is only parsed for the rows that could contain it.
 */
async function rewriteTaggedRows(
  db: D1Database,
  scope: AttachmentScope,
  userId: string,
  name: string,
  edit: (tags: string[]) => string[],
): Promise<void> {
  const descriptor = attachmentScope(scope)
  const needle = `"${name}"`
  let afterId = ''
  while (true) {
    const { results } = await db
      .prepare(
        `SELECT id, tags FROM ${descriptor.table}
          WHERE user_id = ?1 AND ${scopeColumnFilter(scope)} AND instr(tags, ?2) > 0 AND id > ?3
          ORDER BY id ASC LIMIT ?4`,
      )
      .bind(userId, needle, afterId, TAG_REWRITE_PAGE_SIZE)
      .all<{ id: string; tags: string }>()
    if (!results.length) break

    const statements = results.map((row) => {
      const tags = decodeTags(row.tags)
      return db.prepare(
        `UPDATE ${descriptor.table} SET tags = ?1 WHERE user_id = ?2 AND id = ?3`,
      ).bind(JSON.stringify(edit(tags)), userId, row.id)
    })
    if (statements.length) await db.batch(statements)

    afterId = results[results.length - 1]!.id
    if (results.length < TAG_REWRITE_PAGE_SIZE) break
  }
}

function decodeTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}


async function loadTag(
  db: D1Database,
  userId: string,
  scope: AttachmentScope,
  id: string,
): Promise<TagRow> {
  if (!isValidId(id)) throw ApiError.notFound(TAG_NOT_FOUND)
  const row = await db
    .prepare(
      `SELECT ${TAG_COLUMNS} FROM attachment_tags WHERE user_id = ?1 AND scope = ?2 AND id = ?3`,
    )
    .bind(userId, scope, id)
    .first<TagRow>()
  if (!row) throw ApiError.notFound(TAG_NOT_FOUND)
  return row
}
