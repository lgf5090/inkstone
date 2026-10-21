import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { useTodos } from './store'
import { TodosApp } from './TodosApp'

/**
 * The two layouts the container promises.
 *
 * A phone gets the cross-cutting views as a bottom bar and a button that adds a task; a wide window
 * gets a sidebar with every list and no bottom bar. The store is stubbed at the API boundary so the
 * case is about structure rather than about a fetch that never lands.
 */

const state = vi.hoisted(() => ({ today: 0 }))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({
        tasks: [],
        total: 0,
        counts: { inbox: 0, today: state.today, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} },
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
  // The store outlives a render, so a case that expects a fresh load has to hand it back the idle state;
  // without this the first case's counts answer for every case after it.
  useTodos.setState({ status: 'idle', counts: null, tasks: [], completed: [], lists: [], tags: [], view: 'board', listId: null, tagId: null })
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

  it('keeps the sidebar’s own order and words for the four cross-cutting views', async () => {
    stubBreakpoint(true)
    await render()

    // The sidebar calls the board "All" and puts starred above it; the phone calls the board "Board" and
    // leads with it. Those are two different readings of one list of surfaces, so both directions are
    // pinned: a registry that quietly reordered them would look right in one layout and wrong in the other.
    const sidebar = view.container.querySelector(`nav[aria-label="${t('todo.a11y.lists')}"]`)
    const text = sidebar?.textContent ?? ''
    const positions = [t('todo.view.starred'), t('todo.view.plan'), t('todo.smart.all'), t('todo.smart.completed')]
      .map((label) => text.indexOf(label))
    expect(positions.every((index) => index >= 0), 'one of the four views vanished from the sidebar').toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('gives a phone the board first and counts only the plan tab', async () => {
    state.today = 3
    stubBreakpoint(false)
    await render()

    const bar = view.container.querySelector(`nav[aria-label="${t('todo.app.navigation')}"]`)
    const tabs = [...(bar?.querySelectorAll('button') ?? [])]
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
      t('todo.view.board'),
      t('todo.view.starred'),
      t('todo.view.plan'),
      t('todo.view.completed'),
      t('todo.action.ask_assistant'),
    ])
    // Today's work is the only number the phone's bar carries: more badges across the views is noise.
    const badged = tabs.filter((tab) => /\d/.test(tab.textContent ?? ''))
    expect(badged.map((tab) => tab.getAttribute('aria-label'))).toEqual([t('todo.view.plan')])
  })

  it('reaches the calendar from the sidebar and names it in the address', async () => {
    stubBreakpoint(true)
    await render()

    const sidebar = view.container.querySelector(`nav[aria-label="${t('todo.a11y.lists')}"]`)
    const entry = [...(sidebar?.querySelectorAll('button') ?? [])]
      .find((button) => (button.textContent ?? '').includes(t('todo.view.calendar')))
    expect(entry, 'the calendar never reached the sidebar').toBeDefined()

    await act(async () => {
      entry!.click()
      await Promise.resolve()
    })
    await act(async () => { await Promise.resolve() })

    expect(window.location.search).toContain('view=calendar')
    expect(view.container.querySelector('[data-todo-calendar]')).not.toBeNull()
  })

  it('puts the calendar in a phone header rather than a fifth tab', async () => {
    stubBreakpoint(false)
    await render()

    const entry = view.container.querySelector<HTMLButtonElement>('button[data-calendar-entry]')
    expect(entry, 'a phone has no way to reach the calendar').not.toBeNull()
    expect(entry!.getAttribute('aria-label')).toBe(t('todo.view.calendar'))

    await act(async () => {
      entry!.click()
      await Promise.resolve()
    })
    await act(async () => { await Promise.resolve() })

    expect(window.location.search).toContain('view=calendar')
    expect(view.container.querySelector('[data-todo-calendar]')).not.toBeNull()
  })
})
