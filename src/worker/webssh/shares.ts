// Public replay links for session recordings. A share is a capability: the slug is the whole of what
// a visitor knows, and it resolves to exactly one recording owned by the account that made it.
//
// The link never publishes the session: no recording id, session id, host id, account id, R2 key,
// host address or credential is part of any public answer. What it publishes is the cast file, and
// only after the link is enabled, unexpired, under its view cap and — when a passcode is set — past
// the same scrypt check and two-level throttle the notes app uses.
//
// A share's life is tied to its recording's: retention deletes the link in the same sweep that marks
// the recording gone, so a link can never outlive the object it points at.

import { LIMITS } from '@shared/constants'
import { sharePasscodeProblem } from '@shared/share-passcode'
import type { WebsshShareView } from '@shared/webssh/types'
import { ApiError } from '../lib/errors'
import { isValidId, isValidSlug, newSlug } from '../lib/id'
import { hashPassword, verifyPassword } from '../lib/password'
import {
  assertAttemptBudget,
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
} from '../lib/throttle'

export interface ShareRow {
  slug: string
  user_id: string
  recording_id: string
  title: string
  passcode_hash: string
  expires_at: number
  max_views: number
  views: number
  is_enabled: number
  created_at: number
  last_viewed_at: number | null
}

const SHARE_COLUMNS =
  'slug, user_id, recording_id, title, passcode_hash, expires_at, max_views, views, is_enabled, created_at, last_viewed_at'

const MAX_SHARE_TITLE = 200
const MAX_SHARE_VIEWS = 1_000_000
const MAX_SHARE_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000
const SHARE_ACCESS_TOKEN_MS = 12 * 60 * 60 * 1000
const SHARE_PURGE_BATCH = 100

export function shareView(row: ShareRow, origin: string): WebsshShareView {
  return {
    slug: row.slug,
    recordingId: row.recording_id,
    title: row.title,
    url: `${origin}/w/${row.slug}`,
    hasPassword: row.passcode_hash !== '',
    expiresAt: Number(row.expires_at),
    maxViews: Number(row.max_views),
    views: Number(row.views),
    isEnabled: row.is_enabled !== 0,
    createdAt: Number(row.created_at),
    lastViewedAt: row.last_viewed_at === null ? null : Number(row.last_viewed_at),
  }
}

