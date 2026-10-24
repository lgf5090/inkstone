/**
 * Every D1 read the share analytics surface makes.
 *
 * The route parses the request, decides which reading the reader asked for and shapes the answer; the
 * statements that carry it live here, beside the tables they read, in the same shape `ShareStore` uses:
 * one store per request bound to the account the caller authenticated as, methods that take
 * already-validated scalars and hand back rows. Nothing in this module knows about HTTP, and no request
 * context crosses into it — a `Context` reaching down here would invert the layering this split exists to
 * keep.
 *
 * The selection rules are borrowed, never restated: a status comes from `shareStatusSql`, a log filter
 * from `visitLogFilterSql`, a traffic filter from `visitTrafficSql` and a tag's element test from
 * `shareTagElementSql`, while the windowed aggregates and the channel split call the statements
 * `visit-aggregates` and `channel-split` already build. The hub's list, its collection pages and these
 * panels answer the same question because they were never asked separately.
 *
 * Every statement binds its values. The only text spliced in is composed by this module or by the
 * selection-sql helpers it calls.
 */

import { SHARE_STALE_DEFAULT_DAYS } from '@shared/constants'
import type { ChannelDrillDown } from '@shared/share-channel'
import type { ShareBreakdownItem } from '@shared/share-hub'
import type { ShareStatusFilter, VisitLogFilter, VisitTrafficFilters } from '@shared/share-selection'
import { DAY_MS } from './analytics'
import {
  channelBreakdownStatement,
  collectionChannelLabels,
  collectionChannelLabelsStatement,
  composeChannels,
  type ChannelCountRow,
  type CollectionLabelRow,
} from './channel-split'
import {
  shareStatusSql,
  shareTagElementSql,
  visitLogFilterSql,
  visitTrafficSql,
  type SqlFragment,
} from './selection-sql'
import type { ShareRow } from './store'
import {
  VISITOR_COUNT_SQL,
  firstOf,
  rowsOf,
  visitAggregateFromResults,
  visitAggregateStatements,
  type VisitAggregate,
  type VisitAggregateQuery,
  type VisitScope,
} from './visit-aggregates'

/**
 * The window a reading is taken over: the range's own bounds plus the instant the caller resolved them
 * at, so a status rule and a `MIN(visited_at)` answer the same moment.
 */
export interface AnalyticsReadWindow extends VisitAggregateQuery {
  now: number
  prevStartTs: number
}

/** Rows the dashboard's own visit list shows; the log pages over the same table. */
const RECENT_VISITS_LIMIT = 20

/** How many quiet links the stale report lists; the count beside it covers all of them. */
const STALE_LINK_PAGE_SIZE = 5

/** How many lapsed links the expiry notice lists; its count covers all of them. */
const EXPIRED_LINK_PAGE_SIZE = 5

/** This build has no per-owner threshold setting, so the shared default is the report's whole answer. */
export const STALE_THRESHOLD_DAYS = SHARE_STALE_DEFAULT_DAYS

/**
 * The traffic filters the footer counts with, and the ones the dashboard speaks when the query says
 * nothing. One object for both, so an all-time number and a windowed one cannot mean different rows.
 */
const DEFAULT_TRAFFIC_FILTERS: VisitTrafficFilters = { excludeBots: true }

/** One row of `share_visits` joined with its note; `sv` is the visit, `n` the note. */
const VISIT_LOG_COLUMNS = `sv.id, sv.note_id, sv.slug, sv.visited_at, sv.country, sv.region, sv.city,
              sv.referrer, sv.referrer_host, sv.device_type, sv.os, sv.browser, sv.visitor_fp,
              sv.is_bot, sv.is_self_referrer, sv.is_owner, sv.channel,
              CASE WHEN sv.is_bot = 1 THEN sv.user_agent END AS user_agent,
              n.title AS note_title`

/**
 * Whether a visit's link still exists.
 *
 * Both halves are scoped by the account, so a slug another owner holds can never make one account's row
 * look like a live link. A visit whose link was revoked sits outside every reading here, the log included:
 * the hub reports traffic the owner can still be reached by.
 */
function liveLinkCondition(alias: string): string {
  return `EXISTS (SELECT 1 FROM shares s WHERE s.slug = ${alias}.slug AND s.user_id = ${alias}.user_id)`
}

