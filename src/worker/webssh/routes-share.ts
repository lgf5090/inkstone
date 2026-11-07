// The share surface of a recording, in two halves.
//
// The owner half lives under `/api/webssh` behind `requireAuth`: it mints, updates and revokes one
// link per recording. The public half lives under `/api/public/webssh` with no session at all — the
// slug is the capability — and it can only read: first the gate, which checks expiry, the view cap
// and the passcode and issues a short-lived token, then byte slices or the whole cast.
//
// Neither half ever answers with the session, host, account or R2 key. The public metadata is the
// recording's shape (format, size, duration, dimensions, timestamps) and the link's own facts.

import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { LIMITS } from '@shared/constants'
import type {
  WebsshPublicShareFrames,
  WebsshPublicShareView,
  WebsshShareView,
} from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import {
  JSON_BODY_LIMITS,
  readJson,
  readOptionalJson,
  requestClientIp,
} from '../lib/request'
import {
  createShareAssetSession,
  shareAssetCookieName,
  verifyShareAssetSession,
} from '../lib/share-asset-session'
import { recordAudit } from './audit'
import { loadSessionRecording, loadRecordingById, requireReadyRecording, type RecordingRow } from './recording/repository'
import { parseSliceBounds, readCastSlice } from './recording/slice'
import {
  assertSharePasscode,
  claimShareView,
  createShare,
  findShareByRecording,
  findShareBySlug,
  normalizeMaxViews,
  normalizeShareTitle,
  purgeShareRow,
  revokeShare,
  shareExpiry,
  shareIsLive,
  sharePasswordHash,
  shareTokenExpiry,
  shareView,
  updateShare,
  type ShareRow,
} from './shares'

const SHARE_COOKIE_PATH = '/api/public/webssh/'
const PUBLIC_CONTENT_MAX_BYTES = 64 * 1024 * 1024

export const websshShareRoutes = new Hono<AppBindings>()
export const websshPublicShareRoutes = new Hono<AppBindings>()

const gateBudget = createMinuteBudget(20, 'Too many opens of this link')
const readBudget = createMinuteBudget(600, 'Too many replay reads of this link')

function expiryInput(value: unknown): { named: boolean; expiresIn: number | null } {
  if (value === undefined) return { named: false, expiresIn: null }
  if (value === null) return { named: true, expiresIn: 0 }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw ApiError.badRequest('expiresIn must be a non-negative number or null')
  }
  return { named: true, expiresIn: value }
}

websshShareRoutes.get('/sessions/:id/recording/share', async (c) => {
  const userId = c.get('userId')
  const recording = await loadSessionRecording(c.env, userId, c.req.param('id'))
  const row = await findShareByRecording(c.env.DB, userId, recording.id)
  const origin = new URL(c.req.url).origin
  return c.json<{ share: WebsshShareView | null }>({ share: row ? shareView(row, origin) : null })
})

websshShareRoutes.post('/sessions/:id/recording/share', async (c) => {
  const userId = c.get('userId')
  const recording = await loadSessionRecording(c.env, userId, c.req.param('id'))
  requireReadyRecording(recording)
  const body = await readJson<{
    title?: unknown
    password?: unknown
    expiresIn?: unknown
    maxViews?: unknown
    rotate?: unknown
  }>(c, JSON_BODY_LIMITS.small)

  const now = Date.now()
  const current = await findShareByRecording(c.env.DB, userId, recording.id)
  const password = await sharePasswordHash(body.password)
  const expiry = expiryInput(body.expiresIn)
  const title = normalizeShareTitle(body.title, current?.title ?? '')
  const maxViews = normalizeMaxViews(body.maxViews, current?.max_views ?? 0)
  const fallbackExpiry = current && current.expires_at > now ? current.expires_at : recording.expires_at
  const expiresAt = expiry.named ? shareExpiry(recording.expires_at, expiry.expiresIn, now) : fallbackExpiry
  if (expiresAt <= now) throw ApiError.conflict('This recording expires too soon to be shared')

  const passcodeHash = password.named ? password.hash ?? '' : current?.passcode_hash ?? ''
  const row = current
    ? await updateShare(c.env.DB, current, {
      title,
      passcodeHash,
      expiresAt,
      maxViews,
      rotate: body.rotate === true,
    })
    : await createShare(c.env.DB, {
      userId,
      recordingId: recording.id,
      title,
      passcodeHash,
      expiresAt,
      maxViews,
      now,
    })
  if (!row) throw new ApiError(409, 'conflict', 'Share state changed. Refresh and try again')

  void recordAudit(c.env.DB, {
    userId,
    sessionId: recording.session_id,
    hostId: recording.host_id,
    eventType: 'share_create',
    metadata: { recordingId: recording.id, hasPassword: row.passcode_hash !== '', maxViews, expiresAt },
    now,
  }).catch(() => undefined)
  return c.json<{ share: WebsshShareView }>({ share: shareView(row, new URL(c.req.url).origin) })
})

