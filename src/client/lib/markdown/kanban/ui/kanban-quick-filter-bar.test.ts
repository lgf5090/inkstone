/**
 * KU-15, the surface half. Four questions a reader asks of a board constantly — what is late, what is
 * due today, what nobody took, what is mine — are chips in the header instead of five presses in the
 * filter panel. What the cases here hold is that a chip is the *same* rule the panel would have built:
 * it lands in the view's own `filters` list, next to whatever the reader already filtered to, so it can
 * be read, edited and undone in one place rather than living as a second kind of narrowing that no
 * other surface knows about.
 *
 * The board's schema decides which chips exist (a board with no date column is never late), and the
 * account's own name decides whether "mine" is a question at all — both asserted here, because a chip
 * that is drawn but can never match is worse than one that is absent.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, setLocale, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { useSession } from '../../../../store/session'
import type { PublicUser } from '@shared/types'
import { KanbanQuickFilterBar } from './kanban-quick-filter-bar'
import type { KanbanFilter, KanbanProperty } from '../types'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(async () => {
  await act(async () => {
    await setLocale('en-US', false)
  })
  signedInAs(null)
})

const COLUMNS: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
  { id: 'assignee', name: 'Assignee', type: 'person' },
  { id: 'endDate', name: 'End Date', type: 'date' },
]

function signedInAs(name: string | null): void {
  const user = name === null ? null : ({ id: 'u1', login: name, username: name, name, avatarUrl: '', role: 'owner', createdAt: 0 } as PublicUser)
  useSession.setState({ user })
}

const mounted: ReturnType<typeof renderElement>[] = []

function mountBar(columns: KanbanProperty[] = COLUMNS, filters: KanbanFilter[] = []) {
  const onChangeFilters = vi.fn()
  const render = (next: KanbanFilter[]) => createElement(KanbanQuickFilterBar, { columns, filters: next, onChangeFilters })
  const rendered = renderElement(render(filters))
  mounted.push(rendered)
  return { ...rendered, onChangeFilters, rerenderWith: (next: KanbanFilter[]) => rendered.rerender(render(next)) }
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function chip(container: HTMLElement, id: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[data-kanban-quick-filter="${id}"]`)
  if (!found) throw new Error(`the bar draws no ${id} chip`)
  return found
}

function chipIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-kanban-quick-filter]')].map(
    (element) => element.getAttribute('data-kanban-quick-filter') ?? '',
  )
}

describe('the bar draws the questions this board can answer', () => {
  it('offers the four chips, labelled in the reader’s language', () => {
    signedInAs('Alice')
    const { container } = mountBar()
    expect(chipIds(container)).toEqual(['overdue', 'dueToday', 'unassigned', 'mine'])
    expect(chip(container, 'overdue').textContent).toBe(t('preview.kanban_quick_overdue'))
    expect(chip(container, 'mine').textContent).toBe(t('preview.kanban_quick_mine'))
  })

  it('draws nothing at all on a board whose schema cannot answer them', () => {
    signedInAs('Alice')
    const { container } = mountBar([{ id: 'title', name: 'Title', type: 'title' }])
    expect(chipIds(container)).toEqual([])
  })

  it('leaves "mine" out for an account that carries no name', () => {
    signedInAs(null)
    const { container } = mountBar()
    expect(chipIds(container)).toEqual(['overdue', 'dueToday', 'unassigned'])
  })

  it('repaints its own words when the language changes, with no remount', async () => {
    signedInAs('Alice')
    const { container } = mountBar()
    const english = t('preview.kanban_quick_overdue')
    expect(chip(container, 'overdue').textContent).toBe(english)
    await act(async () => {
      await setLocale('zh-CN', false)
    })
    expect(chip(container, 'overdue').textContent).toBe(t('preview.kanban_quick_overdue'))
    expect(chip(container, 'overdue').textContent).not.toBe(english)
  })
})

describe('a chip writes the same rule the filter panel writes', () => {
  it('adds its rule beside the one the reader already built', () => {
    signedInAs('Alice')
    const byHand: KanbanFilter = { propertyId: 'status', operator: 'equals', value: 'todo' }
    const { container, onChangeFilters } = mountBar(COLUMNS, [byHand])
    act(() => { chip(container, 'overdue').click() })
    expect(onChangeFilters).toHaveBeenCalledWith([byHand, { propertyId: 'endDate', operator: 'is_overdue' }])
  })

  it('takes its own rule back out when pressed again', () => {
    signedInAs('Alice')
    const overdue: KanbanFilter = { propertyId: 'endDate', operator: 'is_overdue' }
    const { container, onChangeFilters } = mountBar(COLUMNS, [overdue])
    act(() => { chip(container, 'overdue').click() })
    expect(onChangeFilters).toHaveBeenCalledWith([])
  })

  it('asks the person column for the account’s own name', () => {
    signedInAs('Alice')
    const { container, onChangeFilters } = mountBar()
    act(() => { chip(container, 'mine').click() })
    expect(onChangeFilters).toHaveBeenCalledWith([{ propertyId: 'assignee', operator: 'equals', value: 'Alice' }])
  })

  it('asks about nothing rather than about the empty string when nobody is assigned', () => {
    signedInAs('Alice')
    const { container, onChangeFilters } = mountBar()
    act(() => { chip(container, 'unassigned').click() })
    expect(onChangeFilters).toHaveBeenCalledWith([{ propertyId: 'assignee', operator: 'is_empty' }])
  })
})

describe('a chip shows whether it is in force', () => {
  it('is a pressed toggle while the view carries its rule', () => {
    signedInAs('Alice')
    const { container } = mountBar()
    expect(chip(container, 'overdue').getAttribute('aria-pressed')).toBe('false')
    expect(chip(container, 'overdue').hasAttribute('data-active')).toBe(false)
  })

  it('reads as pressed once the rule is in the view', () => {
    signedInAs('Alice')
    const { container } = mountBar(COLUMNS, [{ propertyId: 'endDate', operator: 'is_overdue' }])
    expect(chip(container, 'overdue').getAttribute('aria-pressed')).toBe('true')
    expect(chip(container, 'overdue').hasAttribute('data-active')).toBe(true)
    // The neighbour asking another question of the same column is not lit by it.
    expect(chip(container, 'dueToday').getAttribute('aria-pressed')).toBe('false')
  })

  it('lights up when the same rule arrives from anywhere else', () => {
    signedInAs('Alice')
    const { container, rerenderWith } = mountBar()
    expect(chip(container, 'unassigned').getAttribute('aria-pressed')).toBe('false')
    rerenderWith([{ propertyId: 'assignee', operator: 'is_empty' }])
    expect(chip(container, 'unassigned').getAttribute('aria-pressed')).toBe('true')
  })
})
