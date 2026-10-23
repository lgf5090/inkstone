import { BarChart3, ChevronRight } from "lucide-react"
import type { ShareGlobalAnalytics } from "@shared/share-hub"
import { IconButton } from "../../../components/primitives"
import { formatNumber } from "../../../lib/time"
import { t } from "../../../lib/i18n"
import { CardEmpty, DashboardCard } from "./card-shell"

/** The notes the window's traffic landed on, and a way into each note's own visit log. */
type TopNote = ShareGlobalAnalytics["topNotes"][number]

export function TopNotesCard({ notes, onOpenVisitLog }: {
  notes: TopNote[]
  onOpenVisitLog?: (noteId: string) => void
}) {
  const busiest = notes[0]?.views ?? 1
  return (
    <DashboardCard
      icon={<BarChart3 size={15} className="text-[var(--accent)]" />}
      title={t("share.dashboard.card_top_notes")}
      badge={t("share.dashboard.top_notes_badge", { count: notes.length })}
    >
      {notes.length === 0 ? (
        <CardEmpty label={t("share.dashboard.no_data_yet")} />
      ) : (
        <ol className="divide-y divide-[var(--border-subtle)] pt-[var(--sp-1)]">
          {notes.map((note, index) => (
            <TopNoteRow key={note.noteId} note={note} rank={index + 1} share={shareOf(note.views, busiest)} onOpenVisitLog={onOpenVisitLog} />
          ))}
        </ol>
      )}
    </DashboardCard>
  )
}

/** A note's traffic as a share of the busiest note in the list, which is what the bar draws. */
function shareOf(views: number, busiest: number): number {
  return Math.round((views / Math.max(1, busiest)) * 100)
}

function TopNoteRow({ note, rank, share, onOpenVisitLog }: {
  note: TopNote
  rank: number
  share: number
  onOpenVisitLog?: (noteId: string) => void
}) {
  // The first three carry the rank in a filled badge; the rest read as text, so the ranking is colour
  // and shape rather than colour alone.
  const rankClass = rank <= 3
    ? "bg-[var(--accent)] text-[var(--accent-contrast)]"
    : "bg-[var(--bg-inset)] text-[var(--text-tertiary)]"
  return (
    <li className="flex items-center gap-[var(--sp-3)] py-[var(--sp-2)]">
      <span className={`flex size-[var(--sp-5)] shrink-0 items-center justify-center rounded-full text-[length:var(--text-10)] font-bold tabular ${rankClass}`}>
        {rank}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-[var(--sp-2)] text-[length:var(--text-12)]">
          <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">
            {note.noteTitle || t("common.untitled_note")}
          </span>
          <span className="shrink-0 font-mono font-semibold text-[var(--text-primary)] tabular">
            {formatNumber(note.views)}
            <span className="ml-[var(--sp-1)] text-[length:var(--text-10)] font-normal text-[var(--text-tertiary)]">
              {t("share.dashboard.metric_pv")}
            </span>
          </span>
        </div>
        <span aria-hidden="true" className="mt-[var(--sp-1)] block h-[var(--sp-1-5)] w-full overflow-hidden rounded-full bg-[var(--bg-inset)]">
          <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${share}%` }} />
        </span>
      </div>
      {onOpenVisitLog && (
        <IconButton
          size="sm"
          label={t("share.dashboard.open_note_log", { title: note.noteTitle || t("common.untitled_note") })}
          onClick={() => onOpenVisitLog(note.noteId)}
        >
          <ChevronRight size={14} />
        </IconButton>
      )}
    </li>
  )
}
