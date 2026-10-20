/**
 * The four reading views: plan, starred, completed, and one list or tag.
 *
 * They share one grouped list because they differ only in how the page is split and what the group
 * headings say. Each view owns its own split — the plan groups by when, completed by the day it was
 * finished — and hands the result here.
 */

import { useMemo, useRef } from 'react'
import { localDate } from '@shared/assistant-time'
import { t } from '../../lib/i18n'
import { Empty } from '../../components/feedback'
import { Select } from '../../components/form'
import { TodoPageFooter } from './TodoPageFooter'
import { useTodos } from './store'
import { TaskCard } from './TaskCard'
import { groupByPlan, groupCompleted, groupByList, type TaskGroup, type PlanGroupKey } from './task-groups'
import type { MessageKey } from '@shared/locales/en-US'
import type { TodoTask } from '@shared/todos/model'

/**
 * Re-read grouped rows in the order the answer carried them.
 *
 * A view still decides which group a row belongs to, but when the reader chose an order the order
 * inside a group is that choice; sorting the group again here would quietly overrule it.
 */
export function inServerOrder(groups: TaskGroup[], tasks: readonly TodoTask[]): TaskGroup[] {
  const position = new Map(tasks.map((task, index) => [task.id, index]))
  return groups.map((group) => ({
    key: group.key,
    tasks: [...group.tasks].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)),
  }))
}

/**
 * The grouped list every reading view draws.
 *
 * `onUnplan` is the today screen's own row action: the other views have no plan to take a task out
 * of, so they pass nothing and the card draws no such button. `canUnplan` narrows it further, because
 * a row can be in today for its due date and still carry a plan for some other day — clearing that
 * plan would not take it off this screen, and a button that does nothing is worse than no button.
 */
