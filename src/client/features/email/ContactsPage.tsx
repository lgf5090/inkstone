import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Pencil, Plus, Search, Star, Trash2, UserPlus, Users, X } from 'lucide-react'
import type { EmailContact, EmailGroupWithMembers } from '@shared/email/contacts'
import { EMAIL_CONTACT_QUERY_MAX_CHARS } from '@shared/email/contacts'
import { Avatar, Button, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Input } from '../../components/form'
import { Menu, confirm, type MenuItem } from '../../components/overlay'
import { TagPill } from '../../components/TagChip'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'
import { ContactEditor } from './ContactEditor'
import { GroupEditor } from './GroupEditor'

const SEARCH_DEBOUNCE_MS = 200

type LoadStatus = 'loading' | 'ready' | 'error'

interface EditorState<T> {
  open: boolean
  value: T | null
}

export function ContactsPage({ onBack }: { onBack?: () => void }) {
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<EmailContact[]>([])
  const [contactsStatus, setContactsStatus] = useState<LoadStatus>('loading')
  const [contactsError, setContactsError] = useState<string | null>(null)
  const [contactsRetry, setContactsRetry] = useState(0)
  const [groups, setGroups] = useState<EmailGroupWithMembers[]>([])
  const [groupsStatus, setGroupsStatus] = useState<LoadStatus>('loading')
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [groupsRetry, setGroupsRetry] = useState(0)
  const [contactEditor, setContactEditor] = useState<EditorState<EmailContact>>({ open: false, value: null })
  const [groupEditor, setGroupEditor] = useState<EditorState<EmailGroupWithMembers>>({ open: false, value: null })
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const contactRequest = useRef(0)
  const groupRequest = useRef(0)

  useEffect(() => {
    const request = ++contactRequest.current
    setContactsStatus('loading')
    setContactsError(null)
    const handle = window.setTimeout(() => {
      api.email.listContacts(query.trim()).then(
        (rows) => {
          if (request !== contactRequest.current) return
          setContacts(rows)
          setContactsStatus('ready')
        },
        (reason: unknown) => {
          if (request !== contactRequest.current) return
          setContactsStatus('error')
          setContactsError(emailErrorText(reason))
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => { window.clearTimeout(handle) }
  }, [query, contactsRetry])

  const loadGroups = useCallback(() => {
    const request = ++groupRequest.current
    setGroupsStatus('loading')
    setGroupsError(null)
    api.email.listGroups().then(
      (rows) => {
        if (request !== groupRequest.current) return
        setGroups(rows)
        setGroupsStatus('ready')
      },
      (reason: unknown) => {
        if (request !== groupRequest.current) return
        setGroupsStatus('error')
        setGroupsError(emailErrorText(reason))
      },
    )
  }, [])

  useEffect(() => {
    loadGroups()
  }, [loadGroups, groupsRetry])

  const reload = () => {
    setContactsRetry((current) => current + 1)
    loadGroups()
  }

  const toggleStar = async (contact: EmailContact) => {
    try {
      const updated = await api.email.updateContact(contact.id, { starred: !contact.starred })
      setContacts((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)))
    } catch (reason) {
      useUi.getState().toast({ title: emailErrorText(reason), tone: 'danger' })
    }
  }

  const removeContact = async (contact: EmailContact) => {
    const name = contact.name || contact.email
    const confirmed = await confirm({
      title: t('email.contacts.delete_contact_title'),
      description: t('email.contacts.delete_contact_warning', { name }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      tone: 'danger',
    })
    if (!confirmed) return
    try {
      await api.email.deleteContact(contact.id)
      useUi.getState().toast({ title: t('email.contacts.deleted'), tone: 'success' })
      reload()
    } catch (reason) {
      useUi.getState().toast({ title: emailErrorText(reason), tone: 'danger' })
    }
  }

  const removeGroup = async (group: EmailGroupWithMembers) => {
    const confirmed = await confirm({
      title: t('email.contacts.delete_group_title'),
      description: t('email.contacts.delete_group_warning', { name: group.name }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      tone: 'danger',
    })
    if (!confirmed) return
    try {
      await api.email.deleteGroup(group.id)
      useUi.getState().toast({ title: t('email.contacts.group_deleted'), tone: 'success' })
      loadGroups()
    } catch (reason) {
      useUi.getState().toast({ title: emailErrorText(reason), tone: 'danger' })
    }
  }

  const removeMember = async (group: EmailGroupWithMembers, contact: EmailContact) => {
    try {
      await api.email.removeGroupMember(group.id, contact.id)
      setGroups((current) => current.map((entry) => (
        entry.id === group.id
          ? { ...entry, members: entry.members.filter((member) => member.id !== contact.id) }
          : entry
      )))
    } catch (reason) {
      useUi.getState().toast({ title: emailErrorText(reason), tone: 'danger' })
    }
  }

  const addItems: MenuItem[] = [
    {
      id: 'new-contact',
      label: t('email.contacts.new_contact'),
      icon: <UserPlus size={13} />,
      onSelect: () => {
        setAddMenuOpen(false)
        setContactEditor({ open: true, value: null })
      },
    },
    {
      id: 'new-group',
      label: t('email.contacts.new_group'),
      icon: <Users size={13} />,
      onSelect: () => {
        setAddMenuOpen(false)
        setGroupEditor({ open: true, value: null })
      },
    },
  ]

  const searching = Boolean(query.trim())
  const showContactList = contacts.length > 0
  const showContactEmpty = contactsStatus === 'ready' && contacts.length === 0
  const showContactError = contactsStatus === 'error' && contacts.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 md:px-3">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowLeft size={14} />}
          onClick={() => { if (onBack) onBack(); else navigateToPath('/email') }}
        >
          {t('email.contacts.back')}
        </Button>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('email.contacts.title')}
        </span>
        <Button
          ref={addButtonRef}
          size="sm"
          icon={<Plus size={14} />}
          aria-haspopup="menu"
          aria-expanded={addMenuOpen}
          onClick={() => setAddMenuOpen(true)}
        >
          {t('email.contacts.add')}
        </Button>
        <Menu anchor={addButtonRef} open={addMenuOpen} onClose={() => setAddMenuOpen(false)} items={addItems} width={200} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('email.contacts.search_placeholder')}
            aria-label={t('email.contacts.search')}
            leading={<Search size={14} />}
            maxLength={EMAIL_CONTACT_QUERY_MAX_CHARS}
            autoComplete="off"
          />
          {contactsStatus === 'error' && showContactList && (
            <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
              <span className="min-w-0 flex-1">{contactsError}</span>
              <Button size="sm" variant="ghost" onClick={() => setContactsRetry((current) => current + 1)}>
                {t('common.retry')}
              </Button>
            </div>
          )}
          {showContactError && (
            <Empty
              art="folder"
              title={t('email.contacts.error_load')}
              description={contactsError ?? undefined}
              action={<Button size="sm" onClick={() => setContactsRetry((current) => current + 1)}>{t('common.retry')}</Button>}
            />
          )}
          {contactsStatus === 'loading' && !showContactList && (
            <LoadingBlock label={t('email.contacts.loading')} />
          )}
          {showContactEmpty && (
            <Empty
              art={searching ? 'search' : 'select'}
              title={searching ? t('email.contacts.no_matches_title') : t('email.contacts.empty_title')}
              description={searching ? t('email.contacts.no_matches_hint') : t('email.contacts.empty_hint')}
              action={searching
                ? <Button size="sm" onClick={() => setQuery('')}>{t('common.clear')}</Button>
                : <Button size="sm" icon={<UserPlus size={14} />} onClick={() => setContactEditor({ open: true, value: null })}>{t('email.contacts.new_contact')}</Button>}
            />
          )}
          {showContactList && (
            <ul aria-label={t('email.contacts.title')} aria-busy={contactsStatus === 'loading'} className="mt-3 space-y-2">
              {contacts.map((contact) => {
                const name = contact.name || contact.email
                return (
                  <li key={contact.id} className="flex items-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
                    <Avatar name={name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{name}</p>
                      <p className="truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                        {[contact.name ? contact.email : '', contact.company].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <IconButton
                      label={contact.starred
                        ? t('email.contacts.unstar', { name })
                        : t('email.contacts.star', { name })}
                      size="sm"
                      active={contact.starred}
                      onClick={() => { void toggleStar(contact) }}
                    >
                      <Star size={14} fill={contact.starred ? 'currentColor' : 'none'} />
                    </IconButton>
                    <IconButton
                      label={t('email.contacts.edit_named', { name })}
                      size="sm"
                      onClick={() => setContactEditor({ open: true, value: contact })}
                    >
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton
                      label={t('email.contacts.delete_named', { name })}
                      size="sm"
                      onClick={() => { void removeContact(contact) }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </li>
                )
              })}
            </ul>
          )}
          <section aria-label={t('email.contacts.groups')} className="mt-6">
            <div className="flex items-center gap-2">
              <h2 className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('email.contacts.groups')}</h2>
              <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{groups.length}</span>
            </div>
            {groupsStatus === 'error' && (
              <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
                <span className="min-w-0 flex-1">
                  <span className="block">{t('email.contacts.groups_error')}</span>
                  {groupsError && <span className="mt-0.5 block text-[length:var(--text-11)] text-[var(--text-tertiary)]">{groupsError}</span>}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setGroupsRetry((current) => current + 1)}>
                  {t('common.retry')}
                </Button>
              </div>
            )}
            {groupsStatus === 'loading' && groups.length === 0 && (
              <LoadingBlock label={t('common.loading')} />
            )}
            {groupsStatus === 'ready' && groups.length === 0 && (
              <Empty
                art="folder"
                compact
                title={t('email.contacts.groups_empty_title')}
                description={t('email.contacts.groups_empty_hint')}
                action={<Button size="sm" icon={<Users size={14} />} onClick={() => setGroupEditor({ open: true, value: null })}>{t('email.contacts.new_group')}</Button>}
              />
            )}
            {groups.length > 0 && (
              <ul aria-label={t('email.contacts.groups')} className="mt-2 space-y-2">
                {groups.map((group) => (
                  <li key={group.id} className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                    <div className="flex items-start gap-2">
                      <Users size={15} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{group.name}</p>
                        {group.description && (
                          <p className="truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{group.description}</p>
                        )}
                        <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                          {t('email.contacts.member_count', { count: group.members.length })}
                        </p>
                      </div>
                      <IconButton
                        label={t('email.contacts.edit_named', { name: group.name })}
                        size="sm"
                        onClick={() => setGroupEditor({ open: true, value: group })}
                      >
                        <Pencil size={14} />
                      </IconButton>
                      <IconButton
                        label={t('email.contacts.delete_named', { name: group.name })}
                        size="sm"
                        onClick={() => { void removeGroup(group) }}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                    {group.members.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-1">
                        {group.members.map((member) => {
                          const memberName = member.name || member.email
                          return (
                            <li key={member.id}>
                              <TagPill
                                label={memberName}
                                trailing={(
                                  <IconButton
                                    label={t('email.contacts.remove_member', { name: memberName, group: group.name })}
                                    size="xs"
                                    className="-mr-1 ml-0.5 text-[var(--text-quaternary)] hover:text-[var(--danger)]"
                                    onClick={() => { void removeMember(group, member) }}
                                  >
                                    <X size={10} />
                                  </IconButton>
                                )}
                              />
                            </li>
                          )
                        })}
                      </ul>
                    ) : (
                      <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('email.contacts.no_members')}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      <ContactEditor
        open={contactEditor.open}
        contact={contactEditor.value}
        onClose={() => setContactEditor({ open: false, value: null })}
        onSaved={reload}
      />
      <GroupEditor
        open={groupEditor.open}
        group={groupEditor.value}
        onClose={() => setGroupEditor({ open: false, value: null })}
        onSaved={loadGroups}
      />
    </div>
  )
}
