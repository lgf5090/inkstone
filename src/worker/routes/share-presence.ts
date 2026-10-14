import { getCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { D1Database } from '@cloudflare/workers-types'
import { SHARE_PRESENCE_AUDIENCE_WINDOW_MS, SHARE_PRESENCE_TTL_MS, type PublicSharePresence, type SharePresencePosition, type SharePresenceSession } from '@shared/share-presence'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidSlug } from '../lib/id'
import { JSON_BODY_LIMITS, readJson, readOptionalJson, requestClientIp } from '../lib/request'
import { hashToken, isSessionToken, newSessionToken } from '../lib/session-store'
import { shareAssetCookieName, verifyShareAssetSession } from '../lib/share-asset-session'
import { assertAttemptBudget, consumeAttemptBudget, countAttemptKeysInRange } from '../lib/throttle'
import {
  SharePresenceStore,
  deletePresenceRowBySlug,
  loadLiveShareBySlug,
  loadPresenceRow,
  type PresentableShare,
  type SharePresenceRow,
} from '../share/presence-store'

/**
 * The audience-side show position: the presenter writes where the talk is, and a viewer on their own
 * device reads it and turns its own page.
 *
 * Two halves live here because they are one contract seen from both ends. The owner half is a normal
 * authenticated share route; the public half is the one that has to be careful — it is reachable by a
 * stranger, so it answers with a capability token rather than a session, and it never writes a visitor
 * row: the position is not a view, and counting every heartbeat would turn "how many people opened
 * this link" into "how many seconds they sat there". The audience number the presenter sees (PR-M7) is
 * read out of the read budget that is already being spent, so it costs no write and no new table.
 *
 * No SQL lives here. The room's rows go through `share/presence-store.ts` — a `SharePresenceStore` for
 * the account that owns the show and slug-keyed free functions for the audience, following the
 * cross-account precedent of `findShareBySlug` — while the audience count, a read of the throttle
 * ledger, goes through `countAttemptKeysInRange`. What stays in this file is validation, the
 * capability-token comparison, the lease arithmetic, the `ApiError` codes and the response shape.
 */

/**
 * A deck position is three counters, and they are only ever echoed back to a viewer and used to pick a
 * page. They are still checked at the boundary: an unbounded integer would be stored and served to
 * every follower, and a negative one has no page to name. The ceilings are far above any deck a note
 * can hold, so they reject garbage without refusing a real show.
 */
const MAX_COUNTER = 1_000_000

/**
 * One past the last byte a throttle key can hold, used as the exclusive upper bound of a key range.
 * Spelled as a code point rather than a raw control byte so the source stays plain ASCII.
 */
const KEY_RANGE_UPPER_BOUND = String.fromCharCode(0x7f)

function readPosition(body: unknown): SharePresencePosition {
  const value = body as Record<string, unknown>
  const at = (name: 'slide' | 'page' | 'step'): number => {
    const field = value[name]
    if (typeof field !== 'number' || !Number.isInteger(field) || field < 0 || field > MAX_COUNTER) {
      throw ApiError.badRequest(`${name} must be a non-negative integer`)
    }
    return field
  }
  return { slide: at('slide'), page: at('page'), step: at('step') }
}

/**
 * Whether this browser has passed the share's passcode, asked the same way the attachment routes ask
 * it: the gate mints one capability and leaves it in a cookie, and a reader proves itself by carrying
 * it. A missing or foreign cookie is not a separate answer — it is the same 404.
 */
async function shareAccessPassed(c: Context<AppBindings>, slug: string, passwordHash: string): Promise<boolean> {
  return await verifyShareAssetSession(c.env.DB, getCookie(c, shareAssetCookieName(slug)), slug, passwordHash)
}

export function registerSharePresenceRoutes(shareManageRoutes: Hono<AppBindings>): void {
  registerSharePresenceStartRoute(shareManageRoutes)
  registerSharePresenceWriteRoute(shareManageRoutes)
  registerSharePresenceStopRoute(shareManageRoutes)
  registerSharePresenceStatusRoute(shareManageRoutes)
}

/**
 * Starting a show mints the capability the audience URL will carry. It is returned exactly once: the
 * row keeps a hash, so a database read cannot hand out a working link, and a speaker who loses the
 * link starts a new show rather than recovering an old one.
 */
