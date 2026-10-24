import { useId } from 'react'
import { ChevronDown, ChevronUp, Send } from 'lucide-react'
import type { EmailMessage } from '@shared/email/model'
import { Badge, Button } from '../../components/primitives'
import { t } from '../../lib/i18n'
import { AttachmentList } from './AttachmentList'
import { EmailFrame } from './EmailFrame'
import { senderLabel, messageFullDate, messageSnippet } from './format'

export function ThreadMessage({ message, expanded, onToggle, busy = false, onSendDraft, onEditDraft, onDiscardDraft }: {
  message: EmailMessage
  expanded: boolean
  onToggle: () => void
  busy?: boolean
  onSendDraft?: (message: EmailMessage) => void
  onEditDraft?: (message: EmailMessage) => void
  onDiscardDraft?: (message: EmailMessage) => void
}) {
  const bodyId = useId()
  return (
    <article className="border-b border-[var(--border-subtle)] last:border-b-0">
      <h3 className="m-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-inset"
        >
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="min-w-0 truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">
                {senderLabel(message.sender)}
              </span>
              {message.folderId === 'draft' && <Badge tone="accent">{t('email.list.draft')}</Badge>}
              {message.deliveryStatus === 'failed' && <Badge tone="danger">{t('email.list.send_failed')}</Badge>}
              <span className="ml-auto shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
                {messageFullDate(message.date)}
              </span>
            </span>
            {!expanded && (
              <span className="mt-0.5 block truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {messageSnippet(message)}
              </span>
            )}
          </span>
          <span className="flex size-6 shrink-0 items-center justify-center text-[var(--text-tertiary)]">
            {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </span>
        </button>
      </h3>
      <div id={bodyId} hidden={!expanded} className="px-4 pb-4">
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <dt className="font-medium text-[var(--text-quaternary)]">{t('email.detail.to')}</dt>
          <dd className="m-0 break-words">{message.recipient || '—'}</dd>
          {message.cc && (
            <>
              <dt className="font-medium text-[var(--text-quaternary)]">{t('email.detail.cc')}</dt>
              <dd className="m-0 break-words">{message.cc}</dd>
            </>
          )}
          {message.bcc && (
            <>
              <dt className="font-medium text-[var(--text-quaternary)]">{t('email.detail.bcc')}</dt>
              <dd className="m-0 break-words">{message.bcc}</dd>
            </>
          )}
        </dl>
        {message.deliveryError && (
          <div role="alert" className="mt-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
            {message.deliveryError}
          </div>
        )}
        {message.attachmentsSkipped && (
          <p role="status" className="mt-2 text-[length:var(--text-11)] text-[var(--warning)]">{t('email.detail.attachments_skipped')}</p>
        )}
        <div className="mt-2 overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <EmailFrame body={message.body} attachments={message.attachments} subject={message.subject} />
        </div>
        <AttachmentList attachments={message.attachments} label={t('email.detail.attachments', { subject: message.subject })} />
        {message.folderId === 'draft' && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              icon={<Send size={13} />}
              disabled={busy}
              onClick={() => onSendDraft?.(message)}
            >
              {t('email.compose.send')}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onEditDraft?.(message)}>
              {t('email.detail.edit_draft')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDiscardDraft?.(message)}>
              {t('email.detail.discard_draft')}
            </Button>
          </div>
        )}
      </div>
    </article>
  )
}
