/**
 * F-09. A work-in-progress limit is a rule about a column, and a rule is only worth having because
 * every surface that asks "how full is this column" answers the same way: the board header, the
 * collapsed strip, the grouped table, and the sentence read out after a card lands. So this file
 * reads the same number off all four, and reads it off the same mount path a reader uses — the
 * column menu that already holds the name and the colour.
 *
 * The limit may also have been written by hand in the fence or imported from another tool, so what
 * the board cannot read as a count of cards is treated as no limit at all rather than as a rule
 * that rejects every card; a column filled exactly to its limit is not yet over it.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { installTestGlobals, renderElement } from '../../../test-render'
import { formatKanbanGroupLabel } from '../i18n-helpers'
import { groupKanbanItems } from '../filter-sort'
import type { KanbanData, KanbanProperty } from '../types'
import { kanbanWipRefuses } from './kanban-board-wiring'
import { CollapsedColumn } from './kanban-column-header'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const TODO = 'todo'
const DOING = 'doing'

function statusColumn(limits: { todo?: number; doing?: number }): KanbanProperty {
  return {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: TODO, label: 'To Do', color: 'gray', wipLimit: limits.todo },
      { id: DOING, label: 'In Progress', color: 'blue', wipLimit: limits.doing },
    ],
  }
}

function cards(count: number, status: string): KanbanData['items'] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${status}-${i}`,
    title: `Card ${status} ${i + 1}`,
    properties: { status },
  }))
}

function boardData(status: KanbanProperty, todoCards: number): KanbanData {
  return {
    columns: [{ id: 'title', name: 'Title', type: 'title' }, status],
    items: [...cards(todoCards, TODO), ...cards(1, DOING)],
    views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
  } as KanbanData
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountKanban(data: KanbanData, onUpdateData = vi.fn()) {
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

function countPill(container: HTMLElement, groupKey: string): HTMLElement {
  const pill = container.querySelector<HTMLElement>(`[data-kanban-group="${groupKey}"] [data-kanban-count]`)
  expect(pill, `column ${groupKey} renders no count`).not.toBeNull()
  return pill!
}

/** What the pill draws, with the screen-reader sentence left out of the way. */
function visibleCount(pill: HTMLElement): string {
  return [...pill.querySelectorAll('span:not(.sr-only)')].map((part) => part.textContent ?? '').join('')
}

function localized(groupKey: string): string {
  return formatKanbanGroupLabel(groupKey, groupKey === TODO ? 'To Do' : 'In Progress')
}

function fullColumnMenu(container: HTMLElement): HTMLElement {
  const trigger = container.querySelector<HTMLElement>(`[data-kanban-group="${TODO}"] button[aria-haspopup="dialog"]`)
  expect(trigger, 'the column has no menu trigger').not.toBeNull()
  act(() => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog, 'the column menu did not open').not.toBeNull()
  return dialog!
}

function limitFieldIn(dialog: HTMLElement): HTMLInputElement {
  const input = dialog.querySelector<HTMLInputElement>('input[type="number"]')
  expect(input, 'the column menu has no work-in-progress limit field').not.toBeNull()
  return input!
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function optionWritten(commit: unknown, groupKey: string) {
  expect(commit, 'nothing was committed').toBeTruthy()
  const data = (commit as [KanbanData])[0]!
  const column = data.columns.find((c) => c.id === 'status')
  return column?.options?.find((o) => o.id === groupKey)
}

function lastCommit(onUpdateData: ReturnType<typeof vi.fn>) {
  const calls = onUpdateData.mock.calls
  return calls.length > 0 ? calls.at(-1) : undefined
}

function liveRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('[data-kanban-board] [data-kanban-move-announcement]')
  expect(region, 'the board renders no polite live region').not.toBeNull()
  return region!
}

function pressShiftArrow(itemId: string, key: 'ArrowRight' | 'ArrowLeft'): void {
  const card = document.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
  expect(card, `card ${itemId} is not in the document`).not.toBeNull()
  const origin = card!.querySelector<HTMLElement>('button') ?? card!
  origin.focus()
  act(() => {
    origin.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true }))
  })
}

