import type { JSX } from "react"
import { t } from "../../../lib/i18n"
import { Button } from "../../../components/primitives"
import { Empty } from "../../../components/feedback"
import { ActivityCard } from "./activity-card"
import { BrowsersCard, CountriesCard, DevicesCard, ReferrersCard } from "./breakdown-cards"
import { DashboardHeader, FilterSummaryBanner } from "./dashboard-header"
import { DashboardLoading } from "./dashboard-loading"
import { ExpiredNotice } from "./expired-notice"
import { KpiGrid } from "./kpi-grid"
import { StaleLinksCard } from "./stale-links-card"
import { TimelineCard } from "./timeline-card"
import { TopNotesCard } from "./top-notes-card"
import { useDashboardView } from "./use-dashboard-view"

export interface ShareDashboardViewProps {
  /** Opens one note's own visit log — the drill-down every per-note row offers. */
  onOpenVisitLog: (noteId: string) => void
  /** The hub's switch to the expired category, which is where lapsed links keep their own shelf. */
  onViewExpiredCategory?: () => void
  /** The log filtered to one channel marker; without it the channel rows simply do not lead anywhere. */
  onOpenChannelLogs?: (channel: string) => void
}

/**
 * The share dashboard: one window's worth of analytics, drawn as the header's controls, the expiry
 * notice, the KPI row, the trend, the breakdown cards and the visit tail.
 *
 * This shell only decides which of the three states is on screen — a reading that failed, a window not
 * yet read, or the numbers themselves. Each card owns its own rendering, and every one of them draws
 * exactly the rows the response carries.
 */
export function ShareDashboardView({
  onOpenVisitLog,
  onViewExpiredCategory,
  onOpenChannelLogs,
}: ShareDashboardViewProps): JSX.Element {
  const view = useDashboardView()
  const { analytics, failed, isLoading, range, load } = view
  const expiredLinks = analytics?.expiredLinks

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[var(--bg-base)] p-[var(--sp-5)]">
      <DashboardHeader view={view} />

      {failed ? (
        <Empty
          art="select"
          title={t("share.dashboard.load_failed")}
          description={t("share.dashboard.load_failed_hint")}
          action={<Button size="sm" variant="secondary" onClick={() => void load()}>{t("common.retry")}</Button>}
        />
      ) : isLoading && !analytics ? (
        <DashboardLoading />
      ) : (
        <div className="flex flex-col gap-[var(--sp-4)]">
          {expiredLinks && expiredLinks.items.length > 0 && (
            <ExpiredNotice
              expiredLinks={expiredLinks}
              onAcknowledge={() => void view.acknowledgeExpired()}
              onViewExpired={onViewExpiredCategory}
            />
          )}

          {view.totalFilteredCount > 0 && (
            <FilterSummaryBanner bots={view.filteredBots} self={view.filteredSelf} owner={view.filteredOwner} />
          )}

          <KpiGrid analytics={analytics} hasVisits={view.hasVisits} />

          <TimelineCard points={view.timelinePoints} metric={view.metric} range={range} onMetricChange={view.setMetric} />

          <div className="grid grid-cols-1 gap-[var(--sp-4)] lg:grid-cols-2">
            <TopNotesCard notes={analytics?.topNotes ?? []} onOpenVisitLog={onOpenVisitLog} />
            <CountriesCard items={analytics?.topCountries ?? []} />
            <ReferrersCard items={analytics?.topReferrers ?? []} channels={analytics?.channels ?? []} onOpenChannelLogs={onOpenChannelLogs} />
            <DevicesCard devices={analytics?.devices ?? []} systems={analytics?.osList ?? []} />
            <BrowsersCard items={analytics?.browsers ?? []} />
          </div>

          <StaleLinksCard
            staleLinks={analytics?.staleLinks}
            isBusy={view.isStaleBusy}
            onPause={() => void view.pauseStaleLinks()}
          />

          <ActivityCard visits={analytics?.recentVisits ?? []} onOpenVisitLog={onOpenVisitLog} />
        </div>
      )}
    </div>
  )
}
