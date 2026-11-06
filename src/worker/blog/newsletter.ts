import type {
  AdminNewsletterSubscriber,
  BlogNewsletterStatus,
  BlogNewsletterSubscribeResult,
  BlogNewsletterList,
} from '@shared/blog/model'
import type { BlogSettings } from '@shared/blog/settings'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'
import { readEmailDeployment } from '../email/deployment'
import { sendViaProvider } from '../email/outbound'
import { loadBlogSettings } from './store'

const COOLDOWN_MS = 10 * 60 * 1000
const MAX_SOURCE_LENGTH = 40

interface SubscriberRow {
  id: string
  email: string
  email_normalized: string
  status: string
  source: string
  confirm_token_hash: string
  unsubscribe_token_hash: string
  created_at: number
  updated_at: number
  confirmed_at: number | null
  unsubscribed_at: number | null
  last_sent_at: number | null
}

function subscriber(row: SubscriberRow): AdminNewsletterSubscriber {
  return {
    id: row.id,
    email: row.email,
    status: row.status === 'confirmed' || row.status === 'unsubscribed' ? row.status : 'pending',
    source: row.source,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    unsubscribedAt: row.unsubscribed_at,
    lastSentAt: row.last_sent_at,
  }
}

export function normalizeSubscriberEmail(raw: string): { email: string; normalized: string } | null {
  const email = raw.trim().slice(0, 254)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return { email, normalized: email.toLowerCase() }
}

function source(value: string | undefined): string {
  return (value ?? '').trim().slice(0, MAX_SOURCE_LENGTH).replace(/[^A-Za-z0-9_-]/g, '') || 'footer'
}

function token(): string {
  return `${newId()}${newId()}`
}

function tokenHash(value: string): Promise<string> {
  return sha256Hex(`blog-newsletter-token|${value}`)
}

function origin(env: Env, settings: BlogSettings): string {
  const fromEnv = env.BLOG_PUBLIC_ORIGIN?.trim()
  const fromSettings = (settings.site as { url?: unknown }).url
  const candidate = fromEnv || (typeof fromSettings === 'string' ? fromSettings.trim() : '')
  return candidate.replace(/\/+$/, '')
}

function confirmationLinks(originUrl: string, confirmToken: string, unsubscribeToken: string) {
  const confirm = `${originUrl}/newsletter/confirm?token=${encodeURIComponent(confirmToken)}`
  const unsubscribe = `${originUrl}/newsletter/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`
  return { confirm, unsubscribe }
}

async function senderAddress(env: Env, userId: string): Promise<string | null> {
  const deployment = await readEmailDeployment(env.DB)
  const account = await env.DB
    .prepare(`SELECT address FROM email_accounts WHERE user_id = ?1 AND address != '' ORDER BY created_at, id LIMIT 1`)
    .bind(userId)
    .first<{ address: string }>()
  return deployment?.resendFrom.trim() || account?.address.trim() || null
}

async function sendingReady(env: Env): Promise<boolean> {
  const deployment = await readEmailDeployment(env.DB)
  if (deployment?.provider === 'resend') return Boolean(deployment.resendKeyCiphertext)
  return Boolean(env.EMAIL)
}

async function sendConfirmation(
  env: Env,
  userId: string,
  settings: BlogSettings,
  email: string,
  confirmToken: string,
  unsubscribeToken: string,
): Promise<BlogNewsletterSubscribeResult['delivery']> {
  if (!(await sendingReady(env))) return 'unavailable'
  const from = await senderAddress(env, userId)
  const originUrl = origin(env, settings)
  if (!from || !originUrl) return 'unavailable'
  const siteTitle = ((settings.site as { title?: unknown }).title as string | undefined)?.trim() || 'Inkstone'
  try {
    const links = confirmationLinks(originUrl, confirmToken, unsubscribeToken)
    await sendViaProvider(env, userId, {
      to: email,
      from,
      subject: `Confirm your subscription · ${siteTitle}`,
      text: [
        `You asked to receive updates from ${siteTitle}.`,
        `Confirm your subscription: ${links.confirm}`,
        '',
        `If this was not you, ignore this message.`,
        `Unsubscribe: ${links.unsubscribe}`,
      ].join('\n'),
    })
    return 'sent'
  } catch (error) {
    console.warn('[inkstone] newsletter confirmation email failed:', (error as Error).message)
    return 'failed'
  }
}

