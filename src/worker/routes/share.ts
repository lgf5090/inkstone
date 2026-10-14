import { Hono, type Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { LIMITS } from '@shared/constants'
import { sharePasscodeProblem } from '@shared/share-passcode'
import type { PublicNote, ShareInfo, ShareListItem } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { registerSharePresenceRoutes, registerSharePublicPresenceRoutes } from './share-presence'
import { isValidSlug, newSlug } from '../lib/id'
import { JSON_BODY_LIMITS, readJson, readOptionalJson, requestClientIp } from '../lib/request'
import { hashPassword, verifyPassword } from '../lib/password'
import {
  createShareAssetSession,
  shareAssetCookieName,
} from '../lib/share-asset-session'
import {
  assertAttemptBudget,
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
} from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import {
  ShareStore,
  countShareView,
  findShareBySlug,
  loadSharePageMeta,
  loadSharedNote,
  type SharePageMeta,
  type ShareRow,
} from '../share/store'


export const shareManageRoutes = new Hono<AppBindings>()

export const shareRoutes = new Hono<AppBindings>()

export const sharePageRoutes = new Hono<AppBindings>()

const VIEW_WINDOW_MS = 60_000
const VIEW_LIMIT = 60

export interface ShareViewWindow {
  count: number
  windowStart: number
}

export function shareVerifyThrottleTargets(slug: string, ip: string): {
  lockTargets: string[]
  workTargets: { key: string; maxAttempts: number; windowMs: number; lockMs?: number }[]
} {
  return {
    lockTargets: [`share:${slug}:ip:${ip}`],
    workTargets: [
      { key: `share-work:${slug}:ip:${ip}`, maxAttempts: 8, windowMs: 10 * 60 * 1000 },
      { key: `share-work:${slug}`, maxAttempts: 60, windowMs: 10 * 60 * 1000, lockMs: 60_000 },
    ],
  }
}

export function shouldPersistShareView(
  state: ShareViewWindow,
  now: number,
): { state: ShareViewWindow; persist: boolean } {
  if (now - state.windowStart >= VIEW_WINDOW_MS) {
    return { state: { count: 1, windowStart: now }, persist: true }
  }
  if (state.count >= VIEW_LIMIT) return { state, persist: false }
  return { state: { count: state.count + 1, windowStart: state.windowStart }, persist: true }
}

const shareViewWindows = new Map<string, ShareViewWindow>()
/** Sweep at most once per window, and never let the map grow without a hard ceiling. */
const SHARE_VIEW_WINDOWS_MAX = 10_000
let shareViewSweepAt = 0

function noteShareView(slug: string, ip: string, now: number): boolean {
  if (now >= shareViewSweepAt) {
    shareViewSweepAt = now + VIEW_WINDOW_MS
    for (const [key, value] of shareViewWindows) {
      if (now - value.windowStart >= VIEW_WINDOW_MS) shareViewWindows.delete(key)
    }
    // View counts are display-only; dropping them beats paying an O(n) sweep per request
    // or growing the isolate without bound under many distinct visitors.
    if (shareViewWindows.size > SHARE_VIEW_WINDOWS_MAX) shareViewWindows.clear()
  }
  const hit = shouldPersistShareView(
    shareViewWindows.get(`${slug}:${ip}`) ?? { count: 0, windowStart: 0 },
    now,
  )
  shareViewWindows.set(`${slug}:${ip}`, hit.state)
  return hit.persist
}

/**
 * The only place a share's `views` number moves is `countShareView` in `share/store.ts`; this file
 * decides when it is worth calling (once per visitor per window) and hangs it off the response path.
 */

function toShareInfo(row: ShareRow, origin: string): ShareInfo {
  return {
    slug: row.slug,
    noteId: row.note_id,
    url: `${origin}/s/${row.slug}`,
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at,
    views: row.views,
    createdAt: row.created_at,
  }
}


shareManageRoutes.use('*', requireAuth)

shareManageRoutes.get('/', async (c) => {
  const rows = await new ShareStore(c.env.DB, c.get('userId')).listShares()
  const origin = new URL(c.req.url).origin
  const shares: ShareListItem[] = rows.map((row) => ({
    ...toShareInfo(row, origin),
    noteTitle: row.note_title,
    deletedAt: row.deleted_at,
  }))
  return c.json({ shares })
})

shareManageRoutes.get('/:noteId', async (c) => {
  const row = await new ShareStore(c.env.DB, c.get('userId')).shareForNote(c.req.param('noteId'))
  if (!row) return c.json({ share: null })
  return c.json({ share: toShareInfo(row, new URL(c.req.url).origin) })
})

shareManageRoutes.post('/:noteId', async (c) => {
  const userId = c.get('userId')
  const noteId = c.req.param('noteId')
  const store = new ShareStore(c.env.DB, userId)
  const body = await readJson<{ password?: string | null; expiresIn?: number | null }>(c, JSON_BODY_LIMITS.small)

  if (!(await store.liveNoteExists(noteId))) throw ApiError.notFound('Note not found')

  const slug = newSlug()
  if (body.password !== undefined && body.password !== null && typeof body.password !== 'string') {
    throw ApiError.badRequest('password must be a string or null')
  }
  const passcodeProblem = sharePasscodeProblem(body.password)
  if (passcodeProblem) throw ApiError.badRequest(passcodeProblem)
  if (
    body.expiresIn !== undefined &&
    body.expiresIn !== null &&
    (!Number.isFinite(body.expiresIn) || body.expiresIn < 0)
  ) {
    throw ApiError.badRequest('expiresIn must be a non-negative number or null')
  }
  const expiresAt =
    typeof body.expiresIn === 'number' && body.expiresIn > 0
        ? Date.now() + Math.min(body.expiresIn, 365 * 24 * 60 * 60 * 1000)
        : null

  const replacePassword = body.password === null || typeof body.password === 'string'
  const passwordHash =
    body.password === null
      ? null
      : typeof body.password === 'string' && body.password
        ? await hashPassword(body.password)
        : null

  const written = await store.upsertShare({
    slug,
    noteId,
    passwordHash,
    expiresAt,
    now: Date.now(),
    replacePassword,
    replaceExpiry: body.expiresIn !== undefined,
  })
  if (!written) throw new ApiError(409, 'conflict', 'Share state changed. Refresh and try again')

  const row = await store.shareForNote(noteId)
  return c.json({ share: toShareInfo(row!, new URL(c.req.url).origin) })
})

shareManageRoutes.delete('/:noteId', async (c) => {
  const noteId = c.req.param('noteId')
  const userId = c.get('userId')
  await new ShareStore(c.env.DB, userId).deleteShare(noteId)
  return c.json({ ok: true })
})


shareRoutes.post('/:slug', async (c) => {
  const slug = c.req.param('slug')
  if (!isValidSlug(slug)) throw ApiError.notFound('The link does not exist or has been revoked')
  const body = await readOptionalJson<{ password?: string }>(c, JSON_BODY_LIMITS.small, {})
  const password = typeof body.password === 'string'
    ? body.password.slice(0, LIMITS.passwordMaxLength)
    : ''

  const share = await findShareBySlug(c.env.DB, slug)
  if (!share) throw ApiError.notFound('The link does not exist or has been revoked')
  if (share.expires_at && share.expires_at < Date.now()) throw ApiError.notFound('The link has expired')

  if (share.password_hash) {
    if (!password) {
      throw ApiError.unauthenticated('An access password is required')
    }
    const targets = shareVerifyThrottleTargets(slug, requestClientIp(c))
    await assertAttemptBudget(async () => {
      await assertNotLocked(c.env.DB, targets.lockTargets)
      await consumeAttemptBudget(c.env.DB, targets.workTargets)
    })
    if (!(await verifyPassword(password, share.password_hash))) {
      await recordLoginFailure(c.env.DB, targets.lockTargets)
      throw new ApiError(401, 'invalid_credentials', "Incorrect passcode")
    }
    await clearLoginFailures(c.env.DB, [
      ...targets.lockTargets,
      ...targets.workTargets.map((target) => target.key),
    ])
  }

  const note = await loadSharedNote(c.env.DB, share.note_id, share.user_id)
  if (!note) throw ApiError.notFound('The note has been deleted')

  if (noteShareView(slug, requestClientIp(c), Date.now())) {
    c.executionCtx?.waitUntil(countShareView(c.env.DB, slug))
  }

  if (share.password_hash) {
    const expiresAt = Math.min(
      share.expires_at ?? Number.MAX_SAFE_INTEGER,
      Date.now() + 12 * 60 * 60 * 1000,
    )
    const token = await createShareAssetSession(c.env.DB, slug, share.password_hash, expiresAt)
    setCookie(c, shareAssetCookieName(slug), token, {
      path: '/api/files/',
      httpOnly: true,
      sameSite: 'Strict',
      maxAge: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
      secure: new URL(c.req.url).protocol === 'https:',
    })
  }

  const body_: PublicNote = {
    title: note.title,
    content: note.content,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
    author: { name: note.name, avatarUrl: note.avatar_url },
    site: { name: c.env.APP_NAME || 'Inkstone' },
    share: { slug },
  }
  return c.json(body_)
})


sharePageRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const url = new URL(c.req.url)

  if (!isValidSlug(slug)) {
    return renderShareShell(c, url, null)
  }

  const row = await loadSharePageMeta(c.env.DB, slug)

  return renderShareShell(c, url, row)
})

