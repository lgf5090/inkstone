import { MEMO_DEFAULT_VISIBILITY } from '@shared/memos/constants'
import type { Memo, MemoLocation } from '@shared/memos/types'
import { ApiError } from '../../lib/errors'
import { isValidId, newId } from '../../lib/id'
import { deriveMemoFields } from '../derive'
import { spaceBelongsToUser } from '../spaces'
import {
  parseBoolean,
  parseContent,
  parseId,
  parseIdList,
  parseLocation,
  parseNullableId,
  parseRev,
  parseState,
  parseTimestamp,
  parseVisibility,
} from './fields'
import {
  BATCH_ID_CHUNK,
  chunkValues,
  loadMemoRow,
  locationOf,
  readMemo,
  type MemoRow,
} from './hydrate'
import { resolveRelatedMemoIds } from './relations'

const MAX_MEMO_ID_ATTEMPTS = 5

interface AttachmentStateRow {
  id: string
  memo_id: string | null
}

export interface MemoCreateFields {
  id?: unknown
  content?: unknown
  visibility?: unknown
  spaceId?: unknown
  parentId?: unknown
  location?: unknown
  attachmentIds?: unknown
  relatedMemoIds?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

export interface MemoPatchFields {
  rev?: unknown
  content?: unknown
  visibility?: unknown
  spaceId?: unknown
  pinned?: unknown
  state?: unknown
  location?: unknown
  attachmentIds?: unknown
  relatedMemoIds?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

export type MemoPatchResult =
  | { status: 'missing' }
  | { status: 'conflict'; current: Memo }
  | { status: 'updated'; memo: Memo }

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

async function readBack(db: D1Database, userId: string, id: string): Promise<Memo> {
  const memo = await readMemo(db, userId, id)
  if (!memo) throw new Error(`memo ${id} could not be read after writing it`)
  return memo
}

export async function createMemo(
  db: D1Database,
  userId: string,
  fields: MemoCreateFields,
): Promise<Memo> {
  const parent = await loadParent(db, userId, fields.parentId)
  const content = parseContent(fields.content)
  const visibility = fields.visibility === undefined
    ? parent?.visibility ?? MEMO_DEFAULT_VISIBILITY
    : parseVisibility(fields.visibility)
  const spaceId = fields.spaceId === undefined
    ? parent?.space_id ?? null
    : parseNullableId(fields.spaceId, 'spaceId')
  if (spaceId) await assertSpace(db, userId, spaceId)

  let id: string
  if (fields.id === undefined) {
    id = await allocateMemoId(db)
  } else {
    id = parseId(fields.id, 'id')
    if (await memoIdExists(db, id)) throw ApiError.conflict('This memo id is already in use')
  }

  const location = parseLocation(fields.location)
  const derived = deriveMemoFields(content, location !== null)
  const explicitAttachments = fields.attachmentIds === undefined
    ? []
    : parseIdList(fields.attachmentIds, 'attachmentIds')
  const attachmentIds = [...new Set([...explicitAttachments, ...derived.attachmentIds])]
  await assertAttachmentsBindable(db, userId, attachmentIds, id)
  const relatedMemoIds = await relatedIdsForCreate(db, userId, fields.relatedMemoIds, id)

  const createdAt = fields.createdAt === undefined
    ? nowSeconds()
    : parseTimestamp(fields.createdAt, 'createdAt')
  const updatedAt = fields.updatedAt === undefined
    ? createdAt
    : parseTimestamp(fields.updatedAt, 'updatedAt')
  const changeAt = nowSeconds()

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO memos_items (
           id, user_id, space_id, parent_id, content, content_search, title, snippet,
           visibility, state, pinned, has_link, has_code, has_task_list, has_incomplete_tasks,
           has_location, location_placeholder, latitude, longitude, rev, created_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'normal', 0, ?10, ?11, ?12, ?13,
           ?14, ?15, ?16, ?17, 1, ?18, ?19
         )`,
      )
      .bind(
        id,
        userId,
        spaceId,
        parent?.id ?? null,
        content,
        derived.contentSearch,
        derived.title,
        derived.snippet,
        visibility,
        derived.hasLink ? 1 : 0,
        derived.hasCode ? 1 : 0,
        derived.hasTaskList ? 1 : 0,
        derived.hasIncompleteTasks ? 1 : 0,
        derived.hasLocation ? 1 : 0,
        location?.placeholder ?? null,
        location?.latitude ?? null,
        location?.longitude ?? null,
        createdAt,
        updatedAt,
      ),
    ...derived.tags.map((tag) =>
      db
        .prepare('INSERT OR IGNORE INTO memos_tags (memo_id, tag) VALUES (?1, ?2)')
        .bind(id, tag),
    ),
    ...relatedMemoIds.map((relatedMemoId) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO memos_relations (memo_id, related_memo_id, created_at) VALUES (?1, ?2, ?3)',
        )
        .bind(id, relatedMemoId, changeAt),
    ),
    ...attachmentIds.map((attachmentId) =>
      db
        .prepare(
          `UPDATE memos_attachments
              SET memo_id = ?1, updated_at = ?2
            WHERE id = ?3 AND user_id = ?4 AND (memo_id IS NULL OR memo_id = ?1)`,
        )
        .bind(id, changeAt, attachmentId, userId),
    ),
    db
      .prepare('INSERT INTO memos_changes (user_id, kind, memo_id, at) VALUES (?1, ?2, ?3, ?4)')
      .bind(userId, parent ? 'comment' : 'memo', id, changeAt),
  ]

  await db.batch(statements)
  return readBack(db, userId, id)
}

export async function patchMemo(
  db: D1Database,
  userId: string,
  id: string,
  fields: MemoPatchFields,
): Promise<MemoPatchResult> {
  const current = await loadMemoRow(db, userId, id)
  if (!current) return { status: 'missing' }
  const rev = parseRev(fields.rev)
  if (rev !== current.rev) {
    const memo = await readMemo(db, userId, id)
    return memo ? { status: 'conflict', current: memo } : { status: 'missing' }
  }

  const content = fields.content === undefined ? current.content : parseContent(fields.content)
  const contentChanged = content !== current.content
  const visibility = fields.visibility === undefined
    ? current.visibility
    : parseVisibility(fields.visibility)
  let spaceId = current.space_id
  if (fields.spaceId !== undefined) {
    spaceId = parseNullableId(fields.spaceId, 'spaceId')
    if (spaceId && spaceId !== current.space_id) await assertSpace(db, userId, spaceId)
  }
  const pinned = fields.pinned === undefined
    ? Boolean(current.pinned)
    : parseBoolean(fields.pinned, 'pinned')
  const state = fields.state === undefined ? current.state : parseState(fields.state)
  const locationProvided = fields.location !== undefined
  const location = locationProvided ? parseLocation(fields.location) : locationOf(current)
  const locationChanged = locationProvided && !sameLocation(location, locationOf(current))
  const derived = contentChanged || locationProvided
    ? deriveMemoFields(content, location !== null)
    : null

  const attachmentReplacement = fields.attachmentIds === undefined
    ? null
    : parseIdList(fields.attachmentIds, 'attachmentIds')
  const contentAttachments = contentChanged ? derived?.attachmentIds ?? [] : []
  const attachmentTargetIds = attachmentReplacement
  const attachmentIdsToBind = attachmentReplacement ?? contentAttachments
  if (attachmentIdsToBind.length) await assertAttachmentsBindable(db, userId, attachmentIdsToBind, id)
  const relatedMemoIds = fields.relatedMemoIds === undefined
    ? null
    : await resolveRelatedMemoIds(db, userId, fields.relatedMemoIds, id)

  const createdAt = fields.createdAt === undefined
    ? current.created_at
    : parseTimestamp(fields.createdAt, 'createdAt')
  const explicitUpdatedAt = fields.updatedAt === undefined
    ? null
    : parseTimestamp(fields.updatedAt, 'updatedAt')
  const shouldBump = contentChanged
    || locationChanged
    || visibility !== current.visibility
    || spaceId !== current.space_id
    || attachmentTargetIds !== null
    || relatedMemoIds !== null
    || explicitUpdatedAt !== null
  const updatedAt = explicitUpdatedAt
    ?? (shouldBump ? Math.max(nowSeconds(), current.updated_at + 1) : current.updated_at)
  const nextRev = current.rev + 1
  const changeAt = nowSeconds()

  const title = derived?.title ?? current.title
  const snippet = derived?.snippet ?? current.snippet
  const contentSearch = derived?.contentSearch ?? current.content_search
  const hasLink = derived ? derived.hasLink : Boolean(current.has_link)
  const hasCode = derived ? derived.hasCode : Boolean(current.has_code)
  const hasTaskList = derived ? derived.hasTaskList : Boolean(current.has_task_list)
  const hasIncompleteTasks = derived ? derived.hasIncompleteTasks : Boolean(current.has_incomplete_tasks)
  const hasLocation = derived ? derived.hasLocation : Boolean(current.has_location)

  const guardValues: unknown[] = [id, userId, nextRev, content, updatedAt]
  const guard = (start: number): string =>
    `EXISTS (SELECT 1 FROM memos_items
      WHERE id = ?${start} AND user_id = ?${start + 1} AND rev = ?${start + 2}
        AND content = ?${start + 3} AND updated_at = ?${start + 4})`

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE memos_items
            SET content = ?1, content_search = ?2, title = ?3, snippet = ?4, visibility = ?5,
                state = ?6, pinned = ?7, has_link = ?8, has_code = ?9, has_task_list = ?10,
                has_incomplete_tasks = ?11, has_location = ?12, location_placeholder = ?13,
                latitude = ?14, longitude = ?15, rev = ?16, created_at = ?17, updated_at = ?18,
                space_id = ?19
          WHERE id = ?20 AND user_id = ?21 AND rev = ?22`,
      )
      .bind(
        content,
        contentSearch,
        title,
        snippet,
        visibility,
        state,
        pinned ? 1 : 0,
        hasLink ? 1 : 0,
        hasCode ? 1 : 0,
        hasTaskList ? 1 : 0,
        hasIncompleteTasks ? 1 : 0,
        hasLocation ? 1 : 0,
        location?.placeholder ?? null,
        location?.latitude ?? null,
        location?.longitude ?? null,
        nextRev,
        createdAt,
        updatedAt,
        spaceId,
        id,
        userId,
        current.rev,
      ),
  ]

