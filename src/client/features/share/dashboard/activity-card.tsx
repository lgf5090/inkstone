import { Activity, ChevronRight } from "lucide-react"
import type { ShareVisitLog } from "@shared/share-hub"
import { Badge, IconButton } from "../../../components/primitives"
import { relativeTime } from "../../../lib/time"
import { localeTag, t } from "../../../lib/i18n"
import { CardEmpty, DashboardCard } from "./card-shell"
import { countryFlag, countryNameLocalized, localizeEnvName } from "./dashboard-format"

/**
 * The newest visits the window holds, with a way into each note's own log.
 *
 * The flags beside a row are the reason that row may not be a plain reader: a crawler, the owner's own
 * device, a click that came from inside the notebook. They are `Badge`s, so they carry a name and a
 * tone from one place rather than a colour of their own.
 */
export function ActivityCard({ visits, onOpenVisitLog }: {
  visits: ShareVisitLog[]
  onOpenVisitLog?: (noteId: string) => void
}) {
  const locale = localeTag()
  return (
    <DashboardCard
      icon={<Activity size={15} className="text-[var(--accent)]" />}
      title={t("share.dashboard.card_activity")}
      badge={t("share.dashboard.activity_badge")}
    >
      {visits.length === 0 ? (
        <CardEmpty label={t("share.dashboard.no_visits_yet")} />
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)] pt-[var(--sp-1)]">
          {visits.map((visit) => (
            <ActivityRow key={visit.id} visit={visit} locale={locale} onOpenVisitLog={onOpenVisitLog} />
          ))}
        </ul>
      )}
    </DashboardCard>
  )
}

function ActivityRow({ visit, locale, onOpenVisitLog }: {
  visit: ShareVisitLog
  locale: string
  onOpenVisitLog?: (noteId: string) => void
}) {
  const place = [countryNameLocalized(visit.country, locale), visit.city].filter(Boolean).join(" · ")
  return (
    <li className="flex items-center gap-[var(--sp-2)] py-[var(--sp-2)] text-[length:var(--text-12)]">
      <span aria-hidden="true" className="shrink-0">{countryFlag(visit.country)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-[var(--sp-2)]">
          <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">
            {visit.noteTitle || t("common.untitled_note")}
          </span>
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{place}</span>
          <VisitFlags visit={visit} />
        </div>
        <p className="pt-[var(--sp-0-5)] text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {`${localizeEnvName(visit.browser)} / ${localizeEnvName(visit.os)}`}
          {visit.referrerHost ? ` · ${visit.referrerHost}` : ""}
        </p>
      </div>
      <span className="shrink-0 font-mono text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        {relativeTime(visit.visitedAt)}
      </span>
      {onOpenVisitLog && (
        <IconButton
          size="sm"
          label={t("share.dashboard.open_note_log", { title: visit.noteTitle || t("common.untitled_note") })}
          onClick={() => onOpenVisitLog(visit.noteId)}
        >
          <ChevronRight size={14} />
        </IconButton>
      )}
    </li>
  )
}

function VisitFlags({ visit }: { visit: ShareVisitLog }) {
  return (
    <>
      {visit.isBot && <Badge tone="neutral">{visit.botName || t("share.dashboard.badge_bot")}</Badge>}
      {visit.isOwner === true && <Badge tone="accent">{t("share.dashboard.badge_owner")}</Badge>}
      {visit.isSelfReferrer === true && <Badge tone="warning">{t("share.dashboard.badge_self")}</Badge>}
    </>
  )
}