async function renderShareShell(
  c: Context<AppBindings>,
  url: URL,
  row: SharePageMeta | null,
) {
  const shell = await c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)))
  if (!shell.ok) return shell
  let html = await shell.text()

  const siteName = c.env.APP_NAME || 'Inkstone'
  const expired = row?.expires_at ? row.expires_at < Date.now() : false
  const title = row && !expired && !row.password_hash ? publicShareTitle(row.title) : "Content unavailable"
  const description = row && !expired && !row.password_hash ? row.excerpt : ''

  const meta = [
    `<title>${escapeHtml(title)} · ${escapeHtml(siteName)}</title>`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
    description ? `<meta property="og:description" content="${escapeHtml(description)}" />` : '',
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="robots" content="noindex, nofollow" />`,
  ]
    .filter(Boolean)
    .join('\n    ')

  html = html.replace(/<title>[\s\S]*?<\/title>/i, '').replace('</head>', `    ${meta}\n  </head>`)

  return c.html(html, 200, {
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  })
}

export function publicShareTitle(title: string): string {
  return title || 'Untitled note'
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Registered here rather than where the instances are declared, so they sit behind the
// `requireAuth` the owner half mounts above; the public half has no auth and never will.
registerSharePresenceRoutes(shareManageRoutes)
registerSharePublicPresenceRoutes(shareRoutes)