  if (derived) {
    statements.push(
      db
        .prepare(`DELETE FROM memos_tags WHERE memo_id = ?1 AND ${guard(2)}`)
        .bind(id, ...guardValues),
      ...derived.tags.map((tag) =>
        db
          .prepare(`INSERT OR IGNORE INTO memos_tags (memo_id, tag) SELECT ?1, ?2 WHERE ${guard(3)}`)
          .bind(id, tag, ...guardValues),
      ),
    )
  }

  if (relatedMemoIds !== null) {
    statements.push(
      db
        .prepare(`DELETE FROM memos_relations WHERE memo_id = ?1 AND ${guard(2)}`)
        .bind(id, ...guardValues),
      ...relatedMemoIds.map((relatedMemoId) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO memos_relations (memo_id, related_memo_id, created_at)
             SELECT ?1, ?2, ?3 WHERE ${guard(4)}`,
          )
          .bind(id, relatedMemoId, changeAt, ...guardValues),
      ),
    )
  }

  if (attachmentTargetIds !== null) {
    if (attachmentTargetIds.length === 0) {
      statements.push(
        db
          .prepare(
            `UPDATE memos_attachments
                SET memo_id = NULL, updated_at = ?1
              WHERE user_id = ?2 AND memo_id = ?3 AND ${guard(4)}`,
          )
          .bind(changeAt, userId, id, ...guardValues),
      )
    } else {
      const placeholders = attachmentTargetIds.map((_, index) => `?${index + 4}`).join(', ')
      statements.push(
        db
          .prepare(
            `UPDATE memos_attachments
                SET memo_id = NULL, updated_at = ?1
              WHERE user_id = ?2 AND memo_id = ?3
                AND id NOT IN (${placeholders}) AND ${guard(4 + attachmentTargetIds.length)}`,
          )
          .bind(changeAt, userId, id, ...attachmentTargetIds, ...guardValues),
      )
    }
  }

  for (const attachmentId of attachmentIdsToBind) {
    statements.push(
      db
        .prepare(
          `UPDATE memos_attachments
              SET memo_id = ?1, updated_at = ?2
            WHERE user_id = ?3 AND id = ?4
              AND (memo_id IS NULL OR memo_id = ?1) AND ${guard(5)}`,
        )
        .bind(id, changeAt, userId, attachmentId, ...guardValues),
    )
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO memos_changes (user_id, kind, memo_id, at)
         SELECT ?1, ?2, ?3, ?4 WHERE ${guard(5)}`,
      )
      .bind(userId, current.parent_id ? 'comment' : 'memo', id, changeAt, ...guardValues),
  )

  const results = await db.batch(statements)
  if (!results[0]?.meta.changes) {
    const latest = await readMemo(db, userId, id)
    return latest ? { status: 'conflict', current: latest } : { status: 'missing' }
  }
  return { status: 'updated', memo: await readBack(db, userId, id) }
}

export async function restoreMemo(
  db: D1Database,
  userId: string,
  id: string,
): Promise<Memo | null> {
  const current = await loadMemoRow(db, userId, id)
  if (!current) return null
  const updatedAt = Math.max(nowSeconds(), current.updated_at + 1)
  await db.batch([
    db
      .prepare(
        `UPDATE memos_items
            SET state = 'normal', rev = rev + 1, updated_at = ?3
          WHERE id = ?1 AND user_id = ?2`,
      )
      .bind(id, userId, updatedAt),
    db
      .prepare('INSERT INTO memos_changes (user_id, kind, memo_id, at) VALUES (?1, ?2, ?3, ?4)')
      .bind(userId, current.parent_id ? 'comment' : 'memo', id, nowSeconds()),
  ])
  return readMemo(db, userId, id)
}

function sameLocation(left: MemoLocation | null, right: MemoLocation | null): boolean {
  if (left === null || right === null) return left === right
  return left.placeholder === right.placeholder
    && left.latitude === right.latitude
    && left.longitude === right.longitude
}

async function loadParent(db: D1Database, userId: string, value: unknown): Promise<MemoRow | null> {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !isValidId(value)) {
    throw ApiError.badRequest('parentId must be a memo id')
  }
  const parent = await loadMemoRow(db, userId, value)
  if (!parent) throw ApiError.notFound('Parent memo not found')
  if (parent.parent_id) throw ApiError.badRequest('Replies are one level deep')
  if (parent.state !== 'normal') throw ApiError.badRequest('Archived memos cannot receive comments')
  return parent
}