describe('the count a column shows about how full it is', () => {
  it('puts the limit beside the cards of a column that has one', () => {
    const { container } = mountKanban(boardData(statusColumn({ todo: 2 }), 3))
    expect(visibleCount(countPill(container, TODO))).toBe(t('preview.kanban_wip_count', { count: 3, limit: 2 }))
  })

  it('leaves a column nobody limited showing only its count', () => {
    const { container } = mountKanban(boardData(statusColumn({ todo: 2 }), 3))
    expect(countPill(container, DOING).textContent).toBe('1')
    expect(countPill(container, DOING).hasAttribute('data-kanban-wip-limit')).toBe(false)
  })

  it('marks the column that is past its limit and says so in words', () => {
    const { container } = mountKanban(boardData(statusColumn({ todo: 2 }), 3))
    const pill = countPill(container, TODO)
    expect(pill.getAttribute('data-kanban-wip')).toBe('over')
    const spoken = pill.querySelector('.sr-only')?.textContent
    expect(spoken).toBe(t('preview.kanban_wip_over', { count: 3, limit: 2, over: 1 }))
  })

  it('does not mark a column filled exactly to its limit', () => {
    const { container } = mountKanban(boardData(statusColumn({ todo: 3 }), 3))
    const pill = countPill(container, TODO)
    expect(pill.hasAttribute('data-kanban-wip')).toBe(false)
    expect(pill.querySelector('.sr-only')).toBeNull()
    expect(visibleCount(pill)).toBe(t('preview.kanban_wip_count', { count: 3, limit: 3 }))
  })

  it('treats a limit it cannot read as a count of cards as no limit', () => {
    const column = statusColumn({ todo: 2 })
    column.options![0]!.wipLimit = 'two' as unknown as number
    const { container } = mountKanban(boardData(column, 3))
    const pill = countPill(container, TODO)
    expect(pill.textContent).toBe('3')
    expect(pill.hasAttribute('data-kanban-wip')).toBe(false)
  })
})

describe('the same answer where a column collapses or groups', () => {
  it('says the same thing on the collapsed strip', () => {
    const column = statusColumn({ todo: 2 })
    const group = groupKanbanItems(cards(3, TODO), 'status', column).find((g) => g.groupKey === TODO)!
    const rendered = renderElement(createElement(CollapsedColumn, {
      group,
      isDragOver: false,
      onExpand: vi.fn(),
      onDrop: vi.fn(),
      onDragOver: vi.fn(),
    }))
    mounted.push(rendered)
    const pill = countPill(rendered.container, TODO)
    expect(visibleCount(pill)).toBe(t('preview.kanban_wip_count', { count: 3, limit: 2 }))
    expect(pill.getAttribute('data-kanban-wip')).toBe('over')
    // The strip is one button, so its label has to carry the state the collapsed pill cannot show.
    expect(rendered.container.querySelector('button')?.getAttribute('aria-label')).toBe(
      t('preview.kanban_expand_column_over', { name: localized(TODO), over: 1, limit: 2 }),
    )
  })

  it('carries the rule into the grouped table too', () => {
    const data = boardData(statusColumn({ todo: 2 }), 3)
    data.views = [{ id: 'v-table', name: 'Table', type: 'table', groupBy: 'status' }]
    const { container } = mountKanban(data)
    const pill = countPill(container, TODO)
    expect(visibleCount(pill)).toBe(t('preview.kanban_wip_count', { count: 3, limit: 2 }))
    expect(pill.getAttribute('data-kanban-wip')).toBe('over')
  })
})