/** The status rule a `CASE WHEN` counts with; `all` names no column, so it counts every joined row. */
function statusFragment(status: ShareStatusFilter, now: number, firstBind: number): SqlFragment {
  return shareStatusSql(status, now, firstBind) ?? { sql: '1', binds: [], nextBind: firstBind }
}

interface MinVisitedRow {
  min_ts: number | null
}

interface PrevStatsRow {
  prev_views: number
  prev_uv: number
}

interface FilterStatsRow {
  bots: number
  self_referrals: number
  owner: number
}

export interface VisitTotalsRow {
  total_views: number
  total_visitors: number
}

export interface ShareSummaryRow {
  total_shares: number
  active_shares: number
}

export interface VisitLogRow {
  id: number
  note_id: string
  slug: string
  visited_at: number
  country: string | null
  region: string | null
  city: string | null
  referrer: string | null
  referrer_host: string | null
  device_type: string | null
  os: string | null
  browser: string | null
  user_agent: string | null
  visitor_fp: string | null
  is_bot: number
  is_self_referrer: number
  is_owner: number
  channel: string | null
  note_title: string | null
}

export interface StaleLinkRow {
  note_id: string
  note_title: string | null
  slug: string
  last_viewed_at: number | null
  views: number
  stale_total: number
  never_viewed: number
}

export interface ExpiredLinkRow {
  note_id: string
  note_title: string | null
  slug: string
  expires_at: number
  expired_total: number
}

/** A share joined with its note's title, as the one-link dashboard reads it. */
export type NoteShareRow = ShareRow & { note_title: string | null }

/** The ten category counts the sidebar numbers itself with. */
export interface GlobalSummaryRow {
  total_shares: number
  active_shares: number
  pinned_shares: number
  starred_shares: number
  paused_shares: number
  password_shares: number
  expiring_soon_shares: number
  expiring_shares: number
  permanent_shares: number
  expired_shares: number
}

/** One folder's two counts, as the sidebar's statement answers them. */
export interface FolderCountRow {
  folder_id: string
  total_shares: number
  shared_notes: number
}

/** One tag's two counts, by the same element rule the list filter uses. */
export interface TagCountRow {
  name: string
  total: number
  shared: number
}

/** The visit-side half of every dashboard: the aggregates, the channel split and the recent list. */
export interface VisitReadings {
  aggregate: VisitAggregate
  channels: ShareBreakdownItem[]
  recentVisits: VisitLogRow[]
}

/** Everything the account dashboard reads in one flight; only the top notes' titles come after it. */
export interface GlobalAnalyticsRead extends VisitReadings {
  summary: ShareSummaryRow | null
  prevStats: PrevStatsRow | null
  filterStats: FilterStatsRow | null
  staleLinks: StaleLinkRow[]
  expiredLinks: ExpiredLinkRow[]
}

/** The four statements behind the sidebar's counters, in the order it prints them. */
export interface SidebarStatsRead {
  summary: GlobalSummaryRow | null
  totals: VisitTotalsRow | null
  folders: FolderCountRow[]
  tags: TagCountRow[]
}

/** One page of the audit trail and the number of rows the same `WHERE` matches. */
export interface VisitLogPageRead {
  rows: VisitLogRow[]
  total: number
}

/** The link a log request narrows to, once the route has checked the account owns it. */
export interface VisitLogScope {
  noteId?: string
  slug?: string
}

