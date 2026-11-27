// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TodoTask } from '@shared/todos/model'
import { initI18n, t } from '../../lib/i18n'
import { useTodos } from './store'

const service = vi.hoisted(() => ({
  updates: [] as { id: string; patch: Record<string, unknown>; rev: number | undefined }[],
  rows: new Map<string, TodoTask>(),
}))

const counts = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({ tasks: [...service.rows.values()], total: service.rows.size, counts, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
      counts: async () => ({ counts, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      update: async (id: string, patch: Record<string, unknown>, rev?: number) => {
        service.updates.push({ id, patch, rev })
        const current = service.rows.get(id)!
        const task = { ...current, ...patch, rev: (current.rev ?? 1) + 1 } as TodoTask
        service.rows.set(id, task)
        return { task }
      },
    },
  },
}))

const confirmMock = vi.hoisted(() => vi.fn(async () => false))
vi.mock('../../components/overlay', () => ({ confirm: confirmMock }))

const original = useTodos.getState()

function row(id: string, parentId: string | null, status: TodoTask['status'] = 'todo'): TodoTask {
  return {
    id, title: id, description: '', status, priority: 'medium', dueAt: null, remindAt: null,
    remindedAt: null, plannedFor: null, completedAt: null, createdAt: 1, updatedAt: 1,
    listId: null, tags: [], parentId, dependsOn: [], blocks: [], starred: false, repeat: null,
    noteId: null, conversationId: null, projectId: null, stepTotal: 0, stepDone: 0, rev: 3,
  }
}

beforeEach(async () => {
  await initI18n()
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
  service.updates.length = 0
  service.rows.clear()
  confirmMock.mockReset().mockResolvedValue(false)
  useTodos.setState(original, true)
})

describe('completing a parent task', () => {
  it('asks before touching children and completes them first when accepted', async () => {
    const parent = row('parent', null)
    const child = row('child', parent.id)
    service.rows.set(parent.id, parent)
    service.rows.set(child.id, child)
    useTodos.setState({ tasks: [parent, child], completed: [], total: 2, status: 'ready' })
    confirmMock.mockResolvedValue(true)

    await useTodos.getState().toggleTask(parent)

    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
      title: t('todo.parent.complete_title'),
      description: t('todo.parent.complete_description', { count: 1 }),
    }))
    expect(service.updates).toEqual([
      { id: child.id, patch: { status: 'done' }, rev: 3 },
      { id: parent.id, patch: { status: 'done' }, rev: 3 },
    ])
  })

  it('completes only the parent when the reader declines the linkage', async () => {
    const parent = row('parent', null)
    const child = row('child', parent.id)
    service.rows.set(parent.id, parent)
    service.rows.set(child.id, child)
    useTodos.setState({ tasks: [parent, child], completed: [], total: 2, status: 'ready' })

    await useTodos.getState().toggleTask(parent)

    expect(service.updates).toEqual([{ id: parent.id, patch: { status: 'done' }, rev: 3 }])
    expect(service.rows.get(child.id)?.status).toBe('todo')
  })
})
