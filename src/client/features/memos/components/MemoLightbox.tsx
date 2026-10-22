import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { ChevronLeft, ChevronRight, Download, Play, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
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

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const ZOOM_STEP = 0.5
const WHEEL_ZOOM_STEP = 0.25
const DOUBLE_CLICK_ZOOM = 2
const SWIPE_MIN_DISTANCE = 48
const SWIPE_MAX_DURATION_MS = 800
const IDLE_PAN = { x: 0, y: 0 }

interface Point {
  x: number
  y: number
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
}

interface SwipeState {
  pointerId: number
  startX: number
  startY: number
  startedAt: number
}

interface PinchState {
  distance: number
  zoom: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function pointerDistance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y)
}

export function MemoLightbox({ images, index, onIndexChange, onClose }: MemoLightboxProps): ReactElement | null {
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [motionFailedId, setMotionFailedId] = useState<string | null>(null)
  const [imageFailedId, setImageFailedId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [pan, setPan] = useState(IDLE_PAN)
  const changeRef = useRef(onIndexChange)
  changeRef.current = onIndexChange
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pointersRef = useRef(new Map<number, Point>())
  const dragRef = useRef<DragState | null>(null)
  const swipeRef = useRef<SwipeState | null>(null)
  const pinchRef = useRef<PinchState | null>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const total = images.length
  const activeIndex = index === null || total === 0 ? null : ((index % total) + total) % total
  const current = activeIndex === null ? null : images[activeIndex] ?? null
  const motionUrl = current ? motionVideoUrl(current) : null
  const playing = current !== null && playingId === current.id
  const motionFailed = current !== null && motionFailedId === current.id
  const imageFailed = current !== null && imageFailedId === current.id
  const videoShown = playing && Boolean(motionUrl) && !motionFailed
  const imageShown = current !== null && !videoShown && !imageFailed

  const clampPan = useCallback((x: number, y: number, level: number): Point => {
    const element = imageRef.current
    const maxX = element ? Math.max(0, (element.clientWidth * (level - 1)) / 2) : 0
    const maxY = element ? Math.max(0, (element.clientHeight * (level - 1)) / 2) : 0
    return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) }
  }, [])

  const applyZoom = useCallback((nextZoom: number): void => {
    const next = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
    setZoom(next)
    setPan((currentPan) => next === MIN_ZOOM ? IDLE_PAN : clampPan(currentPan.x, currentPan.y, next))
  }, [clampPan])

  const resetGesture = useCallback((): void => {
    pointersRef.current.clear()
    dragRef.current = null
    swipeRef.current = null
    pinchRef.current = null
  }, [])

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
    applyZoom(MIN_ZOOM)
    resetGesture()
  }, [activeIndex, applyZoom, resetGesture])

  useEffect(() => {
    if (index !== null) return
    setPlayingId(null)
    setMotionFailedId(null)
    setImageFailedId(null)
    applyZoom(MIN_ZOOM)
    resetGesture()
  }, [index, applyZoom, resetGesture])

  useEffect(() => resetGesture, [resetGesture])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !imageShown) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey || event.deltaY === 0) return
      event.preventDefault()
      applyZoom(zoomRef.current + (event.deltaY < 0 ? WHEEL_ZOOM_STEP : -WHEEL_ZOOM_STEP))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [activeIndex, applyZoom, imageShown])

  if (!current || activeIndex === null) return null

  const metadata = mediaMetadataLines(current)
  const dimensions = attachmentDimensions(current)
  const counter = t('memos.media.counter', { index: activeIndex + 1, total })
  const downloadLabel = t('memos.attachments.download', { name: current.filename })
  const zoomPercent = Math.round(zoom * 100)
  const step = (direction: 1 | -1): void => {
    changeRef.current((activeIndex + direction + total) % total)
  }
  const toggleMotion = (): void => {
    applyZoom(MIN_ZOOM)
    setPlayingId(playing ? null : current.id)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!imageShown) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button, a')) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointersRef.current.size === 1) {
      dragRef.current = zoom > MIN_ZOOM
        ? {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: pan.x,
            originY: pan.y,
          }
        : null
      swipeRef.current = zoom === MIN_ZOOM && total > 1
        ? {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startedAt: Date.now(),
          }
        : null
    } else if (pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()]
      dragRef.current = null
      swipeRef.current = null
      pinchRef.current = first && second
        ? { distance: pointerDistance(first, second), zoom }
        : null
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.has(event.pointerId)) return
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const pinch = pinchRef.current
    if (pinch && pointersRef.current.size >= 2) {
      const [first, second] = [...pointersRef.current.values()]
      if (first && second && pinch.distance > 0) {
        applyZoom(pinch.zoom * (pointerDistance(first, second) / pinch.distance))
      }
      return
    }
    const drag = dragRef.current
    if (drag?.pointerId === event.pointerId) {
      setPan(clampPan(
        drag.originX + event.clientX - drag.startX,
        drag.originY + event.clientY - drag.startY,
        zoom,
      ))
    }
  }

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    if (!pointersRef.current.has(event.pointerId)) return
    pointersRef.current.delete(event.pointerId)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const swipe = swipeRef.current
    const pinched = pinchRef.current !== null
    if (pointersRef.current.size < 2) pinchRef.current = null
    if (pointersRef.current.size > 0) return
    dragRef.current = null
    swipeRef.current = null
    if (cancelled || pinched || !swipe || swipe.pointerId !== event.pointerId) return
    if (zoomRef.current !== MIN_ZOOM) return
    const dx = event.clientX - swipe.startX
    const dy = event.clientY - swipe.startY
    const elapsed = Date.now() - swipe.startedAt
    if (elapsed > SWIPE_MAX_DURATION_MS) return
    if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dx) <= Math.abs(dy) * 1.5) return
    step(dx < 0 ? 1 : -1)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    endPointer(event, false)
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    endPointer(event, true)
  }

  return (
    <Modal
      open
      onClose={onClose}
      variant="fullscreen"
      ariaLabel={t('memos.media.viewer')}
      className="border-0 bg-[var(--media-scrim)] text-[var(--media-text-strong)]"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-memo-lightbox="">
        <div className="flex shrink-0 items-center gap-2 px-2 pb-2 pt-[calc(8px+env(safe-area-inset-top))] md:px-4">
          <p aria-live="polite" className="min-w-0 truncate text-[length:var(--text-11-5)] tabular text-[var(--media-text)] opacity-75">
            {counter}
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {imageShown ? (
              <div className="flex items-center gap-0.5">
                <IconButton
                  label={t('memos.media.zoom_out')}
                  size="sm"
                  disabled={zoom <= MIN_ZOOM}
                  onClick={() => applyZoom(zoom - ZOOM_STEP)}
                  className="text-[var(--media-text)] hover:bg-[var(--media-surface)] hover:text-[var(--media-text-strong)]"
                >
                  <ZoomOut size={15} />
                </IconButton>
                <p
                  aria-live="polite"
                  data-memo-zoom-status=""
                  className="w-14 text-center text-[length:var(--text-11)] tabular text-[var(--media-text)]"
                >
                  {t('memos.media.zoom_status', { percent: zoomPercent })}
                </p>
                <IconButton
                  label={t('memos.media.zoom_in')}
                  size="sm"
                  disabled={zoom >= MAX_ZOOM}
                  onClick={() => applyZoom(zoom + ZOOM_STEP)}
                  className="text-[var(--media-text)] hover:bg-[var(--media-surface)] hover:text-[var(--media-text-strong)]"
                >
                  <ZoomIn size={15} />
                </IconButton>
                <IconButton
                  label={t('memos.media.zoom_reset')}
                  size="sm"
                  disabled={zoom <= MIN_ZOOM}
                  onClick={() => applyZoom(MIN_ZOOM)}
                  className="text-[var(--media-text)] hover:bg-[var(--media-surface)] hover:text-[var(--media-text-strong)]"
                >
                  <RotateCcw size={14} />
                </IconButton>
              </div>
            ) : null}
            {motionUrl ? (
              <Button
                size="sm"
                variant="ghost"
                icon={playing ? undefined : <Play size={12} aria-hidden="true" />}
                onClick={toggleMotion}
                className="text-[var(--media-text)] hover:bg-[var(--media-surface)] hover:text-[var(--media-text-strong)]"
              >
                {playing ? t('memos.media.show_still') : t('memos.media.play_motion')}
              </Button>
            ) : null}
            <a
              href={current.url}
              download={current.filename}
              aria-label={downloadLabel}
              className="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-[var(--media-text)] transition-colors hover:bg-[var(--media-surface)] hover:text-[var(--media-text-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--media-text-strong)] md:size-7"
            >
              <Download size={16} aria-hidden="true" />
            </a>
            <IconButton
              label={t('common.close')}
              data-autofocus
              onClick={onClose}
              className="text-[var(--media-text)] hover:bg-[var(--media-surface)] hover:text-[var(--media-text-strong)]"
            >
              <X size={17} />
            </IconButton>
          </div>
        </div>
        <div
          ref={stageRef}
          data-memo-lightbox-stage=""
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden px-2 py-2 md:px-14"
        >
          {total > 1 ? (
            <IconButton
              label={t('memos.media.previous')}
              size="lg"
              onClick={() => step(-1)}
              className="absolute left-1 top-1/2 z-[var(--z-sticky)] -translate-y-1/2 bg-[var(--media-control)] text-[var(--media-text)] hover:bg-[var(--media-control-hover)] hover:text-[var(--media-text-strong)] md:left-3"
            >
              <ChevronLeft size={22} />
            </IconButton>
          ) : null}
          {videoShown && motionUrl ? (
            <video
              key={current.id}
              src={motionUrl}
              controls
              autoPlay
              loop
              playsInline
              aria-label={t('memos.media.motion_video_label', { name: current.filename })}
              onError={() => setMotionFailedId(current.id)}
              className="max-h-full max-w-full rounded-[var(--r-md)] bg-[var(--media-scrim)]"
            />
          ) : imageFailed ? (
            <div role="alert" className="flex max-w-[80vw] flex-col items-center gap-2 rounded-[var(--r-lg)] bg-[var(--media-control)] px-5 py-4 text-center text-[length:var(--text-12)] text-[var(--media-text)]">
              <p>{t('memos.media.image_failed')}</p>
              <a
                href={current.url}
                download={current.filename}
                className="inline-flex items-center gap-1.5 rounded-[var(--r-sm)] bg-[var(--media-surface)] px-2 py-1 text-[var(--media-text)] transition-colors hover:bg-[var(--media-control-hover)] hover:text-[var(--media-text-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--media-text-strong)]"
              >
                <Download size={13} aria-hidden="true" />
                {downloadLabel}
              </a>
            </div>
          ) : (
            <img
              ref={imageRef}
              src={current.url}
              alt={current.filename}
              width={dimensions.width}
              height={dimensions.height}
              draggable={false}
              onDoubleClick={() => applyZoom(zoom > MIN_ZOOM ? MIN_ZOOM : DOUBLE_CLICK_ZOOM)}
              onError={() => setImageFailedId(current.id)}
              style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
              className={zoom > MIN_ZOOM
                ? 'max-h-full max-w-full cursor-grab touch-none rounded-[var(--r-md)] object-contain select-none active:cursor-grabbing'
                : 'max-h-full max-w-full cursor-zoom-in touch-none rounded-[var(--r-md)] object-contain select-none'}
            />
          )}
          {total > 1 ? (
            <IconButton
              label={t('memos.media.next')}
              size="lg"
              onClick={() => step(1)}
              className="absolute right-1 top-1/2 z-[var(--z-sticky)] -translate-y-1/2 bg-[var(--media-control)] text-[var(--media-text)] hover:bg-[var(--media-control-hover)] hover:text-[var(--media-text-strong)] md:right-3"
            >
              <ChevronRight size={22} />
            </IconButton>
          ) : null}
        </div>
        <div className="shrink-0 px-4 pb-[calc(16px+env(safe-area-inset-bottom))] text-center">
          {motionFailed ? (
            <p role="alert" className="mb-1 text-[length:var(--text-11)] text-[var(--media-text)]">
              {t('memos.media.motion_unavailable')}
            </p>
          ) : null}
          <p aria-live="polite" className="mx-auto max-w-[80ch] truncate text-[length:var(--text-12-5)] text-[var(--media-text)]">
            {current.filename}
          </p>
          {metadata.length > 0 ? (
            <p className="mx-auto mt-0.5 max-w-[80ch] truncate text-[length:var(--text-11)] text-[var(--media-text)] opacity-75">
              {metadata.join(' · ')}
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
