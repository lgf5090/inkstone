/**
 * Reminders and routines.
 *
 * The schedule editor builds a `ScheduleSpec` and shows the sentence it means before anything is sent,
 * because the commonest mistake in a scheduler is a form that says one thing and stores another. The
 * sentence is assembled from the locale catalog, so a reader whose interface is Chinese reads the
 * schedule in their own language rather than as an English string pasted next to it.
 *
 * Times are typed as wall-clock readings in the assistant's timezone, which is what "remind me at 9"
 * means to the reader; the conversion is the server's job and lives in `assistant-schedule`.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { AlarmClock, Bell, Bot, FileText, ListChecks, Plus, Trash2, X } from 'lucide-react'
import type { Automation, AutomationKind, AutomationRun } from '@shared/assistant'
import type { NoteSummary } from '@shared/types'
import { INTERVAL_MAX_MINUTES, INTERVAL_MIN_MINUTES, computeNextRun, scheduleSummary, type ScheduleSpec } from '@shared/assistant-schedule'
import { cn } from '../../lib/cn'
import { localeTag, t, type MessageKey } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { api } from '../../lib/api'
import { Badge, Button, IconButton } from '../../components/primitives'
import { Field, Input, Segmented, Select, Switch } from '../../components/form'
import { DatePicker, TimeField } from '../../components/date-picker'
import { Modal, confirm } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { AssistantHeader } from './AssistantHeader'
import { useAssistant } from './assistant-store'
import { formatInZone } from './time-format'
import { NotePicker } from './ComposerControls'
import { useVaultFolders, type VaultFolderOption } from './NoteScopePicker'
import { notePointer } from './memory-note'
import { openNote } from './note-links'
import { useNotes } from '../../store/notes'

const KIND_META: Record<AutomationKind, { label: MessageKey, hint: MessageKey, icon: typeof Bell }> = {
  reminder: { label: 'assistant.automations.kind.reminder', hint: 'assistant.automations.kind.reminder_hint', icon: Bell },
  task_digest: { label: 'assistant.automations.kind.task_digest', hint: 'assistant.automations.kind.task_digest_hint', icon: ListChecks },
  assistant_prompt: { label: 'assistant.automations.kind.assistant_prompt', hint: 'assistant.automations.kind.assistant_prompt_hint', icon: Bot },
  note_write: { label: 'assistant.automations.kind.note_write', hint: 'assistant.automations.kind.note_write_hint', icon: FileText },
}

const DAY_KEYS = [
  'assistant.weekday.7', 'assistant.weekday.1', 'assistant.weekday.2', 'assistant.weekday.3',
  'assistant.weekday.4', 'assistant.weekday.5', 'assistant.weekday.6',
] as const

/**
 * A weekday list in the reader's own words, joined the way their language joins lists. The schedule
 * sentence cannot be one shared string: the day words and the separator between them are both locale.
 */
function describeDays(days: number[]): string {
  return new Intl.ListFormat(localeTag(), { type: 'unit' }).format(days.map((day) => t(DAY_KEYS[day]!)))
}

/**
 * The one sentence a writing schedule owes the reader: which page it fills, or which folder it files into.
 *
 * The row carries ids and nothing else, so the names are read from the notebook's own lists rather than
 * copied into the schedule — a copied title goes stale the day the page is renamed. A page the notebook no
 * longer opens is said as gone, in the same three states the memory row keeps: a note list the browser has
 * not read yet says nothing about whether the page exists, and claiming it gone would be an invented fact.
 * `null` is only ever a schedule with no target at all, which the create path refuses; saying nothing beats
 * a sentence naming an empty one.
 */
function targetSentence(
  automation: Automation,
  notes: Record<string, NoteSummary>,
  folders: VaultFolderOption[],
  hydrated: boolean,
): string | null {
  if (automation.targetNoteId) {
    const name = notes[automation.targetNoteId]?.title ?? automation.targetNoteId
    const pointer = notePointer({ noteId: automation.targetNoteId }, notes, hydrated)
    return pointer.state === 'gone'
      ? t('assistant.automations.target_page_gone', { name })
      : t('assistant.automations.onto', { name })
  }
  if (automation.targetFolderId) {
    return t('assistant.automations.into', { name: folders.find((folder) => folder.id === automation.targetFolderId)?.path ?? automation.targetFolderId })
  }
  return null
}

