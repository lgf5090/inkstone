/**
 * The public, read-only ICS subscription endpoint: `GET /feeds/<slug>.ics`.
 *
 * This is the reader half of E02's output side. There is no session and there never will be one — a
 * third-party calendar polls this URL and cannot log in — so the only capability is the unguessable
 * slug, optionally guarded by a passcode, exactly as a note share works. Minting, revoking and setting
 * a feed's expiry belong to the owner's side and are *not* here: this file only reads what the owner
 * already published and renders it.
 *
 * The security that `requireAuth` would otherwise supply is done by hand and deliberately:
 *   - `isValidSlug` gates the request before any database is touched, so a guessed slug is refused the
 *     same fast 404 as one that does not exist and is never used as an existence probe;
 *   - the passcode is compared with `verifyPassword` (scrypt over a constant-time buffer compare), the
 *     one passcode scheme the shares already use — there is no second hash here;
 *   - wrong passcodes and rapid polling are throttled through the shared `login_attempts` budget;
 *   - expiry and revocation read as a 404, never a 403-with-a-reason, so a dead link says nothing about
 *     whether it ever held tasks.
 *
 * The document is the account owner's own text, so it carries `no-store` and `nosniff`; and it is built
 * only from the columns a calendar may legitimately see, never `note_id`, `conversation_id` or the
 * stored passcode hash.
 */

import { Hono, type Context } from 'hono'
import { LIMITS } from '@shared/constants'
import { MAX_TASKS_PER_QUERY, parseRepeatRule } from '@shared/todos/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidSlug } from '../lib/id'
import { requestClientIp } from '../lib/request'
import { verifyPassword } from '../lib/password'
import {
  assertAttemptBudget,
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
} from '../lib/throttle'
import { AssistantStore } from '../assistant/store'
import { buildIcsCalendar, type IcsTask } from '../todos/ics'

const DAY_MS = 24 * 60 * 60 * 1000
/** How far ahead a subscription reaches; overdue items are always included, so the floor is the past. */
export const FEED_WINDOW_DAYS = 90

type FeedRow = {
  user_id: string
  password_hash: string | null
  expires_at: number | null
  revoked_at: number | null
}

type TaskRow = {
  id: string
  title: string
  description: string
  priority: string
  due_at: number
  repeat_rule: string | null
}

/** The two attempt budgets a public feed guards itself with, both keyed by slug and visitor. */
export function feedThrottleTargets(slug: string, ip: string) {
  return {
    read: [{ key: `feed-read:${slug}:ip:${ip}`, maxAttempts: 60, windowMs: 5 * 60 * 1000 }],
    verifyLock: [`feed:${slug}:ip:${ip}`],
    verifyWork: [
      { key: `feed-work:${slug}:ip:${ip}`, maxAttempts: 8, windowMs: 10 * 60 * 1000 },
      { key: `feed-work:${slug}`, maxAttempts: 40, windowMs: 10 * 60 * 1000, lockMs: 60_000 },
    ],
  }
}

/** `abc123….ics` and `abc123…` address the same feed; only the latter is a slug. */
export function stripIcsSuffix(value: string | undefined): string {
  if (!value) return ''
  return value.toLowerCase().endsWith('.ics') ? value.slice(0, -4) : value
}

async function findFeed(db: D1Database, slug: string): Promise<FeedRow | null> {
  return (
    (await db
      .prepare(
        `SELECT user_id, password_hash, expires_at, revoked_at FROM todos_feeds WHERE slug = ?1`,
      )
      .bind(slug)
      .first<FeedRow>()) ?? null
  )
}

async function loadFeedTasks(db: D1Database, userId: string, horizonEnd: number): Promise<IcsTask[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, description, priority, due_at, repeat_rule
         FROM todos_tasks
        WHERE user_id = ?1 AND status != 'done' AND due_at IS NOT NULL AND due_at <= ?2
        ORDER BY due_at ASC, id ASC
        LIMIT ?3`,
    )
    .bind(userId, horizonEnd, MAX_TASKS_PER_QUERY)
    .all<TaskRow>()
  return (results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    priority: toPriority(row.priority),
    dueAt: Number(row.due_at),
    repeat: parseRepeatRule(parseStoredRepeat(row.repeat_rule)),
  }))
}

function toPriority(value: string): IcsTask['priority'] {
  return value === 'low' || value === 'high' || value === 'urgent' ? value : 'medium'
}

/** A stored `repeat_rule` is JSON text; a malformed one simply means "does not repeat", never a 500. */
function parseStoredRepeat(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Whether the passcode on this feed's URL is correct; a feed with no passcode needs nothing. */
async function assertPasscode(c: Context<AppBindings>, slug: string, hash: string, ip: string): Promise<void> {
  const provided = c.req.query('key')
  if (provided === undefined || provided === '') {
    throw ApiError.unauthenticated('An access password is required')
  }
  const targets = feedThrottleTargets(slug, ip)
  await assertAttemptBudget(async () => {
    await assertNotLocked(c.env.DB, targets.verifyLock)
    await consumeAttemptBudget(c.env.DB, targets.verifyWork)
  })
  const candidate = provided.slice(0, LIMITS.passwordMaxLength)
  if (!(await verifyPassword(candidate, hash))) {
    await recordLoginFailure(c.env.DB, targets.verifyLock)
    throw new ApiError(401, 'invalid_credentials', 'Incorrect passcode')
  }
  await clearLoginFailures(c.env.DB, [
    ...targets.verifyLock,
    ...targets.verifyWork.map((target) => target.key),
  ])
}

export const todoFeedRoutes = new Hono<AppBindings>()

todoFeedRoutes.get('/:slug', async (c) => {
  const slug = stripIcsSuffix(c.req.param('slug'))
  if (!isValidSlug(slug)) throw ApiError.notFound('The subscription does not exist')

  const targets = feedThrottleTargets(slug, requestClientIp(c))
  await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, targets.read))

  const feed = await findFeed(c.env.DB, slug)
  if (!feed || feed.revoked_at !== null) throw ApiError.notFound('The subscription does not exist')
  const now = Date.now()
  if (feed.expires_at !== null && feed.expires_at < now) {
    throw ApiError.notFound('The subscription has expired')
  }

  if (feed.password_hash) await assertPasscode(c, slug, feed.password_hash, requestClientIp(c))

  const store = new AssistantStore(c.env.DB, feed.user_id, c.env)
  const timezone = (await store.getSettings()).timezone
  const tasks = await loadFeedTasks(c.env.DB, feed.user_id, now + FEED_WINDOW_DAYS * DAY_MS)
  const calendar = buildIcsCalendar(tasks, { now, timezone, horizonMs: FEED_WINDOW_DAYS * DAY_MS })

  return new Response(calendar, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  })
})
