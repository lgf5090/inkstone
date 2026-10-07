/**
 * One card used to read differently depending on which view looked at it (review #25's only
 * correctness row): the board fell back to `startDate`, the gallery and the list never read the
 * schema's own `endDate` column at all, and every badge printed the raw `YYYY-MM-DD` key. The three
 * surfaces now derive one label from one accessor, so the contract asserted here is one item, three
 * surfaces, one date — and that the printed text is the reader's own date format, not the stored key.
 */
import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, localeTag, t } from '../../../i18n'
import { installTestGlobals } from '../../../test-render'
import { KanbanCard } from './kanban-card'
import { KanbanGalleryView } from './kanban-gallery-view'
import { KanbanListView } from './kanban-list-view'
import { getKanbanCardDate, getKanbanDueDate, getKanbanOverdueDays, kanbanDayKey } from '../date-fields'
import { isKanbanItemDone } from '../item-status'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'

beforeAll(async () => {
  await initI18n()
})

const columns: KanbanProperty[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
  { id: 'startDate', name: 'Start Date', type: 'date' },
  { id: 'endDate', name: 'End Date', type: 'date' },
]

// Both fixtures stay inside the running year so the label rule never has to carry a year.
const YEAR = new Date().getFullYear()
const DUE_KEY = `${YEAR}-11-05`
const START_KEY = `${YEAR}-02-03`

function labelFor(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  return new Intl.DateTimeFormat(localeTag(), { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day))
}

function makeItem(id: string, properties: Record<string, unknown>): KanbanItem {
  return { id, title: id, properties: { status: 'todo', ...properties } }
}

function mount(element: ReactElement) {
  installTestGlobals()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(element) })
  mounted.push({ root })
  return container
}

const mounted: { root: ReturnType<typeof createRoot> }[] = []

afterEach(() => {
  while (mounted.length) {
    const { root } = mounted.pop()!
    act(() => { root.unmount() })
  }
  document.body.innerHTML = ''
})

function dataFor(items: KanbanItem[]): KanbanData {
  return { columns, items, views: [{ id: 'v-list', name: 'List', type: 'list', groupBy: 'status' }] }
}

function containersFor(item: KanbanItem): Record<string, HTMLElement> {
  const data = dataFor([item])
  const list = mount(createElement(KanbanListView, {
    data,
    selectedIds: new Set<string>(),
    onToggleSelect: vi.fn(),
    onOpenDetail: vi.fn(),
    onAddItem: vi.fn(),
  }))
  const gallery = mount(createElement(KanbanGalleryView, {
    data,
    selectedIds: new Set<string>(),
    onToggleSelect: vi.fn(),
    onOpenDetail: vi.fn(),
    onAddItem: vi.fn(),
  }))
  const board = mount(createElement(KanbanCard, {
    item,
    columns,
    isSelected: false,
    onToggleSelect: vi.fn(),
    onOpenDetail: vi.fn(),
    onUpdateTitle: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
  }))
  return { list, gallery, board }
}

function surfacesFor(item: KanbanItem): Record<string, string> {
  return Object.fromEntries(
    Object.entries(containersFor(item)).map(([name, container]) => [name, container.textContent ?? '']),
  )
}

// A missed deadline is the one thing a date badge has to work out for itself, and it has to work it
// out the same way on all three surfaces. It says the overrun in words, keeps the day it refers to
// reachable in the title and marks itself with the alert icon; the red token stays off its small
// text, where it measures under AA in the light theme, so colour never has to be read alone.
const TODAY = new Date(2026, 2, 15)

interface Badge {
  text: string
  title: string
  overdue: boolean
  iconDanger: boolean
  textDanger: boolean
}

interface Expectation {
  text: string
  overdue: boolean
  title?: string
}

