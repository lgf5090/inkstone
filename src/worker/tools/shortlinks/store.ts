/**
 * D1 database storage implementation for Short Links tool (`tools_shortlinks_*`).
 * Enforces multi-tenant isolation via user_id on all operations.
 */

import type {
  BreakdownPage,
  BundleAccent,
  BundleStats,
  BundleStatsPerLink,
  ClickData,
  ClickStats,
  DashboardStats,
  ShortLink,
  ShortLinkBundle,
  ShortLinkSlug,
  ShortlinkApiKey,
  ShortlinkBackup,
  ShortlinksSettings,
  TimelineData,
  TimelineRange,
} from '@shared/tools/shortlinks/types'
import {
  DEFAULT_SLUG_LENGTH,
  DEFAULT_TIMELINE_RANGE,
} from '@shared/tools/shortlinks/types'
import { ApiError } from '../../lib/errors'
import { hashPassword } from '../../lib/password'
import {
  computeDelta,
  fillBuckets,
  fillMissingOptions,
  formatAvgPerDay,
  rangeToSinceTs,
} from './analytics'
import {
  getShortlinksBackupR2Key,
  getShortlinksExportCsvR2Key,
  getShortlinksExportTxtR2Key,
  uploadShortlinksFileToR2,
} from './r2'
import { PASSWORD_ATTEMPT_LIMIT, PASSWORD_ATTEMPT_WINDOW_SECONDS } from './password-gate'
import { generateUniqueSlug, validateCustomSlug } from './slugs'
import { fetchPageTitle } from './title-fetch'

export function normalizeUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/[?#]+$/, '')
}

