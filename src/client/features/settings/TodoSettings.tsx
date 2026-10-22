/**
 * The to-do settings page: the zone its days are read in, the reminder a new task starts with, and
 * the daily and weekly goals the statistics screen measures against.
 *
 * The worker answers `dayEnd` and every due-date comparison from a single stored zone, because "today" is
 * a span in the reader's own day rather than something a browser can compute once it is a thousand
 * kilometres from where the reader wrote the task. That value is the account's scheduling zone — the same
 * one the assistant's automations re-schedule against — and until now it was only reachable from the
 * chat's own settings tab, which left a reader who never opens the assistant looking at a "today" that
 * begins eight hours away from their own.
 *
 * It stays one stored value rather than becoming a second, todo-shaped one: two zones for one account is
 * two answers to "what is today", and the app would have to pick which lie to show.
 *
 * The default reminder is the other value here and it is stored with the note settings, not with the
 * assistant's: it is a rule for tasks the to-do app creates, and the worker reads it when a task arrives
 * without a reminder of its own.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { AssistantSettings, Automation } from '@shared/assistant'
import { isValidTimeZone } from '@shared/assistant-schedule'
import { TODO_GOAL_RANGE, TODO_SAVED_FILTER_MAX, TODO_SAVED_FILTER_NAME_MAX, TODO_SAVED_FILTER_QUERY_MAX } from '@shared/constants'
import { REMIND_OFFSETS, type RemindOffset } from '@shared/todos/model'
import type { SavedTodoFilter } from '@shared/types'
import { t, translateApiError } from '../../lib/i18n'
import { api, ApiError } from '../../lib/api'
import { randomLocalId } from '../../lib/random-id'
import { Button, IconButton } from '../../components/primitives'
import { commitOnEnter, Input, Select, SettingRow, Switch } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { useSession } from '../../store/session'
import { FeedSettings } from './FeedSettings'

/** The hour a daily plan starts at before the reader picks one: the same default the chat's editor offers. */
const DEFAULT_DIGEST_TIME = '09:00'
/** `HH:MM`, 24h — the wall clock a `daily` automation carries. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/

/** What a failed read or write says to the reader: the code the server named when it has one. */
function describeError(cause: unknown): string {
  if (cause instanceof ApiError) return translateApiError(cause.code, cause.message)
  return cause instanceof Error ? cause.message : String(cause)
}

