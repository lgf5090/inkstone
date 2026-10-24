import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlarmClock,
  ArrowLeft,
  Bell,
  BellOff,
  Clock,
  Code2,
  Download,
  FileCode2,
  Flag,
  FolderInput,
  Forward,
  Mail,
  MailOpen,
  Printer,
  Reply,
  ReplyAll,
  ShieldBan,
  Star,
  Trash2,
} from 'lucide-react'
import { escapeEmailHtml, stripEmailHtmlToText, textToEmailHtml } from '@shared/email/format'
import type { EmailAccount, EmailFolder, EmailMessage } from '@shared/email/model'
import { Button, Badge, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Menu, Tooltip, confirm, type MenuItem } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import type { EmailComposeMode } from './email-address'
import { useEmailStore, type EmailLoadStatus } from './store'
import { emailErrorText } from './errors'
import { sanitizeEmailHtml } from './email-markdown'
import { emailAddresses, folderLabel, messageFullDate, messageSubject, messageRecipients, senderLabel } from './format'
import { emailMarkdownSource, looksLikeMarkdown } from './markdown-reading'
import { SourceDialog } from './SourceDialog'
import { ThreadMessage } from './ThreadMessage'
import { ComposePanel } from './ComposePanel'
import { canSnoozeMessage, blockSenderMessage, followUpMenuItems, requestEmailFollowUp, requestImportantToggle, requestThreadMute, snoozeMenuItems } from './MessageRow'

const TOOLBAR_BUTTON = 'size-11 md:size-7'
const PRINT_HTML_TAG = /<[a-z][\s\S]*>/i
const PRINT_IFRAME_TIMEOUT_MS = 60_000
const PRINT_STYLE = [
  ':root{color-scheme:light}',
  'html,body{margin:0;padding:0;background:#fff;color:#111}',
  'body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}',
  '@page{margin:16mm}',
  'h1{margin:0 0 8px;font-size:18px;line-height:1.3}',
  '.meta{margin:0 0 16px;font-size:12px;color:#444}',
  '.meta-row{display:flex;gap:8px;margin:0 0 2px}',
  '.meta-label{min-width:56px;font-weight:600;color:#222}',
  '.body{overflow-wrap:anywhere}',
  'img{max-width:100%;height:auto}',
  'table{max-width:100%;border-collapse:collapse}',
  'pre{white-space:pre-wrap}',
  'a{color:#0b6bcb}',
  'blockquote{margin:0 0 0 0.8em;padding-left:0.8em;border-left:2px solid #d0d7de;color:#57606a}',
  'article + article{break-before:page}',
].join('')

function printBodyHtml(body: string): string {
  const source = PRINT_HTML_TAG.test(body) ? body : textToEmailHtml(body)
  return sanitizeEmailHtml(source) || `<p>${escapeEmailHtml(t('email.detail.empty_body'))}</p>`
}

function printMeta(message: EmailMessage): string {
  const rows: { label: string; value: string }[] = [
    { label: t('email.detail.header_from'), value: message.sender },
    { label: t('email.detail.header_to'), value: message.recipient },
    ...(message.cc ? [{ label: t('email.detail.header_cc'), value: message.cc }] : []),
    ...(message.bcc ? [{ label: t('email.detail.header_bcc'), value: message.bcc }] : []),
    { label: t('email.detail.header_date'), value: messageFullDate(message.date) },
  ]
  return rows
    .map((row) => `<div class="meta-row"><span class="meta-label">${escapeEmailHtml(row.label)}</span><span>${escapeEmailHtml(row.value)}</span></div>`)
    .join('')
}

function printDocument(messages: readonly EmailMessage[]): string {
  const title = messageSubject(messages[0]!)
  const articles = messages.map((message) => [
    '<article class="message">',
    `<h1>${escapeEmailHtml(messageSubject(message))}</h1>`,
    `<div class="meta">${printMeta(message)}</div>`,
    `<div class="body">${printBodyHtml(message.body)}</div>`,
    '</article>',
  ].join(''))
  return [
    '<!doctype html>',
    `<html lang="${escapeEmailHtml(document.documentElement.lang || 'en')}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data: blob:; style-src 'unsafe-inline'">`,
    `<title>${escapeEmailHtml(title)}</title>`,
    `<style>${PRINT_STYLE}</style>`,
    '</head>',
    '<body>',
    ...articles,
    '</body>',
    '</html>',
  ].join('')
}

