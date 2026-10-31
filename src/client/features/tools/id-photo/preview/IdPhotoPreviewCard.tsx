import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Eye, Grid, Maximize2, UserCheck } from 'lucide-react'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { useIdPhotoStore } from '../store'
import { specLabel } from '../spec-label'
import { IdPhotoEngine } from '../engine/id-photo-engine'

const GUIDE_BASE = 'absolute left-0 right-0 border-t border-dashed'

const GUIDE_LINES = [
  { top: '12%', tone: 'border-[var(--accent)]' },
  { top: '42%', tone: 'border-[var(--warning)]' },
  { top: '78%', tone: 'border-[var(--accent)]' },
] as const

export function IdPhotoPreviewCard() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderGeneration = useRef(0)
  const [renderFailed, setRenderFailed] = useState(false)
  const [comparingOriginal, setComparingOriginal] = useState(false)

  const imageSrc = useIdPhotoStore((s) => s.imageSrc)
  const originalImageSrc = useIdPhotoStore((s) => s.originalImageSrc)
  const imageElement = useIdPhotoStore((s) => s.imageElement)
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const getActiveSpec = useIdPhotoStore((s) => s.getActiveSpec)
  const guidesVisible = useIdPhotoStore((s) => s.guidesVisible)
  const toggleGuides = useIdPhotoStore((s) => s.toggleGuides)
  const setFullscreenModalOpen = useIdPhotoStore((s) => s.setFullscreenModalOpen)
  const panByRatio = useIdPhotoStore((s) => s.panByRatio)

  const activeSpec = getActiveSpec()

  const drag = useRef<{ pointerId: number; x: number; y: number; width: number; height: number } | null>(null)

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!imageElement || comparingOriginal) return
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: box.width, height: box.height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    const dx = (event.clientX - state.x) / state.width
    const dy = (event.clientY - state.y) / state.height
    state.x = event.clientX
    state.y = event.clientY
    if (dx !== 0 || dy !== 0) panByRatio(dx, dy)
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!imageElement) {
      canvas.width = 0
      canvas.height = 0
      return
    }

    const generation = ++renderGeneration.current
    const engine = new IdPhotoEngine(activeSpec, adjustOptions)
    engine
      .renderCanvas(imageElement)
      .then((rendered) => {
        if (generation !== renderGeneration.current) return
        canvas.width = rendered.width
        canvas.height = rendered.height
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(rendered, 0, 0)
      })
      .catch(() => {
        if (generation !== renderGeneration.current) return
        setRenderFailed(true)
      })
  }, [imageElement, activeSpec, adjustOptions])

  return (
    <div className="relative flex flex-col items-center justify-center rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 shadow-sm min-h-[380px]">
      {/* Top action toolbar */}
      <div className="absolute right-3 top-3 flex items-center gap-1 z-10">
        <Tooltip label={t('tools.id_photo.preview.show_guides')}>
          <IconButton
            size="sm"
            label={t('tools.id_photo.preview.show_guides')}
            active={guidesVisible}
            onClick={toggleGuides}
          >
            <Grid size={15} />
          </IconButton>
        </Tooltip>

        {originalImageSrc && (
          <Tooltip label={t('tools.id_photo.preview.compare_original')}>
            <IconButton
              size="sm"
              active={comparingOriginal}
              label={t('tools.id_photo.preview.compare_original')}
              aria-pressed={comparingOriginal}
              onMouseDown={() => setComparingOriginal(true)}
              onMouseUp={() => setComparingOriginal(false)}
              onMouseLeave={() => setComparingOriginal(false)}
              onTouchStart={() => setComparingOriginal(true)}
              onTouchEnd={() => setComparingOriginal(false)}
              onClick={() => setComparingOriginal((current) => !current)}
            >
              <Eye size={15} />
            </IconButton>
          </Tooltip>
        )}

        <Tooltip label={t('tools.id_photo.preview.fullscreen')}>
          <IconButton
            size="sm"
            label={t('tools.id_photo.preview.fullscreen')}
            onClick={() => setFullscreenModalOpen(true)}
          >
            <Maximize2 size={15} />
          </IconButton>
        </Tooltip>
      </div>

      {/* Main Preview Container */}
      {!imageSrc ? (
        <div className="flex flex-col items-center justify-center gap-3 p-8 text-center select-none">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[var(--text-tertiary)]">
            <UserCheck size={28} />
          </div>
          <div className="flex flex-col gap-1 max-w-[260px]">
            <p className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
              {t('tools.id_photo.preview.empty_title')}
            </p>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.id_photo.preview.empty_desc')}
            </p>
          </div>
        </div>
      ) : (
        <div className="relative flex items-center justify-center py-2">
          {comparingOriginal && originalImageSrc ? (
            <img
              src={originalImageSrc}
              alt={t('tools.id_photo.common.original')}
              className="max-h-[360px] max-w-full rounded-[var(--r-md)] object-contain shadow-sm"
            />
          ) : (
            <div
              className="relative touch-none"
              data-framing-drag
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
            >
              <canvas
                ref={canvasRef}
                role="img"
                aria-label={t('tools.id_photo.common.thumbnail')}
                className={cn(
                  'max-h-[360px] w-auto max-w-full rounded-[var(--r-md)] shadow-[var(--shadow-pop)]',
                  imageElement && 'cursor-grab',
                )}
              />
              {renderFailed && (
                <p className="absolute inset-0 flex items-center justify-center text-center text-[length:var(--text-12)] font-medium text-[var(--danger)]">
                  {t('tools.id_photo.preview.render_failed')}
                </p>
              )}

              {/* Standard Alignment Guides Overlay */}
              {guidesVisible && (
                <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2">
                  <div
                    style={{ top: GUIDE_LINES[0].top }}
                    className={cn(GUIDE_BASE, GUIDE_LINES[0].tone)}
                  />
                  <div
                    style={{ top: GUIDE_LINES[1].top }}
                    className={cn(GUIDE_BASE, GUIDE_LINES[1].tone)}
                  />
                  <div
                    style={{ top: GUIDE_LINES[2].top }}
                    className={cn(GUIDE_BASE, GUIDE_LINES[2].tone)}
                  />
                  <div
                    style={{ left: '50%' }}
                    className="absolute top-0 bottom-0 border-l border-dashed border-[var(--danger)]"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bottom Spec Meta Tag */}
      <div className="mt-3 flex items-center gap-2 rounded-full bg-[var(--bg-base)] px-3 py-1 border border-[var(--border-subtle)] shadow-xs">
        {activeSpec.flagEmoji && (
          <span className="text-sm leading-none">{activeSpec.flagEmoji}</span>
        )}
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
          {specLabel(activeSpec)}
        </span>
        <span className="text-[var(--text-tertiary)] text-[length:var(--text-11)] font-mono">
          {activeSpec.widthMm}×{activeSpec.heightMm}{t('tools.id_photo.unit.mm')} ({activeSpec.widthPx}×{activeSpec.heightPx}{t('tools.id_photo.unit.px')} @ {activeSpec.dpi}{t('tools.id_photo.unit.dpi')})
        </span>
      </div>
    </div>
  )
}
