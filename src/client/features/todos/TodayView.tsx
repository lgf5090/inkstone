/**
 * "My Day": what the reader picked for today, beside what is already owed today.
 *
 * The screen is a pick and a list. The pick searches the open shelf by title and lands the row in
 * today through `POST /:id/plan`; the list groups what came back by the reason it is here — planned,
 * due today, overdue — because the same row can be here for any of the three and "remove from today"
 * only makes sense for the first. The day itself is the account's, read from the server's `dayEnd`
 * and `timezone` rather than the browser's clock.
 */

import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { localDate } from '@shared/assistant-time'
import type { MessageKey } from '@shared/locales/en-US'
import type { TodoTask } from '@shared/todos/model'
import { t } from '../../lib/i18n'
import { Input } from '../../components/form'
import { useTodos } from './store'
import { GroupedTaskList, inServerOrder } from './TaskViews'
import { groupToday, type TodayGroupKey } from './task-groups'

/** How long the picker waits after the last keystroke before asking; the header search uses the same idea. */
const PICKER_DEBOUNCE_MS = 200

const TODAY_LABELS: Record<TodayGroupKey, MessageKey> = {
  planned: 'todo.group.planned',
  today: 'todo.group.today',
  overdue: 'todo.group.overdue',
}

/** Whether a row is already on this screen without being picked for it. */
function alreadyHere(task: TodoTask, today: string, dayEnd: number): boolean {
  if (task.plannedFor === today) return true
  if (task.dueAt !== null) return task.dueAt < dayEnd
  // The server counts an in-progress task with no due date as today; the picker should not offer
  // what the list behind it is already showing.
  return task.status === 'in_progress'
}

/**
 * The picker: a title search over the open shelf, and a button per match that plans it for today.
 *
 * A plain field and a list of buttons rather than a custom combobox: every match is a real button in
 * the tab order, the field keeps its label, and a screen reader reads the title and the action
 * together. A match already on the screen is hidden — the search spans the shelf, the page does not.
 */
function TaskPicker({ timezone, dayEnd }: { timezone: string; dayEnd: number }) {
  const searchTasks = useTodos((state) => state.searchTasks)
  const planTask = useTodos((state) => state.planTask)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TodoTask[]>([])
  const [searched, setSearched] = useState(false)

  useEffect(() => {
    const text = query.trim()
    setSearched(false)
    if (!text) {
      setResults([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      void searchTasks(text).then((rows) => {
        if (!alive) return
        // The day is read when the matches land, not when the screen mounted: a page left open across
        // midnight must not offer a row as "already here" for the day that just ended.
        const today = localDate(Date.now(), timezone)
        setResults(rows.filter((task) => !alreadyHere(task, today, dayEnd)))
        setSearched(true)
      })
    }, PICKER_DEBOUNCE_MS)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, searchTasks, timezone, dayEnd])

  const pick = async (task: TodoTask): Promise<void> => {
    // Read at the press rather than at the render: planning for the day the screen was opened on is
    // exactly the bug the stored day exists to avoid, one midnight later.
    const planned = await planTask(task.id, localDate(Date.now(), timezone))
    if (!planned) return
    // The row is on the page now, so the words and the match that produced it have done their job.
    setQuery('')
    setResults([])
  }

  return (
    <section className="flex flex-col gap-1">
      <h2 className="px-1 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('todo.today.pick')}</h2>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('todo.today.pick_placeholder')}
        aria-label={t('todo.today.pick')}
        leading={<Search size={12} />}
        className="h-9"
      />
      {query.trim() && (results.length > 0 || searched) && (
        <div className="mt-1 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          {results.length > 0 ? (
            <ul aria-label={t('todo.today.pick')}>
              {results.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => { void pick(task) }}
                    className="flex min-h-11 w-full items-center gap-2 px-2.5 py-1.5 text-left text-[length:var(--text-13)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  >
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                    <span className="shrink-0 text-[length:var(--text-11)] text-[var(--accent)]">{t('todo.today.add')}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2.5 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('todo.empty.search')}</p>
          )}
        </div>
      )}
    </section>
  )
}

export function TodayView() {
  const tasks = useTodos((state) => state.tasks)
  const dayEnd = useTodos((state) => state.dayEnd)
  const timezone = useTodos((state) => state.timezone)
  const sort = useTodos((state) => state.sort)
  const planTask = useTodos((state) => state.planTask)
  const today = useMemo(() => localDate(Date.now(), timezone), [timezone])
  const groups = useMemo(() => {
    const grouped = groupToday(tasks, { dayEnd, now: Date.now(), today })
    // A chosen order is the server's answer; re-sorting a group here would overrule it.
    return sort ? inServerOrder(grouped, tasks) : grouped
  }, [tasks, dayEnd, sort, today])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-2 md:px-5">
        <TaskPicker timezone={timezone} dayEnd={dayEnd} />
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        <GroupedTaskList
          groups={groups}
          label={(key) => t(TODAY_LABELS[key as TodayGroupKey])}
          empty={{ title: t('todo.empty.today'), description: t('todo.empty.today_hint') }}
          onUnplan={(task) => { void planTask(task.id, null) }}
          canUnplan={(task) => task.plannedFor === today}
        />
      </div>
    </div>
  )
}
