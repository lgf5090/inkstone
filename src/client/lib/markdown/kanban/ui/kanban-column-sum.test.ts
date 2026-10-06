/**
 * G-12. A view may total one number column into its column headers — the figure a team reads per
 * stage (points left, hours queued) rather than counting cards. The contract here has three halves:
 * the total itself (a numeric string from a hand-written fence counts, a blank does not), the pill
 * the header draws from that total (visible glyph for the eye, a sentence that names the column for
 * the reader's ears), and the picker that turns the whole thing on and off on the view it belongs to.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { sumKanbanNumberProperty } from '../filter-sort'
import type { KanbanData, KanbanProperty, KanbanView } from '../types'
import { KanbanRoot } from './kanban-root'
import { KanbanViewOptions } from './kanban-view-options'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const TODO = 'todo'
const DOING = 'doing'

const statusColumn: KanbanProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: TODO, label: 'To Do', color: 'gray' },
    { id: DOING, label: 'Doing', color: 'blue' },
  ],
}

const pointsColumn: KanbanProperty = { id: 'points', name: 'Points', type: 'number' }

function card(id: string, status: string, points: unknown): KanbanData['items'][number] {
  return { id, title: id, properties: { status, points } }
}

function boardData(sumBy?: string): KanbanData {
  const view: KanbanView = { id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }
  if (sumBy) view.sumBy = sumBy
  return {
    columns: [{ id: 'title', name: 'Title', type: 'title' }, statusColumn, pointsColumn],
    items: [
      card('a', TODO, 3),
      card('b', TODO, '4'),
      card('c', TODO, ''),
      card('d', DOING, 2),
    ],
    views: [view],
  }
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountKanban(data: KanbanData) {
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData: vi.fn() }))
  mounted.push(rendered)
  return rendered
}

describe('sumKanbanNumberProperty', () => {
  it('adds numbers and numeric strings and skips what is not a number', () => {
    const items = [
      card('a', TODO, 3),
      card('b', TODO, '4.5'),
      card('c', TODO, ''),
      card('d', TODO, 'soon'),
      card('e', TODO, undefined),
    ]
    expect(sumKanbanNumberProperty(items, 'points')).toBe(7.5)
  })

  it('totals nothing over no cards', () => {
    expect(sumKanbanNumberProperty([], 'points')).toBe(0)
  })
})

describe('the column header totals the view\u2019s number column', () => {
  it('draws the figure and the sentence naming the column, per stage', () => {
    const { container } = mountKanban(boardData('points'))
    const todoPill = container.querySelector<HTMLElement>(`[data-kanban-group="${TODO}"] [data-kanban-sum]`)
    expect(todoPill, 'the todo column draws no sum pill').not.toBeNull()
    expect(todoPill!.querySelector('span[aria-hidden]')!.textContent).toBe('Σ 7')
    expect(todoPill!.querySelector('.sr-only')!.textContent).toBe(t('preview.kanban_column_sum', { name: 'Points', count: 7 }))
    const doingPill = container.querySelector<HTMLElement>(`[data-kanban-group="${DOING}"] [data-kanban-sum]`)
    expect(doingPill!.querySelector('span[aria-hidden]')!.textContent).toBe('Σ 2')
  })

  it('draws no pill where the view sums nothing', () => {
    const { container } = mountKanban(boardData())
    expect(container.querySelector('[data-kanban-sum]')).toBeNull()
  })
})

describe('the view options picker turns the summary on and off', () => {
  function mountOptions() {
    const onChangeSumBy = vi.fn<(propId: string | undefined) => void>()
    const rendered = renderElement(createElement(KanbanViewOptions, {
      open: true,
      panelId: 'p',
      onClose: vi.fn(),
      anchorRef: { current: document.createElement('button') },
      columns: [statusColumn, pointsColumn, { id: 'title', name: 'Title', type: 'title' }],
      groupBy: 'status',
      sumBy: 'points',
      onChangeGroupBy: vi.fn(),
      onChangeSumBy,
    }))
    mounted.push(rendered)
    return { rendered, onChangeSumBy }
  }

  it('lists the number columns with the off choice first, and reports both directions', () => {
    const { rendered, onChangeSumBy } = mountOptions()
    // The panel holds several selects; the sum picker is the one whose first choice is the off one.
    const select = [...rendered.container.querySelectorAll('select')].find(
      (candidate) => candidate.options[0]?.textContent === t('preview.kanban_sum_off'),
    )
    expect(select, 'the panel drew no sum picker').toBeDefined()
    const labels = [...select!.querySelectorAll('option')].map((option) => option.textContent)
    expect(labels).toEqual([t('preview.kanban_sum_off'), 'Points'])
    act(() => {
      select!.value = ''
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChangeSumBy).toHaveBeenCalledWith(undefined)
    act(() => {
      select!.value = 'points'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChangeSumBy).toHaveBeenLastCalledWith('points')
  })
})
