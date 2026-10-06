import { useMemo, useState } from 'react'
import { AlarmClock, X } from 'lucide-react'
import { t } from '../../../i18n'
import { dateKey } from '../../../time'
import { kanbanDueNotice } from '../date-fields'
import type { KanbanFilter, KanbanItem, KanbanProperty } from '../types'

/**
 * The board's own answer to "what is owed", under the toolbar: one quiet line that counts the
 * still-open cards past their day and the ones due today, on the view's own date column. Each count
 * is a button that writes the matching filter onto the view — the notice is a door into the board's
 * existing filter machinery, not a second filter implementation — and the line goes away for the
 * board's life once the reader dismisses it.
 */
export function KanbanDueNotice({
  items,
  columns,
  dateField,
  onApplyFilters,
}: {
  items: KanbanItem[]
  columns: KanbanProperty[]
  dateField?: string
  onApplyFilters: (filters: KanbanFilter[]) => void
}) {
  const [dismissed, setDismissed] = useState(false)
  const notice = useMemo(() => kanbanDueNotice(items, columns, dateField), [items, columns, dateField])
  if (dismissed || !notice) return null
  if (notice.overdue.length === 0 && notice.dueToday.length === 0) return null
  return (
    <div
      role='status'
      data-kanban-due-notice
      className='flex items-center gap-[var(--sp-2)] px-[var(--sp-4)] pt-[var(--sp-2)] text-[length:var(--text-12)] text-[var(--text-secondary)]'
    >
      <AlarmClock size={14} aria-hidden />
      {notice.overdue.length > 0 && (
        <button
          type='button'
          onClick={() => onApplyFilters([{ propertyId: notice.propertyId, operator: 'is_overdue' }])}
          className='rounded-[var(--r-sm)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] font-medium text-[var(--danger)] transition-colors hover:bg-[var(--bg-hover)]'
        >
          {t('preview.kanban_due_overdue', { count: notice.overdue.length })}
        </button>
      )}
      {notice.dueToday.length > 0 && (
        <button
          type='button'
          onClick={() => onApplyFilters([{ propertyId: notice.propertyId, operator: 'equals', value: dateKey(new Date()) }])}
          className='rounded-[var(--r-sm)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]'
        >
          {t('preview.kanban_due_today', { count: notice.dueToday.length })}
        </button>
      )}
      <button
        type='button'
        aria-label={t('preview.kanban_due_dismiss')}
        onClick={() => setDismissed(true)}
        className='ml-auto rounded-[var(--r-sm)] p-[var(--sp-1)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  )
}
