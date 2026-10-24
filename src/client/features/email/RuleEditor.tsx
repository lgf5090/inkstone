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
} from '@shared/email/rules'
import { EMAIL_TAG_PATH_MAX_CHARS } from '@shared/email/tags'
import { Button } from '../../components/primitives'
import { Checkbox, Field, Input, Select } from '../../components/form'
import { Modal } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { emailErrorText } from './errors'
import { folderLabel } from './format'

interface RuleDraft {
  name: string
  from: string
  to: string
  subject: string
  hasAttachment: boolean
  minBytes: string
  moveTo: string
  tag: string
  markRead: boolean
  star: boolean
  trash: boolean
}

const EMPTY_DRAFT: RuleDraft = {
  name: '',
  from: '',
  to: '',
  subject: '',
  hasAttachment: false,
  minBytes: '',
  moveTo: '',
  tag: '',
  markRead: false,
  star: false,
  trash: false,
}

function conditionValue(conditions: readonly EmailFilterCondition[], field: EmailFilterCondition['field']): string {
  const condition = conditions.find((entry) => entry.field === field)
  if (!condition) return ''
  return typeof condition.value === 'string' ? condition.value : String(condition.value)
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
  return {
    name: filter.name,
    from: conditionValue(filter.conditions, 'fromContains'),
    to: conditionValue(filter.conditions, 'toContains'),
    subject: conditionValue(filter.conditions, 'subjectContains'),
    hasAttachment: filter.conditions.some((entry) => entry.field === 'hasAttachment' && entry.value),
    minBytes: conditionValue(filter.conditions, 'minBytes'),
    moveTo: moveTo?.folder ?? '',
    tag: addTag?.tag ?? '',
    markRead: filter.actions.some((entry) => entry.type === 'markRead'),
    star: filter.actions.some((entry) => entry.type === 'star'),
    trash: filter.actions.some((entry) => entry.type === 'trash'),
  }
}

function draftInput(draft: RuleDraft, enabled: boolean): EmailFilterInput | MessageKey {
  const name = draft.name.trim()
  if (!name) return 'email.rules.invalid_name'
  const conditions: EmailFilterCondition[] = []
  if (draft.from.trim()) conditions.push({ field: 'fromContains', value: draft.from.trim() })
  if (draft.to.trim()) conditions.push({ field: 'toContains', value: draft.to.trim() })
  if (draft.subject.trim()) conditions.push({ field: 'subjectContains', value: draft.subject.trim() })
  if (draft.hasAttachment) conditions.push({ field: 'hasAttachment', value: true })
  const minBytes = draft.minBytes.trim()
  if (minBytes) {
    const bytes = Number(minBytes)
    if (!/^\d+$/.test(minBytes) || !Number.isSafeInteger(bytes) || bytes > EMAIL_INBOUND_MAX_BYTES) {
      return 'email.rules.invalid_min_bytes'
    }
    conditions.push({ field: 'minBytes', value: bytes })
  }
  if (conditions.length === 0) return 'email.rules.invalid_conditions'
  const actions: EmailFilterAction[] = []
  if (draft.moveTo) actions.push({ type: 'moveTo', folder: draft.moveTo })
  if (draft.tag.trim()) actions.push({ type: 'addTag', tag: draft.tag.trim() })
  if (draft.markRead) actions.push({ type: 'markRead' })
  if (draft.star) actions.push({ type: 'star' })
  if (draft.trash) actions.push({ type: 'trash' })
  if (actions.length === 0) return 'email.rules.invalid_actions'
  return { name, enabled, conditions, actions }
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
          <p className="m-0 mb-3 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('email.rules.conditions_hint', { count: EMAIL_FILTER_MAX_CONDITIONS })}
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label={t('email.rules.from')}>
              <Input value={draft.from} maxLength={EMAIL_FILTER_TEXT_MAX_CHARS} onChange={(event) => update('from', event.target.value)} />
            </Field>
            <Field label={t('email.rules.to')}>
              <Input value={draft.to} maxLength={EMAIL_FILTER_TEXT_MAX_CHARS} onChange={(event) => update('to', event.target.value)} />
            </Field>
            <Field label={t('email.rules.subject')}>
              <Input value={draft.subject} maxLength={EMAIL_FILTER_TEXT_MAX_CHARS} onChange={(event) => update('subject', event.target.value)} />
            </Field>
            <Field label={t('email.rules.min_bytes')}>
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
          </div>
          <div className="mt-2">
            <Checkbox
              checked={draft.hasAttachment}
              onChange={(next) => update('hasAttachment', next)}
              label={t('email.rules.has_attachment')}
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
        {error && (
          <p role="alert" className="m-0 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
