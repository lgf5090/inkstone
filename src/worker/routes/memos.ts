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
  type MemoOrderDirection,
  type MemoOrderField,
  type MemoState,
} from '@shared/memos/types'
import type { AppBindings, Env } from '../env'
import { deleteAttachmentObjects } from '../attachments/backend'
import type { AttachmentObjectStorage } from '../attachments/keys'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, clampInt, readJson } from '../lib/request'
import { requireMemoUser } from '../memos/auth'
import {
  MemosStore,
  type MemoAttachmentObjectRef,
  type MemoCommentFields,
  type MemoCreateFields,
  type MemoListOptions,
  type MemoPatchFields,
  type MemoRelationsFields,
} from '../memos/store'

const OBJECT_DELETE_BATCH = 500

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

async function deleteMemoObjects(
  env: Env,
  refs: readonly MemoAttachmentObjectRef[],
): Promise<void> {
  const grouped = new Map<AttachmentObjectStorage, string[]>()
  for (const ref of refs) {
    const keys = grouped.get(ref.storage)
    if (keys) keys.push(ref.key)
    else grouped.set(ref.storage, [ref.key])
  }
  for (const [storage, keys] of grouped) {
    for (let offset = 0; offset < keys.length; offset += OBJECT_DELETE_BATCH) {
      try {
        await deleteAttachmentObjects(env, storage, keys.slice(offset, offset + OBJECT_DELETE_BATCH))
      } catch (error) {
        console.warn('[inkstone] Memo attachment objects could not be deleted:', error)
      }
    }
  }
}

function scheduleMemoObjectCleanup(
  c: Context<AppBindings>,
  refs: readonly MemoAttachmentObjectRef[],
): void {
  const cleanup = deleteMemoObjects(c.env, refs)
  try {
    c.executionCtx.waitUntil(cleanup)
  } catch (error) {
    console.warn('[inkstone] Memo attachment cleanup has no execution context:', error)
    void cleanup
  }
}

export const memoListRoutes = new Hono<AppBindings>()

memoListRoutes.use('*', requireMemoUser)

memoListRoutes.get('/', async (c) => c.json(await memoStore(c).list(listOptions(c))))

memoListRoutes.post('/', async (c) => {
  const body = await readJson<MemoCreateFields>(c, JSON_BODY_LIMITS.note)
  const memo = await memoStore(c).create(body)
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
  return c.json(result.memo)
})

memoListRoutes.delete('/:id', async (c) => {
  const result = await memoStore(c).delete(memoId(c))
  if (!result) throw ApiError.notFound('Memo not found')
  if (result.attachmentObjects.length) {
    scheduleMemoObjectCleanup(c, result.attachmentObjects)
  }
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