export function printEmailMessages(messages: readonly EmailMessage[]): void {
  if (messages.length === 0) return
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('data-email-print', '')
  frame.tabIndex = -1
  frame.style.position = 'fixed'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.style.visibility = 'hidden'
  frame.srcdoc = printDocument(messages)
  let removed = false
  let timer = 0
  const cleanup = (): void => {
    if (removed) return
    removed = true
    window.clearTimeout(timer)
    frame.remove()
  }
  frame.addEventListener('load', () => {
    const view = frame.contentWindow
    if (!view) {
      cleanup()
      return
    }
    view.addEventListener('afterprint', cleanup, { once: true })
    view.print()
  }, { once: true })
  document.body.append(frame)
  timer = window.setTimeout(cleanup, PRINT_IFRAME_TIMEOUT_MS)
}

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
  onSnooze,
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
  onSnooze: (messageId: string, until: string) => Promise<boolean>
  onBack?: () => void
  tools?: ReactNode
}) {
  const toggleStar = useEmailStore((state) => state.toggleStar)
  const setRead = useEmailStore((state) => state.setRead)
  const moveMessage = useEmailStore((state) => state.moveMessage)
  const deleteMessage = useEmailStore((state) => state.deleteMessage)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [markdownOverride, setMarkdownOverride] = useState<boolean | null>(null)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [followUpOpen, setFollowUpOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const moveAnchor = useRef<HTMLButtonElement>(null)
  const snoozeAnchor = useRef<HTMLButtonElement>(null)
  const followUpAnchor = useRef<HTMLButtonElement>(null)

  const draftKey = thread.filter((message) => message.folderId === 'draft').map((message) => message.id).join(',')

  useEffect(() => {
    setMarkdownOverride(null)
  }, [summary?.id])

  useEffect(() => {
    const next = new Set<string>(summary ? [summary.id] : [])
    for (const message of thread) {
      if (message.folderId === 'draft') next.add(message.id)
    }
    setExpanded(next)
  }, [summary?.id, draftKey])

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
  const markdownSources = messages
    .map((message) => emailMarkdownSource(message.body))
    .filter((source): source is string => source !== null)
  const markdownAvailable = markdownSources.length > 0
  const markdownOn = markdownOverride ?? markdownSources.some(looksLikeMarkdown)
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

  const snooze = async (until: string): Promise<void> => {
    setBusy(true)
    const snoozed = await onSnooze(summary.id, until)
    setBusy(false)
    if (snoozed) onClosed()
  }

  const setFollowUp = async (at: string | null): Promise<void> => {
    setBusy(true)
    await requestEmailFollowUp(summary.id, at)
    setBusy(false)
  }

  const toggleImportant = async (): Promise<void> => {
    setBusy(true)
    await requestImportantToggle(summary)
    setBusy(false)
  }

  const toggleMute = async (): Promise<void> => {
    if (!summary.threadId) return
    setBusy(true)
    await requestThreadMute(summary.threadId, !summary.muted)
    setBusy(false)
  }

  const blockSender = async (): Promise<void> => {
    setBusy(true)
    const blocked = await blockSenderMessage(account.id, summary)
    setBusy(false)
    if (!blocked) return
    await useEmailStore.getState().refresh()
    onClosed()
  }

  const refreshAfterDraftChange = (draft: EmailMessage): void => {
    if (draft.id === summary.id) {
      onClosed()
      return
    }
    onReload()
    void useEmailStore.getState().refresh()
  }

  const sendThreadDraft = async (draft: EmailMessage): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await api.email.sendDraft(account.id, draft.id, {
        to: emailAddresses(draft.recipient).join(', '),
        cc: emailAddresses(draft.cc).join(', ') || undefined,
        bcc: emailAddresses(draft.bcc).join(', ') || undefined,
        subject: draft.subject,
        body: draft.bodySource ?? stripEmailHtmlToText(draft.body),
        bodyHtml: draft.body,
        attachmentIds: draft.attachments.map((attachment) => attachment.id),
        operationId: crypto.randomUUID(),
      })
      useUi.getState().toast({ title: t('email.compose.sent'), tone: 'success' })
      refreshAfterDraftChange(draft)
    } catch (reason) {
      useUi.getState().toast({
        title: t('email.toast.failed'),
        description: emailErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  const discardThreadDraft = async (draft: EmailMessage): Promise<void> => {
    const ok = await confirm({
      title: t('email.detail.discard_draft_title'),
      description: t('email.detail.discard_draft_hint'),
      confirmLabel: t('email.detail.discard_draft'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const removed = await deleteMessage(account.id, draft.id, false)
    setBusy(false)
    if (removed) refreshAfterDraftChange(draft)
  }

  const downloadEml = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.email.downloadEml(account.id, summary.id)
    } catch (reason) {
      useUi.getState().toast({
        title: t('email.raw.download_failed'),
        description: emailErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
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
        {canSnoozeMessage(summary.folderId) && (
          <>
            <Tooltip label={summary.important ? t('email.important.unmark') : t('email.important.mark')}>
              <IconButton
                label={summary.important ? t('email.important.unmark') : t('email.important.mark')}
                size="sm"
                className={TOOLBAR_BUTTON}
                active={summary.important}
                disabled={busy}
                onClick={() => { void toggleImportant() }}
              >
                <Flag size={15} fill={summary.important ? 'currentColor' : 'none'} />
              </IconButton>
            </Tooltip>
            <Tooltip label={summary.muted ? t('email.mute.unmute') : t('email.mute.thread')}>
              <IconButton
                label={summary.muted ? t('email.mute.unmute') : t('email.mute.thread')}
                size="sm"
                className={TOOLBAR_BUTTON}
                active={summary.muted}
                disabled={busy || !summary.threadId}
                onClick={() => { void toggleMute() }}
              >
                {summary.muted ? <Bell size={15} /> : <BellOff size={15} />}
              </IconButton>
            </Tooltip>
          </>
        )}
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
        {canSnoozeMessage(summary.folderId) && (
          <>
            <Tooltip label={t('email.snooze.menu')}>
              <IconButton
                ref={snoozeAnchor}
                label={t('email.snooze.menu')}
                size="sm"
                className={TOOLBAR_BUTTON}
                aria-haspopup="menu"
                aria-expanded={snoozeOpen}
                disabled={busy}
                onClick={() => setSnoozeOpen((open) => !open)}
              >
                <Clock size={15} />
              </IconButton>
            </Tooltip>
            <Menu
              anchor={snoozeAnchor}
              open={snoozeOpen}
              onClose={() => setSnoozeOpen(false)}
              items={snoozeMenuItems((until) => {
                setSnoozeOpen(false)
                void snooze(until)
              })}
              width={190}
              label={t('email.snooze.menu')}
            />
            <Tooltip label={t('email.followup.menu')}>
              <IconButton
                ref={followUpAnchor}
                label={t('email.followup.menu')}
                size="sm"
                className={TOOLBAR_BUTTON}
                aria-haspopup="menu"
                aria-expanded={followUpOpen}
                active={Boolean(summary.followUpAt)}
                disabled={busy}
                onClick={() => setFollowUpOpen((open) => !open)}
              >
                <AlarmClock size={15} />
              </IconButton>
            </Tooltip>
            <Menu
              anchor={followUpAnchor}
              open={followUpOpen}
              onClose={() => setFollowUpOpen(false)}
              items={followUpMenuItems((at) => {
                setFollowUpOpen(false)
                void setFollowUp(at)
              }, Boolean(summary.followUpAt))}
              width={230}
              label={t('email.followup.menu')}
            />
          </>
        )}
        {summary.folderId !== 'sent' && summary.folderId !== 'draft' && summary.folderId !== 'trash' && (
          <Tooltip label={t('email.rules.block_sender')}>
            <IconButton
              label={t('email.rules.block_sender')}
              size="sm"
              className={TOOLBAR_BUTTON}
              disabled={busy}
              onClick={() => { void blockSender() }}
            >
              <ShieldBan size={15} />
            </IconButton>
          </Tooltip>
        )}
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
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-[var(--border-subtle)]" />
        <Tooltip label={t('email.raw.download')}>
          <IconButton
            label={t('email.raw.download')}
            size="sm"
            className={TOOLBAR_BUTTON}
            disabled={busy}
            onClick={() => { void downloadEml() }}
          >
            <Download size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('email.raw.print')}>
          <IconButton label={t('email.raw.print')} size="sm" className={TOOLBAR_BUTTON} onClick={() => printEmailMessages(messages)}>
            <Printer size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('email.detail.source')}>
          <IconButton label={t('email.detail.source')} size="sm" className={TOOLBAR_BUTTON} onClick={() => setSourceOpen(true)}>
            <Code2 size={15} />
          </IconButton>
        </Tooltip>
        {markdownAvailable && (
          <Tooltip label={markdownOn ? t('email.detail.show_plain') : t('email.detail.render_markdown')}>
            <IconButton
              label={markdownOn ? t('email.detail.show_plain') : t('email.detail.render_markdown')}
              size="sm"
              className={TOOLBAR_BUTTON}
              active={markdownOn}
              onClick={() => setMarkdownOverride(!markdownOn)}
            >
              <FileCode2 size={15} />
            </IconButton>
          </Tooltip>
        )}
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
            {summary.important && <Badge tone="warning">{t('email.important.badge')}</Badge>}
            {summary.muted && <Badge tone="neutral">{t('email.mute.badge')}</Badge>}
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
            busy={busy}
            markdown={markdownOn}
            onToggle={() => toggle(message.id)}
            onSendDraft={(draft) => { void sendThreadDraft(draft) }}
            onEditDraft={(draft) => onEditDraft(draft.id)}
            onDiscardDraft={(draft) => { void discardThreadDraft(draft) }}
          />
        ))}
      </div>
      <SourceDialog open={sourceOpen} message={summary} onClose={() => setSourceOpen(false)} />
    </section>
  )
}
