import { Activity, Globe, MousePointerClick, Users } from "lucide-react"
import type { ShareGlobalAnalytics } from "@shared/share-hub"
import { t } from "../../../lib/i18n"
import { deltaHintLabel, kpiLabels } from "./dashboard-format"
import { KpiTile } from "./card-shell"

/**
 * The four headline numbers, above every card.
 *
 * They are the four figures the response carries for the window on screen and nothing else: a fifth
 * tile would be a place for a number whose meaning changes whenever the range does.
 */
export function KpiGrid({ analytics, hasVisits }: {
  analytics: ShareGlobalAnalytics | null
  hasVisits: boolean
}) {
  const labels = kpiLabels()
  const hint = deltaHintLabel()
  return (
    <div className="grid grid-cols-1 gap-[var(--sp-3)] sm:grid-cols-2 lg:grid-cols-4">
      <KpiTile
        tone="accent"
        icon={<MousePointerClick size={16} />}
        label={labels.pv}
        value={analytics?.totalViews ?? 0}
        delta={analytics?.viewsDelta}
        deltaHint={hint}
      />

      {/* This instance always holds a visitor key, so a `0` here is a reading rather than a missing
          instrument. An empty window is still a different fact from zero visitors, and it is drawn as a
          dash beside the sentence that says which one it is. */}
      <KpiTile
        tone="success"
        icon={<Users size={16} />}
        label={labels.uv}
        value={hasVisits ? (analytics?.totalVisitors ?? 0) : "—"}
        delta={analytics?.visitorsDelta}
        deltaHint={hint}
        footnote={hasVisits ? undefined : t("share.dashboard.no_visits_in_range")}
      />

      <KpiTile
        tone="accent"
        icon={<Globe size={16} />}
        label={labels.activeShares}
        value={`${analytics?.activeShares ?? 0} / ${analytics?.totalShares ?? 0} ${t("share.dashboard.shares_unit")}`}
        footnote={t("share.dashboard.active_shares_hint")}
      />

      <KpiTile
        tone="warning"
        icon={<Activity size={16} />}
        label={labels.viewsPerDay}
        value={analytics?.viewsPerDay ?? 0}
        delta={analytics?.viewsPerDayDelta}
        deltaHint={hint}
      />
    </div>
  )
}
