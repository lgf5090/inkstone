/**
 * The reading views: plan, upcoming, starred, completed, and one list or tag.
 *
 * They share one grouped list because they differ only in how the page is split and what the group
 * headings say. Each view owns its own split — the plan groups by when, completed by the day it was
 * finished — and hands the result here.
 *
 * What is empty and what is broken is decided here rather than by each view, because the two answers
 * look the same on screen and mean different things to the reader: one is a collection with nothing in
 * it, the other is a read that did not arrive.
 */

import { useMemo, useRef } from 'react'
import { localDate } from '@shared/assistant-time'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { useMediaQuery } from '../../lib/hooks'
import { Button } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { SelectMenu } from '../../components/select-menu'
import { TodoPageFooter } from './TodoPageFooter'
import { OverdueShift } from './OverdueShift'
import { useTodos } from './store'
import {
  TaskRow,
  useListingBounds,
  useTaskMoves,
  useTaskRowActions,
  type TaskMoveControls,
} from './TaskCard'
import { LIST_COLUMNS_QUERY, ListLayoutToggle, StatusBoard, useBoardGroup, useListLayout } from './status-board'
import { arrangeTree, groupByPlan, groupBySection, groupCompletedAndAbandoned, groupByList, type TaskGroup, type PlanGroupKey } from './task-groups'
import type { MessageKey } from '@shared/locales/en-US'
import { type TodoTask } from '@shared/todos/model'

/**
 * The width a reading page is drawn in.
 *
 * The organizer page keeps its rows to 640 and the statistics to 1080; this family's text-densest member
 * sits between them, because a row reads a short title and one line of note, and the control that
 * belongs to it has to stay within the travel of the eye that just read the title. The board is not in
 * this measure — its cards are columns to place work in, not lines to read.
 */
const READING_COLUMN = 'mx-auto w-full max-w-[820px]'

/**
 * The read failed, said as itself.
 *
 * A broken read used to leave the page to its empty branch, which told the reader the collection holds
 * nothing when the server only refused to say — two different facts, and only one of them is fixable by
 * looking again. The words are the trash's and the habits page's: the store's own message and one retry
 * that asks for the listing the same way the first read was asked.
 */
export function ListingFailure({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-10">
      <p role="alert" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{message}</p>
      <Button size="sm" variant="ghost" onClick={onRetry}>{t('common.retry')}</Button>
    </div>
  )
}

/**
 * Re-read grouped rows in the order the answer carried them.
 *
 * A view still decides which group a row belongs to, but when the reader chose an order the order
 * inside a group is that choice; sorting the group again here would quietly overrule it.
 */
