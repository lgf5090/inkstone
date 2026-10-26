// @vitest-environment jsdom
/**
 * A read that failed is not a collection that is empty.
 *
 * The store answers a broken listing read with `status: 'error'` and the server's own message, and the
 * frame above the views only holds the *loading* case back — so every reading surface fell into its
 * empty branch and told the reader the list holds nothing when the truth is that nothing arrived. Seven
 * surfaces said it (board, plan, starred, upcoming, completed, list, tag), and none of them offered the
 * one thing that would have helped: ask again.
 *
 * The cases below drive the failure through the views that render it rather than through the branch,
 * because the finding is about which of the three states a reader is told. The assertion is which
 * control is on the page and which sentence is not, and that the retry really re-asks the route.
 */
import { act, createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'
import type { MessageKey } from '@shared/locales/en-US'
import type { TaskListEntry } from '../../lib/api'

const service = vi.hoisted(() => ({ reads: 0, fail: true }))

vi.mock('../../lib/api', () => {
  const counts = (): TaskCounts => ({
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {},
  })
  const list = (id: string, name: string): TaskListEntry => ({
    id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0,
    openCount: 0, doneCount: 0, archivedAt: null, parentId: null,
  })
  return {
    ApiError: class extends Error {
      constructor(readonly status = 500) { super('the server refused to answer') }
    },
    CLIENT_ID: 'test-client',
    api: {
      todos: {
        list: async () => {
          service.reads += 1
          // The failure the store reports: a read that threw, not a read that came back with nothing.
          if (service.fail) throw new Error('the server refused to answer')
          return { tasks: [], total: 0, counts: counts(), dayEnd: Date.parse('2026-10-20T00:00:00Z'), timezone: 'UTC' }
        },
        lists: async () => ({ lists: [list('L1', 'Work')] }),
        tags: async () => ({ tags: [] }),
      },
    },
  }
})

import {
  CompletedView,
  ListTaskView,
  PlanView,
  StarredView,
  UpcomingView,
} from './TaskViews'
import { BoardView } from './BoardView'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-19T09:00:00Z')
const MESSAGE = 'the server refused to answer'

const original = useTodos.getState()
let view: RenderedElement | null = null

function mount(node: ReactNode): HTMLElement {
  view = renderElement(node)
  return view.container
}

/** The button the reader presses when the page has told them the read broke. */
function retryButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => (node.textContent ?? '').trim() === t('common.retry'))
}

function bodyText(container: HTMLElement): string {
  return container.textContent ?? ''
}

async function press(node: HTMLButtonElement): Promise<void> {
  await act(async () => {
    node.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

/** The rows the empty branch would have printed for this surface, in the words it prints them in. */
const SURFACES: Array<{ name: string; emptyKey: MessageKey; render: () => ReactNode }> = [
  { name: 'plan', emptyKey: 'todo.empty.plan', render: () => createElement(PlanView) },
  { name: 'starred', emptyKey: 'todo.empty.starred', render: () => createElement(StarredView) },
  { name: 'upcoming', emptyKey: 'todo.empty.upcoming', render: () => createElement(UpcomingView) },
  { name: 'completed', emptyKey: 'todo.empty.completed', render: () => createElement(CompletedView) },
  { name: 'list', emptyKey: 'todo.empty.list', render: () => createElement(ListTaskView) },
]

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.reads = 0
  service.fail = true
  useTodos.setState(original, true)
  useTodos.setState({
    status: 'error',
    error: MESSAGE,
    tasks: [] as TodoTask[],
    completed: [] as TodoTask[],
    lists: [],
    tags: [],
    counts: null,
    selectedIds: new Set<string>(),
    query: '',
    dueFrom: null,
    dueTo: null,
    completedFrom: null,
    completedTo: null,
    view: 'plan',
    listId: 'L1',
    tagId: null,
    sort: null,
    dayEnd: NOW + 86_400_000,
    timezone: 'UTC',
  })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

describe('a listing that could not be read', () => {
  for (const surface of SURFACES) {
    it(`${surface.name} says the read failed instead of the collection being empty`, () => {
      const container = mount(surface.render())
      expect(retryButton(container), `${surface.name} offers no retry`).toBeTruthy()
      expect(bodyText(container)).toContain(MESSAGE)
      expect(bodyText(container)).not.toContain(t(surface.emptyKey))
    })
  }

  it('names the failure to assistive technology as an alert', () => {
    const container = mount(createElement(PlanView))
    const alert = container.querySelector('[role="alert"]')
    expect(alert, 'the failure is not announced').not.toBeNull()
    expect(alert?.textContent).toBe(MESSAGE)
  })

  it('asks the route again when the reader presses retry', async () => {
    const container = mount(createElement(PlanView))
    expect(service.reads).toBe(0)
    await press(retryButton(container)!)
    expect(service.reads).toBe(1)
  })

  it('leaves the empty copy alone once the read answers again', async () => {
    const container = mount(createElement(PlanView))
    service.fail = false
    await press(retryButton(container)!)
    expect(bodyText(container)).toContain(t('todo.empty.plan'))
    expect(bodyText(container)).not.toContain(MESSAGE)
    expect(retryButton(container)).toBeUndefined()
  })

  it('says it for the board too, where every card would have said it', () => {
    const container = mount(createElement(BoardView, { onOpenList: () => {} }))
    expect(retryButton(container), 'the board offers no retry').toBeTruthy()
    expect(bodyText(container)).toContain(MESSAGE)
    expect(bodyText(container)).not.toContain(t('todo.empty.list'))
    expect(container.querySelectorAll('[role="list"]').length, 'the board still drew its cards').toBe(0)
  })

  it('keeps drawing the board when the read is fine', () => {
    useTodos.setState({ status: 'ready', error: null })
    const container = mount(createElement(BoardView, { onOpenList: () => {} }))
    expect(retryButton(container)).toBeUndefined()
    expect(container.querySelector('[role="list"][aria-label]')).not.toBeNull()
  })
})