export class ShareAnalyticsStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * The earliest visit inside the reading's scope, or null for a table with no rows in it.
   *
   * Only the `all` range asks: a bounded window already knows where it starts, and without this the
   * all-time reading would fall back to a recent window instead of the account's whole history.
   */
  async minVisitedAt(targetId?: string): Promise<number | null> {
    const row = await minVisitedAtStatement(this.db, { userId: this.userId, targetId }).first<MinVisitedRow>()
    return row?.min_ts ?? null
  }

  /** The share of one of this account's notes, beside its note's title. */
  async noteShareRow(noteId: string): Promise<NoteShareRow | null> {
    const row = await noteShareStatement(this.db, this.userId, noteId).first<NoteShareRow>()
    return row ?? null
  }

  /** Whether this account holds a link for the note; the log's narrowing check answers with it. */
  async ownsNoteShare(noteId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS found FROM shares WHERE note_id = ?1 AND user_id = ?2`)
      .bind(noteId, this.userId)
      .first<{ found: number }>()
    return row !== null
  }

  /** The same question for a slug, which is how a log request that names an address is checked. */
  async ownsShareSlug(slug: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS found FROM shares WHERE slug = ?1 AND user_id = ?2`)
      .bind(slug, this.userId)
      .first<{ found: number }>()
    return row !== null
  }

  /** One link's dashboard: the window's aggregates, its channel split and the visits beside it. */
  async noteDashboard(noteId: string, window: AnalyticsReadWindow): Promise<VisitReadings> {
    const scope: VisitScope = { userId: this.userId, targetId: noteId }
    const [recentResult, channelResult, labelResult, ...visitResults] = await this.db.batch([
      recentVisitsStatement(this.db, { userId: this.userId, noteId, startTs: window.startTs, clause: window.clause }),
      channelBreakdownStatement(this.db, scope, window),
      collectionChannelLabelsStatement(this.db, this.userId),
      ...visitAggregateStatements(this.db, scope, window),
    ])
    const aggregate = visitAggregateFromResults(visitResults, window)
    return {
      aggregate,
      channels: composeChannels(
        rowsOf<ChannelCountRow>(channelResult),
        aggregate.views,
        collectionChannelLabels(rowsOf<CollectionLabelRow>(labelResult)),
      ),
      recentVisits: rowsOf<VisitLogRow>(recentResult),
    }
  }

  /**
   * One read of everything the account dashboard answers with.
   *
   * The aggregates, the two channel statements and both hygiene reports ride one batch; only the top
   * notes' titles need a second flight, which `noteTitles` is, because which notes made the top ten is not
   * known before the first.
   */
  async globalDashboard(window: AnalyticsReadWindow, acknowledgedAt: number | null): Promise<GlobalAnalyticsRead> {
    const scope: VisitScope = { userId: this.userId }
    const [
      summaryResult,
      prevStatsResult,
      filterStatsResult,
      recentResult,
      staleRowsResult,
      expiredRowsResult,
      channelResult,
      channelLabelResult,
      ...visitResults
    ] = await this.db.batch([
      shareSummaryStatement(this.db, this.userId, window.now),
      prevVisitStatsStatement(this.db, this.userId, window.prevStartTs, window.startTs, window.clause),
      visitFilterStatsStatement(this.db, this.userId, window.startTs),
      recentVisitsStatement(this.db, { userId: this.userId, startTs: window.startTs, clause: window.clause }),
      staleLinksStatement(this.db, { userId: this.userId, now: window.now }),
      expiredLinksStatement(this.db, { userId: this.userId, now: window.now, acknowledgedAt }),
      channelBreakdownStatement(this.db, scope, window),
      collectionChannelLabelsStatement(this.db, this.userId),
      ...visitAggregateStatements(this.db, scope, window),
    ])
    const aggregate = visitAggregateFromResults(visitResults, window)
    return {
      aggregate,
      channels: composeChannels(
        rowsOf<ChannelCountRow>(channelResult),
        aggregate.views,
        collectionChannelLabels(rowsOf<CollectionLabelRow>(channelLabelResult)),
      ),
      recentVisits: rowsOf<VisitLogRow>(recentResult),
      summary: firstOf<ShareSummaryRow>(summaryResult),
      prevStats: firstOf<PrevStatsRow>(prevStatsResult),
      filterStats: firstOf<FilterStatsRow>(filterStatsResult),
      staleLinks: rowsOf<StaleLinkRow>(staleRowsResult),
      expiredLinks: rowsOf<ExpiredLinkRow>(expiredRowsResult),
    }
  }

  /**
   * The titles of the links a reading named, read from this account's own notes.
   *
   * A note row that is gone keeps a `null` entry here and the client labels it; the ids arrive already
   * ranked and cut by the card's limit, so this reads no more rows than the card can show.
   */
  async noteTitles(noteIds: readonly string[]): Promise<Map<string, string>> {
    if (!noteIds.length) return new Map()
    const placeholders = noteIds.map((_, index) => `?${index + 2}`).join(', ')
    const { results } = await this.db
      .prepare(`SELECT id, title FROM notes WHERE user_id = ?1 AND id IN (${placeholders})`)
      .bind(this.userId, ...noteIds)
      .all<{ id: string; title: string }>()
    return new Map((results ?? []).map((row) => [row.id, row.title]))
  }

  /** One page of the audit trail and its total, counted by the same `WHERE` the page walks. */
  async visitLogPage(params: {
    scope: VisitLogScope
    filter: VisitLogFilter
    channel: ChannelDrillDown
    limit: number
    offset: number
  }): Promise<VisitLogPageRead> {
    const where = visitLogWhere({ userId: this.userId, scope: params.scope, filter: params.filter, channel: params.channel })
    const [countResult, rowsResult] = await this.db.batch(
      visitLogPageStatements(this.db, where, params.limit, params.offset),
    )
    return {
      rows: rowsOf<VisitLogRow>(rowsResult),
      total: firstOf<{ total: number }>(countResult)?.total ?? 0,
    }
  }

  /**
   * Wipes the account's visit rows, and the counters derived from them.
   *
   * `shares.views` and `shares.last_viewed_at` are the list's own reading of the same traffic, and the stale
   * report is computed from `last_viewed_at`; leaving them after an emptied log would have the hub say "12
   * views, read yesterday" over a table with no rows in it. Both statements run as one batch, so a wipe
   * cannot leave a counter pointing at traffic that is already gone. The returned number is the log's own,
   * which is what the route answers with.
   */
  async wipeVisits(): Promise<number> {
    const [wipe] = await this.db.batch([
      this.db.prepare(`DELETE FROM share_visits WHERE user_id = ?1`).bind(this.userId),
      this.db.prepare(`UPDATE shares SET views = 0, last_viewed_at = NULL WHERE user_id = ?1`).bind(this.userId),
    ])
    return wipe?.meta?.changes ?? 0
  }

  /**
   * The sidebar's counters: the ten categories, the folder and tag counts, and the all-time traffic the
   * footer prints.
   *
   * Four statements in one batch, and no memoization. An all-time aggregate over the whole visit table is
   * not a real-time number, and the reference bought relief with a cached row that silently switched the
   * footer between `COUNT(*)` of `share_visits` and `SUM(shares.views)` depending on whether the cache was
   * warm — two different questions under one label, with a visitor count that had no fallback at all.
   */
  async sidebarStats(now: number): Promise<SidebarStatsRead> {
    const [summaryResult, totalsResult, folderResult, tagResult] = await this.db.batch([
      globalSummaryStatement(this.db, this.userId, now),
      visitTotalsStatement(this.db, this.userId),
      folderCountsStatement(this.db, this.userId, now),
      tagCountsStatement(this.db, this.userId, now),
    ])
    return {
      summary: firstOf<GlobalSummaryRow>(summaryResult),
      totals: firstOf<VisitTotalsRow>(totalsResult),
      folders: rowsOf<FolderCountRow>(folderResult),
      tags: rowsOf<TagCountRow>(tagResult),
    }
  }
}

