import { BellOff, TriangleAlert } from "lucide-react"
import type { ShareExpiredLinks } from "@shared/share-hub"
import { Button } from "../../../components/primitives"
import { fullTime } from "../../../lib/time"
import { t } from "../../../lib/i18n"

/**
 * The expiry notice: the dashboard answers "something lapsed since you last looked" before the KPIs
 * answer anything else, because a link that stopped serving readers is the one finding a reader cannot
 * recover by scrolling.
 *
 * Dismissing stamps one timestamp on the account — the notice only ever returns what lapsed after it —
 * and "see the expired links" hands over to the category where they already have their own shelf.
 */
export function ExpiredNotice({ expiredLinks, onAcknowledge, onViewExpired }: {
  expiredLinks: ShareExpiredLinks
  onAcknowledge: () => void
  /** The hub's category switch; absent until the shell offers one, and the row simply omits it then. */
  onViewExpired?: () => void
}) {
  const remaining = expiredLinks.total - expiredLinks.items.length
  return (
    <section
      role="status"
      aria-label={t("share.dashboard.expired_title", { count: expiredLinks.total })}
      className="rounded-[var(--r-lg)] border border-[var(--warning)] bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] p-[var(--sp-4)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)]">
        <p className="flex items-center gap-[var(--sp-1-5)] text-[length:var(--text-12)] font-semibold text-[var(--warning)]">
          <TriangleAlert size={14} aria-hidden />
          {t("share.dashboard.expired_title", { count: expiredLinks.total })}
        </p>
        <Button size="sm" variant="ghost" icon={<BellOff size={12} />} onClick={onAcknowledge}>
          {t("share.dashboard.expired_dismiss")}
        </Button>
      </div>

      <ul className="space-y-[var(--sp-1)] pt-[var(--sp-2)]">
        {expiredLinks.items.map((item) => (
          <li key={item.slug} className="flex flex-wrap items-baseline justify-between gap-x-[var(--sp-3)] text-[length:var(--text-11)] text-[var(--text-secondary)]">
            <span className="min-w-0 truncate">
              {item.noteTitle || t("common.untitled_note")}
              <span className="ml-[var(--sp-2)] font-mono text-[var(--text-quaternary)]">{`/s/${item.slug}`}</span>
            </span>
            <span className="shrink-0">{t("share.dashboard.expired_lapsed_at", { time: fullTime(item.expiresAt) })}</span>
          </li>
        ))}
      </ul>

      {remaining > 0 && (
        <p className="pt-[var(--sp-1)] text-[length:var(--text-10)] text-[var(--text-tertiary)]">
          {t("share.dashboard.expired_more", { count: remaining })}
        </p>
      )}

      {onViewExpired && (
        <div className="pt-[var(--sp-2)]">
          <Button size="sm" variant="secondary" onClick={onViewExpired}>
            {t("share.dashboard.expired_view_category")}
          </Button>
        </div>
      )}
    </section>
  )
}
