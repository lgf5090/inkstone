/**
 * The focus history on the statistics screen.
 *
 * It reads the same window the statistics screen shows and keeps today's own number beside it, because
 * "how much did I focus in this range" and "how much have I focused today" are different questions a
 * reader asks at different moments. A phase is written when it ends, so the section never guesses
 * from the worklog.
 */
import { useEffect, useState } from 'react'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { durationLabel, SliceBars, Sparkline } from './stats-charts'
import type { TodoFocusStats } from '@shared/todos/model'

export interface FocusStatsState {
  answer: TodoFocusStats | null
  status: 'loading' | 'ready' | 'error'
  error: string
  retry: () => void
}

export function useFocusStats(range: { from: string, to: string }): FocusStatsState {
  const [answer, setAnswer] = useState<TodoFocusStats | null>(null)
  const [status, setStatus] = useState<FocusStatsState['status']>('loading')
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const { from, to } = range

  useEffect(() => {
    if (!from || !to) {
      setAnswer(null)
      setStatus('ready')
      return undefined
    }
    let live = true
    setStatus('loading')
    api.todos.focus({ from, to })
      .then((stats) => {
        if (!live) return
        setAnswer(stats)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (!live) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setStatus('error')
      })
    return () => { live = false }
  }, [from, to, reloadKey])

  return { answer, status, error, retry: () => setReloadKey((key) => key + 1) }
}

export function FocusStatsSection({ state }: { state: FocusStatsState }) {
  const { answer, status, error, retry } = state

  if (status === 'error') {
    return (
      <section data-focus-stats-section="" className="flex flex-col items-start gap-2">
        <p role="alert" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{error}</p>
        <button
          type="button"
          onClick={retry}
          className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1 text-[length:var(--text-12)] hover:bg-[var(--bg-hover)]"
        >
          {t('common.retry')}
        </button>
      </section>
    )
  }

  const slices = (answer?.byTask ?? []).map((row) => ({
    key: row.taskId,
    label: row.title || t('todo.focus.history.untitled'),
    value: row.workMs,
    display: durationLabel(row.workMs),
    color: 'var(--accent)',
  }))

  return (
    <section
      data-focus-stats-section=""
      aria-busy={status === 'loading' || undefined}
      className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('todo.focus.history.title')}
        </h3>
        {answer && (
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('todo.focus.history.today', {
              rounds: answer.today.rounds,
              time: durationLabel(answer.today.workMs),
            })}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="flex flex-col">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('todo.focus.history.work')}</span>
          <span className="text-[length:var(--text-18)] font-semibold tabular-nums text-[var(--text-primary)]">
            {status === 'loading' ? '—' : durationLabel(answer?.workMs ?? 0)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('todo.focus.history.rounds')}</span>
          <span className="text-[length:var(--text-18)] font-semibold tabular-nums text-[var(--text-primary)]">
            {status === 'loading' || !answer ? '—' : t('todo.focus.history.rounds_value', { done: answer.completedRounds, total: answer.workRounds })}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('todo.focus.history.break')}</span>
          <span className="text-[length:var(--text-18)] font-semibold tabular-nums text-[var(--text-primary)]">
            {status === 'loading' ? '—' : durationLabel(answer?.breakMs ?? 0)}
          </span>
        </div>
        {status === 'ready' && (answer?.workMs ?? 0) > 0 && (
          <div className="flex flex-col gap-0.5">
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('todo.focus.history.per_day')}</span>
            <Sparkline values={(answer?.byDay ?? []).map((day) => day.workMs)} />
          </div>
        )}
      </div>

      {status === 'loading' && (
        <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('todo.stats.loading')}</p>
      )}
      {status === 'ready' && (answer?.workRounds ?? 0) === 0 && (
        <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('todo.focus.history.empty')}
        </p>
      )}
      {status === 'ready' && (answer?.workRounds ?? 0) > 0 && slices.length > 0 && (
        <>
          <SliceBars slices={slices} label={t('todo.focus.history.by_task')} />
          {!!answer?.truncatedTasks && (
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {t('todo.focus.history.more', { count: answer.truncatedTasks })}
            </p>
          )}
        </>
      )}
    </section>
  )
}
