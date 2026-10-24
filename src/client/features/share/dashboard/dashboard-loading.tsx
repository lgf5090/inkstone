import { Skeleton } from "../../../components/feedback"
import { t } from "../../../lib/i18n"
import { TIMELINE_CHART_HEIGHT } from "./constants"

/** The placeholders the loading state draws, by the shape of what they stand in for. */
const KPI_PLACEHOLDERS = ["pv", "uv", "shares", "per-day"]
const PANEL_PLACEHOLDERS = ["top-notes", "countries", "referrers", "devices"]

/**
 * First load of the dashboard.
 *
 * Zero-filled cards would be a claim about the data ("no visits in this window") rather than a state of
 * the request, so the KPI row, the trend and the breakdown cards all stand in as shimmer placeholders
 * until the first answer arrives. A later range switch keeps the cards already on screen — only a
 * window nobody has ever read is drawn as an empty one.
 */
export function DashboardLoading() {
  return (
    <div className="flex h-full flex-col">
      <p role="status" aria-busy="true" className="pb-[var(--sp-3)] text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        {t("common.loading")}
      </p>

      <div className="grid grid-cols-1 gap-[var(--sp-3)] sm:grid-cols-2 lg:grid-cols-4">
        {KPI_PLACEHOLDERS.map((key) => (
          <Skeleton key={key} className="h-[var(--sp-16)] rounded-[var(--r-lg)] border border-[var(--border-subtle)]" />
        ))}
      </div>

      <Skeleton className={`mt-[var(--sp-4)] w-full rounded-[var(--r-lg)] border border-[var(--border-subtle)] ${TIMELINE_CHART_HEIGHT}`} />

      <div className="mt-[var(--sp-4)] grid grid-cols-1 gap-[var(--sp-4)] lg:grid-cols-2">
        {PANEL_PLACEHOLDERS.map((key) => (
          <Skeleton key={key} className="h-[var(--sp-16)] rounded-[var(--r-lg)] border border-[var(--border-subtle)]" />
        ))}
      </div>
    </div>
  )
}
