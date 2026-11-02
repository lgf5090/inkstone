/**
 * The address book behind guest autocomplete and birthday events.
 *
 * The dialog owns one list and one draft; a birthday is optional, so a contact can be a plain email
 * address. The birthday calendar is generated on request rather than on every keystroke.
 */
import { useEffect, useState } from 'react'
import { Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { CalendarContactDto } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Modal, confirm } from '../../components/overlay'
import { Field, Input } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { useUi } from '../../store/ui'
import * as api from './api'

interface CalendarContactsDialogProps {
  open: boolean
  onClose: () => void
  onChanged: () => void | Promise<void>
}

export function CalendarContactsDialog({ open, onClose, onChanged }: CalendarContactsDialogProps) {
  const [contacts, setContacts] = useState<CalendarContactDto[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [birthday, setBirthday] = useState('')
  const [editing, setEditing] = useState<CalendarContactDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      setContacts(await api.getContacts())
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('calendar.contacts.load_failed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setName('')
    setEmail('')
    setBirthday('')
    setEditing(null)
    setError(null)
    void load()
  }, [open])

  const resetDraft = (): void => {
    setName('')
    setEmail('')
    setBirthday('')
    setEditing(null)
    setError(null)
  }

  const save = async (): Promise<void> => {
    if (!email.trim()) {
      setError(t('calendar.contacts.email_required'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (editing) {
        const saved = await api.updateContact(editing.id, {
          name: name.trim(),
          email: email.trim(),
          birthday: birthday || null,
          rev: editing.rev,
        })
        setContacts(current => current.map(item => item.id === saved.id ? saved : item))
      } else {
        const saved = await api.createContact({ name: name.trim(), email: email.trim(), birthday: birthday || null })
        setContacts(current => [...current, saved].sort((left, right) => left.name.localeCompare(right.name)))
      }
      resetDraft()
      useUi.getState().toast({ title: t('calendar.contacts.saved'), tone: 'success' })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('calendar.contacts.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (contact: CalendarContactDto): Promise<void> => {
    if (!await confirm({
      title: t('calendar.contacts.delete'),
      description: t('calendar.contacts.delete_confirm', { name: contact.name || contact.email }),
      confirmLabel: t('calendar.contacts.delete'),
      tone: 'danger',
    })) return
    try {
      await api.deleteContact(contact.id)
      setContacts(current => current.filter(item => item.id !== contact.id))
      if (editing?.id === contact.id) resetDraft()
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t('calendar.contacts.delete_failed'))
    }
  }

  const syncBirthdays = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const answer = await api.syncBirthdays({
        calendarName: t('calendar.contacts.birthday_calendar'),
        titleTemplate: t('calendar.contacts.birthday_title'),
      })
      useUi.getState().toast({
        title: t('calendar.contacts.birthday_synced', { count: answer.imported }),
        tone: 'success',
      })
      await onChanged()
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : t('calendar.contacts.sync_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.contacts.title')}
      description={t('calendar.contacts.description')}
      width={560}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.close')}</Button>
          <Button variant="secondary" icon={<RefreshCw size={13} aria-hidden="true" />} loading={saving} onClick={() => void syncBirthdays()}>
            {t('calendar.contacts.sync_birthdays')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('calendar.contacts.name')}>
            <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={t('calendar.contacts.email')} required>
            <Input type="email" value={email} maxLength={254} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label={t('calendar.contacts.birthday')}>
            <div className="flex items-center gap-2">
              <DatePicker label={t('calendar.contacts.birthday')} value={birthday} onChange={setBirthday} />
              {birthday && (
                <Button size="sm" variant="ghost" onClick={() => setBirthday('')}>{t('calendar.contacts.clear_birthday')}</Button>
              )}
            </div>
          </Field>
          <div className="flex items-end gap-2">
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              {editing ? t('calendar.contacts.update') : t('calendar.contacts.add')}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={resetDraft}>{t('common.cancel')}</Button>
            )}
          </div>
        </div>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        <div>
          <p className="text-[length:var(--text-11)] font-semibold uppercase tracking-[0.07em] text-[var(--text-quaternary)]">
            {t('calendar.contacts.list')}
          </p>
          {loading && <p role="status" className="py-3 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</p>}
          {!loading && contacts.length === 0 && (
            <p className="py-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('calendar.contacts.empty')}</p>
          )}
          <ul className="mt-1 divide-y divide-[var(--border-subtle)]">
            {contacts.map(contact => (
              <li key={contact.id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">
                    {contact.name || contact.email}
                  </span>
                  <span className="block truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                    {contact.email}{contact.birthday ? ` · ${contact.birthday}` : ''}
                  </span>
                </span>
                <IconButton
                  size="sm"
                  label={t('calendar.contacts.edit', { name: contact.name || contact.email })}
                  onClick={() => {
                    setEditing(contact)
                    setName(contact.name)
                    setEmail(contact.email)
                    setBirthday(contact.birthday ?? '')
                    setError(null)
                  }}
                >
                  <Pencil size={13} aria-hidden="true" />
                </IconButton>
                <IconButton
                  size="sm"
                  label={t('calendar.contacts.delete_one', { name: contact.name || contact.email })}
                  onClick={() => void remove(contact)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  )
}
