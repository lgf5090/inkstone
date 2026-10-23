import { MoonStar } from "lucide-react"
import type { ShareStaleLink, ShareStaleLinks } from "@shared/share-hub"
import { Button } from "../../../components/primitives"
import { t } from "../../../lib/i18n"
import { CardEmpty, DashboardCard } from "./card-shell"
import { daysSinceVisit } from "./dashboard-format"

/**
 * The links nobody reads any more, and the one action that answers them.
 *
 * It reads the same response as the rest of the dashboard, so it costs no extra request, and the
 * threshold it reports is the account's own number — stated in the badge, because "quiet" only means
 * something next to the days it counts. A threshold of 0 is the owner's off switch: the server sends
 * nothing to report, so there is nothing to draw.
 */
export function StaleLinksCard({ staleLinks, isBusy, onPause }: {
  staleLinks: ShareStaleLinks | undefined
  isBusy: boolean
  onPause: () => void
}) {
  const thresholdDays = staleLinks?.thresholdDays ?? 0
  if (!staleLinks || thresholdDays === 0) return null
  const total = staleLinks.total
  return (
    <DashboardCard
      icon={<MoonStar size={15} className="text-[var(--accent)]" />}
      title={t("share.dashboard.card_stale")}
      badge={t("share.dashboard.stale_threshold", { days: thresholdDays })}
    >
      {total === 0 ? (
        <CardEmpty label={t("share.dashboard.stale_empty", { days: thresholdDays })} />
      ) : (
        <>
          <p className="pt-[var(--sp-2)] text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t("share.dashboard.stale_summary", { count: total, never: staleLinks.neverViewed })}
          </p>
          <ul className="divide-y divide-[var(--border-subtle)] pt-[var(--sp-1)]">
            {staleLinks.items.map((item) => (
              <StaleLinkRow key={item.noteId} item={item} />
            ))}
          </ul>
          {/* The list is what gets paused, and it is a page of the total: saying "these" keeps the
              button from standing in for links that are not on screen. */}
          <div className="flex flex-wrap items-center justify-between gap-[var(--sp-3)] border-t border-[var(--border-subtle)] pt-[var(--sp-3)]">
            <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {t("share.dashboard.stale_pause_scope", { count: staleLinks.items.length })}
            </span>
            <Button size="sm" variant="secondary" disabled={isBusy} onClick={onPause}>
              {t("share.dashboard.stale_pause_action")}
            </Button>
          </div>
        </>
      )}
    </DashboardCard>
  )
}

function StaleLinkRow({ item }: { item: ShareStaleLink }) {
  const days = daysSinceVisit(item.lastViewedAt)
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-[var(--sp-2)] py-[var(--sp-2)] text-[length:var(--text-12)]">
      <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">
        {item.noteTitle || t("common.untitled_note")}
      </span>
      <span className="flex shrink-0 items-center gap-[var(--sp-3)] text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        <span className="font-mono">{`/s/${item.slug}`}</span>
        <span>{days === null ? t("share.dashboard.stale_never_viewed") : t("share.dashboard.stale_last_viewed", { days })}</span>
      </span>
    </li>
  )
}
