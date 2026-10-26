// @vitest-environment jsdom
/**
 * `/todo/<task id>`: the address that names one task, and what the app does when it is the whole screen.
 *
 * A reminder, a chip in an answer, a link pasted into another tab — each of them arrives as an address
 * naming a task, and the reader is entitled to land on that task's panel rather than on the board with a
 * note that something went wrong. Two things make that non-trivial, and both are asserted here: the row may
 * not be on the page the board loaded (it can be completed, or older than that page), so it is read on its
 * own; and it may not be readable at all — somebody else's id, or one that has been deleted — which is
 * answered by putting the address back to the screen that is really there, not by a panel over nothing.
 *
 * jsdom lays nothing out, so every claim here is about which dialog the app mounted, what the address bar
 * was left holding, and which row the store is showing.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import type { TodoTask } from '@shared/todos/model'

const harness = vi.hoisted(() => ({
  /** The rows the fake service holds: an id that is not here is the 404 the real route answers with. */
  tasks: new Map<string, unknown>(),
  read: [] as string[],
}))

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      // The board's open page holds one task, `on-board`. The deep-linked rows are deliberately not on it.
      list: async () => ({
        tasks: [...harness.tasks.values()].filter((task) => (task as { id: string }).id === 'on-board'),
        total: 1,
        counts: EMPTY_COUNTS,
        dayEnd: Date.now() + 3_600_000,
        timezone: 'UTC',
      }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async (id: string) => {
        harness.read.push(id)
        const task = harness.tasks.get(id)
        if (!task) throw new Error('not found')
        return { task, steps: [] }
      },
    },
  },
}))

import { TodosApp } from './TodosApp'
import { openTaskInTodo } from './open-task'
import { useTodos } from './store'

function task(id: string, title: string, status: string = 'in_progress'): Record<string, unknown> {
  return {
    id,
    title,
    description: '',
    listId: null,
    status,
    priority: 'medium',
    starred: false,
    dueAt: null,
    remindAt: null,
    repeat: null,
    tags: [],
    parentId: null,
    dependsOn: [],
    blocks: [],
    stepTotal: 0,
    stepDone: 0,
    conversationId: null,
    noteId: null,
    createdAt: Date.parse('2026-10-01T08:00:00Z'),
    updatedAt: Date.parse('2026-10-01T08:00:00Z'),
  }
}

const original = useTodos.getState()
let root: Root
let host: HTMLElement

const dialog = () => document.querySelector('[role="dialog"]')
const titleField = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')

/** Open the app cold at an address, the way a pasted link or a pressed reminder does. */
async function mountAt(pathname: string): Promise<void> {
  window.history.replaceState(null, '', pathname)
  await act(async () => { root.render(createElement(TodosApp)) })
  // The panel opens once the row the address names has come back: the load, then the read, then the paint.
  for (let pass = 0; pass < 4; pass += 1) {
    // eslint-disable-next-line no-await-in-loop -- the point is to let each microtask turn settle
    await act(async () => { await Promise.resolve() })
  }
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.tasks.clear()
  harness.tasks.set('on-board', task('on-board', 'Water the plants'))
  harness.tasks.set('task-77', task('task-77', 'Renew the lease'))
  harness.tasks.set('done-77', task('done-77', 'File the return', 'done'))
  harness.read.length = 0
  useTodos.setState({ status: 'idle', tasks: [], completed: [], counts: null, selectedId: null, editorOpen: false, draft: null, view: 'board', listId: null, tagId: null, query: '' })
  useUi.setState({ toasts: [] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/todo')
  useTodos.setState(original, true)
})

describe('opening the app at a task address', () => {
  it('puts the panel for that task up, even though the board never loaded the row', async () => {
    await mountAt('/todo/task-77')

    expect(dialog(), 'the address named a task and the app showed the board').toBeTruthy()
    expect(titleField()?.value, 'the panel is not editing the task the address named').toBe('Renew the lease')
    expect(useTodos.getState().selectedId).toBe('task-77')
    expect(window.location.pathname, 'the panel is open but the address stopped naming the task').toBe('/todo/task-77')
  })

  it('reads a completed task from its own address rather than refusing it', async () => {
    await mountAt('/todo/done-77')

    expect(titleField()?.value).toBe('File the return')
    expect(useTodos.getState().completed.map((entry) => entry.id)).toContain('done-77')
  })

  it('falls back to the board when the address names a task nobody can read', async () => {
    await mountAt('/todo/not-mine')

    expect(dialog(), 'a panel was opened over a row that could not be read').toBeNull()
    expect(window.location.pathname, 'the address kept claiming a screen that is not there').toBe('/todo')
    expect(useTodos.getState().view).toBe('board')
    expect(useTodos.getState().editorOpen).toBe(false)
    // The reader is told, rather than silently moved: the failure is the point of the toast.
    expect(useUi.getState().toasts.map((entry) => entry.title).length, 'nothing said about the task that could not be opened')
      .toBeGreaterThan(0)
  })

  it('leaves the view the address also names standing when the task cannot be read', async () => {
    await mountAt('/todo/not-mine?view=plan')

    expect(window.location.pathname).toBe('/todo')
    expect(window.location.search).toBe('?view=plan')
    expect(useTodos.getState().view, 'the fallback threw away the view the reader had asked for').toBe('plan')
  })
})

describe('asking for a task from somewhere else in the app', () => {
  it('lands on the task address, with the panel open, from another tab', async () => {
    window.history.replaceState(null, '', '/chat')
    useTodos.setState({ status: 'idle', tasks: [], completed: [], counts: null, selectedId: null, editorOpen: false, draft: null })

    await act(async () => { await openTaskInTodo('task-77') })

    expect(window.location.pathname, 'a task was asked for and the bar still names no task').toBe('/todo/task-77')
    expect(useTodos.getState().editorOpen).toBe(true)
    expect(useTodos.getState().draft?.id).toBe('task-77')
  })

  it('asks the server for a row the open page does not hold, once', async () => {
    window.history.replaceState(null, '', '/todo')
    useTodos.setState({ status: 'ready', tasks: [harness.tasks.get('on-board') as unknown as TodoTask], completed: [], editorOpen: false, draft: null, selectedId: null })

    await act(async () => { await openTaskInTodo('task-77') })

    expect(harness.read.filter((id) => id === 'task-77')).toHaveLength(1)
    expect(useTodos.getState().editorOpen).toBe(true)
  })

  it('closes the panel and leaves the view in the address when the reader shuts the task', async () => {
    await mountAt('/todo/task-77?view=plan')
    expect(dialog()).toBeTruthy()

    await act(async () => { useTodos.getState().closeEditor() })

    expect(window.location.pathname).toBe('/todo')
    expect(window.location.search).toBe('?view=plan')
    expect(dialog()).toBeNull()
  })
})
