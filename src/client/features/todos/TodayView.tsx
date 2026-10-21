/**
 * "My Day": what the reader picked for today, beside what is already owed today.
 *
 * The screen is a pick and a list. The pick searches the open shelf by title and lands the row in
 * today through `POST /:id/plan`; the list groups what came back by the reason it is here — planned,
 * due today, overdue — because the same row can be here for any of the three and "remove from today"
 * only makes sense for the first. The day itself is the account's, read from the server's `dayEnd`
 * and `timezone` rather than the browser's clock.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Sparkles, Search } from 'lucide-react'
import { localDate } from '@shared/assistant-time'
import type { MessageKey } from '@shared/locales/en-US'
import { MAX_BATCH_TASKS, MAX_TASKS_PER_QUERY, UPCOMING_DAYS, type TodoTask } from '@shared/todos/model'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { Input } from '../../components/form'
import { Button } from '../../components/primitives'
import { useUi } from '../../store/ui'
import { useTodos } from './store'
import { GroupedTaskList, inServerOrder } from './TaskViews'
import { groupToday, type TodayGroupKey } from './task-groups'

/** How long the picker waits after the last keystroke before asking; the header search uses the same idea. */
const PICKER_DEBOUNCE_MS = 200

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How many open rows one plan reads, and how many of them it offers.
 *
 * The same two ceilings the assistant's `plan_today` tool answers with: one page of the shelf rather
 * than the whole of it, and a day's worth of suggestions rather than every match. The caps live here
 * as well because the screen asks the shelf itself; the tool and the panel have to agree about what
 * "a plan" is.
 */
const PLAN_SHELF_LIMIT = 200
const PLAN_SUGGESTION_LIMIT = 8

const TODAY_LABELS: Record<TodayGroupKey, MessageKey> = {
  planned: 'todo.group.planned',
  today: 'todo.group.today',
  overdue: 'todo.group.overdue',
}

/** Why a row is on the plan, in the order the panel takes them: the more urgent reason wins. */
type PlanReason = 'overdue' | 'starred_due' | 'unscheduled'

const PLAN_REASON_LABELS: Record<PlanReason, MessageKey> = {
  overdue: 'todo.today.ai_reason.overdue',
  starred_due: 'todo.today.ai_reason.starred_due',
  unscheduled: 'todo.today.ai_reason.unscheduled',
}

interface PlanSuggestion {
  id: string
  title: string
  reason: PlanReason
}

/**
 * The rows a plan may offer, in the order they are offered.
 *
 * Read from the open shelf and decided here, because the Today screen owns the question "what is not
 * on the page yet": overdue first, then starred rows due in the coming week, then what has no plan at
 * all. Finished and trashed rows are not work, and a row already on today — planned, due, or in
 * progress with no date — is already the screen's answer rather than a suggestion for it.
 */
function planSuggestions(tasks: TodoTask[], options: { today: string, dayEnd: number, now: number }): PlanSuggestion[] {
  const { today, dayEnd, now } = options
  const upcomingEnd = dayEnd + UPCOMING_DAYS * DAY_MS
  const live = tasks.filter((task) => task.status !== 'done' && task.deletedAt == null)
  const out: PlanSuggestion[] = []
  const taken = new Set<string>()
  const offer = (task: TodoTask, reason: PlanReason): void => {
    if (taken.has(task.id)) return
    taken.add(task.id)
    out.push({ id: task.id, title: task.title, reason })
  }
  for (const task of live) {
    if (task.dueAt !== null && task.dueAt < now) offer(task, 'overdue')
  }
  for (const task of live) {
    if (task.starred && task.dueAt !== null && task.dueAt >= dayEnd && task.dueAt < upcomingEnd) {
      if (task.plannedFor !== today) offer(task, 'starred_due')
    }
  }
  for (const task of live) {
    const plannedAhead = task.plannedFor !== null && task.plannedFor >= today
    const dueToday = task.dueAt !== null && task.dueAt < dayEnd
    // The server counts an in-progress task with no date as today, so it is not a candidate.
    const inProgressToday = task.dueAt === null && task.status === 'in_progress'
    if (plannedAhead || dueToday || inProgressToday) continue
    offer(task, 'unscheduled')
  }
  return out.slice(0, PLAN_SUGGESTION_LIMIT)
}

/**
 * The Today screen's plan: one press reads the open shelf and answers with a draft, and every row is
 * accepted through the same `plan` endpoint the picker uses.
 *
 * The draft is a list of buttons rather than a selection: each row can be taken on its own, and the
 * one "add all" press walks the same list in order. The store re-reads the page after each accepted
 * row, so what is left in the panel is what the server refused or has not seen yet.
 */