export function AutomationsView() {
  const automations = useAssistant((state) => state.automations)
  const runs = useAssistant((state) => state.runs)
  const loadAutomations = useAssistant((state) => state.loadAutomations)
  const toggleAutomation = useAssistant((state) => state.toggleAutomation)
  const removeAutomation = useAssistant((state) => state.removeAutomation)
  const timezone = useAssistant((state) => state.settings?.timezone)
  // Read once for the whole screen: a folder's name is needed by every schedule row and by the editor,
  // and the hook fires its own request per call.
  const folders = useVaultFolders()
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void loadAutomations()
  }, [loadAutomations])

  const { active, inactive, upcoming } = useMemo(() => {
    return {
      active: automations.filter((entry) => entry.enabled),
      inactive: automations.filter((entry) => !entry.enabled),
      upcoming: automations
        .filter((entry) => entry.enabled && entry.nextRun !== null)
        .sort((left, right) => (left.nextRun ?? 0) - (right.nextRun ?? 0))
        .slice(0, 6),
    }
  }, [automations])

  const failedRuns = runs.filter((run) => run.status === 'error')

  return (
    <div className="no-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-5 md:px-8">
        <AssistantHeader
          title={t('assistant.automations.title')}
          description={t('assistant.automations.description', { timezone: timezone ?? '' })}
          action={(
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
              {t('assistant.automations.new')}
            </Button>
          )}
        />

        {!automations.length && !runs.length ? (
          <Empty
            art="notes"
            title={t('assistant.automations.empty')}
            description={t('assistant.automations.empty_hint')}
            action={<Button size="sm" variant="secondary" onClick={() => setCreating(true)}>{t('assistant.automations.new')}</Button>}
          />
        ) : (
          <>
            {upcoming.length > 0 && (
              <section>
                <p className="mb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                  {t('assistant.automations.upcoming')}
                </p>
                <ul className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
                  {upcoming.map((automation) => (
                    <li key={automation.id} className="min-w-[160px] shrink-0 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2.5">
                      <AlarmClock size={14} className="text-[var(--accent)]" />
                      <p className="mt-1.5 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{automation.name}</p>
                      <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{relativeTime(automation.nextRun ?? 0)}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {active.length > 0 && <Section heading="assistant.automations.active" automations={active} folders={folders} timezone={timezone} onToggle={toggleAutomation} onDelete={removeAutomation} />}
            {inactive.length > 0 && <Section heading="assistant.automations.paused" automations={inactive} folders={folders} timezone={timezone} onToggle={toggleAutomation} onDelete={removeAutomation} />}

            <section>
              <p className="mb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                {t('assistant.automations.recent')}
              </p>
              {!runs.length ? (
                <p className="text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.automations.no_runs')}</p>
              ) : (
                <ul className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                  {runs.slice(0, 12).map((run) => <RunRow key={run.id} run={run} timezone={timezone} />)}
                </ul>
              )}
            </section>

            {failedRuns.length > 0 && (
              <section>
                <p className="mb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--danger)]">
                  {t('assistant.automations.failed')}
                </p>
                <ul className="overflow-hidden rounded-[var(--r-lg)] border border-[color-mix(in_oklab,var(--danger)_30%,transparent)] bg-[var(--bg-surface)]">
                  {failedRuns.slice(0, 6).map((run) => <RunRow key={run.id} run={run} timezone={timezone} />)}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      <AutomationForm open={creating} onClose={() => setCreating(false)} folders={folders} timezone={timezone} />
    </div>
  )
}

function Section({
  heading,
  automations,
  folders,
  timezone,
  onToggle,
  onDelete,
}: {
  heading: MessageKey
  automations: Automation[]
  folders: VaultFolderOption[]
  timezone?: string
  onToggle: (automation: Automation) => void
  onDelete: (id: string) => Promise<void>
}) {
  const notes = useNotes((state) => state.notes)
  const hydrated = useNotes((state) => state.hydrated)
  return (
    <section>
      <p className="mb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{t(heading)}</p>
      <ul className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        {automations.map((automation) => {
          const meta = KIND_META[automation.kind]
          const Icon = meta.icon
          const summary = scheduleSummary(automation.schedule, describeDays)
          // Which page this refills, or which folder it files into, in the notebook's own words.
          const target = automation.kind === 'note_write' ? targetSentence(automation, notes, folders, hydrated) : null
          return (
            <li key={automation.id} className="flex items-start gap-2.5 border-b border-[var(--border-subtle)] px-3 py-2.5 transition-colors duration-[var(--dur-fast)] last:border-b-0 hover:bg-[var(--bg-hover)]">
              <span className={cn('mt-0.5 shrink-0 rounded-[var(--r-sm)] p-1.5', automation.enabled ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'bg-[var(--bg-inset)] text-[var(--text-quaternary)]')}>
                <Icon size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="min-w-0 truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{automation.name}</p>
                  {automation.status === 'failed' && <Badge tone="danger">{t('assistant.automations.status_failed')}</Badge>}
                  {automation.status === 'completed' && <Badge>{t('assistant.automations.status_completed')}</Badge>}
                </div>
                <p className="mt-0.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">{t(summary.key, summary.params ?? {})}</p>
                {target && <p className="mt-0.5 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{target}</p>}
                <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {automation.enabled && automation.nextRun !== null
                    ? `${t('assistant.automations.next')} ${formatInZone(automation.nextRun, timezone)}`
                    : automation.status === 'completed'
                      ? t('assistant.automations.finished')
                      : automation.enabled
                        ? t('assistant.automations.not_scheduled')
                        : t('assistant.automations.paused_row')}
                  {automation.lastRun !== null && ` · ${t('assistant.automations.last_run', { when: relativeTime(automation.lastRun) })}`}
                  {automation.runCount > 0 && ` · ${t('assistant.automations.runs_count', { count: automation.runCount })}`}
                </p>
                {automation.lastError && <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--danger)]">{automation.lastError}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {automation.status !== 'completed' && (
                  <Switch
                    checked={automation.enabled}
                    onChange={() => onToggle(automation)}
                    label={automation.enabled ? t('assistant.automations.pause') : t('assistant.automations.resume')}
                  />
                )}
                <IconButton
                  label={t('assistant.automations.delete')}
                  size="xs"
                  onClick={() => {
                    void confirm({
                      title: t('assistant.automations.delete'),
                      description: t('assistant.automations.delete_hint', { name: automation.name }),
                      confirmLabel: t('assistant.automations.delete'),
                      tone: 'danger',
                    }).then((yes) => {
                      if (yes) void onDelete(automation.id)
                    })
                  }}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * One finished or running schedule, with what it left behind.
 *
 * The receipt names the page it wrote and reaches it, because "Wrote “Morning log”" that the reader cannot
 * open is half an answer. The page is named from the notebook rather than from the run: the server holds the
 * id, and the id is the only thing that survives a rename. A page the notebook no longer has is said as gone
 * instead of offered as an entry that goes nowhere — the same three states `memory-note.ts` works out for a
 * fact's note, including the one that a list the browser has not read yet does not prove anything missing.
 */
function RunRow({ run, timezone }: { run: AutomationRun, timezone?: string }) {
  const notes = useNotes((state) => state.notes)
  const hydrated = useNotes((state) => state.hydrated)
  const pointer = notePointer({ noteId: run.noteId }, notes, hydrated)
  // The page is worth an entry only while there is a page to reach, and its accessible name is the verb the
  // entry performs plus the title: a reader who hears "Open the page it wrote" four times in a row of runs
  // has not been told which one any of them is.
  const entry = pointer.state === 'open' && run.noteId
    ? {
      id: run.noteId,
      text: pointer.title ?? t('assistant.automations.run_open_note'),
      name: pointer.title ? `${t('assistant.automations.run_open_note')}: ${pointer.title}` : t('assistant.automations.run_open_note'),
    }
    : null
  return (
    <li className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-12-5)] transition-colors duration-[var(--dur-fast)] last:border-b-0 hover:bg-[var(--bg-hover)]">
      <div className="min-w-0">
        <p className="truncate text-[var(--text-primary)]">{run.automationName}</p>
        <p className={cn('truncate text-[length:var(--text-11)]', run.status === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]')}>
          {run.error ?? run.result ?? (run.status === 'running' ? t('assistant.automations.running') : '')}
        </p>
        {entry && (
          <Button size="sm" variant="ghost" className="mt-1" icon={<FileText size={12} />} aria-label={entry.name} onClick={() => openNote(entry.id)}>
            {entry.text}
          </Button>
        )}
        {pointer.state === 'gone' && (
          <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.automations.run_note_gone')}</p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <Badge tone={run.status === 'error' ? 'danger' : 'neutral'}>
          {t(run.status === 'success' ? 'assistant.automations.run_success' : run.status === 'error' ? 'assistant.automations.run_error' : run.status === 'skipped' ? 'assistant.automations.run_skipped' : 'assistant.automations.running')}
        </Badge>
        <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{formatInZone(run.startedAt, timezone, { dateOnly: false })}</p>
      </div>
    </li>
  )
}

/**
 * The page a writing routine refills, named from the notebook.
 *
 * The schedule row only carries an id, and a reader is not going to recognise one; the title is looked up
 * where the notebook keeps it rather than copied into the schedule, which would go stale the day the page
 * is renamed. A page the vault no longer holds keeps its id on the chip — the schedule is still pointed at
 * that id, and hiding it would show a target the reader did not choose.
 */
function TargetPageChip({ id, onClear }: { id: string, onClear: () => void }) {
  const notes = useNotes((state) => state.notes)
  const title = notes[id]?.title ?? id
  return (
    <li className="flex items-center gap-1 rounded-[var(--r-sm)] bg-[var(--bg-surface)] py-0.5 pr-0.5 pl-1.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
      <FileText size={11} className="shrink-0 text-[var(--text-quaternary)]" />
      <span className="max-w-[200px] truncate">{title}</span>
      <IconButton size="sm" label={t('assistant.automations.target_page_clear', { name: title })} onClick={onClear}>
        <X size={11} />
      </IconButton>
    </li>
  )
}

function AutomationForm({ open, onClose, folders, timezone }: { open: boolean, onClose: () => void, folders: VaultFolderOption[], timezone?: string }) {
  const addAutomation = useAssistant((state) => state.addAutomation)
  const [kind, setKind] = useState<AutomationKind>('reminder')
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [type, setType] = useState<ScheduleSpec['type']>('once')
  const [at, setAt] = useState(() => tomorrowAt9(timezone))
  const [time, setTime] = useState('09:00')
  const [days, setDays] = useState<number[]>([1])
  const [day, setDay] = useState(1)
  const [minutes, setMinutes] = useState(60)
  // The target of a writing routine: file the answer in a folder, or refill one page. The server accepts
  // exactly one of the two ids and refuses a schedule that names both or neither, so the form asks which
  // of the two the reader means — and switching drops the other, so no id the reader has taken off screen
  // can still ride along in the body.
  const [target, setTarget] = useState<'folder' | 'note'>('folder')
  const [folderId, setFolderId] = useState('')
  const [noteId, setNoteId] = useState('')
  const [pickingNote, setPickingNote] = useState(false)
  const targetHeadingId = useId()
  const targetProblemId = useId()

  const schedule: ScheduleSpec = type === 'once'
    ? { type, at }
    : type === 'interval'
      ? { type, minutes: clamp(minutes, INTERVAL_MIN_MINUTES, INTERVAL_MAX_MINUTES) }
      : type === 'weekly'
        ? { type, time, days: days.length ? days : [1] }
        : type === 'monthly'
          ? { type, time, day: clamp(day, 1, 31) }
          : { type, time }

  const summary = scheduleSummary(schedule, describeDays)
  const needsMessage = kind !== 'task_digest'
  const writes = kind === 'note_write'
  // Why the routine cannot be saved yet, in the reader's language and on the screen — not in a hover hint on
  // a dead button. A folder list that has not arrived is told apart from a notebook with no folders at all
  // only as far as it can be: `useVaultFolders` answers with what it has, so the sentence covers both.
  const targetProblem = !writes
    ? null
    : target === 'folder'
      ? folders.length === 0
        ? t('assistant.automations.target_folder_none')
        : folderId === '' ? t('assistant.automations.target_folder_required') : null
      : noteId === '' ? t('assistant.automations.target_note_required') : null
  // The picker can be cleared, so a one-off may have no time on it yet; only a filled one-off can be
  // in the past, which a repeating rule never is because it always has a next occurrence.
  const missingAt = type === 'once' && at === ''
  const inThePast = type === 'once' && !missingAt && computeNextRun(schedule, timezone ?? 'UTC', new Date()) === null

  const create = async () => {
    // The store reports the outcome rather than swallowing it: a refused create must leave the dialog
    // and its words exactly where they are, not close over an automation that was never made.
    const made = await addAutomation({
      name: name.trim() || message.trim().slice(0, 80) || t(KIND_META[kind].label),
      kind,
      message,
      schedule,
      enabled: true,
      // Exactly one half of the target, named as the route names it (`folderId` / `noteId`); the row the
      // server hands back calls them `targetFolderId` / `targetNoteId`.
      ...(writes ? (target === 'folder' ? { folderId } : { noteId }) : {}),
    })
    if (!made) return
    setName('')
    setMessage('')
    setFolderId('')
    setNoteId('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('assistant.automations.new')}
      width={520}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            onClick={() => { void create() }}
            disabled={(needsMessage && !message.trim()) || inThePast || missingAt || targetProblem !== null}
            aria-describedby={targetProblem ? targetProblemId : undefined}
          >
            {t('assistant.automations.create')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(Object.keys(KIND_META) as AutomationKind[]).map((entry) => {
            const Icon = KIND_META[entry].icon
            const active = entry === kind
            return (
              <button
                key={entry}
                type="button"
                aria-pressed={active}
                onClick={() => setKind(entry)}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-[var(--r-md)] border px-2 py-2.5 text-[length:var(--text-11)] font-medium',
                  'transition-colors duration-[var(--dur-fast)]',
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <Icon size={15} />
                {t(KIND_META[entry].label)}
              </button>
            )
          })}
        </div>
        <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">{t(KIND_META[kind].hint)}</p>

        <Field label={t('assistant.automations.name')} hint={t('assistant.automations.name_optional')}>
          <Input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </Field>
        {needsMessage && (
          <Field label={kind === 'reminder' ? t('assistant.automations.message') : t('assistant.automations.prompt')}>
            <Input value={message} maxLength={4000} onChange={(event) => setMessage(event.target.value)} />
          </Field>
        )}

        {writes && (
          <div className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5">
            <p id={targetHeadingId} className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
              {t('assistant.automations.target')}
            </p>
            <Segmented
              value={target}
              onChange={(next) => {
                setTarget(next)
                // One target only, and one that is impossible to hold by accident: the choice the reader
                // switched away from goes with it, so a hidden id cannot be sent under a different name.
                if (next === 'folder') setNoteId('')
                else setFolderId('')
              }}
              options={[
                { value: 'folder', label: t('assistant.automations.target_folder') },
                { value: 'note', label: t('assistant.automations.target_note') },
              ]}
              size="sm"
              className="self-start"
              aria-labelledby={targetHeadingId}
              aria-describedby={targetProblem ? targetProblemId : undefined}
              aria-required
            />
            {target === 'folder' && folders.length > 0 && (
              <Field label={t('assistant.automations.target_folder')}>
                <Select value={folderId} onChange={(event) => setFolderId(event.target.value)}>
                  <option value="">{t('assistant.automations.target_none')}</option>
                  {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
                </Select>
              </Field>
            )}
            {target === 'note' && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={() => setPickingNote(true)}>
                  {t('assistant.automations.target_page_pick')}
                </Button>
                {noteId && (
                  <ul className="flex flex-wrap gap-1">
                    <TargetPageChip id={noteId} onClear={() => setNoteId('')} />
                  </ul>
                )}
              </div>
            )}
            {targetProblem && (
              <p id={targetProblemId} className="text-[length:var(--text-11)] leading-relaxed text-[var(--danger)]">
                {targetProblem}
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('assistant.automations.repeat')}>
            <Select value={type} onChange={(event) => setType(event.target.value as ScheduleSpec['type'])}>
              <option value="once">{t('assistant.automations.repeat_once')}</option>
              <option value="daily">{t('assistant.automations.repeat_daily')}</option>
              <option value="weekly">{t('assistant.automations.repeat_weekly')}</option>
              <option value="monthly">{t('assistant.automations.repeat_monthly')}</option>
              <option value="interval">{t('assistant.automations.repeat_interval')}</option>
            </Select>
          </Field>
          {type === 'once' ? (
            <Field label={t('assistant.automations.when')}>
              <DatePicker withTime label={t('assistant.automations.when')} value={at} onChange={setAt} />
            </Field>
          ) : type === 'interval' ? (
            <Field label={t('assistant.automations.minutes')}>
              <Input type="number" min={INTERVAL_MIN_MINUTES} max={INTERVAL_MAX_MINUTES} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} />
            </Field>
          ) : (
            <Field label={t('assistant.automations.time')}>
              <TimeField label={t('assistant.automations.time')} value={time} onChange={setTime} />
            </Field>
          )}
        </div>

        {type === 'weekly' && (
          <div role="group" aria-label={t('assistant.automations.days')} className="flex flex-wrap gap-1">
            {DAY_KEYS.map((key, index) => {
              const on = days.includes(index)
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setDays(on ? days.filter((entry) => entry !== index) : [...days, index])}
                  className={cn(
                    'h-8 w-12 rounded-[var(--r-sm)] border text-[length:var(--text-11)] font-medium',
                    on
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                      : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  {t(key)}
                </button>
              )
            })}
          </div>
        )}
        {type === 'monthly' && (
          <Field label={t('assistant.automations.day_of_month')} hint={t('assistant.automations.day_of_month_hint')}>
            <Input type="number" min={1} max={31} value={day} onChange={(event) => setDay(Number(event.target.value))} />
          </Field>
        )}

        <p className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
          {t(summary.key, summary.params ?? {})}
          {timezone && ` · ${timezone}`}
          {missingAt && <span className="ml-1 text-[var(--danger)]">{t('assistant.automations.when_required')}</span>}
          {inThePast && <span className="ml-1 text-[var(--danger)]">{t('assistant.automations.past_warning')}</span>}
        </p>
      </div>

      {writes && (
        // The notebook's own search, the same one the composer's citation picker uses: a routine that
        // rewrites a page has to be pointed at one the reader can name, and typing an id is not naming it.
        <NotePicker
          open={pickingNote}
          onClose={() => setPickingNote(false)}
          title={t('assistant.automations.target_page_pick')}
          onPick={(row) => {
            setNoteId(row.id)
            setPickingNote(false)
          }}
          search={async (query) => {
            // The same guard the project editor's picker uses: a retry against a cleared box still has to
            // answer with pages rather than with "nothing matches".
            const response = await api.search(query || t('assistant.attach.note_prompt'), 12)
            return response.results.map((hit) => ({ id: hit.note.id, title: hit.note.title }))
          }}
        />
      )}
    </Modal>
  )
}

function clamp(value: number, min: number, max: number): number {
  const numeric = Number.isFinite(value) ? Math.trunc(value) : min
  return Math.min(max, Math.max(min, numeric))
}

/**
 * Tomorrow at nine, in the reader's own calendar day.
 *
 * The reference project built this from the browser's date while the schedule was read in the
 * assistant's timezone, so a reader in an eastern zone got a reminder that had already happened.
 */
function tomorrowAt9(timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone ?? undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Date.now() + 86_400_000))
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '01'
  return `${read('year')}-${read('month')}-${read('day')}T09:00`
}
