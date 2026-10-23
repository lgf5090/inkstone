import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Archive, Check, FolderInput, Mail, MailOpen, Minus, Paperclip, RefreshCw, Star, Tag, Trash2 } from 'lucide-react'
import type { EmailFolder, EmailSummary, EmailTag } from '@shared/email/model'
import { isEmailSystemFolder } from '@shared/email/model'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Badge, IconButton } from '../../components/primitives'
import { Menu, MenuSubmenuList, useContextMenu, type MenuItem } from '../../components/overlay'
import {
  folderLabel,
  highlightNodes,
  messageDateLabel,
  messageSnippet,
  messageSubject,
  senderLabel,
  SYSTEM_FOLDER_LABEL_KEYS,
} from './format'

const MENU_INSET = 12

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
  const sender = senderLabel(message.sender)
  const subject = messageSubject(message)
  const snippet = messageSnippet(message)
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const moveTargets = folders.filter((folder) => folder.id !== message.folderId)
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
    {
      id: 'archive',
      label: t('email.message.archive'),
      icon: <Archive size={13} />,
      disabled: message.folderId === 'archive',
      onSelect: onArchive,
    },
    {
      id: 'delete',
      label: t('email.list.delete'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: onDelete,
    },
  ]
  const openMenuFromKeyboard = (event: ReactKeyboardEvent<HTMLLIElement>): void => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    contextMenu.openAt({ x: rect.left + MENU_INSET, y: rect.top + MENU_INSET })
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
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-inset"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {unread && <span data-unread="" aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--accent)]" />}
          {unread && <span className="sr-only">{t('email.list.unread')}</span>}
          <span className={cn('min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]', unread && 'font-semibold')}>
            {sender}
          </span>
          {searchMode && (
            <Badge tone="neutral" className="shrink-0">{folderLabel(message.folderId, folders)}</Badge>
          )}
          <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-tertiary)]">
            {messageDateLabel(message.date)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn('min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-secondary)]', unread && 'text-[var(--text-primary)]')}>
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
        <IconButton
          label={message.starred ? t('email.list.unstar') : t('email.list.star')}
          size="xs"
          active={message.starred}
          onClick={onToggleStar}
        >
          <Star size={13} fill={message.starred ? 'currentColor' : 'none'} />
        </IconButton>
        <IconButton
          label={message.read ? t('email.list.mark_unread') : t('email.list.mark_read')}
          size="xs"
          onClick={onToggleRead}
        >
          {message.read ? <Mail size={13} /> : <MailOpen size={13} />}
        </IconButton>
        <IconButton label={t('email.list.delete')} size="xs" onClick={onDelete}>
          <Trash2 size={13} />
        </IconButton>
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