function AiPlan({ today, dayEnd }: { today: string, dayEnd: number }) {
  const planTask = useTodos((state) => state.planTask)
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [suggestions, setSuggestions] = useState<PlanSuggestion[]>([])
  const [accepting, setAccepting] = useState(false)
  // A reader who closes the panel while the shelf is in flight must not have it reopen under them.
  const sequence = useRef(0)

  const ask = async (): Promise<void> => {
    if (open) {
      setOpen(false)
      return
    }
    const id = ++sequence.current
    setOpen(true)
    setStatus('loading')
    setSuggestions([])
    try {
      const page = await api.todos.list({ view: 'open', limit: PLAN_SHELF_LIMIT })
      if (id !== sequence.current) return
      setSuggestions(planSuggestions(page.tasks, { today, dayEnd, now: Date.now() }))
      setStatus('ready')
    } catch {
      if (id !== sequence.current) return
      setStatus('error')
    }
  }

  const accept = async (id: string): Promise<void> => {
    const landed = await planTask(id, today)
    if (!landed) return
    setSuggestions((current) => current.filter((entry) => entry.id !== id))
  }

  const acceptAll = async (): Promise<void> => {
    setAccepting(true)
    for (const entry of suggestions) {
      const landed = await planTask(entry.id, today)
      if (!landed) break
      setSuggestions((current) => current.filter((item) => item.id !== entry.id))
    }
    setAccepting(false)
  }

  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t('todo.today.ai_plan')}
          aria-expanded={open}
          aria-controls={panelId}
          disabled={accepting}
          onClick={() => { void ask() }}
          className="flex min-h-9 items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 text-[length:var(--text-12)] font-medium text-[var(--accent)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-60"
        >
          <Sparkles size={12} />
          {t('todo.today.ai_plan')}
        </button>
        {status === 'ready' && suggestions.length > 0 && (
          <button
            type="button"
            aria-label={t('todo.today.ai_plan_all')}
            disabled={accepting}
            onClick={() => { void acceptAll() }}
            className="min-h-9 rounded-[var(--r-md)] px-2 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-60"
          >
            {t('todo.today.ai_plan_all')}
          </button>
        )}
      </div>
      {open && (
        <div id={panelId} className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          {status === 'loading' && (
            <p role="status" className="px-2.5 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</p>
          )}
          {status === 'error' && (
            <p role="alert" className="px-2.5 py-2 text-[length:var(--text-12)] text-[var(--danger)]">{t('todo.today.ai_plan_failed')}</p>
          )}
          {status === 'ready' && suggestions.length === 0 && (
            <p className="px-2.5 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('todo.today.ai_plan_empty')}</p>
          )}
          {suggestions.length > 0 && (
            <ul aria-label={t('todo.today.ai_plan')} className="divide-y divide-[var(--border-subtle)]">
              {suggestions.map((entry) => (
                <li
                  key={entry.id}
                  data-today-suggestion={entry.id}
                  className="flex min-h-11 items-center gap-2 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{entry.title}</p>
                    <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t(PLAN_REASON_LABELS[entry.reason])}</p>
                  </div>
                  <button
                    type="button"
                    aria-label={t('todo.today.ai_plan_accept', { title: entry.title })}
                    disabled={accepting}
                    onClick={() => { void accept(entry.id) }}
                    className="min-h-9 shrink-0 rounded-[var(--r-md)] px-2 text-[length:var(--text-12)] text-[var(--accent)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-60"
                  >
                    {t('todo.today.add')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
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

/**
 * The overdue rows, shifted to today in one press.
 *
 * The count on the button is the server's account-wide overdue number, and the rows are read by the
 * same view that number counts: the page behind the banner is a page, not the whole overdue shelf.
 * A batch names at most `MAX_BATCH_TASKS`, so a longer shelf is sent in chunks; both halves of every
 * answer are summed, because a toast that said "moved" over a partial batch would be a lie.
 *
 * Only `due_at` moves on the server. The day a row was picked for is the reader's own plan and stays
 * where it was, which is what keeps this gesture from silently rearranging "My Day".
 */
function OverdueShift() {
  const counts = useTodos((state) => state.counts)
  const [busy, setBusy] = useState(false)
  const overdue = counts?.overdue ?? 0
  if (overdue === 0) return null

  const shift = async (): Promise<void> => {
    setBusy(true)
    try {
      const page = await api.todos.list({ view: 'overdue', limit: MAX_TASKS_PER_QUERY })
      const ids = page.tasks.filter((task) => task.status !== 'done').map((task) => task.id)
      let done = 0
      let failed = 0
      for (let start = 0; start < ids.length; start += MAX_BATCH_TASKS) {
        const result = await api.todos.batch({ ids: ids.slice(start, start + MAX_BATCH_TASKS), op: 'due' })
        done += result.done.length
        failed += result.failed.length
      }
      // The rows moved, so the page and the count are read again rather than patched by hand — the
      // same rule every other write in this feature follows.
      await useTodos.getState().load()
      if (!ids.length) return
      useUi.getState().toast(failed
        ? { title: t('todo.toast.batch_partial', { failed, total: done + failed }), tone: 'danger' }
        : { title: t('todo.toast.batch_due', { count: done }), tone: 'success' })
    } catch (error) {
      useUi.getState().toast({
        title: t('todo.toast.failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pb-1.5">
      <Button
        variant="ghost"
        size="sm"
        block
        data-todo-overdue-shift=""
        disabled={busy}
        onClick={() => { void shift() }}
        className="justify-start text-[var(--text-secondary)]"
      >
        {t('todo.overdue.shift', { count: overdue })}
      </Button>
    </div>
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
        <OverdueShift />
        <AiPlan today={today} dayEnd={dayEnd} />
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
