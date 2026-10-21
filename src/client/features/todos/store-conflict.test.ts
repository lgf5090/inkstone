// @vitest-environment jsdom
/**
 * What a 409 means on the screen.
 *
 * Two devices editing one task used to be a race the second save won silently. The write now names the
 * revision it read, and a stale one is refused — this file watches what the store does with that
 * refusal: it reads the row the server really holds, asks which side the reader wants, and never paints
 * the refused edit over it. "Use the server version" adopts the row that was read; "retry my change"
 * sends the same patch again against the revision the server reported, which is a retry and not a merge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import type { TodoTask } from '@shared/todos/model'
import { useTodos } from './store'

const service = vi.hoisted(() => ({
  updates: [] as { id: string, body: Record<string, unknown>, rev?: number }[],
  /** The row the other device left on the server. */
  server: null as TodoTask | null,
  /** The first write is refused, so the conflict branch is the one under test. */
  refuseNext: true,
}))

interface ConfirmOptions {
  title: string
  confirmLabel?: string
  cancelLabel?: string
}

const confirmMock = vi.hoisted(() => vi.fn(async (_options: ConfirmOptions) => false))

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({
        tasks: service.server ? [service.server] : [],
        total: service.server ? 1 : 0,
        counts: EMPTY_COUNTS,
        dayEnd: Date.now() + 3_600_000,
        timezone: 'UTC',
      }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async () => ({ task: service.server, steps: [] }),
      update: async (id: string, body: Record<string, unknown>, rev?: number) => {
        service.updates.push({ id, body, rev })
        if (service.refuseNext) {
          service.refuseNext = false
          throw Object.assign(new Error('The task changed since it was read.'), {
            status: 409,
            code: 'conflict',
            details: { id, rev: service.server?.rev },
          })
        }
        return { task: service.server! }
      },
    },
  },
}))

vi.mock('../../components/overlay', () => ({ confirm: confirmMock }))

const original = useTodos.getState()

/** A row the way the route serialises one. */
function row(id: string, title: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    ...extra,
  }
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.updates.length = 0
  service.refuseNext = true
  service.server = row('t1', 'Changed on the other device', { rev: 5 })
  confirmMock.mockReset()
  confirmMock.mockResolvedValue(false)
  useUi.setState({ toasts: [] })
  useTodos.setState(original, true)
  useTodos.setState({
    status: 'ready',
    tasks: [row('t1', 'Mine', { rev: 3 })],
    completed: [],
    total: 1,
  })
})

describe('a task whose revision went stale', () => {
  it('asks which side wins and adopts the server row instead of the refused edit', async () => {
    const result = await useTodos.getState().updateTask('t1', { title: 'My edit' })

    expect(result).toBeNull()
    // The write named the revision the store read.
    expect(service.updates).toEqual([{ id: 't1', body: { title: 'My edit' }, rev: 3 }])
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const options = confirmMock.mock.calls[0]![0]
    expect(options.title).toBe(t('todo.conflict.title'))
    expect(options.confirmLabel).toBe(t('todo.conflict.retry'))
    expect(options.cancelLabel).toBe(t('todo.conflict.use_server'))

    // "Use the server version" is the cancelling answer, and it leaves the row the server holds.
    const stored = useTodos.getState().tasks.find((task) => task.id === 't1')
    expect(stored?.title).toBe('Changed on the other device')
    expect(stored?.rev).toBe(5)
    // Nothing painted the refused edit, and no generic failure toast was raised over the choice.
    expect(JSON.stringify(useTodos.getState().tasks)).not.toContain('My edit')
    expect(useUi.getState().toasts).toEqual([])
  })

  it('retries the same patch against the revision the server reported', async () => {
    confirmMock.mockResolvedValue(true)

    await useTodos.getState().updateTask('t1', { title: 'My edit' })

    // The retry is the same body under the newer revision: a retry, not a merge of the two edits.
    expect(service.updates).toEqual([
      { id: 't1', body: { title: 'My edit' }, rev: 3 },
      { id: 't1', body: { title: 'My edit' }, rev: 5 },
    ])
    expect(useTodos.getState().tasks.find((task) => task.id === 't1')?.title).toBe('Changed on the other device')
  })
})
