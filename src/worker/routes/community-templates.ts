import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { utf8ByteLength } from '@shared/text-utils'
import type { CommunityTemplate, CommunityTemplateInput } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { storedStringArray } from '../lib/json'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import {
  CommunityTemplatesStore,
  type CommunityCursor,
  type CommunityRow,
} from '../templates/store'

export const communityTemplatesRoutes = new Hono<AppBindings>()

communityTemplatesRoutes.use('*', requireAuth)

function toCommunityTemplate(row: CommunityRow): CommunityTemplate {
  const tags = storedStringArray(row.tags)
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    name: row.name,
    description: row.description,
    content: row.content,
    tags,
    category: row.category,
    uses: row.uses ?? 0,
    createdAt: row.created_at,
  }
}

function parseCursor(raw: string | undefined): CommunityCursor | null {
  if (!raw) return null
  const separator = raw.lastIndexOf('_')
  if (separator <= 0) throw ApiError.badRequest('Invalid pagination cursor')
  const createdAt = Number(raw.slice(0, separator))
  const id = raw.slice(separator + 1)
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !isValidId(id))
    throw ApiError.badRequest('Invalid pagination cursor')
  return { createdAt, id }
}

function parsePageSize(raw: string | undefined): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 50
  return Math.min(LIMITS.communityTemplatesPageSizeMax, Math.max(1, Math.trunc(value)))
}

function parseInput(body: Partial<CommunityTemplateInput>): CommunityTemplateInput {
  if (typeof body.name !== 'string' || !body.name.trim())
    throw ApiError.badRequest('name is required')
  if (typeof body.content !== 'string' || !body.content.trim())
    throw ApiError.badRequest('content is required')
  if (utf8ByteLength(body.content) > LIMITS.communityTemplateContentMaxLength)
    throw ApiError.badRequest(`content must stay within ${LIMITS.communityTemplateContentMaxLength} bytes`)
  const description = typeof body.description === 'string' ? body.description : ''
  const category = typeof body.category === 'string' ? body.category : ''
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
    : []
  return {
    id: body.id,
    name: body.name.trim().slice(0, LIMITS.titleMaxLength),
    description: description.slice(0, 240),
    content: body.content,
    tags: tags.map((tag) => tag.trim().slice(0, 30)).filter(Boolean),
    category: category.slice(0, 120),
  }
}

communityTemplatesRoutes.get('/', async (c) => {
  const limit = parsePageSize(c.req.query('limit'))
  const before = parseCursor(c.req.query('before'))
  const results = await new CommunityTemplatesStore(c.env.DB, c.get('userId')).listPage(before, limit)
  const hasMore = results.length > limit
  const page = results.slice(0, limit)
  const last = page[page.length - 1]
  return c.json({
    templates: page.map(toCommunityTemplate),
    hasMore,
    nextCursor: hasMore && last ? `${last.created_at}_${last.id}` : null,
  })
})

/**
 * Publishing counts against a per-account hourly budget so one account cannot
 * flood the shared directory. Updating your own template spends the same
 * budget, which is the point: an edit is another write.
 */
async function enforcePublishBudget(db: D1Database, userId: string): Promise<void> {
  await assertAttemptBudget(() => consumeAttemptBudget(db, [{
    key: `community-template:publish:${userId}`,
    maxAttempts: LIMITS.communityTemplatesPerHour,
    windowMs: 60 * 60 * 1000,
    lockMs: 60 * 60 * 1000,
  }]), 'Too many community template publishes')
}

/**
 * Resolves the row an update targets and enforces both ceilings. A supplied id
 * is only honoured when it is new or already belongs to this account, so one
 * author can neither overwrite nor squat another author's id.
 */
async function resolvePublishId(
  store: CommunityTemplatesStore,
  inputId: string | undefined,
): Promise<string> {
  if (inputId === undefined) {
    await assertRoomForOneMore(store)
    return newId()
  }
  if (!isValidId(inputId)) throw ApiError.badRequest('id must be a valid template id')
  const existing = await store.authorOf(inputId)
  if (existing && existing.author_id !== store.userId)
    throw ApiError.forbidden('Only the author can update a published template')
  if (!existing) await assertRoomForOneMore(store)
  return inputId
}

async function assertRoomForOneMore(store: CommunityTemplatesStore): Promise<void> {
  if ((await store.publishedCount()) >= LIMITS.communityTemplatesMaxPerUser) {
    throw ApiError.forbidden(
      `This account has already published ${LIMITS.communityTemplatesMaxPerUser} templates`,
    )
  }
}

communityTemplatesRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const store = new CommunityTemplatesStore(c.env.DB, userId)
  await enforcePublishBudget(c.env.DB, userId)
  const body = await readJson<Partial<CommunityTemplateInput>>(c, JSON_BODY_LIMITS.small)
  const input = parseInput(body)
  const id = await resolvePublishId(store, input.id)
  const authorName = (await store.profileName()) || 'Inkstone'
  await store.publish({ id, authorName, template: input, now: Date.now() })
  const row = await store.publishedRow(id)
  if (!row)
    throw new ApiError(500, 'internal', 'Failed to store the community template')
  return c.json({ template: toCommunityTemplate(row) })
})

/**
 * One account adopting a template into its own library is the only signal worth
 * counting, so the author's own copy never adds to it. The budget is per account
 * and generous: it stops a script, not a person browsing the directory.
 */
async function enforceUseBudget(db: D1Database, userId: string): Promise<void> {
  await assertAttemptBudget(() => consumeAttemptBudget(db, [{
    key: `community-template:use:${userId}`,
    maxAttempts: LIMITS.communityTemplateUsesPerHour,
    windowMs: 60 * 60 * 1000,
    lockMs: 60 * 60 * 1000,
  }]), 'Too many community template adopts')
}

communityTemplatesRoutes.post('/:id/use', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.badRequest('id must be a valid template id')
  const store = new CommunityTemplatesStore(c.env.DB, userId)
  await enforceUseBudget(c.env.DB, userId)
  if (!(await store.exists(id))) throw ApiError.notFound('Community template not found')
  await store.recordUse(id)
  return c.json({ uses: (await store.uses(id)) ?? 0 })
})

communityTemplatesRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.badRequest('id must be a valid template id')
  const store = new CommunityTemplatesStore(c.env.DB, userId)
  const existing = await store.authorOf(id)
  if (!existing) throw ApiError.notFound('Community template not found')
  if (existing.author_id !== userId)
    throw ApiError.forbidden('Only the author can unpublish a template')
  await store.unpublish(id)
  return c.json({ ok: true as const })
})