function minVisitedAtStatement(db: D1Database, scope: VisitScope): D1PreparedStatement {
  return scope.targetId
    ? db
        .prepare(`SELECT MIN(visited_at) AS min_ts FROM share_visits WHERE note_id = ?1 AND user_id = ?2`)
        .bind(scope.targetId, scope.userId)
    : db.prepare(`SELECT MIN(visited_at) AS min_ts FROM share_visits WHERE user_id = ?1`).bind(scope.userId)
}

function noteShareStatement(db: D1Database, userId: string, noteId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT s.*, n.title AS note_title
         FROM shares s LEFT JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE s.note_id = ?1 AND s.user_id = ?2`,
    )
    .bind(noteId, userId)
}

/**
 * The two link counts the dashboard's header prints.
 *
 * `active` is the shared rule rather than a condition of its own, and no `SUM(views)` is selected: the
 * reading beside this row is measured over `share_visits`, so a counter that disagrees with the log it sits
 * next to is not an answer either of them wants. A dead column is also a column nobody tests.
 */
function shareSummaryStatement(db: D1Database, userId: string, now: number): D1PreparedStatement {
  const active = statusFragment('active', now, 2)
  return db
    .prepare(
      `SELECT COUNT(*) AS total_shares,
              COUNT(CASE WHEN ${active.sql} THEN 1 END) AS active_shares
         FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE s.user_id = ?1 AND n.deleted_at IS NULL`,
    )
    .bind(userId, ...active.binds)
}

/** The same window one step earlier, for the two trend badges. */
function prevVisitStatsStatement(
  db: D1Database,
  userId: string,
  prevStartTs: number,
  startTs: number,
  clause: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COUNT(*) AS prev_views, ${VISITOR_COUNT_SQL} AS prev_uv
         FROM share_visits
        WHERE user_id = ?1 AND visited_at >= ?2 AND visited_at < ?3 ${clause}`,
    )
    .bind(userId, prevStartTs, startTs)
}

