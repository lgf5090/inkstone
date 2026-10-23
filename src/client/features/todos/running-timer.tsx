/**
 * The frame's own line about the interval that is running.
 *
 * "What am I working on, and for how long" outlives the screen it started on: the reader goes to the
 * calendar, to the statistics, to another tab altogether, and the interval keeps running the whole
 * time. So the indicator belongs to the app's frame rather than to any one view, and it reads the
 * ledger's own derived field — `runningSince` is what the server says is open, and `ux_todos_time_open`
 * says at most one row is. A second copy of "which task is running" would be a second truth about a
 * fact the database already owns, which is why there is no timer state in the store at all.
 *
 * The elapsed number is interpolated locally. The server knows the instant the run began and nothing
 * about how long a reader is willing to wait for a round trip to be told what it already said, so the
 * count runs on `performance.now()` — a clock that keeps its own time while the tab is hidden, and one
 * that a system clock correction cannot move. A `Date.now()` difference would do neither: put the wall
 * clock back an hour mid-run and the number the reader is watching becomes a negative one clamped to
 * zero, which says the work stopped.
 */
import { useEffect, useState } from 'react'
import { Play } from 'lucide-react'
import { t } from '../../lib/i18n'
import { useTodos } from './store'
import { formatRunningDuration } from '@shared/todos/duration'
import type { TodoTask } from '@shared/todos/model'

/** How often the line re-reads the monotonic clock it counts on. */
const TICK_MS = 1_000

/**
 * How long a run that began at `since` has gone, measured on the page's own clock.
 *
 * The anchor is taken once per running instant: `Date.now()` is consulted exactly there, to place the
 * server's wall-clock instant on this page's monotonic timeline, and never again. Every later reading
 * is a difference of two `performance.now()` values, so neither a corrected system clock nor a laptop
 * woken from sleep can make the count jump or stop — and the tab coming back is answered by one more
 * reading rather than by a re-anchor, which would put the wall clock back in the path.
 */
function useElapsedSince(since: number | null): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (since === null) {
      setElapsed(0)
      return
    }
    const base = Math.max(0, Date.now() - since)
    const startedAt = performance.now()
    const read = (): void => { setElapsed(base + (performance.now() - startedAt)) }
    read()
    const ticking = setInterval(read, TICK_MS)
    // A hidden tab throttles the interval to a beat every so often, so the number on return is the one
    // the clock has already reached. Reading on the way back in is the whole of the catch-up.
    const onReturn = (): void => { read() }
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      clearInterval(ticking)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [since])
  return elapsed
}

/** The account's one running row, in either bucket: a task can be timed from any listing that shows it. */
function runningRow(state: { tasks: TodoTask[]; completed: TodoTask[] }): TodoTask | null {
  return state.tasks.find((entry) => entry.runningSince != null)
    ?? state.completed.find((entry) => entry.runningSince != null)
    ?? null
}

/**
 * The line itself: what is being timed, how long for, and the way back to it.
 *
 * Pressing it goes through the store's one door by id, which is what makes it work from any view and
 * for a row the current page never read. The counter carries `role="timer"` and no live region — the
 * ARIA role for a ticking count is explicitly not announced as it changes, and a number that spoke
 * every second would make the rest of the screen impossible to hear.
 */
export function RunningTimerBar() {
  const running = useTodos(runningRow)
  const openTask = useTodos((state) => state.openTask)
  const elapsed = useElapsedSince(running?.runningSince ?? null)
  if (!running) return null
  const title = running.title
  return (
    <div
      data-todo-running-bar=""
      className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--accent-soft)] px-3 py-1 text-[length:var(--text-11-5)] md:px-5"
    >
      <Play size={11} fill="currentColor" aria-hidden="true" className="shrink-0 text-[var(--accent-on-soft)]" />
      <span className="shrink-0 font-medium text-[var(--accent-on-soft)]">{t('todo.timer.running')}</span>
      <button
        type="button"
        data-todo-running-open=""
        aria-label={t('todo.timer.running_aria', { title })}
        onClick={() => { void openTask(running.id) }}
        className="min-w-0 flex-1 truncate rounded-[var(--r-sm)] text-left text-[var(--accent-on-soft)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        {title}
      </button>
      <span role="timer" data-todo-running-elapsed="" className="shrink-0 tabular-nums text-[var(--accent-on-soft)]">
        {formatRunningDuration(elapsed)}
      </span>
    </div>
  )
}
