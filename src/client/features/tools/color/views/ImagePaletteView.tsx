import { useEffect, useRef, useState } from 'react'
import {
  Copy,
  Download,
  Heart,
  Image as ImageIcon,
  Loader2,
  Palette,
  Pipette,
  Sparkles,
  Upload,
} from 'lucide-react'
import { extractPaletteFromPixels } from '@shared/tools/color/quantize'
import {
  COLOR_ASSET_MAX_BYTES,
  COLOR_EXTRACT_MAX,
  COLOR_EXTRACT_MIN,
} from '@shared/tools/color/contract'
import type { PoeticColorInterpretation } from '@shared/tools/color/types'
import { Button, IconButton } from '../../../../components/primitives'
import { Slider } from '../../../../components/form'
import { Tooltip } from '../../../../components/overlay'
import { t, type MessageKey } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { colorApi } from '../api'
import { useColorStudioStore } from '../store'
import { AiPosterModal } from '../components/AiPosterModal'

// Pre-packaged SVG sample image for quick testing
const SAMPLE_IMAGE_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><defs><linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%23ff7e5f"/><stop offset="50%" stop-color="%23feb47b"/><stop offset="100%" stop-color="%2386a8e7"/></linearGradient><linearGradient id="g2" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="%232b5876"/><stop offset="100%" stop-color="%234e4376"/></linearGradient></defs><rect width="600" height="400" fill="url(%23g1)"/><circle cx="480" cy="120" r="80" fill="%23fbeeac" opacity="0.85"/><path d="M 0,280 Q 150,200 300,260 T 600,220 L 600,400 L 0,400 Z" fill="url(%23g2)"/><path d="M 0,330 Q 180,270 360,310 T 600,280 L 600,400 L 0,400 Z" fill="%231e3c72" opacity="0.9"/></svg>`

// The quantizer samples a histogram, not every pixel, so a larger bitmap buys nothing but decode time.
const EXTRACT_MAX_DIMENSION = 320

// The preview is held as a data URL in component state, so the picker stops where the server's asset
// endpoint stops instead of inventing a second ceiling.
const MAX_IMAGE_BYTES = COLOR_ASSET_MAX_BYTES

/** A refusal the panel can show: which message, and what it has to name to be useful. */
export interface ImageFileRejection {
  key: MessageKey
  params?: Record<string, string | number>
}

/**
 * Why a file cannot become an extraction source, or null when it can.
 *
 * `accept` is a filter the picker offers, not a check the app runs: a dragged-in file never passes through
 * it at all. An SVG stays allowed because the sample picture this panel ships is one, and a file handed to
 * `<img>` runs no scripts — the byte ceiling is what stops a pathological drawing.
 */
export function imageFileRejection(file: { type: string; size: number }): ImageFileRejection | null {
  if (!file.type.startsWith('image/')) return { key: 'tools.color.image.reject_not_image' }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      key: 'tools.color.image.reject_too_large',
      params: { max: Math.floor(MAX_IMAGE_BYTES / (1024 * 1024)) },
    }
  }
  return null
}

