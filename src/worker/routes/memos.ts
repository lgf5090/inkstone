import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  MEMO_COMMENT_PAGE_SIZE,
  MEMO_MAX_PAGE_SIZE,
  MEMO_PAGE_SIZE,
} from '@shared/memos/constants'
import {
  MEMO_ORDER_FIELDS,
  MEMO_STATES,
  type Memo,
  type MemoOrderDirection,
  type MemoOrderField,
  type MemoState,
} from '@shared/memos/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, clampInt, readJson } from '../lib/request'
import { requireMemoUser } from '../memos/auth'
import { scheduleMemoObjectCleanup } from '../memos/cleanup'
import {
  MemosStore,
  type MemoCommentFields,
  type MemoCreateFields,
  type MemoListOptions,
  type MemoPatchFields,
  type MemoRelationsFields,
} from '../memos/store'
import {
  dispatchMemoWebhookEvent,
  type MemoWebhookActivityType,
} from '../memos/webhooks'

function memoStore(c: Context<AppBindings>): MemosStore {
  return new MemosStore(c.env.DB, c.get('userId'))
}

function memoId(c: Context<AppBindings>): string {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Memo not found')
  return id
}

function parseStateQuery(value: string | undefined): MemoState | undefined {
  if (value === undefined) return undefined
  if (!(MEMO_STATES as readonly string[]).includes(value)) {
    throw ApiError.badRequest('state must be normal or archived')
  }
  return value as MemoState
}

function parseOrderBy(value: string | undefined): MemoOrderField | undefined {
  if (value === undefined) return undefined
  if (!(MEMO_ORDER_FIELDS as readonly string[]).includes(value)) {
    throw ApiError.badRequest('orderBy must be created or updated')
  }
  return value as MemoOrderField
}

function parseOrder(value: string | undefined): MemoOrderDirection | undefined {
  if (value === undefined) return undefined
  if (value !== 'asc' && value !== 'desc') throw ApiError.badRequest('order must be asc or desc')
  return value
}

function parseQueryId(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  if (!isValidId(value)) throw ApiError.badRequest(`${field} must be a valid id`)
  return value
}

function listOptions(c: Context<AppBindings>): MemoListOptions {
  return {
    state: parseStateQuery(c.req.query('state')),
    spaceId: parseQueryId(c.req.query('spaceId'), 'spaceId'),
    parentId: parseQueryId(c.req.query('parentId'), 'parentId'),
    filter: c.req.query('filter') || undefined,
    orderBy: parseOrderBy(c.req.query('orderBy')),
    order: parseOrder(c.req.query('order')),
    cursor: c.req.query('cursor') || undefined,
    limit: clampInt(c.req.query('limit'), 1, MEMO_MAX_PAGE_SIZE, MEMO_PAGE_SIZE),
    tz: c.req.query('tz') || undefined,
  }
}

function scheduleMemoWebhook(
  c: Context<AppBindings>,
  activityType: MemoWebhookActivityType,
  memo: Memo,
): void {
  const delivery = dispatchMemoWebhookEvent(
    c.env,
    c.get('userId'),
    activityType,
    memo,
    new URL(c.req.url).origin,
  )
  try {
    c.executionCtx.waitUntil(delivery)
  } catch (error) {
    // The mutation is already committed; without a waitUntil the delivery runs on its own and may be cut
    // short, which is the same best-effort outcome as a receiver that does not answer.
    console.warn('[inkstone] Memo webhook dispatch has no execution context:', error)
    void delivery
  }
}

export const memoListRoutes = new Hono<AppBindings>()

memoListRoutes.use('*', requireMemoUser)

memoListRoutes.get('/', async (c) => c.json(await memoStore(c).list(listOptions(c))))

memoListRoutes.post('/', async (c) => {
  const body = await readJson<MemoCreateFields>(c, JSON_BODY_LIMITS.note)
  const memo = await memoStore(c).create(body)
  scheduleMemoWebhook(
    c,
    memo.parentId ? 'memos.memo.comment.created' : 'memos.memo.created',
    memo,
  )
  return c.json(memo, 201)
})

memoListRoutes.get('/:id', async (c) => {
  const memo = await memoStore(c).get(memoId(c))
  if (!memo) throw ApiError.notFound('Memo not found')
  return c.json(memo)
})

memoListRoutes.patch('/:id', async (c) => {
  const id = memoId(c)
  const body = await readJson<MemoPatchFields>(c, JSON_BODY_LIMITS.note)
  const result = await memoStore(c).patch(id, body)
  if (result.status === 'missing') throw ApiError.notFound('Memo not found')
  if (result.status === 'conflict') return c.json(result.current, 409)
  scheduleMemoWebhook(c, 'memos.memo.updated', result.memo)
  return c.json(result.memo)
})

memoListRoutes.delete('/:id', async (c) => {
  const id = memoId(c)
  const memo = await memoStore(c).get(id)
  const result = await memoStore(c).delete(id)
  if (!result) throw ApiError.notFound('Memo not found')
  if (result.attachmentObjects.length) {
    scheduleMemoObjectCleanup(c, result.attachmentObjects)
  }
  if (memo) scheduleMemoWebhook(c, 'memos.memo.deleted', memo)
  return c.json({ ok: true })
})

memoListRoutes.post('/:id/restore', async (c) => {
  const memo = await memoStore(c).restore(memoId(c))
  if (!memo) throw ApiError.notFound('Memo not found')
  return c.json(memo)
})

memoListRoutes.get('/:id/comments', async (c) => {
  const page = await memoStore(c).listComments(memoId(c), {
    cursor: c.req.query('cursor') || undefined,
    limit: clampInt(c.req.query('limit'), 1, MEMO_MAX_PAGE_SIZE, MEMO_COMMENT_PAGE_SIZE),
    tz: c.req.query('tz') || undefined,
  })
  if (!page) throw ApiError.notFound('Memo not found')
  return c.json(page)
})

memoListRoutes.post('/:id/comments', async (c) => {
  const id = memoId(c)
  const body = await readJson<MemoCommentFields>(c, JSON_BODY_LIMITS.note)
  const memo = await memoStore(c).create({
    content: body.content,
    attachmentIds: body.attachmentIds,
    createdAt: body.createdAt,
    parentId: id,
  })
  scheduleMemoWebhook(c, 'memos.memo.comment.created', memo)
  return c.json(memo, 201)
})

memoListRoutes.get('/:id/relations', async (c) => {
  const relations = await memoStore(c).relations(memoId(c))
  if (!relations) throw ApiError.notFound('Memo not found')
  return c.json(relations)
})

memoListRoutes.put('/:id/relations', async (c) => {
  const id = memoId(c)
  const body = await readJson<MemoRelationsFields>(c, JSON_BODY_LIMITS.small)
  const relations = await memoStore(c).replaceRelations(id, body)
  if (!relations) throw ApiError.notFound('Memo not found')
  return c.json(relations)
})
