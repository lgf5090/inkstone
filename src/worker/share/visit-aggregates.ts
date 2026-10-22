import type { ShareTimelineRange } from '@shared/share-hub'
import { bucketsFromVisitRows, timelineBucketCount, type TimelineBucket } from './analytics'

/**
 * The readings every share dashboard takes from one visit table.
 *
 * Both aggregate paths answer the same questions — totals, timeline buckets, five distributions and
 * the per-link stats — and they answer them over exactly the rows the traffic filters allow. Every
 * range is summarized in SQL: fetching a window's rows and grouping them in JS put the whole window in
 * memory (10k visits is about 1.5 MB) and made a rapid range switch worse than the read it served.
 * `aggregateFromRows` stays as the reference implementation the SQL path is verified against
 * (`visit-aggregates.test.ts` runs both over the same predicate); both build the same normalized
 * shape, which is what the dashboards consume.
 */

/** The one visit table this module reads. A second source would be a second set of statements, not a flag. */
const VISIT_TABLE = 'share_visits'
const TARGET_COLUMN = 'note_id'
/**
 * The OS bucket's fallback label. Lowercase because that is what the recording side stores for a
 * visit it could not classify, so the bucket and the row agree without a mapping layer.
 */
const OS_FALLBACK = 'other'

/**
 * The distinct-visitor measure, spelled once for the statements that count a window's UV with it.
 *
 * The empty-string guard is what keeps a visit that carried neither an address nor a user agent from
 * becoming a visitor of its own, and a footer number that used a second copy of the expression would be
 * one edit away from meaning something else than the timeline above it.
 */
export const VISITOR_COUNT_SQL = `COUNT(DISTINCT NULLIF(visitor_fp, ''))`

export interface VisitScope {
  userId: string
  targetId?: string
}

export interface VisitAggregateQuery {
  range: ShareTimelineRange
  startTs: number
  duration: number
  clause: string
}

export interface VisitFactRow {
  visited_at: number
  visitor_fp: string | null
  country: string | null
  referrer_host: string | null
  device_type: string | null
  os: string | null
  browser: string | null
  target_id: string | null
  slug: string
}

export interface VisitTargetStat {
  views: number
  visitors: number
  slug: string
}

export interface VisitDistributionMaps {
  countries: Map<string, number>
  referrers: Map<string, number>
  devices: Map<string, number>
  osList: Map<string, number>
  browsers: Map<string, number>
}

export interface VisitAggregate extends VisitDistributionMaps {
  views: number
  visitors: number
  buckets: TimelineBucket[]
  targets: Map<string, VisitTargetStat>
}

export function aggregateFromRows(rows: VisitFactRow[], query: VisitAggregateQuery): VisitAggregate {
  const visitors = new Set<string>()
  const countries = new Map<string, number>()
  const referrers = new Map<string, number>()
  const devices = new Map<string, number>()
  const osList = new Map<string, number>()
  const browsers = new Map<string, number>()
  const targetRows = new Map<string, { views: number; uvs: Set<string>; slug: string }>()

  for (const row of rows) {
    if (row.visitor_fp) visitors.add(row.visitor_fp)
    bump(countries, (row.country || 'Unknown').toUpperCase())
    bump(referrers, row.referrer_host || 'Direct')
    bump(devices, row.device_type || 'desktop')
    bump(osList, row.os || OS_FALLBACK)
    bump(browsers, row.browser || 'Other')
    if (row.target_id) {
      const entry = targetRows.get(row.target_id) ?? { views: 0, uvs: new Set<string>(), slug: '' }
      entry.views += 1
      if (row.visitor_fp) entry.uvs.add(row.visitor_fp)
      // Visits keep their stored slug after the link is renamed, so a target can have several;
      // MAX() is what the SQL path answers with, so this matches it.
      if (row.slug > entry.slug) entry.slug = row.slug
      targetRows.set(row.target_id, entry)
    }
  }

  const targets = new Map<string, VisitTargetStat>()
  for (const [targetId, entry] of targetRows) {
    targets.set(targetId, { views: entry.views, visitors: entry.uvs.size, slug: entry.slug })
  }

  return {
    views: rows.length,
    visitors: visitors.size,
    buckets: bucketsFromVisitRows(rows, query.range, query.startTs, query.duration),
    countries,
    referrers,
    devices,
    osList,
    browsers,
    targets,
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1)
}

export interface VisitWhere {
  sql: string
  binds: Array<string | number>
  startTsParam: number
}

/**
 * The scope and range every statement about the visit table shares. Exported so a statement a single
 * dashboard needs on top of the common set (the channel split) filters exactly the same rows the
 * aggregate beside it does, instead of re-deriving the predicate.
 *
 * The account is a bind, never a fragment of text: an unscoped read would be one query away from
 * showing one owner another owner's traffic.
 */
export function visitWhere(scope: VisitScope, query: VisitAggregateQuery): VisitWhere {
  const binds: Array<string | number> = []
  const conditions: string[] = []
  if (scope.targetId) {
    binds.push(scope.targetId)
    conditions.push(`${TARGET_COLUMN} = ?${binds.length}`)
  }
  binds.push(scope.userId)
  conditions.push(`user_id = ?${binds.length}`)
  binds.push(query.startTs)
  conditions.push(`visited_at >= ?${binds.length}`)
  return { sql: `${conditions.join(' AND ')} ${query.clause}`, binds, startTsParam: binds.length }
}

