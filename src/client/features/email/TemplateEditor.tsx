import { useEffect, useState } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import {
  EMAIL_TEMPLATE_BODY_MAX_CHARS,
  EMAIL_TEMPLATE_NAME_MAX_CHARS,
  EMAIL_TEMPLATE_SUBJECT_MAX_CHARS,
  type EmailTemplate,
  type EmailTemplateInput,
} from '@shared/email/templates'
import { Button } from '../../components/primitives'
import { Field, Input, Textarea } from '../../components/form'
import { Modal } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { emailErrorText } from './errors'

interface TemplateDraft {
  name: string
  subject: string
  body: string
}

const EMPTY_DRAFT: TemplateDraft = { name: '', subject: '', body: '' }

function draftFromTemplate(template: EmailTemplate | null): TemplateDraft {
  if (!template) return EMPTY_DRAFT
  return { name: template.name, subject: template.subject, body: template.body }
}

function draftInput(draft: TemplateDraft): EmailTemplateInput | MessageKey {
  const name = draft.name.trim()
  if (!name || name.length > EMAIL_TEMPLATE_NAME_MAX_CHARS) return 'email.templates.invalid_name'
  const subject = draft.subject.trim()
  if (subject.length > EMAIL_TEMPLATE_SUBJECT_MAX_CHARS) return 'email.templates.invalid_subject'
  if (draft.body.length > EMAIL_TEMPLATE_BODY_MAX_CHARS) return 'email.templates.invalid_body'
  return { name, subject, body: draft.body }
}

export function TemplateEditor({
  open,
  accountId,
  template,
  onClose,
  onSaved,
}: {
  open: boolean
  accountId: string
  template: EmailTemplate | null
  onClose: () => void
  onSaved: (template: EmailTemplate) => void
}) {
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(draftFromTemplate(template))
    setSaving(false)
    setError(null)
  }, [template, open])

  const update = <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const save = async (): Promise<void> => {
    const built = draftInput(draft)
    if (typeof built === 'string') {
      setError(t(built))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = template
        ? await api.email.updateTemplate(accountId, template.id, built)
        : await api.email.createTemplate(accountId, built)
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
      title={template ? t('email.templates.edit_named', { name: template.name }) : t('email.templates.new')}
      footer={(
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={saving} onClick={() => { void save() }}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Field label={t('email.templates.name')}>
          <Input
            value={draft.name}
            placeholder={t('email.templates.name_placeholder')}
            maxLength={EMAIL_TEMPLATE_NAME_MAX_CHARS}
            onChange={(event) => update('name', event.target.value)}
          />
        </Field>
        <Field label={t('email.templates.subject')}>
          <Input
            value={draft.subject}
            placeholder={t('email.templates.subject_placeholder')}
            maxLength={EMAIL_TEMPLATE_SUBJECT_MAX_CHARS}
            onChange={(event) => update('subject', event.target.value)}
          />
        </Field>
        <Field label={t('email.templates.body')} hint={t('email.templates.body_hint')}>
          <Textarea
            value={draft.body}
            placeholder={t('email.templates.body_placeholder')}
            maxLength={EMAIL_TEMPLATE_BODY_MAX_CHARS}
            rows={10}
            spellCheck
            onChange={(event) => update('body', event.target.value)}
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
