/**
 * The Eisenhower matrix: the open plate in four cells cut by importance and urgency.
 *
 * The matrix reads the same listing every other aggregate screen reads, so the filter bar, the search
 * line and the current list all narrow it the same way. A drop writes the two answers the cell stands
 * for; the row's own menu offers the same move for a keyboard or a phone, which cannot drag.
 */
import { useCallback, useMemo, useState } from 'react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { useMediaQuery } from '../../lib/hooks'
import { useTodos } from './store'
import type { TaskList, TodoTask } from '@shared/todos/model'
import { isTaskOpen } from '@shared/todos/status'
import {
  MATRIX_QUADRANTS,
  matrixAxesOf,
  matrixQuadrant,
  quadrantCell,
  type MatrixQuadrant,
} from '@shared/todos/matrix'
import type { MessageKey } from '@shared/locales/en-US'
import { ListingFailure } from './TaskViews'
import {
  FINE_POINTER_QUERY,
  TaskRow,
  isTodoTaskDrag,
  moveTodoTask,
  readTodoTaskDropIds,
  useListingBounds,
  useTaskRowActions,
} from './TaskCard'
import type { TaskQuadrantControls } from './task-menu'

const QUADRANT_LABELS: Record<MatrixQuadrant, MessageKey> = {
  do: 'todo.matrix.quadrant.do',
  schedule: 'todo.matrix.quadrant.schedule',
  delegate: 'todo.matrix.quadrant.delegate',
  drop: 'todo.matrix.quadrant.drop',
}

const QUADRANT_HINTS: Record<MatrixQuadrant, MessageKey> = {
  do: 'todo.matrix.hint.do',
  schedule: 'todo.matrix.hint.schedule',
  delegate: 'todo.matrix.hint.delegate',
  drop: 'todo.matrix.hint.drop',
}

const QUADRANT_TONE: Record<MatrixQuadrant, string> = {
  do: 'border-l-4 border-l-[var(--danger)]',
  schedule: 'border-l-4 border-l-[var(--accent)]',
  delegate: 'border-l-4 border-l-[var(--warning)]',
  drop: 'border-l-4 border-l-[var(--border-subtle)]',
}

