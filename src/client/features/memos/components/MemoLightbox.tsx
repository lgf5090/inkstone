import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Download, Play, X } from 'lucide-react'
import type { MemoAttachment } from '@shared/memos/types'
import { Modal } from '../../../components/overlay'
import { Button, IconButton } from '../../../components/primitives'
import { t } from '../../../lib/i18n'
import { attachmentDimensions, mediaMetadataLines, motionVideoUrl } from '../media'

export interface MemoLightboxProps {
  images: MemoAttachment[]
  index: number | null
  onIndexChange: (index: number) => void
  onClose: () => void
}

export function MemoLightbox({ images, index, onIndexChange, onClose }: MemoLightboxProps): ReactElement | null {
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [motionFailedId, setMotionFailedId] = useState<string | null>(null)
  const [imageFailedId, setImageFailedId] = useState<string | null>(null)
  const changeRef = useRef(onIndexChange)
  changeRef.current = onIndexChange
  const total = images.length
  const activeIndex = index === null || total === 0 ? null : ((index % total) + total) % total
  const current = activeIndex === null ? null : images[activeIndex] ?? null

  useEffect(() => {
    if (activeIndex === null || total < 2) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const step = event.key === 'ArrowRight' ? 1 : -1
      changeRef.current((activeIndex + step + total) % total)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeIndex, total])

  useEffect(() => {
    if (index !== null) return
    setPlayingId(null)
    setMotionFailedId(null)
    setImageFailedId(null)
  }, [index])

  if (!current || activeIndex === null) return null

  const motionUrl = motionVideoUrl(current)
  const playing = playingId === current.id
  const motionFailed = motionFailedId === current.id
  const imageFailed = imageFailedId === current.id
  const metadata = mediaMetadataLines(current)
  const dimensions = attachmentDimensions(current)
  const counter = t('memos.media.counter', { index: activeIndex + 1, total })
  const downloadLabel = t('memos.attachments.download', { name: current.filename })
  const step = (direction: 1 | -1): void => {
    changeRef.current((activeIndex + direction + total) % total)
  }

  return (
    <Modal
      open
      onClose={onClose}
      variant="fullscreen"
      ariaLabel={t('memos.media.viewer')}
      className="border-0 bg-[oklch(0%_0_0/92%)] text-white"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-memo-lightbox="">
        <div className="flex shrink-0 items-center gap-2 px-2 pb-2 pt-[calc(8px+env(safe-area-inset-top))] md:px-4">
          <p aria-live="polite" className="min-w-0 truncate text-[length:var(--text-11-5)] tabular text-white/60">
            {counter}
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {motionUrl ? (
              <Button
                size="sm"
                variant="ghost"
                icon={playing ? undefined : <Play size={12} aria-hidden="true" />}
                onClick={() => setPlayingId(playing ? null : current.id)}
                className="text-white/80 hover:bg-white/10 hover:text-white"
              >
                {playing ? t('memos.media.show_still') : t('memos.media.play_motion')}
              </Button>
            ) : null}
            <a
              href={current.url}
              download={current.filename}
              aria-label={downloadLabel}
              className="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white md:size-7"
            >
              <Download size={16} aria-hidden="true" />
            </a>
            <IconButton
              label={t('common.close')}
              data-autofocus
              onClick={onClose}
              className="text-white/70 hover:bg-white/10 hover:text-white"
            >
              <X size={17} />
            </IconButton>
          </div>
        </div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 py-2 md:px-14">
          {total > 1 ? (
            <IconButton
              label={t('memos.media.previous')}
              size="lg"
              onClick={() => step(-1)}
              className="absolute left-1 top-1/2 z-10 -translate-y-1/2 bg-black/30 text-white/80 hover:bg-black/50 hover:text-white md:left-3"
            >
              <ChevronLeft size={22} />
            </IconButton>
          ) : null}
          {playing && motionUrl && !motionFailed ? (
            <video
              key={current.id}
              src={motionUrl}
              controls
              autoPlay
              loop
              playsInline
              aria-label={t('memos.media.motion_video_label', { name: current.filename })}
              onError={() => setMotionFailedId(current.id)}
              className="max-h-full max-w-full rounded-[var(--r-md)] bg-black"
            />
          ) : imageFailed ? (
            <div role="alert" className="flex max-w-[80vw] flex-col items-center gap-2 rounded-[var(--r-lg)] bg-black/35 px-5 py-4 text-center text-[length:var(--text-12)] text-white/75">
              <p>{t('memos.media.image_failed')}</p>
              <a
                href={current.url}
                download={current.filename}
                className="inline-flex items-center gap-1.5 rounded-[var(--r-sm)] bg-white/10 px-2 py-1 text-white/80 transition-colors hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              >
                <Download size={13} aria-hidden="true" />
                {downloadLabel}
              </a>
            </div>
          ) : (
            <img
              src={current.url}
              alt={current.filename}
              width={dimensions.width}
              height={dimensions.height}
              onError={() => setImageFailedId(current.id)}
              className="max-h-full max-w-full rounded-[var(--r-md)] object-contain"
            />
          )}
          {total > 1 ? (
            <IconButton
              label={t('memos.media.next')}
              size="lg"
              onClick={() => step(1)}
              className="absolute right-1 top-1/2 z-10 -translate-y-1/2 bg-black/30 text-white/80 hover:bg-black/50 hover:text-white md:right-3"
            >
              <ChevronRight size={22} />
            </IconButton>
          ) : null}
        </div>
        <div className="shrink-0 px-4 pb-[calc(16px+env(safe-area-inset-bottom))] text-center">
          {motionFailed ? (
            <p role="alert" className="mb-1 text-[length:var(--text-11)] text-white/70">
              {t('memos.media.motion_unavailable')}
            </p>
          ) : null}
          <p aria-live="polite" className="mx-auto max-w-[80ch] truncate text-[length:var(--text-12-5)] text-white/80">
            {current.filename}
          </p>
          {metadata.length > 0 ? (
            <p className="mx-auto mt-0.5 max-w-[80ch] truncate text-[length:var(--text-11)] text-white/60">
              {metadata.join(' · ')}
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
