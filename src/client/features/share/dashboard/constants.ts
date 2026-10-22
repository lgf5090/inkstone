import type { ShareTimelineRange } from "@shared/share-hub"
import type { VisitTrafficFilters } from "@shared/share-selection"

/** Which series the trend card draws; the two answers a visit window can give about itself. */
export type TimelineMetric = "views" | "visitors"

/**
 * The window the dashboard opens on: the header's default selection, the request's default and the
 * name the exported file is stamped with all read this one constant. A second literal would let the
 * file describe a window the screen never showed.
 */
export const DEFAULT_TIMELINE_RANGE: ShareTimelineRange = "7d"

/** The series drawn before the reader has asked for the other one: PV, the cheaper question. */
export const DEFAULT_TIMELINE_METRIC: TimelineMetric = "views"

/**
 * How often a *visible* dashboard re-asks. Visit numbers move in minutes, and a faster cadence spends
 * the account's read budget redrawing the same figures.
 */
export const AUTO_REFRESH_MS = 45_000

/**
 * The trend card's plot box, named because a height written once as a class and once as a number in
 * another file cannot be kept in step.
 */
export const TIMELINE_CHART_HEIGHT = "h-60"

/** The traffic panel's box: the width the placement math is given before the panel has rendered. */
export const FILTER_PANEL_WIDTH = 320

/**
 * The height the panel is assumed to need, before it has been drawn. The panel measures itself once it
 * is on screen and re-places from the real number, so this only seeds the first frame.
 */
export const FILTER_PANEL_HEIGHT_ESTIMATE = 360

/**
 * What "real visitors" means, stated once: the exact three flags the server's visit filter reads, with
 * bots and the owner's own visits left out and self-referrals kept. There is no fourth flag, and this
 * preset is the only place the triple is spelled.
 */
export const REAL_VISITOR_FILTERS: VisitTrafficFilters = {
  excludeBots: true,
  excludeOwner: true,
  excludeSelfReferrers: false,
}

/** The other end of the master switch: every row the table holds, including bots. */
export const ALL_TRAFFIC_FILTERS: VisitTrafficFilters = {
  excludeBots: false,
  excludeOwner: false,
  excludeSelfReferrers: false,
}

/** Whether the three flags are exactly the preset, which is what the master switch reports. */
export function isRealVisitorFilters(filters: VisitTrafficFilters): boolean {
  return (
    filters.excludeBots === REAL_VISITOR_FILTERS.excludeBots &&
    filters.excludeOwner === REAL_VISITOR_FILTERS.excludeOwner &&
    filters.excludeSelfReferrers === REAL_VISITOR_FILTERS.excludeSelfReferrers
  )
}

/** Whether nothing at all is being hidden — the other named end of the master switch. */
export function isAllTrafficFilters(filters: VisitTrafficFilters): boolean {
  return (
    filters.excludeBots === ALL_TRAFFIC_FILTERS.excludeBots &&
    filters.excludeOwner === ALL_TRAFFIC_FILTERS.excludeOwner &&
    filters.excludeSelfReferrers === ALL_TRAFFIC_FILTERS.excludeSelfReferrers
  )
}

/** Local UI choices, keyed per device rather than per account. */
export const TRAFFIC_FILTERS_STORAGE_KEY = "inkstone_share_dashboard_filters"
export const AUTO_REFRESH_STORAGE_KEY = "inkstone_share_dashboard_auto_refresh"

/** The byte-order mark a spreadsheet needs to read a UTF-8 export as UTF-8 rather than as mojibake. */
export const CSV_BOM = "\uFEFF"

/** The file name prefix of a dashboard export; the range and the day it was taken follow it. */
export const CSV_FILE_PREFIX = "inkstone-share-analytics"
