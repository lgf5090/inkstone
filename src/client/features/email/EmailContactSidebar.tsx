import { useMemo, useRef, useState } from 'react'
import { RefreshCw, ChevronRight, MoreHorizontal, Pencil, Pin, Plus, Settings2, Star, Trash2, UserPlus, Users } from 'lucide-react'
import type { EmailContact, EmailGroupWithMembers } from '@shared/email/contacts'
import { Avatar, IconButton, SectionLabel, Spinner } from '../../components/primitives'
import { FilterInput } from '../../components/FilterInput'
import { Menu, Tooltip, confirm, useContextMenu, type MenuItem } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { compileQuery, queryKeeps } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'
import type { EmailLoadStatus } from './store'

interface PeopleProps {
  contacts: readonly EmailContact[]
  contactsStatus: EmailLoadStatus
  contactsError: string | null
  groups: readonly EmailGroupWithMembers[]
  groupsStatus: EmailLoadStatus
  groupsError: string | null
  activeContactId: string | null
  activeGroupId: string | null
  onSelectContact: (contact: EmailContact) => void
  onSelectGroup: (group: EmailGroupWithMembers) => void
  onEditContact: (contact: EmailContact) => void
  onEditGroup: (group: EmailGroupWithMembers) => void
  onManage: () => void
  onChanged: () => void
  onReload: () => void
  onClose?: () => void
}

function matchesPerson(query: ReturnType<typeof compileQuery>, name: string, email: string): boolean {
  return queryKeeps(query, name) || queryKeeps(query, email)
}

function TabToolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex h-8 shrink-0 items-center justify-end gap-0.5 px-2">{children}</div>
}

function LoadFailure({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-1 px-2 py-1 text-[length:var(--text-11)] text-[var(--danger)]">
      <span className="min-w-0 flex-1 break-words">{message ?? t('email.contacts.error_load')}</span>
      <button type="button" className="shrink-0 underline" onClick={onRetry}>{t('common.retry')}</button>
    </div>
  )
}

type PersonQuery = ReturnType<typeof compileQuery>

function usePersonQuery(): [string, (next: string) => void, PersonQuery] {
  const [query, setQuery] = useState('')
  usePinyinVersion()
  const compiled = useMemo(() => compileQuery(query), [query])
  return [query, setQuery, compiled]
}