/** How many rows the filters are hiding, so the dashboard can say what it left out. */
function visitFilterStatsStatement(db: D1Database, userId: string, startTs: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COUNT(CASE WHEN is_bot = 1 THEN 1 END) AS bots,
              COUNT(CASE WHEN is_self_referrer = 1 THEN 1 END) AS self_referrals,
              COUNT(CASE WHEN is_owner = 1 THEN 1 END) AS owner
         FROM share_visits
        WHERE user_id = ?1 AND visited_at >= ?2`,
    )
    .bind(userId, startTs)
}

/**
 * The stale-links report: live links nobody has opened inside the threshold.
 *
 * The live rule is `shareStatusSql('active')`, so a link this card lists is a link the `active` category
 * counts, and the threshold is a bind rather than text folded into an expression.
 */
function staleLinksStatement(db: D1Database, params: { userId: string; now: number }): D1PreparedStatement {
  const active = statusFragment('active', params.now, 2)
  const cutoff = params.now - STALE_THRESHOLD_DAYS * DAY_MS
  return db
    .prepare(
      `SELECT s.note_id, s.slug, s.last_viewed_at, s.views, n.title AS note_title,
              COUNT(*) OVER () AS stale_total,
              SUM(CASE WHEN s.last_viewed_at IS NULL THEN 1 ELSE 0 END) OVER () AS never_viewed
         FROM shares s
         LEFT JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE s.user_id = ?1 AND ${active.sql}
          AND (s.last_viewed_at IS NULL OR s.last_viewed_at <= ?${active.nextBind})
        ORDER BY COALESCE(s.last_viewed_at, 0), s.created_at, s.note_id
        LIMIT ?${active.nextBind + 1}`,
    )
    .bind(params.userId, ...active.binds, cutoff, STALE_LINK_PAGE_SIZE)
}

/**
 * The expiry notice: links that lapsed since the owner last dismissed it.
 *
 * The dismissal is one timestamp, so "new since the last time I looked" is `expires_at > acknowledgedAt` —
 * a link that expired again after being acknowledged comes back, and one acknowledged once stays gone.
 */
function expiredLinksStatement(
  db: D1Database,
  params: { userId: string; now: number; acknowledgedAt: number | null },
): D1PreparedStatement {
  const expired = statusFragment('expired', params.now, 2)
  return db
    .prepare(
      `SELECT s.note_id, s.slug, s.expires_at, n.title AS note_title, COUNT(*) OVER () AS expired_total
         FROM shares s
         LEFT JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE s.user_id = ?1 AND ${expired.sql}
          AND (?${expired.nextBind} IS NULL OR s.expires_at > ?${expired.nextBind})
        ORDER BY s.expires_at DESC, s.slug
        LIMIT ?${expired.nextBind + 1}`,
    )
    .bind(params.userId, ...expired.binds, params.acknowledgedAt, EXPIRED_LINK_PAGE_SIZE)
}

/**
 * The log's `WHERE`, built once for the page and for its count.
 *
 * Placeholders number from the account bind at `?1`, and every value is a bind; the only text spliced in is
 * the log filter, the live-link test and this module's own column list.
 */
function visitLogWhere(params: {
  userId: string
  scope: VisitLogScope
  filter: VisitLogFilter
  channel: ChannelDrillDown
}): { sql: string; binds: Array<string | number>; nextBind: number } {
  const conditions = ['sv.user_id = ?1']
  const binds: Array<string | number> = [params.userId]
  let bind = 2
  if (params.scope.noteId) {
    conditions.push(`sv.note_id = ?${bind}`)
    binds.push(params.scope.noteId)
    bind += 1
  }
  if (params.scope.slug) {
    conditions.push(`sv.slug = ?${bind}`)
    binds.push(params.scope.slug)
    bind += 1
  }
  if (params.channel.kind === 'unmarked') {
    // The unmarked column holds no marker at all, so this condition carries no bind.
    conditions.push('sv.channel IS NULL')
  } else if (params.channel.kind === 'unrecognized') {
    conditions.push(`sv.channel = ?${bind}`)
    binds.push('')
    bind += 1
  } else if (params.channel.kind === 'token') {
    conditions.push(`sv.channel = ?${bind}`)
    binds.push(params.channel.token)
    bind += 1
  }
  const filterCondition = visitLogFilterSql(params.filter, 'sv')
  if (filterCondition) conditions.push(filterCondition)
  conditions.push(liveLinkCondition('sv'))
  return { sql: conditions.join(' AND '), binds, nextBind: bind }
}

/**
 * The count and the page, in one batch, from the same `WHERE`.
 *
 * At the shipped limits — `LIMITS.shareVisitsPageMax` pages of `LIMITS.shareVisitsPerPage` rows — the
 * largest `OFFSET` a caller can name is `(100 - 1) * 100 = 9 900` rows, four figures and every one of them
 * inside the index the walk uses. `page` beyond the ceiling is clamped, not refused, because a hub that
 * asks for a page past the end gets an empty last page rather than a 500.
 */
function visitLogPageStatements(
  db: D1Database,
  where: { sql: string; binds: Array<string | number>; nextBind: number },
  limit: number,
  offset: number,
): [D1PreparedStatement, D1PreparedStatement] {
  return [
    db.prepare(`SELECT COUNT(*) AS total FROM share_visits sv WHERE ${where.sql}`).bind(...where.binds),
    db.prepare(
      `SELECT ${VISIT_LOG_COLUMNS}
         FROM share_visits sv
         LEFT JOIN notes n ON n.id = sv.note_id AND n.user_id = sv.user_id
        WHERE ${where.sql}
        ORDER BY sv.visited_at DESC
        LIMIT ?${where.nextBind} OFFSET ?${where.nextBind + 1}`,
    ).bind(...where.binds, limit, offset),
  ]
}

/**
 * The recent list beside a dashboard: the same rows the log pages over, narrowed to the reading's own window
 * and traffic filters, so the two lists cannot show different traffic for the same heading.
 */
function recentVisitsStatement(
  db: D1Database,
  params: { userId: string; noteId?: string; startTs: number; clause: string },
): D1PreparedStatement {
  const conditions = ['sv.user_id = ?1']
  const binds: Array<string | number> = [params.userId]
  let bind = 2
  if (params.noteId) {
    conditions.push(`sv.note_id = ?${bind}`)
    binds.push(params.noteId)
    bind += 1
  }
  conditions.push(`sv.visited_at >= ?${bind}`)
  binds.push(params.startTs)
  conditions.push(liveLinkCondition('sv'))
  return db
    .prepare(
      `SELECT ${VISIT_LOG_COLUMNS}
         FROM share_visits sv
         LEFT JOIN notes n ON n.id = sv.note_id AND n.user_id = sv.user_id
        WHERE ${conditions.join(' AND ')}${params.clause}
        ORDER BY sv.visited_at DESC
        LIMIT ${RECENT_VISITS_LIMIT}`,
    )
    .bind(...binds)
}

/** The ten categories the sidebar lists; each is one column of one row, in the order it shows them. */
const STATUS_COUNT_COLUMNS: Record<Exclude<ShareStatusFilter, 'all'>, string> = {
  active: 'active_shares',
  pinned: 'pinned_shares',
  starred: 'starred_shares',
  paused: 'paused_shares',
  password: 'password_shares',
  expiring_soon: 'expiring_soon_shares',
  expiring: 'expiring_shares',
  permanent: 'permanent_shares',
  expired: 'expired_shares',
}

/**
 * One `COUNT(CASE WHEN <status rule> THEN 1 END)` per category, every rule from `shareStatusSql`.
 *
 * A count spelled out beside the helper is a count that keeps its own meaning: the reference's tag total
 * carried an extra `OR is_enabled IS NULL` arm for a column the schema declares `NOT NULL DEFAULT 1`, and
 * the sidebar then numbered links its own list could not filter to. The joins mirror the hub's list — the
 * note row has to exist and be out of the trash, because `pinned` and `starred` are the note's columns.
 */
function statusCountSelect(now: number): { sql: string; binds: Array<string | number> } {
  const parts: string[] = []
  const binds: Array<string | number> = []
  let nextBind = 2
  for (const [status, column] of Object.entries(STATUS_COUNT_COLUMNS) as Array<
    [Exclude<ShareStatusFilter, 'all'>, string]
  >) {
    const fragment = statusFragment(status, now, nextBind)
    parts.push(`COUNT(CASE WHEN ${fragment.sql} THEN 1 END) AS ${column}`)
    binds.push(...fragment.binds)
    nextBind = fragment.nextBind
  }
  return { sql: parts.join(',\n              '), binds }
}

function globalSummaryStatement(db: D1Database, userId: string, now: number): D1PreparedStatement {
  const counts = statusCountSelect(now)
  return db
    .prepare(
      `SELECT COUNT(*) AS total_shares,
              ${counts.sql}
         FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE s.user_id = ?1 AND n.deleted_at IS NULL`,
    )
    .bind(userId, ...counts.binds)
}

/**
 * All-time traffic, both numbers in one statement.
 *
 * There is no fallback and no second source: a footer that printed the visit table's count one minute and
 * `SUM(shares.views)` the next would show a number whose meaning depends on a cache.
 */
function visitTotalsStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COUNT(*) AS total_views, ${VISITOR_COUNT_SQL} AS total_visitors
         FROM share_visits sv
        WHERE sv.user_id = ?1 AND ${liveLinkCondition('sv')}${visitTrafficSql(DEFAULT_TRAFFIC_FILTERS, 'sv')}`,
    )
    .bind(userId)
}

