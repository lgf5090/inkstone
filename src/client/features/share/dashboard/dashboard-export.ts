import type { ShareBreakdownItem, ShareGlobalAnalytics, ShareTimelineRange } from "@shared/share-hub"
import type { VisitTrafficFilters } from "@shared/share-selection"
import { t } from "../../../lib/i18n"
import { CSV_BOM, CSV_FILE_PREFIX } from "./constants"
import {
  countryNameLocalized,
  deltaHintLabel,
  kpiLabels,
  localizeChannelName,
  localizeDeviceName,
  localizeEnvName,
  localizeReferrerName,
  rangeLabel,
  toCsvDocument,
  trafficFilterLabel,
} from "./dashboard-format"

/**
 * The dashboard's window as a file.
 *
 * The file opens with the window it describes — range, filters, what they removed, and when the reading
 * was taken — because a CSV loses every piece of context the screen had, and numbers without a window
 * answer nothing later.
 *
 * The sections are the dashboard's own cards, the labels are the ones those cards draw, and the names
 * are localized exactly as drawn, so the file and the screen cannot describe the same visit two
 * different ways. Nothing here truncates: the payload is the full answer, and a cap that exists to fit
 * a card is a layout decision, not a statement about the data.
 */

/** One row of the export: the card it came from, what it names, and its number. */
type CsvRow = [section: string, item: string, value: string | number]

export interface DashboardExportInput {
  analytics: ShareGlobalAnalytics
  range: ShareTimelineRange
  filters: VisitTrafficFilters
  locale: string
  generatedAt: number
}

export function buildDashboardCsv(input: DashboardExportInput): string {
  const { analytics, locale } = input
  const labels = kpiLabels()
  const header: CsvRow = [
    t("share.dashboard.export_col_section"),
    t("share.dashboard.export_col_item"),
    t("share.dashboard.export_col_value"),
  ]
  return `${CSV_BOM}${toCsvDocument([
    header,
    ...contextRows(input),
    ...kpiRows(analytics, labels),
    ...timelineRows(analytics),
    ...topNoteRows(analytics),
    ...breakdownRows(t("share.dashboard.card_countries"), analytics.topCountries, (item) => countryNameLocalized(item.name, locale)),
    ...breakdownRows(t("share.dashboard.card_referrers"), analytics.topReferrers, (item) => localizeReferrerName(item.name)),
    ...breakdownRows(t("share.dashboard.card_channels"), analytics.channels, (item) => localizeChannelName(item.name, item.label)),
    ...environmentRows(analytics),
    ...breakdownRows(t("share.dashboard.card_browsers"), analytics.browsers, (item) => localizeEnvName(item.name)),
    ...staleLinkRows(analytics),
    ...recentVisitRows(analytics, locale),
  ])}`
}

/** The file's own name: the window it holds and the day it was taken, both in the name. */
export function dashboardCsvFilename(range: ShareTimelineRange, generatedAt: number): string {
  const day = new Date(generatedAt).toISOString().slice(0, 10)
  return `${CSV_FILE_PREFIX}-${range}-${day}.csv`
}

/**
 * What the numbers below are: the window, whether anything was filtered out of it, the endpoint's
 * standing scope, and the moment of the reading. The exclusions are stated in the same sentence the
 * banner above the cards uses, and only when a filter is actually on.
 */
function contextRows(input: DashboardExportInput): CsvRow[] {
  const { analytics, range, filters, generatedAt } = input
  const section = t("share.dashboard.export_context")
  const rows: CsvRow[] = [
    [section, t("share.dashboard.range_label"), rangeLabel(range)],
    [section, t("share.dashboard.export_generated_at"), new Date(generatedAt).toISOString()],
    [section, t("share.dashboard.export_scope"), t("share.dashboard.scope_hint")],
    [section, t("share.dashboard.filter_traffic_title"), trafficFilterLabel(filters)],
  ]
  const isFilteringAnything = filters.excludeBots || filters.excludeOwner || filters.excludeSelfReferrers
  if (isFilteringAnything) {
    rows.push([
      section,
      t("share.dashboard.export_excluded"),
      t("share.dashboard.filter_summary", {
        bots: filters.excludeBots ? (analytics.filterStats?.bots ?? 0) : 0,
        self: filters.excludeSelfReferrers ? (analytics.filterStats?.selfReferrals ?? 0) : 0,
        owner: filters.excludeOwner ? (analytics.filterStats?.owner ?? 0) : 0,
      }),
    ])
  }
  return rows
}

/**
 * The four headline tiles, each delta as its own row. A delta belongs beside the promise it makes — the
 * previous window, which this file does not contain — so it carries that wording rather than sitting
 * unlabelled next to an absolute number.
 */
