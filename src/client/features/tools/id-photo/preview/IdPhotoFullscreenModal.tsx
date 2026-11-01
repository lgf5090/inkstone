import { useEffect, useRef, useState } from 'react'
import { t } from '../../../../lib/i18n'
import { Modal } from '../../../../components/overlay'
import { useIdPhotoStore } from '../store'
import { specLabel } from '../spec-label'
import { IdPhotoEngine } from '../engine/id-photo-engine'

const FULLSCREEN_LONG_EDGE = 1200

export function IdPhotoFullscreenModal() {
  const open = useIdPhotoStore((s) => s.fullscreenModalOpen)
  const setOpen = useIdPhotoStore((s) => s.setFullscreenModalOpen)
  const imageElement = useIdPhotoStore((s) => s.imageElement)
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const getActiveSpec = useIdPhotoStore((s) => s.getActiveSpec)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)

  const spec = getActiveSpec()
  const scale = Math.min(2, Math.max(1, FULLSCREEN_LONG_EDGE / Math.max(spec.widthPx, spec.heightPx)))
  const widthPx = Math.round(spec.widthPx * scale)
  const heightPx = Math.round(spec.heightPx * scale)

  useEffect(() => {
    if (!open || !imageElement) return
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    setFailed(false)
    new IdPhotoEngine(spec, adjustOptions)
      .renderCanvas(imageElement, widthPx, heightPx)
      .then((rendered) => {
        if (cancelled) return
        canvas.width = rendered.width
        canvas.height = rendered.height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          setFailed(true)
          return
        }
        ctx.drawImage(rendered, 0, 0)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [open, imageElement, adjustOptions, spec, widthPx, heightPx])

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title={t('tools.id_photo.preview.fullscreen')}
      variant="fullscreen"
    >
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4 p-4">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${specLabel(spec)} ${widthPx}×${heightPx}`}
          className="min-h-0 w-auto max-w-full flex-1 rounded-[var(--r-md)] bg-[var(--bg-surface)] object-contain shadow-[var(--shadow-pop)]"
        />
        {failed && (
          <p className="text-[length:var(--text-13)] font-medium text-[var(--danger)]">
            {t('tools.id_photo.preview.render_failed')}
          </p>
        )}
        <p className="font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {spec.widthMm}×{spec.heightMm}{t('tools.id_photo.unit.mm')} · {widthPx}×{heightPx}{t('tools.id_photo.unit.px')}
        </p>
      </div>
    </Modal>
  )
}
