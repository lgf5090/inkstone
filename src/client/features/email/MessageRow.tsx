import { Mail, MailOpen, Paperclip, RefreshCw, Star, Trash2 } from 'lucide-react'
import type { EmailFolder, EmailSummary } from '@shared/email/model'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Badge, IconButton } from '../../components/primitives'
import {
  folderLabel,
  highlightNodes,
  messageDateLabel,
  messageSnippet,
  messageSubject,
  senderLabel,
} from './format'

export function MessageRow({
  message,
  selected,
  searchMode,
  query,
  folders,
  onOpen,
  onToggleStar,
  onToggleRead,
  onDelete,
  onRetry,
}: {
  message: EmailSummary
  selected: boolean
  searchMode: boolean
  query: string
  folders: readonly EmailFolder[]
  onOpen: () => void
  onToggleStar: () => void
  onToggleRead: () => void
  onDelete: () => void
  onRetry: () => void
}) {
  const unread = !message.read
  const threadCount = message.threadCount ?? 1
  const failed = message.deliveryStatus === 'failed'
  const sender = senderLabel(message.sender)
  const subject = messageSubject(message)
  const snippet = messageSnippet(message)
  return (
    <li
      data-email-row=""
      className={cn(
        'relative flex items-stretch border-b border-[var(--border-subtle)] transition-colors',
        selected ? 'bg-[var(--accent-soft)]' : unread ? 'bg-[var(--bg-surface)]' : 'bg-[var(--bg-base)]',
        'hover:bg-[var(--bg-hover)]',
      )}
    >
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
    </li>
  )
}
