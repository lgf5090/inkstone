import { MEMO_PUBLIC_PAGE_SIZE } from '@shared/memos/constants'
import type { Memo, MemoListResponse } from '@shared/memos/types'
import type { PublicUser } from '@shared/types'
import { fromBase64, fromUtf8, toBase64, utf8 } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { publicUser } from '../lib/session-info'
import { USER_COLUMNS, rowToUser } from '../middleware/auth'
import { isProtectedReadable, isPubliclyReadable } from './access'
import { findShareByToken } from './shares'
import {
  BATCH_ID_CHUNK,
  MEMO_COLUMNS,
  chunkValues,
  hydrateMemos,
  loadMemoRow,
  type MemoRow,
} from './store/hydrate'
import { normalizeLimit } from './store/list'

export const MEMO_PUBLIC_MAX_PAGE_SIZE = 50

export interface MemoPublicListOptions {
  username?: string
  cursor?: string | null
  limit?: number
  tz?: string
}

type CreatorRow = Parameters<typeof rowToUser>[0]

/** Drop the real account id, role and sign-up time from the public creator. */
function publicCreator(creator: PublicUser): PublicUser {
  return {
    id: '',
    login: creator.username,
    name: creator.name,
    avatarUrl: creator.avatarUrl,
    role: 'member',
    createdAt: 0,
    username: creator.username,
  }
}

function emptyProperties() {
  return {
    hasLink: false,
    hasCode: false,
    hasTaskList: false,
    hasIncompleteTasks: false,
    hasLocation: false,
  }
}

function encodePublicCursor(offset: number): string {
  return toBase64(utf8(JSON.stringify({ offset })))
}

function decodePublicCursor(cursor: string | null | undefined): number {
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

async function findUserIdByUsername(
  db: D1Database,
  username: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM users WHERE username = ?1')
    .bind(username)
    .first<{ id: string }>()
  return row?.id ?? null
}

async function loadCreators(
  db: D1Database,
  ids: readonly string[],
): Promise<Map<string, PublicUser>> {
  const creators = new Map<string, PublicUser>()
  for (const chunk of chunkValues(ids, BATCH_ID_CHUNK)) {
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ')
    const { results } = await db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<CreatorRow>()
    for (const row of results) creators.set(row.id, publicUser(rowToUser(row)))
  }
  return creators
}

/** Build the public shape explicitly so fields added to `Memo` do not leak by default. */
async function hydratePublicMemos(
  db: D1Database,
  rows: readonly MemoRow[],
): Promise<Memo[]> {
  if (!rows.length) return []
  const groups = new Map<string, MemoRow[]>()
  for (const row of rows) {
    const group = groups.get(row.user_id)
    if (group) group.push(row)
    else groups.set(row.user_id, [row])
  }
  const entries = [...groups.entries()]
  const hydrated = new Map<string, Memo>()
  for (const [ownerId, group] of entries) {
    for (const memo of await hydrateMemos(db, ownerId, group)) hydrated.set(memo.id, memo)
  }
  const creators = await loadCreators(db, entries.map(([ownerId]) => ownerId))
  const items: Memo[] = []
  for (const row of rows) {
    const memo = hydrated.get(row.id)
    if (!memo) continue
    const creator = creators.get(row.user_id)
    items.push({
      id: memo.id,
      content: memo.content,
      title: memo.title,
      snippet: memo.snippet,
      tags: memo.tags,
      visibility: memo.visibility,
      state: memo.state,
      pinned: memo.pinned,
      spaceId: null,
      parentId: null,
      location: null,
      properties: emptyProperties(),
      attachments: memo.attachments,
      reactions: [],
      relations: [],
      commentCount: memo.commentCount,
      rev: 0,
      createdAt: memo.createdAt,
      updatedAt: memo.updatedAt,
      ...(creator ? { creator: publicCreator(creator) } : {}),
    })
  }
  return items
}

function visibilityWhere(viewerId: string | null): string {
  return viewerId
    ? `i.visibility IN ('public', 'protected')`
    : `i.visibility = 'public'`
}

export function listPublicMemos(
  db: D1Database,
  viewerId: string | null,
  options: MemoPublicListOptions & { username: string },
): Promise<MemoListResponse | null>
export function listPublicMemos(
  db: D1Database,
  viewerId: string | null,
  options?: Omit<MemoPublicListOptions, 'username'> & { username?: never },
): Promise<MemoListResponse>
export async function listPublicMemos(
  db: D1Database,
  viewerId: string | null,
  options: MemoPublicListOptions = {},
): Promise<MemoListResponse | null> {
  const where = [`i.state = 'normal'`, 'i.parent_id IS NULL', visibilityWhere(viewerId)]
  const params: unknown[] = []
  if (options.username !== undefined) {
    const ownerId = await findUserIdByUsername(db, options.username)
    if (!ownerId) return null
    params.push(ownerId)
    where.push(`i.user_id = ?${params.length}`)
  }
  const offset = decodePublicCursor(options.cursor)
  const limit = Math.min(
    MEMO_PUBLIC_MAX_PAGE_SIZE,
    normalizeLimit(options.limit, MEMO_PUBLIC_PAGE_SIZE),
  )
  const { results } = await db
    .prepare(
      `SELECT ${MEMO_COLUMNS}
         FROM memos_items i
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
    )
    .bind(...params, limit + 1, offset)
    .all<MemoRow>()
  const rows = results.slice(0, limit)
  return {
    items: await hydratePublicMemos(db, rows),
    nextCursor: results.length > limit ? encodePublicCursor(offset + rows.length) : null,
  }
}

export async function getPublicMemo(
  db: D1Database,
  viewerId: string | null,
  username: string,
  id: string,
): Promise<Memo | null> {
  if (!isValidId(id)) return null
  const ownerId = await findUserIdByUsername(db, username)
  if (!ownerId) return null
  const row = await loadMemoRow(db, ownerId, id)
  if (!row || row.parent_id !== null) return null
  if (
    !isPubliclyReadable(row.visibility, row.state)
    && !isProtectedReadable(viewerId, row.visibility, row.state)
  ) {
    return null
  }
  const [memo] = await hydratePublicMemos(db, [row])
  return memo ?? null
}

export async function getSharedMemo(
  db: D1Database,
  token: unknown,
): Promise<Memo | null> {
  const share = await findShareByToken(db, token)
  if (!share) return null
  const row = await loadMemoRow(db, share.user_id, share.memo_id)
  if (!row) return null
  const [memo] = await hydratePublicMemos(db, [row])
  if (!memo) return null
  return {
    ...memo,
    parentId: null,
    commentCount: 0,
    reactions: [],
    relations: [],
  }
}
