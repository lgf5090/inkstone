import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Code2,
  FolderInput,
  Forward,
  Mail,
  MailOpen,
  Reply,
  ReplyAll,
  Star,
  Trash2,
} from 'lucide-react'
import type { EmailAccount, EmailFolder, EmailMessage } from '@shared/email/model'
import { Button, Badge, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Menu, Tooltip, confirm, type MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'
import type { EmailComposeMode } from './email-address'
import { useEmailStore, type EmailLoadStatus } from './store'
import { folderLabel, messageFullDate, messageSubject, messageRecipients, senderLabel } from './format'
import { SourceDialog } from './SourceDialog'
import { ThreadMessage } from './ThreadMessage'
import { ComposePanel } from './ComposePanel'

const TOOLBAR_BUTTON = 'size-11 md:size-7'

export function MessagePane({
  account,
  folderId,
  summary,
  thread,
  threadStatus,
  threadError,
  selectedStatus,
  selectedError,
  folders,
  compose,
  draftId,
  onCompose,
  onEditDraft,
  onCancelCompose,
  onClosed,
  onReload,
  onBack,
  tools,
}: {
  account: EmailAccount
  folderId: string | null
  summary: EmailMessage | null
  thread: EmailMessage[]
  threadStatus: EmailLoadStatus
  threadError: string | null
  selectedStatus: EmailLoadStatus
  selectedError: string | null
  folders: readonly EmailFolder[]
  compose: EmailComposeMode | null
  draftId: string | null
  onCompose: (mode: EmailComposeMode) => void
  onEditDraft: (draftId: string) => void
  onCancelCompose: () => void
  onClosed: () => void
  onReload: () => void
  onBack?: () => void
  tools?: ReactNode
}) {
  const toggleStar = useEmailStore((state) => state.toggleStar)
  const setRead = useEmailStore((state) => state.setRead)
  const moveMessage = useEmailStore((state) => state.moveMessage)
  const deleteMessage = useEmailStore((state) => state.deleteMessage)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sourceOpen, setSourceOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const moveAnchor = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setExpanded(new Set(summary ? [summary.id] : []))
  }, [summary?.id])

  if (compose) {
    return (
      <ComposePanel
        account={account}
        mode={compose}
        draftId={draftId}
        original={compose === 'new' ? null : summary ?? thread[thread.length - 1] ?? null}
        onClose={onCancelCompose}
        onSent={onClosed}
      />
    )
  }

  if (!summary) {
    const content = selectedStatus === 'loading'
      ? <LoadingBlock label={t('email.detail.loading')} />
      : selectedStatus === 'error'
        ? (
            <Empty
              art="folder"
              title={t('email.detail.error')}
              description={selectedError}
              action={<Button size="sm" onClick={onReload}>{t('common.retry')}</Button>}
            />
          )
        : (
            <Empty art="select" title={t('email.detail.no_selection')} description={t('email.detail.no_selection_hint')} />
          )
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-base)]">
        <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2">
          {onBack && (
            <IconButton label={t('email.header.back')} size="sm" className={TOOLBAR_BUTTON} onClick={onBack}>
              <ArrowLeft size={15} />
            </IconButton>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">{tools}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{content}</div>
      </section>
    )
  }

  const messages = thread.length > 0 ? thread : [summary]
  const permanent = folderId === 'trash' || summary.folderId === 'trash'
  const draft = summary.folderId === 'draft'
  const recipients = messageRecipients(summary)

  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t(permanent ? 'email.detail.delete_forever_title' : 'email.detail.delete_title', { subject: messageSubject(summary) }),
      description: t(permanent ? 'email.detail.delete_forever_hint' : 'email.detail.delete_hint'),
      confirmLabel: t(permanent ? 'email.detail.delete_forever' : 'email.detail.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const removed = await deleteMessage(account.id, summary.id, permanent)
    setBusy(false)
    if (removed) onClosed()
  }

  const moveTo = async (target: string): Promise<void> => {
    setMoveOpen(false)
    setBusy(true)
    const moved = await moveMessage(account.id, summary.id, target)
    setBusy(false)
    if (moved) onClosed()
  }

  const moveItems: MenuItem[] = folders.map((folder) => ({
    id: folder.id,
    label: folderLabel(folder.id, folders),
    disabled: folder.id === summary.folderId,
    checked: folder.id === summary.folderId,
    onSelect: () => { void moveTo(folder.id) },
  }))

  const discardDraft = async (): Promise<void> => {
    const ok = await confirm({
      title: t('email.detail.discard_draft_title'),
      description: t('email.detail.discard_draft_hint'),
      confirmLabel: t('email.detail.discard_draft'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const removed = await deleteMessage(account.id, summary.id, false)
    setBusy(false)
    if (removed) onClosed()
  }

  return (
    <section aria-label={t('email.a11y.message')} aria-busy={busy} className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-base)]">
      <div className="flex h-11 shrink-0 items-center border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto no-scrollbar">
        {onBack && (
          <>
            <IconButton label={t('email.header.back')} size="sm" className={TOOLBAR_BUTTON} onClick={onBack}>
              <ArrowLeft size={15} />
            </IconButton>
            <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-[var(--border-subtle)]" />
          </>
        )}
        <Tooltip label={t('email.detail.reply')}>
          <IconButton label={t('email.detail.reply')} size="sm" className={TOOLBAR_BUTTON} onClick={() => onCompose('reply')}>
            <Reply size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('email.detail.reply_all')}>
          <IconButton label={t('email.detail.reply_all')} size="sm" className={TOOLBAR_BUTTON} onClick={() => onCompose('reply-all')}>
            <ReplyAll size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('email.detail.forward')}>
          <IconButton label={t('email.detail.forward')} size="sm" className={TOOLBAR_BUTTON} onClick={() => onCompose('forward')}>
            <Forward size={15} />
          </IconButton>
        </Tooltip>
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-[var(--border-subtle)]" />
        <Tooltip label={summary.starred ? t('email.list.unstar') : t('email.list.star')}>
          <IconButton
            label={summary.starred ? t('email.list.unstar') : t('email.list.star')}
            size="sm"
            className={TOOLBAR_BUTTON}
            active={summary.starred}
            onClick={() => { void toggleStar(account.id, summary.id) }}
          >
            <Star size={15} fill={summary.starred ? 'currentColor' : 'none'} />
          </IconButton>
        </Tooltip>
        <Tooltip label={summary.read ? t('email.list.mark_unread') : t('email.list.mark_read')}>
          <IconButton
            label={summary.read ? t('email.list.mark_unread') : t('email.list.mark_read')}
            size="sm"
            className={TOOLBAR_BUTTON}
            onClick={() => { void setRead(account.id, summary.id, !summary.read) }}
          >
            {summary.read ? <Mail size={15} /> : <MailOpen size={15} />}
          </IconButton>
        </Tooltip>
        <Tooltip label={t('email.detail.move')}>
          <IconButton
            ref={moveAnchor}
            label={t('email.detail.move')}
            size="sm"
            className={TOOLBAR_BUTTON}
            aria-haspopup="menu"
            aria-expanded={moveOpen}
            disabled={busy}
            onClick={() => setMoveOpen((open) => !open)}
          >
            <FolderInput size={15} />
          </IconButton>
        </Tooltip>
        <Menu
          anchor={moveAnchor}
          open={moveOpen}
          onClose={() => setMoveOpen(false)}
          items={moveItems}
          width={190}
          label={t('email.a11y.move_menu')}
        />
        <Tooltip label={permanent ? t('email.detail.delete_forever') : t('email.detail.delete')}>
          <IconButton
            label={permanent ? t('email.detail.delete_forever') : t('email.detail.delete')}
            size="sm"
            className={TOOLBAR_BUTTON}
            disabled={busy}
            onClick={() => { void remove() }}
          >
            <Trash2 size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('email.detail.source')}>
          <IconButton label={t('email.detail.source')} size="sm" className={TOOLBAR_BUTTON} onClick={() => setSourceOpen(true)}>
            <Code2 size={15} />
          </IconButton>
        </Tooltip>
        </div>
        {tools && (
          <span className="flex shrink-0 items-center gap-0.5 border-l border-[var(--border-subtle)] pl-1">
            {tools}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="border-b border-[var(--border-subtle)] px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h2 className="m-0 min-w-0 flex-1 text-[length:var(--text-16)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {messageSubject(summary)}
            </h2>
            {draft && <Badge tone="accent">{t('email.list.draft')}</Badge>}
            {summary.deliveryStatus === 'failed' && <Badge tone="danger">{t('email.list.send_failed')}</Badge>}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            <span className="min-w-0 truncate font-medium text-[var(--text-secondary)]">{senderLabel(summary.sender)}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{messageFullDate(summary.date)}</span>
            {recipients.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate">{t('email.detail.to')} {recipients[0]}</span>
              </>
            )}
            {messages.length > 1 && (
              <Badge tone="neutral">{t('email.detail.thread_messages_other', { count: messages.length })}</Badge>
            )}
          </div>
          {draft && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => onEditDraft(draftId ?? summary.id)}>
                {t('email.detail.edit_draft')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void discardDraft() }}>
                {t('email.detail.discard_draft')}
              </Button>
            </div>
          )}
          {summary.deliveryError && (
            <div role="alert" className="mt-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
              {summary.deliveryError}
            </div>
          )}
        </header>

        {threadStatus === 'loading' && <LoadingBlock label={t('email.detail.loading')} />}
        {threadError && (
          <div role="alert" className="mx-4 mt-3 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
            {threadError}
          </div>
        )}
        {messages.map((message) => (
          <ThreadMessage
            key={message.id}
            message={message}
            expanded={expanded.has(message.id)}
            onToggle={() => toggle(message.id)}
          />
        ))}
      </div>
      <SourceDialog open={sourceOpen} message={summary} onClose={() => setSourceOpen(false)} />
    </section>
  )
}
