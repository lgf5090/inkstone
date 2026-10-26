import React, { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Compass,
  Download,
  Grid,
  Layers,
  Sparkles,
  Upload,
} from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { useQrCodeStore } from '../store'
import { QrEngine } from '../engine/qr-engine'
import { GridAlignModal } from './GridAlignModal'
import {
  compareSegments,
  generateControlNetMask,
  segmentImageFromDataUrl,
  type DiffResult,
} from './diff-engine'

export const QrCompareView: React.FC = () => {
  const [aiImageUrl, setAiImageUrl] = useState<string | null>(null)
  const [refImageUrl, setRefImageUrl] = useState<string | null>(null)
  const [gridSize, setGridSize] = useState<number>(29)
  const [marginSize, setMarginSize] = useState<number>(2)
  const diffThreshold = 30

  const [blendMode, setBlendMode] = useState<GlobalCompositeOperation>('difference')
  const [overlayOpacity, setOverlayOpacity] = useState<number>(0.85)
  const [highlightMismatches, setHighlightMismatches] = useState<boolean>(true)

  const [diffResult, setDiffResult] = useState<DiffResult | null>(null)
  const [isProcessing, setIsProcessing] = useState<boolean>(false)
  const [alignModalOpen, setAlignModalOpen] = useState<boolean>(false)

  const aiInputRef = useRef<HTMLInputElement>(null)
  const refInputRef = useRef<HTMLInputElement>(null)
  const displayCanvasRef = useRef<HTMLCanvasElement>(null)

  const getEncodedPayload = useQrCodeStore((s) => s.getEncodedPayload)
  const options = useQrCodeStore((s) => s.options)

  // Use current generator QR as initial reference QR if empty
  const handleUseCurrentGeneratorAsRef = async () => {
    const payload = getEncodedPayload() || 'https://inkstone.app'
    const engine = new QrEngine(options, payload)
    const canvas = await engine.renderCanvas(800, 800)
    setRefImageUrl(canvas.toDataURL('image/png'))
  }

  // Segment and compare whenever images or grid sizes change
  useEffect(() => {
    if (!aiImageUrl || !refImageUrl) {
      setDiffResult(null)
      return
    }

    let isMounted = true
    setIsProcessing(true)

    async function runDiff() {
      try {
        const [aiSegs, refSegs] = await Promise.all([
          segmentImageFromDataUrl(aiImageUrl!, gridSize),
          segmentImageFromDataUrl(refImageUrl!, gridSize),
        ])

        if (!isMounted) return

        const diff = compareSegments(aiSegs, refSegs, gridSize, marginSize, diffThreshold)
        setDiffResult(diff)
      } catch {
        // error handling
      } finally {
        if (isMounted) setIsProcessing(false)
      }
    }

    runDiff()

    return () => {
      isMounted = false
    }
  }, [aiImageUrl, refImageUrl, gridSize, marginSize, diffThreshold])

  // Render composite display canvas
  useEffect(() => {
    if (!aiImageUrl || !displayCanvasRef.current) return

    const canvas = displayCanvasRef.current
    const ctx = canvas.getContext('2d')!
    const size = 500
    canvas.width = size
    canvas.height = size

    const imgAi = new Image()
    imgAi.crossOrigin = 'anonymous'
    imgAi.src = aiImageUrl
    imgAi.onload = () => {
      ctx.clearRect(0, 0, size, size)
      ctx.drawImage(imgAi, 0, 0, size, size)

      if (refImageUrl) {
        const imgRef = new Image()
        imgRef.crossOrigin = 'anonymous'
        imgRef.src = refImageUrl
        imgRef.onload = () => {
          ctx.save()
          ctx.globalAlpha = overlayOpacity
          ctx.globalCompositeOperation = blendMode
          ctx.drawImage(imgRef, 0, 0, size, size)
          ctx.restore()

          // Draw highlight boxes on mismatches
          if (highlightMismatches && diffResult) {
            const cellSize = size / gridSize
            ctx.lineWidth = 1.5

            ctx.strokeStyle = '#ef4444' // Red for dark mismatches
            for (const m of diffResult.mismatchDark) {
              ctx.strokeRect(m.x * cellSize + 1, m.y * cellSize + 1, cellSize - 2, cellSize - 2)
            }

            ctx.strokeStyle = '#3b82f6' // Blue for light mismatches
            for (const m of diffResult.mismatchLight) {
              ctx.strokeRect(m.x * cellSize + 1, m.y * cellSize + 1, cellSize - 2, cellSize - 2)
            }
          }
        }
      }
    }
  }, [aiImageUrl, refImageUrl, blendMode, overlayOpacity, highlightMismatches, diffResult, gridSize])

  const downloadControlNetMask = (type: 'mask' | 'correction') => {
    if (!diffResult) return
    const maskCanvas = generateControlNetMask(diffResult, gridSize, type)
    const a = document.createElement('a')
    a.href = maskCanvas.toDataURL('image/png')
    a.download = `controlnet-${type}-${Date.now()}.png`
    a.click()
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        {/* Header */}
        <div className="border-b border-[var(--border-subtle)] pb-4">
          <div className="flex items-center gap-2">
            <Compass size={22} className="text-[var(--accent)]" />
            <h2 className="text-xl font-bold text-[var(--text-primary)]">
              {t('tools.qrcode.compare.title')}
            </h2>
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {t('tools.qrcode.compare.subtitle')}
          </p>
        </div>

        {/* Upload Panels Row */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* AI Image Upload */}
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
            <input
              ref={aiInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setAiImageUrl(URL.createObjectURL(f))
              }}
              className="hidden"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                {t('tools.qrcode.compare.ai_image_label')}
              </span>
              <button
                type="button"
                onClick={() => aiInputRef.current?.click()}
                className="flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
              >
                <Upload size={12} />
                <span>{aiImageUrl ? t('tools.qrcode.compare.edit') : t('tools.qrcode.scanner.upload_prompt')}</span>
              </button>
            </div>

            {aiImageUrl ? (
              <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg bg-neutral-900">
                <img src={aiImageUrl} alt="" className="h-full w-full object-contain" />
              </div>
            ) : (
              <div
                onClick={() => aiInputRef.current?.click()}
                className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-[var(--border-subtle)] text-center hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]"
              >
                <Upload size={24} className="text-[var(--text-tertiary)]" />
                <span className="mt-2 text-xs text-[var(--text-tertiary)]">
                  {t('tools.qrcode.compare.upload_ai_prompt')}
                </span>
              </div>
            )}
          </div>

          {/* Reference QR Upload / Generator Hook */}
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
            <input
              ref={refInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setRefImageUrl(URL.createObjectURL(f))
              }}
              className="hidden"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                {t('tools.qrcode.compare.reference_qr_label')}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleUseCurrentGeneratorAsRef}
                  className="flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
                >
                  <Sparkles size={12} />
                  <span>{t('tools.qrcode.compare.use_current')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => refInputRef.current?.click()}
                  className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:underline"
                >
                  <Upload size={12} />
                  <span>{t('tools.qrcode.compare.edit')}</span>
                </button>
              </div>
            </div>

            {refImageUrl ? (
              <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg bg-neutral-900">
                <img src={refImageUrl} alt="" className="h-full w-full object-contain" />
              </div>
            ) : (
              <div
                onClick={() => refInputRef.current?.click()}
                className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-[var(--border-subtle)] text-center hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]"
              >
                <Upload size={24} className="text-[var(--text-tertiary)]" />
                <span className="mt-2 text-xs text-[var(--text-tertiary)]">
                  {t('tools.qrcode.compare.upload_ref_prompt')}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Diagnostics & Comparison Workspace */}
        {aiImageUrl && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Viewport Canvas */}
            <div className="space-y-4 lg:col-span-7">
              <div className="flex flex-col items-center overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
                <canvas
                  ref={displayCanvasRef}
                  className="max-h-[420px] w-auto max-w-full rounded-lg object-contain shadow-xs bg-neutral-900"
                />

                <div className="mt-4 flex w-full flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3 text-xs">
                  <button
                    type="button"
                    onClick={() => setAlignModalOpen(true)}
                    className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-1.5 font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                  >
                    <Grid size={14} className="text-[var(--accent)]" />
                    <span>{t('tools.qrcode.compare.align_grid')}</span>
                  </button>

                  <div className="flex items-center gap-4">
                    <label className="flex cursor-pointer items-center gap-1.5 text-[var(--text-secondary)]">
                      <input
                        type="checkbox"
                        checked={highlightMismatches}
                        onChange={(e) => setHighlightMismatches(e.target.checked)}
                        className="rounded accent-[var(--accent)]"
                      />
                      <span>{t('tools.qrcode.compare.highlight_mismatches')}</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Blend Mode & Opacity Controls */}
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers size={15} className="text-[var(--accent)]" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
                      {t('tools.qrcode.compare.blend_controls')}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <span className="text-xs text-[var(--text-secondary)]">
                      {t('tools.qrcode.compare.blend_mode')}
                    </span>
                    <select
                      value={blendMode}
                      onChange={(e) => setBlendMode(e.target.value as GlobalCompositeOperation)}
                      className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
                    >
                      <option value="difference">{t('tools.qrcode.compare.blend_difference')}</option>
                      <option value="source-over">{t('tools.qrcode.compare.blend_normal')}</option>
                      <option value="multiply">{t('tools.qrcode.compare.blend_multiply')}</option>
                      <option value="screen">{t('tools.qrcode.compare.blend_screen')}</option>
                      <option value="overlay">{t('tools.qrcode.compare.blend_overlay')}</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-[var(--text-secondary)]">
                      <span>{t('tools.qrcode.compare.opacity')}</span>
                      <span>{Math.round(overlayOpacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={overlayOpacity}
                      onChange={(e) => setOverlayOpacity(Number(e.target.value))}
                      className="h-1.5 w-full cursor-pointer accent-[var(--accent)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Diagnostics Stats and Mask Exports */}
            <div className="space-y-4 lg:col-span-5">
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5 space-y-4 shadow-sm">
                <h3 className="text-sm font-semibold text-[var(--text-primary)] border-b border-[var(--border-subtle)] pb-3">
                  {t('tools.qrcode.compare.diagnostics_title')}
                </h3>

                {isProcessing ? (
                  <div className="flex items-center justify-center py-8 text-xs text-[var(--text-tertiary)]">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent mr-2" />
                    <span>{t('common.loading')}</span>
                  </div>
                ) : diffResult ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between rounded-lg bg-[var(--bg-inset)] p-3">
                      <div>
                        <span className="text-xs text-[var(--text-tertiary)]">
                          {t('tools.qrcode.compare.scanability')}
                        </span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {diffResult.scanabilityScore >= 75 ? (
                            <CheckCircle2 size={16} className="text-green-500" />
                          ) : (
                            <AlertCircle size={16} className="text-amber-500" />
                          )}
                          <span className="font-bold text-sm text-[var(--text-primary)]">
                            {diffResult.scanabilityScore}%
                          </span>
                        </div>
                      </div>

                      <div className="text-right">
                        <span className="text-xs text-[var(--text-tertiary)]">
                          {t('tools.qrcode.compare.mismatch_count')}
                        </span>
                        <p className="font-mono text-sm font-bold text-red-500 mt-0.5">
                          {diffResult.mismatchCount}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded border border-[var(--border-subtle)] p-2">
                        <span className="text-[var(--text-tertiary)]">
                          {t('tools.qrcode.compare.mismatch_dark')}
                        </span>
                        <p className="font-mono font-medium text-red-400 mt-0.5">
                          {diffResult.mismatchDark.length}
                        </p>
                      </div>
                      <div className="rounded border border-[var(--border-subtle)] p-2">
                        <span className="text-[var(--text-tertiary)]">
                          {t('tools.qrcode.compare.mismatch_light')}
                        </span>
                        <p className="font-mono font-medium text-blue-400 mt-0.5">
                          {diffResult.mismatchLight.length}
                        </p>
                      </div>
                    </div>

                    {/* ControlNet Mask Export Actions */}
                    <div className="pt-2 border-t border-[var(--border-subtle)] space-y-2">
                      <span className="text-xs font-semibold text-[var(--text-secondary)]">
                        {t('tools.qrcode.compare.export_sd_masks')}
                      </span>

                      <button
                        type="button"
                        onClick={() => downloadControlNetMask('mask')}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      >
                        <Download size={14} />
                        <span>{t('tools.qrcode.compare.export_inpaint_mask')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => downloadControlNetMask('correction')}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      >
                        <Download size={14} />
                        <span>{t('tools.qrcode.compare.export_correction_map')}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-6 text-xs text-[var(--text-tertiary)]">
                    {t('tools.qrcode.compare.ready_prompt')}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <GridAlignModal
          open={alignModalOpen}
          imageUrl={aiImageUrl || ''}
          initialGridSize={gridSize}
          initialMarginSize={marginSize}
          onClose={() => setAlignModalOpen(false)}
          onApply={(g, m) => {
            setGridSize(g)
            setMarginSize(m)
            setAlignModalOpen(false)
          }}
        />
      </div>
    </div>
  )
}
