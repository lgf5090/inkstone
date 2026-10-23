import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Search } from 'lucide-react'
import type { EmailContact, EmailGroupWithMembers } from '@shared/email/contacts'
import { EMAIL_GROUP_DESCRIPTION_MAX_CHARS, EMAIL_GROUP_NAME_MAX_CHARS } from '@shared/email/contacts'
import { Avatar, Button } from '../../components/primitives'
import { Checkbox, Field, Input, SettingRow, Switch, Textarea } from '../../components/form'
import { Modal } from '../../components/overlay'
import { LoadingBlock } from '../../components/feedback'
import { ApiError, api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'

const AvatarPicker = lazy(() => import('../settings/AvatarPicker').then((module) => ({ default: module.AvatarPicker })))

const SEARCH_DEBOUNCE_MS = 200

function groupSaveError(reason: unknown): string {
  if (reason instanceof ApiError && reason.code === 'email_group_exists') return t('email.contacts.group_error_exists')
  return emailErrorText(reason)
}

export function GroupEditor({
  open,
  group,
  onClose,
  onSaved,
}: {
  open: boolean
  group: EmailGroupWithMembers | null
  onClose: () => void
  onSaved: () => void
}) {
  const formId = useId()
  const directoryRequest = useRef(0)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState('')
  const [starred, setStarred] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [directory, setDirectory] = useState<EmailContact[]>([])
  const [directoryStatus, setDirectoryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [directoryRetry, setDirectoryRetry] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(group?.name ?? '')
    setDescription(group?.description ?? '')
    setAvatar(group?.avatar ?? '')
    setStarred(group?.starred ?? false)
    setPinned(group?.pinned ?? false)
    setAvatarOpen(false)
    setSelected(new Set(group?.members.map((member) => member.id) ?? []))
    setQuery('')
    setSaving(false)
    setError(null)
  }, [open, group])

  useEffect(() => {
    if (!open) return
    const request = ++directoryRequest.current
    setDirectoryStatus('loading')
    setDirectoryError(null)
    const handle = window.setTimeout(() => {
      api.email.listContacts(query.trim()).then(
        (rows) => {
          if (request !== directoryRequest.current) return
          setDirectory(rows)
          setDirectoryStatus('ready')
        },
        (reason: unknown) => {
          if (request !== directoryRequest.current) return
          setDirectoryStatus('error')
          setDirectoryError(emailErrorText(reason))
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => { window.clearTimeout(handle) }
  }, [open, query, directoryRetry])

  const candidates = useMemo(() => {
    const byId = new Map<string, EmailContact>()
    for (const member of group?.members ?? []) byId.set(member.id, member)
    for (const contact of directory) byId.set(contact.id, contact)
    const needle = query.trim().toLocaleLowerCase()
    const rows = [...byId.values()]
    if (!needle) return rows
    return rows.filter((contact) =>
      contact.name.toLocaleLowerCase().includes(needle)
      || contact.email.toLocaleLowerCase().includes(needle)
      || contact.company.toLocaleLowerCase().includes(needle))
  }, [directory, group, query])

  const toggle = (contactId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(contactId)) next.delete(contactId)
      else next.add(contactId)
      return next
    })
  }

  const close = () => {
    if (!saving) onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('email.contacts.group_name_required'))
      return
    }
    setSaving(true)
    setError(null)
    const input = { name: trimmed, description: description.trim(), avatar, starred, pinned }
    try {
      let groupId: string
      let previous: Set<string>
      if (group) {
        groupId = group.id
        previous = new Set(group.members.map((member) => member.id))
        await api.email.updateGroup(groupId, input)
      } else {
        const created = await api.email.createGroup(input)
        groupId = created.id
        previous = new Set()
      }
      try {
        for (const contactId of previous) {
          if (!selected.has(contactId)) await api.email.removeGroupMember(groupId, contactId)
        }
        for (const contactId of selected) {
          if (!previous.has(contactId)) await api.email.addGroupMember(groupId, contactId)
        }
      } catch (reason) {
        useUi.getState().toast({ title: groupSaveError(reason), tone: 'danger' })
        onSaved()
        onClose()
        return
      }
      useUi.getState().toast({ title: t('email.contacts.group_saved'), tone: 'success' })
      onSaved()
      onClose()
    } catch (reason) {
      setError(groupSaveError(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={group ? t('email.contacts.edit_group') : t('email.contacts.new_group')}
      width={560}
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
          <Avatar src={avatar || undefined} name={name || '?'} size={48} />
          <Button size="sm" variant="secondary" onClick={() => setAvatarOpen(true)}>
            {t('email.contacts.change_icon')}
          </Button>
        </div>
        <Field label={t('email.contacts.group_name')} required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={EMAIL_GROUP_NAME_MAX_CHARS}
            autoComplete="off"
            data-autofocus
          />
        </Field>
        <SettingRow title={t('email.contacts.starred')} className="border-b-0 py-2">
          <Switch checked={starred} onChange={setStarred} label={t('email.contacts.starred')} />
        </SettingRow>
        <SettingRow title={t('email.contacts.pinned')} className="border-b-0 py-2">
          <Switch checked={pinned} onChange={setPinned} label={t('email.contacts.pinned')} />
        </SettingRow>
        <Field label={t('email.contacts.group_description')}>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('email.contacts.description_placeholder')}
            maxLength={EMAIL_GROUP_DESCRIPTION_MAX_CHARS}
            rows={2}
          />
        </Field>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('email.contacts.members')}</span>
            <span role="status" className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
              {t('email.contacts.member_count', { count: selected.size })}
            </span>
          </div>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('email.contacts.member_search_placeholder')}
            aria-label={t('email.contacts.member_search')}
            leading={<Search size={13} />}
            autoComplete="off"
          />
          {directoryStatus === 'loading' && <LoadingBlock label={t('email.contacts.members_loading')} />}
          {directoryStatus === 'error' && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
              <span className="min-w-0 flex-1">
                <span className="block">{t('email.contacts.members_error')}</span>
                {directoryError && <span className="mt-0.5 block text-[length:var(--text-11)] text-[var(--text-tertiary)]">{directoryError}</span>}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setDirectoryRetry((current) => current + 1)}>
                {t('common.retry')}
              </Button>
            </div>
          )}
          {directoryStatus === 'ready' && candidates.length === 0 && (
            <p className="px-1 py-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">
              {query.trim() ? t('email.contacts.no_matches_title') : t('email.contacts.members_empty')}
            </p>
          )}
          {candidates.length > 0 && (
            <ul aria-label={t('email.contacts.members')} className="max-h-64 space-y-0.5 overflow-y-auto rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-1.5">
              {candidates.map((contact) => (
                <li key={contact.id}>
                  <Checkbox
                    checked={selected.has(contact.id)}
                    onChange={() => toggle(contact.id)}
                    className="w-full"
                    label={(
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[var(--text-primary)]">{contact.name || contact.email}</span>
                        {contact.name && <span className="block truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">{contact.email}</span>}
                      </span>
                    )}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
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
            displayName={name || '?'}
            preference={avatar}
            onSave={async (value) => { setAvatar(value) }}
          />
        </Suspense>
      )}
    </Modal>
  )
}
