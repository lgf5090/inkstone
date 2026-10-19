/**
 * The four reading views: plan, starred, completed, and one list or tag.
 *
 * They share one grouped list because they differ only in how the page is split and what the group
 * headings say. Each view owns its own split — the plan groups by when, completed by the day it was
 * finished — and hands the result here.
 */

import { useMemo, useState } from 'react'
import { localDate } from '@shared/assistant-time'
import { t } from '../../lib/i18n'
import { Empty } from '../../components/feedback'
import { Select } from '../../components/form'
import { useTodos } from './store'
import { TaskCard } from './TaskCard'
import { compareTasks, filterTasks, groupByPlan, groupCompleted, groupByList, type TaskGroup, type PlanGroupKey } from './task-groups'
import type { MessageKey } from '@shared/locales/en-US'

function GroupedTaskList({ groups, label, empty }: {
  groups: TaskGroup[]
  label: (key: string) => string
  empty: { title: string; description: string }
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
    <div className="flex flex-col gap-4 px-3 pb-24 pt-2 md:px-5 md:pb-6" role="list" aria-label={t('todo.a11y.task_list')}>
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
              />
            ))}
          </div>
        </section>
      ))}
    </div>
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
  const groups = useMemo(() => groupByPlan(tasks, { dayEnd, now: Date.now() }), [tasks, dayEnd])
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
  const starred = useMemo(() => tasks.filter((task) => task.starred).sort(compareTasks), [tasks])
  return (
    <GroupedTaskList
      groups={starred.length ? [{ key: 'starred', tasks: starred }] : []}
      label={() => t('todo.smart.starred')}
      empty={{ title: t('todo.empty.starred'), description: t('todo.empty.starred_hint') }}
    />
  )
}

export function CompletedView() {
  const completed = useTodos((state) => state.completed)
  const lists = useTodos((state) => state.lists)
  const timezone = useTodos((state) => state.timezone)
  const [year, setYear] = useState('all')
  const [listId, setListId] = useState('all')

  const years = useMemo(() => {
    const found = new Set<string>()
    for (const task of completed) found.add(localDate(task.completedAt ?? task.updatedAt, timezone).slice(0, 4))
    return [...found].sort((a, b) => (a < b ? 1 : -1))
  }, [completed, timezone])

  const groups = useMemo(() => {
    const rows = completed.filter((task) => {
      if (year !== 'all' && localDate(task.completedAt ?? task.updatedAt, timezone).slice(0, 4) !== year) return false
      if (listId === 'all') return true
      return listId === 'inbox' ? task.listId === null : task.listId === listId
    })
    return groupCompleted(rows, timezone)
  }, [completed, year, listId, timezone])

  const label = (key: string): string => {
    const [y, m, d] = key.split('-')
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(Number(y), Number(m) - 1, Number(d)))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pb-1 pt-2 md:px-5">
        <Select value={year} onChange={(event) => setYear(event.target.value)} aria-label={t('todo.view.completed')} className="w-auto">
          <option value="all">{t('todo.completed.year_all')}</option>
          {years.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </Select>
        <Select value={listId} onChange={(event) => setListId(event.target.value)} aria-label={t('todo.task.list_label')} className="w-auto">
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

/** One list, or one tag: the same rows with the open ones first. */
export function ListTaskView({ listId, tagId }: { listId: string | null; tagId: string | null }) {
  const tasks = useTodos((state) => state.tasks)
  const query = useTodos((state) => state.query)
  const groups = useMemo(() => {
    // The inbox is "no list at all", which is a value rather than the absence of a filter.
    const rows = listId === 'inbox'
      ? filterTasks(tasks, { query, tagId }).filter((task) => task.listId === null)
      : filterTasks(tasks, { query, listId: listId ?? undefined, tagId })
    return groupByList(rows)
  }, [tasks, query, listId, tagId])

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
  if (view === 'plan') return t('todo.view.plan')
  if (view === 'starred') return t('todo.view.starred')
  if (view === 'completed') return t('todo.view.completed')
  return t('todo.view.board')
}

