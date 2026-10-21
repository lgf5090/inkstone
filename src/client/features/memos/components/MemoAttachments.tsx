import { useState, type ReactElement } from 'react'
import { Download, FileText, Music } from 'lucide-react'
import type { MemoAttachment } from '@shared/memos/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { formatBytes } from '../../../lib/time'

export interface MemoAttachmentsProps {
  attachments: MemoAttachment[]
  compact?: boolean
  className?: string
}

function isImage(attachment: MemoAttachment): boolean {
  return attachment.mime.startsWith('image/') && !attachment.mime.startsWith('image/svg')
}

function isVideo(attachment: MemoAttachment): boolean {
  return attachment.mime.startsWith('video/')
}

function isAudio(attachment: MemoAttachment): boolean {
  return attachment.mime.startsWith('audio/')
}

function AttachmentImage({ attachment, className }: { attachment: MemoAttachment; className?: string }): ReactElement {
  const [src, setSrc] = useState(attachment.thumbnailUrl ?? attachment.url)
  return (
    <img
      src={src}
      alt={attachment.filename}
      loading="lazy"
      decoding="async"
      className={className}
      onError={() => {
        if (src !== attachment.url) setSrc(attachment.url)
      }}
    />
  )
}

function FileRow({ attachment }: { attachment: MemoAttachment }): ReactElement {
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('memos.attachments.download', { name: attachment.filename })}
      className={cn(
        'flex min-h-10 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1.5',
        'text-[length:var(--text-11-5)] text-[var(--text-secondary)] transition-colors',
        'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:min-h-0',
      )}
    >
      <FileText size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
      <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
      <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
        {formatBytes(attachment.size)}
      </span>
      <Download size={12} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
    </a>
  )
}

function AudioRow({ attachment }: { attachment: MemoAttachment }): ReactElement {
  return (
    <div className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2">
      <div className="flex items-center gap-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
        <Music size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
        <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
        <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
          {formatBytes(attachment.size)}
        </span>
      </div>
      <audio controls preload="none" src={attachment.url} aria-label={attachment.filename} className="mt-1 w-full" />
    </div>
  )
}

export function MemoAttachments({ attachments, compact = false, className }: MemoAttachmentsProps): ReactElement | null {
  if (attachments.length === 0) return null
  const shown = compact ? attachments.slice(0, 4) : attachments
  const remaining = attachments.length - shown.length
  const images = shown.filter(isImage)
  const videos = shown.filter(isVideo)
  const audios = shown.filter(isAudio)
  const files = shown.filter((attachment) => !isImage(attachment) && !isVideo(attachment) && !isAudio(attachment))
  const media = [...images, ...videos]
  return (
    <div className={cn('space-y-1.5', className)}>
      {media.length > 0 ? (
        <div className={cn('grid gap-1.5', media.length > 1 ? 'grid-cols-2' : 'grid-cols-1', !compact && 'sm:grid-cols-2')}>
          {media.map((attachment) => (
            isVideo(attachment) ? (
              <video
                key={attachment.id}
                src={attachment.url}
                controls
                preload="metadata"
                aria-label={attachment.filename}
                className={cn('w-full rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]', compact ? 'aspect-square object-cover' : 'max-h-[420px] object-contain')}
              />
            ) : (
              <a
                key={attachment.id}
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('memos.attachments.open', { name: attachment.filename })}
                className="block min-w-0 overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]"
              >
                <AttachmentImage
                  attachment={attachment}
                  className={cn('w-full', compact ? 'aspect-square object-cover' : 'max-h-[420px] object-contain')}
                />
              </a>
            )
          ))}
        </div>
      ) : null}
      {audios.map((attachment) => <AudioRow key={attachment.id} attachment={attachment} />)}
      {files.map((attachment) => <FileRow key={attachment.id} attachment={attachment} />)}
      {remaining > 0 ? (
        <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {t('memos.attachments.more', { count: remaining })}
        </p>
      ) : null}
    </div>
  )
}