export function TodoSettings() {
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [digest, setDigest] = useState<Automation | null>(null)
  const [digestTime, setDigestTime] = useState(DEFAULT_DIGEST_TIME)
  const [digestState, setDigestState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [digestError, setDigestError] = useState<string | null>(null)
  const [digestBusy, setDigestBusy] = useState(false)
  const zoneId = useId()
  const remindId = useId()
  const digestHintId = useId()
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const defaultRemind = useSession((state) => state.settings.todo.defaultRemind)
  const dailyGoal = useSession((state) => state.settings.todo.dailyGoal) ?? null
  const weeklyGoal = useSession((state) => state.settings.todo.weeklyGoal) ?? null
  const updateSettings = useSession((state) => state.updateSettings)

  useEffect(() => {
    let wanted = true
    void api.assistant.settings()
      .then((answer) => { if (wanted) { setSettings(answer.settings); setError(null) } })
      .catch((cause: unknown) => { if (wanted) setError(describeError(cause)) })
    return () => { wanted = false }
  }, [])

  /**
   * The daily plan is the assistant's own `task_digest` routine, read as the automation it is.
   *
   * The settings page cannot keep a second schedule of its own: the worker fires the automation, and a
   * page that stored "09:00" somewhere else would be a second answer to when the digest runs. A failed
   * read is told apart from an absent routine — the switch stays disabled until the list has answered,
   * because "no digest" and "could not ask" would otherwise both look like an off switch that creates one.
   */
  const loadDigest = async (): Promise<void> => {
    setDigestState('loading')
    try {
      const { automations } = await api.assistant.automations()
      const found = automations.find((entry) => entry.kind === 'task_digest') ?? null
      setDigest(found)
      const stored = found?.schedule.time
      if (stored && TIME_OF_DAY.test(stored)) setDigestTime(stored)
      setDigestError(null)
      setDigestState('ready')
    } catch (cause) {
      setDigestError(describeError(cause))
      setDigestState('failed')
    }
  }

  useEffect(() => {
    // Once per visit: a routine the reader edits in the chat while this page is open is re-read by the
    // retry, and a background poll here would fight that editor for no visible gain.
    void loadDigest()
  }, [])

  const zones = useMemo(() => {
    if (!settings) return [browserZone]
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [browserZone]
    // A stored zone the shipped data set does not name still has to be selectable, or saving anything
    // else would silently move the reader's day.
    return list.includes(settings.timezone) ? list : [settings.timezone, ...list]
  }, [browserZone, settings])

  async function save(timezone: string) {
    setSaving(true)
    try {
      const answer = await api.assistant.saveSettings({ timezone })
      setSettings(answer.settings)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setSaving(false)
    }
  }

  function saveDefaultRemind(offset: RemindOffset): void {
    updateSettings({ todo: { defaultRemind: offset === 'none' ? null : offset } })
  }

  /**
   * Turns the daily plan on or off on the automation the worker already fires.
   *
   * There is no digest yet — the first press creates the routine the chat's own editor would create:
   * a `task_digest` at the chosen wall time, with no model behind it. Every later press is a PATCH, so
   * the row never ends up with two routines that both notify at nine.
   */
  async function saveDigestEnabled(next: boolean): Promise<void> {
    if (!digest && !next) return
    setDigestBusy(true)
    try {
      if (!digest) {
        const answer = await api.assistant.createAutomation({
          name: t('settings.todo_digest'),
          kind: 'task_digest',
          message: '',
          schedule: { type: 'daily', time: digestTime },
          enabled: true,
        })
        setDigest(answer.automation)
      } else {
        const answer = await api.assistant.updateAutomation(digest.id, { enabled: next })
        setDigest(answer.automation)
      }
      setDigestError(null)
    } catch (cause) {
      setDigestError(describeError(cause))
    } finally {
      setDigestBusy(false)
    }
  }

  /** Writes the picked wall time as a daily schedule; the worker arms it in the account's own zone. */
  async function saveDigestTime(next: string): Promise<void> {
    setDigestTime(next)
    if (!TIME_OF_DAY.test(next) || !digest) return
    setDigestBusy(true)
    try {
      const answer = await api.assistant.updateAutomation(digest.id, { schedule: { type: 'daily', time: next } })
      setDigest(answer.automation)
      setDigestError(null)
    } catch (cause) {
      setDigestError(describeError(cause))
      // The field goes back to what is stored, so a refused write cannot look like a saved one.
      const stored = digest.schedule.time
      if (stored && TIME_OF_DAY.test(stored)) setDigestTime(stored)
    } finally {
      setDigestBusy(false)
    }
  }

  if (!settings && !error) return <LoadingBlock />

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2">
          <p className="min-w-0 text-[length:var(--text-12-5)] text-[var(--danger)]">{error}</p>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save(settings?.timezone ?? browserZone)}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {!error && !settings ? null : (
        <SettingRow
          title={t('assistant.settings.timezone')}
          description={settings && settings.timezone !== browserZone
            ? t('assistant.settings.timezone_use_device', { zone: browserZone })
            : t('assistant.settings.timezone_hint')}
          controlId={zoneId}
        >
          <div className="flex items-center gap-2">
            {settings && settings.timezone !== browserZone && isValidTimeZone(browserZone) && (
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save(browserZone)}>
                {t('assistant.settings.timezone_detect')}
              </Button>
            )}
            <Select
              id={zoneId}
              value={settings?.timezone ?? browserZone}
              disabled={saving}
              onChange={(event) => void save(event.target.value)}
              className="max-w-[240px]"
            >
              {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </Select>
          </div>
        </SettingRow>
      )}
      <SettingRow
        title={t('settings.todo_digest')}
        description={(
          <div className="flex flex-col gap-1">
            <span id={digestHintId}>
              {t('settings.todo_digest_hint', { zone: settings?.timezone ?? browserZone })}
            </span>
            {digestError && <span role="alert" className="text-[var(--danger)]">{digestError}</span>}
          </div>
        )}
      >
        <div className="flex items-center gap-2">
          {digestState === 'failed' && (
            <Button size="sm" variant="ghost" disabled={digestBusy} onClick={() => void loadDigest()}>
              {t('common.retry')}
            </Button>
          )}
          <Input
            type="time"
            aria-label={t('settings.todo_digest_time')}
            aria-describedby={digestHintId}
            value={digestTime}
            disabled={digestBusy || digestState !== 'ready'}
            onChange={(event) => void saveDigestTime(event.target.value)}
            className="w-[132px]"
          />
          <Switch
            checked={digest?.enabled ?? false}
            disabled={digestBusy || digestState !== 'ready'}
            label={t('settings.todo_digest')}
            onChange={(next) => void saveDigestEnabled(next)}
          />
        </div>
      </SettingRow>
      <SettingRow
        title={t('settings.todo_default_remind')}
        description={t('settings.todo_default_remind_hint')}
        controlId={remindId}
      >
        <Select
          id={remindId}
          value={defaultRemind ?? 'none'}
          onChange={(event) => saveDefaultRemind(event.target.value as RemindOffset)}
          className="max-w-[240px]"
        >
          {REMIND_OFFSETS.map((offset) => (
            <option key={offset} value={offset}>
              {offset === 'none' ? t('settings.todo_default_remind_none') : t(`todo.remind.${offset}`)}
            </option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow
        title={t('settings.todo_goals')}
        description={t('settings.todo_goals_hint')}
      >
        <div className="flex items-center gap-2">
          <GoalInput
            label={t('todo.goal.daily')}
            value={dailyGoal}
            onChange={(value) => updateSettings({ todo: { dailyGoal: value } })}
          />
          <GoalInput
            label={t('todo.goal.weekly')}
            value={weeklyGoal}
            onChange={(value) => updateSettings({ todo: { weeklyGoal: value } })}
          />
        </div>
      </SettingRow>
      <SavedFiltersRow />
      <FeedSettings />
      <TodoImportRow />
    </div>
  )
}

/**
 * One of the two goals: a whole count inside `TODO_GOAL_RANGE`, where an empty field or zero leaves
 * the goal off.
 *
 * The field keeps what is being typed while it has focus. Writing every keystroke straight back into
 * the stored setting would let the merge rewrite a half-typed number under the caret — a leading zero
 * vanishing, or a fraction snapping — so the draft is dropped on blur, when the stored count is the
 * one the reader should see.
 */
function GoalInput({ label, value, onChange }: {
  label: string
  value: number | null
  onChange: (value: number | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value === null ? '' : String(value))
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={TODO_GOAL_RANGE[0]}
      max={TODO_GOAL_RANGE[1]}
      aria-label={label}
      value={shown}
      onChange={(event) => {
        const text = event.target.value
        setDraft(text)
        if (text === '') {
          onChange(null)
          return
        }
        const parsed = Number(text)
        if (!Number.isFinite(parsed)) return
        const rounded = Math.round(parsed)
        // The merge applies the same edges; the field stops a spinner from ever showing a count it
        // would not keep.
        onChange(rounded <= TODO_GOAL_RANGE[0] ? null : Math.min(TODO_GOAL_RANGE[1], rounded))
      }}
      onBlur={() => setDraft(null)}
      className="w-24 tabular-nums"
    />
  )
}

/** The empty list a settings object without the field reads as; one instance, so the selector is stable. */
const NO_SAVED_FILTERS: SavedTodoFilter[] = []

/**
 * The saved filter lines: a name, the line itself, and what is already kept.
 *
 * A saved filter is a screen the to-do sidebar can reopen, so the row keeps the line exactly as it was
 * typed — the grammar is read when the sidebar opens it, not when it is saved. Both halves are
 * required: a line with no name is a row nobody can pick out, and a name with no line opens an
 * unfiltered screen. The list is the same one the sidebar draws, with the same delete action, because
 * a shortcut removed in one place must not linger in the other.
 */
function SavedFiltersRow() {
  const saved = useSession((state) => state.settings.todo.savedFilters) ?? NO_SAVED_FILTERS
  const updateSettings = useSession((state) => state.updateSettings)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const nameId = useId()
  const queryId = useId()
  const canSave = name.trim() !== '' && query.trim() !== '' && saved.length < TODO_SAVED_FILTER_MAX

  /** Writes the whole list, because the settings merge stores a list rather than a row. */
  const add = (): void => {
    if (!canSave) return
    updateSettings({
      todo: {
        savedFilters: [...saved, { id: randomLocalId('filter'), name: name.trim(), query: query.trim() }],
      },
    })
    setName('')
    setQuery('')
  }

  const remove = (id: string): void => {
    updateSettings({ todo: { savedFilters: saved.filter((entry) => entry.id !== id) } })
  }

  return (
    <SettingRow
      title={t('settings.todo_saved_filters')}
      description={(
        <div className="flex flex-col gap-1">
          <span>{t('settings.todo_saved_filters_hint')}</span>
          <code className="break-words text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('settings.todo_saved_filters_syntax')}
          </code>
        </div>
      )}
    >
      <div className="flex w-full max-w-[460px] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={nameId}
            aria-label={t('settings.todo_saved_filter_name')}
            maxLength={TODO_SAVED_FILTER_NAME_MAX}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Input
            id={queryId}
            aria-label={t('settings.todo_saved_filter_query')}
            placeholder={t('settings.todo_saved_filters_syntax')}
            maxLength={TODO_SAVED_FILTER_QUERY_MAX}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { commitOnEnter(event, add) }}
            className="min-w-0 flex-[2]"
          />
          <Button size="sm" disabled={!canSave} onClick={add}>{t('settings.todo_saved_filter_add')}</Button>
        </div>
        {saved.length === 0 ? (
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('settings.todo_saved_filter_empty')}</p>
        ) : (
          <ul aria-label={t('settings.todo_saved_filters')} className="flex flex-col gap-1">
            {saved.map((entry) => (
              <li key={entry.id} className="flex min-h-8 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2">
                <span className="min-w-0 shrink-0 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{entry.name}</span>
                <code className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">{entry.query}</code>
                <IconButton
                  label={t('todo.saved_filter.delete', { name: entry.name })}
                  size="xs"
                  onClick={() => remove(entry.id)}
                >
                  <X size={12} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingRow>
  )
}

/**
 * The CSV import row.
 *
 * The worker already answers with what happened row by row; this row only chooses the document and the one
 * rule a CSV cannot carry — what "already imported" should mean. A refused row is a line number the reader
 * can fix, so the answer is printed rather than swallowed into a toast.
 */
function TodoImportRow() {
  const fileId = useId()
  const [file, setFile] = useState<File | null>(null)
  const [conflict, setConflict] = useState<'skip' | 'newer' | 'duplicate'>('skip')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    if (!file) {
      setProblem(t('settings.todo_import_choose'))
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const result = await api.todos.importCsv(file, conflict)
      setAnswer(t('settings.todo_import_result', { created: result.created, updated: result.updated, skipped: result.skipped }))
      setFile(null)
    } catch (cause) {
      setProblem(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingRow
      title={t('settings.todo_import')}
      description={(
        <div className="flex flex-col gap-1">
          <span id={fileId}>{t('settings.todo_import_hint')}</span>
          {(answer || problem) && (
            <span role="status" className={problem ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]'}>{problem ?? answer}</span>
          )}
        </div>
      )}
      controlId={fileId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={fileId}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null)
            setAnswer(null)
            setProblem(null)
          }}
          className="min-h-9 max-w-[240px] text-[length:var(--text-11-5)] text-[var(--text-secondary)] file:mr-2 file:rounded-[var(--r-sm)] file:border-0 file:bg-[var(--bg-hover)] file:px-2 file:py-1 file:text-[var(--text-secondary)]"
        />
        <Select
          aria-label={t('settings.todo_import_conflict')}
          value={conflict}
          disabled={busy}
          onChange={(event) => setConflict(event.target.value as 'skip' | 'newer' | 'duplicate')}
          className="max-w-[170px]"
        >
          <option value="skip">{t('settings.todo_import_conflict_skip')}</option>
          <option value="newer">{t('settings.todo_import_conflict_newer')}</option>
          <option value="duplicate">{t('settings.todo_import_conflict_duplicate')}</option>
        </Select>
        <Button size="sm" disabled={busy} onClick={() => void run()}>{t('settings.todo_import_action')}</Button>
      </div>
    </SettingRow>
  )
}
