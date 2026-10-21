import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { Paperclip, Trash2 } from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { MemoAttachment } from '@shared/memos/types'
import { IconButton } from '../../../components/primitives'
import { t } from '../../../lib/i18n'
import { formatBytes, formatDate } from '../../../lib/time'
import { attachmentSource } from '../attachment-groups'
import { attachmentDimensions, isAudioAttachment, isImageAttachment, motionVideoUrl } from '../media'
import {
  AttachmentAudio,
  AttachmentDocument,
  AttachmentMotionBadge,
  AttachmentUnavailable,
  AttachmentVideo,
  useAttachmentImageSource,
} from './AttachmentMedia'

function isoTime(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function SourceMemoLink({ attachment, onOpen }: {
  attachment: MemoAttachment
  onOpen: (id: string) => void
}): ReactElement | null {
  const memo = attachmentSource(attachment)
  if (!memo) return null
  const title = memo.title.trim() || memo.snippet.trim() || t('memos.attachments.library.source_memo_untitled')
  const label = t('memos.attachments.library.source_memo', { title })
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onOpen(memo.id)
  }
  return (
    <a
      href={`${MEMOS_APP_PATH}/m/${encodeURIComponent(memo.id)}`}
      onClick={onClick}
      title={label}
      className="inline-flex min-w-0 items-center gap-1 rounded-[var(--r-xs)] text-[length:var(--text-10-5)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
    >
      <Paperclip size={10} aria-hidden="true" className="shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  )
}

export function LibraryMediaTile({ attachment, busy, onOpenImage, onDelete, onOpenMemo }: {
  attachment: MemoAttachment
  busy: boolean
  onOpenImage: (attachment: MemoAttachment) => void
  onDelete: (attachment: MemoAttachment) => void
  onOpenMemo: (id: string) => void
}): ReactElement {
  const source = useAttachmentImageSource(attachment)
  const image = isImageAttachment(attachment)
  const dimensions = attachmentDimensions(attachment)
  const motion = motionVideoUrl(attachment)
  const deleteLabel = t('memos.attachments.library.delete', { name: attachment.filename })
  const openLabel = t(motion ? 'memos.media.open_live_photo' : 'memos.media.open_image', {
    name: attachment.filename,
  })
  return (
    <figure
      data-attachment-id={attachment.id}
      className="flex min-w-0 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
    >
      <div className="relative aspect-[4/3] bg-[var(--bg-inset)]">
        {image ? (
          source.failed ? (
            <div className="absolute inset-0 p-2">
              <AttachmentUnavailable
                attachment={attachment}
                message={t('memos.media.image_failed')}
                className="h-full items-start"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={(event) => {
                event.currentTarget.focus()
                onOpenImage(attachment)
              }}
              aria-label={openLabel}
              className="absolute inset-0 block focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:-outline-offset-2"
            >
              <img
                src={source.src}
                alt={attachment.filename}
                width={dimensions.width}
                height={dimensions.height}
                loading="lazy"
                decoding="async"
                onError={source.onError}
                className="size-full object-cover"
              />
            </button>
          )
        ) : (
          <AttachmentVideo attachment={attachment} className="size-full rounded-none border-0 object-contain" />
        )}
        {image && !source.failed && motion ? <AttachmentMotionBadge /> : null}
      </div>
      <figcaption className="flex min-w-0 flex-1 flex-col gap-0.5 p-2">
        <div className="flex min-w-0 items-start gap-1">
          <p className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]" title={attachment.filename}>
            {attachment.filename}
          </p>
          <IconButton
            label={deleteLabel}
            size="sm"
            disabled={busy}
            onClick={() => onDelete(attachment)}
            className="-mr-1 -mt-0.5 hover:text-[var(--danger)]"
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
        <p className="text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
          {formatBytes(attachment.size)}
          <span aria-hidden="true"> · </span>
          <time dateTime={isoTime(attachment.createdAt)}>{formatDate(attachment.createdAt * 1000)}</time>
        </p>
        <SourceMemoLink attachment={attachment} onOpen={onOpenMemo} />
      </figcaption>
    </figure>
  )
}

export function LibraryRow({ attachment, busy, onDelete, onOpenMemo }: {
  attachment: MemoAttachment
  busy: boolean
  onDelete: (attachment: MemoAttachment) => void
  onOpenMemo: (id: string) => void
}): ReactElement {
  const deleteLabel = t('memos.attachments.library.delete', { name: attachment.filename })
  const action = (
    <IconButton
      label={deleteLabel}
      size="sm"
      disabled={busy}
      onClick={() => onDelete(attachment)}
      className="hover:text-[var(--danger)]"
    >
      <Trash2 size={13} />
    </IconButton>
  )
  const caption: ReactNode = (
    <>
      <time dateTime={isoTime(attachment.createdAt)}>{formatDate(attachment.createdAt * 1000)}</time>
      <SourceMemoLink attachment={attachment} onOpen={onOpenMemo} />
    </>
  )
  return (
    <li className="min-w-0" data-attachment-id={attachment.id}>
      {isAudioAttachment(attachment) ? (
        <AttachmentAudio attachment={attachment} action={action} caption={caption} />
      ) : (
        <AttachmentDocument attachment={attachment} action={action} caption={caption} />
      )}
    </li>
  )
}
