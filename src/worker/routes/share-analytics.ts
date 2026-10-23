import { Hono } from 'hono'
import { LIMITS, SHARE_STALE_DEFAULT_DAYS } from '@shared/constants'
import { parseChannelDrillDown } from '@shared/share-channel'
import type {
  ShareBreakdownItem,
  ShareExpiredLinks,
  ShareGlobalAnalytics,
  ShareGlobalStats,
  ShareNoteAnalytics,
  ShareStaleLinks,
  ShareVisitLog,
} from '@shared/share-hub'
import { type VisitLogFilter, isVisitLogFilter } from '@shared/share-selection'
import type { AppBindings } from '../env'
import { getMeta, setMeta } from '../db/metadata'
import { ApiError } from '../lib/errors'
import { isValidId, isValidSlug } from '../lib/id'
import { createMinuteBudget } from '../lib/rate-limit'
import { clampInt } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { ShareAnalyticsStore } from '../share/analytics-store'
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
import type {
  VisitAggregate,
  VisitDistributionMaps,
  VisitScope,
  VisitTargetStat,
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

/** One page of the visit log, and the deepest page a caller may name. */
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

/** How many quiet days make a link stale, when the account has not named its own. */
const STALE_THRESHOLD_DAYS = SHARE_STALE_DEFAULT_DAYS

export const shareAnalyticsRoutes = new Hono<AppBindings>()

shareAnalyticsRoutes.use('*', requireAuth)

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

shareAnalyticsRoutes.get('/analytics/global', async (c) => {
  const userId = c.get('userId')
  const store = new ShareAnalyticsStore(c.env.DB, userId)
  const ctx = await analyticsContext(store, c, { userId })
  // Only the unbounded range is charged: a bounded one reads a single window of rows.
  if (ctx.range === 'all') chargeReadBudget(userId)
  // Read ahead of the batch, because the expired-links query filters on it.
  const acknowledgedAt = parseExpiredAck(await getMeta(c.env.DB, expiredAckMetaKey(userId)))
  const read = await store.globalDashboard(ctx, acknowledgedAt)
  return c.json(composeGlobalAnalytics({
    ctx,
    aggregate: read.aggregate,
    summary: read.summary,
    prevStats: read.prevStats,
    filterStats: read.filterStats,
    topNotes: await topNotesOf(store, read.aggregate.targets),
    recentVisits: toVisitLogs(read.recentVisits),
    staleLinks: composeStaleLinks(read.staleLinks),
    expiredLinks: composeExpiredLinks(acknowledgedAt, read.expiredLinks),
    channels: read.channels,
  }))
})

shareAnalyticsRoutes.post('/analytics/expired-ack', async (c) => {
  await setMeta(c.env.DB, expiredAckMetaKey(c.get('userId')), String(Date.now()))
  return c.json({ ok: true })
})

shareAnalyticsRoutes.get('/analytics/note/:noteId', async (c) => {
  const userId = c.get('userId')
  const store = new ShareAnalyticsStore(c.env.DB, userId)
  const noteId = c.req.param('noteId')
  // A malformed id and a foreign one get the same answer: neither tells the caller anything about the id
  // they guessed, and a dashboard has nothing of this account's to show for either.
  if (!isValidId(noteId)) throw ApiError.notFound('Share or note not found')
  const share = await store.noteShareRow(noteId)
  if (!share) throw ApiError.notFound('Share or note not found')

  const ctx = await analyticsContext(store, c, { userId, targetId: noteId })
  if (ctx.range === 'all') chargeReadBudget(userId)
  const read = await store.noteDashboard(noteId, ctx)
  const aggregate = read.aggregate
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
    channels: read.channels,
    recentVisits: toVisitLogs(read.recentVisits, share.note_title),
  } satisfies ShareNoteAnalytics)
})

/**
 * One page of the visit log.
 *
 * The deepest page a caller can name is bounded by the shared product limits — the arithmetic on
 * `OFFSET` is written out where the statements are built, in `analytics-store`.
 */
shareAnalyticsRoutes.get('/visits', async (c) => {
  const userId = c.get('userId')
  const store = new ShareAnalyticsStore(c.env.DB, userId)
  const page = clampInt(c.req.query('page'), VISITS_PAGE_DEFAULT, LIMITS.shareVisitsPageMax, VISITS_PAGE_DEFAULT)
  const limit = clampInt(c.req.query('limit'), 1, LIMITS.shareVisitsPerPage, VISITS_LIMIT_DEFAULT)
  const filter = visitLogFilterParam(c.req.query('filter'))
  const channel = parseChannelDrillDown(c.req.query('channel'))
  // A mistyped channel is refused rather than folded into "no filter": a dropped drill-down that answered
  // with every row would read as "this channel sent everything".
  if (channel.kind === 'invalid') throw ApiError.badRequest(`Unknown visit channel: ${c.req.query('channel')}`)
  const scope = await resolveVisitScope(store, c.req.query('noteId'), c.req.query('slug'))
  // The page's total is an unbounded `COUNT(*)` over the account, so it shares the read budget.
  chargeReadBudget(userId)
  const read = await store.visitLogPage({ scope, filter, channel, limit, offset: (page - 1) * limit })
  return c.json({
    visits: toVisitLogs(read.rows),
    total: read.total,
    page,
    limit,
    totalPages: Math.ceil(read.total / limit),
  })
})

