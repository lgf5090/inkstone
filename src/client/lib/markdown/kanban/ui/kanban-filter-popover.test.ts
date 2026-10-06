/**
 * A filter row asked text questions of every column, so the six operators a rule could carry were
 * the same whether the column held a count, a deadline or a choice. That is a row which reads as
 * working and never matches: "greater than" was not offerable at all, and "contains" on a date
 * column compared a whole timestamp to whatever was typed. The row therefore has to answer to its
 * column three ways — the operators it lists, the control it asks for a threshold with, and what
 * survives of a rule already saved in the note when the column behind it is swapped.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanFilter, KanbanProperty } from '../types'
import { KanbanFilterPopover } from './kanban-filter-popover'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const noop = () => {}
const anchorRef = { current: null as HTMLElement | null }

const columns: KanbanProperty[] = [
  { id: 'notes', name: 'Notes', type: 'text' },
  { id: 'points', name: 'Points', type: 'number' },
  { id: 'deadline', name: 'Deadline', type: 'date' },
  {
    id: 'stage',
    name: 'Stage',
    type: 'select',
    options: [{ id: 's1', label: 'Alpha', color: 'gray' }, { id: 's2', label: 'Beta', color: 'blue' }],
  },
]

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

function mountRow(filters: KanbanFilter[], cols = columns) {
  const onChangeFilters = vi.fn()
  const rendered = renderElement(
    createElement(KanbanFilterPopover, {
      open: true,
      panelId: 'filter-panel',
      onClose: noop,
      anchorRef,
      columns: cols,
      filters,
      onChangeFilters,
    }),
  )
  mounted.push(rendered)
  return { ...rendered, onChangeFilters }
}

function named(root: ParentNode, name: string): HTMLElement | null {
  return root.querySelector(`[aria-label="${name}"]`)
}

/* Every case below mounts exactly one rule, so the panel's first of each control is that rule's. */
const propertyOf = (container: ParentNode) =>
  named(container, t('preview.kanban_filter_property')) as HTMLSelectElement
const operatorOf = (container: ParentNode) => named(container, t('preview.kanban_filter_operator')) as HTMLSelectElement
const valueOf = (container: ParentNode) => named(container, t('preview.kanban_filter_value'))
const operatorLabelsIn = (container: ParentNode) =>
  [...operatorOf(container).querySelectorAll('option')].map((o) => o.textContent ?? '')

function changeSelect(node: HTMLSelectElement | HTMLElement, value: string): void {
  act(() => {
    ;(node as HTMLSelectElement).value = value
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('a filter row lists the operators its column can answer', () => {
  it('offers comparison to a number column and withholds text search', () => {
    const rendered = mountRow([{ propertyId: 'points', operator: 'equals', value: '3' }])
    const labels = operatorLabelsIn(rendered.container)
    expect(labels).toContain(t('preview.kanban_op_greater_than'))
    expect(labels).toContain(t('preview.kanban_op_less_or_equal'))
    expect(labels).not.toContain(t('preview.kanban_op_contains'))
  })

  it('offers the missed-day question to a date column alone', () => {
    const labels = operatorLabelsIn(
      mountRow([{ propertyId: 'deadline', operator: 'before', value: '2026-03-10' }]).container,
    )
    expect(labels).toContain(t('preview.kanban_op_is_overdue'))
    for (const id of ['notes', 'points', 'stage']) {
      const other = mountRow([{ propertyId: id, operator: 'equals', value: 'x' }]).container
      expect(operatorLabelsIn(other), `${id} offers a missed-day question`).not.toContain(
        t('preview.kanban_op_is_overdue'),
      )
    }
  })

  it('still names the operator a saved rule already uses', () => {
    const rendered = mountRow([{ propertyId: 'points', operator: 'contains', value: '3' }])
    expect(operatorLabelsIn(rendered.container)).toContain(t('preview.kanban_op_contains'))
    expect(operatorOf(rendered.container).value).toBe('contains')
  })
})

describe('a filter row asks for the threshold in the column’s own kind', () => {
  it('gives a number column a number field', () => {
    const rendered = mountRow([{ propertyId: 'points', operator: 'greater_than', value: '3' }])
    const value = valueOf(rendered.container)
    expect(value?.tagName).toBe('INPUT')
    expect((value as HTMLInputElement).type).toBe('number')
    expect((value as HTMLInputElement).value).toBe('3')
  })

  it('gives a date column a date field', () => {
    const rendered = mountRow([{ propertyId: 'deadline', operator: 'before', value: '2026-03-10' }])
    const value = valueOf(rendered.container)
    expect(value?.tagName).toBe('INPUT')
    expect((value as HTMLInputElement).type).toBe('date')
  })

  it('gives a choice column the list of choices, and keeps a value written as a label', () => {
    const rendered = mountRow([{ propertyId: 'stage', operator: 'equals', value: 'Beta' }])
    const value = valueOf(rendered.container)
    expect(value?.tagName).toBe('SELECT')
    const written = [...(value as HTMLSelectElement).options].map((o) => o.value)
    expect(written).toEqual(expect.arrayContaining(['s1', 's2', 'Beta']))
    expect((value as HTMLSelectElement).value).toBe('Beta')
  })

  it('asks for no threshold at all when the operator reads the cell itself', () => {
    for (const operator of ['is_overdue', 'is_empty', 'is_not_empty'] as const) {
      const rendered = mountRow([{ propertyId: 'deadline', operator }])
      expect(valueOf(rendered.container), `${operator} asks for a threshold`).toBeNull()
    }
  })
})

describe('switching a rule to another column', () => {
  it('restarts the operator when the new column cannot answer the old one', () => {
    const rendered = mountRow([{ propertyId: 'notes', operator: 'contains', value: 'draft' }])
    changeSelect(propertyOf(rendered.container), 'points')
    expect(rendered.onChangeFilters).toHaveBeenCalledWith([
      { propertyId: 'points', operator: 'equals', value: '' },
    ])
  })

  it('keeps an operator both columns can answer, value and all', () => {
    const rendered = mountRow([{ propertyId: 'points', operator: 'equals', value: 'draft' }])
    changeSelect(propertyOf(rendered.container), 'notes')
    expect(rendered.onChangeFilters).toHaveBeenCalledWith([
      { propertyId: 'notes', operator: 'equals', value: 'draft' },
    ])
  })
})

describe('a filter row names each of its controls', () => {
  it('labels the field, the operator and the threshold', () => {
    const rendered = mountRow([{ propertyId: 'points', operator: 'greater_than', value: '3' }])
    expect(propertyOf(rendered.container).getAttribute('aria-label')).toBe(
      t('preview.kanban_filter_property'),
    )
    expect(operatorOf(rendered.container).getAttribute('aria-label')).toBe(
      t('preview.kanban_filter_operator'),
    )
    expect(valueOf(rendered.container)?.getAttribute('aria-label')).toBe(t('preview.kanban_filter_value'))
  })
})