export function GroupedTaskList({ groups, label, empty, onUnplan, canUnplan }: {
  groups: TaskGroup[]
  label: (key: string) => string
  empty: { title: string; description: string }
  onUnplan?: (task: TodoTask) => void
  canUnplan?: (task: TodoTask) => boolean
}) {
  const lists = useTodos((state) => state.lists)
  const dayEnd = useTodos((state) => state.dayEnd)
  const timezone = useTodos((state) => state.timezone)
  const openEditor = useTodos((state) => state.openEditor)
  const updateTask = useTodos((state) => state.updateTask)
  const bounds = { dayEnd, now: Date.now() }

  if (!groups.length) {
    const searching = Boolean(useTodos.getState().query.trim())
    return (
      <div className="px-4 py-10">
        <Empty
          title={searching ? t('todo.empty.search') : empty.title}
          description={searching ? undefined : empty.description}
        />
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col gap-4 px-3 pb-6 pt-2 md:px-5" role="list" aria-label={t('todo.a11y.task_list')}>
        {groups.map((group) => (
          <section key={group.key} aria-label={label(group.key)}>
            <div className="mb-1.5 flex items-baseline justify-between px-1">
              <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{label(group.key)}</h2>
              <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{group.tasks.length}</span>
            </div>
            <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-0.5 py-1">
              {group.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  lists={lists}
                  bounds={bounds}
                  timezone={timezone}
                  onOpen={() => openEditor({ id: task.id })}
                  onStar={() => { void updateTask(task.id, { starred: !task.starred }) }}
                  {...(onUnplan && (!canUnplan || canUnplan(task)) ? { onUnplan: () => onUnplan(task) } : {})}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      {/* Outside the list, because the rows a page still owes is not itself one of the rows. */}
      <div className="px-3 pb-16 md:px-5 md:pb-2">
        <TodoPageFooter />
      </div>
    </>
  )
}

const PLAN_LABELS: Record<PlanGroupKey, MessageKey> = {
  overdue: 'todo.group.overdue',
  today: 'todo.group.today',
  upcoming: 'todo.group.upcoming',
  later: 'todo.group.later',
  none: 'todo.group.none',
}

export function PlanView() {
  const tasks = useTodos((state) => state.tasks)
  const dayEnd = useTodos((state) => state.dayEnd)
  const sort = useTodos((state) => state.sort)
  const groups = useMemo(() => {
    const grouped = groupByPlan(tasks, { dayEnd, now: Date.now() })
    return sort ? inServerOrder(grouped, tasks) : grouped
  }, [tasks, dayEnd, sort])
  return (
    <GroupedTaskList
      groups={groups}
      label={(key) => t(PLAN_LABELS[key as PlanGroupKey])}
      empty={{ title: t('todo.empty.plan'), description: t('todo.empty.plan_hint') }}
    />
  )
}

export function StarredView() {
  const tasks = useTodos((state) => state.tasks)
  // The server was asked for the starred rows, in the order it reads a starred list: nothing here picks
  // them out again, which is the only way this view can show a task the page it used to hold missed.
  return (
    <GroupedTaskList
      groups={tasks.length ? [{ key: 'starred', tasks }] : []}
      label={() => t('todo.smart.starred')}
      empty={{ title: t('todo.empty.starred'), description: t('todo.empty.starred_hint') }}
    />
  )
}

export function CompletedView() {
  const completed = useTodos((state) => state.completed)
  const lists = useTodos((state) => state.lists)
  const timezone = useTodos((state) => state.timezone)
  const listId = useTodos((state) => state.listId)
  const sort = useTodos((state) => state.sort)
  const completedFrom = useTodos((state) => state.completedFrom)
  const setCompletedRange = useTodos((state) => state.setCompletedRange)
  const setView = useTodos((state) => state.setView)

  const activeYear = completedFrom ? completedFrom.slice(0, 4) : 'all'
  // Every year this screen has seen, not only the ones on the current page: once a year is chosen the
  // answer no longer carries the years it excluded, and a select that lost them could not go back.
  const seenYears = useRef(new Set<string>())
  for (const task of completed) {
    seenYears.current.add(localDate(task.completedAt ?? task.updatedAt, timezone).slice(0, 4))
  }
  if (completedFrom) seenYears.current.add(completedFrom.slice(0, 4))
  const years = [...seenYears.current].sort((a, b) => (a < b ? 1 : -1))

  const groups = useMemo(() => {
    const grouped = groupCompleted(completed, timezone)
    // The day a task was filed under is the grouping; within it, an order the reader chose is the
    // server's answer and is not sorted again here.
    return sort ? inServerOrder(grouped, completed) : grouped
  }, [completed, sort, timezone])

  const label = (key: string): string => {
    const [y, m, d] = key.split('-')
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(Number(y), Number(m) - 1, Number(d)))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pb-1 pt-2 md:px-5">
        <Select
          value={activeYear}
          onChange={(event) => {
            const year = event.target.value
            // A year is the half-open window 1 January → next 1 January on the day the task was
            // finished, which is what the route bounds; it is asked again rather than filtered here.
            setCompletedRange(year === 'all'
              ? { from: null, to: null }
              : { from: `${year}-01-01`, to: `${Number(year) + 1}-01-01` })
          }}
          aria-label={t('todo.view.completed')}
          className="w-auto"
        >
          <option value="all">{t('todo.completed.year_all')}</option>
          {years.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </Select>
        {/* The collection is part of the question, so it is asked again rather than filtered here:
            a page of finished work cannot be narrowed to a list it never received the rows of. */}
        <Select
          value={listId ?? 'all'}
          onChange={(event) => {
            // Moving to another collection starts over at all years; `setView` clears the window.
            setView('completed', { listId: event.target.value === 'all' ? undefined : event.target.value })
          }}
          aria-label={t('todo.task.list_label')}
          className="w-auto"
        >
          <option value="all">{t('todo.filter.all_lists')}</option>
          <option value="inbox">{t('todo.smart.inbox')}</option>
          {lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
        </Select>
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        <GroupedTaskList
          groups={groups}
          label={label}
          empty={{ title: t('todo.empty.completed'), description: t('todo.empty.completed_hint') }}
        />
      </div>
    </div>
  )
}

/** One list, or one tag: the rows the server scoped for it, with the open ones first. */
export function ListTaskView() {
  const tasks = useTodos((state) => state.tasks)
  const sort = useTodos((state) => state.sort)
  const groups = useMemo(() => {
    const grouped = groupByList(tasks)
    return sort ? inServerOrder(grouped, tasks) : grouped
  }, [tasks, sort])

  const label = (key: string): string => (key === 'done' ? t('todo.group.done') : t('todo.group.open'))

  return (
    <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
      <GroupedTaskList
        groups={groups}
        label={label}
        empty={{ title: t('todo.empty.list'), description: t('todo.empty.list_hint') }}
      />
    </div>
  )
}

/** The list or tag the header is naming, so a page opened from the board says where it is. */
export function useViewTitle(): string {
  const view = useTodos((state) => state.view)
  const listId = useTodos((state) => state.listId)
  const tagId = useTodos((state) => state.tagId)
  const lists = useTodos((state) => state.lists)
  const tags = useTodos((state) => state.tags)
  if (view === 'list') return listId === 'inbox' ? t('todo.smart.inbox') : lists.find((list) => list.id === listId)?.name ?? t('todo.view.list')
  if (view === 'tag') return tags.find((tag) => tag.id === tagId)?.name ?? t('todo.view.tag')
  if (view === 'today') return t('todo.view.today')
  if (view === 'plan') return t('todo.view.plan')
  if (view === 'calendar') return t('todo.view.calendar')
  if (view === 'starred') return t('todo.view.starred')
  if (view === 'completed') return t('todo.view.completed')
  if (view === 'stats') return t('todo.view.stats')
  return t('todo.view.board')
}

