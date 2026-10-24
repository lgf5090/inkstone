import { useCallback, useEffect, useRef, useState } from "react"
import type { ShareGlobalAnalytics, ShareTimelineRange } from "@shared/share-hub"
import type { VisitTrafficFilters } from "@shared/share-selection"
import { confirm } from "../../../components/overlay"
import { downloadTextFile } from "../../../lib/export-note"
import { localeTag, t } from "../../../lib/i18n"
import { shareHubApi, type TrafficParams } from "../../../lib/api-share-hub"
import { useUi } from "../../../store/ui"
import {
  ALL_TRAFFIC_FILTERS,
  DEFAULT_TIMELINE_METRIC,
  DEFAULT_TIMELINE_RANGE,
  REAL_VISITOR_FILTERS,
  type TimelineMetric,
} from "./constants"
import { buildDashboardCsv, dashboardCsvFilename } from "./dashboard-export"
import {
  readAutoRefreshEnabled,
  readTrafficFilters,
  writeAutoRefreshEnabled,
  writeTrafficFilters,
} from "./preferences"
import { useAutoRefresh } from "./use-auto-refresh"

/**
 * The dashboard's data layer: one window's worth of readings, the request that answers it, the age of
 * what came back, and the optional cadence that re-asks.
 *
 * The dashboard answers one question per window, so nothing about *how* it is drawn belongs here — the
 * cards own their own rendering, and the shell only picks which of the three states is on screen.
 */

/**
 * The client's flag names onto the query the hub's routes accept. The shared contract calls the third
 * filter `excludeSelfReferrers` (that is what the server's SQL reads); the query string has always
 * spelled it `excludeSelf`. This is the one place the two spellings meet.
 */
export function trafficParams(filters: VisitTrafficFilters): TrafficParams {
  return {
    excludeBots: filters.excludeBots,
    excludeSelf: filters.excludeSelfReferrers,
    excludeOwner: filters.excludeOwner,
  }
}

