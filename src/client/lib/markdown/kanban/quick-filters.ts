import type { MessageKey } from '../../i18n'
import type { KanbanFilter, KanbanProperty } from './types'

/**
 * The questions a reader asks of a board far more often than any other: what is late, what is due
 * today, what nobody has picked up, and what is mine. Each one is expressible as a rule the board
 * already understands — `is_overdue` for the first, `equals today` for the second, `is_empty` and
 * `equals <my name>` on the person column for the last two — so this module builds the very rules the
 * filter panel builds by hand. Nothing here is a second filter engine: pressing a chip writes a
 * `KanbanFilter` into the view, which is why the rule then shows up in the panel as an ordinary row,
 * survives a reload, and comes back with one undo.
 *
 * Which column each question is asked of is decided here and nowhere else. `dueDate` is what the
 * detail dialog's due field writes and `endDate` is the generated schema's own end column; a board may
 * carry either, and the deadline is the one of them the rest of the module treats as the card's
 * deadline (see `date-fields.ts`), so a chip cannot call a card late that its own badge calls on time.
 */

export type KanbanQuickFilterId = 'overdue' | 'dueToday' | 'unassigned' | 'mine'

export interface KanbanQuickFilter {
  id: KanbanQuickFilterId
  /** What the chip says, in the reader's own language at the moment it is drawn. */
  messageKey: MessageKey
  /** The rule the chip writes — the same shape the filter panel produces. */
  filter: KanbanFilter
}

/**
 * The column a deadline question is asked of: the due column when the author declared one, else the
 * generated end column, else the board's first date column. A board that declares no date column at
 * all has no deadline to be late against, and gets no chips for it.
 */
export function kanbanDeadlineColumn(columns: KanbanProperty[]): KanbanProperty | undefined {
  const dated = columns.filter((column) => column.type === 'date')
  return dated.find((column) => column.id === 'dueDate')
    ?? dated.find((column) => column.id === 'endDate')
    ?? dated[0]
}

/** The column that names who holds a card. The first one, for the same reason the deadline is. */
export function kanbanPersonColumn(columns: KanbanProperty[]): KanbanProperty | undefined {
  return columns.find((column) => column.type === 'person')
}

/**
 * The chips this board can offer, in the order they are worth reading: the two deadline questions
 * first, then the two about who holds the card. `me` is the account's own name; without one — a
 * reader whose account carries no name, or a board with no person column — "mine" is not a question
 * that can be asked, so it is left out rather than drawn as a chip that matches nothing.
 */
export function kanbanQuickFilters(
  columns: KanbanProperty[],
  context: { today: string; me?: string },
): KanbanQuickFilter[] {
  const chips: KanbanQuickFilter[] = []
  const deadline = kanbanDeadlineColumn(columns)
  if (deadline) {
    chips.push({
      id: 'overdue',
      messageKey: 'preview.kanban_quick_overdue',
      filter: { propertyId: deadline.id, operator: 'is_overdue' },
    })
    chips.push({
      id: 'dueToday',
      messageKey: 'preview.kanban_quick_due_today',
      filter: { propertyId: deadline.id, operator: 'equals', value: context.today },
    })
  }
  const person = kanbanPersonColumn(columns)
  if (person) {
    chips.push({
      id: 'unassigned',
      messageKey: 'preview.kanban_quick_unassigned',
      filter: { propertyId: person.id, operator: 'is_empty' },
    })
    const me = context.me?.trim()
    if (me) {
      chips.push({
        id: 'mine',
        messageKey: 'preview.kanban_quick_mine',
        filter: { propertyId: person.id, operator: 'equals', value: me },
      })
    }
  }
  return chips
}

/** Two rules are the same rule when they ask the same thing of the same column. */
function sameKanbanFilter(a: KanbanFilter, b: KanbanFilter): boolean {
  return a.propertyId === b.propertyId && a.operator === b.operator && (a.value ?? '') === (b.value ?? '')
}

/** Whether the view already carries this chip's rule — what lights the chip up. */
export function isKanbanQuickFilterOn(filter: KanbanFilter, filters: KanbanFilter[]): boolean {
  return filters.some((existing) => sameKanbanFilter(existing, filter))
}

/**
 * Pressing a chip narrows the board further or takes that narrowing back, leaving every other rule
 * alone: the reader may have built a filter by hand and then reached for "overdue" on top of it, and a
 * chip that replaced the whole list would silently throw their own work away.
 */
export function toggleKanbanQuickFilter(filter: KanbanFilter, filters: KanbanFilter[]): KanbanFilter[] {
  if (isKanbanQuickFilterOn(filter, filters)) {
    return filters.filter((existing) => !sameKanbanFilter(existing, filter))
  }
  return [...filters, filter]
}