export async function subscribeNewsletter(
  env: Env,
  userId: string,
  rawEmail: string,
  rawSource: string | undefined,
  now = Date.now(),
): Promise<BlogNewsletterSubscribeResult> {
  const parsed = normalizeSubscriberEmail(rawEmail)
  if (!parsed) throw new Error('newsletter_invalid_email')
  const existing = await env.DB
    .prepare(`SELECT * FROM blog_newsletter_subscribers WHERE user_id = ?1 AND email_normalized = ?2`)
    .bind(userId, parsed.normalized)
    .first<SubscriberRow>()
  if (existing?.status === 'confirmed') {
    return { status: 'confirmed', emailSent: false, delivery: 'already_confirmed' }
  }
  if (existing?.status === 'pending' && now - existing.updated_at < COOLDOWN_MS) {
    return { status: 'pending', emailSent: false, delivery: 'cooldown' }
  }
  const confirmToken = token()
  const unsubscribeToken = token()
  const confirmHash = await tokenHash(confirmToken)
  const unsubscribeHash = await tokenHash(unsubscribeToken)
  const id = existing?.id ?? newId()
  if (existing) {
    await env.DB
      .prepare(
        `UPDATE blog_newsletter_subscribers
            SET email = ?3, status = 'pending', source = ?4, confirm_token_hash = ?5,
                unsubscribe_token_hash = ?6, updated_at = ?7, confirmed_at = NULL, unsubscribed_at = NULL,
                last_sent_at = NULL
          WHERE user_id = ?1 AND id = ?2`,
      )
      .bind(userId, id, parsed.email, source(rawSource), confirmHash, unsubscribeHash, now)
      .run()
  } else {
    await env.DB
      .prepare(
        `INSERT INTO blog_newsletter_subscribers (
           id, user_id, email, email_normalized, status, source, confirm_token_hash,
           unsubscribe_token_hash, created_at, updated_at, confirmed_at, unsubscribed_at, last_sent_at
         ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?8, NULL, NULL, NULL)`,
      )
      .bind(id, userId, parsed.email, parsed.normalized, source(rawSource), confirmHash, unsubscribeHash, now)
      .run()
  }
  const settings = await loadBlogSettings(env.DB, userId)
  const delivery = await sendConfirmation(env, userId, settings, parsed.email, confirmToken, unsubscribeToken)
  if (delivery === 'sent') {
    await env.DB
      .prepare(`UPDATE blog_newsletter_subscribers SET last_sent_at = ?3 WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, id, now)
      .run()
  }
  return { status: 'pending', emailSent: delivery === 'sent', delivery }
}

export async function confirmNewsletter(
  env: Env,
  userId: string,
  rawToken: string,
): Promise<{ status: BlogNewsletterStatus | 'invalid'; already: boolean }> {
  const hash = await tokenHash(rawToken.trim())
  const row = await env.DB
    .prepare(
      `SELECT * FROM blog_newsletter_subscribers
        WHERE user_id = ?1 AND confirm_token_hash = ?2 AND confirm_token_hash != ''`,
    )
    .bind(userId, hash)
    .first<SubscriberRow>()
  if (!row || row.status === 'unsubscribed') return { status: 'invalid', already: false }
  if (row.status === 'confirmed') return { status: 'confirmed', already: true }
  await env.DB
    .prepare(
      `UPDATE blog_newsletter_subscribers
          SET status = 'confirmed', confirmed_at = ?3, unsubscribed_at = NULL, updated_at = ?3
        WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, row.id, Date.now())
    .run()
  return { status: 'confirmed', already: false }
}

export async function unsubscribeNewsletter(
  env: Env,
  userId: string,
  rawToken: string,
): Promise<{ status: BlogNewsletterStatus | 'invalid'; already: boolean }> {
  const hash = await tokenHash(rawToken.trim())
  const row = await env.DB
    .prepare(
      `SELECT * FROM blog_newsletter_subscribers
        WHERE user_id = ?1 AND unsubscribe_token_hash = ?2 AND unsubscribe_token_hash != ''`,
    )
    .bind(userId, hash)
    .first<SubscriberRow>()
  if (!row) return { status: 'invalid', already: false }
  if (row.status === 'unsubscribed') return { status: 'unsubscribed', already: true }
  await env.DB
    .prepare(
      `UPDATE blog_newsletter_subscribers
          SET status = 'unsubscribed', unsubscribed_at = ?3, updated_at = ?3
        WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, row.id, Date.now())
    .run()
  return { status: 'unsubscribed', already: false }
}

export interface NewsletterQuery {
  status: BlogNewsletterStatus | 'all'
  q: string
}

export async function listNewsletterSubscribers(
  db: D1Database,
  userId: string,
  query: NewsletterQuery,
  page: number,
  limit: number,
): Promise<BlogNewsletterList> {
  const safeLimit = Math.min(Math.max(limit, 1), 100)
  const offset = (Math.max(page, 1) - 1) * safeLimit
  const where = newsletterWhere(query, userId)
  const [rows, total, counts] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM blog_newsletter_subscribers
          WHERE ${where.sql}
          ORDER BY created_at DESC, id
          LIMIT ?${where.binds.length + 1} OFFSET ?${where.binds.length + 2}`,
      )
      .bind(...where.binds, safeLimit, offset)
      .all<SubscriberRow>(),
    db
      .prepare(`SELECT COUNT(*) AS total FROM blog_newsletter_subscribers WHERE ${where.sql}`)
      .bind(...where.binds)
      .first<{ total: number }>(),
    newsletterCounts(db, userId),
  ])
  return { items: rows.results.map(subscriber), total: total?.total ?? 0, counts }
}