/** The link this account has on one recording, if any. At most one live link is made per recording. */
export async function findShareByRecording(
  db: D1Database,
  userId: string,
  recordingId: string,
): Promise<ShareRow | null> {
  if (!isValidId(recordingId)) return null
  return await db
    .prepare(
      `SELECT ${SHARE_COLUMNS} FROM webssh_shares
        WHERE user_id = ?1 AND recording_id = ?2
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId, recordingId)
    .first<ShareRow>()
}

/** A link by its slug, for the public half. Cross-account on purpose: the slug *is* the capability. */
export async function findShareBySlug(db: D1Database, slug: string): Promise<ShareRow | null> {
  if (!isValidSlug(slug)) return null
  return await db
    .prepare(`SELECT ${SHARE_COLUMNS} FROM webssh_shares WHERE slug = ?1`)
    .bind(slug)
    .first<ShareRow>()
}

export interface CreateShareInput {
  userId: string
  recordingId: string
  title: string
  passcodeHash: string
  expiresAt: number
  maxViews: number
  now: number
}

export async function createShare(db: D1Database, input: CreateShareInput): Promise<ShareRow> {
  const row: ShareRow = {
    slug: newSlug(),
    user_id: input.userId,
    recording_id: input.recordingId,
    title: input.title,
    passcode_hash: input.passcodeHash,
    expires_at: input.expiresAt,
    max_views: input.maxViews,
    views: 0,
    is_enabled: 1,
    created_at: input.now,
    last_viewed_at: null,
  }
  await db
    .prepare(
      `INSERT INTO webssh_shares
         (slug, user_id, recording_id, title, passcode_hash, expires_at, max_views, views, is_enabled, created_at, last_viewed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 1, ?8, NULL)`,
    )
    .bind(
      row.slug,
      row.user_id,
      row.recording_id,
      row.title,
      row.passcode_hash,
      row.expires_at,
      row.max_views,
      row.created_at,
    )
    .run()
  return row
}

export interface UpdateShareInput {
  title: string
  passcodeHash: string
  expiresAt: number
  maxViews: number
  rotate: boolean
}

/** Conditional columns keep a field the request did not name, exactly as the notes share upsert does. */
export async function updateShare(
  db: D1Database,
  current: ShareRow,
  input: UpdateShareInput,
): Promise<ShareRow | null> {
  const slug = input.rotate ? newSlug() : current.slug
  const result = await db
    .prepare(
      `UPDATE webssh_shares SET slug = ?3, title = ?4, passcode_hash = ?5, expires_at = ?6, max_views = ?7
        WHERE slug = ?1 AND user_id = ?2`,
    )
    .bind(
      current.slug,
      current.user_id,
      slug,
      input.title,
      input.passcodeHash,
      input.expiresAt,
      input.maxViews,
    )
    .run()
  if ((result.meta?.changes ?? 0) === 0) return null
  if (slug !== current.slug) await deleteShareTokens(db, current.slug)
  return { ...current, slug, title: input.title, passcode_hash: input.passcodeHash, expires_at: input.expiresAt, max_views: input.maxViews }
}

/** Revoking removes the row, so the slug stops resolving anywhere; issued tokens are dropped too. */
export async function revokeShare(db: D1Database, userId: string, recordingId: string): Promise<ShareRow | null> {
  const current = await findShareByRecording(db, userId, recordingId)
  if (!current) return null
  await db.batch([
    db.prepare(`DELETE FROM share_asset_sessions WHERE slug = ?1`).bind(current.slug),
    db.prepare(`DELETE FROM webssh_shares WHERE slug = ?1 AND user_id = ?2`).bind(current.slug, userId),
  ])
  return current
}

async function deleteShareTokens(db: D1Database, slug: string): Promise<void> {
  await db.prepare(`DELETE FROM share_asset_sessions WHERE slug = ?1`).bind(slug).run()
}

/** Drops one link and the tokens it issued; used when its recording can no longer replay. */
export async function purgeShareRow(db: D1Database, slug: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM share_asset_sessions WHERE slug = ?1`).bind(slug),
    db.prepare(`DELETE FROM webssh_shares WHERE slug = ?1`).bind(slug),
  ])
}

/**
 * One open counted atomically. The update itself decides whether the view cap still allows it, so
 * two visitors arriving together cannot both slip past the last slot.
 */