function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${guarded.replace(/"/g, '""')}"`
}

export class ShortlinksStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async getSettings(): Promise<ShortlinksSettings> {
    const row = await this.db
      .prepare('SELECT * FROM tools_shortlinks_settings WHERE user_id = ?')
      .bind(this.userId)
      .first<{
        user_id: string
        slug_default_length: number
        default_range: string
        filter_bots: number
        filter_self_referrers: number
        updated_at: number
      }>()

    if (!row) {
      return {
        slug_default_length: DEFAULT_SLUG_LENGTH,
        default_range: DEFAULT_TIMELINE_RANGE,
        filter_bots: true,
        filter_self_referrers: true,
        updated_at: Math.floor(Date.now() / 1000),
      }
    }

    return {
      slug_default_length: row.slug_default_length,
      default_range: (row.default_range as TimelineRange) || DEFAULT_TIMELINE_RANGE,
      filter_bots: Boolean(row.filter_bots),
      filter_self_referrers: Boolean(row.filter_self_referrers),
      updated_at: row.updated_at,
    }
  }

  async updateSettings(settings: Partial<ShortlinksSettings>): Promise<ShortlinksSettings> {
    const current = await this.getSettings()
    const updated: ShortlinksSettings = {
      ...current,
      ...settings,
      updated_at: Math.floor(Date.now() / 1000),
    }

    await this.db
      .prepare(
        `INSERT INTO tools_shortlinks_settings (user_id, slug_default_length, default_range, filter_bots, filter_self_referrers, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           slug_default_length = excluded.slug_default_length,
           default_range = excluded.default_range,
           filter_bots = excluded.filter_bots,
           filter_self_referrers = excluded.filter_self_referrers,
           updated_at = excluded.updated_at`,
      )
      .bind(
        this.userId,
        updated.slug_default_length,
        updated.default_range,
        updated.filter_bots ? 1 : 0,
        updated.filter_self_referrers ? 1 : 0,
        updated.updated_at,
      )
      .run()

    return updated
  }

  // -------------------------------------------------------------------------
  // Password gate throttling
  // -------------------------------------------------------------------------

  async passwordGateState(bucket: string, now: number): Promise<{ blocked: boolean; retryAfter: number }> {
    const row = await this.db
      .prepare('SELECT failures, window_start FROM tools_shortlinks_password_attempts WHERE bucket = ?')
      .bind(bucket)
      .first<{ failures: number; window_start: number }>()

    if (!row) return { blocked: false, retryAfter: 0 }
    if (row.window_start <= now - PASSWORD_ATTEMPT_WINDOW_SECONDS) return { blocked: false, retryAfter: 0 }
    if (row.failures < PASSWORD_ATTEMPT_LIMIT) return { blocked: false, retryAfter: 0 }
    return { blocked: true, retryAfter: row.window_start + PASSWORD_ATTEMPT_WINDOW_SECONDS - now }
  }

  async recordPasswordFailure(bucket: string, now: number): Promise<void> {
    const row = await this.db
      .prepare('SELECT failures, window_start FROM tools_shortlinks_password_attempts WHERE bucket = ?')
      .bind(bucket)
      .first<{ failures: number; window_start: number }>()

    if (!row || row.window_start <= now - PASSWORD_ATTEMPT_WINDOW_SECONDS) {
      await this.db
        .prepare(
          `INSERT INTO tools_shortlinks_password_attempts (bucket, failures, window_start) VALUES (?, 1, ?)
           ON CONFLICT (bucket) DO UPDATE SET failures = 1, window_start = excluded.window_start`,
        )
        .bind(bucket, now)
        .run()
      return
    }

    await this.db
      .prepare('UPDATE tools_shortlinks_password_attempts SET failures = failures + 1 WHERE bucket = ?')
      .bind(bucket)
      .run()
  }

  async clearPasswordFailures(bucket: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM tools_shortlinks_password_attempts WHERE bucket = ?')
      .bind(bucket)
      .run()
  }

  async upgradePasswordHash(linkId: number, password: string): Promise<string> {
    const hash = await hashPassword(password)
    await this.db
      .prepare('UPDATE tools_shortlinks_links SET password_hash = ? WHERE id = ? AND user_id = ?')
      .bind(hash, linkId, this.userId)
      .run()

    return hash
  }

  // -------------------------------------------------------------------------
  // Links CRUD
  // -------------------------------------------------------------------------

  async createLink(params: {
    url: string
    label?: string | null
    password?: string | null
    slug_length?: number
    expires_at?: number | null
    allow_duplicate?: boolean
    custom_slug?: string | null
    created_via?: string
  }): Promise<ShortLink> {
    const url = normalizeUrl(params.url)

    // Duplicate check
    if (!params.allow_duplicate) {
      const existing = await this.db
        .prepare('SELECT id FROM tools_shortlinks_links WHERE user_id = ? AND url = ? LIMIT 1')
        .bind(this.userId, url)
        .first<{ id: number }>()

      if (existing) {
        throw ApiError.conflict('This URL has already been shortened. Allow duplicates to create anyway.')
      }
    }

    // Determine slug
    let slug: string
    let isCustom = 0
    if (params.custom_slug) {
      const custom = params.custom_slug.trim()
      const validationErr = validateCustomSlug(custom)
      if (validationErr) {
        throw ApiError.badRequest(validationErr)
      }
      const existingSlug = await this.db
        .prepare('SELECT slug FROM tools_shortlinks_slugs WHERE slug = ? LIMIT 1')
        .bind(custom)
        .first()
      if (existingSlug) {
        throw ApiError.conflict('This slug is already in use')
      }
      slug = custom
      isCustom = 1
    } else {
      const settings = await this.getSettings()
      const len = params.slug_length || settings.slug_default_length || DEFAULT_SLUG_LENGTH
      slug = await generateUniqueSlug(this.db, len, async (db, s) => {
        const row = await db.prepare('SELECT slug FROM tools_shortlinks_slugs WHERE slug = ? LIMIT 1').bind(s).first()
        return Boolean(row)
      })
    }

    // Password hashing
    let passwordHash: string | null = null
    let isProtected = 0
    if (params.password && params.password.trim().length > 0) {
      passwordHash = await hashPassword(params.password.trim())
      isProtected = 1
    }

    const now = Math.floor(Date.now() / 1000)

    // The link row and its first slug commit together: a generated slug lost to a concurrent create
    // must not leave a link that no short code can ever resolve.
    let linkId = 0
    for (let attempt = 0; ; attempt++) {
      try {
        await this.db.batch([
          this.db
            .prepare(
              `INSERT INTO tools_shortlinks_links (user_id, url, label, password_hash, is_password_protected, created_at, expires_at, created_via, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              this.userId,
              url,
              params.label?.trim() || null,
              passwordHash,
              isProtected,
              now,
              params.expires_at ?? null,
              params.created_via || 'app',
              'user',
            ),
          this.db
            .prepare(
              `INSERT INTO tools_shortlinks_slugs (slug, user_id, link_id, is_custom, is_primary, created_at, disabled_at)
               VALUES (?, ?, last_insert_rowid(), ?, 1, ?, NULL)`,
            )
            .bind(slug, this.userId, isCustom, now),
        ])
        break
      } catch (err) {
        const retryable = !isCustom && attempt < 2 && err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
        if (!retryable) throw err
        const settings = await this.getSettings()
        const len = params.slug_length || settings.slug_default_length || DEFAULT_SLUG_LENGTH
        slug = await generateUniqueSlug(this.db, len, async (db, candidate) => {
          const row = await db.prepare('SELECT slug FROM tools_shortlinks_slugs WHERE slug = ? LIMIT 1').bind(candidate).first()
          return Boolean(row)
        })
      }
    }

    const inserted = await this.db
      .prepare('SELECT link_id FROM tools_shortlinks_slugs WHERE slug = ? AND user_id = ?')
      .bind(slug, this.userId)
      .first<{ link_id: number }>()
    if (!inserted) {
      throw new ApiError(500, 'internal', 'Link was not persisted')
    }
    linkId = inserted.link_id

    return (await this.getLinkById(linkId))!
  }

  /** Best-effort title backfill, run after the response so creating a link never waits on the target. */
  async fillMissingLabel(linkId: number): Promise<void> {
    const row = await this.db
      .prepare('SELECT url, label FROM tools_shortlinks_links WHERE id = ? AND user_id = ?')
      .bind(linkId, this.userId)
      .first<{ url: string; label: string | null }>()
    if (!row || row.label) return

    const sniffed = await fetchPageTitle(row.url, 3000)
    if (!sniffed) return
    await this.db
      .prepare('UPDATE tools_shortlinks_links SET label = ? WHERE id = ? AND user_id = ? AND label IS NULL')
      .bind(sniffed, linkId, this.userId)
      .run()
  }

  async getLinkById(id: number): Promise<ShortLink | null> {
    const linkRow = await this.db
      .prepare('SELECT * FROM tools_shortlinks_links WHERE id = ? AND user_id = ?')
      .bind(id, this.userId)
      .first<{
        id: number
        user_id: string
        url: string
        label: string | null
        password_hash: string | null
        is_password_protected: number
        created_at: number
        expires_at: number | null
        created_via: string | null
        created_by: string
      }>()

    if (!linkRow) return null

    const slugRows = await this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM tools_shortlinks_clicks c WHERE c.slug = s.slug AND c.user_id = ?) as click_count
         FROM tools_shortlinks_slugs s
         WHERE s.link_id = ? AND s.user_id = ?
         ORDER BY s.is_primary DESC, s.created_at ASC`,
      )
      .bind(this.userId, id, this.userId)
      .all<{
        slug: string
        link_id: number
        is_custom: number
        is_primary: number
        click_count: number
        created_at: number
        disabled_at: number | null
      }>()

    const slugs: ShortLinkSlug[] = (slugRows.results ?? []).map((s) => ({
      slug: s.slug,
      link_id: s.link_id,
      is_custom: Boolean(s.is_custom),
      is_primary: Boolean(s.is_primary),
      click_count: s.click_count || 0,
      created_at: s.created_at,
      disabled_at: s.disabled_at,
    }))

    const totalClicksRow = await this.db
      .prepare('SELECT COUNT(*) as count FROM tools_shortlinks_clicks WHERE link_id = ? AND user_id = ?')
      .bind(id, this.userId)
      .first<{ count: number }>()

    return {
      id: linkRow.id,
      user_id: linkRow.user_id,
      url: linkRow.url,
      label: linkRow.label,
      password_protected: Boolean(linkRow.is_password_protected),
      created_at: linkRow.created_at,
      expires_at: linkRow.expires_at,
      created_via: linkRow.created_via,
      created_by: linkRow.created_by,
      slugs,
      total_clicks: totalClicksRow?.count || 0,
    }
  }

  async listLinks(params: {
    filter?: 'all' | 'active' | 'disabled'
    status?: 'all' | 'active' | 'disabled'
    sort?: 'created_at' | 'clicks'
    sort_by?: string
    sort_order?: 'asc' | 'desc'
    bundle_id?: number
    search?: string
    range?: TimelineRange
    offset?: number
    limit?: number
  }): Promise<{ items: ShortLink[]; links: ShortLink[]; total: number }> {
    const filter = params.status || params.filter || 'all'
    const sort = params.sort_by === 'clicks' || params.sort === 'clicks' ? 'clicks' : 'created_at'
    const sortOrder = params.sort_order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const offset = Math.min(1_000_000, Math.max(0, Math.floor(params.offset || 0)))
    const limit = Math.min(100, Math.max(1, Math.floor(params.limit || 20)))
    const now = Math.floor(Date.now() / 1000)

    let whereClause = 'WHERE l.user_id = ?'
    const binds: (string | number)[] = [this.userId]

    if (filter === 'active') {
      whereClause += ' AND (l.expires_at IS NULL OR l.expires_at > ?) AND EXISTS (SELECT 1 FROM tools_shortlinks_slugs s WHERE s.link_id = l.id AND s.disabled_at IS NULL)'
      binds.push(now)
    } else if (filter === 'disabled') {
      whereClause += ' AND ((l.expires_at IS NOT NULL AND l.expires_at <= ?) OR NOT EXISTS (SELECT 1 FROM tools_shortlinks_slugs s WHERE s.link_id = l.id AND s.disabled_at IS NULL))'
      binds.push(now)
    }

    if (params.bundle_id) {
      whereClause += ' AND l.id IN (SELECT link_id FROM tools_shortlinks_bundle_links WHERE bundle_id = ? AND user_id = ?)'
      binds.push(params.bundle_id, this.userId)
    }

    if (params.search && params.search.trim().length > 0) {
      const q = `%${params.search.trim()}%`
      whereClause += ' AND (l.url LIKE ? OR l.label LIKE ? OR EXISTS (SELECT 1 FROM tools_shortlinks_slugs s WHERE s.link_id = l.id AND s.slug LIKE ?))'
      binds.push(q, q, q)
    }

    // Count total
    const countQuery = `SELECT COUNT(*) as cnt FROM tools_shortlinks_links l ${whereClause}`
    const countRow = await this.db.prepare(countQuery).bind(...binds).first<{ cnt: number }>()
    const total = countRow?.cnt || 0

    // Fetch link IDs and rows
    let orderSql = `ORDER BY l.created_at ${sortOrder}`
    if (sort === 'clicks') {
      orderSql = `ORDER BY total_clicks ${sortOrder}, l.created_at ${sortOrder}`
    }

    const sinceTs = rangeToSinceTs(params.range, now)
    const clickWindow = sinceTs === undefined ? '' : ' AND c.clicked_at >= ?'
    const clickBinds: (string | number)[] = sinceTs === undefined ? [this.userId] : [this.userId, sinceTs]

    const query = `
      SELECT l.*,
        (SELECT COUNT(*) FROM tools_shortlinks_clicks c WHERE c.link_id = l.id AND c.user_id = ?${clickWindow}) as total_clicks
      FROM tools_shortlinks_links l
      ${whereClause}
      ${orderSql}
      LIMIT ${limit} OFFSET ${offset}
    `
    const rows = await this.db.prepare(query).bind(...clickBinds, ...binds).all<{
      id: number
      user_id: string
      url: string
      label: string | null
      password_hash: string | null
      is_password_protected: number
      created_at: number
      expires_at: number | null
      created_via: string | null
      created_by: string
      total_clicks: number
    }>()

    const linkIds = (rows.results ?? []).map((r) => r.id)
    if (linkIds.length === 0) {
      return { items: [], links: [], total }
    }

    // Batch load slugs
    const placeholders = linkIds.map(() => '?').join(',')
    const slugRows = await this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM tools_shortlinks_clicks c WHERE c.slug = s.slug AND c.user_id = ?) as click_count
         FROM tools_shortlinks_slugs s
         WHERE s.link_id IN (${placeholders}) AND s.user_id = ?
         ORDER BY s.is_primary DESC, s.created_at ASC`,
      )
      .bind(this.userId, ...linkIds, this.userId)
      .all<{
        slug: string
        link_id: number
        is_custom: number
        is_primary: number
        click_count: number
        created_at: number
        disabled_at: number | null
      }>()

    const slugMap = new Map<number, ShortLinkSlug[]>()
    for (const s of slugRows.results ?? []) {
      const list = slugMap.get(s.link_id) || []
      list.push({
        slug: s.slug,
        link_id: s.link_id,
        is_custom: Boolean(s.is_custom),
        is_primary: Boolean(s.is_primary),
        click_count: s.click_count || 0,
        created_at: s.created_at,
        disabled_at: s.disabled_at,
      })
      slugMap.set(s.link_id, list)
    }

    const items: ShortLink[] = (rows.results ?? []).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      url: r.url,
      label: r.label,
      password_protected: Boolean(r.is_password_protected),
      created_at: r.created_at,
      expires_at: r.expires_at,
      created_via: r.created_via,
      created_by: r.created_by,
      slugs: slugMap.get(r.id) || [],
      total_clicks: r.total_clicks || 0,
    }))

    return { items, links: items, total }
  }

  async updateLink(
    id: number,
    data: {
      url?: string
      label?: string | null
      password?: string | null
      expires_at?: number | null
    },
  ): Promise<ShortLink> {
    const existing = await this.getLinkById(id)
    if (!existing) {
      throw ApiError.notFound('Link not found')
    }

    const updates: string[] = []
    const binds: (string | number | null)[] = []

    if (data.url !== undefined) {
      updates.push('url = ?')
      binds.push(normalizeUrl(data.url))
    }
    if (data.label !== undefined) {
      updates.push('label = ?')
      binds.push(data.label ? data.label.trim() : null)
    }
    if (data.expires_at !== undefined) {
      updates.push('expires_at = ?')
      binds.push(data.expires_at)
    }
    if (data.password !== undefined) {
      if (data.password && data.password.trim().length > 0) {
        const hash = await hashPassword(data.password.trim())
        updates.push('password_hash = ?, is_password_protected = 1')
        binds.push(hash)
      } else {
        updates.push('password_hash = NULL, is_password_protected = 0')
      }
    }

    if (updates.length > 0) {
      binds.push(id, this.userId)
      const sql = `UPDATE tools_shortlinks_links SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
      await this.db.prepare(sql).bind(...binds).run()
    }

    return (await this.getLinkById(id))!
  }

  async deleteLink(id: number): Promise<void> {
    const link = await this.getLinkById(id)
    if (!link) {
      throw ApiError.notFound('Link not found')
    }

    // Zero-click deletion guard
    const clickCountRow = await this.db
      .prepare('SELECT COUNT(*) as cnt FROM tools_shortlinks_clicks WHERE link_id = ? AND user_id = ?')
      .bind(id, this.userId)
      .first<{ cnt: number }>()

    if ((clickCountRow?.cnt || 0) > 0) {
      throw ApiError.badRequest('Cannot delete a short link with click history. Please disable it instead to preserve analytics.')
    }

    await this.db
      .prepare('DELETE FROM tools_shortlinks_links WHERE id = ? AND user_id = ?')
      .bind(id, this.userId)
      .run()
  }

  // -------------------------------------------------------------------------
  // Slugs Management
  // -------------------------------------------------------------------------

  async addSlug(linkId: number, rawSlug: string): Promise<ShortLinkSlug> {
    const owned = await this.db
      .prepare('SELECT id FROM tools_shortlinks_links WHERE id = ? AND user_id = ?')
      .bind(linkId, this.userId)
      .first<{ id: number }>()
    if (!owned) {
      throw ApiError.notFound('Link not found')
    }

    const slug = rawSlug.trim().toLowerCase()
    const validationErr = validateCustomSlug(slug)
    if (validationErr) {
      throw ApiError.badRequest(validationErr)
    }

    const existingSlug = await this.db
      .prepare('SELECT slug FROM tools_shortlinks_slugs WHERE slug = ? LIMIT 1')
      .bind(slug)
      .first()
    if (existingSlug) {
      throw ApiError.conflict('This slug is already taken')
    }

    const now = Math.floor(Date.now() / 1000)
    await this.db
      .prepare(
        `INSERT INTO tools_shortlinks_slugs (slug, user_id, link_id, is_custom, is_primary, created_at, disabled_at)
         VALUES (?, ?, ?, 1, 0, ?, NULL)`,
      )
      .bind(slug, this.userId, linkId, now)
      .run()

    return {
      slug,
      link_id: linkId,
      is_custom: true,
      is_primary: false,
      click_count: 0,
      created_at: now,
      disabled_at: null,
    }
  }

  async setPrimarySlug(linkId: number, slug: string): Promise<void> {
    const row = await this.db
      .prepare('SELECT slug FROM tools_shortlinks_slugs WHERE link_id = ? AND slug = ? AND user_id = ?')
      .bind(linkId, slug, this.userId)
      .first()

    if (!row) {
      throw ApiError.notFound('Slug not found for this link')
    }

    await this.db.batch([
      this.db
        .prepare('UPDATE tools_shortlinks_slugs SET is_primary = 0 WHERE link_id = ? AND user_id = ?')
        .bind(linkId, this.userId),
      this.db
        .prepare('UPDATE tools_shortlinks_slugs SET is_primary = 1 WHERE slug = ? AND link_id = ? AND user_id = ?')
        .bind(slug, linkId, this.userId),
    ])
  }

  async disableSlug(slug: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .prepare('UPDATE tools_shortlinks_slugs SET disabled_at = ? WHERE slug = ? AND user_id = ?')
      .bind(now, slug, this.userId)
      .run()
  }

  async enableSlug(slug: string): Promise<void> {
    await this.db
      .prepare('UPDATE tools_shortlinks_slugs SET disabled_at = NULL WHERE slug = ? AND user_id = ?')
      .bind(slug, this.userId)
      .run()
  }

  async deleteSlug(slug: string): Promise<void> {
    const slugRow = await this.db
      .prepare('SELECT * FROM tools_shortlinks_slugs WHERE slug = ? AND user_id = ?')
      .bind(slug, this.userId)
      .first<{ slug: string; link_id: number; is_primary: number }>()

    if (!slugRow) {
      throw ApiError.notFound('Slug not found')
    }

    const clickRow = await this.db
      .prepare('SELECT COUNT(*) as cnt FROM tools_shortlinks_clicks WHERE slug = ? AND user_id = ?')
      .bind(slug, this.userId)
      .first<{ cnt: number }>()

    if ((clickRow?.cnt || 0) > 0) {
      throw ApiError.badRequest('Cannot delete slug with click history. Please disable it instead.')
    }

    // Check count of remaining slugs
    const countRow = await this.db
      .prepare('SELECT COUNT(*) as cnt FROM tools_shortlinks_slugs WHERE link_id = ? AND user_id = ?')
      .bind(slugRow.link_id, this.userId)
      .first<{ cnt: number }>()

    if ((countRow?.cnt || 0) <= 1) {
      throw ApiError.badRequest('Cannot delete the only slug attached to a short link')
    }

    const statements = [
      this.db
        .prepare('DELETE FROM tools_shortlinks_slugs WHERE slug = ? AND user_id = ?')
        .bind(slug, this.userId),
    ]
    if (slugRow.is_primary) {
      const nextSlug = await this.db
        .prepare('SELECT slug FROM tools_shortlinks_slugs WHERE link_id = ? AND slug != ? AND user_id = ? LIMIT 1')
        .bind(slugRow.link_id, slug, this.userId)
        .first<{ slug: string }>()
      if (nextSlug) {
        // After the delete, so the one-primary index never sees two rows at once.
        statements.push(
          this.db
            .prepare('UPDATE tools_shortlinks_slugs SET is_primary = 1 WHERE slug = ? AND link_id = ? AND user_id = ?')
            .bind(nextSlug.slug, slugRow.link_id, this.userId),
        )
      }
    }
    await this.db.batch(statements)
  }

  // -------------------------------------------------------------------------
  // Click Ingestion & Public Resolution
  // -------------------------------------------------------------------------

  async findSlugForRedirect(slug: string): Promise<{
    slug: string
    link_id: number
    user_id: string
    url: string
    disabled_at: number | null
    expires_at: number | null
    password_hash: string | null
    is_password_protected: boolean
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT s.slug, s.link_id, s.user_id, s.disabled_at, l.url, l.expires_at, l.password_hash, l.is_password_protected
         FROM tools_shortlinks_slugs s
         JOIN tools_shortlinks_links l ON s.link_id = l.id
         WHERE s.slug = ?`,
      )
      .bind(slug)
      .first<{
        slug: string
        link_id: number
        user_id: string
        disabled_at: number | null
        url: string
        expires_at: number | null
        password_hash: string | null
        is_password_protected: number
      }>()

    if (!row) return null

    return {
      slug: row.slug,
      link_id: row.link_id,
      user_id: row.user_id,
      url: row.url,
      disabled_at: row.disabled_at,
      expires_at: row.expires_at,
      password_hash: row.password_hash,
      is_password_protected: Boolean(row.is_password_protected),
    }
  }

  async recordClick(slug: string, linkId: number, targetUserId: string, click: ClickData): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .prepare(
        `INSERT INTO tools_shortlinks_clicks (
           user_id, link_id, slug, clicked_at, referrer, referrer_host, country, region, city,
           device_type, os, browser, language, link_mode, channel,
           utm_source, utm_medium, utm_campaign, utm_term, utm_content,
           user_agent, is_bot, visitor_fp, is_self_referrer
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?
         )`,
      )
      .bind(
        targetUserId,
        linkId,
        slug,
        now,
        click.referrer || null,
        click.referrerHost || null,
        click.country || null,
        click.region || null,
        click.city || null,
        click.deviceType || 'desktop',
        click.os || 'other',
        click.browser || 'Other',
        click.language || null,
        click.linkMode || 'link',
        click.channel || null,
        click.utmSource || null,
        click.utmMedium || null,
        click.utmCampaign || null,
        click.utmTerm || null,
        click.utmContent || null,
        click.userAgent || null,
        click.isBot || 0,
        click.visitorFp || null,
        click.isSelfReferrer || 0,
      )
      .run()
  }

  // -------------------------------------------------------------------------
  // Analytics
  // -------------------------------------------------------------------------

  private clickScope(settings: ShortlinksSettings): string {
    let scope = ''
    if (settings.filter_bots) scope += ' AND is_bot = 0'
    if (settings.filter_self_referrers) scope += ' AND is_self_referrer = 0'
    return scope
  }

  async getLinkAnalytics(linkId: number, range: TimelineRange = '30d'): Promise<ClickStats> {
    const settings = await this.getSettings()
    const link = await this.db
      .prepare('SELECT created_at FROM tools_shortlinks_links WHERE id = ? AND user_id = ?')
      .bind(linkId, this.userId)
      .first<{ created_at: number }>()
    let where = `user_id = ? AND link_id = ?${this.clickScope(settings)}`
    const binds: (string | number)[] = [this.userId, linkId]

    const sinceTs = rangeToSinceTs(range)
    if (sinceTs !== undefined) {
      where += ' AND clicked_at >= ?'
      binds.push(sinceTs)
    }

    const [
      totalRow,
      countries,
      referrers,
      referrerHosts,
      devices,
      osList,
      browsers,
      linkModes,
      channels,
      timelineRows,
      slugClicks,
      numCountriesRow,
      numReferrersRow,
      numHostsRow,
      numOsRow,
      numBrowsersRow,
    ] = await Promise.all([
      this.db.prepare(`SELECT COUNT(*) as cnt FROM tools_shortlinks_clicks WHERE ${where}`).bind(...binds).first<{ cnt: number }>(),
      this.db.prepare(`SELECT country as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND country IS NOT NULL GROUP BY country ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT referrer as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND referrer IS NOT NULL AND referrer NOT LIKE 'android-app://%' GROUP BY referrer ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT referrer_host as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND referrer_host IS NOT NULL GROUP BY referrer_host ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT device_type as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND device_type IS NOT NULL GROUP BY device_type ORDER BY count DESC`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT os as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND os IS NOT NULL GROUP BY os ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT browser as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND browser IS NOT NULL GROUP BY browser ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT link_mode as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} GROUP BY link_mode ORDER BY count DESC`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT channel as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND channel IS NOT NULL GROUP BY channel ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT date(clicked_at, 'unixepoch') as date, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} GROUP BY date ORDER BY date DESC LIMIT 30`).bind(...binds).all<{ date: string; count: number }>(),
      this.db.prepare(`SELECT slug, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} GROUP BY slug ORDER BY count DESC`).bind(...binds).all<{ slug: string; count: number }>(),
      this.db.prepare(`SELECT COUNT(DISTINCT country) as cnt FROM tools_shortlinks_clicks WHERE ${where} AND country IS NOT NULL`).bind(...binds).first<{ cnt: number }>(),
      this.db.prepare(`SELECT COUNT(DISTINCT referrer) as cnt FROM tools_shortlinks_clicks WHERE ${where} AND referrer IS NOT NULL AND referrer NOT LIKE 'android-app://%'`).bind(...binds).first<{ cnt: number }>(),
      this.db.prepare(`SELECT COUNT(DISTINCT referrer_host) as cnt FROM tools_shortlinks_clicks WHERE ${where} AND referrer_host IS NOT NULL`).bind(...binds).first<{ cnt: number }>(),
      this.db.prepare(`SELECT COUNT(DISTINCT os) as cnt FROM tools_shortlinks_clicks WHERE ${where} AND os IS NOT NULL`).bind(...binds).first<{ cnt: number }>(),
      this.db.prepare(`SELECT COUNT(DISTINCT browser) as cnt FROM tools_shortlinks_clicks WHERE ${where} AND browser IS NOT NULL`).bind(...binds).first<{ cnt: number }>(),
    ])

    return {
      total_clicks: totalRow?.cnt || 0,
      avg_clicks_per_day: formatAvgPerDay(totalRow?.cnt || 0, range, link?.created_at),
      countries: countries.results ?? [],
      referrers: referrers.results ?? [],
      referrer_hosts: referrerHosts.results ?? [],
      devices: devices.results ?? [],
      operating_systems: osList.results ?? [],
      browsers: browsers.results ?? [],
      link_modes: fillMissingOptions(linkModes.results ?? [], ['link', 'qr']),
      channels: channels.results ?? [],
      clicks_over_time: (timelineRows.results ?? []).reverse(),
      slug_clicks: slugClicks.results ?? [],
      num_countries: numCountriesRow?.cnt || 0,
      num_referrers: numReferrersRow?.cnt || 0,
      num_referrer_hosts: numHostsRow?.cnt || 0,
      num_os: numOsRow?.cnt || 0,
      num_browsers: numBrowsersRow?.cnt || 0,
    }
  }

  async getTimeline(linkId?: number, bundleId?: number, range: TimelineRange = '30d'): Promise<TimelineData> {
    const settings = await this.getSettings()
    const now = Math.floor(Date.now() / 1000)
    let where = `user_id = ?${this.clickScope(settings)}`
    const binds: (string | number)[] = [this.userId]

    if (linkId) {
      where += ' AND link_id = ?'
      binds.push(linkId)
    } else if (bundleId) {
      where += ' AND link_id IN (SELECT link_id FROM tools_shortlinks_bundle_links WHERE bundle_id = ? AND user_id = ?)'
      binds.push(bundleId, this.userId)
    }

    let bucketExpr = "date(clicked_at, 'unixepoch')"
    const sinceTs = rangeToSinceTs(range, now)

    if (range === '24h') {
      bucketExpr = "strftime('%Y-%m-%d %H', clicked_at, 'unixepoch')"
    } else if (range === '1y') {
      bucketExpr = "date(clicked_at, 'unixepoch', 'weekday 0', '-6 days')"
    }

    let timeFilter = ''
    const bucketBinds = [...binds]
    if (sinceTs !== undefined) {
      timeFilter = ' AND clicked_at >= ?'
      bucketBinds.push(sinceTs)
    }

    const rows = await this.db
      .prepare(
        `SELECT ${bucketExpr} as label, COUNT(*) as count
         FROM tools_shortlinks_clicks
         WHERE ${where}${timeFilter}
         GROUP BY label ORDER BY label ASC`,
      )
      .bind(...bucketBinds)
      .all<{ label: string; count: number }>()

    const dataMap = new Map((rows.results ?? []).map((r) => [r.label, r.count]))
    const buckets = fillBuckets(range, dataMap, now)

    return { range, buckets }
  }

  async getBreakdownPage(params: {
    linkId?: number
    bundleId?: number
    dimension: string
    range?: TimelineRange
    offset?: number
    limit?: number
  }): Promise<BreakdownPage> {
    const dimension = params.dimension
    const offset = Math.min(1_000_000, Math.max(0, Math.floor(params.offset || 0)))
    const limit = Math.min(100, Math.max(1, Math.floor(params.limit || 10)))
    const range = params.range || '30d'

    let col = 'country'
    if (dimension === 'referrer' || dimension === 'referrers') col = 'referrer'
    else if (dimension === 'referrer_host' || dimension === 'referrer_hosts' || dimension === 'domain') col = 'referrer_host'
    else if (dimension === 'device_type' || dimension === 'devices') col = 'device_type'
    else if (dimension === 'os' || dimension === 'operating_systems' || dimension === 'operating_system') col = 'os'
    else if (dimension === 'browser' || dimension === 'browsers') col = 'browser'
    else if (dimension === 'channel' || dimension === 'channels') col = 'channel'
    else if (dimension === 'link_mode' || dimension === 'link_modes') col = 'link_mode'
    else if (dimension === 'country' || dimension === 'countries') col = 'country'

    const settings = await this.getSettings()
    let where = `user_id = ?${this.clickScope(settings)}`
    const binds: (string | number)[] = [this.userId]

    if (params.linkId) {
      where += ' AND link_id = ?'
      binds.push(params.linkId)
    } else if (params.bundleId) {
      where += ' AND link_id IN (SELECT link_id FROM tools_shortlinks_bundle_links WHERE bundle_id = ? AND user_id = ?)'
      binds.push(params.bundleId, this.userId)
    }

    const sinceTs = rangeToSinceTs(range)
    if (sinceTs !== undefined) {
      where += ' AND clicked_at >= ?'
      binds.push(sinceTs)
    }

    where += ` AND ${col} IS NOT NULL`

    const countRow = await this.db
      .prepare(`SELECT COUNT(DISTINCT ${col}) as total FROM tools_shortlinks_clicks WHERE ${where}`)
      .bind(...binds)
      .first<{ total: number }>()
    const total = countRow?.total || 0

    const rows = await this.db
      .prepare(
        `SELECT ${col} as name, COUNT(*) as count
         FROM tools_shortlinks_clicks
         WHERE ${where}
         GROUP BY ${col}
         ORDER BY count DESC, name ASC
         LIMIT ${limit} OFFSET ${offset}`,
      )
      .bind(...binds)
      .all<{ name: string; count: number }>()

    const items = rows.results ?? []
    return {
      dimension,
      items,
      total,
      offset,
      limit,
      has_more: offset + items.length < total,
    }
  }

  async getDashboardStats(range: TimelineRange = '30d'): Promise<DashboardStats> {
    const settings = await this.getSettings()
    const now = Math.floor(Date.now() / 1000)
    const sinceTs = rangeToSinceTs(range, now)
    const prevSinceTs = sinceTs !== undefined ? sinceTs - (now - sinceTs) : undefined

    let where = `user_id = ?${this.clickScope(settings)}`
    const binds: (string | number)[] = [this.userId]

    let timeFilter = ''
    if (sinceTs !== undefined) {
      timeFilter = ' AND clicked_at >= ?'
      binds.push(sinceTs)
    }

    const totalLinksRow = await this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN (expires_at IS NULL OR expires_at > ?)
             AND EXISTS (SELECT 1 FROM tools_shortlinks_slugs s WHERE s.link_id = tools_shortlinks_links.id AND s.disabled_at IS NULL)
             THEN 1 ELSE 0 END) as active
         FROM tools_shortlinks_links WHERE user_id = ?`,
      )
      .bind(now, this.userId)
      .first<{ total: number; active: number | null }>()

    const totalClicksRow = await this.db
      .prepare(`SELECT COUNT(*) as cnt FROM tools_shortlinks_clicks WHERE ${where}${timeFilter}`)
      .bind(...binds)
      .first<{ cnt: number }>()

    let totalClicksPrevious = 0
    if (sinceTs !== undefined && prevSinceTs !== undefined) {
      const prevClicksRow = await this.db
        .prepare(`SELECT COUNT(*) as cnt FROM tools_shortlinks_clicks WHERE user_id = ?${this.clickScope(settings)} AND clicked_at >= ? AND clicked_at < ?`)
        .bind(this.userId, prevSinceTs, sinceTs)
        .first<{ cnt: number }>()
      totalClicksPrevious = prevClicksRow?.cnt || 0
    }

    const totalClicks = totalClicksRow?.cnt || 0
    const deltaClicks = computeDelta(totalClicks, totalClicksPrevious)

    const [timelineData, recent, topCountries, topReferrers] = await Promise.all([
      this.getTimeline(undefined, undefined, range),
      this.listLinks({ limit: 5, sort: 'created_at' }),
      this.db.prepare(`SELECT country as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where}${timeFilter} AND country IS NOT NULL GROUP BY country ORDER BY count DESC LIMIT 5`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT referrer_host as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where}${timeFilter} AND referrer_host IS NOT NULL GROUP BY referrer_host ORDER BY count DESC LIMIT 5`).bind(...binds).all<{ name: string; count: number }>(),
    ])

    return {
      range,
      total_links: totalLinksRow?.total || 0,
      active_links: totalLinksRow?.active || 0,
      total_clicks: totalClicks,
      delta_clicks: deltaClicks,
      avg_clicks_per_day: formatAvgPerDay(totalClicks, range),
      timeline: {
        labels: timelineData.buckets.map((b) => b.label),
        values: timelineData.buckets.map((b) => b.count),
      },
      recent_links: recent.items,
      top_countries: topCountries.results ?? [],
      top_referrers: topReferrers.results ?? [],
    }
  }

  // -------------------------------------------------------------------------
  // Bundles Management
  // -------------------------------------------------------------------------

  async listBundles(): Promise<ShortLinkBundle[]> {
    const now = Math.floor(Date.now() / 1000)
    const t7d = now - 7 * 86400

    const [rows, sparkRows] = await Promise.all([
      this.db
        .prepare(
          `SELECT b.*,
             (SELECT COUNT(*) FROM tools_shortlinks_bundle_links bl WHERE bl.bundle_id = b.id AND bl.user_id = ?) as link_count,
             (SELECT COUNT(*) FROM tools_shortlinks_clicks c WHERE c.link_id IN (SELECT bl.link_id FROM tools_shortlinks_bundle_links bl WHERE bl.bundle_id = b.id AND bl.user_id = ?) AND c.user_id = ?) as total_clicks
           FROM tools_shortlinks_bundles b
           WHERE b.user_id = ?
           ORDER BY b.archived_at ASC, b.created_at DESC`,
        )
        .bind(this.userId, this.userId, this.userId, this.userId)
        .all<{
          id: number
          user_id: string
          name: string
          description: string | null
          icon: string | null
          accent: BundleAccent
          archived_at: number | null
          created_via: string | null
          created_by: string
          created_at: number
          updated_at: number
          link_count: number
          total_clicks: number
        }>(),
      this.db
        .prepare(
          `SELECT bl.bundle_id as bundle_id, date(c.clicked_at, 'unixepoch') as label, COUNT(*) as count
           FROM tools_shortlinks_clicks c
           JOIN tools_shortlinks_bundle_links bl ON bl.link_id = c.link_id AND bl.user_id = c.user_id
           WHERE c.user_id = ? AND c.clicked_at >= ?
           GROUP BY bl.bundle_id, label`,
        )
        .bind(this.userId, t7d)
        .all<{ bundle_id: number; label: string; count: number }>(),
    ])

    const sparkByBundle = new Map<number, Map<string, number>>()
    for (const row of sparkRows.results ?? []) {
      const dataMap = sparkByBundle.get(row.bundle_id) ?? new Map<string, number>()
      dataMap.set(row.label, row.count)
      sparkByBundle.set(row.bundle_id, dataMap)
    }

    return (rows.results ?? []).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      name: r.name,
      description: r.description,
      icon: r.icon,
      accent: r.accent,
      link_count: r.link_count || 0,
      total_clicks: r.total_clicks || 0,
      sparkline: fillBuckets('7d', sparkByBundle.get(r.id) ?? new Map(), now).map((b) => b.count),
      archived_at: r.archived_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))
  }

  async createBundle(data: {
    name: string
    description?: string | null
    icon?: string | null
    accent?: BundleAccent
  }): Promise<ShortLinkBundle> {
    const now = Math.floor(Date.now() / 1000)
    await this.assertBundleNameFree(data.name.trim())
    const res = await this.db
      .prepare(
        `INSERT INTO tools_shortlinks_bundles (user_id, name, description, icon, accent, archived_at, created_via, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'app', 'user', ?, ?)`,
      )
      .bind(
        this.userId,
        data.name.trim(),
        data.description?.trim() || null,
        data.icon?.trim() || null,
        data.accent || 'orange',
        now,
        now,
      )
      .run()

    const id = res.meta.last_row_id as number
    return (await this.getBundleById(id))!
  }

  async getBundleById(id: number): Promise<ShortLinkBundle | null> {
    const row = await this.db
      .prepare(
        `SELECT b.*,
           (SELECT COUNT(*) FROM tools_shortlinks_bundle_links bl WHERE bl.bundle_id = b.id AND bl.user_id = ?) as link_count,
           (SELECT COUNT(*) FROM tools_shortlinks_clicks c WHERE c.link_id IN (SELECT bl.link_id FROM tools_shortlinks_bundle_links bl WHERE bl.bundle_id = b.id AND bl.user_id = ?) AND c.user_id = ?) as total_clicks
         FROM tools_shortlinks_bundles b
         WHERE b.id = ? AND b.user_id = ?`,
      )
      .bind(this.userId, this.userId, this.userId, id, this.userId)
      .first<{
        id: number
        user_id: string
        name: string
        description: string | null
        icon: string | null
        accent: BundleAccent
        archived_at: number | null
        created_via: string | null
        created_by: string
        created_at: number
        updated_at: number
        link_count: number
        total_clicks: number
      }>()

    if (!row) return null

    return {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      accent: row.accent,
      link_count: row.link_count || 0,
      total_clicks: row.total_clicks || 0,
      sparkline: [],
      archived_at: row.archived_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  async updateBundle(
    id: number,
    data: {
      name?: string
      description?: string | null
      icon?: string | null
      accent?: BundleAccent
    },
  ): Promise<ShortLinkBundle> {
    const existing = await this.getBundleById(id)
    if (!existing) {
      throw ApiError.notFound('Bundle not found')
    }

    const updates: string[] = ['updated_at = ?']
    const now = Math.floor(Date.now() / 1000)
    const binds: (string | number | null)[] = [now]

    if (data.name !== undefined) {
      updates.push('name = ?')
      binds.push(data.name.trim())
    }
    if (data.description !== undefined) {
      updates.push('description = ?')
      binds.push(data.description ? data.description.trim() : null)
    }
    if (data.icon !== undefined) {
      updates.push('icon = ?')
      binds.push(data.icon ? data.icon.trim() : null)
    }
    if (data.accent !== undefined) {
      updates.push('accent = ?')
      binds.push(data.accent)
    }

    if (data.name !== undefined) await this.assertBundleNameFree(data.name, id)

    binds.push(id, this.userId)
    const sql = `UPDATE tools_shortlinks_bundles SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
    await this.db.prepare(sql).bind(...binds).run()

    return (await this.getBundleById(id))!
  }

  private async assertBundleNameFree(name: string, excludeId?: number): Promise<void> {
    const row = await this.db
      .prepare('SELECT id FROM tools_shortlinks_bundles WHERE user_id = ? AND name = ? AND id != ? LIMIT 1')
      .bind(this.userId, name, excludeId ?? -1)
      .first<{ id: number }>()
    if (row) {
      throw ApiError.conflict('A bundle with this name already exists')
    }
  }

  async deleteBundle(id: number): Promise<void> {
    await this.db
      .prepare('DELETE FROM tools_shortlinks_bundles WHERE id = ? AND user_id = ?')
      .bind(id, this.userId)
      .run()
  }

  async archiveBundle(id: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .prepare('UPDATE tools_shortlinks_bundles SET archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(now, now, id, this.userId)
      .run()
  }

  async unarchiveBundle(id: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .prepare('UPDATE tools_shortlinks_bundles SET archived_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(now, id, this.userId)
      .run()
  }

  async addBundleLinks(bundleId: number, linkIds: number[]): Promise<void> {
    const bundle = await this.db
      .prepare('SELECT id FROM tools_shortlinks_bundles WHERE id = ? AND user_id = ?')
      .bind(bundleId, this.userId)
      .first<{ id: number }>()
    if (!bundle) {
      throw ApiError.notFound('Bundle not found')
    }

    const unique = [...new Set(linkIds)]
    const placeholders = unique.map(() => '?').join(', ')
    const owned = await this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM tools_shortlinks_links WHERE user_id = ? AND id IN (${placeholders})`,
      )
      .bind(this.userId, ...unique)
      .first<{ cnt: number }>()
    if ((owned?.cnt ?? 0) !== unique.length) {
      throw ApiError.badRequest('One or more links were not found')
    }

    const now = Math.floor(Date.now() / 1000)
    // Four bound values per row; D1 rejects statements past roughly a hundred parameters.
    const chunkSize = 20
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize)
      const values = chunk.map(() => '(?, ?, ?, ?)').join(', ')
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO tools_shortlinks_bundle_links (user_id, bundle_id, link_id, added_at)
           VALUES ${values}`,
        )
        .bind(...chunk.flatMap((linkId) => [this.userId, bundleId, linkId, now]))
        .run()
    }
  }

  async removeBundleLink(bundleId: number, linkId: number): Promise<void> {
    await this.db
      .prepare('DELETE FROM tools_shortlinks_bundle_links WHERE bundle_id = ? AND link_id = ? AND user_id = ?')
      .bind(bundleId, linkId, this.userId)
      .run()
  }

  async getBundleLinks(bundleId: number): Promise<ShortLink[]> {
    const rows = await this.db
      .prepare(
        `SELECT l.*,
           (SELECT COUNT(*) FROM tools_shortlinks_clicks c WHERE c.link_id = l.id AND c.user_id = ?) as total_clicks
         FROM tools_shortlinks_links l
         JOIN tools_shortlinks_bundle_links bl ON l.id = bl.link_id
         WHERE bl.bundle_id = ? AND bl.user_id = ? AND l.user_id = ?
         ORDER BY bl.added_at DESC`,
      )
      .bind(this.userId, bundleId, this.userId, this.userId)
      .all<{
        id: number
        user_id: string
        url: string
        label: string | null
        password_hash: string | null
        is_password_protected: number
        created_at: number
        expires_at: number | null
        created_via: string | null
        created_by: string
        total_clicks: number
      }>()

    const linkIds = (rows.results ?? []).map((r) => r.id)
    if (linkIds.length === 0) return []

    const placeholders = linkIds.map(() => '?').join(',')
    const slugRows = await this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM tools_shortlinks_clicks c WHERE c.slug = s.slug AND c.user_id = ?) as click_count
         FROM tools_shortlinks_slugs s
         WHERE s.link_id IN (${placeholders}) AND s.user_id = ?
         ORDER BY s.is_primary DESC, s.created_at ASC`,
      )
      .bind(this.userId, ...linkIds, this.userId)
      .all<{
        slug: string
        link_id: number
        is_custom: number
        is_primary: number
        click_count: number
        created_at: number
        disabled_at: number | null
      }>()

    const slugMap = new Map<number, ShortLinkSlug[]>()
    for (const s of slugRows.results ?? []) {
      const list = slugMap.get(s.link_id) || []
      list.push({
        slug: s.slug,
        link_id: s.link_id,
        is_custom: Boolean(s.is_custom),
        is_primary: Boolean(s.is_primary),
        click_count: s.click_count || 0,
        created_at: s.created_at,
        disabled_at: s.disabled_at,
      })
      slugMap.set(s.link_id, list)
    }

    return (rows.results ?? []).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      url: r.url,
      label: r.label,
      password_protected: Boolean(r.is_password_protected),
      created_at: r.created_at,
      expires_at: r.expires_at,
      created_via: r.created_via,
      created_by: r.created_by,
      slugs: slugMap.get(r.id) || [],
      total_clicks: r.total_clicks || 0,
    }))
  }

  async getBundleAnalytics(bundleId: number, range: TimelineRange = '30d'): Promise<BundleStats> {
    const bundle = await this.getBundleById(bundleId)
    if (!bundle) {
      throw ApiError.notFound('Bundle not found')
    }

    const settings = await this.getSettings()
    const links = await this.getBundleLinks(bundleId)
    const timeline = await this.getTimeline(undefined, bundleId, range)

    let where = `user_id = ?${this.clickScope(settings)} AND link_id IN (SELECT link_id FROM tools_shortlinks_bundle_links WHERE bundle_id = ? AND user_id = ?)`
    const binds: (string | number)[] = [this.userId, bundleId, this.userId]

    const sinceTs = rangeToSinceTs(range)
    if (sinceTs !== undefined) {
      where += ' AND clicked_at >= ?'
      binds.push(sinceTs)
    }

    const [
      totalRow,
      countries,
      devices,
      osList,
      browsers,
      referrers,
      referrerHosts,
      linkModes,
      numCountriesRow,
      numReferrersRow,
      numHostsRow,
      numOsRow,
      numBrowsersRow,
    ] = await Promise.all([
      this.db.prepare(`SELECT COUNT(*) as cnt FROM tools_shortlinks_clicks WHERE ${where}`).bind(...binds).first<{ cnt: number }>(),
      this.db.prepare(`SELECT country as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND country IS NOT NULL GROUP BY country ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT device_type as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND device_type IS NOT NULL GROUP BY device_type ORDER BY count DESC`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT os as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND os IS NOT NULL GROUP BY os ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT browser as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND browser IS NOT NULL GROUP BY browser ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT referrer as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND referrer IS NOT NULL AND referrer NOT LIKE 'android-app://%' GROUP BY referrer ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT referrer_host as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} AND referrer_host IS NOT NULL GROUP BY referrer_host ORDER BY count DESC LIMIT 10`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT link_mode as name, COUNT(*) as count FROM tools_shortlinks_clicks WHERE ${where} GROUP BY link_mode ORDER BY count DESC`).bind(...binds).all<{ name: string; count: number }>(),
      this.db.prepare(`SELECT COUNT(DISTINCT country) as cnt FROM tools_shortlinks_clicks WHERE ${where} AND country IS NOT NULL`).bind(...binds).first<{ cnt: number }>(),
      this.db.prepare(`SELECT COUNT(DISTINCT referrer) as cnt FROM tools_shortlinks_clicks WHERE ${where} AND referrer IS NOT NULL AND referrer NOT LIKE 'android-app://%'`).bind(...binds).first<{ cnt: number }>(),
      this.db.prepare(`SELECT COUNT(DISTINCT referrer_host) as cnt FROM tools_shortlinks_clicks WHERE ${where} AND referrer_host IS NOT NULL`).bind(...binds).first<{ cnt: number }>(),
      this.db.prepare(`SELECT COUNT(DISTINCT os) as cnt FROM tools_shortlinks_clicks WHERE ${where} AND os IS NOT NULL`).bind(...binds).first<{ cnt: number }>(),
      this.db.prepare(`SELECT COUNT(DISTINCT browser) as cnt FROM tools_shortlinks_clicks WHERE ${where} AND browser IS NOT NULL`).bind(...binds).first<{ cnt: number }>(),
    ])

    const totalClicks = totalRow?.cnt || 0

    const linkIds = links.map((l) => l.id)
    const rangeCounts = new Map<number, number>()
    if (linkIds.length > 0) {
      const placeholders = linkIds.map(() => '?').join(', ')
      const counted = await this.db
        .prepare(
          `SELECT link_id, COUNT(*) as cnt FROM tools_shortlinks_clicks
           WHERE ${where} AND link_id IN (${placeholders})
           GROUP BY link_id`,
        )
        .bind(...binds, ...linkIds)
        .all<{ link_id: number; cnt: number }>()
      for (const row of counted.results ?? []) rangeCounts.set(row.link_id, row.cnt)
    }

    // Per link breakdown
    const perLink: BundleStatsPerLink[] = links.map((l) => {
      const primarySlug = l.slugs.find((s) => s.is_primary)?.slug || l.slugs[0]?.slug || ''
      const clicks = rangeCounts.get(l.id) ?? 0
      const pct = totalClicks > 0 ? Math.round((clicks / totalClicks) * 100) : 0
      return {
        link_id: l.id,
        label: l.label,
        primary_slug: primarySlug,
        url: l.url,
        click_count: clicks,
        pct_of_bundle: pct,
      }
    })

    const topPerformerItem = perLink.slice().sort((a, b) => b.click_count - a.click_count)[0]
    const topPerformer = topPerformerItem && topPerformerItem.click_count > 0 ? {
      slug: topPerformerItem.primary_slug,
      label: topPerformerItem.label,
      click_count: topPerformerItem.click_count,
      pct_of_bundle: topPerformerItem.pct_of_bundle,
    } : undefined

    return {
      bundle,
      link_count: links.length,
      total_clicks: totalClicks,
      clicked_links: perLink.filter((l) => l.click_count > 0).length,
      top_performer: topPerformer,
      countries_reached: numCountriesRow?.cnt || 0,
      timeline,
      countries: countries.results ?? [],
      devices: devices.results ?? [],
      operating_systems: osList.results ?? [],
      browsers: browsers.results ?? [],
      referrers: referrers.results ?? [],
      referrer_hosts: referrerHosts.results ?? [],
      link_modes: fillMissingOptions(linkModes.results ?? [], ['link', 'qr']),
      per_link: perLink,
      num_countries: numCountriesRow?.cnt || 0,
      num_referrers: numReferrersRow?.cnt || 0,
      num_referrer_hosts: numHostsRow?.cnt || 0,
      num_os: numOsRow?.cnt || 0,
      num_browsers: numBrowsersRow?.cnt || 0,
    }
  }

  // -------------------------------------------------------------------------
  // API Keys
  // -------------------------------------------------------------------------

  async listApiKeys(): Promise<ShortlinkApiKey[]> {
    const rows = await this.db
      .prepare('SELECT id, user_id, title, key_prefix, scope, created_at, last_used_at FROM tools_shortlinks_api_keys WHERE user_id = ? ORDER BY created_at DESC')
      .bind(this.userId)
      .all<ShortlinkApiKey>()

    return rows.results ?? []
  }

  async createApiKey(title: string, scope = 'read,write'): Promise<{ apiKey: string; record: ShortlinkApiKey }> {
    const rawBytes = new Uint8Array(24)
    crypto.getRandomValues(rawBytes)
    const rawKey = Array.from(rawBytes, (b) => b.toString(16).padStart(2, '0')).join('')
    const apiKey = `sl_${rawKey}`
    const keyPrefix = `${apiKey.slice(0, 7)}...`
    const keyHash = await hashPassword(apiKey)
    const now = Math.floor(Date.now() / 1000)

    const res = await this.db
      .prepare(
        `INSERT INTO tools_shortlinks_api_keys (user_id, title, key_prefix, key_hash, scope, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(this.userId, title.trim(), keyPrefix, keyHash, scope, now)
      .run()

    const id = res.meta.last_row_id as number

    return {
      apiKey,
      record: {
        id,
        user_id: this.userId,
        title: title.trim(),
        key_prefix: keyPrefix,
        scope,
        created_at: now,
        last_used_at: null,
      },
    }
  }

  async deleteApiKey(id: number): Promise<void> {
    await this.db
      .prepare('DELETE FROM tools_shortlinks_api_keys WHERE id = ? AND user_id = ?')
      .bind(id, this.userId)
      .run()
  }

  // -------------------------------------------------------------------------
  // Backups & Export/Import
  // -------------------------------------------------------------------------

  async listBackups(): Promise<ShortlinkBackup[]> {
    const rows = await this.db
      .prepare('SELECT * FROM tools_shortlinks_backups WHERE user_id = ? ORDER BY created_at DESC')
      .bind(this.userId)
      .all<ShortlinkBackup>()
    return rows.results ?? []
  }

  /** Pages through the whole account: listLinks caps one page at 100 rows. */
  private async allLinksForExport(): Promise<ShortLink[]> {
    const pageSize = 100
    const all: ShortLink[] = []
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.listLinks({ limit: pageSize, offset })
      all.push(...page.items)
      if (page.items.length < pageSize || all.length >= page.total) return all
    }
  }

  async createBackup(r2Bucket?: R2Bucket): Promise<ShortlinkBackup> {
    const now = Math.floor(Date.now() / 1000)
    const backupId = `backup_${now}_${crypto.randomUUID().slice(0, 8)}`
    const filename = `shortlinks_backup_${now}.json`

    const links = await this.allLinksForExport()
    const bundles = await this.listBundles()
    const settings = await this.getSettings()

    const backupData = {
      _backup_info: {
        type: 'inkstone_shortlinks_backup',
        version: '1.0.0',
        created_at: now,
        link_count: links.length,
      },
      settings,
      links,
      bundles,
    }

    const content = JSON.stringify(backupData, null, 2)
    const { key, size } = await uploadShortlinksFileToR2(
      r2Bucket,
      getShortlinksBackupR2Key(this.userId, backupId),
      content,
      'application/json',
    )

    await this.db
      .prepare(
        `INSERT INTO tools_shortlinks_backups (user_id, id, filename, r2_key, size, type, created_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?)`,
      )
      .bind(this.userId, backupId, filename, key, size, now)
      .run()

    return {
      id: backupId,
      user_id: this.userId,
      filename,
      r2_key: key,
      size,
      type: 'manual',
      created_at: now,
      link_count: links.length,
    }
  }

  async exportData(
    format: 'txt' | 'csv' | 'json' | 'passwords',
    r2Bucket?: R2Bucket,
  ): Promise<{ key: string; filename: string; size: number }> {
    const now = Math.floor(Date.now() / 1000)
    const fileId = `${now}_${crypto.randomUUID().slice(0, 6)}`
    const links = await this.allLinksForExport()

    if (format === 'txt') {
      const filename = `shortlinks_${fileId}.txt`
      const lines = links.map((l) => {
        const slug = l.slugs.find((s) => s.is_primary)?.slug || l.slugs[0]?.slug || ''
        return `[${slug}] -> ${l.url}${l.label ? ` (${l.label})` : ''}`
      })
      const content = lines.join('\n')
      const key = getShortlinksExportTxtR2Key(this.userId, fileId, false)
      const { size } = await uploadShortlinksFileToR2(r2Bucket, key, content, 'text/plain; charset=utf-8')
      return { key, filename, size }
    }

    if (format === 'passwords') {
      const filename = `protected_links_${fileId}.txt`
      const protectedLinks = links.filter((l) => l.password_protected)
      const lines = protectedLinks.map((l) => {
        const slug = l.slugs.find((s) => s.is_primary)?.slug || l.slugs[0]?.slug || ''
        return `[Protected] [${slug}] -> ${l.url}${l.label ? ` (${l.label})` : ''}`
      })
      const content = lines.join('\n')
      const key = getShortlinksExportTxtR2Key(this.userId, fileId, true)
      const { size } = await uploadShortlinksFileToR2(r2Bucket, key, content, 'text/plain; charset=utf-8')
      return { key, filename, size }
    }

    if (format === 'csv') {
      const filename = `shortlinks_${fileId}.csv`
      const headers = ['id', 'primary_slug', 'url', 'label', 'password_protected', 'total_clicks', 'created_at']
      const rows = links.map((l) => {
        const slug = l.slugs.find((s) => s.is_primary)?.slug || l.slugs[0]?.slug || ''
        return [
          l.id,
          csvCell(slug),
          csvCell(l.url),
          csvCell(l.label || ''),
          l.password_protected ? 1 : 0,
          l.total_clicks,
          l.created_at,
        ].join(',')
      })
      const content = [headers.join(','), ...rows].join('\n')
      const key = getShortlinksExportCsvR2Key(this.userId, fileId)
      const { size } = await uploadShortlinksFileToR2(r2Bucket, key, content, 'text/csv; charset=utf-8')
      return { key, filename, size }
    }

    // JSON export
    const filename = `shortlinks_${fileId}.json`
    const content = JSON.stringify(links, null, 2)
    const key = `tools/shortlinks/backup/${this.userId}/export_${fileId}.json`
    const { size } = await uploadShortlinksFileToR2(r2Bucket, key, content, 'application/json')
    return { key, filename, size }
  }

  async batchImportLinks(items: { url: string; label?: string; slug?: string }[]): Promise<{ imported: number; failed: number }> {
    let imported = 0
    let failed = 0

    for (const item of items) {
      try {
        await this.createLink({
          url: item.url,
          label: item.label,
          custom_slug: item.slug,
          allow_duplicate: true,
        })
        imported++
      } catch {
        failed++
      }
    }

    return { imported, failed }
  }

  async restoreBackup(
    backupId: string,
    r2Bucket?: R2Bucket,
  ): Promise<{ imported: number; total: number; protectedWithoutPassword: number }> {
    const backup = await this.db
      .prepare('SELECT * FROM tools_shortlinks_backups WHERE user_id = ? AND id = ?')
      .bind(this.userId, backupId)
      .first<ShortlinkBackup>()

    if (!backup) {
      throw ApiError.notFound('Backup not found')
    }

    if (!r2Bucket) {
      throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
    }

    const obj = await r2Bucket.get(backup.r2_key)
    if (!obj) {
      throw ApiError.notFound('Backup file not found in storage')
    }

    const text = await obj.text()
    const parsed = JSON.parse(text)
    const links = (parsed.links || []) as Array<{
      url: string
      label?: string | null
      expires_at?: number | null
      password_protected?: boolean
      slugs?: Array<{ slug: string }>
    }>

    let imported = 0
    let protectedWithoutPassword = 0
    for (const l of links) {
      try {
        const slug = l.slugs?.[0]?.slug
        await this.createLink({
          url: l.url,
          label: l.label ?? undefined,
          custom_slug: slug,
          expires_at: l.expires_at ?? null,
          allow_duplicate: true,
        })
        imported++
        if (l.password_protected) protectedWithoutPassword++
      } catch {
        // Continue on conflict
      }
    }

    return { imported, total: links.length, protectedWithoutPassword }
  }
}
