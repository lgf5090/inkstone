// @vitest-environment jsdom
/**
 * The history section of the task panel.
 *
 * It is folded away until it is asked for, and the read happens on that press rather than with the
 * task: a panel opened to change a title should not fetch a table nobody asked to see. The three
 * states a reader can meet are pinned here — rows, nothing recorded, and a read that failed — because
 * a section that silently renders nothing is indistinguishable from a task with no history.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskEvent } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  calls: 0,
  events: [] as TaskEvent[],
  failure: null as Error | null,
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      events: async () => {
        service.calls += 1
        if (service.failure) throw service.failure
        return { events: service.events }
      },
    },
  },
}))

import { TaskHistory } from './TaskHistory'

let view: RenderedElement | null = null

beforeEach(async () => {
  await initI18n()
  service.calls = 0
  service.events = []
  service.failure = null
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

function toggle(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => (node.textContent ?? '').trim() === t('todo.history.title'))
  if (!button) throw new Error('the panel offers no history toggle')
  return button
}

describe('a task’s history', () => {
  it('stays folded and unread until it is opened', async () => {
    service.events = [{ id: 'e1', kind: 'born', fromStatus: null, toStatus: 'todo', at: 0 }]
    view = renderElement(createElement(TaskHistory, { taskId: 't1' }))

    const button = toggle(view.container)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(service.calls, 'the panel read a table nobody asked for').toBe(0)

    await act(async () => { button.click(); await Promise.resolve() })
    await settle()

    expect(service.calls).toBe(1)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(view.container.textContent).toContain(t('todo.history.born'))
  })

  it('reads each move as the two statuses it went between', async () => {
    service.events = [
      { id: 'e2', kind: 'status', fromStatus: 'done', toStatus: 'todo', at: 2_000 },
      { id: 'e1', kind: 'born', fromStatus: null, toStatus: 'todo', at: 1_000 },
    ]
    view = renderElement(createElement(TaskHistory, { taskId: 't1' }))
    await act(async () => { toggle(view!.container).click(); await Promise.resolve() })
    await settle()

    const rows = [...view.container.querySelectorAll('li')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain(t('todo.history.moved', {
      from: t('todo.status.done'),
      to: t('todo.status.todo'),
    }))
    expect(rows[1]!.textContent).toContain(t('todo.history.born'))
    // Every row names its instant, so a reader can put it against the task's own dates.
    expect(rows[0]!.querySelector('time')?.getAttribute('datetime')).toBe(new Date(2_000).toISOString())
  })

  it('says a read failed rather than drawing an empty history', async () => {
    service.failure = new Error('The connection went away')
    view = renderElement(createElement(TaskHistory, { taskId: 't1' }))
    await act(async () => { toggle(view!.container).click(); await Promise.resolve() })
    await settle()

    const alert = view.container.querySelector('[role="alert"]')
    expect(alert, 'a failed read was drawn as "nothing recorded"').not.toBeNull()
    expect(alert!.textContent).toContain(t('todo.history.error'))
    expect(alert!.textContent).toContain('The connection went away')
    expect(view.container.textContent).not.toContain(t('todo.history.empty'))
  })
})
