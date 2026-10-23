import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { ChevronDown, FileText, Paperclip, X } from 'lucide-react'
import type { EmailAccount, EmailMessage, EmailSendInput } from '@shared/email/model'
import { EMAIL_ATTACHMENT_MAX_BYTES } from '@shared/email/model'
import { buildEmailQuoteMarkdown, formatEmailQuotedDate, splitEmailList, stripEmailHtmlToText } from '@shared/email/format'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Segmented } from '../../components/form'
import { confirm, Menu } from '../../components/overlay'
import { toastWithUndo, useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { formatBytes, fullTime } from '../../lib/time'
import { api } from '../../lib/api'
import { attachmentHubApi } from '../attachment-hub/api'
import { FilePreviewModal } from '../file-preview'
import { FormatToolbar } from '../../editor/FormatToolbar'
import { insertLink } from '../../editor/commands'
import { prompt } from '../../components/overlay'
import { emailMarkdownToHtml } from './email-markdown'
import { EmailComposer } from './EmailComposer'
import { RecipientField } from './RecipientField'
import type { EmailComposeMode } from './email-address'

interface ComposeAttachment {
  id: string
  filename: string
  mime: string
  size: number
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type SchedulePreset = 'hour' | 'tomorrow' | 'week'

const AUTO_SAVE_DELAY_MS = 1600
const UNDO_WINDOW_MS = 9000
const UNDO_TICK_MS = 1000
const HOUR_MS = 60 * 60 * 1000
const SCHEDULE_HOUR = 8

function scheduledTime(preset: SchedulePreset, now = new Date()): Date {
  if (preset === 'hour') return new Date(now.getTime() + HOUR_MS)
  const next = new Date(now)
  next.setDate(next.getDate() + (preset === 'tomorrow' ? 1 : 7))
  next.setHours(SCHEDULE_HOUR, 0, 0, 0)
  return next
}

function signatureBlock(account: EmailAccount): string {
  const signature = account.settings.signature
  if (!signature?.enabled || !signature.text.trim()) return ''
  return `\n\n--\n${signature.text.trim()}`
}

function recipientAddresses(value: string): string {
  return splitEmailList(value)
    .map((entry) => {
      const match = /^(.*?)<([^<>]+)>$/.exec(entry)
      return (match?.[2] ?? entry).trim()
    })
    .filter(Boolean)
    .join(', ')
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
  const [baseline, setBaseline] = useState(() => ({
    to: initial.to,
    cc: initial.cc,
    bcc: '',
    subject: initial.subject,
    body: initial.body,
  }))
  const [showCc, setShowCc] = useState(initial.showCc)
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit')
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [undoSeconds, setUndoSeconds] = useState<number | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
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
  const scheduleAnchor = useRef<HTMLButtonElement>(null)
  const saveInFlight = useRef(false)
  const autoSaveTimer = useRef<number | null>(null)
  const undoTimer = useRef<number | null>(null)
  const undoInterval = useRef<number | null>(null)
  const pendingSend = useRef<{ id: string; input: EmailSendInput } | null>(null)
  const autoSave = useRef<(silent: boolean) => Promise<string | null>>(async () => null)
  const sent = useRef(false)
  const dirty = to !== baseline.to || cc !== baseline.cc || bcc !== baseline.bcc || subject !== baseline.subject || body !== baseline.body
  const hasComposeContent = to.trim() !== '' || cc.trim() !== '' || bcc.trim() !== '' || subject.trim() !== '' || body.trim() !== ''
  const canAutoSave = dirty && hasComposeContent
  const attachmentKey = attachments.map((entry) => entry.id).join(',')

  useEffect(() => {
    if (!draftId) return
    let cancelled = false
    void api.email.getEmail(account.id, draftId).then((message) => {
      if (cancelled) return
      const loaded = {
        to: message.recipient ?? '',
        cc: message.cc ?? '',
        bcc: message.bcc ?? '',
        subject: message.subject,
        body: message.bodySource ?? message.body,
      }
      setTo(loaded.to)
      setCc(loaded.cc)
      setBcc(loaded.bcc)
      setSubject(loaded.subject)
      setBody(loaded.body)
      setBaseline(loaded)
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

  const clearAutoSaveTimer = () => {
    if (autoSaveTimer.current === null) return
    window.clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = null
  }

  const clearUndoTimers = () => {
    if (undoTimer.current !== null) {
      window.clearTimeout(undoTimer.current)
      undoTimer.current = null
    }
    if (undoInterval.current !== null) {
      window.clearInterval(undoInterval.current)
      undoInterval.current = null
    }
  }

  useEffect(() => () => {
    clearAutoSaveTimer()
    clearUndoTimers()
    pendingSend.current = null
  }, [])

  const saveDraft = async (silent = false): Promise<string | null> => {
    if (saveInFlight.current) return null
    saveInFlight.current = true
    const snapshot = { to, cc, bcc, subject, body }
    setSaving(true)
    setSaveState('saving')
    setSaveError(null)
    if (!silent) setError(null)
    try {
      const saved = await api.email.saveDraft(account.id, {
        to: recipientAddresses(snapshot.to),
        cc: recipientAddresses(snapshot.cc) || undefined,
        bcc: recipientAddresses(snapshot.bcc) || undefined,
        subject: snapshot.subject,
        body: snapshot.body,
        bodyHtml: emailMarkdownToHtml(snapshot.body),
        inReplyTo: threading.inReplyTo ?? undefined,
        threadId: threading.threadId ?? undefined,
        draftId: draft ?? undefined,
      })
      setDraft(saved.draftId)
      setBaseline(snapshot)
      setSaveState('saved')
      if (!silent) toast(t('email.compose.draft_saved'))
      return saved.draftId
    } catch (reason) {
      const message = (reason as Error).message
      setSaveState('error')
      setSaveError(message)
      if (!silent) {
        setError(message)
        toast(message, 'danger')
      }
      return null
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  useEffect(() => {
    autoSave.current = saveDraft
  })

  useEffect(() => {
    clearAutoSaveTimer()
    if (sending || scheduling || sent.current || !canAutoSave) return
    const schedule = () => {
      autoSaveTimer.current = window.setTimeout(() => {
        autoSaveTimer.current = null
        if (saveInFlight.current) {
          schedule()
          return
        }
        void autoSave.current(true)
      }, AUTO_SAVE_DELAY_MS)
    }
    schedule()
    return clearAutoSaveTimer
  }, [to, cc, bcc, subject, body, attachmentKey, canAutoSave, sending, scheduling])

  const cancelPendingSend = () => {
    if (!pendingSend.current) return
    pendingSend.current = null
    clearUndoTimers()
    setUndoSeconds(null)
    setSending(false)
    toast(t('email.compose.send_cancelled'))
  }

  const deliverPendingSend = async () => {
    const pending = pendingSend.current
    pendingSend.current = null
    clearUndoTimers()
    setUndoSeconds(null)
    if (!pending) {
      setSending(false)
      return
    }
    try {
      await api.email.sendDraft(account.id, pending.id, pending.input)
      sent.current = true
      clearAutoSaveTimer()
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

  const send = async () => {
    if (sending || scheduling) return
    if (!to.trim()) {
      setError(t('email.compose.error_no_recipient'))
      return
    }
    if (!body.trim()) {
      setError(t('email.compose.error_empty'))
      return
    }
    clearAutoSaveTimer()
    setSending(true)
    setError(null)
    const id = draft ?? await saveDraft()
    if (!id) {
      setSending(false)
      return
    }
    const input: EmailSendInput = {
      to: recipientAddresses(to),
      cc: recipientAddresses(cc) || undefined,
      bcc: recipientAddresses(bcc) || undefined,
      subject,
      body,
      bodyHtml: bodyHtml(),
      attachmentIds: attachments.map((entry) => entry.id),
      operationId: crypto.randomUUID(),
    }
    pendingSend.current = { id, input }
    setUndoSeconds(Math.ceil(UNDO_WINDOW_MS / UNDO_TICK_MS))
    toastWithUndo(t('email.compose.sending_toast'), cancelPendingSend, { duration: UNDO_WINDOW_MS })
    undoInterval.current = window.setInterval(() => {
      setUndoSeconds((current) => (current === null ? null : Math.max(0, current - 1)))
    }, UNDO_TICK_MS)
    undoTimer.current = window.setTimeout(() => { void deliverPendingSend() }, UNDO_WINDOW_MS)
  }

  const schedule = async (preset: SchedulePreset) => {
    setScheduleOpen(false)
    if (sending || scheduling) return
    if (!to.trim()) {
      setError(t('email.compose.error_no_recipient'))
      return
    }
    if (!body.trim()) {
      setError(t('email.compose.error_empty'))
      return
    }
    clearAutoSaveTimer()
    setScheduling(true)
    setError(null)
    try {
      const id = await saveDraft(true)
      if (!id) {
        setError(t('email.compose.schedule_save_failed'))
        return
      }
      const job = await api.email.scheduleDraftSend(account.id, id, {
        sendAt: scheduledTime(preset).toISOString(),
        operationId: crypto.randomUUID(),
      })
      sent.current = true
      toast(t('email.compose.schedule_sent', { time: fullTime(Date.parse(job.sendAt)) }))
      onSent()
    } catch (reason) {
      const message = (reason as Error).message || t('email.compose.schedule_failed')
      setError(message)
      toast(message, 'danger')
    } finally {
      setScheduling(false)
    }
  }

  const scheduleItems = [
    { id: 'hour', label: t('email.compose.schedule_in_hour'), onSelect: () => { void schedule('hour') } },
    { id: 'tomorrow', label: t('email.compose.schedule_tomorrow'), onSelect: () => { void schedule('tomorrow') } },
    { id: 'week', label: t('email.compose.schedule_next_week'), onSelect: () => { void schedule('week') } },
  ]

  const discard = async () => {
    clearUndoTimers()
    pendingSend.current = null
    setUndoSeconds(null)
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
    if (sending || scheduling) return
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

  const saveStatus = saveState === 'saved' && !dirty
    ? t('email.compose.saved')
    : saveState === 'saving'
      ? t('email.compose.saving')
      : saveState === 'error'
        ? t('email.compose.save_failed')
        : ''

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-base)]" aria-label={t(titleKey)}>
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t(titleKey)}</h2>
        <IconButton label={t('common.close')} size="sm" onClick={() => { void close() }} disabled={sending || scheduling}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto p-3 md:p-4">
        <Field label={t('email.compose.to')} required>
          <RecipientField value={to} onChange={setTo} placeholder={t('email.compose.recipient_placeholder')} />
        </Field>
        {!showCc && (
          <Button size="sm" variant="ghost" onClick={() => setShowCc(true)}>{t('email.compose.show_cc')}</Button>
        )}
        {showCc && (
          <>
            <Field label={t('email.compose.cc')}>
              <RecipientField value={cc} onChange={setCc} placeholder={t('email.compose.recipient_placeholder')} />
            </Field>
            <Field label={t('email.compose.bcc')}>
              <RecipientField value={bcc} onChange={setBcc} placeholder={t('email.compose.recipient_placeholder')} />
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
            <Button size="sm" variant="secondary" icon={<Paperclip size={14} />} onClick={() => fileInput.current?.click()} disabled={sending || saving || scheduling}>
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
        <Button size="sm" variant="ghost" onClick={() => { void discard() }} disabled={sending || scheduling}>
          {t('email.compose.discard')}
        </Button>
        <div className="flex items-center gap-2">
          {undoSeconds !== null && (
            <span className="text-[length:var(--text-11-5)] text-[var(--accent)]">
              {t('email.compose.sending_in', { seconds: undoSeconds })}
            </span>
          )}
          <span
            role="status"
            aria-live="polite"
            title={saveState === 'error' ? saveError ?? undefined : undefined}
            className={cn(
              'min-w-16 text-right text-[length:var(--text-11-5)]',
              saveState === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]',
            )}
          >
            {saveStatus}
            {saveState === 'error' && saveError && <span className="sr-only">: {saveError}</span>}
          </span>
          <Button size="sm" variant="secondary" onClick={() => { void saveDraft() }} loading={saving} disabled={sending || scheduling}>
            {t('email.compose.save_draft')}
          </Button>
          <div className="flex items-center">
            <Button
              size="sm"
              variant="primary"
              className="rounded-r-none"
              onClick={() => { void send() }}
              loading={sending}
              disabled={saving || scheduling}
            >
              {t('email.compose.send')}
            </Button>
            <Button
              ref={scheduleAnchor}
              size="sm"
              variant="primary"
              className="rounded-l-none border-l border-[var(--border-default)] px-1.5"
              icon={<ChevronDown size={14} />}
              aria-label={t('email.compose.schedule_send')}
              aria-haspopup="menu"
              aria-expanded={scheduleOpen}
              onClick={() => setScheduleOpen((open) => !open)}
              disabled={saving || sending || scheduling}
            />
          </div>
        </div>
      </footer>
      <Menu
        anchor={scheduleAnchor}
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        items={scheduleItems}
        align="end"
        width={220}
        label={t('email.compose.schedule_send')}
      />
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
