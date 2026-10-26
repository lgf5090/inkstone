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
import type { PoeticColorInterpretation } from '@shared/tools/color/types'
import { Button, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { colorApi } from '../api'
import { useColorStudioStore } from '../store'
import { AiPosterModal } from '../components/AiPosterModal'

// Pre-packaged SVG sample image for quick testing
const SAMPLE_IMAGE_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><defs><linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%23ff7e5f"/><stop offset="50%" stop-color="%23feb47b"/><stop offset="100%" stop-color="%2386a8e7"/></linearGradient><linearGradient id="g2" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="%232b5876"/><stop offset="100%" stop-color="%234e4376"/></linearGradient></defs><rect width="600" height="400" fill="url(%23g1)"/><circle cx="480" cy="120" r="80" fill="%23fbeeac" opacity="0.85"/><path d="M 0,280 Q 150,200 300,260 T 600,220 L 600,400 L 0,400 Z" fill="url(%23g2)"/><path d="M 0,330 Q 180,270 360,310 T 600,280 L 600,400 L 0,400 Z" fill="%231e3c72" opacity="0.9"/></svg>`

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

  const setCurrentHex = useColorStudioStore((s) => s.setCurrentHex)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const addFavorite = useColorStudioStore((s) => s.addFavorite)
  const savePalette = useColorStudioStore((s) => s.savePalette)
  const openExportPaletteModal = useColorStudioStore((s) => s.openExportPaletteModal)

  const processImage = (src: string, colorCount: number) => {
    setIsExtracting(true)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = canvasRef.current || document.createElement('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        setIsExtracting(false)
        return
      }

      // Constrain processing dimensions for performance
      const maxDim = 320
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

      try {
        const imageData = ctx.getImageData(0, 0, w, h)
        const result = extractPaletteFromPixels(imageData.data, colorCount)
        setDominantColor(result.dominant)
        setExtractedPalette(result.palette)
      } catch {
        useUi.getState().toast({
          title: t('tools.color.toast.copy_failed'),
          tone: 'danger',
        })
      } finally {
        setIsExtracting(false)
      }
    }
    img.onerror = () => {
      setIsExtracting(false)
    }
    img.src = src
  }

  useEffect(() => {
    if (imageSrc) {
      processImage(imageSrc, maxColors)
    }
  }, [imageSrc, maxColors])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result as string
      if (result) {
        setImageSrc(result)
        setInterpretations([])
      }
    }
    reader.readAsDataURL(file)
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
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (event) => {
        const result = event.target?.result as string
        if (result) {
          setImageSrc(result)
          setInterpretations([])
        }
      }
      reader.readAsDataURL(file)
    }
  }

  const handleRequestInterpretations = async () => {
    const allColors = [dominantColor, ...extractedPalette]
    if (allColors.length === 0) return
    setIsInterpreting(true)
    try {
      const results = await colorApi.interpretColors(allColors)
      setInterpretations(results)
      useUi.getState().toast({
        title: t('tools.color.toast.ai_success'),
        tone: 'success',
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
      'Image Palette',
      items,
      'image',
      ['image-extract', 'palette'],
      'Extracted palette from uploaded image',
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
                ? 'border-[var(--brand-primary)] bg-[var(--bg-elevated)]'
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
              className="hidden"
            />
          </div>

          {/* Color count slider */}
          <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3">
            <span className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">
              {t('tools.color.image.extract_count')}: {maxColors}
            </span>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={3}
                max={12}
                step={1}
                value={maxColors}
                onChange={(e) => setMaxColors(Number(e.target.value))}
                className="h-1.5 w-28 cursor-pointer rounded-lg bg-[var(--border-subtle)] accent-[var(--brand-primary)]"
              />
            </div>
          </div>
        </div>

        {/* Right: Extracted colors & actions */}
        <div className="lg:col-span-7 flex flex-col space-y-6">
          {/* Dominant color hero card */}
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-xs">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
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
                    onClick={() => copyColor(dominantColor, 'Dominant')}
                  >
                    <Copy size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label={t('tools.color.favorites.title')}>
                  <IconButton
                    size="sm"
                    label={t('tools.color.favorites.title')}
                    onClick={() => addFavorite(dominantColor, 'Dominant Color')}
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
            <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
              <span className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                {t('tools.color.image.palette')} ({extractedPalette.length})
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isInterpreting}
                  onClick={handleRequestInterpretations}
                >
                  {isInterpreting ? (
                    <Loader2 size={14} className="mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles size={14} className="mr-1.5 text-[var(--brand-primary)]" />
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
                      title: 'Image Extracted Palette',
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
                <Loader2 size={24} className="animate-spin text-[var(--brand-primary)]" />
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
                      className="group flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] transition-all hover:border-[var(--brand-primary)]"
                    >
                      <button
                        type="button"
                        aria-label={`Select ${hex}`}
                        className="h-16 w-full cursor-pointer relative focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]"
                        style={{ backgroundColor: hex }}
                        onClick={() => setCurrentHex(hex, 'image')}
                      >
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/20 transition-opacity">
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
                            <span className="text-[length:var(--text-12)] font-medium text-[var(--brand-primary)]">
                              {interp.name}
                            </span>
                            <p className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)] mt-0.5">
                              {interp.story}
                            </p>
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
        themeTitle="Aesthetic Essence"
      />
    </div>
  )
}
