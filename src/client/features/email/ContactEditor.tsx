import { lazy, Suspense, useEffect, useId, useState, type FormEvent } from 'react'
import type { EmailContact } from '@shared/email/contacts'
import {
  EMAIL_CONTACT_COMPANY_MAX_CHARS,
  EMAIL_CONTACT_EMAIL_MAX_CHARS,
  EMAIL_CONTACT_NAME_MAX_CHARS,
  EMAIL_CONTACT_NOTES_MAX_CHARS,
  isValidContactEmail,
  normalizeContactEmail,
} from '@shared/email/contacts'
import { Avatar, Button } from '../../components/primitives'
import { Field, Input, SettingRow, Switch, Textarea } from '../../components/form'
import { Modal } from '../../components/overlay'
import { ApiError, api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'

const AvatarPicker = lazy(() => import('../settings/AvatarPicker').then((module) => ({ default: module.AvatarPicker })))

function contactSaveError(reason: unknown): string {
  if (reason instanceof ApiError && reason.code === 'email_contact_exists') return t('email.contacts.error_exists')
  return emailErrorText(reason)
}

export function ContactEditor({
  open,
  contact,
  onClose,
  onSaved,
}: {
  open: boolean
  contact: EmailContact | null
  onClose: () => void
  onSaved: () => void
}) {
  const formId = useId()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [notes, setNotes] = useState('')
  const [starred, setStarred] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [avatar, setAvatar] = useState('')
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setEmail(contact?.email ?? '')
    setName(contact?.name ?? '')
    setCompany(contact?.company ?? '')
    setNotes(contact?.notes ?? '')
    setStarred(contact?.starred ?? false)
    setPinned(contact?.pinned ?? false)
    setAvatar(contact?.avatar ?? '')
    setAvatarOpen(false)
    setSaving(false)
    setError(null)
  }, [open, contact])

  const close = () => {
    if (!saving) onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const address = normalizeContactEmail(email)
    if (!isValidContactEmail(address)) {
      setError(t('email.contacts.error_invalid_email'))
      return
    }
    setSaving(true)
    setError(null)
    const input = {
      email: address,
      name: name.trim(),
      company: company.trim(),
      notes: notes.trim(),
      starred,
      pinned,
      avatar,
    }
    try {
      if (contact) await api.email.updateContact(contact.id, input)
      else await api.email.createContact(input)
      useUi.getState().toast({ title: t('email.contacts.saved'), tone: 'success' })
      onSaved()
      onClose()
    } catch (reason) {
      setError(contactSaveError(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={contact ? t('email.contacts.edit_contact') : t('email.contacts.new_contact')}
      width={520}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>{t('common.save')}</Button>
        </>
      )}
    >
      <form id={formId} onSubmit={(event) => { void submit(event) }} className="space-y-3">
        <div className="flex items-center gap-3">
          <Avatar src={avatar || undefined} name={name || email || '?'} size={48} />
          <Button size="sm" variant="secondary" onClick={() => setAvatarOpen(true)}>
            {t('email.contacts.change_icon')}
          </Button>
        </div>
        <Field label={t('email.contacts.email')} required>
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t('email.contacts.email_placeholder')}
            maxLength={EMAIL_CONTACT_EMAIL_MAX_CHARS}
            autoComplete="off"
            data-autofocus
          />
        </Field>
        <Field label={t('email.contacts.name')}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('email.contacts.name_placeholder')}
            maxLength={EMAIL_CONTACT_NAME_MAX_CHARS}
            autoComplete="off"
          />
        </Field>
        <Field label={t('email.contacts.company')}>
          <Input
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            placeholder={t('email.contacts.company_placeholder')}
            maxLength={EMAIL_CONTACT_COMPANY_MAX_CHARS}
            autoComplete="off"
          />
        </Field>
        <Field label={t('email.contacts.notes')}>
          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={t('email.contacts.notes_placeholder')}
            maxLength={EMAIL_CONTACT_NOTES_MAX_CHARS}
            rows={4}
          />
        </Field>
        <SettingRow title={t('email.contacts.starred')} className="border-b-0 py-2">
          <Switch checked={starred} onChange={setStarred} label={t('email.contacts.starred')} />
        </SettingRow>
        <SettingRow title={t('email.contacts.pinned')} className="border-b-0 py-2">
          <Switch checked={pinned} onChange={setPinned} label={t('email.contacts.pinned')} />
        </SettingRow>
        {error && (
          <p role="alert" className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
            {error}
          </p>
        )}
      </form>
      {avatarOpen && (
        <Suspense fallback={null}>
          <AvatarPicker
            open
            onClose={() => setAvatarOpen(false)}
            displayName={name || email || '?'}
            preference={avatar}
            onSave={async (value) => { setAvatar(value) }}
          />
        </Suspense>
      )}
    </Modal>
  )
}
