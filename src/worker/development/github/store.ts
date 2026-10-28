import { MAX_GISTS, MAX_REPOS, MAX_TAGS } from '@shared/development/github/limits'
import type {
  GithubExportFormat,
  GithubTag,
  SavedGist,
  SavedGithubRepo,
} from '@shared/development/github/types'
import { chunkMarks, idChunks, runBatched } from '../../db/writes'
import { ApiError } from '../../lib/errors'

interface TagRow {
  id: string
  name: string
  color: string
  parent_id: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

interface RepoRow {
  id: string
  full_name: string
  url: string
  data_json: string
  tag_ids: string
  pinned: number
  favorited: number
  created_at: number
  updated_at: number
}

interface GistRow {
  id: string
  description: string
  url: string
  data_json: string
  tag_ids: string
  pinned: number
  favorited: number
  notes: string
  created_at: number
  updated_at: number
}

interface ExportRow {
  id: string
  filename: string
  format: string
  r2_key: string
  size: number
  created_at: number
}

export interface ExportRecord {
  id: string
  filename: string
  format: GithubExportFormat
  r2Key: string
  size: number
  createdAt: number
}

export interface ExportInsert {
  id: string
  filename: string
  format: GithubExportFormat
  r2Key: string
  size: number
  createdAt: number
}

export interface TagUpsert {
  id: string
  name: string
  color: string
  parentId: string | null
  sortOrder: number
  createdAt?: number
}

export interface RepoUpsert {
  id: string
  fullName: string
  url: string
  data: SavedGithubRepo['data']
  tagIds: string[]
  pinned: boolean
  favorited: boolean
  createdAt?: number
}

export interface GistUpsert {
  id: string
  description: string
  url: string
  data: SavedGist['data']
  tagIds: string[]
  pinned: boolean
  favorited: boolean
  notes: string
  createdAt?: number
}

export interface GistBatchPatch {
  pinned?: boolean
  favorited?: boolean
  addTagIds?: string[]
  removeTagIds?: string[]
}

const TAG_COLUMNS = 'id, name, color, parent_id, sort_order, created_at, updated_at'
const REPO_COLUMNS = 'id, full_name, url, data_json, tag_ids, pinned, favorited, created_at, updated_at'
const GIST_COLUMNS = 'id, description, url, data_json, tag_ids, pinned, favorited, notes, created_at, updated_at'
const EXPORT_COLUMNS = 'id, filename, format, r2_key, size, created_at'

function readJson<T>(raw: string, fallback: T, label: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    console.warn(`[inkstone] Ignoring malformed development github ${label} JSON:`, error)
    return fallback
  }
}

