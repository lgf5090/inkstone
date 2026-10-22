import { Hono } from 'hono'
import { LIMITS, SHARE_STALE_DEFAULT_DAYS } from '@shared/constants'
import { parseChannelDrillDown, type ChannelDrillDown } from '@shared/share-channel'
import type {
  ShareBreakdownItem,
  ShareExpiredLinks,
  ShareGlobalAnalytics,
  ShareGlobalStats,
  ShareNoteAnalytics,
  ShareStaleLinks,
  ShareVisitLog,
} from '@shared/share-hub'
import type { ShareStatusFilter, VisitLogFilter, VisitTrafficFilters } from '@shared/share-selection'
import { isVisitLogFilter } from '@shared/share-selection'
import type { AppBindings } from '../env'
import { getMeta, setMeta } from '../db/metadata'
import { ApiError } from '../lib/errors'
import { isValidId, isValidSlug } from '../lib/id'
import { createMinuteBudget } from '../lib/rate-limit'
import { clampInt } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  ANALYTICS_CARD_LIMIT,
  DAY_MS,
  analyticsWindow,
  buildBucketedTimeline,
  computeDelta,
  parseAnalyticsRequest,
  parseBotName,
  perDayRate,
  publicVisitorFingerprint,
  toBreakdown,
  type AnalyticsRequest,
  type AnalyticsWindow,
} from '../share/analytics'
import {
  channelBreakdownStatement,
  collectionChannelLabels,
  collectionChannelLabelsStatement,
  composeChannels,
  type ChannelCountRow,
  type CollectionLabelRow,
} from '../share/channel-split'
import {
  shareStatusSql,
  shareTagElementSql,
  visitLogFilterSql,
  visitTrafficSql,
  type ShareSqlAliases,
  type SqlFragment,
} from '../share/selection-sql'
import type { ShareRow } from '../share/store'
import {
  firstOf,
  rowsOf,
  visitAggregateFromResults,
  visitAggregateStatements,
  type VisitAggregate,
  type VisitDistributionMaps,
  type VisitScope,
  type VisitTargetStat,
} from '../share/visit-aggregates'

/**
 * The share hub's analytics: the account dashboard, one link's dashboard, the visit log, the two hygiene
 * reports beside them, and the sidebar's counters.
 *
 * Every reading comes from `share_visits`. `shares.views` is a display counter the public read path moves,
 * not a measurement — it counts bot hits, owner previews and referrer-less taps alike, and it outlives a
 * log wipe. So nothing below reads it, and the footer's two KPIs are one statement that answers both at
 * once: a page-view number and a visitor number drawn from different tables would mean different things to
 * the same reader, which is exactly the drift the reference's cached stats produced.
 *
 * No statement here re-states a selection rule. A status comes from `shareStatusSql`, a log filter from
 * `visitLogFilterSql`, a traffic filter from `visitTrafficSql` and a tag's element test from
 * `shareTagElementSql`, so the hub's list, its collection pages and these panels answer the same question
 * because they were never asked separately.
 */

export const shareAnalyticsRoutes = new Hono<AppBindings>()

shareAnalyticsRoutes.use('*', requireAuth)

/** Rows the dashboard's own visit list shows; the log route pages over the same table. */
const RECENT_VISITS_LIMIT = 20

/** How many quiet links the stale card lists; the count beside it covers all of them. */
const STALE_LINK_PAGE_SIZE = 5

/** How many lapsed links the expiry notice lists; its count covers all of them. */
const EXPIRED_LINK_PAGE_SIZE = 5

const VISITS_PAGE_DEFAULT = 1
const VISITS_LIMIT_DEFAULT = 50

/**
 * Reads per account per minute the unbounded paths may cost.
 *
 * An `all`-range dashboard, the log's total and the sidebar's all-time footer summarize the account's whole
 * visit history, so a session stuck in a retry loop burns its own quota without ever writing. The brake is
 * the repo's existing per-caller minute budget (`../lib/rate-limit`) rather than a new ledger table: it is a
 * runaway-client guard, not a quota, and a bounded range costs one indexed window instead. The number sits
 * above anything a person does in a minute — the hub fires a handful of these per open — and far below what
 * a loop reaches in the same second.
 */
