// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({ list: vi.fn(), batch: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { todos: service } }))

import { OverdueShift } from './OverdueShift'
import { useTodos } from './store'

const original = useTodos.getState()
let view: RenderedElement | null = null

function task(index: number): TodoTask {
  return {
    id: `task-${index}`,
    title: `Overdue ${index}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: 1,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    parentId: null,
    dependsOn: [],
    blocks: [],
    tags: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
  }
}

beforeEach(async () => {
  await initI18n()
  service.list.mockReset()
  service.batch.mockReset()
  service.list.mockImplementation(async ({ offset = 0 }: { offset?: number }) => ({
    tasks: Array.from({ length: Math.min(500, 1200 - offset) }, (_, index) => task(offset + index)),
    total: 1200,
  }))
  service.batch.mockImplementation(async ({ ids }: { ids: string[] }) => ({
    done: ids.map((id) => ({ id, next: null })),
    failed: [],
  }))
  useTodos.setState({
    ...original,
    counts: { inbox: 0, today: 0, upcoming: 0, overdue: 1200, all: 1200, completed: 0, starred: 0, byList: {}, byTag: {} },
    load: vi.fn(async () => undefined),
  })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  useTodos.setState(original, true)
})

describe('overdue shift', () => {
  it('walks every page and batches all 1200 rows', async () => {
    view = renderElement(createElement(OverdueShift, { className: '' }))
    const button = view.container.querySelector('button')!
    await act(async () => { button.click(); await Promise.resolve() })
    await vi.waitFor(() => expect(service.batch).toHaveBeenCalledTimes(12))

    expect(service.list.mock.calls.map(([params]) => params.offset)).toEqual([0, 500, 1000])
    expect(service.batch.mock.calls.flatMap(([body]) => body.ids)).toHaveLength(1200)
  })
})