function registerSharePresenceStartRoute(shareManageRoutes: Hono<AppBindings>): void {
  shareManageRoutes.post('/:noteId/present/start', async (c) => {
    const store = new SharePresenceStore(c.env.DB, c.get('userId'))
    const share = await requirePresentableShare(store, c.req.param('noteId'))
    const token = newSessionToken()
    const now = Date.now()
    const expiresAt = presenceExpiry(share.expires_at, now)
    await store.startPresence({ slug: share.slug, noteId: share.note_id, tokenHash: await hashToken(token), now, expiresAt })
    const response: SharePresenceSession = { token, expiresAt, slug: share.slug, slide: 0, page: 0, step: 0 }
    return c.json(response, 200, { 'Cache-Control': 'no-store' })
  })
}

/**
 * Writing the position refreshes the lease: a talk that runs long is not cut off, while a show that
 * was simply left open expires on its own. There is no INSERT here on purpose — a position can only
 * be written into a show that was started, so a stale client cannot resurrect a revoked token.
 */
function registerSharePresenceWriteRoute(shareManageRoutes: Hono<AppBindings>): void {
  shareManageRoutes.post('/:noteId/present', async (c) => {
    const store = new SharePresenceStore(c.env.DB, c.get('userId'))
    const share = await requirePresentableShare(store, c.req.param('noteId'))
    const body = readPosition(await readJson(c, JSON_BODY_LIMITS.small))
    const now = Date.now()
    const updated = await store.writePosition({
      slug: share.slug,
      slide: body.slide,
      page: body.page,
      step: body.step,
      now,
      expiresAt: presenceExpiry(share.expires_at, now),
    })
    if (!updated) throw ApiError.notFound('The presentation is not running')
    // The turn of a page is also how the speaker hears that the room is there: the count rides back on the
    // answer they already waited for, so an audience costs no extra request to notice.
    return c.json({ updatedAt: now, viewers: await countAudienceViewers(c.env.DB, share.slug, now) }, 200, { 'Cache-Control': 'no-store' })
  })
}

/** Stopping is idempotent: the presenter presses it once and the browser may press it again on unload. */
function registerSharePresenceStopRoute(shareManageRoutes: Hono<AppBindings>): void {
  shareManageRoutes.post('/:noteId/present/stop', async (c) => {
    const store = new SharePresenceStore(c.env.DB, c.get('userId'))
    const share = await requirePresentableShare(store, c.req.param('noteId'))
    await store.stopPresence(share.slug)
    return c.json({ stopped: true }, 200, { 'Cache-Control': 'no-store' })
  })
}

/**
 * The owner's own question, asked when the share sheet opens: is a show running, so the control can
 * say "stop" instead of "start". It never returns the token — that left the server once.
 */
function registerSharePresenceStatusRoute(shareManageRoutes: Hono<AppBindings>): void {
  shareManageRoutes.get('/:noteId/present', async (c) => {
    const store = new SharePresenceStore(c.env.DB, c.get('userId'))
    const share = await requirePresentableShare(store, c.req.param('noteId'))
    // The owner asking whether they are on air is also the moment their finished shows get cleaned
    // up: a row whose lease ran out answers nothing (every read filters on `expires_at`), so it is
    // only ever left behind by a browser that never sent the stop press.
    await store.deleteExpiredShows(Date.now())
    const row = await loadPresenceRow(c.env.DB, share.slug, Date.now())
    const viewers = await countAudienceViewers(c.env.DB, share.slug, Date.now())
    if (!row) return c.json({ running: false, viewers }, 200, { 'Cache-Control': 'no-store' })
    const running: PublicSharePresence = { slide: row.slide, page: row.page, step: row.step, updatedAt: row.updated_at, title: share.title }
    return c.json({ running: true, expiresAt: row.expires_at, presence: running, viewers }, 200, { 'Cache-Control': 'no-store' })
  })
}

