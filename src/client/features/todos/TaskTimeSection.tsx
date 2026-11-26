/**
 * The time ledger for one saved task.
 *
 * Entries stay as the server split them: a span crossing the account's midnight is several rows, not
 * one duration with a guessed date. Manual spans are written immediately rather than queued, because
 * the time route has no idempotency key and replaying a lost answer would file the same work twice.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Clock, Plus, Trash2 } from 'lucide-react'
import { MAX_SINGLE_TIME_ENTRY_MS, type TimeEntrySource, type TodoTimeEntry } from '@shared/todos/model'
import { parseLocalTime } from '@shared/assistant-time'
import { ApiError, api } from '../../lib/api'
import { localeTag, t } from '../../lib/i18n'
import { useOnlineStatus } from '../../lib/hooks'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Field } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { confirm } from '../../components/overlay'
import { durationLabel } from './stats-charts'

type TimeState =
  | { status: 'loading' }
  | { status: 'ready', entries: TodoTimeEntry[] }
  | { status: 'error', message: string }

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function sourceLabel(source: TimeEntrySource): string {
  switch (source) {
    case 'timer': return t('todo.time.source_timer')
    case 'focus': return t('todo.focus.title')
    case 'manual': return t('settings.manual')
  }
}

export function TaskTimeSection({ taskId, timezone }: { taskId: string, timezone: string }) {
  const [state, setState] = useState<TimeState>({ status: 'loading' })
  const [startText, setStartText] = useState('')
  const [endText, setEndText] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const mounted = useRef(true)
  const loadVersion = useRef(0)
  const validationId = useId()
  useOnlineStatus(setOnline)

  const stamp = useMemo(() => new Intl.DateTimeFormat(localeTag(), {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }), [timezone])

  const load = useCallback(async (): Promise<void> => {
    const version = ++loadVersion.current
    setState({ status: 'loading' })
    setActionError(null)
    try {
      const answer = await api.todos.time(taskId)
      if (mounted.current && version === loadVersion.current) {
        setState({ status: 'ready', entries: answer.entries })
      }
    } catch (error) {
      if (mounted.current && version === loadVersion.current) {
        setState({ status: 'error', message: errorMessage(error) })
      }
    }
  }, [taskId])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      loadVersion.current += 1
    }
  }, [load])

  const startAt = parseLocalTime(startText, timezone)
  const endAt = parseLocalTime(endText, timezone)
  const endBeforeStart = startAt !== null && endAt !== null && endAt <= startAt
  const overLimit = startAt !== null && endAt !== null && endAt - startAt > MAX_SINGLE_TIME_ENTRY_MS
  const validationMessage = overLimit
    ? t('todo.time.logged_refused')
    : endBeforeStart
      ? `${t('todo.time.end_label')}: ${t('api.error.bad_request')}`
      : null
  const canSubmit = startAt !== null && endAt !== null && !endBeforeStart && !overLimit
    && online && !saving && state.status !== 'loading'

  const add = async (): Promise<void> => {
    if (!canSubmit || startAt === null || endAt === null) return
    // Check again at the gesture: the browser may not have delivered the offline event yet, and this
    // write deliberately has no offline queue to lose or duplicate it.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setActionError(t('todo.time.logged_offline'))
      return
    }
    setSaving(true)
    setActionError(null)
    try {
      const answer = await api.todos.addTime(taskId, { startAt, endAt })
      if (!mounted.current) return
      setState((current) => current.status === 'ready'
        ? { ...current, entries: [...current.entries, ...answer.entries] }
        : { status: 'ready', entries: answer.entries })
      setStartText('')
      setEndText('')
    } catch (error) {
      if (!mounted.current) return
      setActionError(error instanceof ApiError && error.isOffline
        ? t('todo.time.logged_offline')
        : errorMessage(error))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const remove = async (entry: TodoTimeEntry): Promise<void> => {
    if (deletingId !== null) return
    const end = entry.endAt === null ? t('todo.timer.running') : stamp.format(new Date(entry.endAt))
    const approved = await confirm({
      title: t('common.delete'),
      description: `${stamp.format(new Date(entry.startAt))} – ${end}`,
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!approved || !mounted.current) return
    setDeletingId(entry.id)
    setActionError(null)
    try {
      await api.todos.removeTime(entry.id)
      if (!mounted.current) return
      setState((current) => current.status === 'ready'
        ? { ...current, entries: current.entries.filter((row) => row.id !== entry.id) }
        : current)
    } catch (error) {
      if (mounted.current) setActionError(errorMessage(error))
    } finally {
      if (mounted.current) setDeletingId(null)
    }
  }

  return (
    <section
      aria-label={t('project.time.title')}
      aria-busy={state.status === 'loading' || saving || deletingId !== null}
      className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5">
        <Clock size={12} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
        <h3 className="min-w-0 flex-1 text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
          {t('project.time.title')}
        </h3>
      </div>

      {state.status === 'loading' && (
        <p role="status" className="flex min-h-9 items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <Spinner size={13} />
          {t('common.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div role="alert" className="flex flex-col items-start gap-1.5">
          <p className="text-[length:var(--text-11-5)] text-[var(--danger)]">{t('common.action_failed')}</p>
          <p className="max-w-full break-words text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{state.message}</p>
          <Button size="sm" variant="secondary" onClick={() => { void load() }}>{t('common.retry')}</Button>
        </div>
      )}
      {state.status === 'ready' && state.entries.length === 0 && (
        <p className="py-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('project.time.empty')}</p>
      )}
      {state.status === 'ready' && state.entries.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {state.entries.map((entry) => {
            const start = stamp.format(new Date(entry.startAt))
            const end = entry.endAt === null ? t('todo.timer.running') : stamp.format(new Date(entry.endAt))
            const description = `${start} – ${end}`
            return (
              <li
                key={entry.id}
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1"
              >
                <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{sourceLabel(entry.source)}</span>
                <span className="min-w-0 text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
                  <span>{t('todo.task.start_label')} </span>
                  <time dateTime={new Date(entry.startAt).toISOString()}>{start}</time>
                  <span aria-hidden="true"> → </span>
                  <span>{t('todo.time.end_label')} </span>
                  {entry.endAt === null
                    ? <span>{end}</span>
                    : <time dateTime={new Date(entry.endAt).toISOString()}>{end}</time>}
                </span>
                <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-primary)]">
                  {entry.endAt === null ? '—' : durationLabel(entry.endAt - entry.startAt)}
                </span>
                <span className="ml-auto">
                  <IconButton
                    label={`${t('common.delete')}: ${description}`}
                    size="sm"
                    disabled={deletingId !== null || saving}
                    onClick={() => { void remove(entry) }}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </IconButton>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {!online && (
        <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('todo.time.logged_offline')}
        </p>
      )}
      {actionError && (
        <p role="alert" className="break-words text-[length:var(--text-11-5)] text-[var(--danger)]">{actionError}</p>
      )}

      <form
        className="grid grid-cols-1 gap-2 border-t border-[var(--border-subtle)] pt-2 sm:grid-cols-2"
        onSubmit={(event) => { event.preventDefault(); void add() }}
      >
        <Field label={t('todo.task.start_label')} required>
          <DatePicker
            label={t('todo.task.start_label')}
            value={startText}
            withTime
            invalid={endBeforeStart || overLimit}
            aria-describedby={validationMessage ? validationId : undefined}
            onChange={(value) => { setStartText(value); setActionError(null) }}
          />
        </Field>
        <Field label={t('todo.time.end_label')} required>
          <DatePicker
            label={t('todo.time.end_label')}
            value={endText}
            withTime
            invalid={endBeforeStart || overLimit}
            aria-describedby={validationMessage ? validationId : undefined}
            onChange={(value) => { setEndText(value); setActionError(null) }}
          />
        </Field>
        {validationMessage && (
          <p id={validationId} role="alert" className="text-[length:var(--text-11)] text-[var(--danger)] sm:col-span-2">
            {validationMessage}
          </p>
        )}
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" size="sm" icon={<Plus size={13} aria-hidden="true" />} loading={saving} disabled={!canSubmit}>
            {t('settings.manual')}
          </Button>
        </div>
      </form>
    </section>
  )
}
