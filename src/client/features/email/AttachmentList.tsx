import { useState } from 'react'
import { Download, File, FileArchive, FileText, Film, Image as ImageIcon, Music, Paperclip } from 'lucide-react'
import { emailAttachmentCategory, type EmailAttachment } from '@shared/email/model'
import { t } from '../../lib/i18n'
import { formatBytes } from '../../lib/time'
import { FilePreviewModal, type FilePreviewTarget } from '../file-preview'

function attachmentIcon(attachment: EmailAttachment) {
  const category = emailAttachmentCategory(attachment.mime, attachment.filename)
  if (category === 'images') return ImageIcon
  if (category === 'audio') return Music
  if (category === 'video') return Film
  if (category === 'archives') return FileArchive
  if (category === 'docs' || category === 'code') return FileText
  return File
}

function visibleAttachments(attachments: readonly EmailAttachment[]): EmailAttachment[] {
  return attachments.filter((attachment) => {
    if (attachment.disposition?.toLowerCase() === 'inline') return false
    return !attachment.contentId
  })
}

export function AttachmentList({ attachments, label }: { attachments: readonly EmailAttachment[]; label: string }) {
  const [preview, setPreview] = useState<FilePreviewTarget | null>(null)
  const visible = visibleAttachments(attachments)
  if (visible.length === 0) return null
  return (
    <section aria-label={label} className="mt-3">
      <div className="mb-1 flex items-center gap-1.5 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
        <Paperclip size={12} aria-hidden="true" />
        {t(visible.length === 1 ? 'email.attachments.title_one' : 'email.attachments.title_other', { count: visible.length })}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {visible.map((attachment) => {
          const Icon = attachmentIcon(attachment)
          const target = { url: attachment.url, filename: attachment.filename, mime: attachment.mime, size: attachment.size }
          return (
            <li key={attachment.id} className="flex min-w-0 items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] pl-2 pr-0.5">
              <button
                type="button"
                onClick={() => setPreview(target)}
                aria-label={t('email.attachments.preview', { name: attachment.filename })}
                className="flex min-h-8 min-w-0 items-center gap-1.5 py-1 text-left"
              >
                <Icon size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="min-w-0 max-w-40 truncate text-[length:var(--text-11-5)] text-[var(--text-primary)]">{attachment.filename}</span>
                <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">{formatBytes(attachment.size)}</span>
              </button>
              <a
                href={attachment.url}
                download={attachment.filename}
                aria-label={t('email.attachments.download', { name: attachment.filename })}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <Download size={13} aria-hidden="true" />
              </a>
            </li>
          )
        })}
      </ul>
      <FilePreviewModal
        open={preview !== null}
        onClose={() => setPreview(null)}
        file={preview ?? { url: '', filename: '', mime: '' }}
      />
    </section>
  )
}
