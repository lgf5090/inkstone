/**
 * The card date is printed by the board, the list and the gallery. Each of them used to paste its
 * own copy of that chip, which is how one card could read differently depending on where it was
 * looked at; the badge is drawn here once instead. A missed deadline is said in words and marked
 * with its own icon, because colour alone may not carry state (WCAG 1.4.1), and the day it refers
 * to stays reachable in the title.
 */
import { AlertTriangle, Calendar } from 'lucide-react'
import { t } from '../../../i18n'
import { readKanbanCardDate } from '../date-fields'
import type { KanbanItem } from '../types'

interface KanbanDateBadgeProps {
  item: KanbanItem
  /** `chip` sits on the board and the gallery, `plain` on a list row, which carries no inset box. */
  variant?: 'chip' | 'plain'
  /** Layout extras the surrounding row needs (a responsive hiding class), never a colour. */
  className?: string
}

export function KanbanDateBadge({ item, variant = 'chip', className }: KanbanDateBadgeProps) {
  const date = readKanbanCardDate(item)
  if (!date) return null
  const overdue = date.overdueDays > 0
  const box = variant === 'chip'
    ? 'rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] text-[length:var(--text-11)]'
    : ''
  // `--danger` as text on the chip's inset measures 3.38 in the light theme, under AA at this size,
  // so the red stays on the icon, where a graphic only needs 3, and the words carry the state.
  const tone = overdue ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
  return (
    <span
      data-kanban-date=''
      data-kanban-overdue={overdue ? '' : undefined}
      title={overdue ? date.dateText : undefined}
      className={`inline-flex items-center gap-[var(--sp-1)] ${box} ${tone} ${className ?? ''}`}
    >
      {overdue
        ? <AlertTriangle size={11} className='text-[var(--danger)]' />
        : <Calendar size={11} className='text-[var(--text-tertiary)]' />}
      <span>{overdue ? t('preview.kanban_overdue_days', { count: date.overdueDays }) : date.dateText}</span>
    </span>
  )
}
