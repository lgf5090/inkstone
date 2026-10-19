import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { TodosApp } from './TodosApp'

/**
 * The two layouts the container promises.
 *
 * A phone gets the cross-cutting views as a bottom bar and a button that adds a task; a wide window
 * gets a sidebar with every list and no bottom bar. The store is stubbed at the API boundary so the
 * case is about structure rather than about a fetch that never lands.
 */

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({
        tasks: [],
        counts: { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} },
        dayEnd: Date.now() + 3_600_000,
        timezone: 'UTC',
      }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async () => ({ task: null, steps: [] }),
    },
  },
}))

let view: RenderedElement

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
})

afterEach(() => {
  view?.unmount()
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  view = renderElement(createElement(TodosApp))
  // The first paint is the loading block; the stubbed page lands one microtask later.
  await act(async () => { await Promise.resolve() })
}

describe('the to-do container', () => {
  it('gives a phone a bottom bar and a button for a new task', async () => {
    stubBreakpoint(false)
    await render()

    expect(view.container.querySelector(`nav[aria-label="${t('todo.app.navigation')}"]`)).not.toBeNull()
    expect(view.container.querySelector(`button[aria-label="${t('todo.action.new_task')}"]`)).not.toBeNull()
    // No sidebar: the list panel is a page of its own on a phone.
    expect(view.container.querySelector(`nav[aria-label="${t('todo.a11y.lists')}"]`)).toBeNull()
  })

  it('gives a wide window a sidebar and no bottom bar', async () => {
    stubBreakpoint(true)
    await render()

    expect(view.container.querySelector(`nav[aria-label="${t('todo.a11y.lists')}"]`)).not.toBeNull()
    expect(view.container.querySelector(`nav[aria-label="${t('todo.app.navigation')}"]`)).toBeNull()
  })

  it('says there is nothing yet instead of drawing an empty board', async () => {
    stubBreakpoint(false)
    await render()
    expect(view.container.textContent).toContain(t('todo.empty.board'))
  })
})
