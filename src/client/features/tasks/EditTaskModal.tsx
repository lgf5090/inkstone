/**
 * The task edit form.
 *
 * One field per thing a task line says, and nothing the reader did not ask for: the dependency and
 * identity fields are shown because a task that waits on another is confusing without saying so, but
 * they are read only — an id is minted when something starts depending on this task, not typed here.
 *
 * The form holds text, not dates. A half-typed `2026-13` is something a reader types on the way to a
 * real date, so the answer is to say which box is wrong and leave the words in place, rather than
 * blanking the field or refusing the whole form.
 */
import { useState } from 'react'
import { Button } from '../../components/primitives'
import { Field, Input, Select } from '../../components/form'
import { Modal } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { Priority } from '../../lib/tasks/model/priority'
import { OnCompletion } from '../../lib/tasks/model/on-completion'
import {
  EDIT_DATE_FIELDS,
  describeRecurrence,
  type DraftErrors,
  type EditDateField,
  type TaskDraft,
} from '../../lib/tasks/edit/task-editor'
import type { MessageKey } from '@shared/locales/en-US'

const DATE_KEYS: Record<EditDateField, MessageKey> = {
  createdDate: 'tasks.edit_created',
  startDate: 'tasks.edit_start',
  scheduledDate: 'tasks.edit_scheduled',
  dueDate: 'tasks.edit_due',
  cancelledDate: 'tasks.edit_cancelled',
  doneDate: 'tasks.edit_done',
}

const PRIORITY_KEYS: Record<Priority, MessageKey> = {
  [Priority.Highest]: 'tasks.priority_highest',
  [Priority.High]: 'tasks.priority_high',
  [Priority.Medium]: 'tasks.priority_medium',
  [Priority.None]: 'tasks.priority_none',
  [Priority.Low]: 'tasks.priority_low',
  [Priority.Lowest]: 'tasks.priority_lowest',
}

export interface EditTaskModalProps {
  /** The draft the form opens with, read off the line by whoever opened it. */
  draft: TaskDraft
  /** Every status this reader can move the task to, in their own order. */
  statuses: Array<{ symbol: string; name: string }>
  /** What the model makes of the draft, so the form can name the field that failed. */
  validate: (draft: TaskDraft, statusSymbol: string) => DraftErrors
  onClose: () => void
  /** Writes the line. Resolves once the note has the new text; rejects if it refused. */
  onSave: (draft: TaskDraft, statusSymbol: string) => Promise<void>
}

export function EditTaskModal({ draft: first, statuses, validate, onClose, onSave }: EditTaskModalProps) {
  const [draft, setDraft] = useState<TaskDraft>(first)
  const [errors, setErrors] = useState<DraftErrors | null>(null)
  const [saving, setSaving] = useState(false)
  const recurrence = describeRecurrence(draft, new Date())
  const recurrenceHint = recurrence.problem === 'invalid'
    ? t('tasks.edit_recurrence_invalid')
    : recurrence.problem === 'needs-a-date'
      ? t('tasks.edit_recurrence_needs_date')
      : recurrence.text !== ''
        ? t('tasks.edit_recurrence_next', { value0: recurrence.text })
        : t('tasks.edit_recurrence_hint')
  const noDescription = draft.description.trim() === ''

  const patch = (change: Partial<TaskDraft>): void => {
    setDraft((current) => ({ ...current, ...change }))
  }

  async function save(): Promise<void> {
    const found = validate(draft, draft.statusSymbol)
    const invalid = found.recurrence !== 'none' || Object.keys(found.dates).length > 0
    setErrors(invalid ? found : null)
    if (invalid) return
    setSaving(true)
    try {
      await onSave(draft, draft.statusSymbol)
      onClose()
    } catch {
      // The caller has already said what it could not do — a note that moved, a write that was
      // refused. The form stays open with the reader's words in it, which is the whole point.
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('tasks.edit_title')}
      width={620}
      dismissible={!saving}
      footer={(<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving || noDescription}>
          {t('common.save')}
        </Button>
      </>)}
    >
      <div className="space-y-3 px-4 pb-4 md:px-5">
        <Field
          label={t('tasks.edit_description')}
          required
          hint={noDescription ? t('tasks.edit_description_required') : undefined}
        >
          <Input
            value={draft.description}
            aria-invalid={noDescription || undefined}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('tasks.edit_status')}>
            <Select value={draft.statusSymbol} onChange={(event) => patch({ statusSymbol: event.target.value })}>
              {statuses.map((status) => (
                // The empty symbol is a real option — an unticked box — and two statuses can share a
                // name while not sharing a character, so the character is the key.
                <option key={status.symbol || 'unticked'} value={status.symbol}>{status.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('tasks.edit_priority')}>
            <Select
              value={String(draft.priority)}
              onChange={(event) => patch({ priority: event.target.value as Priority })}
            >
              {Object.values(Priority).map((value) => (
                <option key={value} value={String(value)}>{t(PRIORITY_KEYS[value])}</option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {EDIT_DATE_FIELDS.map((field) => {
            const problem = errors?.dates[field]
            const hint = problem === undefined ? undefined
              : t(problem === 'from-note-name' ? 'tasks.edit_date_inferred' : 'tasks.edit_date_invalid')
            return (
              <Field key={field} label={t(DATE_KEYS[field])} hint={hint}>
                <Input
                  value={draft.dates[field]}
                  placeholder={t('tasks.edit_date_placeholder')}
                  aria-invalid={problem !== undefined || undefined}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    dates: { ...current.dates, [field]: event.target.value },
                  }))}
                />
              </Field>
            )
          })}
        </div>

        <Field label={t('tasks.edit_recurrence')} hint={recurrenceHint}>
          <Input
            value={draft.recurrenceRule}
            placeholder={t('tasks.edit_recurrence_placeholder')}
            aria-invalid={errors !== null && errors.recurrence !== 'none' || undefined}
            onChange={(event) => patch({ recurrenceRule: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('tasks.edit_on_completion')}>
            <Select
              value={draft.onCompletion}
              onChange={(event) => patch({ onCompletion: event.target.value as OnCompletion })}
            >
              <option value={OnCompletion.Ignore}>{t('tasks.edit_on_completion_keep')}</option>
              <option value={OnCompletion.Delete}>{t('tasks.edit_on_completion_delete')}</option>
            </Select>
          </Field>
          <Field
            label={t('tasks.edit_blocked_by')}
            hint={draft.id === '' ? t('tasks.edit_id_none') : t('tasks.edit_id_value', { value0: draft.id })}
          >
            <Input
              value={draft.blockedBy.length > 0 ? draft.blockedBy.join(', ') : t('tasks.edit_none')}
              readOnly
            />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
