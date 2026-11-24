import { useEffect, useState } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import { EMAIL_INBOUND_MAX_BYTES, type EmailFolder } from '@shared/email/model'
import {
  EMAIL_FILTER_MAX_ACTIONS,
  EMAIL_FILTER_MAX_CONDITIONS,
  EMAIL_FILTER_NAME_MAX_CHARS,
  EMAIL_FILTER_TEXT_MAX_CHARS,
  type EmailFilter,
  type EmailFilterAction,
  type EmailFilterCondition,
  type EmailFilterInput,
  type EmailFilterMatchMode,
} from '@shared/email/rules'
import { EMAIL_TAG_PATH_MAX_CHARS } from '@shared/email/tags'
import { Button } from '../../components/primitives'
import { Checkbox, Field, Input, Select, Switch } from '../../components/form'
import { Modal } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { emailErrorText } from './errors'
import { folderLabel } from './format'

interface RuleDraft {
  name: string
  matchMode: EmailFilterMatchMode
  from: string
  negateFrom: boolean
  to: string
  negateTo: boolean
  subject: string
  negateSubject: boolean
  hasAttachment: boolean
  negateHasAttachment: boolean
  minBytes: string
  negateMinBytes: boolean
  moveTo: string
  tag: string
  markRead: boolean
  star: boolean
  trash: boolean
  stopProcessing: boolean
}

const EMPTY_DRAFT: RuleDraft = {
  name: '',
  matchMode: 'all',
  from: '',
  negateFrom: false,
  to: '',
  negateTo: false,
  subject: '',
  negateSubject: false,
  hasAttachment: false,
  negateHasAttachment: false,
  minBytes: '',
  negateMinBytes: false,
  moveTo: '',
  tag: '',
  markRead: false,
  star: false,
  trash: false,
  stopProcessing: false,
}

function conditionFor(
  conditions: readonly EmailFilterCondition[],
  field: EmailFilterCondition['field'],
): EmailFilterCondition | undefined {
  return conditions.find((entry) => entry.field === field)
}

function conditionValue(conditions: readonly EmailFilterCondition[], field: EmailFilterCondition['field']): string {
  const condition = conditionFor(conditions, field)
  if (!condition) return ''
  return typeof condition.value === 'string' ? condition.value : String(condition.value)
}

function NegateSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 md:h-[34px]">
      <span aria-hidden="true" className="text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]">{t('email.rules.negate')}</span>
      <Switch checked={checked} disabled={disabled} label={t('email.rules.negate_named', { label })} onChange={onChange} />
    </div>
  )
}

function actionOfType<T extends EmailFilterAction['type']>(
  actions: readonly EmailFilterAction[],
  type: T,
): Extract<EmailFilterAction, { type: T }> | null {
  return (actions.find((entry) => entry.type === type) as Extract<EmailFilterAction, { type: T }> | undefined) ?? null
}

function draftFromFilter(filter: EmailFilter | null): RuleDraft {
  if (!filter) return EMPTY_DRAFT
  const moveTo = actionOfType(filter.actions, 'moveTo')
  const addTag = actionOfType(filter.actions, 'addTag')
  const from = conditionFor(filter.conditions, 'fromContains')
  const to = conditionFor(filter.conditions, 'toContains')
  const subject = conditionFor(filter.conditions, 'subjectContains')
  const hasAttachment = conditionFor(filter.conditions, 'hasAttachment')
  const minBytes = conditionFor(filter.conditions, 'minBytes')
  return {
    name: filter.name,
    matchMode: filter.matchMode ?? 'all',
    from: conditionValue(filter.conditions, 'fromContains'),
    negateFrom: from?.negate ?? false,
    to: conditionValue(filter.conditions, 'toContains'),
    negateTo: to?.negate ?? false,
    subject: conditionValue(filter.conditions, 'subjectContains'),
    negateSubject: subject?.negate ?? false,
    hasAttachment: hasAttachment?.field === 'hasAttachment' && hasAttachment.value,
    negateHasAttachment: hasAttachment?.negate ?? false,
    minBytes: conditionValue(filter.conditions, 'minBytes'),
    negateMinBytes: minBytes?.negate ?? false,
    moveTo: moveTo?.folder ?? '',
    tag: addTag?.tag ?? '',
    markRead: filter.actions.some((entry) => entry.type === 'markRead'),
    star: filter.actions.some((entry) => entry.type === 'star'),
    trash: filter.actions.some((entry) => entry.type === 'trash'),
    stopProcessing: filter.stopProcessing ?? false,
  }
}

