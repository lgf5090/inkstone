import { ApiError, api } from '../../lib/api'
import { localDb, type OutboxItem } from '../../lib/db'
import { snoozeMinutesOrNull, type TodoTask } from '@shared/todos/model'

export type TodoOutboxOp = 'create' | 'update' | 'delete' | 'plan' | 'snooze' | 'timer-start' | 'timer-stop'

export type TodoOutboxPayload = {
  op: TodoOutboxOp
  task?: Record<string, unknown>
  patch?: Record<string, unknown>
  rev?: number
  date?: string | null
  minutes?: number
  at?: number
}

export type TodoOutboxOutcome =
  | { status: 'done'; retarget?: { from: string; to: string } }
  | { status: 'retry' }
  | { status: 'offline' }

export interface TodoOutboxRuntime {
  tasks: () => TodoTask[]
  timedRowIds: () => string[]
  storeServerTask: (task: TodoTask, options?: { addIfMissing?: boolean; replaceId?: string }) => void
  removeServerTask: (id: string) => void
  advanceTodoDependents: (
    item: OutboxItem,
    payload: TodoOutboxPayload,
    nextRev: number,
    siblings: OutboxItem[],
  ) => Promise<void>
  resolveTodoReplayConflict: (
    item: OutboxItem,
    payload: TodoOutboxPayload,
    siblings: OutboxItem[],
  ) => Promise<'retry' | 'adopted' | 'failed'>
  refreshServerRows: (ids: readonly string[]) => Promise<void>
  cachedDependPartners: (ids: readonly string[]) => string[]
  dependsIds: (value: unknown) => string[]
  paintTimedRow: (id: string, since: number | null) => void
  toastError: (error: unknown) => void
}

export function isTodoOutboxPayload(value: Record<string, unknown>): value is TodoOutboxPayload {
  return value.op === 'create' || value.op === 'update' || value.op === 'delete'
    || value.op === 'plan' || value.op === 'snooze'
    || value.op === 'timer-start' || value.op === 'timer-stop'
}

export function todoQueuedRev(payload: TodoOutboxPayload): number | undefined {
  return typeof payload.rev === 'number' && Number.isSafeInteger(payload.rev) && payload.rev >= 1
    ? payload.rev
    : undefined
}

export async function replayTodoOutboxItem(
  item: OutboxItem,
  siblings: OutboxItem[],
  runtime: TodoOutboxRuntime,
): Promise<TodoOutboxOutcome> {
  const payload = item.payload
  if (!isTodoOutboxPayload(payload)) {
    await localDb.markOutboxFailure(item.id, item.writeId, 'invalid offline task write').catch(() => {})
    return { status: 'retry' }
  }
  const id = item.entityId
  try {
    switch (payload.op) {
      case 'create': {
        const body = payload.task ?? {}
        const { task } = await api.todos.create(body, item.writeId)
        runtime.storeServerTask(task, { addIfMissing: true, replaceId: id })
        await localDb.retargetOutboxEntity('todo', id, task.id).catch(() => {})
        await runtime.refreshServerRows(runtime.cachedDependPartners(runtime.dependsIds(body.dependsOn)))
        return { status: 'done', retarget: { from: id, to: task.id } }
      }
      case 'update': {
        const patch = payload.patch ?? {}
        const partners = 'dependsOn' in patch
          ? [
            ...(runtime.tasks().find((entry) => entry.id === id)?.dependsOn.map((ref) => ref.id) ?? []),
            ...runtime.dependsIds(patch.dependsOn),
          ]
          : []
        const { task, next } = await api.todos.update(id, patch, todoQueuedRev(payload), item.writeId)
        runtime.storeServerTask(task, { addIfMissing: true })
        if (next) runtime.storeServerTask(next, { addIfMissing: true })
        await runtime.advanceTodoDependents(item, payload, task.rev ?? 1, siblings)
        await runtime.refreshServerRows(runtime.cachedDependPartners(partners))
        return { status: 'done' }
      }
      case 'delete': {
        try {
          await api.todos.remove(id)
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error
        }
        runtime.removeServerTask(id)
        return { status: 'done' }
      }
      case 'plan': {
        const { task } = await api.todos.plan(id, payload.date ?? null, todoQueuedRev(payload))
        runtime.storeServerTask(task, { addIfMissing: true })
        await runtime.advanceTodoDependents(item, payload, task.rev ?? 1, siblings)
        return { status: 'done' }
      }
      case 'snooze': {
        const minutes = snoozeMinutesOrNull(payload.minutes)
        if (minutes === null) {
          await localDb.markOutboxFailure(item.id, item.writeId, 'invalid snooze duration').catch(() => {})
          return { status: 'retry' }
        }
        const { task } = await api.todos.snooze(id, minutes, todoQueuedRev(payload))
        runtime.storeServerTask(task, { addIfMissing: true })
        await runtime.advanceTodoDependents(item, payload, task.rev ?? 1, siblings)
        return { status: 'done' }
      }
      case 'timer-start': {
        const { entry } = await api.todos.startTimer(id, payload.at === undefined ? {} : { startAt: payload.at })
        const displaced = runtime.timedRowIds().filter((rowId) => rowId !== entry.taskId)
        runtime.paintTimedRow(entry.taskId, entry.startAt)
        await runtime.refreshServerRows([entry.taskId, ...displaced])
        return { status: 'done' }
      }
      case 'timer-stop': {
        try {
          await api.todos.stopTimer(id, payload.at === undefined ? {} : { endAt: payload.at })
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error
        }
        runtime.paintTimedRow(id, null)
        await runtime.refreshServerRows([id])
        return { status: 'done' }
      }
    }
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.isOffline) return { status: 'offline' }
      if (error.isAuth) {
        location.reload()
        return { status: 'retry' }
      }
      if (error.isConflict) {
        const resolved = await runtime.resolveTodoReplayConflict(item, payload, siblings)
        if (resolved === 'retry') return { status: 'retry' }
        if (resolved === 'adopted') return { status: 'done' }
      }
      if (error.status === 404 && payload.op === 'delete') {
        runtime.removeServerTask(id)
        return { status: 'done' }
      }
      if (error.status === 429) {
        await localDb.markOutboxFailure(item.id, item.writeId, error.message).catch(() => {})
        return { status: 'retry' }
      }
    }
    runtime.toastError(error)
    await localDb.markOutboxFailure(
      item.id,
      item.writeId,
      error instanceof Error ? error.message : String(error),
    ).catch(() => {})
    return { status: 'retry' }
  }
}