export async function newsletterCounts(
  db: D1Database,
  userId: string,
): Promise<Record<BlogNewsletterStatus, number>> {
  const { results } = await db
    .prepare(
      `SELECT status, COUNT(*) AS total FROM blog_newsletter_subscribers
        WHERE user_id = ?1 GROUP BY status`,
    )
    .bind(userId)
    .all<{ status: BlogNewsletterStatus; total: number }>()
  const counts: Record<BlogNewsletterStatus, number> = { pending: 0, confirmed: 0, unsubscribed: 0 }
  for (const row of results) {
    if (row.status in counts) counts[row.status] = row.total
  }
  return counts
}

function newsletterWhere(query: NewsletterQuery, userId: string): { sql: string; binds: unknown[] } {
  const clauses: string[] = ['user_id = ?1']
  const binds: unknown[] = [userId]
  if (query.status !== 'all') {
    clauses.push(`status = ?${binds.length + 1}`)
    binds.push(query.status)
  }
  const needle = query.q.trim().slice(0, 200).toLowerCase()
  if (needle) {
    clauses.push(`email_normalized LIKE ?${binds.length + 1}`)
    binds.push(`%${needle}%`)
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', binds }
}

export async function exportNewsletterSubscribers(
  db: D1Database,
  userId: string,
  query: NewsletterQuery,
): Promise<AdminNewsletterSubscriber[]> {
  const where = newsletterWhere(query, userId)
  const { results } = await db
    .prepare(
      `SELECT * FROM blog_newsletter_subscribers
        WHERE ${where.sql}
        ORDER BY created_at DESC, id
        LIMIT 50000`,
    )
    .bind(...where.binds)
    .all<SubscriberRow>()
  return results.map(subscriber)
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

export function newsletterCsv(rows: AdminNewsletterSubscriber[]): string {
  const header = ['email', 'status', 'source', 'created_at', 'confirmed_at', 'unsubscribed_at', 'last_sent_at']
  const iso = (value: number | null): string => value ? new Date(value).toISOString() : ''
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push([
      row.email, row.status, row.source, iso(row.createdAt), iso(row.confirmedAt),
      iso(row.unsubscribedAt), iso(row.lastSentAt),
    ].map(csvCell).join(','))
  }
  return lines.join('\r\n')
}

export async function rotateConfirmationToken(
  env: Env,
  userId: string,
  subscriberId: string,
): Promise<{ url: string }> {
  const row = await env.DB
    .prepare(`SELECT * FROM blog_newsletter_subscribers WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, subscriberId)
    .first<SubscriberRow>()
  if (!row) throw new Error('newsletter_missing')
  if (row.status !== 'pending') throw new Error('newsletter_not_pending')
  const settings = await loadBlogSettings(env.DB, userId)
  const originUrl = origin(env, settings)
  if (!originUrl) throw new Error('newsletter_origin_missing')
  const confirmToken = token()
  const confirmHash = await tokenHash(confirmToken)
  await env.DB
    .prepare(
      `UPDATE blog_newsletter_subscribers SET confirm_token_hash = ?3, updated_at = ?4
        WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, row.id, confirmHash, Date.now())
    .run()
  return { url: `${originUrl}/newsletter/confirm?token=${encodeURIComponent(confirmToken)}` }
}