export function ImagePaletteView() {
  const [imageSrc, setImageSrc] = useState<string>(SAMPLE_IMAGE_SVG)
  const [maxColors, setMaxColors] = useState<number>(8)
  const [dominantColor, setDominantColor] = useState<string>('#ff7e5f')
  const [extractedPalette, setExtractedPalette] = useState<string[]>([])
  const [isExtracting, setIsExtracting] = useState<boolean>(false)
  const [isInterpreting, setIsInterpreting] = useState<boolean>(false)
  const [interpretations, setInterpretations] = useState<PoeticColorInterpretation[]>([])
  const [isPosterModalOpen, setIsPosterModalOpen] = useState<boolean>(false)
  const [isDragging, setIsDragging] = useState<boolean>(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // The decoded picture, keyed by source: the count slider used to re-decode a multi-megabyte file once
  // per step, and a slow decode of an earlier image could answer after a later one.
  const decodedRef = useRef<{ src: string; data: ImageData } | null>(null)
  const requestIdRef = useRef(0)

  const setCurrentHex = useColorStudioStore((s) => s.setCurrentHex)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const addFavorite = useColorStudioStore((s) => s.addFavorite)
  const savePalette = useColorStudioStore((s) => s.savePalette)
  const openExportPaletteModal = useColorStudioStore((s) => s.openExportPaletteModal)

  const decodeToPixels = async (src: string): Promise<ImageData | null> => {
    if (decodedRef.current?.src === src) return decodedRef.current.data

    const img = new Image()
    img.crossOrigin = 'anonymous'
    const loaded = await new Promise<HTMLImageElement | null>((resolve) => {
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = src
    })
    if (!loaded) return null

    const canvas = canvasRef.current || document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    // Constrain processing dimensions for performance
    const maxDim = EXTRACT_MAX_DIMENSION
    let w = img.naturalWidth || img.width
    let h = img.naturalHeight || img.height
    if (w > maxDim || h > maxDim) {
      if (w > h) {
        h = Math.round((h * maxDim) / w)
        w = maxDim
      } else {
        w = Math.round((w * maxDim) / h)
        h = maxDim
      }
    }

    canvas.width = w
    canvas.height = h
    ctx.drawImage(img, 0, 0, w, h)

    let data: ImageData
    try {
      data = ctx.getImageData(0, 0, w, h)
    } catch {
      // A picture from another origin taints the canvas; the sample and every local file do not.
      return null
    }
    decodedRef.current = { src, data }
    return data
  }

  const runExtraction = (src: string, colorCount: number) => {
    const requestId = ++requestIdRef.current
    setIsExtracting(true)
    void decodeToPixels(src).then((data) => {
      if (requestId !== requestIdRef.current) return
      if (!data) {
        setIsExtracting(false)
        useUi.getState().toast({ title: t('tools.color.toast.extract_failed'), tone: 'danger' })
        return
      }
      try {
        const result = extractPaletteFromPixels(data.data, colorCount)
        setDominantColor(result.dominant)
        setExtractedPalette(result.palette)
      } catch {
        useUi.getState().toast({ title: t('tools.color.toast.extract_failed'), tone: 'danger' })
      } finally {
        setIsExtracting(false)
      }
    })
  }

  const readImageFile = (file: File) => {
    const rejection = imageFileRejection(file)
    if (rejection) {
      useUi.getState().toast({ title: t(rejection.key, rejection.params), tone: 'danger' })
      return
    }
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result as string
      if (result) {
        setImageSrc(result)
        setInterpretations([])
      }
    }
    reader.onerror = () => {
      useUi.getState().toast({ title: t('tools.color.toast.extract_failed'), tone: 'danger' })
    }
    reader.readAsDataURL(file)
  }

  useEffect(() => {
    if (imageSrc) {
      runExtraction(imageSrc, maxColors)
    }
  }, [imageSrc, maxColors])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) readImageFile(file)
    // The same file picked twice must re-run: without the reset the change event never fires.
    e.target.value = ''
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) readImageFile(file)
  }

  const handleRequestInterpretations = async () => {
    const allColors = [dominantColor, ...extractedPalette]
    if (allColors.length === 0) return
    setIsInterpreting(true)
    try {
      const result = await colorApi.interpretColors(allColors)
      setInterpretations(result.items)
      useUi.getState().toast({
        title: result.degraded
          ? t('tools.color.image.ai_namer_fallback')
          : t('tools.color.toast.ai_success'),
        tone: result.degraded ? 'warning' : 'success',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.color.toast.ai_failed'),
        tone: 'danger',
      })
    } finally {
      setIsInterpreting(false)
    }
  }

  const handleSavePalette = async () => {
    const allColors = [dominantColor, ...extractedPalette]
    const items = allColors.map((hex) => {
      const found = interpretations.find((item) => item.hex.toLowerCase() === hex.toLowerCase())
      return {
        hex,
        name: found ? found.name : undefined,
      }
    })
    await savePalette(
      t('tools.color.image.palette_title'),
      items,
      'image',
      ['image-extract', 'palette'],
      t('tools.color.image.palette_desc'),
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6 space-y-6 bg-[var(--bg-base)]">
      {/* Hidden processing canvas */}
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

      {/* Header */}
      <div>
        <h2 className="text-[length:var(--text-18)] font-bold text-[var(--text-primary)]">
          {t('tools.color.image.title')}
        </h2>
        <p className="mt-1 text-[length:var(--text-13)] text-[var(--text-secondary)]">
          {t('tools.color.image.subtitle')}
        </p>
      </div>

      {/* Upload & Preview Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Image preview & drop zone */}
        <div className="lg:col-span-5 flex flex-col space-y-4">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative flex flex-col items-center justify-center min-h-[260px] max-h-[360px] overflow-hidden rounded-[var(--radius-lg)] border-2 border-dashed transition-colors ${
              isDragging
                ? 'border-[var(--accent)] bg-[var(--bg-raised)]'
                : 'border-[var(--border-subtle)] bg-[var(--bg-surface)]'
            }`}
          >
            {imageSrc ? (
              <div className="relative group flex h-full w-full items-center justify-center p-2">
                <img
                  src={imageSrc}
                  alt={t('tools.color.image.preview_alt')}
                  className="max-h-[320px] max-w-full rounded-[var(--radius-md)] object-contain shadow-xs"
                />
                <div className="absolute top-4 right-4 flex items-center gap-1.5 opacity-90 transition-opacity">
                  <Tooltip label={t('tools.color.image.change_image')}>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => fileInputRef.current?.click()}
                      className="shadow-sm"
                    >
                      <Upload size={14} className="mr-1" />
                      {t('tools.color.image.upload_prompt')}
                    </Button>
                  </Tooltip>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center p-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[var(--text-tertiary)] mb-3">
                  <ImageIcon size={24} />
                </div>
                <p className="text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">
                  {t('tools.color.image.upload_prompt')}
                </p>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-4"
                >
                  <Upload size={14} className="mr-1.5" />
                  {t('tools.color.image.upload_button')}
                </Button>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={handleFileChange}
              // Not `hidden`: a `display:none` input cannot open a picker in every engine, and the drop zone
              // above is the control the reader actually uses, so this stays out of the tab order and the tree.
              className="sr-only"
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>

          {/* Color count slider */}
          <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3">
            <span className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">
              {t('tools.color.image.extract_count')}: {maxColors}
            </span>
            <div className="flex items-center gap-3">
              <Slider
                value={maxColors}
                min={COLOR_EXTRACT_MIN}
                max={COLOR_EXTRACT_MAX}
                onChange={setMaxColors}
                label={t('tools.color.image.extract_count')}
                className="w-28"
              />
            </div>
          </div>
        </div>

        {/* Right: Extracted colors & actions */}
        <div className="lg:col-span-7 flex flex-col space-y-6">
          {/* Dominant color hero card */}
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--border-subtle)]">
              <span className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                {t('tools.color.image.dominant')}
              </span>
              <div className="flex items-center gap-1.5">
                <Tooltip label={t('tools.color.studio.seed_color')}>
                  <IconButton
                    size="sm"
                    label={t('tools.color.studio.seed_color')}
                    onClick={() => setCurrentHex(dominantColor, 'image')}
                  >
                    <Pipette size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label={t('tools.color.studio.copy')}>
                  <IconButton
                    size="sm"
                    label={t('tools.color.studio.copy')}
                    onClick={() => copyColor(dominantColor, t('tools.color.image.dominant_name'))}
                  >
                    <Copy size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label={t('tools.color.favorites.title')}>
                  <IconButton
                    size="sm"
                    label={t('tools.color.favorites.title')}
                    onClick={() => addFavorite(dominantColor, t('tools.color.image.dominant_favorite'))}
                  >
                    <Heart size={14} />
                  </IconButton>
                </Tooltip>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-4">
              <div
                className="h-16 w-24 shrink-0 rounded-[var(--radius-md)] border border-black/10 shadow-inner"
                style={{ backgroundColor: dominantColor }}
              />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[length:var(--text-18)] font-bold text-[var(--text-primary)] uppercase">
                  {dominantColor}
                </p>
                <p className="text-[length:var(--text-12)] text-[var(--text-secondary)] mt-0.5">
                  {t('tools.color.image.centroid_desc')}
                </p>
              </div>
            </div>
          </div>

          {/* Palette grid */}
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--border-subtle)]">
              <span className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                {t('tools.color.image.palette')} ({extractedPalette.length})
              </span>
              {/* Four labelled buttons: measured 494px inside a 372px card at 420px, so they wrap. */}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isInterpreting}
                  onClick={handleRequestInterpretations}
                >
                  {isInterpreting ? (
                    <Loader2 size={14} className="mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles size={14} className="mr-1.5 text-[var(--accent)]" />
                  )}
                  {t('tools.color.image.ai_namer')}
                </Button>
                <Button size="sm" variant="secondary" onClick={handleSavePalette}>
                  <Palette size={14} className="mr-1.5" />
                  {t('tools.color.create_palette.save')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={extractedPalette.length === 0}
                  onClick={() =>
                    openExportPaletteModal({
                      title: t('tools.color.image.export_title'),
                      colors: extractedPalette,
                    })
                  }
                >
                  <Download size={14} className="mr-1.5" />
                  {t('tools.color.export.title')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setIsPosterModalOpen(true)}
                >
                  <ImageIcon size={14} className="mr-1.5" />
                  {t('tools.color.image.generate_poster')}
                </Button>
              </div>
            </div>

            {isExtracting ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={24} className="animate-spin text-[var(--accent)]" />
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {extractedPalette.map((hex, index) => {
                  const interp = interpretations.find(
                    (item) => item.hex.toLowerCase() === hex.toLowerCase(),
                  )
                  return (
                    <div
                      key={`${hex}-${index}`}
                      className="group flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] transition-all hover:border-[var(--accent)]"
                    >
                      <button
                        type="button"
                        aria-label={t('tools.color.swatch.use', { hex })}
                        className="h-16 w-full cursor-pointer relative focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                        style={{ backgroundColor: hex }}
                        onClick={() => setCurrentHex(hex, 'image')}
                      >
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/60 transition-opacity">
                          <Pipette size={16} className="text-white drop-shadow-sm" />
                        </div>
                      </button>
                      <div className="p-2.5">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[length:var(--text-12)] font-semibold text-[var(--text-primary)] uppercase">
                            {hex}
                          </span>
                          <Tooltip label={t('tools.color.studio.copy')}>
                            <IconButton
                              size="xs"
                              label={t('tools.color.studio.copy')}
                              onClick={() => copyColor(hex)}
                            >
                              <Copy size={12} />
                            </IconButton>
                          </Tooltip>
                        </div>
                        {interp && (
                          <div className="mt-1">
                            <span className="text-[length:var(--text-12)] font-medium text-[var(--accent)]">
                              {interp.name}
                            </span>
                            {interp.story && (
                              <p className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)] mt-0.5">
                                {interp.story}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Wallpaper Poster Modal */}
      <AiPosterModal
        open={isPosterModalOpen}
        onClose={() => setIsPosterModalOpen(false)}
        imageSrc={imageSrc}
        colors={[dominantColor, ...extractedPalette]}
        interpretations={interpretations}
        themeTitle={t('tools.color.image.poster_theme')}
      />
    </div>
  )
}
