import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { utf8ByteLength } from '@shared/text-utils'
import type { CommunityTemplate, CommunityTemplateInput } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'

export const communityTemplatesRoutes = new Hono<AppBindings>()

communityTemplatesRoutes.use('*', requireAuth)

interface CommunityRow {
  id: string
  author_id: string
  author_name: string
  name: string
  description: string
  content: string
  tags: string
  category: string
  uses: number
  created_at: number
}

/**
 * `author_name` is read from the account rather than the copy frozen into the row
 * at publish time, so an author who changes their display name is credited with the
 * name readers should see today.
 */
const COMMUNITY_SELECT = `ct.id, ct.author_id,
  COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), ct.author_name, 'Inkstone') AS author_name,
  ct.name, ct.description, ct.content, ct.tags, ct.category, ct.uses, ct.created_at`
const COMMUNITY_FROM = `FROM community_templates ct
  LEFT JOIN users u ON u.id = ct.author_id`

function toCommunityTemplate(row: CommunityRow): CommunityTemplate {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(row.tags) as unknown
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string')
  }
  catch {
    tags = []
  }
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

function parseCursor(raw: string | undefined): { createdAt: number; id: string } | null {
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
  const { results } = await c.env.DB.prepare(
    before
      ? `SELECT ${COMMUNITY_SELECT} ${COMMUNITY_FROM}
         WHERE (ct.created_at < ?1 OR (ct.created_at = ?1 AND ct.id < ?2))
         ORDER BY ct.created_at DESC, ct.id ASC LIMIT ?3`
      : `SELECT ${COMMUNITY_SELECT} ${COMMUNITY_FROM}
         ORDER BY ct.created_at DESC, ct.id ASC LIMIT ?1`,
  ).bind(...(before ? [before.createdAt, before.id, limit + 1] : [limit + 1])).all<CommunityRow>()
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
  try {
    await consumeAttemptBudget(db, [{
      key: `community-template:publish:${userId}`,
      maxAttempts: LIMITS.communityTemplatesPerHour,
      windowMs: 60 * 60 * 1000,
      lockMs: 60 * 60 * 1000,
    }])
  }
  catch (error) {
    if (error instanceof ThrottleError) {
      throw new ApiError(
        429,
        'too_many_attempts',
        `Too many community template publishes. Try again in ${error.retryAfterSec} seconds`,
        { retryAfter: error.retryAfterSec },
      )
    }
    throw error
  }
}

/**
 * Resolves the row an update targets and enforces both ceilings. A supplied id
 * is only honoured when it is new or already belongs to this account, so one
 * author can neither overwrite nor squat another author's id.
 */
async function resolvePublishId(
  db: D1Database,
  inputId: string | undefined,
  userId: string,
): Promise<string> {
  if (inputId === undefined) {
    await assertRoomForOneMore(db, userId)
    return newId()
  }
  if (!isValidId(inputId)) throw ApiError.badRequest('id must be a valid template id')
  const existing = await db.prepare(
    `SELECT author_id FROM community_templates WHERE id = ?1`,
  ).bind(inputId).first<{ author_id: string }>()
  if (existing && existing.author_id !== userId)
    throw ApiError.forbidden('Only the author can update a published template')
  if (!existing) await assertRoomForOneMore(db, userId)
  return inputId
}

async function assertRoomForOneMore(db: D1Database, userId: string): Promise<void> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM community_templates WHERE author_id = ?1`,
  ).bind(userId).first<{ n: number }>()
  if ((row?.n ?? 0) >= LIMITS.communityTemplatesMaxPerUser) {
    throw ApiError.forbidden(
      `This account has already published ${LIMITS.communityTemplatesMaxPerUser} templates`,
    )
  }
}

async function upsertTemplate(
  db: D1Database,
  id: string,
  userId: string,
  input: CommunityTemplateInput,
): Promise<void> {
  const author = await db.prepare(`SELECT name FROM users WHERE id = ?1`)
    .bind(userId).first<{ name: string }>()
  const authorName = author?.name || 'Inkstone'
  // `created_at` is deliberately absent from the UPDATE list: re-publishing an
  // existing template refreshes its text but must not jump it back to the top
  // of the directory.
  await db.prepare(
    `INSERT INTO community_templates (id, author_id, author_name, name, description, content, tags, category, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET
       author_name = excluded.author_name,
       name = excluded.name,
       description = excluded.description,
       content = excluded.content,
       tags = excluded.tags,
       category = excluded.category`,
  )
    .bind(
      id,
      userId,
      authorName,
      input.name,
      input.description,
      input.content,
      JSON.stringify(input.tags),
      input.category,
      Date.now(),
    )
    .run()
}

communityTemplatesRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  await enforcePublishBudget(c.env.DB, userId)
  const body = await readJson<Partial<CommunityTemplateInput>>(c, JSON_BODY_LIMITS.small)
  const input = parseInput(body)
  const id = await resolvePublishId(c.env.DB, input.id, userId)
  await upsertTemplate(c.env.DB, id, userId, input)
  const row = await c.env.DB.prepare(
    `SELECT ${COMMUNITY_SELECT} ${COMMUNITY_FROM} WHERE ct.id = ?1`,
  ).bind(id).first<CommunityRow>()
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
  try {
    await consumeAttemptBudget(db, [{
      key: `community-template:use:${userId}`,
      maxAttempts: LIMITS.communityTemplateUsesPerHour,
      windowMs: 60 * 60 * 1000,
      lockMs: 60 * 60 * 1000,
    }])
  }
  catch (error) {
    if (error instanceof ThrottleError) {
      throw new ApiError(
        429,
        'too_many_attempts',
        `Too many community template adopts. Try again in ${error.retryAfterSec} seconds`,
        { retryAfter: error.retryAfterSec },
      )
    }
    throw error
  }
}

communityTemplatesRoutes.post('/:id/use', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.badRequest('id must be a valid template id')
  await enforceUseBudget(c.env.DB, userId)
  const existing = await c.env.DB.prepare(
    `SELECT id FROM community_templates WHERE id = ?1`,
  ).bind(id).first<{ id: string }>()
  if (!existing) throw ApiError.notFound('Community template not found')
  await c.env.DB.prepare(
    `UPDATE community_templates SET uses = uses + 1 WHERE id = ?1 AND author_id != ?2`,
  ).bind(id, userId).run()
  const row = await c.env.DB.prepare(
    `SELECT uses FROM community_templates WHERE id = ?1`,
  ).bind(id).first<{ uses: number }>()
  return c.json({ uses: row?.uses ?? 0 })
})

communityTemplatesRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.badRequest('id must be a valid template id')
  const existing = await c.env.DB.prepare(
    `SELECT author_id FROM community_templates WHERE id = ?1`,
  ).bind(id).first<{ author_id: string }>()
  if (!existing) throw ApiError.notFound('Community template not found')
  if (existing.author_id !== userId)
    throw ApiError.forbidden('Only the author can unpublish a template')
  await c.env.DB.prepare(`DELETE FROM community_templates WHERE id = ?1`).bind(id).run()
  return c.json({ ok: true as const })
})
