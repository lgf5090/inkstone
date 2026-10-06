/**
 * F-11. Who a member picker may offer is decided where the board is mounted, not in the cell that
 * draws it, so these cases read a board end to end: the roster has to survive the current filter —
 * hiding a card must not make its teammate unassignable — and one choice has to reach the document
 * through the board's single commit path.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const TODO = 'todo'
const DOING = 'doing'

const columns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: TODO, label: 'To Do', color: 'gray' },
      { id: DOING, label: 'In Progress', color: 'blue' },
    ],
  },
  { id: 'reviewer', name: 'Reviewer', type: 'person' },
]

function card(id: string, properties: Record<string, unknown>): KanbanItem {
  return { id, title: `Card ${id}`, properties }
}

/** `Otto` is the only name no visible card carries. */
function rosterData(): KanbanData {
  return {
    columns,
    items: [
      card('a', { status: TODO, reviewer: 'Nora' }),
      card('b', { status: TODO }),
      card('c', { status: DOING, reviewer: 'Otto' }),
    ],
    views: [
      {
        id: 'v',
        name: 'Table',
        type: 'table',
        groupBy: 'status',
        filters: [{ propertyId: 'status', operator: 'equals', value: TODO }],
      },
    ],
  } as KanbanData
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountBoard(data: KanbanData = rosterData()) {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

function cell(container: HTMLElement, itemId: string, columnId: string): HTMLElement {
  const cellEl = container.querySelector<HTMLElement>(`[data-item-id="${itemId}"] [data-kanban-column="${columnId}"]`)
  if (!cellEl) throw new Error(`no cell for "${itemId}"/"${columnId}"`)
  return cellEl
}

function openMemberPicker(container: HTMLElement, itemId: string): HTMLElement {
  const trigger = [...cell(container, itemId, 'reviewer').querySelectorAll<HTMLButtonElement>('button')]
    .find((el) => el.getAttribute('aria-label') === t('preview.kanban_person_change', { property: 'Reviewer' }))
  if (!trigger) throw new Error(`no member trigger on card "${itemId}"`)
  act(() => { trigger.click() })
  const panel = cell(container, itemId, 'reviewer').querySelector<HTMLElement>('[role="dialog"]')
  if (!panel) throw new Error('the member panel did not open')
  return panel
}

function rosterOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-kanban-person-name]')].map((el) => el.textContent ?? '')
}

function committedItem(onUpdateData: ReturnType<typeof vi.fn>, itemId: string): KanbanItem {
  const calls = onUpdateData.mock.calls
  const next = (calls.at(-1) as [KanbanData])[0]
  return next.items.find((item) => item.id === itemId)!
}

describe('the roster a mounted board offers', () => {
  it('keeps a name whose only card the current filter hides', () => {
    const { container } = mountBoard()
    expect(container.querySelector('[data-item-id="c"]')).toBeNull()
    openMemberPicker(container, 'b')
    expect(rosterOf(container)).toEqual(['Nora', 'Otto'])
  })

  it('writes the chosen member through the single commit path', () => {
    const { container, onUpdateData } = mountBoard()
    openMemberPicker(container, 'b')
    const choice = [...container.querySelectorAll<HTMLButtonElement>('[data-kanban-person-choice]')]
      .find((el) => el.textContent?.includes('Otto'))!
    act(() => { choice.click() })
    expect(onUpdateData).toHaveBeenCalledTimes(1)
    expect(committedItem(onUpdateData, 'b').properties.reviewer).toBe('Otto')
  })

  it('assigns a name the board has never used', () => {
    const { container, onUpdateData } = mountBoard()
    const panel = openMemberPicker(container, 'b')
    const search = panel.querySelector<HTMLInputElement>("input[type='search']")!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'Zane')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onUpdateData).toHaveBeenCalledTimes(1)
    expect(committedItem(onUpdateData, 'b').properties.reviewer).toBe('Zane')
  })
})
