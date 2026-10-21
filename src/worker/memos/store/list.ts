import {
  MEMO_FILTER_SCAN_LIMIT,
  MEMO_MAX_PAGE_SIZE,
  MEMO_PAGE_SIZE,
} from '@shared/memos/constants'
import { compileMemoFilter, type MemoFilterRecord } from '@shared/memos/filter'
import type {
  MemoListResponse,
  MemoOrderDirection,
  MemoOrderField,
  MemoState,
  MemoVisibility,
} from '@shared/memos/types'
import { utf8ByteLength } from '@shared/text-utils'
import { fromBase64, fromUtf8, toBase64, utf8 } from '../../lib/encoding'
import { ApiError } from '../../lib/errors'
import { MEMO_COLUMNS, hydrateMemos, type MemoRow } from './hydrate'

const TAG_SEPARATOR = '\u001f'

const TAGS_PROJECTION = `(SELECT GROUP_CONCAT(t.tag, char(31))
  FROM memos_tags t WHERE t.memo_id = i.id) AS tags_text`

interface MemoFilterRow extends MemoRow {
  tags_text: string | null
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

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function normalizeLimit(value: number | undefined, fallback: number): number {
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

function resolveTimeZone(value: string | undefined): string {
  if (!value) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return value
  } catch {
    return 'UTC'
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

async function listFiltered(
  db: D1Database,
  userId: string,
  options: {
    where: string
    params: unknown[]
    filter: string
    orderBySql: string
    offset: number
    limit: number
    tz: string | undefined
  },
): Promise<MemoListResponse> {
  const compiled = compileMemoFilter(options.filter)
  if (!compiled.ok) {
    throw ApiError.badRequest(
      `Invalid filter: ${compiled.error.message} (position ${compiled.error.position})`,
    )
  }
  const { results } = await db
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
    viewerId: userId,
    now: nowSeconds(),
    timeZone: resolveTimeZone(options.tz),
  }
  const matched = results.filter((row) => compiled.filter.matches(toFilterRecord(row), context))
  const rows = matched.slice(options.offset, options.offset + options.limit)
  return {
    items: await hydrateMemos(db, userId, rows),
    nextCursor: options.offset + rows.length < matched.length
      ? encodeMemoCursor(options.offset + rows.length)
      : null,
  }
}

export async function listMemos(
  db: D1Database,
  userId: string,
  options: MemoListOptions,
): Promise<MemoListResponse> {
  const state = options.state ?? 'normal'
  const direction = options.order === 'asc' ? 'ASC' : 'DESC'
  const orderColumn = (options.orderBy ?? 'created') === 'updated' ? 'i.updated_at' : 'i.created_at'
  const pinnedOrder = state === 'archived' || options.parentId !== undefined ? '' : 'i.pinned DESC, '
  const orderBySql = `${pinnedOrder}${orderColumn} ${direction}, i.id ${direction}`
  const offset = decodeMemoCursor(options.cursor)
  const limit = normalizeLimit(options.limit, MEMO_PAGE_SIZE)

  const where = ['i.user_id = ?1', 'i.state = ?2']
  const params: unknown[] = [userId, state]
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
    return listFiltered(db, userId, {
      where: where.join(' AND '),
      params,
      filter,
      orderBySql,
      offset,
      limit,
      tz: options.tz,
    })
  }

  const { results } = await db
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
    items: await hydrateMemos(db, userId, rows),
    nextCursor: results.length > limit ? encodeMemoCursor(offset + rows.length) : null,
  }
}
