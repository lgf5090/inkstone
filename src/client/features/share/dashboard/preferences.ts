import { AUTO_REFRESH_STORAGE_KEY, REAL_VISITOR_FILTERS, TRAFFIC_FILTERS_STORAGE_KEY } from "./constants"
import type { VisitTrafficFilters } from "@shared/share-selection"

/**
 * The dashboard's two local preferences: which traffic it hides and whether it re-asks on a cadence.
 * Both belong to the device rather than to the account — two sessions on two machines can reasonably
 * want different windows — so they live in browser storage beside the other local UI choices.
 *
 * Storage can be unavailable (private mode, a full quota). A preference nobody could read is not worth
 * failing a screen over, so an unreadable value answers with the default and the reason is logged; the
 * dashboard still loads either way.
 */

function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch (error) {
    console.warn("[share] could not read a stored dashboard preference", key, error)
    return null
  }
}

function writeItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (error) {
    console.warn("[share] could not store a dashboard preference", key, error)
  }
}

export function readAutoRefreshEnabled(): boolean {
  return readItem(AUTO_REFRESH_STORAGE_KEY) === "1"
}

export function writeAutoRefreshEnabled(enabled: boolean): void {
  writeItem(AUTO_REFRESH_STORAGE_KEY, enabled ? "1" : "0")
}

/**
 * The stored triple, or the preset. `excludeBots` is the one flag on unless stored off, matching the
 * server's own default, so a value written by an older build still reads the same way on both sides.
 */
export function readTrafficFilters(): VisitTrafficFilters {
  const raw = readItem(TRAFFIC_FILTERS_STORAGE_KEY)
  if (!raw) return REAL_VISITOR_FILTERS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return REAL_VISITOR_FILTERS
    const stored = parsed as Record<string, unknown>
    return {
      excludeBots: stored.excludeBots !== false,
      excludeOwner: stored.excludeOwner === true,
      excludeSelfReferrers: stored.excludeSelfReferrers === true,
    }
  } catch (error) {
    console.warn("[share] the stored traffic filters are not readable, falling back to real visitors", error)
    return REAL_VISITOR_FILTERS
  }
}

export function writeTrafficFilters(filters: VisitTrafficFilters): void {
  writeItem(TRAFFIC_FILTERS_STORAGE_KEY, JSON.stringify(filters))
}
