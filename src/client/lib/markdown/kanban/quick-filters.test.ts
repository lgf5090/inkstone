/**
 * KU-15. A board answers the same four questions over and over — what is late, what is due today, what
 * nobody has picked up, what is mine — and every one of them is already expressible as a rule the
 * filter panel can build by hand, several presses at a time. These are the rules the chips write, held
 * apart from any surface: which column a deadline question is asked of, that a chip narrows the board
 * rather than replacing what the reader already filtered to, and that a board which cannot answer a
 * question is offered no chip for it instead of one that matches nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  isKanbanQuickFilterOn,
  kanbanDeadlineColumn,
  kanbanPersonColumn,
  kanbanQuickFilters,
  toggleKanbanQuickFilter,
} from './quick-filters'
import type { KanbanFilter, KanbanProperty } from './types'

const COLUMNS: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
  { id: 'assignee', name: 'Assignee', type: 'person' },
  { id: 'startDate', name: 'Start Date', type: 'date' },
  { id: 'endDate', name: 'End Date', type: 'date' },
  { id: 'tags', name: 'Tags', type: 'multi-select', options: [] },
]

const TODAY = '2026-09-24'

describe('a deadline question picks the column the rest of the board calls the deadline', () => {
  it('prefers the due column the detail dialog writes', () => {
    expect(kanbanDeadlineColumn([...COLUMNS, { id: 'dueDate', name: 'Due', type: 'date' }])?.id).toBe('dueDate')
  })

  it('falls back to the generated end column', () => {
    expect(kanbanDeadlineColumn(COLUMNS)?.id).toBe('endDate')
  })

  it('falls back to the first date column a board of another shape declares', () => {
    const columns: KanbanProperty[] = [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'sprintEnds', name: 'Sprint ends', type: 'date' },
    ]
    expect(kanbanDeadlineColumn(columns)?.id).toBe('sprintEnds')
  })

  it('has no deadline on a board that declares no date column', () => {
    expect(kanbanDeadlineColumn(COLUMNS.filter((column) => column.type !== 'date'))).toBeUndefined()
  })
})

describe('the chips a board offers are the questions its own schema can answer', () => {
  it('asks the deadline and the person column, each once', () => {
    const chips = kanbanQuickFilters(COLUMNS, { today: TODAY, me: 'Alice' })
    expect(chips.map((chip) => chip.id)).toEqual(['overdue', 'dueToday', 'unassigned', 'mine'])
    expect(chips[0]!.filter).toEqual({ propertyId: 'endDate', operator: 'is_overdue' })
    expect(chips[1]!.filter).toEqual({ propertyId: 'endDate', operator: 'equals', value: TODAY })
    expect(chips[2]!.filter).toEqual({ propertyId: 'assignee', operator: 'is_empty' })
    expect(chips[3]!.filter).toEqual({ propertyId: 'assignee', operator: 'equals', value: 'Alice' })
  })

  it('finds the person column by its type rather than by a name it happens to have', () => {
    const columns: KanbanProperty[] = [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'owner', name: 'Owner', type: 'person' },
    ]
    expect(kanbanPersonColumn(columns)?.id).toBe('owner')
    expect(kanbanQuickFilters(columns, { today: TODAY, me: 'Alice' })[0]!.filter.propertyId).toBe('owner')
  })

  it('offers no chip for what it cannot ask', () => {
    const noPerson: KanbanProperty[] = [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'endDate', name: 'End Date', type: 'date' },
    ]
    expect(kanbanQuickFilters(noPerson, { today: TODAY, me: 'Alice' }).map((chip) => chip.id)).toEqual(['overdue', 'dueToday'])
    const noDates: KanbanProperty[] = [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'assignee', name: 'Assignee', type: 'person' },
    ]
    expect(kanbanQuickFilters(noDates, { today: TODAY, me: 'Alice' }).map((chip) => chip.id)).toEqual(['unassigned', 'mine'])
    expect(kanbanQuickFilters([{ id: 'title', name: 'Title', type: 'title' }], { today: TODAY, me: 'Alice' })).toEqual([])
  })

  it('leaves "mine" out when the account carries no name to match', () => {
    expect(kanbanQuickFilters(COLUMNS, { today: TODAY }).map((chip) => chip.id)).toEqual(['overdue', 'dueToday', 'unassigned'])
    expect(kanbanQuickFilters(COLUMNS, { today: TODAY, me: '   ' }).map((chip) => chip.id)).toEqual(['overdue', 'dueToday', 'unassigned'])
  })

  it('names every chip, in a key the resources carry', () => {
    for (const chip of kanbanQuickFilters(COLUMNS, { today: TODAY, me: 'Alice' })) {
      expect(chip.messageKey.startsWith('preview.kanban_quick_'), chip.messageKey).toBe(true)
    }
  })
})

describe('a chip narrows the board rather than replacing what the reader built', () => {
  const overdue: KanbanFilter = { propertyId: 'endDate', operator: 'is_overdue' }
  const byHand: KanbanFilter = { propertyId: 'status', operator: 'equals', value: 'todo' }

  it('adds its rule to the end of the list', () => {
    expect(toggleKanbanQuickFilter(overdue, [byHand])).toEqual([byHand, overdue])
  })

  it('takes its own rule back out and leaves the others standing', () => {
    expect(toggleKanbanQuickFilter(overdue, [byHand, overdue])).toEqual([byHand])
  })

  it('is on exactly while the view carries the same rule', () => {
    expect(isKanbanQuickFilterOn(overdue, [byHand])).toBe(false)
    expect(isKanbanQuickFilterOn(overdue, [byHand, overdue])).toBe(true)
  })

  it('tells two questions of the same column apart', () => {
    const dueToday: KanbanFilter = { propertyId: 'endDate', operator: 'equals', value: TODAY }
    expect(isKanbanQuickFilterOn(dueToday, [overdue])).toBe(false)
    expect(isKanbanQuickFilterOn(overdue, [dueToday])).toBe(false)
    // Same operator, different column: the two person rules are not each other.
    expect(isKanbanQuickFilterOn({ propertyId: 'assignee', operator: 'equals', value: 'Alice' }, [{ propertyId: 'reviewer', operator: 'equals', value: 'Alice' }])).toBe(false)
  })

  it('reads an empty rule value as an empty rule value rather than as a missing one', () => {
    const unassigned: KanbanFilter = { propertyId: 'assignee', operator: 'is_empty' }
    expect(isKanbanQuickFilterOn(unassigned, [{ propertyId: 'assignee', operator: 'is_empty', value: '' }])).toBe(true)
    expect(isKanbanQuickFilterOn(unassigned, [{ propertyId: 'assignee', operator: 'is_empty', value: 'Alice' }])).toBe(false)
  })
})
