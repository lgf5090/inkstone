import { Download, RefreshCw } from "lucide-react"
import type { ShareTimelineRange } from "@shared/share-hub"
import { Segmented, Switch } from "../../../components/form"
import { IconButton } from "../../../components/primitives"
import { t } from "../../../lib/i18n"
import { relativeTime } from "../../../lib/time"
import { rangeOptions } from "./dashboard-format"
import { TrafficFilterPopover } from "./traffic-filter-popover"
import type { DashboardView } from "./use-dashboard-view"

/**
 * The dashboard's title row: what the screen is, which window it reads, how old that window is, and the
 * four ways to change or renew it.
 */
export function DashboardHeader({ view }: { view: DashboardView }) {
  const { loadedAt, range, setRange, filters, updateFilters, setRealVisitors, isLoading, load, exportCsv, analytics, autoRefresh, setAutoRefresh } = view
  return (
    <div className="flex flex-wrap items-start justify-between gap-[var(--sp-3)] pb-[var(--sp-4)]">
      <div className="min-w-0">
        <h2 className="text-[length:var(--text-18)] font-bold text-[var(--text-primary)]">{t("share.dashboard.title")}</h2>
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t("share.dashboard.subtitle")}</p>
        {/* The dashboard reads every share the account has, whatever folder or tag the sidebar has
            selected: saying so is the difference between a wrong number and a stated scope. */}
        <p className="pt-[var(--sp-0-5)] text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t("share.dashboard.scope_hint")}</p>
        {/* The age of what is on screen, stated rather than implied: without it a person cannot tell a
            quiet week from a tab opened before lunch. */}
        {loadedAt !== null && (
          <p className="pt-[var(--sp-0-5)] text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t("share.dashboard.updated_at", { time: relativeTime(loadedAt) })}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
        <Segmented
          size="sm"
          label={t("share.dashboard.range_label")}
          value={range}
          onChange={(next) => setRange(next as ShareTimelineRange)}
          options={rangeOptions()}
        />

        <TrafficFilterPopover filters={filters} onFiltersChange={updateFilters} onRealVisitorsChange={setRealVisitors} />

        <IconButton
          size="sm"
          label={t("common.refresh")}
          disabled={isLoading}
          onClick={() => void load()}
        >
          <RefreshCw size={14} className={isLoading ? "animate-spin" : undefined} />
        </IconButton>

        {/* The numbers can leave the app with the window they describe; the handler itself says
            "nothing on screen yet" rather than handing over an empty file. */}
        <IconButton size="sm" label={t("share.dashboard.export_csv")} disabled={!analytics} onClick={exportCsv}>
          <Download size={14} />
        </IconButton>

        <span className="whitespace-nowrap text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t("share.dashboard.auto_refresh")}</span>
        <Switch checked={autoRefresh} onChange={setAutoRefresh} label={t("share.dashboard.auto_refresh")} />
      </div>
    </div>
  )
}

/**
 * What the traffic filters took out of the numbers below, drawn only when they took something. A
 * reading that hides rows has to say which rows, or the reader is comparing against a window they did
 * not choose.
 */
export function FilterSummaryBanner({ bots, self, owner }: { bots: number; self: number; owner: number }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-[var(--sp-2)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-11-5)] text-[var(--text-secondary)]"
    >
      <span className="flex items-center gap-[var(--sp-2)]">
        <span aria-hidden="true" className="size-[var(--sp-2)] shrink-0 rounded-full bg-[var(--success)]" />
        {t("share.dashboard.filter_summary", { bots, self, owner })}
      </span>
    </div>
  )
}