websshShareRoutes.delete('/sessions/:id/recording/share', async (c) => {
  const userId = c.get('userId')
  const recording = await loadSessionRecording(c.env, userId, c.req.param('id'))
  const revoked = await revokeShare(c.env.DB, userId, recording.id)
  if (revoked) {
    void recordAudit(c.env.DB, {
      userId,
      sessionId: recording.session_id,
      hostId: recording.host_id,
      eventType: 'share_revoke',
      metadata: { recordingId: recording.id },
    }).catch(() => undefined)
  }
  return c.json({ ok: true })
})

/**
 * The one read that opens a link. It answers the link's and the recording's public facts, sets the
 * read token and counts the view atomically. A link past its cap, expired, revoked or whose recording
 * is gone is a plain 404 — a stranger learns nothing about why.
 */
websshPublicShareRoutes.post('/shares/:slug', async (c) => {
  const slug = c.req.param('slug')
  const ip = requestClientIp(c)
  gateBudget(`${slug}:${ip}`)
  const body = await readOptionalJson<{ password?: unknown }>(c, JSON_BODY_LIMITS.small, {})
  const password = typeof body.password === 'string'
    ? body.password.slice(0, LIMITS.passwordMaxLength)
    : ''

  const now = Date.now()
  const share = await loadPublicShare(c, slug, now)
  await assertSharePasscode(c.env.DB, slug, ip, share.share, password)

  if (!(await claimShareView(c.env.DB, slug, now))) {
    throw ApiError.notFound('The link does not exist or has been revoked')
  }
  const tokenExpiry = shareTokenExpiry(share.share, now)
  if (tokenExpiry <= now) throw ApiError.notFound('The link does not exist or has been revoked')
  const token = await createShareAssetSession(
    c.env.DB,
    slug,
    share.share.passcode_hash || null,
    tokenExpiry,
  )
  setCookie(c, shareAssetCookieName(slug), token, {
    path: SHARE_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: Math.max(1, Math.floor((tokenExpiry - now) / 1000)),
    secure: new URL(c.req.url).protocol === 'https:',
  })

  void recordAudit(c.env.DB, {
    userId: share.share.user_id,
    sessionId: share.recording.session_id,
    hostId: share.recording.host_id,
    eventType: 'share_access',
    metadata: { recordingId: share.recording.id, action: 'open' },
    now,
  }).catch(() => undefined)
  return c.json<WebsshPublicShareView>({
    share: {
      slug: share.share.slug,
      title: share.share.title,
      createdAt: Number(share.share.created_at),
      expiresAt: Number(share.share.expires_at),
      maxViews: Number(share.share.max_views),
      views: Number(share.share.views) + 1,
    },
    recording: {
      format: 'cast',
      sizeBytes: Number(share.recording.size_bytes),
      durationMs: Number(share.recording.duration_ms),
      cols: Number(share.recording.cols),
      rows: Number(share.recording.rows),
      createdAt: Number(share.recording.created_at),
      finalizedAt: share.recording.finalized_at === null ? null : Number(share.recording.finalized_at),
    },
  })
})