export function EmailContactsTab({
  contacts,
  contactsStatus,
  contactsError,
  activeContactId,
  onSelectContact,
  onNewContact,
  onEditContact,
  onManage,
  onChanged,
  onReload,
  onClose,
}: Pick<PeopleProps, 'contacts' | 'contactsStatus' | 'contactsError' | 'activeContactId' | 'onSelectContact' | 'onEditContact' | 'onManage' | 'onChanged' | 'onReload' | 'onClose'> & {
  onNewContact: () => void
}) {
  const [query, setQuery, compiled] = usePersonQuery()
  const visible = contacts.filter((contact) => matchesPerson(compiled, contact.name || contact.email, contact.email))
  const loading = contactsStatus === 'loading' && contacts.length === 0
  const failed = contactsStatus === 'error' && contacts.length === 0
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabToolbar>
        <Tooltip label={t('email.contacts.manage')} side="bottom">
          <IconButton label={t('email.contacts.manage')} size="xs" onClick={onManage}>
            <Settings2 size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('email.contacts.new_contact')} side="bottom">
          <IconButton label={t('email.contacts.new_contact')} size="xs" onClick={onNewContact}>
            <UserPlus size={13} />
          </IconButton>
        </Tooltip>
      </TabToolbar>
      <div className="shrink-0 px-2 pb-1">
        <FilterInput value={query} onChange={setQuery} query={compiled} label={t('email.contacts.search')} placeholder={t('email.sidebar.filter_contacts')} className="mt-0" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading && <div className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]"><Spinner size={10} />{t('common.loading')}</div>}
        {failed && <LoadFailure message={contactsError} onRetry={onReload} />}
        {!loading && !failed && contacts.length === 0 && (
          <p className="m-0 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.contacts.empty_hint')}</p>
        )}
        {!loading && !failed && contacts.length > 0 && visible.length === 0 && (
          <p className="m-0 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.contacts.no_matches_title')}</p>
        )}
        {visible.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {visible.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                active={contact.id === activeContactId}
                onSelect={() => { onSelectContact(contact); onClose?.() }}
                onEdit={() => onEditContact(contact)}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function EmailGroupsTab({
  groups,
  groupsStatus,
  groupsError,
  activeGroupId,
  onSelectGroup,
  onSelectContact,
  onNewGroup,
  onEditGroup,
  onEditContact,
  onManage,
  onChanged,
  onReload,
  onClose,
}: Pick<PeopleProps, 'groups' | 'groupsStatus' | 'groupsError' | 'activeGroupId' | 'onSelectGroup' | 'onSelectContact' | 'onEditGroup' | 'onEditContact' | 'onManage' | 'onChanged' | 'onReload' | 'onClose'> & {
  onNewGroup: () => void
}) {
  const [query, setQuery, compiled] = usePersonQuery()
  const visible = groups.filter((group) => matchesPerson(compiled, group.name, group.members.map((member) => member.email).join(' ')))
  const loading = groupsStatus === 'loading' && groups.length === 0
  const failed = groupsStatus === 'error' && groups.length === 0
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabToolbar>
        <Tooltip label={t('email.contacts.manage')} side="bottom">
          <IconButton label={t('email.contacts.manage')} size="xs" onClick={onManage}>
            <Settings2 size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('email.contacts.new_group')} side="bottom">
          <IconButton label={t('email.contacts.new_group')} size="xs" onClick={onNewGroup}>
            <Plus size={13} />
          </IconButton>
        </Tooltip>
      </TabToolbar>
      <div className="shrink-0 px-2 pb-1">
        <FilterInput value={query} onChange={setQuery} query={compiled} label={t('email.contacts.groups')} placeholder={t('email.sidebar.filter_groups')} className="mt-0" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading && <div className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]"><Spinner size={10} />{t('common.loading')}</div>}
        {failed && <LoadFailure message={groupsError} onRetry={onReload} />}
        {!loading && !failed && groups.length === 0 && (
          <p className="m-0 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.contacts.groups_empty_hint')}</p>
        )}
        {!loading && !failed && groups.length > 0 && visible.length === 0 && (
          <p className="m-0 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.contacts.no_matches_title')}</p>
        )}
        {visible.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {visible.map((group) => (
              <GroupRow
                key={group.id}
                group={group}
                active={group.id === activeGroupId}
                onSelect={() => { onSelectGroup(group); onClose?.() }}
                onManage={onManage}
                onEdit={() => onEditGroup(group)}
                onEditMember={onEditContact}
                onSelectMember={(contact) => { onSelectContact(contact); onClose?.() }}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function EmailFavoritesTab({
  contacts,
  groups,
  activeContactId,
  activeGroupId,
  onSelectContact,
  onSelectGroup,
  onEditContact,
  onEditGroup,
  onSelectStarredMessages,
  onManage,
  onChanged,
  onReload,
  onClose,
}: Pick<PeopleProps, 'contacts' | 'groups' | 'activeContactId' | 'activeGroupId' | 'onSelectContact' | 'onSelectGroup' | 'onEditContact' | 'onEditGroup' | 'onManage' | 'onChanged' | 'onReload' | 'onClose'> & {
  onSelectStarredMessages: () => void
}) {
  const [query, setQuery, compiled] = usePersonQuery()
  const starredContacts = contacts.filter((contact) => contact.starred && matchesPerson(compiled, contact.name || contact.email, contact.email))
  const starredGroups = groups.filter((group) => group.starred && matchesPerson(compiled, group.name, group.members.map((member) => member.email).join(' ')))
  const showMessages = !query.trim() || queryKeeps(compiled, t('email.sidebar.starred_messages'))
  const empty = !showMessages && starredContacts.length === 0 && starredGroups.length === 0
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabToolbar>
        <Tooltip label={t('email.contacts.manage')} side="bottom">
          <IconButton label={t('email.contacts.manage')} size="xs" onClick={onManage}>
            <Settings2 size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('common.refresh')} side="bottom">
          <IconButton label={t('common.refresh')} size="xs" onClick={onReload}>
            <RefreshCw size={13} />
          </IconButton>
        </Tooltip>
      </TabToolbar>
      <div className="shrink-0 px-2 pb-1">
        <FilterInput value={query} onChange={setQuery} query={compiled} label={t('email.sidebar.tab_favorites')} placeholder={t('email.sidebar.filter_favorites')} className="mt-0" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {showMessages && (
          <button
            type="button"
            data-email-view="starred"
            onClick={() => { onSelectStarredMessages(); onClose?.() }}
            className="flex min-h-8 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Star size={14} aria-hidden="true" className="shrink-0 text-[var(--warning)]" fill="currentColor" />
            <span className="min-w-0 flex-1 truncate">{t('email.sidebar.starred_messages')}</span>
          </button>
        )}
        {starredContacts.length > 0 && (
          <>
            <SectionLabel className="px-2 pt-3 pb-1">{t('email.sidebar.starred_contacts')}</SectionLabel>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {starredContacts.map((contact) => (
                <ContactRow
                  key={contact.id}
                  contact={contact}
                  active={contact.id === activeContactId}
                  onSelect={() => { onSelectContact(contact); onClose?.() }}
                  onEdit={() => onEditContact(contact)}
                  onChanged={onChanged}
                />
              ))}
            </ul>
          </>
        )}
        {starredGroups.length > 0 && (
          <>
            <SectionLabel className="px-2 pt-3 pb-1">{t('email.sidebar.starred_groups')}</SectionLabel>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {starredGroups.map((group) => (
                <GroupRow
                  key={group.id}
                  group={group}
                  active={group.id === activeGroupId}
                  onSelect={() => { onSelectGroup(group); onClose?.() }}
                  onManage={onManage}
                  onEdit={() => onEditGroup(group)}
                  onEditMember={onEditContact}
                  onSelectMember={(contact) => { onSelectContact(contact); onClose?.() }}
                  onChanged={onChanged}
                />
              ))}
            </ul>
          </>
        )}
        {empty && (
          <p className="m-0 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.sidebar.no_favorites')}</p>
        )}
      </div>
    </div>
  )
}

function ContactRow({
  contact,
  active,
  onSelect,
  onEdit,
  onChanged,
}: {
  contact: EmailContact
  active: boolean
  onSelect: () => void
  onEdit: () => void
  onChanged: () => void
}) {
  const name = contact.name || contact.email
  const menu = useContextMenu()
  const [menuOpen, setMenuOpen] = useState(false)
  const moreAnchor = useRef<HTMLButtonElement>(null)
  const openFromKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    setMenuOpen(false)
    const rect = event.currentTarget.getBoundingClientRect()
    menu.openAt({ x: rect.left + 12, y: rect.top + Math.min(rect.height / 2, 16) })
  }
  const patch = async (value: { starred?: boolean; pinned?: boolean }) => {
    try {
      await api.email.updateContact(contact.id, value)
      onChanged()
    } catch (error) {
      useUi.getState().toast({ title: emailErrorText(error), tone: 'danger' })
    }
  }
  const remove = async () => {
    setMenuOpen(false)
    const ok = await confirm({
      title: t('email.contacts.delete_contact_title'),
      description: t('email.contacts.delete_contact_warning', { name }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.email.deleteContact(contact.id)
      useUi.getState().toast({ title: t('email.contacts.deleted'), tone: 'success' })
      onChanged()
    } catch (error) {
      useUi.getState().toast({ title: emailErrorText(error), tone: 'danger' })
    }
  }
  const items: MenuItem[] = [
    { id: 'edit', label: t('email.contacts.edit_action'), icon: <Pencil size={13} />, onSelect: () => { setMenuOpen(false); onEdit() } },
    {
      id: 'star',
      label: t(contact.starred ? 'email.contacts.unstar_action' : 'email.contacts.star_action'),
      icon: <Star size={13} fill={contact.starred ? 'currentColor' : 'none'} />,
      onSelect: () => { setMenuOpen(false); void patch({ starred: !contact.starred }) },
    },
    {
      id: 'pin',
      label: t(contact.pinned ? 'email.contacts.unpin_action' : 'email.contacts.pin_action'),
      icon: <Pin size={13} />,
      onSelect: () => { setMenuOpen(false); void patch({ pinned: !contact.pinned }) },
    },
    { id: 'delete', label: t('email.contacts.delete_action'), icon: <Trash2 size={13} />, tone: 'danger', separatorBefore: true, onSelect: () => { void remove() } },
  ]
  return (
    <li
      className="flex min-h-8 items-center gap-0.5 rounded-[var(--r-md)] pr-0.5 hover:bg-[var(--bg-hover)]"
      onContextMenu={(event) => { setMenuOpen(false); menu.onContextMenu(event) }}
    >
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        onKeyDown={openFromKeyboard}
        className={cn(
          'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
          active
            ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
        )}
      >
        <Avatar src={contact.avatar || undefined} name={name} size={20} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {contact.starred && <Star size={10} className="shrink-0 text-[var(--warning)]" fill="currentColor" aria-hidden="true" />}
        {contact.pinned && <Pin size={10} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />}
      </button>
      <IconButton
        ref={moreAnchor}
        label={t('email.contacts.more', { name })}
        size="xs"
        active={menuOpen}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <MoreHorizontal size={12} />
      </IconButton>
      <Menu anchor={moreAnchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={190} label={t('email.contacts.more_actions')} />
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} width={190} label={t('email.contacts.more_actions')} />}
    </li>
  )
}

function GroupRow({
  group,
  active,
  onSelect,
  onManage,
  onEdit,
  onEditMember,
  onSelectMember,
  onChanged,
}: {
  group: EmailGroupWithMembers
  active: boolean
  onSelect: () => void
  onManage: () => void
  onEdit: () => void
  onEditMember: (contact: EmailContact) => void
  onSelectMember: (contact: EmailContact) => void
  onChanged: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const menu = useContextMenu()
  const [menuOpen, setMenuOpen] = useState(false)
  const moreAnchor = useRef<HTMLButtonElement>(null)
  const openFromKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    setMenuOpen(false)
    const rect = event.currentTarget.getBoundingClientRect()
    menu.openAt({ x: rect.left + 12, y: rect.top + Math.min(rect.height / 2, 16) })
  }
  const patch = async (value: { starred?: boolean; pinned?: boolean }) => {
    try {
      await api.email.updateGroup(group.id, value)
      onChanged()
    } catch (error) {
      useUi.getState().toast({ title: emailErrorText(error), tone: 'danger' })
    }
  }
  const items: MenuItem[] = [
    { id: 'members', label: t('email.contacts.group_members'), icon: <Users size={13} />, onSelect: () => { setMenuOpen(false); setExpanded(true); onManage() } },
    { id: 'edit', label: t('email.contacts.edit_action'), icon: <Pencil size={13} />, onSelect: () => { setMenuOpen(false); onEdit() } },
    { id: 'star', label: t(group.starred ? 'email.contacts.unstar_action' : 'email.contacts.star_action'), icon: <Star size={13} fill={group.starred ? 'currentColor' : 'none'} />, onSelect: () => { setMenuOpen(false); void patch({ starred: !group.starred }) } },
    { id: 'pin', label: t(group.pinned ? 'email.contacts.unpin_action' : 'email.contacts.pin_action'), icon: <Pin size={13} />, onSelect: () => { setMenuOpen(false); void patch({ pinned: !group.pinned }) } },
  ]
  return (
    <li
      className="flex flex-col"
      onContextMenu={(event) => { setMenuOpen(false); menu.onContextMenu(event) }}
    >
      <div className="flex min-h-8 items-center gap-0.5 rounded-[var(--r-md)] pr-0.5 hover:bg-[var(--bg-hover)]">
        <button
          type="button"
          aria-current={active ? 'page' : undefined}
          aria-expanded={expanded}
          onClick={() => { setExpanded(!expanded); onSelect() }}
          onKeyDown={openFromKeyboard}
          className={cn(
            'flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
            active
              ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
        >
          <ChevronRight size={11} className={cn('shrink-0 transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
          <Avatar src={group.avatar || undefined} name={group.name} size={20} />
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
          <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">{group.members.length}</span>
          {group.starred && <Star size={10} className="shrink-0 text-[var(--warning)]" fill="currentColor" aria-hidden="true" />}
          {group.pinned && <Pin size={10} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />}
        </button>
        <IconButton
          ref={moreAnchor}
          label={t('email.contacts.more', { name: group.name })}
          size="xs"
          active={menuOpen}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <MoreHorizontal size={12} />
        </IconButton>
        <Menu anchor={moreAnchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={200} label={t('email.contacts.more_actions')} />
        {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} width={200} label={t('email.contacts.more_actions')} />}
      </div>
      {expanded && (
        <ul className="m-0 flex list-none flex-col gap-0.5 py-0.5 pl-5 pr-1">
          {group.members.length === 0 && <li className="px-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.contacts.no_members')}</li>}
          {group.members.map((member) => {
            const name = member.name || member.email
            return (
              <li key={member.id} className="flex min-h-7 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => { onSelectMember(member) }}
                  className="flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-11-5)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <Avatar src={member.avatar || undefined} name={name} size={16} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                </button>
                <IconButton label={t('email.contacts.edit_named', { name })} size="xs" onClick={() => onEditMember(member)}>
                  <Pencil size={11} />
                </IconButton>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}