function badgesFor(item: KanbanItem): Record<string, Badge> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(TODAY)
  try {
    return Object.fromEntries(Object.entries(containersFor(item)).map(([name, container]) => {
      const badge = container.querySelector<HTMLElement>('[data-kanban-date]')
      return [name, {
        text: badge?.textContent ?? '',
        title: badge?.getAttribute('title') ?? '',
        overdue: badge?.hasAttribute('data-kanban-overdue') ?? false,
        iconDanger: badge?.querySelector('svg')?.getAttribute('class')?.includes('var(--danger)') ?? false,
        textDanger: badge?.className.includes('var(--danger)') ?? false,
      }]
    }))
  }
  finally {
    vi.useRealTimers()
  }
}

function expectOnEverySurface(item: KanbanItem, expected: Expectation) {
  for (const [surface, badge] of Object.entries(badgesFor(item))) {
    expect(badge.text, `${surface} prints the wrong thing`).toBe(expected.text)
    if (expected.title !== undefined) {
      expect(badge.title, `${surface} hides the day its badge talks about`).toBe(expected.title)
    }
    expect(badge.overdue, `${surface} calls the card the wrong kind of late`).toBe(expected.overdue)
    expect(badge.iconDanger, `${surface} marks the deadline with the wrong icon`).toBe(expected.overdue)
    expect(badge.textDanger, `${surface} puts sub-AA red on small text`).toBe(false)
  }
}

describe('kanban card date across surfaces', () => {
  it('shows the end date the schema owns in every surface', () => {
    const surfaces = surfacesFor(makeItem('only-end', { endDate: DUE_KEY }))
    for (const [name, text] of Object.entries(surfaces))
      expect(text, `${name} dropped the only date the card has`).toContain(labelFor(DUE_KEY))
    for (const text of Object.values(surfaces))
      expect(text, 'the stored key must not reach the reader').not.toContain(DUE_KEY)
  })

  it('shows the deadline rather than the start in every surface', () => {
    const surfaces = surfacesFor(makeItem('both-dates', { dueDate: DUE_KEY, startDate: START_KEY }))
    for (const [name, text] of Object.entries(surfaces)) {
      expect(text, `${name} printed the start date as the deadline`).toContain(labelFor(DUE_KEY))
      expect(text, `${name} printed the deadline twice`).not.toContain(labelFor(START_KEY))
    }
  })

  it('still shows a card that only has a start date', () => {
    const surfaces = surfacesFor(makeItem('only-start', { startDate: START_KEY }))
    for (const [name, text] of Object.entries(surfaces))
      expect(text, `${name} lost the only date the card has`).toContain(labelFor(START_KEY))
  })
})

describe('kanban date field resolution', () => {
  it('reads the deadline from the key the detail writes, then the schema end column', () => {
    expect(getKanbanDueDate(makeItem('a', { dueDate: DUE_KEY, endDate: START_KEY }))).toBe(DUE_KEY)
    expect(getKanbanDueDate(makeItem('b', { endDate: START_KEY }))).toBe(START_KEY)
    expect(getKanbanDueDate(makeItem('c', { startDate: START_KEY }))).toBe('')
  })

  it('ignores a date key no writer produces', () => {
    expect(getKanbanCardDate(makeItem('legacy', { date: DUE_KEY }))).toBe('')
  })

  it('reads the day a stored value names, and none when it names none', () => {
    expect(kanbanDayKey('2026-09-17')).toBe('2026-09-17')
    expect(kanbanDayKey('2026-09-17T12:00:00Z')).toBe('2026-09-17')
    expect(kanbanDayKey('tomorrow')).toBe('')
    expect(kanbanDayKey('')).toBe('')
    expect(kanbanDayKey(null)).toBe('')
  })

  it('falls back to the start date only when there is no deadline', () => {
    expect(getKanbanCardDate(makeItem('start-only', { startDate: START_KEY }))).toBe(START_KEY)
    expect(getKanbanCardDate(makeItem('both', { dueDate: DUE_KEY, startDate: START_KEY }))).toBe(DUE_KEY)
  })
})