/**
 * One result object out of a `db.batch()` call, unpacked the way this repo's D1 reads are: a batch
 * answers with one result per statement, each holding its own `results` array.
 */
export interface D1ReadResult {
  results?: unknown[]
}

export function rowsOf<T>(result: D1ReadResult | undefined): T[] {
  return (result?.results ?? []) as T[]
}

export function firstOf<T>(result: D1ReadResult | undefined): T | null {
  return rowsOf<T>(result)[0] ?? null
}

// Eight statements, whichever range is asked: totals, buckets (bounded to the window's end, while
// the totals keep counting what sits past it), five distributions and per-target stats.
// `visitAggregateFromResults` unpacks them back in the same order.
export function visitAggregateStatements(
  db: D1Database,
  scope: VisitScope,
  query: VisitAggregateQuery,
): D1PreparedStatement[] {
  const where = visitWhere(scope, query)
  const bucketWidth = query.duration / timelineBucketCount(query.range)
  return [
    db.prepare(
      `SELECT COUNT(*) AS views, ${VISITOR_COUNT_SQL} AS visitors
         FROM ${VISIT_TABLE} WHERE ${where.sql}`,
    ).bind(...where.binds),
    db.prepare(
      `SELECT CAST((visited_at - ?${where.startTsParam}) / ?${where.startTsParam + 1} AS INTEGER) AS bucket,
              COUNT(*) AS views, ${VISITOR_COUNT_SQL} AS visitors
         FROM ${VISIT_TABLE}
        WHERE ${where.sql} AND visited_at < ?${where.startTsParam + 2}
        GROUP BY bucket`,
    ).bind(...where.binds, bucketWidth, query.startTs + query.duration),
    ...distributionStatements(db, where),
    db.prepare(
      `SELECT ${TARGET_COLUMN} AS target_id, COUNT(*) AS views,
              ${VISITOR_COUNT_SQL} AS visitors, MAX(slug) AS slug
         FROM ${VISIT_TABLE}
        WHERE ${where.sql} AND ${TARGET_COLUMN} IS NOT NULL
        GROUP BY ${TARGET_COLUMN}`,
    ).bind(...where.binds),
  ]
}

// The OS bucket falls back to a stored-shape label, so that one statement binds an extra parameter
// the others do not.
function distributionStatements(db: D1Database, where: VisitWhere): D1PreparedStatement[] {
  const dimension = (expression: string): string =>
    `SELECT ${expression} AS name, COUNT(*) AS count FROM ${VISIT_TABLE} WHERE ${where.sql} GROUP BY name`
  return [
    // The fallback has to be uppercased too: the client matches the country bucket on 'UNKNOWN' to
    // show its "unknown country" label.
    db.prepare(dimension(`COALESCE(NULLIF(UPPER(country), ''), 'UNKNOWN')`)).bind(...where.binds),
    db.prepare(dimension(`COALESCE(NULLIF(referrer_host, ''), 'Direct')`)).bind(...where.binds),
    db.prepare(dimension(`COALESCE(NULLIF(device_type, ''), 'desktop')`)).bind(...where.binds),
    db.prepare(dimension(`COALESCE(NULLIF(os, ''), ?${where.startTsParam + 1})`)).bind(...where.binds, OS_FALLBACK),
    db.prepare(dimension(`COALESCE(NULLIF(browser, ''), 'Other')`)).bind(...where.binds),
  ]
}

export interface VisitTotalsSqlRow {
  views: number
  visitors: number
}

export interface VisitBucketSqlRow {
  bucket: number
  views: number
  visitors: number
}

export interface VisitNameCountSqlRow {
  name: string
  count: number
}

export interface VisitTargetSqlRow {
  target_id: string
  views: number
  visitors: number
  slug: string
}

export function visitAggregateFromResults(results: D1ReadResult[], query: VisitAggregateQuery): VisitAggregate {
  const buckets: TimelineBucket[] = Array.from({ length: timelineBucketCount(query.range) }, () => ({ views: 0, visitors: 0 }))
  for (const row of rowsOf<VisitBucketSqlRow>(results[1])) {
    const bucket = buckets[row.bucket]
    if (bucket) {
      bucket.views = row.views
      bucket.visitors = row.visitors
    }
  }
  const targets = new Map<string, VisitTargetStat>()
  for (const row of rowsOf<VisitTargetSqlRow>(results[7])) {
    targets.set(row.target_id, { views: row.views, visitors: row.visitors, slug: row.slug })
  }
  const totals = firstOf<VisitTotalsSqlRow>(results[0])
  return {
    views: totals?.views ?? 0,
    visitors: totals?.visitors ?? 0,
    buckets,
    countries: countsByName(rowsOf<VisitNameCountSqlRow>(results[2])),
    referrers: countsByName(rowsOf<VisitNameCountSqlRow>(results[3])),
    devices: countsByName(rowsOf<VisitNameCountSqlRow>(results[4])),
    osList: countsByName(rowsOf<VisitNameCountSqlRow>(results[5])),
    browsers: countsByName(rowsOf<VisitNameCountSqlRow>(results[6])),
    targets,
  }
}

function countsByName(rows: VisitNameCountSqlRow[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of rows) {
    map.set(row.name, row.count)
  }
  return map
}