/**
 * Wipes the account's visit rows, and the counters derived from them.
 *
 * The two statements and why they must be one batch are the store's; this only answers with the row
 * count it reports.
 */
shareAnalyticsRoutes.delete('/visits', async (c) => {
  const deleted = await new ShareAnalyticsStore(c.env.DB, c.get('userId')).wipeVisits()
  return c.json({ ok: true, deleted })
})

/**
 * The sidebar's counters: ten category counts, the folder and tag counts, and the all-time traffic the
 * footer prints.
 *
 * The four statements ride one batch in the store, and there is no memoization here or there: the
 * reference cached this and silently switched the footer between two different measures depending on
 * whether the cache was warm. The read budget is the honest brake.
 */
shareAnalyticsRoutes.get('/stats', async (c) => {
  const now = Date.now()
  const userId = c.get('userId')
  chargeReadBudget(userId)
  const read = await new ShareAnalyticsStore(c.env.DB, userId).sidebarStats(now)
  const globalStats: ShareGlobalStats = composeGlobalStats(
    read.summary,
    read.totals,
    toFolderCounts(read.folders),
    toTagCounts(read.tags),
  )
  return c.json({ globalStats })
})

/** The window and clause every share read resolves, so two panels cannot disagree about "7d, no bots". */
async function analyticsContext(
  store: ShareAnalyticsStore,
  c: { req: { query(key: string): string | undefined } },
  scope: VisitScope,
): Promise<AnalyticsContext> {
  const request = parseAnalyticsRequest(c)
  const earliest = request.range === 'all' ? await store.minVisitedAt(scope.targetId) : null
  return { ...request, ...analyticsWindow(request.range, request.now, earliest) }
}

/**
 * The dashboard's top-notes card: the busiest links out of the window's per-target stats, with the
 * titles read back for just those ids.
 *
 * The ranking and the card's ceiling live here rather than in the store because they are a presentation
 * choice — which ten of the account's links a reader is shown — while the titles are the one second
 * flight the batch cannot predict.
 */
async function topNotesOf(
  store: ShareAnalyticsStore,
  targets: Map<string, VisitTargetStat>,
): Promise<ShareGlobalAnalytics['topNotes']> {
  const ranked = Array.from(targets, ([noteId, stat]) => ({ noteId, ...stat }))
    .sort((left, right) => right.views - left.views || (left.noteId < right.noteId ? -1 : 1))
    .slice(0, ANALYTICS_CARD_LIMIT)
  if (!ranked.length) return []
  const titles = await store.noteTitles(ranked.map((note) => note.noteId))
  return ranked.map((note) => ({
    noteId: note.noteId,
    noteTitle: titles.get(note.noteId) ?? null,
    slug: note.slug,
    views: note.views,
    visitors: note.visitors,
  }))
}

/**
 * Which link a log request narrows to, checked against the account that owns the store.
 *
 * An id and a slug together is a contradiction the caller should hear about; either alone is answered
 * the same way whether it is malformed, foreign or simply absent, so the log is not a way to ask
 * whether some other account published something.
 */
async function resolveVisitScope(
  store: ShareAnalyticsStore,
  rawNoteId: string | undefined,
  rawSlug: string | undefined,
): Promise<VisitLogScope> {
  const noteId = rawNoteId?.trim() ?? ''
  const slug = rawSlug?.trim() ?? ''
  if (noteId && slug) throw ApiError.badRequest('The visit log narrows to one note id or one slug, not both')
  if (noteId) {
    if (!isValidId(noteId)) throw ApiError.badRequest('noteId is not a valid id')
    if (!(await store.ownsNoteShare(noteId))) throw ApiError.notFound('Share or note not found')
    return { noteId }
  }
  if (slug) {
    if (!isValidSlug(slug)) throw ApiError.badRequest('slug is not a valid link address')
    if (!(await store.ownsShareSlug(slug))) throw ApiError.notFound('The link does not exist')
    return { slug }
  }
  return {}
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
 * The log's `WHERE`, built once for the page and for its count.
 *
 * Placeholders number from the account bind at `?1`, and every value is a bind; the only text spliced in is
 * the log filter, the live-link test and the module's own column list.
 */

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

interface FolderCountRow {
  folder_id: string
  total_shares: number
  shared_notes: number
}

interface TagCountRow {
  name: string
  total: number
  shared: number
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
