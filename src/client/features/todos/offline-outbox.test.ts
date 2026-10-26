// @vitest-environment jsdom
/**
 * Task writes made with no network.
 *
 * The queue is the note outbox, so the tests go through the same replay entry the note store owns:
 * a queued create is replayed by the shared lease loop, a 409 stops at the same two-answer conflict
 * choice a live write offers, and a delete is queued as a tombstone so an already-gone row is a
 * success rather than a failure that retries forever.
 *
 * The ledger's back-fill door is in scope here as well, because it is the one task write this queue
 * deliberately does *not* carry: the hours a quick-add line says have already gone are refused out
 * loud with no network rather than queued, and the reason is pinned beside the behaviour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TodoTask } from '@shared/todos/model'
import { ApiError } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { useTodos, replayTodoOutboxItem } from './store'

const mocks = vi.hoisted(() => ({
  queue: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  plan: vi.fn(),
  snooze: vi.fn(),
  addTime: vi.fn(),
  startTimer: vi.fn(),
  stopTimer: vi.fn(),
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
        addTime: mocks.addTime,
        startTimer: mocks.startTimer,
        stopTimer: mocks.stopTimer,
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
    parentId: null,
    dependsOn: [],
    blocks: [],
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
    mocks.addTime, mocks.startTimer, mocks.stopTimer, mocks.updateOutboxRevision,
    mocks.markOutboxFailure, confirmMock]) fn.mockReset()
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
    // The key a replay sends is the queued row's own write id, so it is persisted with the row rather
    // than minted afresh each pass: the server has to be able to tell two attempts at one create apart
    // from two creates.
    const writeId = (mocks.queue[0] as { writeId: string }).writeId

    setOnline(true)
    mocks.create.mockResolvedValue({ task: row('server-1', 'Book the room', { rev: 1 }) })
    await useNotes.getState().replayPending()

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Book the room' }), writeId)
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

  it('replays a queued pick against the revision it was made at', async () => {
    useTodos.setState({ tasks: [row('t1', 'Mine', { rev: 3 })], total: 1 })
    await useTodos.getState().planTask('t1', '2026-10-21')
    expect(mocks.queue[0]).toMatchObject({ entity: 'todo', payload: { op: 'plan', date: '2026-10-21', rev: 3 } })

    setOnline(true)
    mocks.plan.mockResolvedValue({ task: row('t1', 'Mine', { rev: 4, plannedFor: '2026-10-21' }) })
    await replayTodoOutboxItem(mocks.queue[0] as never)

    // A pick made offline is still a conditional write: the revision the reader was looking at goes
    // to the route, so a row that moved meanwhile is refused rather than overwritten.
    expect(mocks.plan).toHaveBeenCalledWith('t1', '2026-10-21', 3)
  })

  it('replays a queued snooze against its revision and moves the edits behind it', async () => {
    useTodos.setState({ tasks: [row('t1', 'Mine', { rev: 3 })], total: 1 })
    await useTodos.getState().snoozeTask('t1', 60)
    await useTodos.getState().updateTask('t1', { title: 'Renamed' })
    expect(mocks.queue).toHaveLength(2)

    setOnline(true)
    mocks.snooze
      .mockResolvedValueOnce({ task: row('t1', 'Mine', { rev: 4 }), reminders: [Date.now() + 60_000] })
    mocks.update.mockResolvedValueOnce({ task: row('t1', 'Renamed', { rev: 5 }) })
    await useNotes.getState().replayPending()

    expect(mocks.snooze).toHaveBeenCalledWith('t1', 60, 3)
    // The snooze spent a revision of its own, so the edit queued behind it names the one that landed:
    // left at 3 it would report a conflict this tab created itself.
    expect(mocks.update).toHaveBeenCalledWith('t1', { title: 'Renamed' }, 4)
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

  it('refuses the hours a line back-fills while there is no network, and says so', async () => {
    const task = await useTodos.getState().createTask({ title: 'Write the report', timeLoggedMs: 5 * 60_000 })
    expect(task).not.toBeNull()

    // The row is a queued fact; the hours are not a queued fact on purpose. `POST /api/todos/:id/time`
    // answers by inserting, and it is the one task write with no idempotency door of its own — only
    // `POST /api/todos` reads `Idempotency-Key`. A replay of a back-fill whose response was lost would
    // therefore file the same five minutes twice, and a doubled number in the ledger is exactly the
    // wrong fact the server-side clock guards exist to make impossible.
    expect(mocks.queue).toHaveLength(1)
    expect(mocks.queue[0]).toMatchObject({ entity: 'todo', entityId: task?.id, payload: { op: 'create' } })
    expect((mocks.queue[0] as { payload: { task: Record<string, unknown> } }).payload.task)
      .not.toHaveProperty('timeLoggedMs')
    expect(mocks.addTime, 'a back-fill was asked for against an id the server has never seen')
      .not.toHaveBeenCalled()
    const said = useUi.getState().toasts.map((entry) => entry.title)
    expect(said, 'the hours were dropped without saying where they went')
      .toContain(t('todo.time.logged_offline'))

    // Coming back online does not file them either: the reader was told at the press, and hours that
    // appeared on their own after the replay would contradict the one answer they were given.
    setOnline(true)
    mocks.create.mockResolvedValue({ task: row('server-1', 'Write the report', { rev: 1 }) })
    await useNotes.getState().replayPending()

    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.addTime).not.toHaveBeenCalled()
    expect(mocks.queue).toHaveLength(0)
    expect(useTodos.getState().tasks.map((entry) => entry.id)).toEqual(['server-1'])
  })

  it('files the hours the same line back-fills when there is a network', async () => {
    setOnline(true)
    mocks.create.mockResolvedValue({ task: row('server-1', 'Write the report', { rev: 1 }) })
    mocks.addTime.mockResolvedValue({ entries: [] })
    mocks.get.mockResolvedValue({ task: row('server-1', 'Write the report', { rev: 2, timeSpentMs: 5 * 60_000 }), steps: [] })

    await useTodos.getState().createTask({ title: 'Write the report', timeLoggedMs: 5 * 60_000 })

    // The refusal above is about the door, not about the number: online, the span goes to the ledger in
    // the same press that created the row.
    expect(mocks.addTime).toHaveBeenCalledTimes(1)
    const [id, span] = mocks.addTime.mock.calls[0] as [string, { startAt: number, endAt: number }]
    expect(id).toBe('server-1')
    expect(span.endAt - span.startAt).toBe(5 * 60_000)
    expect(useTodos.getState().tasks[0]).toMatchObject({ timeSpentMs: 5 * 60_000 })
  })

  // The two timer gestures are queueable where the back-fill above is not, and the reason is the shape
  // of each door: starting on the task whose interval is already open answers with that interval, and
  // stopping one that is no longer running is the 404 that says the stop wanted state. Neither can be
  // filed twice by a replay that lost its answer.
  describe('a timer gesture made offline', () => {
    /** The instant the reader pressed, bracketed by the two clock reads around the action. */
    function queuedInstant(item: unknown): number {
      return (item as { payload: { at: number } }).payload.at
    }

    it('queues the press with the instant it happened and puts the indicator up at once', async () => {
      useTodos.setState({ tasks: [row('t1', 'Mine', { status: 'in_progress' })], total: 1 })

      const before = Date.now()
      await useTodos.getState().startTimer(row('t1', 'Mine', { status: 'in_progress' }))
      const after = Date.now()

      expect(mocks.startTimer, 'a gesture with no network reached the route anyway').not.toHaveBeenCalled()
      expect(mocks.queue).toHaveLength(1)
      expect(mocks.queue[0]).toMatchObject({ entity: 'todo', entityId: 't1', payload: { op: 'timer-start' } })
      const at = queuedInstant(mocks.queue[0])
      expect(at).toBeGreaterThanOrEqual(before)
      expect(at).toBeLessThanOrEqual(after)
      // The card counts from the press, not from whenever the device finds a network again.
      expect(useTodos.getState().tasks[0]?.runningSince).toBe(at)
    })

    it('replays the start at the instant it was pressed rather than when the queue drained', async () => {
      useTodos.setState({ tasks: [row('t1', 'Mine', { status: 'in_progress' })], total: 1 })
      await useTodos.getState().startTimer(row('t1', 'Mine', { status: 'in_progress' }))
      const at = queuedInstant(mocks.queue[0])

      setOnline(true)
      mocks.startTimer.mockResolvedValue({ entry: { id: 'e1', taskId: 't1', startAt: at, endAt: null, day: '2026-10-22', source: 'timer' } })
      await useNotes.getState().replayPending()

      // Four hours of work happened at two o'clock. Filing them as a span that opened at six would move
      // them into a different row of the day ledger, which is what the day buckets and the ceiling read.
      expect(mocks.startTimer).toHaveBeenCalledWith('t1', { startAt: at })
      expect(mocks.queue).toHaveLength(0)
    })

    it('queues the stop, takes the indicator down at once, and files the span it was pressed at', async () => {
      useTodos.setState({ tasks: [row('t1', 'Mine', { status: 'in_progress', runningSince: Date.now() - 60_000 })], total: 1 })

      await useTodos.getState().stopTimer('t1')
      expect(mocks.stopTimer).not.toHaveBeenCalled()
      expect(useTodos.getState().tasks[0]?.runningSince, 'the card kept counting a span the reader put down')
        .toBeNull()
      expect(mocks.queue[0]).toMatchObject({ entityId: 't1', payload: { op: 'timer-stop' } })
      const at = queuedInstant(mocks.queue[0])

      setOnline(true)
      mocks.stopTimer.mockResolvedValue({ entries: [{ id: 'e1', taskId: 't1', startAt: at - 60_000, endAt: at }] })
      await replayTodoOutboxItem(mocks.queue[0] as never)

      expect(mocks.stopTimer).toHaveBeenCalledWith('t1', { endAt: at })
    })

    it('treats a stop whose interval is already gone as the state it wanted', async () => {
      useTodos.setState({ tasks: [row('t1', 'Mine', { status: 'in_progress', runningSince: Date.now() - 60_000 })], total: 1 })
      await useTodos.getState().stopTimer('t1')

      setOnline(true)
      // The one way here is a replay of a stop that landed and lost its answer — same tombstone rule a
      // queued delete follows, and for the same reason: retrying it forever would be a failure of ours.
      mocks.stopTimer.mockRejectedValue(new ApiError(404, 'not-found', 'No timer is running for this task.'))
      const outcome = await replayTodoOutboxItem(mocks.queue[0] as never)

      expect(outcome).toEqual({ status: 'done' })
      expect(mocks.markOutboxFailure).not.toHaveBeenCalled()
    })

    it('moves a queued start onto the id the server minted for the row it was pressed on', async () => {
      const mine = await useTodos.getState().createTask({ title: 'Written offline' })
      await useTodos.getState().startTimer(mine!)
      // Three rows: the create, the move to `in_progress` the gesture makes first, and the interval.
      expect(mocks.queue).toHaveLength(3)
      expect(mocks.queue[2]).toMatchObject({ entityId: mine!.id, payload: { op: 'timer-start' } })
      const at = queuedInstant(mocks.queue[2])
      expect(mine!.id.startsWith('local-')).toBe(true)

      setOnline(true)
      mocks.create.mockResolvedValue({ task: row('server-1', 'Written offline') })
      mocks.update.mockResolvedValue({ task: row('server-1', 'Written offline', { status: 'in_progress', rev: 2 }) })
      mocks.startTimer.mockResolvedValue({ entry: { id: 'e1', taskId: 'server-1', startAt: at, endAt: null, day: '2026-10-22', source: 'timer' } })
      mocks.get.mockResolvedValue({ task: row('server-1', 'Written offline', { status: 'in_progress', runningSince: at }), steps: [] })
      await useNotes.getState().replayPending()

      // The create replays first and retargets what came after it, so the interval is filed against a
      // task that exists rather than against an id only this device ever saw.
      expect(mocks.startTimer).toHaveBeenCalledWith('server-1', { startAt: at })
      expect(mocks.queue).toHaveLength(0)
    })
  })
})