const READS_PER_MINUTE = 60
const chargeReadBudget = createMinuteBudget(
  READS_PER_MINUTE,
  'Too many analytics reads at once. Try again in a minute.',
)

/**
 * The distinct-visitor measure, spelled once for the two statements that need it.
 *
 * It is the expression `visit-aggregates` counts a windowed UV with, and the empty-string guard is what
 * keeps a visit that carried neither an address nor a user agent from becoming a visitor of its own.
 */
const VISITOR_COUNT_SQL = `COUNT(DISTINCT NULLIF(visitor_fp, ''))`

/**
 * The traffic filters the footer counts with, and the ones the dashboard speaks when the query says
 * nothing. One object for both, so an all-time number and a windowed one cannot mean different rows.
 */
const DEFAULT_TRAFFIC_FILTERS: VisitTrafficFilters = { excludeBots: true }

/** This build has no per-owner threshold setting, so the shared default is the report's whole answer. */
const STALE_THRESHOLD_DAYS = SHARE_STALE_DEFAULT_DAYS

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
function statusFragment(
  status: ShareStatusFilter,
  now: number,
  firstBind: number,
  aliases?: ShareSqlAliases,
): SqlFragment {
  return shareStatusSql(status, now, firstBind, aliases) ?? { sql: '1', binds: [], nextBind: firstBind }
}

/**
 * The dismissal of the expired-links notice, one timestamp per account in `app_meta`.
 *
 * The key carries a version: a notice whose shape changes is a notice whose old dismissal may no longer
 * mean the same thing, and a stale key would silence a report the owner never dismissed.
 */
const EXPIRED_ACK_KEY_VERSION = 1

export function expiredAckMetaKey(userId: string): string {
  return `share:expired-ack:v${EXPIRED_ACK_KEY_VERSION}:${userId}`
}

