import { CHANNEL_UNMARKED, CHANNEL_UNRECOGNIZED, collectionChannelToken } from '@shared/share-channel'
import type { ShareBreakdownItem } from '@shared/share-hub'
import { toBreakdown } from './analytics'
import { visitWhere, type VisitAggregateQuery, type VisitScope } from './visit-aggregates'

/**
 * Which copy of a link each visit came from.
 *
 * It lives beside the aggregates rather than inside them because only the share table carries a
 * marker column, and the dashboards read the aggregate statement list positionally. A visit with no
 * marker and a visit whose marker was refused are counted in separate rows and never merged: a marker
 * that quietly stopped matching has to be visible, not averaged into "direct". The two reserved names
 * cannot collide with a stored token, which always starts with a letter or digit (`@shared/share-channel`).
 */
export interface ChannelCountRow {
  name: string
  count: number
}

export function channelBreakdownStatement(
  db: D1Database,
  scope: VisitScope,
  query: VisitAggregateQuery,
): D1PreparedStatement {
  const where = visitWhere(scope, query)
  // The reserved labels are bound rather than written into the text, like every other value here:
  // they are constants today, and a statement builder that interpolates is one input away from a hole.
  const unmarkedParam = where.binds.length + 1
  return db.prepare(
    `SELECT CASE
              WHEN channel IS NULL THEN ?${unmarkedParam}
              WHEN channel = '' THEN ?${unmarkedParam + 1}
              ELSE channel
            END AS name,
            COUNT(*) AS count
       FROM share_visits
      WHERE ${where.sql}
      GROUP BY name`,
  ).bind(...where.binds, CHANNEL_UNMARKED, CHANNEL_UNRECOGNIZED)
}

/**
 * Percentages share the dashboard's denominator, so the split sums against the KPI row. `labels`
 * (from `collectionChannelLabels`) turns a directory's marker into the collection that sent the
 * visit; a marker with no entry stays exactly as the owner wrote it.
 */
export function composeChannels(
  rows: ChannelCountRow[],
  total: number,
  labels: Map<string, string> = new Map(),
): ShareBreakdownItem[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.name, row.count)
  return toBreakdown(counts, total).map((item) => {
    const label = labels.get(item.name)
    return label ? { ...item, label } : item
  })
}

/** One row per published collection: the address its links carry and the name to show for it. */
export interface CollectionLabelRow {
  slug: string
  name: string | null
}

/**
 * The names a collection directory goes by in the channel split.
 *
 * The stored `title` wins because that is the name the owner gave the page; a collection created
 * without one is named by whatever it publishes, which is what the hub's own list shows. Both are
 * read live, so a rename reaches the split instead of leaving a stale label beside it.
 */
export function collectionChannelLabelsStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare(
    `SELECT c.slug AS slug,
            COALESCE(
              NULLIF(c.title, ''),
              CASE c.target_type WHEN 'folder' THEN f.name ELSE t.name END
            ) AS name
       FROM share_collections c
       LEFT JOIN share_folders f ON c.target_type = 'folder' AND f.id = c.target_value AND f.user_id = c.user_id
       LEFT JOIN share_tags t ON c.target_type = 'tag' AND t.id = c.target_value AND t.user_id = c.user_id
      WHERE c.user_id = ?1`,
  ).bind(userId)
}

/** The marker-to-name map `composeChannels` reads; a collection whose name is gone contributes nothing. */
export function collectionChannelLabels(rows: CollectionLabelRow[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const row of rows) {
    if (row.name) labels.set(collectionChannelToken(row.slug), row.name)
  }
  return labels
}