describe('kanban overdue judgement', () => {
  const due = (value: unknown) => makeItem('due', { dueDate: value })

  it('counts whole days between the deadline and today', () => {
    expect(getKanbanOverdueDays(due('2026-03-10'), TODAY)).toBe(5)
    expect(getKanbanOverdueDays(due('2026-03-14'), TODAY)).toBe(1)
  })

  it('keeps the count across a month and a year boundary', () => {
    expect(getKanbanOverdueDays(due('2026-02-27'), TODAY)).toBe(16)
    expect(getKanbanOverdueDays(due('2025-12-30'), new Date(2026, 0, 3))).toBe(4)
  })

  it('is not overdue on the deadline itself or while it still lies ahead', () => {
    expect(getKanbanOverdueDays(due('2026-03-15'), TODAY)).toBe(0)
    expect(getKanbanOverdueDays(due('2026-04-02'), TODAY)).toBe(0)
  })

  it('counts the schema end column as a deadline', () => {
    expect(getKanbanOverdueDays(makeItem('end', { endDate: '2026-03-01' }), TODAY)).toBe(14)
  })

  it('never calls a start date a missed deadline', () => {
    expect(getKanbanOverdueDays(makeItem('start', { startDate: '2020-01-01' }), TODAY)).toBe(0)
  })

  it('stops counting once the card sits in a done group', () => {
    expect(getKanbanOverdueDays(makeItem('done', { dueDate: '2026-03-01', status: 'Done' }), TODAY)).toBe(0)
  })

  it('reads a deadline stored with a time as that same day', () => {
    expect(getKanbanOverdueDays(due('2026-03-10T12:00:00Z'), TODAY)).toBe(5)
  })

  it('has no opinion about a value that is not a day', () => {
    expect(getKanbanOverdueDays(due('tomorrow'), TODAY)).toBe(0)
    expect(getKanbanOverdueDays(due(1700000000000), TODAY)).toBe(0)
    expect(getKanbanOverdueDays(makeItem('none', {}), TODAY)).toBe(0)
  })
})

describe('kanban completion judgement', () => {
  it('recognises the done option by id and by the label a foreign document stores', () => {
    expect(isKanbanItemDone(makeItem('a', { status: 'done' }))).toBe(true)
    expect(isKanbanItemDone(makeItem('b', { status: 'Completed' }))).toBe(true)
    expect(isKanbanItemDone(makeItem('c', { status: 'in_progress' }))).toBe(false)
    expect(isKanbanItemDone(makeItem('d', { status: 'todo' }))).toBe(false)
    expect(isKanbanItemDone(makeItem('e', {}))).toBe(false)
  })
})

describe('kanban overdue badge across surfaces', () => {
  it('names a missed deadline in words and keeps its day in the badge title', () => {
    expectOnEverySurface(makeItem('missed', { dueDate: '2026-03-12' }), {
      text: t('preview.kanban_overdue_days', { count: 3 }),
      title: labelFor('2026-03-12'),
      overdue: true,
    })
  })

  it('leaves a deadline that has not passed printing its day', () => {
    expectOnEverySurface(makeItem('upcoming', { dueDate: '2026-03-20' }), {
      text: labelFor('2026-03-20'),
      overdue: false,
    })
  })

  it('does not shout about work that is already done', () => {
    expectOnEverySurface(makeItem('finished', { dueDate: '2026-03-12', status: 'done' }), {
      text: labelFor('2026-03-12'),
      overdue: false,
    })
  })

  it('keeps a start-only card plain however long ago it began', () => {
    expectOnEverySurface(makeItem('late-start', { startDate: '2026-03-01' }), {
      text: labelFor('2026-03-01'),
      overdue: false,
    })
  })

  it('prints nothing for a card without dates', () => {
    expectOnEverySurface(makeItem('no-date', {}), { text: '', overdue: false })
  })
})