export function registerSharePublicPresenceRoutes(shareRoutes: Hono<AppBindings>): void {
  shareRoutes.post('/:slug/present', async (c) => {
    const slug = c.req.param('slug')
    if (!isValidSlug(slug)) throw shareNotFound()
    await enforcePresenceReadBudget(c, slug)
    const body = await readOptionalJson<{ token?: unknown }>(c, JSON_BODY_LIMITS.small, {})
    const row = await loadPresenceRow(c.env.DB, slug, Date.now())
    // One answer for "no such share", "no show running", "no token", "wrong token" and "the show is
    // over": the existence of a presentation is the owner's information, not the caller's to learn.
    if (!row || typeof body.token !== 'string' || !(await tokenMatches(row, body.token))) throw shareNotFound()
    const share = await loadLiveShareBySlug(c.env.DB, slug)
    // This fork revokes a link by deleting its row, so a missing row and one past its expiry are the
    // same answer here — the store hands back the row, and reading `expires_at` past its lease is the
    // route's decision. The share was revoked or expired while the row was still inside its lease:
    // take the row with it, so the next heartbeat answers the same way the first one did rather than
    // waiting out the TTL.
    if (!share || (share.expires_at && share.expires_at < Date.now())) {
      await deletePresenceRowBySlug(c.env.DB, slug)
      throw shareNotFound()
    }
    // A passcode protects the note, and the note's title and progress are part of the note. The token
    // says "the speaker sent you this link"; the proof the gate left in the cookie jar says "this
    // browser has read it", and both are needed. Answered the same way as every other refusal.
    if (share.password_hash && !(await shareAccessPassed(c, slug, share.password_hash))) throw shareNotFound()
    const presence: PublicSharePresence = { slide: row.slide, page: row.page, step: row.step, updatedAt: row.updated_at, title: share.title }
    // A viewer polls on a beat, and most beats nothing has changed. The validator is taken over the
    // answer's own numbers, which is what makes a hit cheap: 304 carries no row, no title and no work.
    const etag = `W/"${row.slide}-${row.page}-${row.step}-${row.updated_at}"`
    const headers = { ETag: etag, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers)
    return c.json(presence, 200, headers)
  })
}

/**
 * The read budget is its own keys (`share-present:view:*`), deliberately not the page-view budget: a
 * viewer who opens the shared page and a viewer whose client is polling are different kinds of traffic,
 * and sharing a bucket would let one heartbeat starve the other's page load.
 *
 * The numbers are measured against the poll interval: 2 s over a 10-minute window is 300 reads a head,
 * which is above the per-IP budget on purpose — the 304 path is what makes an idle viewer cheap, and if
 * the budget has to be raised, the poll interval has to be measured first.
 */
const READ_SLUG_IP_BUDGET = { maxAttempts: 120, windowMs: 10 * 60 * 1000 }
const READ_IP_BUDGET = { maxAttempts: 300, windowMs: 10 * 60 * 1000 }

async function enforcePresenceReadBudget(c: Context<AppBindings>, slug: string): Promise<void> {
  const clientIp = requestClientIp(c)
  await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [
    { key: `share-present:view:${slug}:ip:${clientIp}`, ...READ_SLUG_IP_BUDGET },
    { key: `share-present:view:ip:${clientIp}`, ...READ_IP_BUDGET },
  ]))
}

async function tokenMatches(row: SharePresenceRow, token: string): Promise<boolean> {
  if (!isSessionToken(token)) return false
  return await hashToken(token) === row.token_hash
}

/**
 * How many browsers have been reading this show (PR-M7).
 *
 * The audience is already counted, by accident: every public read spends a budget attempt keyed by the
 * show's slug and the reader's address, and the row it writes carries the time of that read. Counting
 * those rows is the whole signal — no per-viewer table, which was weighed and refused, no second write, and
 * nothing new for a viewer to send. The count is a read of the throttle ledger, so it is asked through
 * `countAttemptKeysInRange`; this only builds the room's key range and window.
 *
 * The range is a `[prefix, prefix + U+007F)` half-open window rather than a `LIKE` pattern because a
 * slug is data: a `_` in it would otherwise stand for "any character" and count somebody else's room.
 */
async function countAudienceViewers(db: D1Database, slug: string, now: number): Promise<number> {
  const prefix = `share-present:view:${slug}:ip:`
  return await countAttemptKeysInRange(db, prefix, `${prefix}${KEY_RANGE_UPPER_BOUND}`, now - SHARE_PRESENCE_AUDIENCE_WINDOW_MS)
}

/** A show lives at most `SHARE_PRESENCE_TTL_MS`, and never past the link it rides on. */
function presenceExpiry(shareExpiresAt: number | null, now: number): number {
  const lease = now + SHARE_PRESENCE_TTL_MS
  return shareExpiresAt && shareExpiresAt < lease ? shareExpiresAt : lease
}

/**
 * The owner's live share for a show, or the 404 every owner-side route answers with.
 *
 * The store hands back the row (`presentableShare`); whether an expired link still counts as presentable
 * is a rule about the response, so it is decided here, exactly as the share routes decide expiry.
 */
async function requirePresentableShare(store: SharePresenceStore, noteId: string): Promise<PresentableShare> {
  const share = await store.presentableShare(noteId)
  if (!share || (share.expires_at && share.expires_at < Date.now())) throw ApiError.notFound('Note not found')
  return share
}

/** The same words the share routes answer with: a revoked link, an expired one and one that never
 * existed do not differ, and neither does a show the caller has no part in. */
function shareNotFound(): ApiError {
  return ApiError.notFound('The link does not exist or has been revoked')
}
