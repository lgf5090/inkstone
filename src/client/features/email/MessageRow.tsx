import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { AlarmClock, Archive, Bell, BellOff, Check, Clock, Flag, FolderInput, Mail, MailOpen, Minus, Paperclip, RefreshCw, ShieldBan, Star, Tag, Trash2 } from 'lucide-react'
import type { EmailFolder, EmailSummary, EmailTag } from '@shared/email/model'
import { isEmailSystemFolder } from '@shared/email/model'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Badge, IconButton } from '../../components/primitives'
import { Menu, MenuSubmenuList, Tooltip, confirm, useContextMenu, type MenuItem, type MenuSubmenuContext } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { emailDragBlocked, hasSelectedTextInside, setEmailDragImage, writeEmailDrag } from './email-drag'
import { emailErrorText } from './errors'
import {
  folderLabel,
  highlightNodes,
  messageDateLabel,
  messageSnippet,
  messageSubject,
  senderLabel,
  SYSTEM_FOLDER_LABEL_KEYS,
} from './format'
import { emailFollowUpOptions, emailSnoozeOptions, useEmailStore } from './store'

const MENU_INSET = 12

export function canSnoozeMessage(folderId: string): boolean {
  return folderId !== 'sent' && folderId !== 'draft' && folderId !== 'trash' && folderId !== 'spam'
}

export function snoozeMenuItems(onPick: (until: string) => void): MenuItem[] {
  return emailSnoozeOptions().map((option) => ({
    id: `snooze-${option.preset}`,
    label: t(option.key),
    icon: <Clock size={13} />,
    onSelect: () => onPick(option.until),
  }))
}

export async function requestEmailSnooze(messageId: string, until: string): Promise<boolean> {
  const state = useEmailStore.getState()
  if (!state.accountId) {
    useUi.getState().toast({ title: t('email.toast.failed'), tone: 'danger' })
    return false
  }
  const ok = await state.snoozeMessage(state.accountId, messageId, until)
  if (ok) useUi.getState().toast({ title: t('email.snooze.done'), tone: 'success' })
  return ok
}

export function followUpMenuItems(onPick: (at: string | null) => void, active: boolean): MenuItem[] {
  return [
    ...emailFollowUpOptions().map((option) => ({
      id: `follow-up-${option.preset}`,
      label: t(option.key),
      icon: <AlarmClock size={13} />,
      onSelect: () => onPick(option.at),
    })),
    {
      id: 'follow-up-clear',
      label: t('email.followup.clear'),
      icon: <BellOff size={13} />,
      disabled: !active,
      separatorBefore: true,
      onSelect: () => onPick(null),
    },
    {
      id: 'follow-up-hint',
      label: t('email.followup.hint'),
      disabled: true,
    },
  ]
}

export async function requestEmailFollowUp(messageId: string, at: string | null): Promise<boolean> {
  const state = useEmailStore.getState()
  if (!state.accountId) {
    useUi.getState().toast({ title: t('email.toast.failed'), tone: 'danger' })
    return false
  }
  const ok = await state.setFollowUp(state.accountId, messageId, at)
  if (ok) useUi.getState().toast({ title: t(at ? 'email.followup.set' : 'email.followup.cleared'), tone: 'success' })
  return ok
}

export async function requestImportantToggle(message: EmailSummary): Promise<boolean> {
  const state = useEmailStore.getState()
  if (!state.accountId) {
    useUi.getState().toast({ title: t('email.toast.failed'), tone: 'danger' })
    return false
  }
  const ok = await state.toggleImportant(state.accountId, message.id)
  if (ok) useUi.getState().toast({ title: t(message.important ? 'email.important.unmarked' : 'email.important.marked'), tone: 'success' })
  return ok
}

export async function requestThreadMute(threadId: string, muted: boolean): Promise<boolean> {
  const state = useEmailStore.getState()
  if (!state.accountId) {
    useUi.getState().toast({ title: t('email.toast.failed'), tone: 'danger' })
    return false
  }
  const ok = await state.muteThread(state.accountId, threadId, muted)
  if (ok) useUi.getState().toast({ title: t(muted ? 'email.mute.muted' : 'email.mute.unmuted'), tone: 'success' })
  return ok
}

