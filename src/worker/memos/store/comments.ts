import { MEMO_COMMENT_PAGE_SIZE } from '@shared/memos/constants'
import type { MemoListResponse } from '@shared/memos/types'
import { loadMemoRow } from './hydrate'
import { listMemos, normalizeLimit } from './list'

export interface MemoCommentFields {
  content?: unknown
  attachmentIds?: unknown
  createdAt?: unknown
}

export async function listMemoComments(
  db: D1Database,
  userId: string,
  parentId: string,
  options: { cursor?: string | null; limit?: number; tz?: string } = {},
): Promise<MemoListResponse | null> {
  if (!(await loadMemoRow(db, userId, parentId))) return null
  return listMemos(db, userId, {
    state: 'normal',
    parentId,
    orderBy: 'created',
    order: 'asc',
    cursor: options.cursor,
    limit: normalizeLimit(options.limit, MEMO_COMMENT_PAGE_SIZE),
    tz: options.tz,
  })
}