/** Null for anything that is not a positive safe integer: a corrupt row reads as never dismissed. */
export function parseExpiredAck(raw: string | null): number | null {
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
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

interface VisitTotalsRow {
  total_views: number
  total_visitors: number
}

interface ShareSummaryRow {
  total_shares: number
  active_shares: number
}

type AnalyticsContext = AnalyticsRequest & AnalyticsWindow

interface VisitLogRow {
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

interface StaleLinkRow {
  note_id: string
  note_title: string | null
  slug: string
  last_viewed_at: number | null
  views: number
  stale_total: number
  never_viewed: number
}

interface ExpiredLinkRow {
  note_id: string
  note_title: string | null
  slug: string
  expires_at: number
  expired_total: number
}

type NoteShareRow = ShareRow & { note_title: string | null }

shareAnalyticsRoutes.get('/analytics/global', async (c) => {
  const database = c.env.DB
  const userId = c.get('userId')
  const ctx = await analyticsContext(database, c, { userId })
  // Only the unbounded range is charged: a bounded one reads a single window of rows.
  if (ctx.range === 'all') chargeReadBudget(userId)
  // Read ahead of the batch, because the expired-links query filters on it.
  const acknowledgedAt = parseExpiredAck(await getMeta(database, expiredAckMetaKey(userId)))
  return c.json(await loadGlobalAnalytics(database, userId, ctx, acknowledgedAt))
})

shareAnalyticsRoutes.post('/analytics/expired-ack', async (c) => {
  await setMeta(c.env.DB, expiredAckMetaKey(c.get('userId')), String(Date.now()))
  return c.json({ ok: true })
})

shareAnalyticsRoutes.get('/analytics/note/:noteId', async (c) => {
  const database = c.env.DB
  const userId = c.get('userId')
  const noteId = c.req.param('noteId')
  // A malformed id and a foreign one get the same answer: neither tells the caller anything about the id
  // they guessed, and a dashboard has nothing of this account's to show for either.
  if (!isValidId(noteId)) throw ApiError.notFound('Share or note not found')
  const share = await noteShareStatement(database, userId, noteId).first<NoteShareRow>()
  if (!share) throw ApiError.notFound('Share or note not found')

  const ctx = await analyticsContext(database, c, { userId, targetId: noteId })
  if (ctx.range === 'all') chargeReadBudget(userId)
  const scope: VisitScope = { userId, targetId: noteId }
  const [recentResult, channelResult, labelResult, ...visitResults] = await database.batch([
    recentVisitsStatement(database, { userId, noteId, startTs: ctx.startTs, clause: ctx.clause }),
    channelBreakdownStatement(database, scope, ctx),
    collectionChannelLabelsStatement(database, userId),
    ...visitAggregateStatements(database, scope, ctx),
  ])
  const aggregate = visitAggregateFromResults(visitResults, ctx)
  const breakdown = breakdownsOf(aggregate, aggregate.views)
  return c.json({
    range: ctx.range,
    noteId: share.note_id,
    noteTitle: share.note_title,
    slug: share.slug,
    url: `${new URL(c.req.url).origin}/s/${share.slug}`,
    createdAt: share.created_at,
    expiresAt: share.expires_at,
    hasPassword: Boolean(share.password_hash),
    isEnabled: share.is_enabled !== 0,
    totalViews: aggregate.views,
    totalVisitors: aggregate.visitors,
    timeline: buildBucketedTimeline(aggregate.buckets, ctx.range, ctx.startTs, ctx.duration),
    topCountries: breakdown.countries,
    topReferrers: breakdown.referrers,
    devices: breakdown.devices,
    osList: breakdown.osList,
    browsers: breakdown.browsers,
    channels: composeChannels(
      rowsOf<ChannelCountRow>(channelResult),
      aggregate.views,
      collectionChannelLabels(rowsOf<CollectionLabelRow>(labelResult)),
    ),
    recentVisits: toVisitLogs(rowsOf<VisitLogRow>(recentResult), share.note_title),
  } satisfies ShareNoteAnalytics)
})

/**
 * One page of the audit trail.
 *
 * The deepest page a caller can name is bounded by the shared product limits — see
 * `visitLogPageStatements`, where the arithmetic on `OFFSET` is written out.
 */
shareAnalyticsRoutes.get('/visits', async (c) => {
  const database = c.env.DB
  const userId = c.get('userId')
  const page = clampInt(c.req.query('page'), VISITS_PAGE_DEFAULT, LIMITS.shareVisitsPageMax, VISITS_PAGE_DEFAULT)
  const limit = clampInt(c.req.query('limit'), 1, LIMITS.shareVisitsPerPage, VISITS_LIMIT_DEFAULT)
  const filter = visitLogFilterParam(c.req.query('filter'))
  const channel = parseChannelDrillDown(c.req.query('channel'))
  // A mistyped channel is refused rather than folded into "no filter": a dropped drill-down that answered
  // with every row would read as "this channel sent everything".
  if (channel.kind === 'invalid') throw ApiError.badRequest(`Unknown visit channel: ${c.req.query('channel')}`)
  const scope = await resolveVisitScope(database, userId, c.req.query('noteId'), c.req.query('slug'))
  // The page's total is an unbounded `COUNT(*)` over the account, so it shares the read budget.
  chargeReadBudget(userId)

  const where = visitLogWhere({ userId, scope, filter, channel })
  const offset = (page - 1) * limit
  const [countResult, rowsResult] = await database.batch(visitLogPageStatements(database, where, limit, offset))
  const total = firstOf<{ total: number }>(countResult)?.total ?? 0
  return c.json({
    visits: toVisitLogs(rowsOf<VisitLogRow>(rowsResult)),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  })
})

/**
 * Wipes the account's visit rows, and the counters derived from them.
 *
 * `shares.views` and `shares.last_viewed_at` are the list's own reading of the same traffic, and the stale
 * report is computed from `last_viewed_at`; leaving them after an emptied log would have the hub say "12
 * views, read yesterday" over a table with no rows in it. Both statements run as one batch, so a wipe
 * cannot leave a counter pointing at traffic that is already gone.
 */
shareAnalyticsRoutes.delete('/visits', async (c) => {
  const database = c.env.DB
  const userId = c.get('userId')
  const [wipe] = await database.batch([
    database.prepare(`DELETE FROM share_visits WHERE user_id = ?1`).bind(userId),
    database.prepare(`UPDATE shares SET views = 0, last_viewed_at = NULL WHERE user_id = ?1`).bind(userId),
  ])
  return c.json({ ok: true, deleted: wipe?.meta?.changes ?? 0 })
})

/**
 * The sidebar's counters: ten category counts, the folder and tag counts, and the all-time traffic the
 * footer prints.
 *
 * Four statements in one batch, and no memoization. An all-time aggregate over the whole visit table is not
 * a real-time number, and the reference bought relief with a cached row that silently switched the footer
 * between `COUNT(*)` of `share_visits` and `SUM(shares.views)` depending on whether the cache was warm — two
 * different questions under one label, with a visitor count that had no fallback at all. The read budget is
 * the honest brake.
 */
shareAnalyticsRoutes.get('/stats', async (c) => {
  const database = c.env.DB
  const userId = c.get('userId')
  const now = Date.now()
  chargeReadBudget(userId)
  const [summaryResult, totalsResult, folderResult, tagResult] = await database.batch([
    globalSummaryStatement(database, userId, now),
    visitTotalsStatement(database, userId),
    folderCountsStatement(database, userId, now),
    tagCountsStatement(database, userId, now),
  ])
  const globalStats: ShareGlobalStats = composeGlobalStats(
    firstOf<GlobalSummaryRow>(summaryResult),
    firstOf<VisitTotalsRow>(totalsResult),
    toFolderCounts(rowsOf<FolderCountRow>(folderResult)),
    toTagCounts(rowsOf<TagCountRow>(tagResult)),
  )
  return c.json({ globalStats })
})

/** The window and clause every share read resolves, so two panels cannot disagree about "7d, no bots". */
async function analyticsContext(
  database: D1Database,
  c: { req: { query(key: string): string | undefined } },
  scope: VisitScope,
): Promise<AnalyticsContext> {
  const request = parseAnalyticsRequest(c)
  const minRow =
    request.range === 'all' ? await minVisitedAtStatement(database, scope).first<MinVisitedRow>() : null
  return { ...request, ...analyticsWindow(request.range, request.now, minRow?.min_ts ?? null) }
}

function minVisitedAtStatement(database: D1Database, scope: VisitScope): D1PreparedStatement {
  return scope.targetId
    ? database
        .prepare(`SELECT MIN(visited_at) AS min_ts FROM share_visits WHERE note_id = ?1 AND user_id = ?2`)
        .bind(scope.targetId, scope.userId)
    : database
        .prepare(`SELECT MIN(visited_at) AS min_ts FROM share_visits WHERE user_id = ?1`)
        .bind(scope.userId)
}

/**
 * One read of everything the global dashboard answers with.
 *
 * The aggregates, the two channel statements and both hygiene reports ride one batch; only the top-notes
 * titles need a second flight, because which notes made the top ten is not known before the first.
 */
async function loadGlobalAnalytics(
  database: D1Database,
  userId: string,
  ctx: AnalyticsContext,
  acknowledgedAt: number | null,
): Promise<ShareGlobalAnalytics> {
  const scope: VisitScope = { userId }
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
  ] = await database.batch([
    shareSummaryStatement(database, userId, ctx.now),
    prevVisitStatsStatement(database, userId, ctx.prevStartTs, ctx.startTs, ctx.clause),
    visitFilterStatsStatement(database, userId, ctx.startTs),
    recentVisitsStatement(database, { userId, startTs: ctx.startTs, clause: ctx.clause }),
    staleLinksStatement(database, { userId, now: ctx.now }),
    expiredLinksStatement(database, { userId, now: ctx.now, acknowledgedAt }),
    channelBreakdownStatement(database, scope, ctx),
    collectionChannelLabelsStatement(database, userId),
    ...visitAggregateStatements(database, scope, ctx),
  ])
  const aggregate = visitAggregateFromResults(visitResults, ctx)
  return composeGlobalAnalytics({
    ctx,
    aggregate,
    summary: firstOf<ShareSummaryRow>(summaryResult),
    prevStats: firstOf<PrevStatsRow>(prevStatsResult),
    filterStats: firstOf<FilterStatsRow>(filterStatsResult),
    topNotes: await loadTopNotes(database, userId, aggregate.targets),
    recentVisits: toVisitLogs(rowsOf<VisitLogRow>(recentResult)),
    staleLinks: composeStaleLinks(rowsOf<StaleLinkRow>(staleRowsResult)),
    expiredLinks: composeExpiredLinks(acknowledgedAt, rowsOf<ExpiredLinkRow>(expiredRowsResult)),
    channels: composeChannels(
      rowsOf<ChannelCountRow>(channelResult),
      aggregate.views,
      collectionChannelLabels(rowsOf<CollectionLabelRow>(channelLabelResult)),
    ),
  })
}

function composeGlobalAnalytics(params: {
  ctx: AnalyticsContext
  aggregate: VisitAggregate
  summary: ShareSummaryRow | null
  prevStats: PrevStatsRow | null
  filterStats: FilterStatsRow | null
  topNotes: ShareGlobalAnalytics['topNotes']
  recentVisits: ShareVisitLog[]
  staleLinks: ShareStaleLinks
  expiredLinks: ShareExpiredLinks
  channels: ShareBreakdownItem[]
}): ShareGlobalAnalytics {
  const { ctx, aggregate, summary, prevStats, filterStats, topNotes, recentVisits, staleLinks, expiredLinks, channels } =
    params
  const timeline = buildBucketedTimeline(aggregate.buckets, ctx.range, ctx.startTs, ctx.duration)
  // A window shorter than a day is still measured per day, never per zero.
  const daysSpan = Math.max(1, Math.round(ctx.duration / DAY_MS))
  const breakdown = breakdownsOf(aggregate, aggregate.views)
  const viewsPerDay = perDayRate(aggregate.views, daysSpan)
  // The rate is compared with the same rate over the previous window of the same length, so the badge
  // answers "did the pace change" rather than "did the window grow". A previous period of zero answers
  // nothing at all, which is what keeps a first week of traffic from reading as "+100% from nothing".
  const prevViewsPerDay = perDayRate(prevStats?.prev_views ?? 0, daysSpan)
  return {
    range: ctx.range,
    totalShares: summary?.total_shares ?? 0,
    activeShares: summary?.active_shares ?? 0,
    totalViews: aggregate.views,
    totalVisitors: aggregate.visitors,
    viewsDelta: computeDelta(aggregate.views, prevStats?.prev_views ?? 0),
    visitorsDelta: computeDelta(aggregate.visitors, prevStats?.prev_uv ?? 0),
    viewsPerDay,
    viewsPerDayDelta: computeDelta(viewsPerDay, prevViewsPerDay),
    timeline,
    topNotes,
    topCountries: breakdown.countries,
    topReferrers: breakdown.referrers,
    devices: breakdown.devices,
    osList: breakdown.osList,
    browsers: breakdown.browsers,
    channels,
    recentVisits,
    staleLinks,
    expiredLinks,
    filterStats: {
      bots: filterStats?.bots ?? 0,
      selfReferrals: filterStats?.self_referrals ?? 0,
      owner: filterStats?.owner ?? 0,
    },
  }
}

function breakdownsOf(
  maps: VisitDistributionMaps,
  total: number,
): Record<'countries' | 'referrers' | 'devices' | 'osList' | 'browsers', ShareBreakdownItem[]> {
  return {
    countries: toBreakdown(maps.countries, total),
    referrers: toBreakdown(maps.referrers, total),
    devices: toBreakdown(maps.devices, total),
    osList: toBreakdown(maps.osList, total),
    browsers: toBreakdown(maps.browsers, total),
  }
}

/**
 * The links the aggregate put in the window, with their titles.
 *
 * Equal view counts have no order out of a `GROUP BY`, so ties break by note id and the card is the same
 * list on two requests. The titles come from one `IN (...)` read of this account's own notes, so a link
 * whose note row is gone keeps a `null` title and the client labels it.
 */
async function loadTopNotes(
  database: D1Database,
  userId: string,
  targets: Map<string, VisitTargetStat>,
): Promise<ShareGlobalAnalytics['topNotes']> {
  const ranked = Array.from(targets, ([noteId, stat]) => ({ noteId, ...stat }))
    .sort((a, b) => b.views - a.views || (a.noteId < b.noteId ? -1 : 1))
    .slice(0, ANALYTICS_CARD_LIMIT)
  if (!ranked.length) return []
  const placeholders = ranked.map((_, index) => `?${index + 2}`).join(', ')
  const noteRows = await database
    .prepare(`SELECT id, title FROM notes WHERE user_id = ?1 AND id IN (${placeholders})`)
    .bind(userId, ...ranked.map((note) => note.noteId))
    .all<{ id: string; title: string }>()
  const titles = new Map((noteRows.results ?? []).map((row) => [row.id, row.title]))
  return ranked.map((note) => ({
    noteId: note.noteId,
    noteTitle: titles.get(note.noteId) ?? null,
    slug: note.slug,
    views: note.views,
    visitors: note.visitors,
  }))
}

/**
 * The two link counts the dashboard's header prints.
 *
 * `active` is the shared rule rather than a condition of its own, and no `SUM(views)` is selected: the
 * reading beside this row is measured over `share_visits`, so a counter that disagrees with the log it sits
 * next to is not an answer either of them wants. A dead column is also a column nobody tests.
 */
function shareSummaryStatement(database: D1Database, userId: string, now: number): D1PreparedStatement {
  const active = statusFragment('active', now, 2)
  return database
    .prepare(
      `SELECT COUNT(*) AS total_shares,
              COUNT(CASE WHEN ${active.sql} THEN 1 END) AS active_shares
         FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE s.user_id = ?1 AND n.deleted_at IS NULL`,
    )
    .bind(userId, ...active.binds)
}

function noteShareStatement(database: D1Database, userId: string, noteId: string): D1PreparedStatement {
  return database
    .prepare(
      `SELECT s.*, n.title AS note_title
         FROM shares s LEFT JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE s.note_id = ?1 AND s.user_id = ?2`,
    )
    .bind(noteId, userId)
}

/** The same window one step earlier, for the two trend badges. */
function prevVisitStatsStatement(
  database: D1Database,
  userId: string,
  prevStartTs: number,
  startTs: number,
  clause: string,
): D1PreparedStatement {
  return database
    .prepare(
      `SELECT COUNT(*) AS prev_views, ${VISITOR_COUNT_SQL} AS prev_uv
         FROM share_visits
        WHERE user_id = ?1 AND visited_at >= ?2 AND visited_at < ?3 ${clause}`,
    )
    .bind(userId, prevStartTs, startTs)
}

/** How many rows the filters are hiding, so the dashboard can say what it left out. */
function visitFilterStatsStatement(database: D1Database, userId: string, startTs: number): D1PreparedStatement {
  return database
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
function staleLinksStatement(
  database: D1Database,
  params: { userId: string; now: number },
): D1PreparedStatement {
  const active = statusFragment('active', params.now, 2)
  const cutoff = params.now - STALE_THRESHOLD_DAYS * DAY_MS
  return database
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

function composeStaleLinks(rows: StaleLinkRow[]): ShareStaleLinks {
  return {
    thresholdDays: STALE_THRESHOLD_DAYS,
    // The window function counts every match; the limit only decides how many are listed.
    total: rows[0]?.stale_total ?? 0,
    neverViewed: rows[0]?.never_viewed ?? 0,
    items: rows.map((row) => ({
      noteId: row.note_id,
      noteTitle: row.note_title,
      slug: row.slug,
      lastViewedAt: row.last_viewed_at,
      views: row.views,
    })),
  }
}

/**
 * The expiry notice: links that lapsed since the owner last dismissed it.
 *
 * The dismissal is one timestamp, so "new since the last time I looked" is `expires_at > acknowledgedAt` —
 * a link that expired again after being acknowledged comes back, and one acknowledged once stays gone.
 */
function expiredLinksStatement(
  database: D1Database,
  params: { userId: string; now: number; acknowledgedAt: number | null },
): D1PreparedStatement {
  const expired = statusFragment('expired', params.now, 2)
  return database
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

function composeExpiredLinks(acknowledgedAt: number | null, rows: ExpiredLinkRow[]): ShareExpiredLinks {
  return {
    acknowledgedAt,
    total: rows[0]?.expired_total ?? 0,
    items: rows.map((row) => ({
      noteId: row.note_id,
      noteTitle: row.note_title,
      slug: row.slug,
      expiresAt: row.expires_at,
    })),
  }
}

/** An unknown log filter is refused: answering with every row reads as a filter that matched everything. */
function visitLogFilterParam(raw: string | undefined): VisitLogFilter {
  if (!raw) return 'all'
  if (!isVisitLogFilter(raw)) throw ApiError.badRequest(`Unknown visit filter: ${raw}`)
  return raw
}

interface VisitLogScope {
  noteId?: string
  slug?: string
}

/**
 * The link a log request narrows to, or nothing at all for the whole account.
 *
 * Whitespace counts as absent: a filter the client cleared arrives empty, and the account-wide reading is
 * what an empty filter means. A named link this account does not own is a 404 rather than an empty page, so
 * the log cannot be used to ask whether a note id or a slug belongs to somebody else.
 */
async function resolveVisitScope(
  database: D1Database,
  userId: string,
  rawNoteId: string | undefined,
  rawSlug: string | undefined,
): Promise<VisitLogScope> {
  const noteId = rawNoteId?.trim() ?? ''
  const slug = rawSlug?.trim() ?? ''
  if (noteId && slug) throw ApiError.badRequest('The visit log narrows to one note id or one slug, not both')
  if (noteId) {
    if (!isValidId(noteId)) throw ApiError.badRequest('noteId is not a valid id')
    const owned = await database
      .prepare(`SELECT 1 AS found FROM shares WHERE note_id = ?1 AND user_id = ?2`)
      .bind(noteId, userId)
      .first<{ found: number }>()
    if (!owned) throw ApiError.notFound('Share or note not found')
    return { noteId }
  }
  if (slug) {
    if (!isValidSlug(slug)) throw ApiError.badRequest('slug is not a valid link address')
    const owned = await database
      .prepare(`SELECT 1 AS found FROM shares WHERE slug = ?1 AND user_id = ?2`)
      .bind(slug, userId)
      .first<{ found: number }>()
    if (!owned) throw ApiError.notFound('The link does not exist')
    return { slug }
  }
  return {}
}

/**
 * The log's `WHERE`, built once for the page and for its count.
 *
 * Placeholders number from the account bind at `?1`, and every value is a bind; the only text spliced in is
 * the log filter, the live-link test and the module's own column list.
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
  database: D1Database,
  where: { sql: string; binds: Array<string | number>; nextBind: number },
  limit: number,
  offset: number,
): [D1PreparedStatement, D1PreparedStatement] {
  return [
    database
      .prepare(`SELECT COUNT(*) AS total FROM share_visits sv WHERE ${where.sql}`)
      .bind(...where.binds),
    database
      .prepare(
        `SELECT ${VISIT_LOG_COLUMNS}
           FROM share_visits sv
           LEFT JOIN notes n ON n.id = sv.note_id AND n.user_id = sv.user_id
          WHERE ${where.sql}
          ORDER BY sv.visited_at DESC
          LIMIT ?${where.nextBind} OFFSET ?${where.nextBind + 1}`,
      )
      .bind(...where.binds, limit, offset),
  ]
}

/**
 * A visit row as the API answers it.
 *
 * `visitor_fp` is truncated on the way out, and `user_agent` is read only for a row already marked as a bot
 * and then only through `parseBotName`. What leaves the worker is a device class, an operating system, a
 * browser, a bot name and eight characters of a salted digest — never the address or the string those were
 * derived from, and no IP is stored to leak in the first place.
 */
function toVisitLog(row: VisitLogRow, noteTitle?: string | null): ShareVisitLog {
  return {
    id: row.id,
    noteId: row.note_id,
    noteTitle: row.note_title ?? noteTitle ?? null,
    slug: row.slug,
    visitedAt: row.visited_at,
    country: row.country,
    region: row.region,
    city: row.city,
    referrer: row.referrer,
    referrerHost: row.referrer_host,
    deviceType: row.device_type,
    os: row.os,
    browser: row.browser,
    visitorFp: row.visitor_fp ? publicVisitorFingerprint(row.visitor_fp) : null,
    isBot: row.is_bot === 1,
    isSelfReferrer: row.is_self_referrer === 1,
    isOwner: row.is_owner === 1,
    botName: row.is_bot === 1 ? parseBotName(row.user_agent ?? '') : null,
    // The empty string is the stored "a marker was sent and refused"; which kind of miss it was is the
    // channel card's split, so a row shows the marker or nothing.
    channel: row.channel || null,
  }
}

function toVisitLogs(rows: VisitLogRow[], noteTitle?: string | null): ShareVisitLog[] {
  return rows.map((row) => toVisitLog(row, noteTitle))
}

/**
 * The recent list beside a dashboard: the same rows the log pages over, narrowed to the reading's own window
 * and traffic filters, so the two lists cannot show different traffic for the same heading.
 */
function recentVisitsStatement(
  database: D1Database,
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
  return database
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

function globalSummaryStatement(database: D1Database, userId: string, now: number): D1PreparedStatement {
  const counts = statusCountSelect(now)
  return database
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
function visitTotalsStatement(database: D1Database, userId: string): D1PreparedStatement {
  return database
    .prepare(
      `SELECT COUNT(*) AS total_views, ${VISITOR_COUNT_SQL} AS total_visitors
         FROM share_visits sv
        WHERE sv.user_id = ?1 AND ${liveLinkCondition('sv')}${visitTrafficSql(DEFAULT_TRAFFIC_FILTERS, 'sv')}`,
    )
    .bind(userId)
}

interface FolderCountRow {
  folder_id: string
  total_shares: number
  shared_notes: number
}

/**
 * What each folder covers.
 *
 * "Shared" is the collection page's own rule — `active`, over a note that is not in the trash — so a folder
 * whose row says three cannot open on a page that lists two.
 */
function folderCountsStatement(database: D1Database, userId: string, now: number): D1PreparedStatement {
  const live = statusFragment('active', now, 2)
  return database
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

interface TagCountRow {
  name: string
  total: number
  shared: number
}

/**
 * What each tag covers, by the same element test the list filter uses.
 *
 * `shareTagElementSql('s', 't.name')` asks whether the name is one element of the stored array; the
 * substring test it replaces counted `monthly-report` under a tag called `report`.
 */
function tagCountsStatement(database: D1Database, userId: string, now: number): D1PreparedStatement {
  const live = statusFragment('active', now, 2)
  return database
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

/** The counts keyed for the sidebar, with the live half never ahead of the total. */
function toCountMap(rows: Array<{ key: string; total: number; shared: number }>): Record<string, { total: number; shared: number }> {
  const counts: Record<string, { total: number; shared: number }> = {}
  for (const row of rows) counts[row.key] = { total: row.total, shared: Math.min(row.shared, row.total) }
  return counts
}

function toFolderCounts(rows: FolderCountRow[]): Record<string, { total: number; shared: number }> {
  return toCountMap(rows.map((row) => ({ key: row.folder_id, total: row.total_shares, shared: row.shared_notes })))
}

function toTagCounts(rows: TagCountRow[]): Record<string, { total: number; shared: number }> {
  return toCountMap(rows.map((row) => ({ key: row.name, total: row.total, shared: row.shared })))
}

function composeGlobalStats(
  summary: GlobalSummaryRow | null,
  visitTotals: VisitTotalsRow | null,
  folderCounts: Record<string, { total: number; shared: number }>,
  tagCounts: Record<string, { total: number; shared: number }>,
): ShareGlobalStats {
  return {
    totalShares: summary?.total_shares ?? 0,
    activeShares: summary?.active_shares ?? 0,
    pinnedShares: summary?.pinned_shares ?? 0,
    starredShares: summary?.starred_shares ?? 0,
    pausedShares: summary?.paused_shares ?? 0,
    passwordShares: summary?.password_shares ?? 0,
    expiringShares: summary?.expiring_shares ?? 0,
    expiringSoonShares: summary?.expiring_soon_shares ?? 0,
    permanentShares: summary?.permanent_shares ?? 0,
    expiredShares: summary?.expired_shares ?? 0,
    totalViews: visitTotals?.total_views ?? 0,
    totalVisitors: visitTotals?.total_visitors ?? 0,
    folderCounts,
    tagCounts,
  }
}