export async function blockSenderMessage(accountId: string, message: EmailSummary): Promise<boolean> {
  const ok = await confirm({
    title: t('email.rules.block_sender_title', { sender: senderLabel(message.sender) || message.sender }),
    description: t('email.rules.block_sender_hint'),
    confirmLabel: t('email.rules.block_sender'),
    tone: 'danger',
  })
  if (!ok) return false
  try {
    await api.email.blockSender(accountId, message.id)
    useUi.getState().toast({ title: t('email.rules.block_sender_done'), tone: 'success' })
    return true
  } catch (reason) {
    useUi.getState().toast({
      title: t('email.toast.failed'),
      description: emailErrorText(reason),
      tone: 'danger',
    })
    return false
  }
}

export async function requestBlockSender(message: EmailSummary): Promise<boolean> {
  const state = useEmailStore.getState()
  if (!state.accountId) {
    useUi.getState().toast({ title: t('email.toast.failed'), tone: 'danger' })
    return false
  }
  const blocked = await blockSenderMessage(state.accountId, message)
  if (!blocked) return false
  const latest = useEmailStore.getState()
  if (latest.selectedId === message.id) latest.clearOpenMessage()
  await latest.refresh()
  return true
}

export function SelectionBox({
  checked,
  mixed = false,
  label,
  onToggle,
  className,
}: {
  checked: boolean
  mixed?: boolean
  label: string
  onToggle: (event: ReactMouseEvent<HTMLButtonElement>) => void
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        'ink-tap-pad relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-[var(--dur-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]',
        checked || mixed
          ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]'
          : 'border-[var(--border-strong)] bg-[var(--bg-inset)]',
        className,
      )}
    >
      {mixed
        ? <Minus size={10} strokeWidth={3} aria-hidden="true" />
        : checked
          ? <Check size={10} strokeWidth={3} aria-hidden="true" />
          : null}
    </button>
  )
}