export async function claimShareView(db: D1Database, slug: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE webssh_shares SET views = views + 1, last_viewed_at = ?2
        WHERE slug = ?1 AND is_enabled = 1 AND (max_views = 0 OR views < max_views)`,
    )
    .bind(slug, now)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

export function shareIsLive(row: ShareRow, now: number): boolean {
  return row.is_enabled !== 0 && row.expires_at > 0 && row.expires_at > now
}

/** The access token a passed gate issues; bounded by both the share and a twelve-hour shift. */
export function shareTokenExpiry(row: ShareRow, now: number): number {
  return Math.min(row.expires_at, now + SHARE_ACCESS_TOKEN_MS)
}

/** A passcode the owner set, after the shared rules. `named` is the route's "was the field sent". */
export async function sharePasswordHash(password: unknown): Promise<{ hash: string | null; named: boolean }> {
  if (password === undefined) return { hash: null, named: false }
  if (password !== null && typeof password !== 'string') throw ApiError.badRequest('password must be a string or null')
  const problem = sharePasscodeProblem(password as string | null)
  if (problem) throw ApiError.badRequest(problem)
  if (password === null || password === '') return { hash: null, named: true }
  return { hash: await hashPassword((password as string).slice(0, LIMITS.passwordMaxLength)), named: true }
}

/** The owner's `expiresIn` in milliseconds, clamped to what the recording itself may still live. */
export function shareExpiry(recordingExpiresAt: number, expiresIn: number | null, now: number): number {
  if (expiresIn === null || expiresIn === 0) return recordingExpiresAt
  return Math.min(now + Math.min(expiresIn, MAX_SHARE_EXPIRY_MS), recordingExpiresAt)
}

export function normalizeShareTitle(value: unknown, current = ''): string {
  if (value === undefined) return current
  if (typeof value !== 'string') throw ApiError.badRequest('title must be a string')
  return value.trim().slice(0, MAX_SHARE_TITLE)
}

export function normalizeMaxViews(value: unknown, current = 0): number {
  if (value === undefined) return current
  if (value === null) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SHARE_VIEWS) {
    throw ApiError.badRequest(`maxViews must be an integer between 0 and ${MAX_SHARE_VIEWS}`)
  }
  return value
}

/**
 * The passcode gate of the public read, mirroring the notes and conversation shares: one throttle
 * per visitor per link and one per link, so a hostile client cannot spend the link's whole budget.
 */
export async function assertSharePasscode(
  db: D1Database,
  slug: string,
  ip: string,
  row: ShareRow,
  password: string,
): Promise<void> {
  if (!row.passcode_hash) return
  if (!password) throw ApiError.unauthenticated('An access password is required')
  const lockTargets = [`webssh-share:${slug}:ip:${ip}`]
  const workTargets = [
    { key: `webssh-share-work:${slug}:ip:${ip}`, maxAttempts: 8, windowMs: 10 * 60 * 1000 },
    { key: `webssh-share-work:${slug}`, maxAttempts: 60, windowMs: 10 * 60 * 1000, lockMs: 60_000 },
  ]
  await assertAttemptBudget(async () => {
    await assertNotLocked(db, lockTargets)
    await consumeAttemptBudget(db, workTargets)
  })
  if (!(await verifyPassword(password, row.passcode_hash))) {
    await recordLoginFailure(db, lockTargets)
    throw new ApiError(401, 'invalid_credentials', 'Incorrect passcode')
  }
  await clearLoginFailures(db, [...lockTargets, ...workTargets.map((target) => target.key)])
}

/** Drops every link of one recording, called by the same sweep that removes the recording. */
export async function deleteSharesForRecording(db: D1Database, recordingId: string): Promise<number> {
  const result = await db.batch([
    db
      .prepare(
        `DELETE FROM share_asset_sessions
          WHERE slug IN (SELECT slug FROM webssh_shares WHERE recording_id = ?1)`,
      )
      .bind(recordingId),
    db.prepare(`DELETE FROM webssh_shares WHERE recording_id = ?1`).bind(recordingId),
  ])
  return Number(result[1]?.meta?.changes ?? 0)
}

/**
 * Expired links and links whose recording is already gone. Bounded per fire and safe to re-run: the
 * second pass finds nothing.
 */
export async function purgeExpiredShares(
  db: D1Database,
  now: number,
  limit = SHARE_PURGE_BATCH,
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT s.slug FROM webssh_shares s
         LEFT JOIN webssh_recordings r ON r.id = s.recording_id AND r.user_id = s.user_id
        WHERE (s.expires_at > 0 AND s.expires_at <= ?1)
           OR r.id IS NULL
           OR r.status = 'deleted'
           OR r.deleted_at IS NOT NULL
        ORDER BY s.expires_at ASC
        LIMIT ?2`,
    )
    .bind(now, Math.max(1, limit))
    .all<{ slug: string }>()
  const slugs = (rows.results ?? []).map((row) => row.slug)
  if (!slugs.length) return 0
  const placeholders = slugs.map((_, index) => `?${index + 1}`).join(', ')
  await db.batch([
    db.prepare(`DELETE FROM share_asset_sessions WHERE slug IN (${placeholders})`).bind(...slugs),
    db.prepare(`DELETE FROM webssh_shares WHERE slug IN (${placeholders})`).bind(...slugs),
  ])
  return slugs.length
}