function draftInput(draft: RuleDraft, enabled: boolean): EmailFilterInput | MessageKey {
  const name = draft.name.trim()
  if (!name) return 'email.rules.invalid_name'
  const conditions: EmailFilterCondition[] = []
  if (draft.from.trim()) conditions.push({ field: 'fromContains', value: draft.from.trim(), negate: draft.negateFrom })
  if (draft.to.trim()) conditions.push({ field: 'toContains', value: draft.to.trim(), negate: draft.negateTo })
  if (draft.subject.trim()) conditions.push({ field: 'subjectContains', value: draft.subject.trim(), negate: draft.negateSubject })
  if (draft.hasAttachment) {
    conditions.push({ field: 'hasAttachment', value: true, negate: draft.negateHasAttachment })
  }
  const minBytes = draft.minBytes.trim()
  if (minBytes) {
    const bytes = Number(minBytes)
    if (!/^\d+$/.test(minBytes) || !Number.isSafeInteger(bytes) || bytes > EMAIL_INBOUND_MAX_BYTES) {
      return 'email.rules.invalid_min_bytes'
    }
    conditions.push({ field: 'minBytes', value: bytes, negate: draft.negateMinBytes })
  }
  if (conditions.length === 0) return 'email.rules.invalid_conditions'
  const actions: EmailFilterAction[] = []
  if (draft.moveTo) actions.push({ type: 'moveTo', folder: draft.moveTo })
  if (draft.tag.trim()) actions.push({ type: 'addTag', tag: draft.tag.trim() })
  if (draft.markRead) actions.push({ type: 'markRead' })
  if (draft.star) actions.push({ type: 'star' })
  if (draft.trash) actions.push({ type: 'trash' })
  if (actions.length === 0) return 'email.rules.invalid_actions'
  return { name, enabled, matchMode: draft.matchMode, conditions, actions, stopProcessing: draft.stopProcessing }
}

