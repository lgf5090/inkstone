import React, { useEffect, useRef, useState } from 'react'
import { Grid, X } from 'lucide-react'
import { t } from '../../../../lib/i18n'

interface GridAlignModalProps {
  open: boolean
  imageUrl: string
  initialGridSize: number
  initialMarginSize: number
  onClose: () => void
  onApply: (gridSize: number, marginSize: number) => void
}

export const GridAlignModal: React.FC<GridAlignModalProps> = ({
  open,
  imageUrl,
  initialGridSize,
  initialMarginSize,
  onClose,
  onApply,
}) => {
  const [gridSize, setGridSize] = useState(initialGridSize)
  const [marginSize, setMarginSize] = useState(initialMarginSize)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!open) return
    setGridSize(initialGridSize)
    setMarginSize(initialMarginSize)
  }, [open, initialGridSize, initialMarginSize])

  useEffect(() => {
    if (!open || !canvasRef.current || !imageUrl) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = imageUrl
    img.onload = () => {
      const size = 500
      canvas.width = size
      canvas.height = size

      const minSide = Math.min(img.width, img.height)
      ctx.drawImage(
        img,
        (img.width - minSide) / 2,
        (img.height - minSide) / 2,
        minSide,
        minSide,
        0,
        0,
        size,
        size
      )

      // Draw Grid Lines (Red)
      const cellSize = size / gridSize
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)'
      ctx.lineWidth = 1

      for (let i = 0; i <= gridSize; i++) {
        const pos = i * cellSize
        ctx.beginPath()
        ctx.moveTo(pos, 0)
        ctx.lineTo(pos, size)
        ctx.stroke()

        ctx.beginPath()
        ctx.moveTo(0, pos)
        ctx.lineTo(size, pos)
        ctx.stroke()
      }

      // Draw Margin Box (Lime)
      const mOffset = marginSize * cellSize
      const mWidth = size - mOffset * 2
      ctx.strokeStyle = '#84cc16'
      ctx.lineWidth = 2.5
      ctx.strokeRect(mOffset, mOffset, mWidth, mWidth)
    }
  }, [open, imageUrl, gridSize, marginSize])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex w-full max-w-lg flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
          <div className="flex items-center gap-2">
            <Grid size={18} className="text-[var(--accent)]" />
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {t('tools.qrcode.compare.align_grid_title')}
            </h3>
          </div>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="my-4 flex justify-center">
          <canvas
            ref={canvasRef}
            className="h-72 w-72 rounded-lg border border-[var(--border-subtle)] bg-neutral-900 object-contain shadow-inner"
          />
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-[var(--text-secondary)]">
              <span>{t('tools.qrcode.compare.grid_modules')}</span>
              <span className="font-mono text-[var(--text-primary)]">{`${gridSize} × ${gridSize}`}</span>
            </div>
            <input
              type="range"
              min={17}
              max={65}
              step={1}
              value={gridSize}
              onChange={(e) => setGridSize(Number(e.target.value))}
              className="h-1.5 w-full cursor-pointer accent-[var(--accent)]"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-[var(--text-secondary)]">
              <span>{t('tools.qrcode.compare.margin_modules')}</span>
              <span className="font-mono text-[var(--text-primary)]">{`${marginSize} cells`}</span>
            </div>
            <input
              type="range"
              min={0}
              max={8}
              step={1}
              value={marginSize}
              onChange={(e) => setMarginSize(Number(e.target.value))}
              className="h-1.5 w-full cursor-pointer accent-[var(--accent)]"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            {t('tools.qrcode.compare.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onApply(gridSize, marginSize)}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-medium text-white shadow-xs hover:opacity-95"
          >
            {t('tools.qrcode.compare.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
