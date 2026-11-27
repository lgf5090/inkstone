import type { Hono } from 'hono'
import { sharePasscodeProblem } from '@shared/share-passcode'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidSlug, newSlug } from '../lib/id'
import { hashPassword } from '../lib/password'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { insertFeed, listFeeds, revokeFeed, type OwnFeedRow } from '../todos/feeds'

const BODY_LIMIT = JSON_BODY_LIMITS.settings
const FEED_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000

function feedInfo(row: OwnFeedRow, origin: string) {
  return {
    slug: row.slug,
    url: `${origin}/feeds/${row.slug}.ics`,
    hasPassword: row.has_password !== 0,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

function feedExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw ApiError.badRequest('expiresIn must be a non-negative number or null')
  }
  return value > 0 ? Date.now() + Math.min(value, FEED_MAX_AGE_MS) : null
}

export function registerTodoFeedOwnerRoutes(routes: Hono<AppBindings>): void {
  routes.get('/feed', async (c) => {
    const rows = await listFeeds(c.env.DB, c.get('userId'))
    const origin = new URL(c.req.url).origin
    return c.json({ feeds: rows.map((row) => feedInfo(row, origin)) })
  })

  routes.post('/feed', async (c) => {
    const body = await readJson<{ password?: unknown, expiresIn?: unknown }>(c, BODY_LIMIT)
    if (body.password !== undefined && body.password !== null && typeof body.password !== 'string') {
      throw ApiError.badRequest('password must be a string or null')
    }
    const passcodeProblem = sharePasscodeProblem(body.password)
    if (passcodeProblem) throw ApiError.badRequest(passcodeProblem)
    const expiresAt = feedExpiry(body.expiresIn)
    const passwordHash = typeof body.password === 'string' && body.password
      ? await hashPassword(body.password)
      : null
    const now = Date.now()
    const slug = newSlug()
    await insertFeed(c.env.DB, { slug, userId: c.get('userId'), passwordHash, expiresAt, now })
    const feed = feedInfo(
      { slug, has_password: passwordHash ? 1 : 0, expires_at: expiresAt, created_at: now },
      new URL(c.req.url).origin,
    )
    return c.json({ feed }, 201)
  })

  routes.delete('/feed/:slug', async (c) => {
    const slug = c.req.param('slug')
    if (!isValidSlug(slug)) throw ApiError.notFound('The subscription does not exist')
    if (!(await revokeFeed(c.env.DB, c.get('userId'), slug, Date.now()))) {
      throw ApiError.notFound('The subscription does not exist')
    }
    return c.json({ ok: true })
  })
}
