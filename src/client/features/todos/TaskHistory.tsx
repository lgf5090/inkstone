/**
 * A task's own history, folded away until it is asked for.
 *
 * The rows have been written since the statistics screen was built — `todos_task_events` is what the
 * cumulative flow replays — but nothing showed them to the reader, so a task that had been finished,
 * reopened and finished again looked like it had always been finished. This is the smallest surface
 * that answers "when did this happen": the birth and each move between statuses, newest first, with
 * the local time.
 *
 * It reads on open rather than with the task. A panel opened to change a title should not pay for a
 * table nobody asked to see, and the history is the one section of the panel that is genuinely a read.
 * The component is keyed by the task on the parent's side, so switching tasks starts from a collapsed,
 * unread state rather than showing the previous task's events under the new task's heading.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { History } from 'lucide-react'
import type { TaskEvent, TaskStatus } from '@shared/todos/model'
import { api } from '../../lib/api'
import { localeTag, t, type MessageKey } from '../../lib/i18n'
import { LoadingBlock } from '../../components/feedback'

/** The words each status is read as, the same ones the board's columns and the group headings use. */
const STATUS_KEYS: Record<TaskStatus, MessageKey> = {
  todo: 'todo.status.todo',
  in_progress: 'todo.status.in_progress',
  done: 'todo.status.done',
  cancelled: 'todo.group.cancelled',
}

type HistoryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready', events: TaskEvent[] }
  | { status: 'error', message: string }

function stamp(at: number): string {
  return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at))
}

/** One row: what happened, and when. */
function HistoryRow({ event }: { event: TaskEvent }) {
  const label = event.kind === 'born'
    ? t('todo.history.born')
    : t('todo.history.moved', {
        from: t(STATUS_KEYS[event.fromStatus ?? 'todo']),
        to: t(STATUS_KEYS[event.toStatus]),
      })
  return (
    <li className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="min-w-0 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{label}</span>
      <time dateTime={new Date(event.at).toISOString()} className="shrink-0 tabular text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
        {stamp(event.at)}
      </time>
    </li>
  )
}

export function TaskHistory({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<HistoryState>({ status: 'idle' })
  const panelId = useId()
  /**
   * Which task this component has already asked about.
   *
   * The effect below must not depend on its own state: putting the status in the dependency list made
   * the move to `loading` tear the effect down, which cleared the `live` flag the answer was waiting
   * on, and every failed read then rendered as "nothing recorded". The ref is what says "asked once"
   * without re-running the effect, and it is per task so a remount for another task reads again.
   */
  const asked = useRef<string | null>(null)

  useEffect(() => {
    if (!open || asked.current === taskId) return
    asked.current = taskId
    // A read that lands after the panel moved on is dropped rather than painted over the next task's
    // history: `live` is the same guard the calendar uses for its own window.
    let live = true
    setState({ status: 'loading' })
    api.todos.events(taskId)
      .then((answer) => { if (live) setState({ status: 'ready', events: answer.events }) })
      .catch((failure: unknown) => {
        if (live) setState({ status: 'error', message: failure instanceof Error ? failure.message : String(failure) })
      })
    return () => { live = false }
  }, [open, taskId])

  return (
    <section className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1.5 self-start rounded-[var(--r-sm)] px-0.5 text-[length:var(--text-11)] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <History size={11} aria-hidden="true" />
        {t('todo.history.title')}
      </button>
      {open && (
        <div id={panelId} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1">
          {state.status === 'loading' && <LoadingBlock />}
          {state.status === 'error' && (
            <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {t('todo.history.error')}
              <span className="mt-0.5 block break-words text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{state.message}</span>
            </p>
          )}
          {state.status === 'ready' && (state.events.length === 0
            ? <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.history.empty')}</p>
            : <ol className="flex flex-col">{state.events.map((event) => <HistoryRow key={event.id} event={event} />)}</ol>)}
        </div>
      )}
    </section>
  )
}