export function folderPathLabel(folder: EmailFolder, byId: ReadonlyMap<string, EmailFolder>): string {
  const names: string[] = []
  const seen = new Set<string>()
  let current: EmailFolder | undefined = folder
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    names.unshift(isEmailSystemFolder(current.id) ? t(SYSTEM_FOLDER_LABEL_KEYS[current.id]) : current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return names.join(' / ')
}

export function MessageRow({
  message,
  selected,
  batchSelected,
  selectedIds,
  dragEnabled,
  searchMode,
  query,
  folders,
  tags,
  onOpen,
  onToggleSelect,
  onToggleStar,
  onToggleRead,
  onMove,
  onArchive,
  onTag,
  onDelete,
  onRetry,
}: {
  message: EmailSummary
  selected: boolean
  batchSelected: boolean
  selectedIds: ReadonlySet<string>
  dragEnabled: boolean
  searchMode: boolean
  query: string
  folders: readonly EmailFolder[]
  tags: readonly EmailTag[]
  onOpen: () => void
  onToggleSelect: (modifiers: { shiftKey: boolean }) => void
  onToggleStar: () => void
  onToggleRead: () => void
  onMove: (folderId: string) => void
  onArchive: () => void
  onTag: (tag: EmailTag) => void
  onDelete: () => void
  onRetry: () => void
}) {
  const contextMenu = useContextMenu()
  const unread = !message.read
  const threadCount = message.threadCount ?? 1
  const failed = message.deliveryStatus === 'failed'
  const canBlockSender = message.folderId !== 'sent' && message.folderId !== 'draft' && message.folderId !== 'trash'
  const sender = senderLabel(message.sender)
  const recipient = message.recipient.trim() ? senderLabel(message.recipient) : ''
  const correspondent = message.folderId === 'sent' || message.folderId === 'draft'
    ? recipient || t('email.list.no_recipient')
    : sender
  const subject = messageSubject(message)
  const snippet = messageSnippet(message)
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const moveTargets = folders.filter((folder) => folder.id !== message.folderId)
  const snoozeItem: MenuItem = {
    id: 'snooze',
    label: t('email.snooze.menu'),
    icon: <Clock size={13} />,
    submenu: ({ closeMenu }) => (
      <MenuSubmenuList
        label={t('email.snooze.menu')}
        items={snoozeMenuItems((until) => {
          void requestEmailSnooze(message.id, until)
          closeMenu()
        })}
      />
    ),
  }
  const items: MenuItem[] = [
    { id: 'open', label: t('email.message.open'), icon: <MailOpen size={13} />, onSelect: onOpen },
    {
      id: 'read',
      label: t(unread ? 'email.list.mark_read' : 'email.list.mark_unread'),
      icon: unread ? <MailOpen size={13} /> : <Mail size={13} />,
      onSelect: onToggleRead,
    },
    {
      id: 'star',
      label: t(message.starred ? 'email.list.unstar' : 'email.list.star'),
      icon: <Star size={13} fill={message.starred ? 'currentColor' : 'none'} />,
      onSelect: onToggleStar,
    },
    ...(canSnoozeMessage(message.folderId)
      ? [{
          id: 'important',
          label: t(message.important ? 'email.important.unmark' : 'email.important.mark'),
          icon: <Flag size={13} fill={message.important ? 'currentColor' : 'none'} />,
          onSelect: () => { void requestImportantToggle(message) },
        }]
      : []),
    ...(canSnoozeMessage(message.folderId) && message.threadId
      ? [{
          id: 'mute',
          label: t(message.muted ? 'email.mute.unmute' : 'email.mute.thread'),
          icon: message.muted ? <Bell size={13} /> : <BellOff size={13} />,
          onSelect: () => { void requestThreadMute(message.threadId!, !message.muted) },
        }]
      : []),
    {
      id: 'move',
      label: t('email.message.move_to'),
      icon: <FolderInput size={13} />,
      submenu: ({ closeMenu }) => (
        <MenuSubmenuList
          label={t('email.message.move_to')}
          items={moveTargets.length > 0
            ? moveTargets.map((folder) => ({
                id: folder.id,
                label: folderPathLabel(folder, byId),
                icon: <FolderInput size={13} />,
                onSelect: () => {
                  onMove(folder.id)
                  closeMenu()
                },
              }))
            : [{ id: 'empty', label: t('email.message.move_empty'), disabled: true }]}
        />
      ),
    },
    {
      id: 'tag',
      label: t('email.message.tag'),
      icon: <Tag size={13} />,
      submenu: ({ closeMenu }) => (
        <MenuSubmenuList
          label={t('email.message.tag')}
          items={tags.length > 0
            ? tags.map((tag) => ({
                id: tag.id,
                label: tag.name,
                icon: <Tag size={13} />,
                onSelect: () => {
                  onTag(tag)
                  closeMenu()
                },
              }))
            : [{ id: 'empty', label: t('email.message.tag_empty'), disabled: true }]}
        />
      ),
    },
    ...(canSnoozeMessage(message.folderId) ? [snoozeItem] : []),
    ...(canSnoozeMessage(message.folderId)
      ? [{
          id: 'follow-up',
          label: t('email.followup.menu'),
          icon: <AlarmClock size={13} />,
          submenu: ({ closeMenu }: MenuSubmenuContext) => (
            <MenuSubmenuList
              label={t('email.followup.menu')}
              items={followUpMenuItems((at) => {
                void requestEmailFollowUp(message.id, at)
                closeMenu()
              }, Boolean(message.followUpAt))}
            />
          ),
        }]
      : []),
    {
      id: 'archive',
      label: t('email.message.archive'),
      icon: <Archive size={13} />,
      disabled: message.folderId === 'archive',
      onSelect: onArchive,
    },
    ...(canBlockSender
      ? [{
          id: 'block-sender',
          label: t('email.rules.block_sender'),
          icon: <ShieldBan size={13} />,
          separatorBefore: true,
          onSelect: () => { void requestBlockSender(message) },
        }]
      : []),
    {
      id: 'delete',
      label: t('email.list.delete'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: !canBlockSender,
      onSelect: onDelete,
    },
  ]
  const openMenuFromKeyboard = (event: ReactKeyboardEvent<HTMLLIElement>): void => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    contextMenu.openAt({ x: rect.left + MENU_INSET, y: rect.top + MENU_INSET })
  }
  const startDrag = (event: ReactDragEvent<HTMLButtonElement>): void => {
    if (!dragEnabled || emailDragBlocked() || hasSelectedTextInside(event.currentTarget)) {
      event.preventDefault()
      return
    }
    const ids = selectedIds.has(message.id) ? [...selectedIds] : [message.id]
    writeEmailDrag(event.dataTransfer, ids)
    setEmailDragImage(event.dataTransfer, event.currentTarget)
  }
  return (
    <li
      data-email-row=""
      onContextMenu={contextMenu.onContextMenu}
      onKeyDown={openMenuFromKeyboard}
      className={cn(
        'group relative flex items-stretch border-b border-[var(--border-subtle)] transition-colors',
        selected ? 'bg-[var(--accent-soft)]' : unread ? 'bg-[var(--bg-surface)]' : 'bg-[var(--bg-base)]',
        'hover:bg-[var(--bg-hover)]',
      )}
    >
      <span className="pointer-events-none flex w-7 shrink-0 items-center justify-center opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100">
        <SelectionBox
          checked={batchSelected}
          label={t('email.list.select', { subject })}
          onToggle={(event) => onToggleSelect({ shiftKey: event.shiftKey })}
        />
      </span>
      <button
        type="button"
        data-email-open=""
        draggable={dragEnabled}
        onDragStart={startDrag}
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-inset"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {unread && <span data-unread="" aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--accent)]" />}
          {unread && <span className="sr-only">{t('email.list.unread')}</span>}
          <span className={cn('min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-normal text-[var(--text-secondary)]', unread && 'font-semibold text-[var(--text-primary)]')}>
            {correspondent}
          </span>
          {searchMode && (
            <Badge tone="neutral" className="shrink-0">{folderLabel(message.folderId, folders)}</Badge>
          )}
          <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-tertiary)]">
            {messageDateLabel(message.date)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn('min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-normal text-[var(--text-secondary)]', unread && 'font-semibold text-[var(--text-primary)]')}>
            {highlightNodes(subject, query)}
          </span>
          {threadCount > 1 && (
            <span
              aria-label={t('email.list.thread_count', { count: threadCount })}
              className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]"
            >
              {threadCount}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {highlightNodes(snippet, query)}
          </span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1 pt-0.5">
          {message.important && (
            <span className="inline-flex items-center gap-0.5 text-[length:var(--text-10-5)] text-[var(--warning)]">
              <Flag size={11} aria-hidden="true" fill="currentColor" />
              <span className="sr-only">{t('email.important.badge')}</span>
            </span>
          )}
          {message.muted && (
            <span className="inline-flex items-center gap-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              <BellOff size={11} aria-hidden="true" />
              <span className="sr-only">{t('email.mute.badge')}</span>
            </span>
          )}
          {message.hasDraft && <Badge tone="accent">{t('email.list.draft')}</Badge>}
          {message.needsReply && <Badge tone="warning">{t('email.list.needs_reply')}</Badge>}
          {failed && <Badge tone="danger">{t('email.list.send_failed')}</Badge>}
          {message.hasAttachment && (
            <span className="inline-flex items-center gap-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              <Paperclip size={11} aria-hidden="true" />
              <span className="sr-only">{t('email.list.has_attachment')}</span>
            </span>
          )}
        </span>
      </button>
      <div className="flex shrink-0 flex-col items-center justify-center gap-0.5 pr-1.5">
        {failed && (
          <IconButton label={t('email.list.retry_send')} size="xs" onClick={onRetry}>
            <RefreshCw size={13} />
          </IconButton>
        )}
        <Tooltip label={message.starred ? t('email.list.unstar') : t('email.list.star')} side="left">
          <IconButton
            label={message.starred ? t('email.list.unstar') : t('email.list.star')}
            size="xs"
            active={message.starred}
            onClick={onToggleStar}
          >
            <Star size={13} fill={message.starred ? 'currentColor' : 'none'} />
          </IconButton>
        </Tooltip>
        <Tooltip label={message.read ? t('email.list.mark_unread') : t('email.list.mark_read')} side="left">
          <IconButton
            label={message.read ? t('email.list.mark_unread') : t('email.list.mark_read')}
            size="xs"
            onClick={onToggleRead}
          >
            {message.read ? <Mail size={13} /> : <MailOpen size={13} />}
          </IconButton>
        </Tooltip>
        <Tooltip label={t('email.list.delete')} side="left">
          <IconButton label={t('email.list.delete')} size="xs" onClick={onDelete}>
            <Trash2 size={13} />
          </IconButton>
        </Tooltip>
      </div>
      {contextMenu.point && (
        <Menu
          anchor={contextMenu.point}
          open
          onClose={contextMenu.close}
          items={items}
          label={t('email.message.menu')}
        />
      )}
    </li>
  )
}
