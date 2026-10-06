/**
 * F-2. The due-date notice is one question a board answers before the reader has to ask it: what is
 * still owed. What is pinned here is the counting — one date column decides, per the preference the
 * view and the schema hint at; done and filed-away cards stay out of it; and the two counts the
 * buttons write filters for are exactly the two the notice shows, so the door and what is behind it
 * cannot drift apart.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { kanbanDueNotice } from '../date-fields'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'
import { KanbanDueNotice } from './kanban-due-notice'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

/** The reader's own day, shifted by whole days — the same clock the notice counts against. */
function day(offset: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${dayOfMonth}`
}

function dateColumn(id: string): KanbanProperty {
  return { id, name: id === 'dueDate' ? 'Due' : 'End', type: 'date' }
}

function card(id: string, properties: Record<string, unknown>, extra: Partial<KanbanItem> = {}): KanbanItem {
  return { id, title: id, properties, ...extra }
}

describe('kanbanDueNotice counts what is still owed, off one date column', () => {
  it('splits past-due from due-today and skips done and filed-away cards', () => {
    const items = [
      card('late', { dueDate: day(-2) }),
      card('today', { dueDate: day(0) }),
      card('tomorrow', { dueDate: day(1) }),
      card('finished', { dueDate: day(-2), status: 'done' }),
      card('archived', { dueDate: day(-3) }, { archived: true }),
      card('deleted', { dueDate: day(-3) }, { deleted: true }),
    ]
    const notice = kanbanDueNotice(items, [dateColumn('dueDate')])!
    expect(notice.propertyId).toBe('dueDate')
    expect(notice.overdue.map((item) => item.id)).toEqual(['late'])
    expect(notice.dueToday.map((item) => item.id)).toEqual(['today'])
  })

  it('prefers the view’s own date field when the board keeps that column', () => {
    const items = [card('a', { endDate: day(-5), startDate: day(-1) })]
    const notice = kanbanDueNotice(items, [dateColumn('endDate'), dateColumn('startDate')], 'endDate')!
    expect(notice.propertyId).toBe('endDate')
    expect(notice.overdue).toHaveLength(1)
  })

  it('falls back through dueDate and endDate and answers nothing without a date column', () => {
    const withEnd = kanbanDueNotice([card('a', { endDate: day(-1) })], [dateColumn('endDate')])
    expect(withEnd?.propertyId).toBe('endDate')
    expect(kanbanDueNotice([card('a', { status: 'todo' })], [dateColumn('endDate')])).toBeNull()
    expect(kanbanDueNotice([card('a', { dueDate: day(-1) })], [{ id: 'dueDate', name: 'Due', type: 'text' }])).toBeNull()
  })
})

describe('the notice under the toolbar', () => {
  const columns: KanbanData['columns'] = [dateColumn('dueDate')]

  function mountNotice(items: KanbanItem[], onApplyFilters = vi.fn()) {
    const rendered = renderElement(createElement(KanbanDueNotice, {
      items,
      columns,
      onApplyFilters,
    }))
    mounted.push(rendered)
    return { onApplyFilters }
  }

  it('offers both counts as filters, each writing the rule it promised', () => {
    const { onApplyFilters } = mountNotice([
      card('late', { dueDate: day(-2) }),
      card('today', { dueDate: day(0) }),
    ])
    expect(document.querySelector('[data-kanban-due-notice]')).not.toBeNull()
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-kanban-due-notice] button')]
    act(() => buttons[0]!.click())
    expect(onApplyFilters).toHaveBeenCalledWith([{ propertyId: 'dueDate', operator: 'is_overdue' }])
    act(() => buttons[1]!.click())
    expect(onApplyFilters).toHaveBeenCalledWith([{ propertyId: 'dueDate', operator: 'equals', value: day(0) }])
  })

  it('goes away when the reader dismisses it, and stays away', () => {
    mountNotice([card('late', { dueDate: day(-2) })])
    const dismiss = [...document.querySelectorAll<HTMLButtonElement>('[data-kanban-due-notice] button')].at(-1)!
    expect(dismiss.getAttribute('aria-label')).toBe(t('preview.kanban_due_dismiss'))
    act(() => dismiss.click())
    expect(document.querySelector('[data-kanban-due-notice]')).toBeNull()
  })

  it('draws nothing for a board that owes nothing', () => {
    mountNotice([card('a', { dueDate: day(3) })])
    expect(document.querySelector('[data-kanban-due-notice]')).toBeNull()
  })
})
