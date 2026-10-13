/**
 * Named places in the book.
 *
 * A location mark is not a highlight: it says "come back here", not "this sentence matters", so it is
 * stored as a position with a label rather than as a range of text, and it survives a reflow of the
 * edition unchanged.
 */
import { Trash2 } from 'lucide-react'
import { IconButton } from '../../../components/primitives'
import { Tooltip } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { useLibrary } from '../store/library'
import { formatPercent } from '../position'
import type { BookPosition } from '../position'

export interface MarksPanelProps {
  bookId: string
  onJump: (position: BookPosition) => void
  onRemove: (id: string) => void
}

export function MarksPanel({ bookId, onJump, onRemove }: MarksPanelProps) {
  const marks = useLibrary((state) => state.marks[bookId]) ?? []
  const progress = useLibrary((state) => state.progress[bookId])

  if (!marks.length) {
    return (
      <div className="px-3 py-6 text-center text-[12px] opacity-60">
        <p>{t('reading.no_marks')}</p>
        <p className="mt-1">{t('reading.no_marks_hint')}</p>
        {progress?.position ? (
          <p className="mt-2 text-[11px]">{t('reading.current_position_value0', { value0: formatPercent(progress.fraction) })}</p>
        ) : null}
      </div>
    )
  }

  return (
    <ul className="px-1 py-2">
      {marks.map((mark) => (
        <li key={mark.id} className="group/row flex items-center gap-1 rounded-[var(--r-sm)] px-1 hover:bg-[color-mix(in_oklab,currentColor_8%,transparent)]">
          <button
            type="button"
            className="min-w-0 flex-1 px-1 py-1.5 text-left"
            onClick={() => onJump(mark.position)}
          >
            <span className="block truncate text-[12.5px]">{mark.label}</span>
            <span className="block text-[10.5px] tabular opacity-55">
              {mark.position.kind === 'epub'
                ? t('reading.chapter_value0', { value0: mark.position.chapter + 1 })
                : t('reading.page_value0', { value0: mark.position.page })}
            </span>
          </button>
          <Tooltip label={t('reading.delete_mark')} side="left">
            <IconButton label={t('reading.delete_mark')} size="xs" onClick={() => onRemove(mark.id)} className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100">
              <Trash2 size={12} />
            </IconButton>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}