function readStringArray(raw: string, label: string): string[] {
  const value = readJson<unknown>(raw, [], label)
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function toTag(row: TagRow): GithubTag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRepo(row: RepoRow): SavedGithubRepo {
  return {
    id: row.id,
    fullName: row.full_name,
    url: row.url,
    data: readJson<SavedGithubRepo['data']>(row.data_json, {} as SavedGithubRepo['data'], 'repo snapshot'),
    tagIds: readStringArray(row.tag_ids, 'repo tag ids'),
    pinned: row.pinned === 1,
    favorited: row.favorited === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toGist(row: GistRow): SavedGist {
  return {
    id: row.id,
    description: row.description,
    url: row.url,
    data: readJson<SavedGist['data']>(row.data_json, {} as SavedGist['data'], 'gist snapshot'),
    tagIds: readStringArray(row.tag_ids, 'gist tag ids'),
    pinned: row.pinned === 1,
    favorited: row.favorited === 1,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toExportFormat(value: string): GithubExportFormat {
  if (value === 'json' || value === 'md' || value === 'txt') return value
  console.warn(`[inkstone] Unrecognised development github export format: ${value}`)
  return 'json'
}

function toExport(row: ExportRow): ExportRecord {
  return {
    id: row.id,
    filename: row.filename,
    format: toExportFormat(row.format),
    r2Key: row.r2_key,
    size: row.size,
    createdAt: row.created_at,
  }
}

export function collectDescendantTagIds(
  tags: readonly Pick<GithubTag, 'id' | 'parentId'>[],
  rootId: string,
): string[] {
  const result = new Set<string>([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const tag of tags) {
      if (tag.parentId && result.has(tag.parentId) && !result.has(tag.id)) {
        result.add(tag.id)
        changed = true
      }
    }
  }
  return Array.from(result)
}

export async function listTags(db: D1Database, userId: string): Promise<GithubTag[]> {
  const { results } = await db
    .prepare(
      `SELECT ${TAG_COLUMNS} FROM development_github_tags
        WHERE user_id = ?1
        ORDER BY sort_order ASC, created_at ASC`,
    )
    .bind(userId)
    .all<TagRow>()
  return results.map(toTag)
}

export async function findTag(db: D1Database, userId: string, id: string): Promise<GithubTag | null> {
  const row = await db
    .prepare(`SELECT ${TAG_COLUMNS} FROM development_github_tags WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id)
    .first<TagRow>()
  return row ? toTag(row) : null
}

export async function countTags(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM development_github_tags WHERE user_id = ?1')
    .bind(userId)
    .first<{ count: number }>()
  return Number(row?.count ?? 0)
}

export async function upsertTag(db: D1Database, userId: string, input: TagUpsert): Promise<GithubTag> {
  const existing = await findTag(db, userId, input.id)
  if (!existing && (await countTags(db, userId)) >= MAX_TAGS) {
    throw ApiError.badRequest(`Tags are limited to ${MAX_TAGS} per account`)
  }
  const now = Date.now()
  const createdAt = existing?.createdAt ?? input.createdAt ?? now
  await db
    .prepare(
      `INSERT INTO development_github_tags (user_id, id, name, color, parent_id, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (user_id, id) DO UPDATE SET
         name = excluded.name,
         color = excluded.color,
         parent_id = excluded.parent_id,
         sort_order = excluded.sort_order,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, input.id, input.name, input.color, input.parentId, input.sortOrder, createdAt, now)
    .run()
  return {
    id: input.id,
    name: input.name,
    color: input.color,
    parentId: input.parentId,
    sortOrder: input.sortOrder,
    createdAt,
    updatedAt: now,
  }
}

export async function deleteTags(db: D1Database, userId: string, ids: readonly string[]): Promise<number> {
  let removed = 0
  for (const chunk of idChunks(ids)) {
    const result = await db
      .prepare(
        `DELETE FROM development_github_tags WHERE user_id = ?1 AND id IN (${chunkMarks(chunk)})`,
      )
      .bind(userId, ...chunk)
      .run()
    removed += result.meta.changes ?? 0
  }
  return removed
}

export async function listRepos(db: D1Database, userId: string): Promise<SavedGithubRepo[]> {
  const { results } = await db
    .prepare(
      `SELECT ${REPO_COLUMNS} FROM development_github_repos
        WHERE user_id = ?1
        ORDER BY updated_at DESC`,
    )
    .bind(userId)
    .all<RepoRow>()
  return results.map(toRepo)
}

export async function findRepo(db: D1Database, userId: string, id: string): Promise<SavedGithubRepo | null> {
  const row = await db
    .prepare(`SELECT ${REPO_COLUMNS} FROM development_github_repos WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id)
    .first<RepoRow>()
  return row ? toRepo(row) : null
}

export async function countRepos(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM development_github_repos WHERE user_id = ?1')
    .bind(userId)
    .first<{ count: number }>()
  return Number(row?.count ?? 0)
}

export async function upsertRepo(
  db: D1Database,
  userId: string,
  input: RepoUpsert,
): Promise<SavedGithubRepo> {
  const existing = await findRepo(db, userId, input.id)
  if (!existing && (await countRepos(db, userId)) >= MAX_REPOS) {
    throw ApiError.badRequest(`Repositories are limited to ${MAX_REPOS} per account`)
  }
  const now = Date.now()
  const createdAt = existing?.createdAt ?? input.createdAt ?? now
  await db
    .prepare(
      `INSERT INTO development_github_repos
         (user_id, id, full_name, url, data_json, tag_ids, pinned, favorited, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (user_id, id) DO UPDATE SET
         full_name = excluded.full_name,
         url = excluded.url,
         data_json = excluded.data_json,
         tag_ids = excluded.tag_ids,
         pinned = excluded.pinned,
         favorited = excluded.favorited,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      input.id,
      input.fullName,
      input.url,
      JSON.stringify(input.data),
      JSON.stringify(input.tagIds),
      input.pinned ? 1 : 0,
      input.favorited ? 1 : 0,
      createdAt,
      now,
    )
    .run()
  return {
    id: input.id,
    fullName: input.fullName,
    url: input.url,
    data: input.data,
    tagIds: input.tagIds,
    pinned: input.pinned,
    favorited: input.favorited,
    createdAt,
    updatedAt: now,
  }
}

export async function deleteRepo(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM development_github_repos WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function unbindRepoTags(
  db: D1Database,
  userId: string,
  tagIds: readonly string[],
): Promise<string[]> {
  if (tagIds.length === 0) return []
  const removed = new Set(tagIds)
  const { results } = await db
    .prepare('SELECT id, tag_ids FROM development_github_repos WHERE user_id = ?1')
    .bind(userId)
    .all<{ id: string; tag_ids: string }>()
  const now = Date.now()
  const updated: string[] = []
  const statements: D1PreparedStatement[] = []
  for (const row of results) {
    const current = readStringArray(row.tag_ids, 'repo tag ids')
    const next = current.filter((tagId) => !removed.has(tagId))
    if (next.length === current.length) continue
    updated.push(row.id)
    statements.push(
      db
        .prepare(
          'UPDATE development_github_repos SET tag_ids = ?1, updated_at = ?2 WHERE user_id = ?3 AND id = ?4',
        )
        .bind(JSON.stringify(next), now, userId, row.id),
    )
  }
  await runBatched(db, statements)
  return updated
}

export async function listGistTags(db: D1Database, userId: string): Promise<GithubTag[]> {
  const { results } = await db
    .prepare(
      `SELECT ${TAG_COLUMNS} FROM development_github_gist_tags
        WHERE user_id = ?1
        ORDER BY sort_order ASC, created_at ASC`,
    )
    .bind(userId)
    .all<TagRow>()
  return results.map(toTag)
}

export async function findGistTag(
  db: D1Database,
  userId: string,
  id: string,
): Promise<GithubTag | null> {
  const row = await db
    .prepare(`SELECT ${TAG_COLUMNS} FROM development_github_gist_tags WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id)
    .first<TagRow>()
  return row ? toTag(row) : null
}

export async function countGistTags(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM development_github_gist_tags WHERE user_id = ?1')
    .bind(userId)
    .first<{ count: number }>()
  return Number(row?.count ?? 0)
}

export async function upsertGistTag(
  db: D1Database,
  userId: string,
  input: TagUpsert,
): Promise<GithubTag> {
  const existing = await findGistTag(db, userId, input.id)
  if (!existing && (await countGistTags(db, userId)) >= MAX_TAGS) {
    throw ApiError.badRequest(`Gist tags are limited to ${MAX_TAGS} per account`)
  }
  const now = Date.now()
  const createdAt = existing?.createdAt ?? input.createdAt ?? now
  await db
    .prepare(
      `INSERT INTO development_github_gist_tags (user_id, id, name, color, parent_id, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (user_id, id) DO UPDATE SET
         name = excluded.name,
         color = excluded.color,
         parent_id = excluded.parent_id,
         sort_order = excluded.sort_order,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, input.id, input.name, input.color, input.parentId, input.sortOrder, createdAt, now)
    .run()
  return {
    id: input.id,
    name: input.name,
    color: input.color,
    parentId: input.parentId,
    sortOrder: input.sortOrder,
    createdAt,
    updatedAt: now,
  }
}

export async function deleteGistTags(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<number> {
  let removed = 0
  for (const chunk of idChunks(ids)) {
    const result = await db
      .prepare(
        `DELETE FROM development_github_gist_tags WHERE user_id = ?1 AND id IN (${chunkMarks(chunk)})`,
      )
      .bind(userId, ...chunk)
      .run()
    removed += result.meta.changes ?? 0
  }
  return removed
}

export async function listGists(db: D1Database, userId: string): Promise<SavedGist[]> {
  const { results } = await db
    .prepare(
      `SELECT ${GIST_COLUMNS} FROM development_github_gists
        WHERE user_id = ?1
        ORDER BY updated_at DESC`,
    )
    .bind(userId)
    .all<GistRow>()
  return results.map(toGist)
}

export async function findGist(db: D1Database, userId: string, id: string): Promise<SavedGist | null> {
  const row = await db
    .prepare(`SELECT ${GIST_COLUMNS} FROM development_github_gists WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id)
    .first<GistRow>()
  return row ? toGist(row) : null
}

export async function countGists(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM development_github_gists WHERE user_id = ?1')
    .bind(userId)
    .first<{ count: number }>()
  return Number(row?.count ?? 0)
}

export async function upsertGist(
  db: D1Database,
  userId: string,
  input: GistUpsert,
): Promise<SavedGist> {
  const existing = await findGist(db, userId, input.id)
  if (!existing && (await countGists(db, userId)) >= MAX_GISTS) {
    throw ApiError.badRequest(`Gists are limited to ${MAX_GISTS} per account`)
  }
  const now = Date.now()
  const createdAt = existing?.createdAt ?? input.createdAt ?? now
  await db
    .prepare(
      `INSERT INTO development_github_gists
         (user_id, id, description, url, data_json, tag_ids, pinned, favorited, notes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (user_id, id) DO UPDATE SET
         description = excluded.description,
         url = excluded.url,
         data_json = excluded.data_json,
         tag_ids = excluded.tag_ids,
         pinned = excluded.pinned,
         favorited = excluded.favorited,
         notes = excluded.notes,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      input.id,
      input.description,
      input.url,
      JSON.stringify(input.data),
      JSON.stringify(input.tagIds),
      input.pinned ? 1 : 0,
      input.favorited ? 1 : 0,
      input.notes,
      createdAt,
      now,
    )
    .run()
  return {
    id: input.id,
    description: input.description,
    url: input.url,
    data: input.data,
    tagIds: input.tagIds,
    pinned: input.pinned,
    favorited: input.favorited,
    notes: input.notes,
    createdAt,
    updatedAt: now,
  }
}

export async function deleteGist(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM development_github_gists WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function deleteGists(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<number> {
  let removed = 0
  for (const chunk of idChunks(ids)) {
    const result = await db
      .prepare(`DELETE FROM development_github_gists WHERE user_id = ?1 AND id IN (${chunkMarks(chunk)})`)
      .bind(userId, ...chunk)
      .run()
    removed += result.meta.changes ?? 0
  }
  return removed
}

export async function unbindGistTags(
  db: D1Database,
  userId: string,
  tagIds: readonly string[],
): Promise<string[]> {
  if (tagIds.length === 0) return []
  const removed = new Set(tagIds)
  const { results } = await db
    .prepare('SELECT id, tag_ids FROM development_github_gists WHERE user_id = ?1')
    .bind(userId)
    .all<{ id: string; tag_ids: string }>()
  const now = Date.now()
  const updated: string[] = []
  const statements: D1PreparedStatement[] = []
  for (const row of results) {
    const current = readStringArray(row.tag_ids, 'gist tag ids')
    const next = current.filter((tagId) => !removed.has(tagId))
    if (next.length === current.length) continue
    updated.push(row.id)
    statements.push(
      db
        .prepare(
          'UPDATE development_github_gists SET tag_ids = ?1, updated_at = ?2 WHERE user_id = ?3 AND id = ?4',
        )
        .bind(JSON.stringify(next), now, userId, row.id),
    )
  }
  await runBatched(db, statements)
  return updated
}

export async function batchUpdateGists(
  db: D1Database,
  userId: string,
  ids: readonly string[],
  patch: GistBatchPatch,
): Promise<number> {
  const hasFlags = patch.pinned !== undefined || patch.favorited !== undefined
  const hasTags = patch.addTagIds !== undefined || patch.removeTagIds !== undefined
  if (!hasFlags && !hasTags) return 0
  const uniqueIds = Array.from(new Set(ids))
  const statements: D1PreparedStatement[] = []
  const now = Date.now()
  let updated = 0
  for (const chunk of idChunks(uniqueIds)) {
    const { results } = await db
      .prepare(
        `SELECT id, tag_ids FROM development_github_gists WHERE user_id = ?1 AND id IN (${chunkMarks(chunk)})`,
      )
      .bind(userId, ...chunk)
      .all<{ id: string; tag_ids: string }>()
    for (const row of results) {
      const sets: string[] = []
      const values: unknown[] = []
      if (patch.pinned !== undefined) {
        sets.push('pinned = ?')
        values.push(patch.pinned ? 1 : 0)
      }
      if (patch.favorited !== undefined) {
        sets.push('favorited = ?')
        values.push(patch.favorited ? 1 : 0)
      }
      if (hasTags) {
        let tagIds = readStringArray(row.tag_ids, 'gist tag ids')
        if (patch.addTagIds) tagIds = Array.from(new Set([...tagIds, ...patch.addTagIds]))
        if (patch.removeTagIds) {
          const removed = new Set(patch.removeTagIds)
          tagIds = tagIds.filter((tagId) => !removed.has(tagId))
        }
        sets.push('tag_ids = ?')
        values.push(JSON.stringify(tagIds))
      }
      sets.push('updated_at = ?')
      values.push(now, userId, row.id)
      statements.push(
        db
          .prepare(`UPDATE development_github_gists SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`)
          .bind(...values),
      )
      updated += 1
    }
  }
  await runBatched(db, statements)
  return updated
}

type IdTable = 'development_github_tags' | 'development_github_gist_tags'

async function findExistingIds(
  db: D1Database,
  table: IdTable,
  userId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>()
  const unique = Array.from(new Set(ids))
  for (const chunk of idChunks(unique)) {
    const { results } = await db
      .prepare(`SELECT id FROM ${table} WHERE user_id = ?1 AND id IN (${chunkMarks(chunk)})`)
      .bind(userId, ...chunk)
      .all<{ id: string }>()
    for (const row of results) found.add(row.id)
  }
  return found
}

export async function findMissingTagIds(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<string[]> {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return []
  const found = await findExistingIds(db, 'development_github_tags', userId, unique)
  return unique.filter((id) => !found.has(id))
}

export async function findMissingGistTagIds(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<string[]> {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return []
  const found = await findExistingIds(db, 'development_github_gist_tags', userId, unique)
  return unique.filter((id) => !found.has(id))
}

export async function listExports(db: D1Database, userId: string): Promise<ExportRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${EXPORT_COLUMNS} FROM development_github_exports
        WHERE user_id = ?1
        ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<ExportRow>()
  return results.map(toExport)
}

export async function findExport(db: D1Database, userId: string, id: string): Promise<ExportRecord | null> {
  const row = await db
    .prepare(`SELECT ${EXPORT_COLUMNS} FROM development_github_exports WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id)
    .first<ExportRow>()
  return row ? toExport(row) : null
}

export async function insertExport(
  db: D1Database,
  userId: string,
  record: ExportInsert,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO development_github_exports (user_id, id, filename, format, r2_key, size, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      userId,
      record.id,
      record.filename,
      record.format,
      record.r2Key,
      record.size,
      record.createdAt,
    )
    .run()
}

export async function deleteExport(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM development_github_exports WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function listExpiredExports(
  db: D1Database,
  userId: string,
  cutoff: number,
): Promise<ExportRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${EXPORT_COLUMNS} FROM development_github_exports
        WHERE user_id = ?1 AND created_at < ?2`,
    )
    .bind(userId, cutoff)
    .all<ExportRow>()
  return results.map(toExport)
}

export async function deleteExpiredExports(
  db: D1Database,
  userId: string,
  cutoff: number,
): Promise<number> {
  const result = await db
    .prepare('DELETE FROM development_github_exports WHERE user_id = ?1 AND created_at < ?2')
    .bind(userId, cutoff)
    .run()
  return result.meta.changes ?? 0
}
