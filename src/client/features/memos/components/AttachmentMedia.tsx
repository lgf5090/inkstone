import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { AlertTriangle, Download, FileText, ImageOff, Music, Play } from 'lucide-react'
import type { MemoAttachment } from '@shared/memos/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { formatBytes } from '../../../lib/time'
import { attachmentDimensions } from '../media'

export interface AttachmentImageSource {
  src: string
  failed: boolean
  onError: () => void
}

export function useAttachmentImageSource(attachment: MemoAttachment): AttachmentImageSource {
  const initial = attachment.thumbnailUrl ?? attachment.url
  const [src, setSrc] = useState(initial)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setSrc(attachment.thumbnailUrl ?? attachment.url)
    setFailed(false)
  }, [attachment.id, attachment.thumbnailUrl, attachment.url])
  return {
    src,
    failed,
    onError: () => {
      if (src !== attachment.url) setSrc(attachment.url)
      else setFailed(true)
    },
  }
}

export function AttachmentUnavailable({ attachment, message, className }: {
  attachment: MemoAttachment
  message: ReactNode
  className?: string
}): ReactElement {
  const label = t('memos.attachments.download', { name: attachment.filename })
  return (
    <div
      role="status"
      className={cn(
        'flex min-h-10 min-w-0 flex-wrap items-center gap-2 rounded-[var(--r-sm)] border border-dashed border-[var(--border-subtle)]',
        'bg-[var(--bg-inset)] px-2 py-1.5 text-[length:var(--text-11-5)]',
        className,
      )}
    >
      <ImageOff size={14} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[var(--text-secondary)]" title={attachment.filename}>{attachment.filename}</p>
        <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{message}</p>
      </div>
      <a
        href={attachment.url}
        download={attachment.filename}
        aria-label={label}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
      >
        <Download size={13} aria-hidden="true" />
      </a>
    </div>
  )
}

export function AttachmentMotionBadge(): ReactElement {
  return (
    <span className="pointer-events-none absolute bottom-1 left-1 inline-flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[length:var(--text-10)] text-white">
      <Play size={9} aria-hidden="true" />
      {t('memos.media.live_photo')}
    </span>
  )
}

export function AttachmentVideo({ attachment, className }: {
  attachment: MemoAttachment
  className?: string
}): ReactElement {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (failedSrc === attachment.url) {
    return (
      <AttachmentUnavailable
        attachment={attachment}
        message={t('memos.media.video_failed')}
        className={className}
      />
    )
  }
  const dimensions = attachmentDimensions(attachment)
  return (
    <video
      src={attachment.url}
      poster={attachment.thumbnailUrl ?? undefined}
      controls
      preload="metadata"
      playsInline
      aria-label={attachment.filename}
      width={dimensions.width}
      height={dimensions.height}
      onError={() => setFailedSrc(attachment.url)}
      className={cn(
        'w-full rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]',
        className,
      )}
    />
  )
}

export function AttachmentAudio({ attachment, action, caption, className }: {
  attachment: MemoAttachment
  action?: ReactNode
  caption?: ReactNode
  className?: string
}): ReactElement {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const failed = failedSrc === attachment.url
  return (
    <div className={cn('min-w-0 rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2', className)}>
      <div className="flex min-h-10 items-center gap-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)] md:min-h-0">
        <Music size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
        <span className="min-w-0 flex-1 truncate" title={attachment.filename}>{attachment.filename}</span>
        <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
          {formatBytes(attachment.size)}
        </span>
        {action}
      </div>
      {caption ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {caption}
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="mt-1 flex flex-wrap items-center gap-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
          <AlertTriangle size={12} aria-hidden="true" />
          <span className="min-w-0 flex-1">{t('memos.media.audio_failed')}</span>
          <a
            href={attachment.url}
            download={attachment.filename}
            aria-label={t('memos.attachments.download', { name: attachment.filename })}
            className="inline-flex size-8 items-center justify-center rounded-[var(--r-md)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <Download size={12} aria-hidden="true" />
          </a>
        </p>
      ) : (
        <audio
          controls
          preload="none"
          src={attachment.url}
          aria-label={attachment.filename}
          onError={() => setFailedSrc(attachment.url)}
          className="mt-1 w-full"
        />
      )}
    </div>
  )
}

export function AttachmentDocument({ attachment, action, caption, className }: {
  attachment: MemoAttachment
  action?: ReactNode
  caption?: ReactNode
  className?: string
}): ReactElement {
  const openLabel = t('memos.attachments.open', { name: attachment.filename })
  const downloadLabel = t('memos.attachments.download', { name: attachment.filename })
  return (
    <div
      className={cn(
        'flex min-h-10 min-w-0 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)]',
        'px-2 py-1.5 text-[length:var(--text-11-5)] md:min-h-0',
        className,
      )}
    >
      <FileText size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
      <div className="min-w-0 flex-1">
        <a
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={openLabel}
          title={attachment.filename}
          className="block truncate text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          {attachment.filename}
        </a>
        {caption ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            {caption}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
        {formatBytes(attachment.size)}
      </span>
      <a
        href={attachment.url}
        download={attachment.filename}
        aria-label={downloadLabel}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
      >
        <Download size={12} aria-hidden="true" />
      </a>
      {action}
    </div>
  )
}
