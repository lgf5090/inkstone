import {
  MEMO_COMMENT_PAGE_SIZE,
  MEMO_CONTENT_MAX_BYTES,
  MEMO_DEFAULT_VISIBILITY,
  MEMO_FILTER_SCAN_LIMIT,
  MEMO_MAX_PAGE_SIZE,
  MEMO_PAGE_SIZE,
} from '@shared/memos/constants'
import { compileMemoFilter, type MemoFilterRecord } from '@shared/memos/filter'
import {
  MEMO_STATES,
  MEMO_VISIBILITIES,
  type Memo,
  type MemoAttachment,
  type MemoListResponse,
  type MemoLocation,
  type MemoOrderDirection,
  type MemoOrderField,
  type MemoReactionSummary,
  type MemoRelation,
  type MemoState,
  type MemoVisibility,
} from '@shared/memos/types'
import { utf8ByteLength } from '@shared/text-utils'
import { fromBase64, fromUtf8, toBase64, utf8 } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import type { AttachmentObjectStorage } from '../attachments/keys'
import { toMemoAttachmentView, type MemoAttachmentRow } from './attachments'
import { deriveMemoFields } from './derive'
import { spaceBelongsToUser } from './spaces'

const BATCH_ID_CHUNK = 90
const MAX_MEMO_ID_ATTEMPTS = 5
const TAG_SEPARATOR = '\u001f'

const MEMO_COLUMNS = `i.id, i.user_id, i.space_id, i.parent_id, i.content, i.content_search,
  i.title, i.snippet, i.visibility, i.state, i.pinned, i.has_link, i.has_code, i.has_task_list,
  i.has_incomplete_tasks, i.has_location, i.location_placeholder, i.latitude, i.longitude, i.rev,
  i.created_at, i.updated_at`

const TAGS_PROJECTION = `(SELECT GROUP_CONCAT(t.tag, char(31))
  FROM memos_tags t WHERE t.memo_id = i.id) AS tags_text`

const ATTACHMENT_COLUMNS = `a.id, a.user_id, a.memo_id, a.filename, a.mime, a.size, a.storage,
  a.storage_key, a.width, a.height, a.thumbnail_key, a.media_metadata, a.motion_group_id,
  a.motion_role, a.created_at, a.updated_at`

export interface MemoRow {
  id: string
  user_id: string
  space_id: string | null
  parent_id: string | null
  content: string
  content_search: string
  title: string
  snippet: string
  visibility: MemoVisibility
  state: MemoState
  pinned: number
  has_link: number
  has_code: number
  has_task_list: number
  has_incomplete_tasks: number
  has_location: number
  location_placeholder: string | null
  latitude: number | null
  longitude: number | null
  rev: number
  created_at: number
  updated_at: number
}

interface MemoFilterRow extends MemoRow {
  tags_text: string | null
}

interface TagRow {
  memo_id: string
  tag: string
}

interface ReactionRow {
  memo_id: string
  type: string
  count: number
  reacted: number
}

interface RelationRow {
  memo_id: string
  related_memo_id: string
  created_at: number
  related_snippet: string | null
}

interface CommentCountRow {
  parent_id: string
  count: number
}

interface AttachmentStateRow {
  id: string
  memo_id: string | null
}

export interface MemoListOptions {
  state?: MemoState
  spaceId?: string | null
  parentId?: string
  filter?: string
  orderBy?: MemoOrderField
  order?: MemoOrderDirection
  cursor?: string | null
  limit?: number
  tz?: string
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

export interface MemoCommentFields {
  content?: unknown
  attachmentIds?: unknown
  createdAt?: unknown
}

export interface MemoRelationsFields {
  relatedMemoIds?: unknown
}

export interface MemoRelationsPair {
  outgoing: MemoRelation[]
  incoming: MemoRelation[]
}

export type MemoPatchResult =
  | { status: 'missing' }
  | { status: 'conflict'; current: Memo }
  | { status: 'updated'; memo: Memo }

export interface MemoAttachmentObjectRef {
  storage: AttachmentObjectStorage
  key: string
}

export interface MemoDeleteResult {
  attachmentObjects: MemoAttachmentObjectRef[]
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(MEMO_MAX_PAGE_SIZE, Math.max(1, Math.trunc(value)))
}

function encodeMemoCursor(offset: number): string {
  return toBase64(utf8(JSON.stringify({ offset })))
}

function decodeMemoCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(fromBase64(cursor))) as unknown
  } catch {
    throw ApiError.badRequest('Invalid cursor')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ApiError.badRequest('Invalid cursor')
  }
  const offset = (parsed as { offset?: unknown }).offset
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw ApiError.badRequest('Invalid cursor')
  }
  return offset
}

