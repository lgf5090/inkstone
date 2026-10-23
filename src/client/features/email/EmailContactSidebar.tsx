import { useRef, useState } from 'react'
import { ChevronRight, MoreHorizontal, Pencil, Pin, Plus, Star, Trash2, UserPlus, Users } from 'lucide-react'
import type { EmailContact, EmailGroupWithMembers } from '@shared/email/contacts'
import { Avatar, IconButton, SectionLabel, Spinner } from '../../components/primitives'
import { Menu, Tooltip, confirm, type MenuItem } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'
import type { EmailLoadStatus } from './store'

export function EmailContactSidebar({
  contacts,
  contactsStatus,
  contactsError,
  groups,
  groupsStatus,
  groupsError,
  activeContactId,
  activeGroupId,
  onSelectContact,
  onSelectGroup,
  onNewContact,
  onNewGroup,
  onEditContact,
  onEditGroup,
  onManage,
  onChanged,
  onReload,
  onClose,
}: {
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
  onNewContact: () => void
  onNewGroup: () => void
  onEditContact: (contact: EmailContact) => void
  onEditGroup: (group: EmailGroupWithMembers) => void
  onManage: () => void
  onChanged: () => void
  onReload: () => void
  onClose?: () => void
}) {
  const [addOpen, setAddOpen] = useState(false)
  const addAnchor = useRef<HTMLButtonElement>(null)
  const addItems: MenuItem[] = [
    { id: 'new-contact', label: t('email.contacts.new_contact'), icon: <UserPlus size={13} />, onSelect: () => { setAddOpen(false); onNewContact() } },
    { id: 'new-group', label: t('email.contacts.new_group'), icon: <Users size={13} />, onSelect: () => { setAddOpen(false); onNewGroup() } },
  ]
  const loading = contactsStatus === 'loading' && contacts.length === 0
  const failed = contactsStatus === 'error' && contacts.length === 0
  return (
    <section aria-label={t('email.contacts.title')} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-1 pr-0.5">
        <SectionLabel className="p-0">{t('email.contacts.title')}</SectionLabel>
        <span className="flex items-center gap-0.5">
          <Tooltip label={t('email.contacts.manage')} side="top">
            <IconButton label={t('email.contacts.manage')} size="xs" onClick={onManage}>
              <Users size={12} />
            </IconButton>
          </Tooltip>
          <IconButton
            ref={addAnchor}
            label={t('email.contacts.add')}
            size="xs"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen(!addOpen)}
          >
            <Plus size={12} />
          </IconButton>
        </span>
      </div>
      <Menu anchor={addAnchor} open={addOpen} onClose={() => setAddOpen(false)} items={addItems} width={190} label={t('email.contacts.add')} />
      {loading && <div className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]"><Spinner size={10} />{t('common.loading')}</div>}
      {failed && (
        <div className="flex items-center gap-1 px-2 py-1 text-[length:var(--text-11)] text-[var(--danger)]">
          <span className="min-w-0 flex-1 truncate">{contactsError ?? t('email.contacts.error_load')}</span>
          <button type="button" className="shrink-0 underline" onClick={onReload}>{t('common.retry')}</button>
        </div>
      )}
      {!loading && !failed && contacts.length === 0 && (
        <p className="m-0 px-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.contacts.empty_hint')}</p>
      )}
      {!loading && !failed && contacts.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {contacts.map((contact) => (
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
      <div className="mt-1 flex items-center justify-between gap-1 pr-0.5">
        <SectionLabel className="p-0">{t('email.contacts.groups')}</SectionLabel>
        <Tooltip label={t('email.contacts.new_group')} side="top">
          <IconButton label={t('email.contacts.new_group')} size="xs" onClick={onNewGroup}>
            <Users size={12} />
          </IconButton>
        </Tooltip>
      </div>
      {groupsStatus === 'loading' && groups.length === 0 && (
        <div className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]"><Spinner size={10} />{t('common.loading')}</div>
      )}
      {groupsStatus === 'error' && groups.length === 0 && (
        <div className="flex items-center gap-1 px-2 py-1 text-[length:var(--text-11)] text-[var(--danger)]">
          <span className="min-w-0 flex-1 truncate">{groupsError ?? t('email.contacts.groups_error')}</span>
          <button type="button" className="shrink-0 underline" onClick={onReload}>{t('common.retry')}</button>
        </div>
      )}
      {groups.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {groups.map((group) => (
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
      {groupsStatus === 'ready' && groups.length === 0 && (
        <p className="m-0 px-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.contacts.groups_empty_hint')}</p>
      )}
    </section>
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
  const [menuOpen, setMenuOpen] = useState(false)
  const moreAnchor = useRef<HTMLButtonElement>(null)
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
    <li className="flex min-h-8 items-center gap-0.5 pr-0.5">
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        className={cn(
          'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
          active
            ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
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
  const [menuOpen, setMenuOpen] = useState(false)
  const moreAnchor = useRef<HTMLButtonElement>(null)
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
    <li className="flex flex-col">
      <div className="flex min-h-8 items-center gap-0.5 pr-0.5">
        <button
          type="button"
          aria-current={active ? 'page' : undefined}
          aria-expanded={expanded}
          onClick={() => { setExpanded(!expanded); onSelect() }}
          className={cn(
            'flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
            active
              ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
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