/**
 * What each folder covers.
 *
 * "Shared" is the collection page's own rule — `active`, over a note that is not in the trash — so a folder
 * whose row says three cannot open on a page that lists two.
 */
function folderCountsStatement(db: D1Database, userId: string, now: number): D1PreparedStatement {
  const live = statusFragment('active', now, 2)
  return db
    .prepare(
      `SELECT sf.id AS folder_id,
              COUNT(CASE WHEN s.slug IS NOT NULL AND n.deleted_at IS NULL THEN 1 END) AS total_shares,
              COUNT(CASE WHEN s.slug IS NOT NULL AND n.deleted_at IS NULL AND ${live.sql} THEN 1 END) AS shared_notes
         FROM share_folders sf
         LEFT JOIN shares s ON s.folder_id = sf.id AND s.user_id = sf.user_id
         LEFT JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE sf.user_id = ?1
        GROUP BY sf.id`,
    )
    .bind(userId, ...live.binds)
}

/**
 * What each tag covers, by the same element test the list filter uses.
 *
 * `shareTagElementSql('s', 't.name')` asks whether the name is one element of the stored array; the
 * substring test it replaces counted `monthly-report` under a tag called `report`.
 */
function tagCountsStatement(db: D1Database, userId: string, now: number): D1PreparedStatement {
  const live = statusFragment('active', now, 2)
  return db
    .prepare(
      `SELECT t.name AS name,
              COUNT(CASE WHEN s.slug IS NOT NULL AND n.deleted_at IS NULL THEN 1 END) AS total,
              COUNT(CASE WHEN s.slug IS NOT NULL AND n.deleted_at IS NULL AND ${live.sql} THEN 1 END) AS shared
         FROM share_tags t
         LEFT JOIN shares s ON s.user_id = t.user_id AND ${shareTagElementSql('s', 't.name')}
         LEFT JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE t.user_id = ?1
        GROUP BY t.name`,
    )
    .bind(userId, ...live.binds)
}
