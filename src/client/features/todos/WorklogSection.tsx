/**
 * The worklog section of the statistics screen: where the hours actually went.
 *
 * It reads its own endpoint on the range the screen already shows, because the statistics replay the
 * plate's rows and this sums the ledger — an account can hold forty hours in a week whose tasks were
 * mostly closed later, and the two readings have to be allowed to disagree.
 *
 * The dimension is this section's own choice rather than a page-wide filter: it answers "grouped by
 * what", a question the rest of the screen never asks, and lifting it up would make one control
 * appear to govern charts it does not touch.
 */

import { useEffect, useState } from 'react'
import { t } from '../../lib/i18n'
import { SelectMenu } from '../../components/select-menu'
import { api } from '../../lib/api'
import { durationLabel, SliceBars, Sparkline } from './stats-charts'
import { WORKLOG_DIMENSIONS, type Worklog, type WorklogDimension } from '@shared/todos/model'
import type { MessageKey } from '@shared/locales/en-US'

const DIMENSION_KEYS: Record<WorklogDimension, MessageKey> = {
  list: 'todo.stats.worklog.by_list',
  tag: 'todo.stats.worklog.by_tag',
  task: 'todo.stats.worklog.by_task',
}

/** Hours, as a bar chart's number. Bars want a plain value; the label beside it carries the unit. */
function hours(ms: number): number {
  return Math.round((ms / 3_600_000) * 10) / 10
}

export function WorklogSection({ from, to }: { from: string, to: string }) {
  const [dimension, setDimension] = useState<WorklogDimension>('list')
  const [answer, setAnswer] = useState<Worklog | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  /** Bumped by a retry, which is the only way back out of an error the range did not change. */
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let live = true
    setStatus('loading')
    api.todos.worklog({ from, to, group: dimension })
      .then((worklog) => {
        if (!live) return
        setAnswer(worklog)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (!live) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setStatus('error')
      })
    return () => { live = false }
  }, [from, to, dimension, reloadKey])

  if (status === 'error') {
    return (
      <section data-worklog-section="" className="flex flex-col items-start gap-2">
        <p role="alert" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{error}</p>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1 text-[length:var(--text-12)] hover:bg-[var(--bg-hover)]"
        >
          {t('common.retry')}
        </button>
      </section>
    )
  }

  const tracked = answer?.totalMs ?? 0
  const slices = (answer?.byGroup ?? []).map((group) => ({
    key: group.key,
    label: group.label,
    value: hours(group.trackedMs),
    color: 'var(--accent)',
  }))

  return (
    <section
      data-worklog-section=""
      aria-busy={status === 'loading' || undefined}
      className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('todo.stats.worklog.title')}
        </h3>
        <SelectMenu
          className="w-auto min-w-[120px]"
          label={t('todo.stats.worklog.group_by')}
          value={dimension}
          onChange={(next) => setDimension(next as WorklogDimension)}
          options={WORKLOG_DIMENSIONS.map((entry) => ({ value: entry, label: t(DIMENSION_KEYS[entry]) }))}
        />
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="flex flex-col">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('todo.stats.worklog.tracked')}</span>
          <span className="text-[length:var(--text-18)] font-semibold tabular-nums text-[var(--text-primary)]">
            {status === 'loading' ? '—' : durationLabel(tracked)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('todo.stats.worklog.overrun')}</span>
          <span className="flex items-end gap-1.5">
            <span className="text-[length:var(--text-18)] font-semibold tabular-nums text-[var(--text-primary)]">
              {/* A missing denominator is a dash, not a zero: nothing was planned, so nothing overran
                  is a different statement from never overrunning. */}
              {status === 'loading' || !answer ? '—' : answer.overEstimateRate === null ? '—' : `${Math.round(answer.overEstimateRate * 100)}%`}
            </span>
            {answer && answer.overEstimateRate !== null && (
              <span className="pb-1 text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">
                {t('todo.stats.worklog.overrun_of', { over: answer.overEstimateCount, planned: answer.estimatedCount })}
              </span>
            )}
          </span>
        </div>
        {status === 'ready' && tracked > 0 && (
          <div className="flex flex-col gap-0.5">
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('todo.stats.worklog.per_day')}</span>
            <Sparkline values={(answer?.byDay ?? []).map((day) => day.trackedMs)} />
          </div>
        )}
      </div>

      {status === 'loading' && (
        <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('todo.stats.loading')}</p>
      )}
      {status === 'ready' && tracked === 0 && (
        <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('todo.stats.worklog.empty')}
        </p>
      )}
      {status === 'ready' && tracked > 0 && (
        <>
          <SliceBars slices={slices} label={t('todo.stats.worklog.distribution')} />
          {!!answer?.truncatedGroups && (
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {t('todo.stats.worklog.more', { count: answer.truncatedGroups })}
            </p>
          )}
        </>
      )}
    </section>
  )
}
