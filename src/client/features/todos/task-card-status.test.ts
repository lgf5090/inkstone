// @vitest-environment jsdom
/**
 * The status a card shows, and the one it can be moved to.
 *
 * `status` has three values, but until now only the checkbox could move a task between two of them:
 * "in progress" existed in the model and nowhere on screen. The card is where a reader decides to start
 * something, so the assertion here is made at the API boundary — the menu has to reach the same update
 * route every other card action uses, with the status the reader picked.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
}))

vi.mock('../../lib/api', () => {
  const counts = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }
  const row = (id: string, status: string): TodoTask => ({
    id,
    title: id,
    description: '',
    status: status as TodoTask['status'],
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat: null,
    remindedAt: null,
    plannedFor: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
  })
  return {
    api: {
      todos: {
        update: async (id: string, patch: Record<string, unknown>) => {
          service.updates.push({ id, patch })
          return { task: row(id, String(patch.status ?? 'todo')), next: null }
        },
        // The store re-reads the counts after a write; an empty page is enough for this case.
        list: async () => ({
          tasks: [],
          total: 0,
          counts,
          dayEnd: Date.now() + 3_600_000,
          timezone: 'UTC',
        }),
      },
    },
  }
})

import { TaskCard, openTaskSiblings } from './TaskCard'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

function task(id: string, status: TodoTask['status'], title: string): TodoTask {
  return {
    id,
    title,
    description: '',
    status,
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat: null,
    remindedAt: null,
    plannedFor: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.updates.length = 0
  useTodos.setState(original, true)
  useTodos.setState({ lists: [], timezone: 'UTC', dayEnd: NOW + DAY, selectedIds: new Set<string>() })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  vi.unstubAllGlobals()
})

function renderCard(row: TodoTask): void {
  view = renderElement(createElement(TaskCard, {
    task: row,
    lists: [],
    bounds: { dayEnd: NOW + DAY, now: NOW },
    timezone: 'UTC',
    onOpen: () => {},
    onStar: () => {},
  }))
}

function menuTrigger(row: TodoTask): HTMLButtonElement {
  const trigger = view!.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('todo.task.actions')}: ${row.title}"]`,
  )
  if (!trigger) throw new Error('the card offers no menu')
  return trigger
}

/** Open the row's menu and press one of its actions, the way a reader does. */
async function choose(row: TodoTask, label: string): Promise<void> {
  const trigger = menuTrigger(row)
  await act(async () => {
    trigger.click()
    await Promise.resolve()
  })
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((node) => (node.textContent ?? '').trim() === label)
  if (!item) throw new Error(`the menu has no row named “${label}”`)
  await act(async () => {
    item.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('the status in a card menu', () => {
  it('shows an in-progress task in words, not only in colour', () => {
    renderCard(task('a', 'in_progress', 'Write the report'))
    const article = view!.container.querySelector('article')
    expect(article, 'the card did not render').not.toBeNull()
    expect(article!.textContent).toContain(t('todo.status.in_progress'))
  })

  it('sends the in-progress status to the same update route every other write uses', async () => {
    const row = task('a', 'todo', 'Write the report')
    renderCard(row)

    await choose(row, t('todo.status.mark_in_progress'))

    expect(service.updates).toEqual([{ id: 'a', patch: { status: 'in_progress' } }])
  })

  it('offers the way back out of in progress', async () => {
    const row = task('a', 'in_progress', 'Write the report')
    renderCard(row)

    await choose(row, t('todo.status.mark_todo'))

    expect(service.updates).toEqual([{ id: 'a', patch: { status: 'todo' } }])
  })

  it('gives the menu a finger-sized target', () => {
    renderCard(task('a', 'todo', 'Write the report'))
    expect(menuTrigger(task('a', 'todo', 'Write the report')).className).toContain('size-11')
  })
})

describe('the tick a started row wears', () => {
  /** The completion control: the row's only `role="checkbox"` outside the batch-selection mode. */
  function checkbox(row: TodoTask): HTMLButtonElement {
    const node = view!.container.querySelector<HTMLButtonElement>('button[role="checkbox"]')
    expect(node, `the card for ${row.title} rendered no completion control`).not.toBeNull()
    return node!
  }

  it('leaves a started row unticked and asks for it to be finished', () => {
    // The row the reader is in the middle of is the row that is still owed: the tick stays empty and
    // the control's own name offers to complete it, not to reopen it.
    const row = task('a', 'in_progress', 'Write the report')
    renderCard(row)

    expect(checkbox(row).getAttribute('aria-checked')).toBe('false')
    expect(checkbox(row).getAttribute('aria-label')).toBe(t('todo.a11y.mark_done', { title: row.title }))
  })

  it('ticks only the row that was actually finished', () => {
    const row = task('a', 'done', 'Write the report')
    renderCard(row)

    expect(checkbox(row).getAttribute('aria-checked')).toBe('true')
    expect(checkbox(row).getAttribute('aria-label')).toBe(t('todo.a11y.mark_open', { title: row.title }))
  })
})

describe('the three readings a card makes of one status', () => {
  function checkbox(): HTMLButtonElement | null {
    return view!.container.querySelector<HTMLButtonElement>('button[role="checkbox"]')
  }

  function title(row: TodoTask): HTMLElement | null {
    return view!.container.querySelector<HTMLElement>(`button[data-todo-open="${row.id}"]`)
  }

  /** Whether the card still treats this row as work: the reminders it offers and the stopwatch it shows. */
  function owedAffordances(row: TodoTask): { kebab: boolean, timer: boolean } {
    return {
      kebab: view!.container.querySelector(`button[aria-label="${t('todo.task.actions')}: ${row.title}"]`) !== null,
      timer: view!.container.querySelector(`button[data-todo-timer="${row.id}"]`) !== null,
    }
  }

  it('draws a started row as work the reader still owes', () => {
    // The card asks "is this owed" in four places at once — the tick, the struck-through title, the
    // stopwatch and the reminder rows — and each has to answer yes for the row in the middle of it.
    const row = task('a', 'in_progress', 'Write the report')
    renderCard(row)

    expect(checkbox()?.getAttribute('aria-checked')).toBe('false')
    expect(title(row)!.className).not.toContain('line-through')
    expect(owedAffordances(row)).toEqual({ kebab: true, timer: true })
  })

  it('draws a finished row as work that is off the plate', () => {
    const row = task('a', 'done', 'Write the report')
    renderCard(row)

    expect(checkbox()?.getAttribute('aria-checked')).toBe('true')
    expect(title(row)!.className).toContain('line-through')
    expect(owedAffordances(row)).toEqual({ kebab: false, timer: false })
  })

  it('draws a row that is neither finished nor owed as neither', () => {
    // A `cancelled` row read off the future enum, one press before the app can offer it. The card must
    // not answer it with the unchecked box of open work — that reading invites a press that marks the
    // abandoned row finished — nor with the tick of a row the reader completed.
    const row = task('a', 'cancelled' as TodoTask['status'], 'Learn Esperanto')
    renderCard(row)

    expect(checkbox()?.getAttribute('aria-checked')).toBe('mixed')
    expect(checkbox()!.querySelector('svg'), 'an abandoned row wears no completion tick').toBeNull()
    // The name describes what a press really writes — `toggledStatus` reopens an abandoned row to
    // `todo` — so the control is named "reopen", not "mark done".
    expect(checkbox()?.getAttribute('aria-label')).toBe(t('todo.a11y.mark_open', { title: 'Learn Esperanto' }))
    expect(title(row)!.className).not.toContain('line-through')
    expect(owedAffordances(row)).toEqual({ kebab: false, timer: false })
  })

  it('orders the rows still owed, a started one among them', () => {
    const rows = [task('a', 'todo', 'A'), task('b', 'in_progress', 'B'), task('c', 'done', 'C')]
    expect(openTaskSiblings(rows, rows[0]!).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(openTaskSiblings(rows, rows[2]!)).toEqual([])
  })

  it('gives a row that is neither finished nor owed no place in the manual order', () => {
    const rows = [task('a', 'todo', 'A'), task('b', 'in_progress', 'B'), task('c', 'done', 'C')]
    const abandoned = task('d', 'cancelled' as TodoTask['status'], 'D')
    const shelf = [...rows, abandoned]
    // Neither the row the order is walked from, nor one of the neighbours it names.
    expect(openTaskSiblings(shelf, abandoned)).toEqual([])
    expect(openTaskSiblings(shelf, rows[0]!).map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})