async function assertSpace(db: D1Database, userId: string, spaceId: string): Promise<void> {
  if (!(await spaceBelongsToUser(db, userId, spaceId))) {
    throw ApiError.badRequest('The selected space does not exist')
  }
}

async function memoIdExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM memos_items WHERE id = ?1')
    .bind(id)
    .first<{ id: string }>()
  return row !== null
}

async function allocateMemoId(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < MAX_MEMO_ID_ATTEMPTS; attempt++) {
    const id = newId()
    if (!(await memoIdExists(db, id))) return id
  }
  throw ApiError.conflict('Could not allocate a memo id. Try again')
}

async function assertAttachmentsBindable(
  db: D1Database,
  userId: string,
  attachmentIds: readonly string[],
  memoId: string,
): Promise<void> {
  if (!attachmentIds.length) return
  const rows: AttachmentStateRow[] = []
  for (const chunk of chunkValues(attachmentIds, BATCH_ID_CHUNK)) {
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const { results } = await db
      .prepare(
        `SELECT id, memo_id FROM memos_attachments
          WHERE user_id = ?1 AND id IN (${placeholders})`,
      )
      .bind(userId, ...chunk)
      .all<AttachmentStateRow>()
    rows.push(...results)
  }
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const id of attachmentIds) {
    const row = byId.get(id)
    if (!row) throw ApiError.badRequest(`Attachment ${id} was not found`)
    if (row.memo_id !== null && row.memo_id !== memoId) {
      throw ApiError.badRequest(`Attachment ${id} is already used by another memo`)
    }
  }
}

async function relatedIdsForCreate(
  db: D1Database,
  userId: string,
  value: unknown,
  memoId: string,
): Promise<string[]> {
  if (value === undefined || value === null) return []
  return resolveRelatedMemoIds(db, userId, value, memoId)
}