export function inServerOrder(groups: TaskGroup[], tasks: readonly TodoTask[]): TaskGroup[] {
  const position = new Map(tasks.map((task, index) => [task.id, index]))
  return groups.map((group) => ({
    ...group,
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
export function GroupedTaskList({ groups, label, empty, onUnplan, canUnplan, moveFor, showList = true }: {
  groups: TaskGroup[]
  label: (key: string) => string
  empty: { title: string; description: string }
  onUnplan?: (task: TodoTask) => void
  canUnplan?: (task: TodoTask) => boolean
  /**
   * The manual-order controls for a row, when this page's order belongs to the reader. The plan and
   * the finished view pass nothing: their groups are dates, and a drop between two days has no place
   * to land. An explicit sort also passes nothing, because that order is the reader's own choice.
   */
  moveFor?: (task: TodoTask) => TaskMoveControls | null
  /** Whether rows name their list; one list's own page does not repeat it on every row. */
  showList?: boolean
}) {
  const lists = useTodos((state) => state.lists)
  const dayEnd = useTodos((state) => state.dayEnd)
  const timezone = useTodos((state) => state.timezone)
  const status = useTodos((state) => state.status)
  const error = useTodos((state) => state.error)
  const readAgain = useTodos((state) => state.load)
  const filtered = useTodos((state) => Boolean(
    state.query.trim() || state.dueFrom || state.dueTo || state.completedFrom || state.completedTo,
  ))
  const bounds = useListingBounds(dayEnd)
  // Which parents are folded, as the set `arrangeTree` asks for. The store holds an array because that is
  // what survives a state replace; the lookup is per row.
  const foldedIds = useTodos((state) => state.collapsedTasks)
  const collapsed = useMemo(() => new Set(foldedIds), [foldedIds])
  // One actions object for the page, so a row's props only move when the row's own reading does.
  const actions = useTaskRowActions({ moveFor, unplan: onUnplan, canUnplan })

  // Before the empty branch, because the two answers are not the same fact: a read that came back
  // broken says so, rather than telling the reader this collection has nothing in it.
  if (status === 'error') {
    return <ListingFailure message={error} onRetry={() => { void readAgain() }} />
  }

  if (!groups.length) {
    return (
      <div className="px-4 py-10">
        <Empty
          title={filtered ? t('todo.empty.search') : empty.title}
          description={filtered ? undefined : empty.description}
        />
      </div>
    )
  }

  return (
    <>
      <div className={cn('flex flex-col gap-4 px-3 pb-6 pt-2 md:px-5', READING_COLUMN)} role="list" aria-label={t('todo.a11y.task_list')}>
        {groups.map((group) => (
          <section key={group.key} aria-label={label(group.key)}>
            <div className="mb-1.5 flex items-baseline justify-between px-1">
              <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{label(group.key)}</h2>
              <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{group.tasks.length}</span>
            </div>
            <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-0.5 py-1">
              {arrangeTree(group.tasks, collapsed).map((row) => (
                <TaskRow
                  key={row.task.id}
                  task={row.task}
                  lists={lists}
                  bounds={bounds}
                  timezone={timezone}
                  actions={actions}
                  depth={row.depth}
                  childCount={row.childCount}
                  collapsed={collapsed.has(row.task.id)}
                  showList={group.showList ?? showList}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      {/* Outside the list, because the rows a page still owes is not itself one of the rows. */}
      <div className={cn('px-3 pb-16 md:px-5 md:pb-2', READING_COLUMN)}>
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
    <>
      <OverdueShift className="px-3 pb-1.5 pt-2 md:px-5" />
      <GroupedTaskList
        groups={groups}
        label={(key) => t(PLAN_LABELS[key as PlanGroupKey])}
        empty={{ title: t('todo.empty.plan'), description: t('todo.empty.plan_hint') }}
      />
    </>
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

/**
 * The next week, as one shelf.
 *
 * The server already scopes it — due after the end of today, within `UPCOMING_DAYS` — so nothing here
 * narrows the page again: a view that filtered its own answer would show fewer rows than the number its
 * nav row carries. The plan page divides the whole open set by when; this one answers only the question
 * "what is coming".
 */
export function UpcomingView() {
  const tasks = useTodos((state) => state.tasks)
  return (
    <GroupedTaskList
      groups={tasks.length ? [{ key: 'upcoming', tasks }] : []}
      label={() => t('todo.group.upcoming')}
      empty={{ title: t('todo.empty.upcoming'), description: t('todo.empty.upcoming_hint') }}
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
    const { done, abandoned } = groupCompletedAndAbandoned(completed, timezone)
    // The day a task was filed under is the grouping; within it, an order the reader chose is the
    // server's answer and is not sorted again here. Abandoned rows ride below the finished ones as
    // their own section, newest-left first, so "did this" and "will not do this" never share a heading.
    const doneGroups = sort ? inServerOrder(done, completed) : done
    return abandoned.length ? [...doneGroups, { key: 'abandoned', tasks: abandoned }] : doneGroups
  }, [completed, sort, timezone])

  const label = (key: string): string => {
    if (key === 'abandoned') return t('todo.group.cancelled')
    const [y, m, d] = key.split('-')
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(Number(y), Number(m) - 1, Number(d)))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pb-1 pt-2 md:px-5">
        <SelectMenu
          size="sm"
          className="w-auto min-w-[112px]"
          label={t('todo.view.completed')}
          value={activeYear}
          onChange={(year) => {
            // A year is the half-open window 1 January → next 1 January on the day the task was
            // finished, which is what the route bounds; it is asked again rather than filtered here.
            setCompletedRange(year === 'all'
              ? { from: null, to: null }
              : { from: `${year}-01-01`, to: `${Number(year) + 1}-01-01` })
          }}
          options={[
            { value: 'all', label: t('todo.completed.year_all') },
            ...years.map((entry) => ({ value: entry, label: entry })),
          ]}
        />
        {/* The collection is part of the question, so it is asked again rather than filtered here:
            a page of finished work cannot be narrowed to a list it never received the rows of. */}
        <SelectMenu
          size="sm"
          className="w-auto min-w-[132px]"
          label={t('todo.task.list_label')}
          value={listId ?? 'all'}
          onChange={(next) => {
            // Moving to another collection starts over at all years; `setView` clears the window.
            setView('completed', { listId: next === 'all' ? undefined : next })
          }}
          options={[
            { value: 'all', label: t('todo.filter.all_lists') },
            { value: 'inbox', label: t('todo.smart.inbox') },
            ...lists.map((list) => ({ value: list.id, label: list.name })),
          ]}
        />
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
  const lists = useTodos((state) => state.lists)
  const listId = useTodos((state) => state.listId)
  const sort = useTodos((state) => state.sort)
  const view = useTodos((state) => state.view)
  // Columns are a reading of the same rows the plain list draws, cut by whichever field the reader
  // asked for; a narrower window keeps the list, and the switches that ask for either do not exist
  // where the columns cannot be drawn.
  const wide = useMediaQuery(LIST_COLUMNS_QUERY)
  const layout = useListLayout()
  const group = useBoardGroup()
  const columns = view === 'list' && wide && layout === 'columns'
  // A list's page is drawn in sections, and a section is its child lists in the order the reader filed
  // them — the nesting the sidebar already offers, read as the sections of one page instead. `lists` is
  // the working set, so a put-away collection is not in it to begin with.
  const sections = useMemo(
    () => (view === 'list' && listId && listId !== 'inbox'
      ? lists.filter((list) => list.parentId === listId)
      : []),
    [view, listId, lists],
  )
  const groups = useMemo(() => {
    const grouped = sections.length ? groupBySection(tasks, sections) : groupByList(tasks)
    return sort ? inServerOrder(grouped, tasks) : grouped
  }, [tasks, sort, sections])
  // The manual order is the list's own reading. An explicit sort replaces it, so the controls that
  // would write a place are not offered while that sort is up.
  const moveFor = useTaskMoves(view === 'list' && !sort)

  const label = (key: string): string => {
    if (key === 'done') return t('todo.group.done')
    if (key === 'unsectioned') return t('todo.group.unsectioned')
    if (key.startsWith('section:')) {
      return lists.find((list) => list.id === key.slice('section:'.length))?.name ?? t('todo.view.list')
    }
    return t('todo.group.open')
  }

  return (
    <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
      {view === 'list' && wide && <ListLayoutToggle layout={layout} group={group} />}
      {columns ? (
        <StatusBoard tasks={tasks} group={group} />
      ) : (
        <GroupedTaskList
          groups={groups}
          label={label}
          empty={{ title: t('todo.empty.list'), description: t('todo.empty.list_hint') }}
          moveFor={moveFor}
          showList={view !== 'list'}
        />
      )}
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
  if (view === 'upcoming') return t('todo.view.upcoming')
  if (view === 'calendar') return t('todo.view.calendar')
  if (view === 'starred') return t('todo.view.starred')
  if (view === 'completed') return t('todo.view.completed')
  if (view === 'stats') return t('todo.view.stats')
  if (view === 'finish-day') return t('todo.view.finish_day')
  if (view === 'counters') return t('todo.view.counters')
  return t('todo.view.board')
}

