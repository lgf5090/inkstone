import { CHANNEL_UNMARKED, CHANNEL_UNRECOGNIZED } from "@shared/share-channel"
import type { ShareTimelineRange } from "@shared/share-hub"
import type { VisitTrafficFilters } from "@shared/share-selection"
import { t } from "../../../lib/i18n"
import { isAllTrafficFilters, isRealVisitorFilters } from "./constants"

/**
 * The words and the cells the dashboard draws.
 *
 * Every label the cards print is resolved here, inside a function rather than at module scope, so the
 * language the reader is actually reading in is the one that comes out; and the export calls the same
 * functions, which is what keeps a file that leaves the app from naming a row differently from the
 * card that drew it.
 */

/** The four windows the range control offers, in the order a reader scans them. */
export function rangeOptions(): Array<{ value: ShareTimelineRange; label: string }> {
  return [
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "all", label: t("share.dashboard.range_all") },
  ]
}

/** How a range reads in a sentence or a file name; the literal otherwise. */
export function rangeLabel(range: ShareTimelineRange): string {
  return range === "all" ? t("share.dashboard.range_all") : range
}

/** A country as the flag glyph its code maps to, with a neutral mark for an unreadable code. */
export function countryFlag(countryCode: string | null | undefined): string {
  if (!countryCode || countryCode === "UNKNOWN" || countryCode.length !== 2) return "🌐"
  return countryCode.toUpperCase().replace(/./g, (character) => String.fromCodePoint(127397 + character.charCodeAt(0)))
}

const displayNamesByLocale = new Map<string, Intl.DisplayNames>()

function regionNames(locale: string): Intl.DisplayNames {
  const cached = displayNamesByLocale.get(locale)
  if (cached) return cached
  const names = new Intl.DisplayNames([locale], { type: "region" })
  displayNamesByLocale.set(locale, names)
  return names
}

/**
 * A country code in the language the reader is reading in. `of()` throws on a code it does not know,
 * and the code itself is a better answer than a crash or a blank — it is still what the row is about.
 */
export function countryNameLocalized(countryCode: string | null | undefined, locale: string): string {
  if (!countryCode || countryCode === "UNKNOWN") return t("share.dashboard.country_unknown")
  try {
    return regionNames(locale).of(countryCode.toUpperCase()) || countryCode
  } catch {
    return countryCode
  }
}

/** The three device classes the breakdown names in words; anything else is already a name. */
export function localizeDeviceName(name: string): string {
  if (name === "desktop") return t("share.dashboard.device_desktop")
  if (name === "mobile") return t("share.dashboard.device_mobile")
  if (name === "tablet") return t("share.dashboard.device_tablet")
  return name
}

/** The referrer table's `Direct` is the server's sentinel for "no referrer", not a host name. */
export function localizeReferrerName(name: string): string {
  return name === "Direct" ? t("share.dashboard.direct_access") : name
}

/**
 * A browser or OS name is a proper noun the UA parser read off the header, with one exception: its own
 * `Other` means it could not read one, and that is a value rather than a name.
 */
export function localizeEnvName(name: string | null | undefined): string {
  const value = name?.trim()
  return !value || value.toLowerCase() === "other" ? t("share.dashboard.env_unknown") : value
}

/**
 * The channel split's names. The two reserved ones become copy; anything else is a token the owner
 * wrote, rendered as text by React and never through a markup API. `label` is the collection title the
 * worker could resolve — user data, so it rides into the sentence rather than replacing it.
 */
export function localizeChannelName(name: string, label?: string): string {
  if (label) return t("share.dashboard.channel_collection", { title: label })
  if (name === CHANNEL_UNMARKED) return t("share.dashboard.channel_none")
  if (name === CHANNEL_UNRECOGNIZED) return t("share.dashboard.channel_unrecognized")
  return name
}

/** How the three flags read as one sentence, shared by the panel's badge and the exported file. */
export function trafficFilterLabel(filters: VisitTrafficFilters): string {
  if (isRealVisitorFilters(filters)) return t("share.dashboard.filter_real_visitors")
  if (isAllTrafficFilters(filters)) return t("share.dashboard.filter_all_traffic")
  return t("share.dashboard.filter_custom_traffic")
}

/**
 * The four headline figures, named in one place. A tile and an exported row that each call `t()` with
 * their own key are two strings that can drift into near-duplicates — a "total views (PV)" beside an
 * "all-time cumulative views (PV)" is that drift, and a translator cannot tell which one the card on
 * screen is actually showing.
 */
export function kpiLabels(): Record<"pv" | "uv" | "activeShares" | "viewsPerDay", string> {
  return {
    pv: t("share.dashboard.kpi_total_views"),
    uv: t("share.dashboard.kpi_unique_visitors"),
    activeShares: t("share.dashboard.kpi_active_shares"),
    viewsPerDay: t("share.dashboard.kpi_views_per_day"),
  }
}

/** What every delta on the screen is measured against, stated rather than implied by an arrow. */
export function deltaHintLabel(): string {
  return t("share.dashboard.delta_vs_previous")
}

/** Whole days since a visit, or null for a link nobody has ever opened. */
export function daysSinceVisit(lastViewedAt: number | null, now = Date.now()): number | null {
  if (lastViewedAt === null) return null
  return Math.max(0, Math.floor((now - lastViewedAt) / 86_400_000))
}

/** One CSV cell, quoted per RFC 4180 whenever it holds a comma, a quote or a line break. */
function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** A CSV document from rows of equal width; no trailing blank line, which spreadsheets read as data. */
export function toCsvDocument(rows: readonly (readonly (string | number)[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n")
}