export function useDashboardView() {
  const [range, setRange] = useState<ShareTimelineRange>(DEFAULT_TIMELINE_RANGE)
  const [metric, setMetric] = useState<TimelineMetric>(DEFAULT_TIMELINE_METRIC)
  const [filters, setFilters] = useState<VisitTrafficFilters>(readTrafficFilters)
  const [analytics, setAnalytics] = useState<ShareGlobalAnalytics | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [autoRefresh, setAutoRefreshState] = useState(readAutoRefreshEnabled)
  const [isStaleBusy, setIsStaleBusy] = useState(false)
  const toast = useUi((s) => s.toast)

  // Only one request per window may land: a switch that fires a second read while the first is still
  // running would let the older answer overwrite the newer one. `inFlightRef` is the synchronous answer
  // to "is anything on the wire right now", which is what the auto-refresh tick asks before it speaks.
  const controllerRef = useRef<AbortController | null>(null)
  const inFlightRef = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    inFlightRef.current = true
    setIsLoading(true)
    setFailed(false)
    try {
      const data = await shareHubApi.analytics.global({ range, ...trafficParams(filters), signal: controller.signal })
      if (controller.signal.aborted) return
      // The age is stamped with the data: the line describes the numbers on screen, so it can only
      // move when they do.
      setAnalytics(data)
      setLoadedAt(Date.now())
    } catch (error) {
      if (controller.signal.aborted) return
      console.warn("[share] dashboard analytics request failed", error)
      setFailed(true)
    } finally {
      if (controllerRef.current === controller) {
        inFlightRef.current = false
        setIsLoading(false)
      }
    }
  }, [range, filters])

  useEffect(() => {
    void load()
    return () => controllerRef.current?.abort()
  }, [load])

  useAutoRefresh({
    enabled: autoRefresh,
    refresh: () => void load(),
    isBusy: () => inFlightRef.current,
  })

  const updateFilters = (patch: Partial<VisitTrafficFilters>): void => {
    const next = { ...filters, ...patch }
    setFilters(next)
    writeTrafficFilters(next)
  }

  /** The master switch: the preset triple, or nothing hidden at all. */
  const setRealVisitors = (enabled: boolean): void => updateFilters(enabled ? REAL_VISITOR_FILTERS : ALL_TRAFFIC_FILTERS)

  const setAutoRefresh = (next: boolean): void => {
    setAutoRefreshState(next)
    writeAutoRefreshEnabled(next)
  }

  /**
   * The dismissal is one stamp on the account: the notice only returns what lapsed after it, so
   * acknowledging and re-reading is the whole lifecycle. A failed stamp keeps the notice up — dismissing
   * twice is harmless, losing the notice is not.
   */
  const acknowledgeExpired = async (): Promise<void> => {
    try {
      await shareHubApi.analytics.ackExpired()
      await load()
    } catch (error) {
      console.warn("[share] dismissing the expired notice failed", error)
      toast({ title: t("share.dashboard.expired_ack_failed"), tone: "danger" })
    }
  }

  /**
   * The quiet links are paused as a batch, and the batch is the page the card lists — a button that
   * described "these" has to act on "these". The confirm dialog is the app's own, so the click is
   * reversible up to the moment it is committed and nowhere after.
   */
  const pauseStaleLinks = async (): Promise<void> => {
    const items = analytics?.staleLinks.items ?? []
    if (items.length === 0) return
    const noteIds = items.map((item) => item.noteId)
    const confirmed = await confirm({
      title: t("share.dashboard.stale_pause_confirm_title", { count: noteIds.length }),
      description: t("share.dashboard.stale_pause_confirm_body"),
      confirmLabel: t("share.dashboard.stale_pause_action"),
      tone: "danger",
    })
    if (!confirmed) return
    setIsStaleBusy(true)
    try {
      await shareHubApi.batch.setEnabled(noteIds, false)
      toast({ title: t("share.dashboard.stale_paused", { count: noteIds.length }), tone: "success" })
      await load()
    } catch (error) {
      console.warn("[share] pausing the quiet links failed", error)
      toast({ title: t("common.action_failed"), tone: "danger" })
    } finally {
      setIsStaleBusy(false)
    }
  }

  /** The numbers can leave the app with the window they describe; an empty hand says so out loud. */
  const exportCsv = (): void => {
    if (!analytics) {
      toast({ title: t("share.dashboard.export_empty"), tone: "warning" })
      return
    }
    const generatedAt = Date.now()
    const csv = buildDashboardCsv({ analytics, range, filters, locale: localeTag(), generatedAt })
    downloadTextFile(dashboardCsvFilename(range, generatedAt), csv, "text/csv;charset=utf-8")
    toast({ title: t("share.dashboard.export_success"), tone: "success" })
  }

  const timelinePoints = analytics?.timeline ?? []
  const filteredBots = filters.excludeBots ? (analytics?.filterStats?.bots ?? 0) : 0
  const filteredSelf = filters.excludeSelfReferrers ? (analytics?.filterStats?.selfReferrals ?? 0) : 0
  const filteredOwner = filters.excludeOwner ? (analytics?.filterStats?.owner ?? 0) : 0

  return {
    range,
    setRange,
    metric,
    setMetric,
    filters,
    updateFilters,
    setRealVisitors,
    analytics,
    isLoading,
    failed,
    loadedAt,
    load,
    autoRefresh,
    setAutoRefresh,
    exportCsv,
    acknowledgeExpired,
    pauseStaleLinks,
    isStaleBusy,
    timelinePoints,
    filteredBots,
    filteredSelf,
    filteredOwner,
    totalFilteredCount: filteredBots + filteredSelf + filteredOwner,
    /**
     * Whether the window holds any visit at all. A zero in a table is a reading; an empty window is not,
     * and a tile that prints `0` for it answers a question nobody asked.
     */
    hasVisits: (analytics?.totalViews ?? 0) > 0,
  }
}

export type DashboardView = ReturnType<typeof useDashboardView>
