import { useMemo } from 'react'
import { t, useLocaleRepaint } from '../../../i18n'
import { useSession } from '../../../../store/session'
import { dateKey } from '../../../time'
import { kanbanPersonName } from '../person'
import { isKanbanQuickFilterOn, kanbanQuickFilters, toggleKanbanQuickFilter } from '../quick-filters'
import type { KanbanFilter, KanbanProperty } from '../types'

/**
 * The board's four habitual questions, one press each.
 *
 * Every chip is the rule the filter panel would have taken several presses to build, and it is written
 * into the same `filters` list — so a chip that is pressed shows up as a row in the panel (and can be
 * edited there), and a rule built by hand lights the chip up. The chips are drawn only when the board's
 * own schema can answer them: a board with no date column is never late and has nothing due today, so
 * it is offered no chip rather than a chip that matches nothing.
 *
 * "Mine" is the account's own name matched against the person column, because that column stores the
 * name the author typed and carries no link to an account. An account whose name differs from the one
 * on the cards — or a board where the same person is spelled another way — will find fewer cards than
 * they expect; the alternative (a chip that cannot be built at all) is worse than a filter they can
 * see, read and delete.
 */
export function KanbanQuickFilterBar({
  columns,
  filters,
  onChangeFilters,
}: {
  columns: KanbanProperty[]
  filters: KanbanFilter[]
  onChangeFilters: (filters: KanbanFilter[]) => void
}) {
  useLocaleRepaint()
  const user = useSession((state) => state.user)
  const me = kanbanPersonName(user?.name) || kanbanPersonName(user?.username)
  // `today` is read at render rather than held: a board left open across midnight would otherwise
  // keep calling yesterday "today", and every commit re-reads it for free.
  const chips = useMemo(
    () => kanbanQuickFilters(columns, { today: dateKey(new Date()), me }),
    [columns, me],
  )
  if (chips.length === 0) return null

  return (
    <div data-kanban-quick-filters className='flex flex-wrap items-center gap-[var(--sp-1-5)]'>
      <span className='sr-only'>{t('preview.kanban_quick_filters')}</span>
      {chips.map((chip) => {
        const on = isKanbanQuickFilterOn(chip.filter, filters)
        return (
          <button
            key={chip.id}
            type='button'
            data-kanban-quick-filter={chip.id}
            data-active={on ? '' : undefined}
            aria-pressed={on}
            onClick={() => onChangeFilters(toggleKanbanQuickFilter(chip.filter, filters))}
            className={`rounded-full border px-[var(--sp-2)] py-[var(--sp-0-5)] text-[length:var(--text-11)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)] ${
              on
                ? 'border-transparent bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
                : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t(chip.messageKey)}
          </button>
        )
      })}
    </div>
  )
}