function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size))
  }
  return chunks
}

function resolveTimeZone(value: string | undefined): string {
  if (!value) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return value
  } catch {
    return 'UTC'
  }
}

function parseContent(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('content must be a string')
  if (utf8ByteLength(value) > MEMO_CONTENT_MAX_BYTES) {
    throw ApiError.tooLarge(`Memo content exceeds the ${MEMO_CONTENT_MAX_BYTES / 1_000_000} MB limit`)
  }
  return value
}

function parseVisibility(value: unknown): MemoVisibility {
  if (typeof value !== 'string' || !(MEMO_VISIBILITIES as readonly string[]).includes(value)) {
    throw ApiError.badRequest('visibility must be private, protected, or public')
  }
  return value as MemoVisibility
}

function parseState(value: unknown): MemoState {
  if (typeof value !== 'string' || !(MEMO_STATES as readonly string[]).includes(value)) {
    throw ApiError.badRequest('state must be normal or archived')
  }
  return value as MemoState
}

function parseId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidId(value)) {
    throw ApiError.badRequest(`${field} must be a memo id`)
  }
  return value
}

function parseNullableId(value: unknown, field: string): string | null {
  if (value === null) return null
  return parseId(value, field)
}

function parseIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw ApiError.badRequest(`${field} must be an array of ids`)
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !isValidId(entry)) {
      throw ApiError.badRequest(`${field} must contain memo ids`)
    }
    if (!ids.includes(entry)) ids.push(entry)
  }
  return ids
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw ApiError.badRequest(`${field} must be a Unix timestamp in seconds`)
  }
  return value
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${field} must be a boolean`)
  return value
}

function parseRev(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw ApiError.badRequest('rev must be a positive integer')
  }
  return value
}

function parseLocation(value: unknown): MemoLocation | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('location must be an object or null')
  }
  const record = value as Record<string, unknown>
  if (typeof record.placeholder !== 'string') {
    throw ApiError.badRequest('location.placeholder must be a string')
  }
  if (
    typeof record.latitude !== 'number'
    || !Number.isFinite(record.latitude)
    || record.latitude < -90
    || record.latitude > 90
  ) {
    throw ApiError.badRequest('location.latitude must be between -90 and 90')
  }
  if (
    typeof record.longitude !== 'number'
    || !Number.isFinite(record.longitude)
    || record.longitude < -180
    || record.longitude > 180
  ) {
    throw ApiError.badRequest('location.longitude must be between -180 and 180')
  }
  return {
    placeholder: record.placeholder,
    latitude: record.latitude,
    longitude: record.longitude,
  }
}

function locationOf(row: MemoRow): MemoLocation | null {
  if (
    !row.has_location
    || row.location_placeholder === null
    || row.latitude === null
    || row.longitude === null
  ) {
    return null
  }
  return {
    placeholder: row.location_placeholder,
    latitude: row.latitude,
    longitude: row.longitude,
  }
}

function sameLocation(left: MemoLocation | null, right: MemoLocation | null): boolean {
  if (left === null || right === null) return left === right
  return left.placeholder === right.placeholder
    && left.latitude === right.latitude
    && left.longitude === right.longitude
}

function toMemoAttachment(row: MemoAttachmentRow): MemoAttachment {
  const view = toMemoAttachmentView(row)
  return {
    id: view.id,
    filename: view.filename,
    mime: view.mime,
    size: view.size,
    width: view.width,
    height: view.height,
    url: view.url,
    thumbnailUrl: view.thumbnailUrl,
    motion: view.motion,
    mediaMetadata: view.mediaMetadata,
    createdAt: view.createdAt,
  }
}

function toFilterRecord(row: MemoFilterRow): MemoFilterRecord {
  return {
    id: row.id,
    creatorId: row.user_id,
    content: row.content,
    tags: row.tags_text ? row.tags_text.split(TAG_SEPARATOR).filter(Boolean) : [],
    visibility: row.visibility.toUpperCase() as MemoVisibility,
    pinned: Boolean(row.pinned),
    spaceId: row.space_id,
    size: utf8ByteLength(row.content),
    hasLink: Boolean(row.has_link),
    hasCode: Boolean(row.has_code),
    hasTaskList: Boolean(row.has_task_list),
    hasIncompleteTasks: Boolean(row.has_incomplete_tasks),
    hasLocation: Boolean(row.has_location),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class MemosStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  async list(options: MemoListOptions): Promise<MemoListResponse> {
    const state = options.state ?? 'normal'
    const direction = options.order === 'asc' ? 'ASC' : 'DESC'
    const orderColumn = (options.orderBy ?? 'created') === 'updated' ? 'i.updated_at' : 'i.created_at'
    const pinnedOrder = state === 'archived' || options.parentId !== undefined ? '' : 'i.pinned DESC, '
    const orderBySql = `${pinnedOrder}${orderColumn} ${direction}, i.id ${direction}`
    const offset = decodeMemoCursor(options.cursor)
    const limit = normalizeLimit(options.limit, MEMO_PAGE_SIZE)

    const where = ['i.user_id = ?1', 'i.state = ?2']
    const params: unknown[] = [this.userId, state]
    if (options.spaceId === null) {
      where.push('i.space_id IS NULL')
    } else if (options.spaceId !== undefined) {
      params.push(options.spaceId)
      where.push(`i.space_id = ?${params.length}`)
    }
    if (options.parentId === undefined) {
      where.push('i.parent_id IS NULL')
    } else {
      params.push(options.parentId)
      where.push(`i.parent_id = ?${params.length}`)
    }

    const filter = options.filter?.trim()
    if (filter) {
      return this.listFiltered({
        where: where.join(' AND '),
        params,
        filter,
        orderBySql,
        offset,
        limit,
        tz: options.tz,
      })
    }

    const { results } = await this.db
      .prepare(
        `SELECT ${MEMO_COLUMNS}
           FROM memos_items i
          WHERE ${where.join(' AND ')}
          ORDER BY ${orderBySql}
          LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
      )
      .bind(...params, limit + 1, offset)
      .all<MemoRow>()

    const rows = results.slice(0, limit)
    return {
      items: await this.hydrate(rows),
      nextCursor: results.length > limit ? encodeMemoCursor(offset + rows.length) : null,
    }
  }

  async get(id: string): Promise<Memo | null> {
    const row = await this.loadRow(id)
    if (!row) return null
    const [memo] = await this.hydrate([row])
    return memo ?? null
  }

  async listComments(
    parentId: string,
    options: { cursor?: string | null; limit?: number; tz?: string } = {},
  ): Promise<MemoListResponse | null> {
    if (!(await this.loadRow(parentId))) return null
    return this.list({
      state: 'normal',
      parentId,
      orderBy: 'created',
      order: 'asc',
      cursor: options.cursor,
      limit: normalizeLimit(options.limit, MEMO_COMMENT_PAGE_SIZE),
      tz: options.tz,
    })
  }

  async create(fields: MemoCreateFields): Promise<Memo> {
    const parent = await this.loadParent(fields.parentId)
    const content = parseContent(fields.content)
    const visibility = fields.visibility === undefined
      ? parent?.visibility ?? MEMO_DEFAULT_VISIBILITY
      : parseVisibility(fields.visibility)
    const spaceId = fields.spaceId === undefined
      ? parent?.space_id ?? null
      : parseNullableId(fields.spaceId, 'spaceId')
    if (spaceId) await this.assertSpace(spaceId)

    let id: string
    if (fields.id === undefined) {
      id = await this.allocateMemoId()
    } else {
      id = parseId(fields.id, 'id')
      if (await this.memoIdExists(id)) throw ApiError.conflict('This memo id is already in use')
    }

    const location = parseLocation(fields.location)
    const derived = deriveMemoFields(content, location !== null)
    const explicitAttachments = fields.attachmentIds === undefined
      ? []
      : parseIdList(fields.attachmentIds, 'attachmentIds')
    const attachmentIds = [...new Set([...explicitAttachments, ...derived.attachmentIds])]
    await this.assertAttachmentsBindable(attachmentIds, id)
    const relatedMemoIds = await this.relatedIdsForCreate(fields.relatedMemoIds, id)

    const createdAt = fields.createdAt === undefined
      ? nowSeconds()
      : parseTimestamp(fields.createdAt, 'createdAt')
    const updatedAt = fields.updatedAt === undefined
      ? createdAt
      : parseTimestamp(fields.updatedAt, 'updatedAt')
    const changeAt = nowSeconds()

    const statements: D1PreparedStatement[] = [
      this.db
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
          this.userId,
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
        this.db
          .prepare('INSERT OR IGNORE INTO memos_tags (memo_id, tag) VALUES (?1, ?2)')
          .bind(id, tag),
      ),
      ...relatedMemoIds.map((relatedMemoId) =>
        this.db
          .prepare(
            'INSERT OR IGNORE INTO memos_relations (memo_id, related_memo_id, created_at) VALUES (?1, ?2, ?3)',
          )
          .bind(id, relatedMemoId, changeAt),
      ),
      ...attachmentIds.map((attachmentId) =>
        this.db
          .prepare(
            `UPDATE memos_attachments
                SET memo_id = ?1, updated_at = ?2
              WHERE id = ?3 AND user_id = ?4 AND (memo_id IS NULL OR memo_id = ?1)`,
          )
          .bind(id, changeAt, attachmentId, this.userId),
      ),
      this.db
        .prepare('INSERT INTO memos_changes (user_id, kind, memo_id, at) VALUES (?1, ?2, ?3, ?4)')
        .bind(this.userId, parent ? 'comment' : 'memo', id, changeAt),
    ]

    await this.db.batch(statements)
    return this.readBack(id)
  }

  async patch(id: string, fields: MemoPatchFields): Promise<MemoPatchResult> {
    const current = await this.loadRow(id)
    if (!current) return { status: 'missing' }
    const rev = parseRev(fields.rev)
    if (rev !== current.rev) {
      const memo = await this.get(id)
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
      if (spaceId && spaceId !== current.space_id) await this.assertSpace(spaceId)
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
    if (attachmentIdsToBind.length) await this.assertAttachmentsBindable(attachmentIdsToBind, id)
    const relatedMemoIds = fields.relatedMemoIds === undefined
      ? null
      : await this.resolveRelatedMemoIds(fields.relatedMemoIds, id)

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

    const guardValues: unknown[] = [id, this.userId, nextRev, content, updatedAt]
    const guard = (start: number): string =>
      `EXISTS (SELECT 1 FROM memos_items
        WHERE id = ?${start} AND user_id = ?${start + 1} AND rev = ?${start + 2}
          AND content = ?${start + 3} AND updated_at = ?${start + 4})`

    const statements: D1PreparedStatement[] = [
      this.db
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
          this.userId,
          current.rev,
        ),
    ]

    if (derived) {
      statements.push(
        this.db
          .prepare(`DELETE FROM memos_tags WHERE memo_id = ?1 AND ${guard(2)}`)
          .bind(id, ...guardValues),
        ...derived.tags.map((tag) =>
          this.db
            .prepare(`INSERT OR IGNORE INTO memos_tags (memo_id, tag) SELECT ?1, ?2 WHERE ${guard(3)}`)
            .bind(id, tag, ...guardValues),
        ),
      )
    }

    if (relatedMemoIds !== null) {
      statements.push(
        this.db
          .prepare(`DELETE FROM memos_relations WHERE memo_id = ?1 AND ${guard(2)}`)
          .bind(id, ...guardValues),
        ...relatedMemoIds.map((relatedMemoId) =>
          this.db
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
          this.db
            .prepare(
              `UPDATE memos_attachments
                  SET memo_id = NULL, updated_at = ?1
                WHERE user_id = ?2 AND memo_id = ?3 AND ${guard(4)}`,
            )
            .bind(changeAt, this.userId, id, ...guardValues),
        )
      } else {
        const placeholders = attachmentTargetIds.map((_, index) => `?${index + 4}`).join(', ')
        statements.push(
          this.db
            .prepare(
              `UPDATE memos_attachments
                  SET memo_id = NULL, updated_at = ?1
                WHERE user_id = ?2 AND memo_id = ?3
                  AND id NOT IN (${placeholders}) AND ${guard(4 + attachmentTargetIds.length)}`,
            )
            .bind(changeAt, this.userId, id, ...attachmentTargetIds, ...guardValues),
        )
      }
    }

    for (const attachmentId of attachmentIdsToBind) {
      statements.push(
        this.db
          .prepare(
            `UPDATE memos_attachments
                SET memo_id = ?1, updated_at = ?2
              WHERE user_id = ?3 AND id = ?4
                AND (memo_id IS NULL OR memo_id = ?1) AND ${guard(5)}`,
          )
          .bind(id, changeAt, this.userId, attachmentId, ...guardValues),
      )
    }

    statements.push(
      this.db
        .prepare(
          `INSERT INTO memos_changes (user_id, kind, memo_id, at)
           SELECT ?1, ?2, ?3, ?4 WHERE ${guard(5)}`,
        )
        .bind(this.userId, current.parent_id ? 'comment' : 'memo', id, changeAt, ...guardValues),
    )

    const results = await this.db.batch(statements)
    if (!results[0]?.meta.changes) {
      const latest = await this.get(id)
      return latest ? { status: 'conflict', current: latest } : { status: 'missing' }
    }
    return { status: 'updated', memo: await this.readBack(id) }
  }

  async restore(id: string): Promise<Memo | null> {
    const current = await this.loadRow(id)
    if (!current) return null
    const updatedAt = Math.max(nowSeconds(), current.updated_at + 1)
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE memos_items
              SET state = 'normal', rev = rev + 1, updated_at = ?3
            WHERE id = ?1 AND user_id = ?2`,
        )
        .bind(id, this.userId, updatedAt),
      this.db
        .prepare('INSERT INTO memos_changes (user_id, kind, memo_id, at) VALUES (?1, ?2, ?3, ?4)')
        .bind(this.userId, current.parent_id ? 'comment' : 'memo', id, nowSeconds()),
    ])
    return this.get(id)
  }

  async delete(id: string): Promise<MemoDeleteResult | null> {
    const current = await this.loadRow(id)
    if (!current) return null

    const scope = `(SELECT id FROM memos_items WHERE user_id = ?1 AND (id = ?2 OR parent_id = ?2))`
    const { results: attachmentRows } = await this.db
      .prepare(
        `SELECT a.storage, a.storage_key, a.thumbnail_key
           FROM memos_attachments a
          WHERE a.user_id = ?1 AND a.memo_id IN ${scope}`,
      )
      .bind(this.userId, id)
      .all<{ storage: AttachmentObjectStorage; storage_key: string; thumbnail_key: string | null }>()

    const results = await this.db.batch([
      this.db
        .prepare(`DELETE FROM memos_attachments WHERE user_id = ?1 AND memo_id IN ${scope}`)
        .bind(this.userId, id),
      this.db
        .prepare(
          `DELETE FROM memos_relations
            WHERE memo_id IN ${scope} OR related_memo_id IN (SELECT id FROM memos_items
              WHERE user_id = ?3 AND (id = ?4 OR parent_id = ?4))`,
        )
        .bind(this.userId, id, this.userId, id),
      this.db.prepare(`DELETE FROM memos_reactions WHERE memo_id IN ${scope}`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM memos_shares WHERE memo_id IN ${scope}`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM memos_tags WHERE memo_id IN ${scope}`).bind(this.userId, id),
      this.db
        .prepare(
          `INSERT INTO memos_changes (user_id, kind, memo_id, at)
           SELECT ?1, ?3, ?2, ?4
            WHERE EXISTS (SELECT 1 FROM memos_items WHERE id = ?2 AND user_id = ?1)`,
        )
        .bind(this.userId, id, current.parent_id ? 'comment' : 'memo', nowSeconds()),
      this.db
        .prepare(`DELETE FROM memos_items WHERE user_id = ?1 AND (id = ?2 OR parent_id = ?2)`)
        .bind(this.userId, id),
    ])

    if (!results[6]?.meta.changes) return null

    const attachmentObjects: MemoAttachmentObjectRef[] = []
    for (const row of attachmentRows) {
      attachmentObjects.push({ storage: row.storage, key: row.storage_key })
      if (row.thumbnail_key) attachmentObjects.push({ storage: row.storage, key: row.thumbnail_key })
    }
    return { attachmentObjects }
  }

  async relations(id: string): Promise<MemoRelationsPair | null> {
    if (!(await this.loadRow(id))) return null
    return this.loadRelations(id)
  }

  async replaceRelations(id: string, fields: MemoRelationsFields): Promise<MemoRelationsPair | null> {
    if (!(await this.loadRow(id))) return null
    if (fields.relatedMemoIds === undefined) {
      throw ApiError.badRequest('relatedMemoIds is required')
    }
    const relatedMemoIds = await this.resolveRelatedMemoIds(fields.relatedMemoIds, id)
    const now = nowSeconds()
    await this.db.batch([
      this.db.prepare('DELETE FROM memos_relations WHERE memo_id = ?1').bind(id),
      ...relatedMemoIds.map((relatedMemoId) =>
        this.db
          .prepare(
            'INSERT OR IGNORE INTO memos_relations (memo_id, related_memo_id, created_at) VALUES (?1, ?2, ?3)',
          )
          .bind(id, relatedMemoId, now),
      ),
      this.db
        .prepare('INSERT INTO memos_changes (user_id, kind, memo_id, at) VALUES (?1, ?2, ?3, ?4)')
        .bind(this.userId, 'memo', id, now),
    ])
    return this.loadRelations(id)
  }

  private async listFiltered(options: {
    where: string
    params: unknown[]
    filter: string
    orderBySql: string
    offset: number
    limit: number
    tz: string | undefined
  }): Promise<MemoListResponse> {
    const compiled = compileMemoFilter(options.filter)
    if (!compiled.ok) {
      throw ApiError.badRequest(
        `Invalid filter: ${compiled.error.message} (position ${compiled.error.position})`,
      )
    }
    const { results } = await this.db
      .prepare(
        `SELECT ${MEMO_COLUMNS}, ${TAGS_PROJECTION}
           FROM memos_items i
          WHERE ${options.where}
          ORDER BY ${options.orderBySql}
          LIMIT ?${options.params.length + 1}`,
      )
      .bind(...options.params, MEMO_FILTER_SCAN_LIMIT + 1)
      .all<MemoFilterRow>()

    if (results.length > MEMO_FILTER_SCAN_LIMIT) {
      throw ApiError.badRequest(
        'The filter is too large to evaluate; add a tag, date, or text condition',
      )
    }

    const context = {
      viewerId: this.userId,
      now: nowSeconds(),
      timeZone: resolveTimeZone(options.tz),
    }
    const matched = results.filter((row) => compiled.filter.matches(toFilterRecord(row), context))
    const rows = matched.slice(options.offset, options.offset + options.limit)
    return {
      items: await this.hydrate(rows),
      nextCursor: options.offset + rows.length < matched.length
        ? encodeMemoCursor(options.offset + rows.length)
        : null,
    }
  }

  private async hydrate(rows: readonly MemoRow[]): Promise<Memo[]> {
    if (!rows.length) return []
    const chunks = chunkValues(rows.map((row) => row.id), BATCH_ID_CHUNK)
    const statements: D1PreparedStatement[] = []
    for (const chunk of chunks) {
      const tagPlaceholders = chunk.map((_, index) => `?${index + 1}`).join(', ')
      const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
      statements.push(
        this.db
          .prepare(
            `SELECT memo_id, tag FROM memos_tags
              WHERE memo_id IN (${tagPlaceholders}) ORDER BY memo_id ASC, tag ASC`,
          )
          .bind(...chunk),
        this.db
          .prepare(
            `SELECT ${ATTACHMENT_COLUMNS} FROM memos_attachments a
              WHERE a.user_id = ?1 AND a.memo_id IN (${placeholders})
              ORDER BY a.created_at ASC, a.id ASC`,
          )
          .bind(this.userId, ...chunk),
        this.db
          .prepare(
            `SELECT memo_id, type, COUNT(*) AS count,
                    MAX(CASE WHEN user_id = ?1 THEN 1 ELSE 0 END) AS reacted
               FROM memos_reactions
              WHERE memo_id IN (${placeholders})
              GROUP BY memo_id, type
              ORDER BY memo_id ASC, type ASC`,
          )
          .bind(this.userId, ...chunk),
        this.db
          .prepare(
            `SELECT r.memo_id, r.related_memo_id, r.created_at, m.snippet AS related_snippet
               FROM memos_relations r
               JOIN memos_items m ON m.id = r.related_memo_id AND m.user_id = ?1
              WHERE r.memo_id IN (${placeholders})
              ORDER BY r.memo_id ASC, r.created_at ASC, r.related_memo_id ASC`,
          )
          .bind(this.userId, ...chunk),
        this.db
          .prepare(
            `SELECT parent_id, COUNT(*) AS count FROM memos_items
              WHERE user_id = ?1 AND state = 'normal' AND parent_id IN (${placeholders})
              GROUP BY parent_id`,
          )
          .bind(this.userId, ...chunk),
      )
    }

    const results = await this.db.batch(statements)
    const tagRows: TagRow[] = []
    const attachmentRows: MemoAttachmentRow[] = []
    const reactionRows: ReactionRow[] = []
    const relationRows: RelationRow[] = []
    const commentCountRows: CommentCountRow[] = []
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const base = chunkIndex * 5
      tagRows.push(...((results[base]?.results as TagRow[] | undefined) ?? []))
      attachmentRows.push(...((results[base + 1]?.results as MemoAttachmentRow[] | undefined) ?? []))
      reactionRows.push(...((results[base + 2]?.results as ReactionRow[] | undefined) ?? []))
      relationRows.push(...((results[base + 3]?.results as RelationRow[] | undefined) ?? []))
      commentCountRows.push(...((results[base + 4]?.results as CommentCountRow[] | undefined) ?? []))
    }

    const tags = new Map<string, string[]>()
    for (const row of tagRows) {
      const list = tags.get(row.memo_id)
      if (list) list.push(row.tag)
      else tags.set(row.memo_id, [row.tag])
    }
    const attachments = new Map<string, MemoAttachment[]>()
    for (const row of attachmentRows) {
      const memoId = row.memo_id
      if (!memoId) continue
      const list = attachments.get(memoId)
      if (list) list.push(toMemoAttachment(row))
      else attachments.set(memoId, [toMemoAttachment(row)])
    }
    const reactions = new Map<string, MemoReactionSummary[]>()
    for (const row of reactionRows) {
      const list = reactions.get(row.memo_id)
      const summary: MemoReactionSummary = {
        type: row.type,
        count: Number(row.count),
        reacted: Boolean(row.reacted),
      }
      if (list) list.push(summary)
      else reactions.set(row.memo_id, [summary])
    }
    const relations = new Map<string, MemoRelation[]>()
    for (const row of relationRows) {
      const list = relations.get(row.memo_id)
      const relation: MemoRelation = {
        memoId: row.memo_id,
        relatedMemoId: row.related_memo_id,
        relatedSnippet: row.related_snippet ?? '',
        createdAt: row.created_at,
      }
      if (list) list.push(relation)
      else relations.set(row.memo_id, [relation])
    }
    const commentCounts = new Map<string, number>()
    for (const row of commentCountRows) commentCounts.set(row.parent_id, Number(row.count))

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      title: row.title,
      snippet: row.snippet,
      tags: tags.get(row.id) ?? [],
      visibility: row.visibility,
      state: row.state,
      pinned: Boolean(row.pinned),
      spaceId: row.space_id,
      parentId: row.parent_id,
      location: locationOf(row),
      properties: {
        hasLink: Boolean(row.has_link),
        hasCode: Boolean(row.has_code),
        hasTaskList: Boolean(row.has_task_list),
        hasIncompleteTasks: Boolean(row.has_incomplete_tasks),
        hasLocation: Boolean(row.has_location),
      },
      attachments: attachments.get(row.id) ?? [],
      reactions: reactions.get(row.id) ?? [],
      relations: relations.get(row.id) ?? [],
      commentCount: commentCounts.get(row.id) ?? 0,
      rev: row.rev,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  private async loadRow(id: string): Promise<MemoRow | null> {
    return this.db
      .prepare(`SELECT ${MEMO_COLUMNS} FROM memos_items i WHERE i.id = ?1 AND i.user_id = ?2`)
      .bind(id, this.userId)
      .first<MemoRow>()
  }

  private async readBack(id: string): Promise<Memo> {
    const memo = await this.get(id)
    if (!memo) throw new Error(`memo ${id} could not be read after writing it`)
    return memo
  }

  private async loadParent(value: unknown): Promise<MemoRow | null> {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string' || !isValidId(value)) {
      throw ApiError.badRequest('parentId must be a memo id')
    }
    const parent = await this.loadRow(value)
    if (!parent) throw ApiError.notFound('Parent memo not found')
    if (parent.parent_id) throw ApiError.badRequest('Replies are one level deep')
    if (parent.state !== 'normal') throw ApiError.badRequest('Archived memos cannot receive comments')
    return parent
  }

  private async assertSpace(spaceId: string): Promise<void> {
    if (!(await spaceBelongsToUser(this.db, this.userId, spaceId))) {
      throw ApiError.badRequest('The selected space does not exist')
    }
  }

  private async memoIdExists(id: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT id FROM memos_items WHERE id = ?1')
      .bind(id)
      .first<{ id: string }>()
    return row !== null
  }

  private async allocateMemoId(): Promise<string> {
    for (let attempt = 0; attempt < MAX_MEMO_ID_ATTEMPTS; attempt++) {
      const id = newId()
      if (!(await this.memoIdExists(id))) return id
    }
    throw ApiError.conflict('Could not allocate a memo id. Try again')
  }

  private async assertAttachmentsBindable(
    attachmentIds: readonly string[],
    memoId: string,
  ): Promise<void> {
    if (!attachmentIds.length) return
    const rows: AttachmentStateRow[] = []
    for (const chunk of chunkValues(attachmentIds, BATCH_ID_CHUNK)) {
      const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT id, memo_id FROM memos_attachments
            WHERE user_id = ?1 AND id IN (${placeholders})`,
        )
        .bind(this.userId, ...chunk)
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

  private async relatedIdsForCreate(value: unknown, memoId: string): Promise<string[]> {
    if (value === undefined || value === null) return []
    return this.resolveRelatedMemoIds(value, memoId)
  }

  private async resolveRelatedMemoIds(value: unknown, memoId: string): Promise<string[]> {
    const ids = parseIdList(value, 'relatedMemoIds').filter((id) => id !== memoId)
    if (!ids.length) return []
    const found = new Set<string>()
    for (const chunk of chunkValues(ids, BATCH_ID_CHUNK)) {
      const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
      const { results } = await this.db
        .prepare(`SELECT id FROM memos_items WHERE user_id = ?1 AND id IN (${placeholders})`)
        .bind(this.userId, ...chunk)
        .all<{ id: string }>()
      for (const row of results) found.add(row.id)
    }
    for (const id of ids) {
      if (!found.has(id)) throw ApiError.badRequest(`Related memo ${id} was not found`)
    }
    return ids
  }

  private async loadRelations(id: string): Promise<MemoRelationsPair> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `SELECT r.memo_id, r.related_memo_id, r.created_at, m.snippet AS related_snippet
             FROM memos_relations r
             JOIN memos_items m ON m.id = r.related_memo_id AND m.user_id = ?2
            WHERE r.memo_id = ?1
            ORDER BY r.created_at ASC, r.related_memo_id ASC`,
        )
        .bind(id, this.userId),
      this.db
        .prepare(
          `SELECT r.memo_id, r.related_memo_id, r.created_at, m.snippet AS related_snippet
             FROM memos_relations r
             JOIN memos_items m ON m.id = r.memo_id AND m.user_id = ?2
            WHERE r.related_memo_id = ?1
            ORDER BY r.created_at ASC, r.memo_id ASC`,
        )
        .bind(id, this.userId),
    ])
    const outgoingRows = (results[0]?.results as RelationRow[] | undefined) ?? []
    const incomingRows = (results[1]?.results as RelationRow[] | undefined) ?? []
    return {
      outgoing: outgoingRows.map((row) => ({
        memoId: row.memo_id,
        relatedMemoId: row.related_memo_id,
        relatedSnippet: row.related_snippet ?? '',
        createdAt: row.created_at,
      })),
      incoming: incomingRows.map((row) => ({
        memoId: row.memo_id,
        relatedMemoId: row.related_memo_id,
        relatedSnippet: row.related_snippet ?? '',
        createdAt: row.created_at,
      })),
    }
  }
}
