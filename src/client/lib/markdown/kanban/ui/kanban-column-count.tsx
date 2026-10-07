/**
 * F-09. The count of cards in a column is read in three places — the board header, the collapsed
 * strip and the grouped table — and a work-in-progress limit is only a rule if all three answer from
 * the same number, so the pill is drawn here once instead of pasted a third time. Being over the
 * limit is said in words and marked with an icon rather than painted red: `--danger` as text at this
 * size measures under AA on the inset surfaces, so the red stays on the graphic and the words carry
 * the state (WCAG 1.4.1), same as the overdue date badge does.
 */
import { AlertTriangle } from 'lucide-react'
import { t } from '../../../i18n'
import { kanbanWipOver } from '../filter-sort'

interface KanbanColumnCountProps {
  count: number
  /** The rule the reader set for this column; `undefined` means there is none to show. */
  limit?: number
  /** Shape classes of the surface drawing it (radius, padding, size), never a text colour. */
  className?: string
}

export function KanbanColumnCount({ count, limit, className }: KanbanColumnCountProps) {
  const over = kanbanWipOver(count, limit)
  const isOver = over > 0
  const words = isOver ? t('preview.kanban_wip_over', { count, limit: limit ?? 0, over }) : undefined
  return (
    <span
      data-kanban-count=''
      data-kanban-wip-limit={limit}
      data-kanban-wip={isOver ? 'over' : undefined}
      title={words}
      className={`inline-flex items-center gap-[var(--sp-1)] ${isOver ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'} ${className ?? ''}`}
    >
      {isOver ? <AlertTriangle size={11} className='shrink-0 text-[var(--danger)]' aria-hidden='true' /> : null}
      <span>{limit === undefined ? count : t('preview.kanban_wip_count', { count, limit })}</span>
      {words ? <span className='sr-only'>{words}</span> : null}
    </span>
  )
}
