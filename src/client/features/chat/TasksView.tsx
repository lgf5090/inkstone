/**
 * The chat's view of the to-do list.
 *
 * Not a second task manager. The app owns creating, editing, listing and deleting, and a full copy of
 * that here would be two interfaces over one table — and the copy that drifts first is always the one
 * nobody is looking at. So this answers the one question a reader asks from inside a conversation —
 * "what is on me today" — and hands everything else to the app with one press.
 *
 * The set comes from the same store the app uses rather than from a fetch of its own: a task completed
 * here and a task completed there are the same row, and a second source would show one of them as open.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, CalendarDays, CheckCircle2, Circle, Plus } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { Badge, Button } from '../../components/primitives'
import { Input } from '../../components/form'
import { Empty } from '../../components/feedback'
import { AssistantHeader } from './AssistantHeader'
import { useTodos } from '../todos/store'

/** How many rows the glance shows before it stops being a glance. */
const MAX_ROWS = 8

export function TasksView() {
  const status = useTodos((state) => state.status)
  const tasks = useTodos((state) => state.tasks)
  const counts = useTodos((state) => state.counts)
  const dayEnd = useTodos((state) => state.dayEnd)
  const timezone = useTodos((state) => state.timezone)
  const load = useTodos((state) => state.load)
  const createTask = useTodos((state) => state.createTask)
  const toggleTask = useTodos((state) => state.toggleTask)
  const [quick, setQuick] = useState('')

  useEffect(() => {
    if (useTodos.getState().status === 'idle') void load()
  }, [load])

  // Due today or already late: both are "on me today", and the server's own `today` view counts them
  // the same way, so the number here matches the badge in the app.
  const today = useMemo(() => {
    if (!dayEnd) return []
    return tasks
      .filter((task) => task.status !== 'done' && task.dueAt !== null && task.dueAt <= dayEnd)
      .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0))
  }, [tasks, dayEnd])

  const shown = today.slice(0, MAX_ROWS)
  const rest = today.length - shown.length
  const now = Date.now()

  return (
    <div className="no-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-5 md:px-8">
        <AssistantHeader title={t('assistant.tasks.title')} description={t('assistant.tasks.description')} />

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={today.length ? 'accent' : 'neutral'}>{t('todo.chat.today_count', { count: today.length })}</Badge>
          {counts && counts.overdue > 0 && <Badge tone="danger">{t('todo.chat.overdue_count', { count: counts.overdue })}</Badge>}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => navigateToPath('/todo')}>
            {t('todo.action.open_todo')}
            <ArrowRight size={13} />
          </Button>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const title = quick.trim()
            if (!title) return
            void createTask({ title, dueAt: todayValue() })
            setQuick('')
          }}
        >
          <Input
            value={quick}
            onChange={(event) => setQuick(event.target.value)}
            placeholder={t('todo.chat.quick_add')}
            maxLength={300}
            aria-label={t('todo.chat.quick_add')}
            className="h-8 flex-1 text-[length:var(--text-12-5)]"
          />
          <Button type="submit" size="sm" variant="primary" icon={<Plus size={14} />} disabled={!quick.trim()}>
            {t('todo.action.add_task')}
          </Button>
        </form>

        {status === 'loading' && !tasks.length && (
          <p className="text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">{t('todo.chat.loading')}</p>
        )}

        {status !== 'loading' && !today.length && (
          <Empty art="notes" title={t('todo.chat.empty')} description={t('todo.chat.empty_hint')} />
        )}

        {shown.length > 0 && (
          <ul className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            {shown.map((task) => {
              const overdue = task.dueAt !== null && task.dueAt < now
              return (
                <li key={task.id} className="flex items-start gap-2.5 border-b border-[var(--border-subtle)] px-3 py-2 last:border-b-0 hover:bg-[var(--bg-hover)]">
                  <button
                    type="button"
                    onClick={() => void toggleTask(task)}
                    aria-label={t('todo.a11y.mark_done', { title: task.title })}
                    className="ink-tap-pad mt-0.5 shrink-0 text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]"
                  >
                    {task.status === 'done' ? <CheckCircle2 size={16} className="text-[var(--accent)]" /> : <Circle size={16} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-[length:var(--text-13)] leading-relaxed text-[var(--text-primary)]">{task.title}</p>
                    {task.dueAt !== null && (
                      <span className={cn(
                        'mt-0.5 inline-flex items-center gap-1 text-[length:var(--text-11)]',
                        overdue ? 'font-medium text-[var(--danger)]' : 'text-[var(--text-quaternary)]',
                      )}>
                        <CalendarDays size={11} />
                        {overdue ? t('todo.a11y.overdue') : formatWhen(task.dueAt, dayEnd, timezone)}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {rest > 0 && (
          <button
            type="button"
            onClick={() => navigateToPath('/todo')}
            className="self-start text-[length:var(--text-12-5)] text-[var(--accent)] hover:underline"
          >
            {t('todo.chat.more', { count: rest })}
          </button>
        )}
      </div>
    </div>
  )
}

/** Today as the reader's own date, which is the form the server reads in their timezone. */
function todayValue(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Today, or a date — a due date is read at a glance, so the day it is already on is left out. */
function formatWhen(dueAt: number, dayEnd: number, timezone: string): string {
  const due = new Date(dueAt)
  const end = new Date(dayEnd)
  const sameDay = due.getFullYear() === end.getFullYear() && due.getMonth() === end.getMonth() && due.getDate() === end.getDate()
  if (sameDay) return t('todo.chat.due_today')
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: timezone }).format(due)
}
