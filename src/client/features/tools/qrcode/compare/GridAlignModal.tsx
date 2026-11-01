import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../../../lib/i18n'
import { Field, Slider } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { Modal } from '../../../../components/overlay'

const PREVIEW_SIZE = 500

interface GridAlignModalProps {
  open: boolean
  imageUrl: string
  initialGridSize: number
  initialMarginSize: number
  onClose: () => void
  onApply: (gridSize: number, marginSize: number) => void
}

export function GridAlignModal({
  open,
  imageUrl,
  initialGridSize,
  initialMarginSize,
  onClose,
  onApply,
}: GridAlignModalProps) {
  const [gridSize, setGridSize] = useState(initialGridSize)
  const [marginSize, setMarginSize] = useState(initialMarginSize)
  const [failed, setFailed] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    if (!open) return
    setGridSize(initialGridSize)
    setMarginSize(initialMarginSize)
    setFailed(false)
  }, [open, initialGridSize, initialMarginSize])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = PREVIEW_SIZE
    canvas.height = PREVIEW_SIZE
    const minSide = Math.min(img.width, img.height)
    ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
    ctx.drawImage(
      img,
      (img.width - minSide) / 2,
      (img.height - minSide) / 2,
      minSide,
      minSide,
      0,
      0,
      PREVIEW_SIZE,
      PREVIEW_SIZE
    )

    const cellSize = PREVIEW_SIZE / gridSize
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)'
    ctx.lineWidth = 1
    for (let i = 0; i <= gridSize; i++) {
      const pos = i * cellSize
      ctx.beginPath()
      ctx.moveTo(pos, 0)
      ctx.lineTo(pos, PREVIEW_SIZE)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, pos)
      ctx.lineTo(PREVIEW_SIZE, pos)
      ctx.stroke()
    }

    const offset = marginSize * cellSize
    ctx.strokeStyle = '#84cc16'
    ctx.lineWidth = 2.5
    ctx.strokeRect(offset, offset, PREVIEW_SIZE - offset * 2, PREVIEW_SIZE - offset * 2)
  }, [gridSize, marginSize])

  useEffect(() => {
    if (!open || !imageUrl) return
    let cancelled = false
    // One decode for the whole session with the grid being dragged over it: loading it inside the draw
    // effect re-fetched and re-decoded the same picture on every slider step.
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      imageRef.current = img
      draw()
    }
    img.onerror = () => {
      if (cancelled) return
      imageRef.current = null
      setFailed(true)
    }
    img.src = imageUrl
    return () => {
      cancelled = true
    }
  }, [open, imageUrl, draw])

  useEffect(() => {
    if (open) draw()
  }, [open, draw])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tools.qrcode.compare.align_grid_title')}
      width={560}
    >
      <div className="flex flex-col gap-4 p-4">
        {failed ? (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
            {t('tools.qrcode.compare.image_failed')}
          </p>
        ) : (
          <div className="flex justify-center">
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={t('tools.qrcode.compare.align_preview_label')}
              className="h-72 w-72 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] object-contain"
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-4 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-0.5 w-4 bg-[#ef4444]" />
            {t('tools.qrcode.compare.legend_grid')}
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-0.5 w-4 bg-[#84cc16]" />
            {t('tools.qrcode.compare.legend_margin')}
          </span>
        </div>

        <Field label={`${t('tools.qrcode.compare.grid_modules')}: ${gridSize} × ${gridSize}`}>
          <Slider
            value={gridSize}
            min={17}
            max={65}
            onChange={setGridSize}
          />
        </Field>

        <Field label={`${t('tools.qrcode.compare.margin_modules')}: ${marginSize}`}>
          <Slider value={marginSize} min={0} max={8} onChange={setMarginSize} />
        </Field>

        <div className="flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-3">
          <Button variant="secondary" onClick={onClose}>
            {t('tools.qrcode.compare.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={failed}
            onClick={() => onApply(gridSize, marginSize)}
          >
            {t('tools.qrcode.compare.apply')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