function kpiRows(analytics: ShareGlobalAnalytics, labels: Record<"pv" | "uv" | "activeShares" | "viewsPerDay", string>): CsvRow[] {
  const section = t("share.dashboard.title")
  return [
    [section, labels.pv, analytics.totalViews],
    ...deltaRow(section, labels.pv, analytics.viewsDelta),
    [section, labels.uv, analytics.totalVisitors],
    ...deltaRow(section, labels.uv, analytics.visitorsDelta),
    [section, labels.activeShares, `${analytics.activeShares} / ${analytics.totalShares}`],
    [section, labels.viewsPerDay, analytics.viewsPerDay],
    ...deltaRow(section, labels.viewsPerDay, analytics.viewsPerDayDelta),
  ]
}

function deltaRow(section: string, metric: string, delta: number | undefined): CsvRow[] {
  if (delta === undefined) return []
  return [[section, `${metric} · ${deltaHintLabel()}`, delta]]
}

/** Both series of the trend, one row each: the card draws whichever the metric switch picked. */
function timelineRows(analytics: ShareGlobalAnalytics): CsvRow[] {
  const section = t("share.dashboard.card_timeline")
  const metricLabels = metricOptions()
  return analytics.timeline.flatMap((point): CsvRow[] => [
    [section, `${point.label} · ${metricLabels.views}`, point.views],
    [section, `${point.label} · ${metricLabels.visitors}`, point.visitors],
  ])
}

function topNoteRows(analytics: ShareGlobalAnalytics): CsvRow[] {
  const section = t("share.dashboard.card_top_notes")
  const metricLabels = metricOptions()
  return analytics.topNotes.flatMap((note): CsvRow[] => {
    const title = note.noteTitle || t("common.untitled_note")
    return [
      [section, `${title} · ${metricLabels.views}`, note.views],
      [section, `${title} · ${metricLabels.visitors}`, note.visitors],
    ]
  })
}

/** A breakdown list: the name the card shows, with the share of the total the card prints beside it. */
function breakdownRows(
  section: string,
  items: readonly ShareBreakdownItem[],
  name: (item: ShareBreakdownItem) => string,
): CsvRow[] {
  return items.map((item) => [section, withPercentage(name(item), item.percentage), item.count])
}

function withPercentage(name: string, percentage: number | undefined): string {
  return percentage === undefined ? name : `${name} (${percentage}%)`
}

/** Devices and systems as the one card draws them, every row it was given, names localized the same way. */
function environmentRows(analytics: ShareGlobalAnalytics): CsvRow[] {
  const section = t("share.dashboard.card_devices")
  return [
    ...analytics.devices.map((item): CsvRow => [section, `${t("share.dashboard.device_type")} · ${localizeDeviceName(item.name)}`, item.count]),
    ...analytics.osList.map((item): CsvRow => [section, `${t("share.dashboard.operating_system")} · ${localizeEnvName(item.name)}`, item.count]),
  ]
}

/**
 * The hygiene report's own number, written only when the report is on. A threshold of 0 is the owner's
 * off switch, and a file that turned that into "0 quiet links" would report the absence of a report as
 * good news about the links.
 */
function staleLinkRows(analytics: ShareGlobalAnalytics): CsvRow[] {
  const { thresholdDays, total } = analytics.staleLinks
  if (thresholdDays === 0) return []
  return [[t("share.dashboard.card_stale"), t("share.dashboard.stale_threshold", { days: thresholdDays }), total]]
}

/**
 * The visit tail the activity card lists. The value is the timestamp alone, so it sorts and compares as
 * one, and everything else the row says about the visit rides in the item.
 */
function recentVisitRows(analytics: ShareGlobalAnalytics, locale: string): CsvRow[] {
  const section = t("share.dashboard.card_activity")
  return analytics.recentVisits.map((visit): CsvRow => {
    const parts = [
      visit.noteTitle || t("common.untitled_note"),
      [countryNameLocalized(visit.country, locale), visit.city].filter(Boolean).join(" · "),
      `${localizeEnvName(visit.browser)} / ${localizeEnvName(visit.os)}`,
      visit.referrerHost ?? "",
      ...visitFlags(visit),
    ]
    return [section, parts.filter((part) => part !== "").join(" | "), new Date(visit.visitedAt).toISOString()]
  })
}

function visitFlags(visit: ShareGlobalAnalytics["recentVisits"][number]): string[] {
  return [
    visit.isBot ? visit.botName || t("share.dashboard.badge_bot") : "",
    visit.isOwner === true ? t("share.dashboard.badge_owner") : "",
    visit.isSelfReferrer === true ? t("share.dashboard.badge_self") : "",
  ]
}

/** The two names the trend card's switch offers, resolved where they are needed rather than at import. */
function metricOptions(): { views: string; visitors: string } {
  return { views: t("share.dashboard.metric_pv"), visitors: t("share.dashboard.metric_uv") }
}
