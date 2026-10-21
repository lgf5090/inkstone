import type {
  MemoReactionSummary,
  MemoReactionUser,
  MemoState,
} from '@shared/memos/types'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'

export const MEMO_REACTION_TYPE_MAX_LENGTH = 64

interface MemoStateRow {
  state: MemoState
}

interface ReactionRow {
  type: string
  user_id: string
  name: string
  avatar_url: string
}

async function loadOwnedMemo(db: D1Database, userId: string, memoId: string): Promise<MemoStateRow> {
  const row = await db
    .prepare('SELECT state FROM memos_items WHERE id = ?1 AND user_id = ?2')
    .bind(memoId, userId)
    .first<MemoStateRow>()
  if (!row) throw ApiError.notFound('Memo not found')
  return row
}

function normalizeReactionType(value: unknown): string {
  if (value === undefined || value === null) throw ApiError.badRequest('Reaction type is required')
  if (typeof value !== 'string') throw ApiError.badRequest('Reaction type must be a string')
  const type = value.trim()
  if (!type) throw ApiError.badRequest('Reaction type cannot be empty')
  if (type.length > MEMO_REACTION_TYPE_MAX_LENGTH) {
    throw ApiError.badRequest(`Reaction type cannot exceed ${MEMO_REACTION_TYPE_MAX_LENGTH} characters`)
  }
  return type
}

async function reactionSummary(
  db: D1Database,
  userId: string,
  memoId: string,
): Promise<MemoReactionSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT r.type, r.user_id, u.name, u.avatar_url
         FROM memos_reactions r
         JOIN users u ON u.id = r.user_id
        WHERE r.memo_id = ?1 AND r.user_id = ?2
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .bind(memoId, userId)
    .all<ReactionRow>()

  const summary = new Map<string, {
    type: string
    count: number
    reacted: boolean
    users: MemoReactionUser[]
  }>()
  for (const row of results) {
    const user = { id: row.user_id, name: row.name, avatarUrl: row.avatar_url }
    const existing = summary.get(row.type)
    if (existing) {
      existing.count += 1
      existing.reacted = existing.reacted || row.user_id === userId
      existing.users.push(user)
      continue
    }
    summary.set(row.type, {
      type: row.type,
      count: 1,
      reacted: row.user_id === userId,
      users: [user],
    })
  }
  return [...summary.values()]
}

export async function listMemoReactions(
  db: D1Database,
  userId: string,
  memoId: string,
): Promise<MemoReactionSummary[]> {
  await loadOwnedMemo(db, userId, memoId)
  return reactionSummary(db, userId, memoId)
}

export async function upsertMemoReaction(
  db: D1Database,
  userId: string,
  memoId: string,
  value: unknown,
): Promise<MemoReactionSummary[]> {
  const type = normalizeReactionType(value)
  const memo = await loadOwnedMemo(db, userId, memoId)
  if (memo.state !== 'normal') throw ApiError.conflict('Archived memos cannot be reacted to')

  const now = Math.floor(Date.now() / 1000)
  await db.batch([
    db
      .prepare(
        `INSERT INTO memos_reactions (id, user_id, memo_id, type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (user_id, memo_id, type) DO NOTHING`,
      )
      .bind(newId(), userId, memoId, type, now),
    db
      .prepare(`INSERT INTO memos_changes (user_id, kind, memo_id, at) VALUES (?1, 'reaction', ?2, ?3)`)
      .bind(userId, memoId, now),
  ])
  return reactionSummary(db, userId, memoId)
}

export async function deleteMemoReaction(
  db: D1Database,
  userId: string,
  memoId: string,
  value: unknown,
): Promise<MemoReactionSummary[]> {
  const type = normalizeReactionType(value)
  const memo = await loadOwnedMemo(db, userId, memoId)
  if (memo.state !== 'normal') throw ApiError.conflict('Archived memos cannot be reacted to')

  const now = Math.floor(Date.now() / 1000)
  await db.batch([
    db
      .prepare('DELETE FROM memos_reactions WHERE memo_id = ?1 AND user_id = ?2 AND type = ?3')
      .bind(memoId, userId, type),
    db
      .prepare(`INSERT INTO memos_changes (user_id, kind, memo_id, at) VALUES (?1, 'reaction', ?2, ?3)`)
      .bind(userId, memoId, now),
  ])
  return reactionSummary(db, userId, memoId)
}
