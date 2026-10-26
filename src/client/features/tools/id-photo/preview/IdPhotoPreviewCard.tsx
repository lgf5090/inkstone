import { useEffect, useRef, useState } from 'react'
import { Eye, Grid, Maximize2, UserCheck } from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { useIdPhotoStore } from '../store'
import { IdPhotoEngine } from '../engine/id-photo-engine'

export function IdPhotoPreviewCard() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [comparingOriginal, setComparingOriginal] = useState(false)

  const imageSrc = useIdPhotoStore((s) => s.imageSrc)
  const originalImageSrc = useIdPhotoStore((s) => s.originalImageSrc)
  const imageElement = useIdPhotoStore((s) => s.imageElement)
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const getActiveSpec = useIdPhotoStore((s) => s.getActiveSpec)
  const guidesVisible = useIdPhotoStore((s) => s.guidesVisible)
  const toggleGuides = useIdPhotoStore((s) => s.toggleGuides)
  const setFullscreenModalOpen = useIdPhotoStore((s) => s.setFullscreenModalOpen)

  const activeSpec = getActiveSpec()

  useEffect(() => {
    if (!imageElement || !containerRef.current) return

    const engine = new IdPhotoEngine(activeSpec, adjustOptions)
    let isMounted = true

    engine.renderCanvas(imageElement).then((canvas) => {
      if (isMounted && containerRef.current) {
        containerRef.current.innerHTML = ''
        canvas.style.maxWidth = '100%'
        canvas.style.maxHeight = '360px'
        canvas.style.height = 'auto'
        canvas.style.borderRadius = 'var(--r-md)'
        canvas.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.08)'
        containerRef.current.appendChild(canvas)
      }
    })

    return () => {
      isMounted = false
    }
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
              label={t('tools.id_photo.preview.compare_original')}
              onMouseDown={() => setComparingOriginal(true)}
              onMouseUp={() => setComparingOriginal(false)}
              onMouseLeave={() => setComparingOriginal(false)}
              onTouchStart={() => setComparingOriginal(true)}
              onTouchEnd={() => setComparingOriginal(false)}
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
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
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
            <div className="relative">
              <div ref={containerRef} className="flex items-center justify-center" />

              {/* Standard Alignment Guides Overlay */}
              {guidesVisible && (
                <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2">
                  {/* Top crown line */}
                  <div
                    style={{ top: '12%' }}
                    className="absolute left-0 right-0 border-t border-dashed border-cyan-400/80"
                  />
                  {/* Eye horizontal center line */}
                  <div
                    style={{ top: '42%' }}
                    className="absolute left-0 right-0 border-t border-dashed border-amber-400/80"
                  />
                  {/* Chin bottom line */}
                  <div
                    style={{ top: '78%' }}
                    className="absolute left-0 right-0 border-t border-dashed border-cyan-400/80"
                  />
                  {/* Vertical Center line */}
                  <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 border-l border-dashed border-red-400/80" />
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
          {activeSpec.nameKey ? t(activeSpec.nameKey as any) : activeSpec.name}
        </span>
        <span className="text-[var(--text-tertiary)] text-[length:var(--text-11)] font-mono">
          {activeSpec.widthMm}×{activeSpec.heightMm}{t('tools.id_photo.unit.mm')} ({activeSpec.widthPx}×{activeSpec.heightPx}{t('tools.id_photo.unit.px')} @ {activeSpec.dpi}{t('tools.id_photo.unit.dpi')})
        </span>
      </div>
    </div>
  )
}