export function MatrixView() {
  const tasks = useTodos((state) => state.tasks)
  const lists = useTodos((state) => state.lists)
  const timezone = useTodos((state) => state.timezone)
  const dayEnd = useTodos((state) => state.dayEnd)
  const status = useTodos((state) => state.status)
  const error = useTodos((state) => state.error)
  const reload = useTodos((state) => state.load)
  const updateTask = useTodos((state) => state.updateTask)
  const reportUndo = useTodos((state) => state.reportUndo)
  const bounds = useListingBounds(dayEnd)
  const finePointer = useMediaQuery(FINE_POINTER_QUERY)
  const now = bounds.now

  /**
   * Write one cell, and offer the two flags it replaced as one step back. The answers are written
   * together because a quadrant is one of four pairs; leaving one axis derived while the other is
   * frozen would draw a cell the reader never chose.
   */
  const moveToCell = useCallback((ids: readonly string[], important: boolean, urgent: boolean): void => {
    const carried = ids
      .map((id) => useTodos.getState().tasks.find((entry) => entry.id === id))
      .filter((entry): entry is TodoTask => entry !== undefined)
    if (carried.length === 0) return
    const changed = carried.filter((task) => {
      const axes = matrixAxesOf(task, Date.now())
      return axes.important !== important || axes.urgent !== urgent
    })
    if (changed.length === 0) return
    const previous = changed.map((task) => ({ id: task.id, important: task.important ?? null, urgent: task.urgent ?? null }))
    for (const task of changed) void updateTask(task.id, { important, urgent })
    reportUndo(t('todo.matrix.moved', { count: changed.length }), async () => {
      for (const entry of previous) await updateTask(entry.id, { important: entry.important, urgent: entry.urgent })
    })
  }, [reportUndo, updateTask])

  const quadrantFor = useCallback((task: TodoTask): TaskQuadrantControls => {
    const axes = matrixAxesOf(task, Date.now())
    return {
      important: axes.important,
      urgent: axes.urgent,
      automatic: (task.important ?? null) === null && (task.urgent ?? null) === null,
      move: (important, urgent) => moveToCell([task.id], important, urgent),
      auto: () => {
        const previous = { important: task.important ?? null, urgent: task.urgent ?? null }
        void updateTask(task.id, { important: null, urgent: null })
        reportUndo(t('todo.matrix.auto_done'), async () => {
          await updateTask(task.id, previous)
        })
      },
    }
  }, [moveToCell, reportUndo, updateTask])

  const moveFor = useCallback((task: TodoTask) => ({
    dragEnabled: finePointer,
    onMoveToList: (listId: string | null) => { void moveTodoTask(task.id, { beforeId: null, listId }) },
  }), [finePointer])

  const actions = useTaskRowActions({ moveFor, quadrantFor })
  const open = tasks.filter((task) => isTaskOpen(task.status))
  const cells = useMemo(() => {
    const grouped: Record<MatrixQuadrant, TodoTask[]> = { do: [], schedule: [], delegate: [], drop: [] }
    for (const task of open) grouped[matrixQuadrant(matrixAxesOf(task, now))].push(task)
    return grouped
  }, [open, now])

  if (status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ListingFailure message={error} onRetry={() => { void reload() }} />
      </div>
    )
  }

  return (
    <div data-matrix-view="" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pb-1 pt-2 md:px-5">
        <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('todo.matrix.subtitle')}</p>
      </div>
      <div className="no-scrollbar grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-2 overflow-y-auto px-3 pb-24 pt-1 md:grid-cols-2 md:px-5 md:pb-6">
        {MATRIX_QUADRANTS.map((quadrant) => (
          <QuadrantSection
            key={quadrant}
            quadrant={quadrant}
            tasks={cells[quadrant]}
            lists={lists}
            bounds={bounds}
            timezone={timezone}
            actions={actions}
            onDropIds={(ids) => {
              const cell = quadrantCell(quadrant)
              moveToCell(ids, cell.important, cell.urgent)
            }}
          />
        ))}
      </div>
      {open.length === 0 && (
        <p role="status" className="px-4 pb-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('todo.matrix.empty')}
        </p>
      )}
    </div>
  )
}

function QuadrantSection({ quadrant, tasks, lists, bounds, timezone, actions, onDropIds }: {
  quadrant: MatrixQuadrant
  tasks: TodoTask[]
  lists: readonly TaskList[]
  bounds: { dayEnd: number; now: number }
  timezone: string
  actions: ReturnType<typeof useTaskRowActions>
  onDropIds: (ids: readonly string[]) => void
}) {
  const [over, setOver] = useState(false)
  const title = t(QUADRANT_LABELS[quadrant])

  return (
    <section
      data-matrix-quadrant={quadrant}
      aria-label={title}
      onDragOver={(event) => {
        if (!isTodoTaskDrag(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setOver(false)
      }}
      onDrop={(event) => {
        if (!isTodoTaskDrag(event)) return
        event.preventDefault()
        setOver(false)
        onDropIds(readTodoTaskDropIds(event))
      }}
      className={cn(
        'flex min-h-[180px] min-w-0 flex-col rounded-[var(--r-lg)] border bg-[var(--bg-surface)]',
        QUADRANT_TONE[quadrant],
        over && 'ring-2 ring-[var(--accent)]',
      )}
    >
      <header className="border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{title}</h2>
          <span className="text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">{tasks.length}</span>
        </div>
        <p className="mt-0.5 text-[length:var(--text-10-5)] leading-snug text-[var(--text-tertiary)]">{t(QUADRANT_HINTS[quadrant])}</p>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 px-0.5 py-1">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} lists={lists} bounds={bounds} timezone={timezone} actions={actions} />
        ))}
        {tasks.length === 0 && (
          <p className="px-2.5 py-2 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('todo.matrix.cell_empty')}
          </p>
        )}
      </div>
    </section>
  )
}