describe('setting a column limit from its menu', () => {
  it('starts from the limit the column already carries and writes back what is typed', () => {
    const { container, onUpdateData } = mountKanban(boardData(statusColumn({ todo: 2 }), 1))
    const input = limitFieldIn(fullColumnMenu(container))
    expect(input.value).toBe('2')
    typeInto(input, '5')
    act(() => { press(input, 'Enter') })
    expect(optionWritten(lastCommit(onUpdateData), TODO)).toMatchObject({ wipLimit: 5 })
  })

  it('names the field after the limit it holds', () => {
    const { container } = mountKanban(boardData(statusColumn({ todo: 2 }), 1))
    const dialog = fullColumnMenu(container)
    const input = limitFieldIn(dialog)
    expect(input.labels?.[0]?.textContent).toBe(t('preview.kanban_wip_limit'))
    const noticeId = input.getAttribute('aria-describedby')
    expect(noticeId, 'the field promises a notice it does not point at').toBeTruthy()
    expect(dialog.querySelector(`[id="${noticeId}"]`)?.textContent).toBe(t('preview.kanban_wip_limit_hint'))
  })

  it('clears the rule when the reader leaves the field blank', () => {
    const { container, onUpdateData } = mountKanban(boardData(statusColumn({ todo: 2 }), 1))
    const input = limitFieldIn(fullColumnMenu(container))
    typeInto(input, '')
    act(() => { press(input, 'Enter') })
    const written = optionWritten(lastCommit(onUpdateData), TODO)
    expect('wipLimit' in written!).toBe(false)
  })

})

describe('what the limit field writes back', () => {
  it('refuses a limit that is not a whole positive count of cards', () => {
    for (const junk of ['0', '-2', '1.5']) {
      const { container, onUpdateData } = mountKanban(boardData(statusColumn({ todo: 2 }), 1))
      const input = limitFieldIn(fullColumnMenu(container))
      typeInto(input, junk)
      const notice = document.querySelector<HTMLElement>('[role="dialog"] [role="status"]')
      expect(notice?.textContent, `typed ${junk}`).toBe(t('preview.kanban_wip_limit_invalid'))
      expect(input.getAttribute('aria-invalid')).toBe('true')
      act(() => { press(input, 'Enter') })
      expect(lastCommit(onUpdateData), `typed ${junk} then submitted`).toBeUndefined()
    }
  })

  it('commits on blur, the way renaming the column does', () => {
    const { container, onUpdateData } = mountKanban(boardData(statusColumn({ todo: 2 }), 1))
    const input = limitFieldIn(fullColumnMenu(container))
    typeInto(input, '4')
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(optionWritten(lastCommit(onUpdateData), TODO)).toMatchObject({ wipLimit: 4 })
  })

  it('has nothing to write a limit onto in the No Status column', () => {
    const data = boardData(statusColumn({ todo: 2 }), 1)
    data.items = [...data.items, { id: 'orphan', title: 'Card nowhere', properties: {} }]
    const { container } = mountKanban(data)
    const trigger = container.querySelector<HTMLElement>(`[data-kanban-group="__none__"] button[aria-haspopup="dialog"]`)
    expect(trigger, 'the No Status column has no menu trigger').not.toBeNull()
    act(() => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog, 'the No Status menu did not open').not.toBeNull()
    expect(dialog!.querySelector('input[type="number"]')).toBeNull()
  })
})

describe('a card that lands in a full column', () => {
  afterEach(() => {
    useUi.setState({ toasts: [] })
  })

  it('is refused at a column filled exactly to its limit, with a word of why', () => {
    const { container, onUpdateData } = mountKanban(boardData(statusColumn({ todo: 3 }), 3))
    pressShiftArrow(`${DOING}-0`, 'ArrowLeft')
    expect(onUpdateData, 'a card was moved into a full column anyway').not.toHaveBeenCalled()
    expect(liveRegion(container).textContent, 'a refused move was announced as if it happened').toBe('')
    expect(useUi.getState().toasts.at(-1)?.title).toBe(
      t('preview.kanban_wip_blocked', { group: localized(TODO), limit: 3 }),
    )
  })

  it('still lets the column’s own cards change place, even past the limit', () => {
    // The todo column is already over its limit here (three cards, limit two): what the door refuses
    // is cards coming in from elsewhere, not the column reordering itself.
    expect(kanbanWipRefuses(
      groupKanbanItems(cards(3, TODO), 'status', statusColumn({ todo: 2 })),
      { groupKey: TODO },
      new Set([`${TODO}-0`]),
    )).toBe(false)
  })

  it('keeps the plain announcement when the destination has room', () => {
    const { container } = mountKanban(boardData(statusColumn({ todo: 10 }), 3))
    pressShiftArrow(`${TODO}-0`, 'ArrowRight')
    expect(liveRegion(container).textContent).toBe(t('preview.kanban_moved_to_group', {
      title: 'Card todo 1',
      group: localized(DOING),
    }))
  })
})