/** One byte-addressed slice, bounded and token-gated exactly like the owner-side replay. */
websshPublicShareRoutes.get('/shares/:slug/frames', async (c) => {
  const slug = c.req.param('slug')
  const ip = requestClientIp(c)
  readBudget(`${slug}:${ip}`)
  const share = await loadPublicShare(c, slug, Date.now())
  await requireShareToken(c, slug, share.share)
  const bucket = c.env.FILES
  if (!bucket) throw new ApiError(503, 'storage_unavailable', 'The recording store is not bound')

  const { offset, limit } = parseSliceBounds(c.req.query('offset'), c.req.query('limit'))
  const slice = await readCastSlice(bucket, share.recording.r2_key, offset, limit)
  if (!slice) throw ApiError.notFound('The recording object is missing')
  return c.json<WebsshPublicShareFrames>({
    offset,
    startOffset: slice.startOffset,
    nextOffset: slice.nextOffset,
    totalSize: slice.totalSize,
    complete: slice.complete,
    ...(slice.header ? { header: slice.header } : {}),
    frames: slice.frames,
  })
})

/**
 * The whole cast as a stream. Public reads get a hard size ceiling rather than an unbounded
 * pass-through: a link is handed out, so one anonymous request should not pull an arbitrarily large
 * object. Frames remain available for a larger recording.
 */
websshPublicShareRoutes.get('/shares/:slug/content', async (c) => {
  const slug = c.req.param('slug')
  const ip = requestClientIp(c)
  readBudget(`${slug}:${ip}`)
  const share = await loadPublicShare(c, slug, Date.now())
  await requireShareToken(c, slug, share.share)
  const bucket = c.env.FILES
  if (!bucket) throw new ApiError(503, 'storage_unavailable', 'The recording store is not bound')

  const head = await bucket.head(share.recording.r2_key)
  if (!head) throw ApiError.notFound('The recording object is missing')
  if (head.size > PUBLIC_CONTENT_MAX_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'This recording is too large to stream; read it in frames', {
      sizeBytes: head.size,
      maxBytes: PUBLIC_CONTENT_MAX_BYTES,
    })
  }
  const object = await bucket.get(share.recording.r2_key)
  if (!object) throw ApiError.notFound('The recording object is missing')
  return new Response(object.body, {
    headers: {
      'content-type': 'application/x-asciicast',
      'content-length': String(object.size),
      'cache-control': 'no-store',
    },
  })
})

interface PublicShare {
  share: ShareRow
  recording: RecordingRow
}

/**
 * The link and its recording, both still live. Expiry is authoritative on the share row; the
 * recording is read through the repository so an expired or already-deleted object is purged the same
 * way the owner route purges it.
 */
async function loadPublicShare(c: Context<AppBindings>, slug: string, now: number): Promise<PublicShare> {
  const share = await findShareBySlug(c.env.DB, slug)
  if (!share || !shareIsLive(share, now)) {
    throw ApiError.notFound('The link does not exist or has been revoked')
  }
  const recording = await loadRecordingById(c.env, share.user_id, share.recording_id)
  if (!recording || recording.status !== 'ready') {
    await purgeShareRow(c.env.DB, share.slug).catch(() => undefined)
    throw ApiError.notFound('The link does not exist or has been revoked')
  }
  return { share, recording }
}

function tokenOf(c: Context<AppBindings>, slug: string): string | undefined {
  const authorization = c.req.header('authorization') ?? ''
  const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(authorization)
  if (match) return match[1]
  return getCookie(c, shareAssetCookieName(slug))
}

/** Reads need a token from a passed gate, which is what makes the view cap and passcode hold. */
async function requireShareToken(c: Context<AppBindings>, slug: string, share: ShareRow): Promise<void> {
  const valid = await verifyShareAssetSession(c.env.DB, tokenOf(c, slug), slug, share.passcode_hash || null)
  if (!valid) throw ApiError.unauthenticated('Open the share link before reading the recording')
}
