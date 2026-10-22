// @vitest-environment jsdom
/**
 * Task writes made with no network.
 *
 * The queue is the note outbox, so the tests go through the same replay entry the note store owns:
 * a queued create is replayed by the shared lease loop, a 409 stops at the same two-answer conflict
 * choice a live write offers, and a delete is queued as a tombstone so an already-gone row is a
 * success rather than a failure that retries forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TodoTask } from '@shared/todos/model'
import { ApiError } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useTodos, replayTodoOutboxItem } from './store'

const mocks = vi.hoisted(() => ({
  queue: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  plan: vi.fn(),
  snooze: vi.fn(),
  updateOutboxRevision: vi.fn(async () => {}),
  markOutboxFailure: vi.fn(async () => {}),
}))

vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>()
  const normalize = actual.normalizeOutboxItem
  return {
    ...actual,
    publishBroadcast: vi.fn(),
    localDb: {
      scheduleShellSave: vi.fn(),
      setContent: vi.fn(async () => {}),
      setContentBatch: vi.fn(async () => {}),
      dropContent: vi.fn(async () => {}),
      getOutbox: async () => mocks.queue.map(normalize).filter((item) => item !== null),
      enqueueOutbox: async (item: unknown) => {
        mocks.queue = [...mocks.queue.filter((entry) => (entry as { id?: string }).id !== (item as { id: string }).id), item]
      },
      enqueueOutboxBatch: async (items: unknown[]) => {
        for (const item of items)
          mocks.queue = [...mocks.queue.filter((entry) => (entry as { id?: string }).id !== (item as { id: string }).id), item]
      },
      completeOutboxItem: async (id: string, writeId: string) => {
        mocks.queue = mocks.queue.filter((entry) => {
          const item = normalize(entry)
          return !item || item.id !== id || item.writeId !== writeId
        })
      },
      retargetOutboxEntity: async (_entity: string, fromId: string, toId: string) => {
        mocks.queue = mocks.queue.map((entry) => {
          const item = normalize(entry)
          return item && item.entityId === fromId ? { ...item, entityId: toId } : entry
        })
      },
      advanceOutboxDependents: vi.fn(async () => {}),
      advanceOutboxEntityRevisions: async (_entity: string, entityId: string, nextRev: number) => {
        mocks.queue = mocks.queue.map((entry) => {
          const item = normalize(entry)
          return item && item.entityId === entityId && typeof item.payload.rev === 'number' && item.payload.rev < nextRev
            ? { ...item, payload: { ...item.payload, rev: nextRev } }
            : entry
        })
      },
      updateOutboxRevision: mocks.updateOutboxRevision,
      setOutboxRecoveryId: vi.fn(async () => {}),
      markOutboxFailure: mocks.markOutboxFailure,
      withOutboxReplayLock: async (_owner: string, task: () => Promise<void>) => {
        await task()
        return true
      },
    },
  }
})

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<{ api: Record<string, any>, ApiError: typeof ApiError }>('../../lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      notes: { get: vi.fn(), patch: vi.fn(), create: vi.fn(), linkMention: vi.fn() },
      todos: {
        list: async () => ({ tasks: [], total: 0, counts: null, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
        lists: async () => ({ lists: [] }),
        tags: async () => ({ tags: [] }),
        create: mocks.create,
        update: mocks.update,
        get: mocks.get,
        remove: mocks.remove,
        plan: mocks.plan,
        snooze: mocks.snooze,
      },
    },
  }
})

const confirmMock = vi.hoisted(() => vi.fn(async (_options: {
  title: string
  confirmLabel?: string
  cancelLabel?: string
}) => false))
vi.mock('../../components/overlay', () => ({ confirm: confirmMock }))

const original = useTodos.getState()
let online = false

function setOnline(value: boolean): void {
  online = value
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

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
    createdAt: 1,
    updatedAt: 1,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    rev: 1,
    ...extra,
  }
}

function conflict(id: string, rev: number): ApiError {
  return new ApiError(409, 'conflict', 'The task changed since it was read.', { id, rev })
}

beforeEach(async () => {
  await initI18n()
  mocks.queue = []
  for (const fn of [mocks.create, mocks.update, mocks.get, mocks.remove, mocks.plan, mocks.snooze,
    mocks.updateOutboxRevision, mocks.markOutboxFailure, confirmMock]) fn.mockReset()
  confirmMock.mockResolvedValue(false)
  setOnline(false)
  useTodos.setState(original, true)
  useTodos.setState({ status: 'ready', tasks: [], completed: [], total: 0, completedTotal: 0 })
  useNotes.setState({ notes: {}, contents: {}, folders: [], tags: [], cursor: 0, pendingCount: 0, online: false })
})

describe('a task write made offline', () => {
  it('is queued, shown at once, and replayed into the server list on the shared outbox', async () => {
    const task = await useTodos.getState().createTask({ title: 'Book the room', listId: null })
    expect(task?.id.startsWith('local-')).toBe(true)
    expect(useTodos.getState().tasks.map((entry) => entry.title)).toEqual(['Book the room'])
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.queue).toHaveLength(1)
    expect(mocks.queue[0]).toMatchObject({ entity: 'todo', entityId: task?.id, payload: { op: 'create' } })

    setOnline(true)
    mocks.create.mockResolvedValue({ task: row('server-1', 'Book the room', { rev: 1 }) })
    await useNotes.getState().replayPending()

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Book the room' }))
    expect(useTodos.getState().tasks.map((entry) => entry.id)).toEqual(['server-1'])
    expect(mocks.queue).toHaveLength(0)
  })

  it('moves a queued follow-up edit onto the id the server minted', async () => {
    const created = await useTodos.getState().createTask({ title: 'Draft', listId: null })
    await useTodos.getState().updateTask(created!.id, { title: 'Draft, edited' })
    expect(mocks.queue).toHaveLength(2)

    setOnline(true)
    mocks.create.mockResolvedValue({ task: row('server-1', 'Draft', { rev: 1 }) })
    mocks.update.mockResolvedValue({ task: row('server-1', 'Draft, edited', { rev: 2 }) })
    await useNotes.getState().replayPending()

    expect(mocks.update).toHaveBeenCalledWith('server-1', { title: 'Draft, edited' }, undefined)
    expect(useTodos.getState().tasks[0]).toMatchObject({ id: 'server-1', title: 'Draft, edited' })
    expect(mocks.queue).toHaveLength(0)
  })

  it('moves the later queued edits onto the revision the first one landed at', async () => {
    useTodos.setState({ tasks: [row('t1', 'Mine', { rev: 3 })], total: 1 })
    await useTodos.getState().updateTask('t1', { title: 'First edit' })
    await useTodos.getState().updateTask('t1', { priority: 'high' })
    const [first, second] = mocks.queue as { payload: { rev?: number } }[]
    expect(first!.payload.rev).toBe(3)
    expect(second!.payload.rev).toBe(3)

    setOnline(true)
    mocks.update
      .mockResolvedValueOnce({ task: row('t1', 'First edit', { rev: 4 }) })
      .mockResolvedValueOnce({ task: row('t1', 'First edit', { rev: 5, priority: 'high' }) })
    await useNotes.getState().replayPending()

    expect(mocks.update).toHaveBeenNthCalledWith(1, 't1', { title: 'First edit' }, 3)
    expect(mocks.update).toHaveBeenNthCalledWith(2, 't1', { priority: 'high' }, 4)
    expect(mocks.queue).toHaveLength(0)
  })

  it('asks which side wins when the replay is refused, without painting over the local row', async () => {
    useTodos.setState({ tasks: [row('t1', 'Mine', { rev: 3 })], total: 1 })
    await useTodos.getState().updateTask('t1', { title: 'Mine, edited' })
    const item = mocks.queue[0]
    expect(item).toMatchObject({ entity: 'todo', payload: { op: 'update', rev: 3 } })

    setOnline(true)
    mocks.update.mockRejectedValueOnce(conflict('t1', 5))
    mocks.get.mockResolvedValue({ task: row('t1', 'Changed elsewhere', { rev: 5 }), steps: [] })
    let answer!: (value: boolean) => void
    confirmMock.mockReturnValue(new Promise<boolean>((resolve) => { answer = resolve }))

    const replay = replayTodoOutboxItem(item as never)
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1))
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({
      title: t('todo.conflict.title'),
      confirmLabel: t('todo.conflict.retry'),
      cancelLabel: t('todo.conflict.use_server'),
    })
    // Until the reader answers, the row on screen is the one this tab painted, not the server's.
    expect(useTodos.getState().tasks.find((entry) => entry.id === 't1')?.title).toBe('Mine, edited')

    answer(false)
    await replay
    expect(useTodos.getState().tasks.find((entry) => entry.id === 't1')?.title).toBe('Changed elsewhere')
  })

  it('keeps the queued edit against the revision the server reported when the reader retries', async () => {
    useTodos.setState({ tasks: [row('t1', 'Mine', { rev: 3 })], total: 1 })
    await useTodos.getState().updateTask('t1', { title: 'Mine, edited' })
    const item = mocks.queue[0]

    setOnline(true)
    mocks.update.mockRejectedValueOnce(conflict('t1', 5))
    mocks.get.mockResolvedValue({ task: row('t1', 'Changed elsewhere', { rev: 5 }), steps: [] })
    confirmMock.mockResolvedValue(true)

    await replayTodoOutboxItem(item as never)

    expect(mocks.updateOutboxRevision).toHaveBeenCalledWith((item as any).id, (item as any).writeId, 5)
    expect((item as any).payload.rev).toBe(5)
  })

  it('queues a delete as a tombstone and treats an already-gone row as done', async () => {
    useTodos.setState({ tasks: [row('t1', 'Throw away', { rev: 4 })], total: 1 })
    await useTodos.getState().removeTask('t1')
    expect(useTodos.getState().tasks).toEqual([])
    const item = mocks.queue[0]
    expect(item).toMatchObject({ entity: 'todo', entityId: 't1', payload: { op: 'delete', rev: 4 } })

    setOnline(true)
    mocks.remove.mockRejectedValue(new ApiError(404, 'not_found', 'Task not found'))
    const outcome = await replayTodoOutboxItem(item as never)

    expect(mocks.remove).toHaveBeenCalledWith('t1')
    expect(outcome).toEqual({ status: 'done' })
  })
})