export function RuleEditor({
  open,
  accountId,
  filter,
  folders,
  onClose,
  onSaved,
}: {
  open: boolean
  accountId: string
  filter: EmailFilter | null
  folders: readonly EmailFolder[]
  onClose: () => void
  onSaved: (filter: EmailFilter) => void
}) {
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(draftFromFilter(filter))
    setSaving(false)
    setError(null)
  }, [filter, open])

  const update = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const save = async (): Promise<void> => {
    const built = draftInput(draft, filter?.enabled ?? true)
    if (typeof built === 'string') {
      setError(t(built))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = filter
        ? await api.email.updateFilter(accountId, filter.id, built)
        : await api.email.createFilter(accountId, built)
      onSaved(saved)
    } catch (reason) {
      setError(emailErrorText(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={filter ? t('email.rules.edit_named', { name: filter.name }) : t('email.rules.new')}
      footer={(
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={saving} onClick={() => { void save() }}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Field label={t('email.rules.name')}>
          <Input
            value={draft.name}
            placeholder={t('email.rules.name_placeholder')}
            maxLength={EMAIL_FILTER_NAME_MAX_CHARS}
            onChange={(event) => update('name', event.target.value)}
          />
        </Field>
        <fieldset className="min-w-0 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
          <legend className="px-1 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('email.rules.conditions')}
          </legend>
          {draft.matchMode === 'all' && (
            <p className="m-0 mb-3 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
              {t('email.rules.conditions_hint', { count: EMAIL_FILTER_MAX_CONDITIONS })}
            </p>
          )}
          <Field label={t('email.rules.match_mode')} className="mb-3">
            <Select
              value={draft.matchMode}
              onChange={(event) => update('matchMode', event.target.value as EmailFilterMatchMode)}
              onKeyDown={(event) => {
                if (event.key === 'Home') {
                  event.preventDefault()
                  update('matchMode', 'all')
                } else if (event.key === 'End') {
                  event.preventDefault()
                  update('matchMode', 'any')
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  update('matchMode', draft.matchMode === 'all' ? 'any' : 'all')
                }
              }}
            >
              <option value="all">{t('email.rules.match_all')}</option>
              <option value="any">{t('email.rules.match_any')}</option>
            </Select>
          </Field>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex min-w-0 items-end gap-2">
              <Field label={t('email.rules.from')} className="min-w-0 flex-1">
                <Input value={draft.from} maxLength={EMAIL_FILTER_TEXT_MAX_CHARS} onChange={(event) => update('from', event.target.value)} />
              </Field>
              <NegateSwitch
                checked={draft.negateFrom}
                disabled={!draft.from.trim()}
                label={t('email.rules.from')}
                onChange={(next) => update('negateFrom', next)}
              />
            </div>
            <div className="flex min-w-0 items-end gap-2">
              <Field label={t('email.rules.to')} className="min-w-0 flex-1">
                <Input value={draft.to} maxLength={EMAIL_FILTER_TEXT_MAX_CHARS} onChange={(event) => update('to', event.target.value)} />
              </Field>
              <NegateSwitch
                checked={draft.negateTo}
                disabled={!draft.to.trim()}
                label={t('email.rules.to')}
                onChange={(next) => update('negateTo', next)}
              />
            </div>
            <div className="flex min-w-0 items-end gap-2">
              <Field label={t('email.rules.subject')} className="min-w-0 flex-1">
                <Input value={draft.subject} maxLength={EMAIL_FILTER_TEXT_MAX_CHARS} onChange={(event) => update('subject', event.target.value)} />
              </Field>
              <NegateSwitch
                checked={draft.negateSubject}
                disabled={!draft.subject.trim()}
                label={t('email.rules.subject')}
                onChange={(next) => update('negateSubject', next)}
              />
            </div>
            <div className="flex min-w-0 items-end gap-2">
              <Field label={t('email.rules.min_bytes')} className="min-w-0 flex-1">
                <Input
                  type="number"
                  min={0}
                  max={EMAIL_INBOUND_MAX_BYTES}
                  step={1}
                  inputMode="numeric"
                  value={draft.minBytes}
                  onChange={(event) => update('minBytes', event.target.value)}
                />
              </Field>
              <NegateSwitch
                checked={draft.negateMinBytes}
                disabled={!draft.minBytes.trim()}
                label={t('email.rules.min_bytes')}
                onChange={(next) => update('negateMinBytes', next)}
              />
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <Checkbox
              checked={draft.hasAttachment}
              onChange={(next) => update('hasAttachment', next)}
              label={t('email.rules.has_attachment')}
            />
            <NegateSwitch
              checked={draft.negateHasAttachment}
              disabled={!draft.hasAttachment}
              label={t('email.rules.has_attachment')}
              onChange={(next) => update('negateHasAttachment', next)}
            />
          </div>
        </fieldset>
        <fieldset className="min-w-0 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
          <legend className="px-1 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('email.rules.actions')}
          </legend>
          <p className="m-0 mb-3 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('email.rules.actions_hint', { count: EMAIL_FILTER_MAX_ACTIONS })}
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label={t('email.rules.move_to')}>
              <Select value={draft.moveTo} onChange={(event) => update('moveTo', event.target.value)}>
                <option value="">{t('email.rules.move_none')}</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>{folderLabel(folder.id, folders)}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('email.rules.add_tag')}>
              <Input
                value={draft.tag}
                placeholder={t('email.rules.tag_placeholder')}
                maxLength={EMAIL_TAG_PATH_MAX_CHARS}
                onChange={(event) => update('tag', event.target.value)}
              />
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <Checkbox checked={draft.markRead} onChange={(next) => update('markRead', next)} label={t('email.rules.mark_read')} />
            <Checkbox checked={draft.star} onChange={(next) => update('star', next)} label={t('email.rules.star')} />
            <Checkbox checked={draft.trash} onChange={(next) => update('trash', next)} label={t('email.rules.trash')} />
          </div>
        </fieldset>
        <Field label={t('email.rules.stop_processing')}>
          <Switch
            checked={draft.stopProcessing}
            label={t('email.rules.stop_processing')}
            onChange={(next) => update('stopProcessing', next)}
          />
        </Field>
        {error && (
          <p role="alert" className="m-0 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
