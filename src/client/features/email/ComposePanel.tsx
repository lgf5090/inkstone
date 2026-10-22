import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { FileText, Paperclip, X } from 'lucide-react'
import type { EmailAccount, EmailMessage } from '@shared/email/model'
import { EMAIL_ATTACHMENT_MAX_BYTES } from '@shared/email/model'
import { buildEmailQuoteMarkdown, formatEmailQuotedDate, splitEmailList, stripEmailHtmlToText } from '@shared/email/format'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Segmented } from '../../components/form'
import { confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { formatBytes } from '../../lib/time'
import { api } from '../../lib/api'
import { attachmentHubApi } from '../attachment-hub/api'
import { FilePreviewModal } from '../file-preview'
import { FormatToolbar } from '../../editor/FormatToolbar'
import { insertLink } from '../../editor/commands'
import { prompt } from '../../components/overlay'
import { emailMarkdownToHtml } from './email-markdown'
import { EmailComposer } from './EmailComposer'
import type { EmailComposeMode } from './email-address'

interface ComposeAttachment {
  id: string
  filename: string
  mime: string
  size: number
}

function signatureBlock(account: EmailAccount): string {
  const signature = account.settings.signature
  if (!signature?.enabled || !signature.text.trim()) return ''
  return `\n\n--\n${signature.text.trim()}`
}

function replyAllRecipients(original: EmailMessage, self: string): { to: string; cc: string } {
  const selfAddress = self.toLowerCase()
  const to: string[] = []
  const seen = new Set<string>()
  const push = (address: string) => {
    const normalized = address.trim().toLowerCase()
    if (!normalized || normalized === selfAddress || seen.has(normalized)) return
    seen.add(normalized)
    to.push(address.trim())
  }
  push(original.sender)
  for (const address of splitEmailList(original.recipient)) push(address)
  const cc: string[] = []
  for (const address of splitEmailList(original.cc)) {
    const normalized = address.trim().toLowerCase()
    if (!normalized || normalized === selfAddress || seen.has(normalized)) continue
    seen.add(normalized)
    cc.push(address.trim())
  }
  return { to: to.join(', '), cc: cc.join(', ') }
}

function initialFields(account: EmailAccount, mode: EmailComposeMode, original: EmailMessage | null): {
  to: string
  cc: string
  subject: string
  body: string
  showCc: boolean
} {
  const signature = signatureBlock(account)
  if (!original || mode === 'new') {
    return { to: '', cc: '', subject: '', body: signature.trimStart(), showCc: false }
  }
  const quote = buildEmailQuoteMarkdown(original.date, original.sender, original.body)
  if (mode === 'forward') {
    const forwarded = `\n\n---------- Forwarded message ----------\nFrom: ${original.sender}\nDate: ${formatEmailQuotedDate(original.date)}\nSubject: ${original.subject}\n\n${stripEmailHtmlToText(original.body)}`
    return { to: '', cc: '', subject: original.subject.startsWith('Fwd:') ? original.subject : `Fwd: ${original.subject}`, body: `${signature}${forwarded}`.trimStart(), showCc: false }
  }
  const subject = original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`
  const body = `${signature}${quote}`.trimStart()
  if (mode === 'reply-all') {
    const recipients = replyAllRecipients(original, account.address)
    return { to: recipients.to, cc: recipients.cc, subject, body, showCc: Boolean(recipients.cc) }
  }
  return { to: original.sender, cc: '', subject, body, showCc: false }
}

export function ComposePanel({
  account,
  mode,
  draftId,
  original,
  onClose,
  onSent,
}: {
  account: EmailAccount
  mode: EmailComposeMode
  draftId: string | null
  original: EmailMessage | null
  onClose: () => void
  onSent: () => void
}) {
  const initial = useMemo(() => initialFields(account, mode, original), [account, mode, original])
  const [to, setTo] = useState(initial.to)
  const [cc, setCc] = useState(initial.cc)
  const [bcc, setBcc] = useState('')
  const [subject, setSubject] = useState(initial.subject)
  const [body, setBody] = useState(initial.body)
  const [showCc, setShowCc] = useState(initial.showCc)
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit')
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(draftId)
  const [threading, setThreading] = useState<{ inReplyTo: string | null, threadId: string | null }>(() => (
    draftId || !original
      ? { inReplyTo: null, threadId: null }
      : { inReplyTo: original.id, threadId: original.threadId }
  ))
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([])
  const [preview, setPreview] = useState<ComposeAttachment | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const dirty = to !== initial.to || cc !== initial.cc || bcc !== '' || subject !== initial.subject || body !== initial.body

  useEffect(() => {
    if (!draftId) return
    let cancelled = false
    void api.email.getEmail(account.id, draftId).then((message) => {
      if (cancelled) return
      setTo(message.recipient ?? '')
      setCc(message.cc ?? '')
      setBcc(message.bcc ?? '')
      setSubject(message.subject)
      setBody(message.bodySource ?? message.body)
      setShowCc(Boolean(message.cc || message.bcc))
      setThreading({ inReplyTo: message.inReplyTo, threadId: message.threadId })
      setAttachments(message.attachments.map((entry) => ({ id: entry.id, filename: entry.filename, mime: entry.mime, size: entry.size })))
    }).catch((reason) => {
      if (!cancelled) setError((reason as Error).message)
    })
    return () => { cancelled = true }
  }, [account.id, draftId])

  const toast = (title: string, tone: 'default' | 'danger' = 'default') => useUi.getState().toast({ title, tone })
  const bodyHtml = () => emailMarkdownToHtml(body)

  const saveDraft = async (): Promise<string | null> => {
    setSaving(true)
    setError(null)
    try {
      const saved = await api.email.saveDraft(account.id, {
        to,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject,
        body,
        bodyHtml: bodyHtml(),
        inReplyTo: threading.inReplyTo ?? undefined,
        threadId: threading.threadId ?? undefined,
        draftId: draft ?? undefined,
      })
      setDraft(saved.draftId)
      toast(t('email.compose.draft_saved'))
      return saved.draftId
    } catch (reason) {
      const message = (reason as Error).message
      setError(message)
      toast(message, 'danger')
      return null
    } finally {
      setSaving(false)
    }
  }

  const send = async () => {
    if (!to.trim()) {
      setError(t('email.compose.error_no_recipient'))
      return
    }
    if (!body.trim()) {
      setError(t('email.compose.error_empty'))
      return
    }
    setSending(true)
    setError(null)
    try {
      const id = draft ?? await saveDraft()
      if (!id) return
      await api.email.sendDraft(account.id, id, {
        to,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject,
        body,
        bodyHtml: bodyHtml(),
        attachmentIds: attachments.map((entry) => entry.id),
        operationId: crypto.randomUUID(),
      })
      toast(t('email.compose.sent'))
      onSent()
    } catch (reason) {
      const message = (reason as Error).message
      setError(message)
      toast(message, 'danger')
    } finally {
      setSending(false)
    }
  }

  const discard = async () => {
    if (draft) {
      try {
        await api.email.deleteEmail(account.id, draft, true)
      } catch (reason) {
        toast((reason as Error).message, 'danger')
        return
      }
    }
    onClose()
  }

  const close = async () => {
    if (sending) return
    if (dirty || draft) {
      const confirmed = await confirm({
        title: t('email.compose.unsaved_title'),
        description: t('email.compose.unsaved_hint'),
        confirmLabel: t('email.compose.unsaved_discard'),
        cancelLabel: t('common.cancel'),
        tone: 'danger',
      })
      if (!confirmed) return
    }
    await discard()
  }

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setError(null)
    let activeDraft = draft
    for (const file of Array.from(files)) {
      if (file.size > EMAIL_ATTACHMENT_MAX_BYTES) {
        toast(t('email.compose.attachment_too_large'), 'danger')
        continue
      }
      try {
        if (!activeDraft) {
          activeDraft = await saveDraft()
          if (!activeDraft) return
        }
        const uploaded = await attachmentHubApi.upload('email', file)
        await api.email.linkAttachment(account.id, activeDraft, uploaded.id)
        setAttachments((current) => [...current, { id: uploaded.id, filename: uploaded.filename, mime: uploaded.mime, size: uploaded.size }])
      } catch (reason) {
        toast((reason as Error).message, 'danger')
      }
    }
  }

  const removeAttachment = async (attachment: ComposeAttachment) => {
    if (!draft) return
    try {
      await api.email.unlinkAttachment(account.id, draft, attachment.id)
      setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))
    } catch (reason) {
      toast((reason as Error).message, 'danger')
    }
  }

  const run = (command: (target: EditorView) => boolean) => {
    const view = viewRef.current
    if (!view) return
    command(view)
    view.focus()
  }

  const insertEmailLink = () => {
    void prompt({
      title: t('email.compose.link_title'),
      description: t('email.compose.link_hint'),
      placeholder: 'https://',
    }).then((url) => {
      if (!url) return
      if (!/^(https?:|mailto:)/i.test(url.trim())) {
        toast(t('email.compose.link_invalid'), 'danger')
        return
      }
      run(insertLink(url.trim()))
    })
  }

  const align = (align: 'left' | 'center' | 'right' | 'justify') => {
    const view = viewRef.current
    if (!view) return
    const range = view.state.selection.main
    const start = view.state.doc.lineAt(range.from).from
    const end = view.state.doc.lineAt(range.to).to
    const text = view.state.doc.sliceString(start, end)
    view.dispatch({
      changes: { from: start, to: end, insert: `<div align="${align}">\n${text}\n</div>` },
      selection: { anchor: start + `<div align="${align}">\n`.length },
    })
    view.focus()
  }

  const titleKey = draft
    ? 'email.compose.title_edit_draft'
    : mode === 'reply'
      ? 'email.compose.title_reply'
      : mode === 'reply-all'
        ? 'email.compose.title_reply_all'
        : mode === 'forward'
          ? 'email.compose.title_forward'
          : 'email.compose.title_new'

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-base)]" aria-label={t(titleKey)}>
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t(titleKey)}</h2>
        <IconButton label={t('common.close')} size="sm" onClick={() => { void close() }} disabled={sending}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto p-3 md:p-4">
        <Field label={t('email.compose.to')} required>
          <Input value={to} onChange={(event) => setTo(event.target.value)} placeholder={t('email.compose.recipient_placeholder')} autoComplete="off" />
        </Field>
        {!showCc && (
          <Button size="sm" variant="ghost" onClick={() => setShowCc(true)}>{t('email.compose.show_cc')}</Button>
        )}
        {showCc && (
          <>
            <Field label={t('email.compose.cc')}>
              <Input value={cc} onChange={(event) => setCc(event.target.value)} placeholder={t('email.compose.recipient_placeholder')} autoComplete="off" />
            </Field>
            <Field label={t('email.compose.bcc')}>
              <Input value={bcc} onChange={(event) => setBcc(event.target.value)} placeholder={t('email.compose.recipient_placeholder')} autoComplete="off" />
            </Field>
          </>
        )}
        <Field label={t('email.compose.subject')} required>
          <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
        </Field>
        <div className="overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <div className="flex min-w-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1.5 py-1">
            <Segmented
              value={viewMode}
              onChange={setViewMode}
              size="sm"
              options={[
                { value: 'edit', label: t('email.compose.edit') },
                { value: 'preview', label: t('email.compose.preview') },
              ]}
            />
            {viewMode === 'edit' && (
              <div className="min-w-0 flex-1 overflow-x-auto no-scrollbar">
                <FormatToolbar
                  run={run}
                  variant="email"
                  onInsertLink={insertEmailLink}
                  onAlign={align}
                  showHistory
                />
              </div>
            )}
          </div>
          {viewMode === 'edit' ? (
            <EmailComposer
              value={body}
              onChange={setBody}
              onReady={(view) => { viewRef.current = view }}
              placeholder={t('email.compose.body_placeholder')}
              label={t('email.compose.body_label')}
            />
          ) : (
            <div
              className="ink-prose min-h-[180px] p-3 text-[length:var(--text-13)]"
              dangerouslySetInnerHTML={{ __html: emailMarkdownToHtml(body) }}
            />
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              aria-label={t('email.compose.add_attachment')}
              onChange={(event) => { void addFiles(event.target.files); event.target.value = '' }}
            />
            <Button size="sm" variant="secondary" icon={<Paperclip size={14} />} onClick={() => fileInput.current?.click()} disabled={sending}>
              {t('email.compose.add_attachment')}
            </Button>
            <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('email.compose.attachment_hint')}</span>
          </div>
          {attachments.length > 0 && (
            <ul className="mt-2 space-y-1">
              {attachments.map((attachment) => (
                <li key={attachment.id} className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1.5 text-[length:var(--text-12)]">
                  <FileText size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[var(--text-primary)] hover:underline"
                    onClick={() => setPreview(attachment)}
                  >
                    {attachment.filename}
                  </button>
                  <span className="shrink-0 text-[var(--text-quaternary)]">{formatBytes(attachment.size)}</span>
                  <IconButton label={t('email.compose.remove_attachment')} size="xs" onClick={() => { void removeAttachment(attachment) }}>
                    <X size={12} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error && (
          <div role="alert" className="rounded-[var(--r-sm)] border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">
            {error}
          </div>
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
        <Button size="sm" variant="ghost" onClick={() => { void discard() }} disabled={sending}>
          {t('email.compose.discard')}
        </Button>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => { void saveDraft() }} loading={saving} disabled={sending}>
            {t('email.compose.save_draft')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => { void send() }} loading={sending} disabled={saving}>
            {t('email.compose.send')}
          </Button>
        </div>
      </footer>
      {preview && (
        <FilePreviewModal
          open
          onClose={() => setPreview(null)}
          file={{ url: api.email.attachmentUrl(preview.id), filename: preview.filename, mime: preview.mime, size: preview.size }}
        />
      )}
    </section>
  )
}
