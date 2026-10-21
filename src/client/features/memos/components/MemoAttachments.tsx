import { useState, type ReactElement } from 'react'
import type { MemoAttachment } from '@shared/memos/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { attachmentDimensions, isAudioAttachment, isImageAttachment, isVideoAttachment, mediaMetadataLines, motionVideoUrl } from '../media'
import { AttachmentAudio, AttachmentDocument, AttachmentMotionBadge, AttachmentUnavailable, AttachmentVideo, useAttachmentImageSource } from './AttachmentMedia'
import { MemoLightbox } from './MemoLightbox'

export interface MemoAttachmentsProps {
  attachments: MemoAttachment[]
  compact?: boolean
  className?: string
}

function GalleryImage({ attachment, index, compact, multiple, onOpen }: {
  attachment: MemoAttachment
  index: number
  compact: boolean
  multiple: boolean
  onOpen: (index: number) => void
}): ReactElement {
  const source = useAttachmentImageSource(attachment)
  const caption = compact ? [] : mediaMetadataLines(attachment)
  if (source.failed) {
    return (
      <AttachmentUnavailable
        attachment={attachment}
        message={t('memos.media.image_failed')}
        className="min-w-0"
      />
    )
  }
  const motion = motionVideoUrl(attachment)
  const dimensions = attachmentDimensions(attachment)
  return (
    <figure className="min-w-0">
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.focus()
          onOpen(index)
        }}
        aria-label={t(motion ? 'memos.media.open_live_photo' : 'memos.media.open_image', { name: attachment.filename })}
        className="group relative block w-full overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <img
          src={source.src}
          alt={attachment.filename}
          width={dimensions.width}
          height={dimensions.height}
          loading="lazy"
          decoding="async"
          onError={source.onError}
          className={cn(
            'w-full',
            multiple ? 'aspect-square object-cover' : compact ? 'max-h-56 object-contain' : 'max-h-[420px] object-contain',
          )}
        />
        {motion ? (
          <AttachmentMotionBadge />
        ) : null}
      </button>
      {caption.length > 0 ? (
        <figcaption
          title={caption.join(' · ')}
          className="mt-1 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"
        >
          {caption.join(' · ')}
        </figcaption>
      ) : null}
    </figure>
  )
}

function GalleryVideo({ attachment, compact, multiple }: {
  attachment: MemoAttachment
  compact: boolean
  multiple: boolean
}): ReactElement {
  const caption = compact ? [] : mediaMetadataLines(attachment)
  return (
    <div className="min-w-0">
      <AttachmentVideo
        attachment={attachment}
        className={cn(multiple ? 'aspect-square object-contain' : compact ? 'max-h-56 object-contain' : 'max-h-[420px] object-contain')}
      />
      {caption.length > 0 ? (
        <p title={caption.join(' · ')} className="mt-1 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {caption.join(' · ')}
        </p>
      ) : null}
    </div>
  )
}

export function MemoAttachments({ attachments, compact = false, className }: MemoAttachmentsProps): ReactElement | null {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  if (attachments.length === 0) return null
  const shown = compact ? attachments.slice(0, 4) : attachments
  const remaining = attachments.length - shown.length
  const images = shown.filter(isImageAttachment)
  const media = shown.filter((attachment) => isImageAttachment(attachment) || isVideoAttachment(attachment))
  const audios = shown.filter(isAudioAttachment)
  const files = shown.filter((attachment) => !isImageAttachment(attachment) && !isVideoAttachment(attachment) && !isAudioAttachment(attachment))
  const multiple = media.length > 1
  return (
    <div className={cn('space-y-1.5', className)} data-memo-attachments="">
      {media.length > 0 ? (
        <div className={cn(multiple ? 'grid grid-cols-2 gap-1.5' : 'space-y-1.5', multiple && !compact && 'sm:grid-cols-3')}>
          {media.map((attachment) => (
            isVideoAttachment(attachment) ? (
              <GalleryVideo
                key={attachment.id}
                attachment={attachment}
                compact={compact}
                multiple={multiple}
              />
            ) : (
              <GalleryImage
                key={attachment.id}
                attachment={attachment}
                index={images.indexOf(attachment)}
                compact={compact}
                multiple={multiple}
                onOpen={setLightboxIndex}
              />
            )
          ))}
        </div>
      ) : null}
      {audios.map((attachment) => <AttachmentAudio key={attachment.id} attachment={attachment} />)}
      {files.map((attachment) => <AttachmentDocument key={attachment.id} attachment={attachment} />)}
      {remaining > 0 ? (
        <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {t('memos.attachments.more', { count: remaining })}
        </p>
      ) : null}
      <MemoLightbox
        images={images}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    </div>
  )
}
