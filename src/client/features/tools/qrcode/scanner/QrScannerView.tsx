import React, { useEffect, useRef, useState } from 'react'
import {
  Camera,
  Check,
  Compass,
  Copy,
  FileImage,
  RotateCcw,
  ScanLine,
  Sliders,
  Sparkles,
  Upload,
} from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { useQrCodeStore } from '../store'
import { CameraScanner } from './CameraScanner'
import {
  preprocessImageToCanvas,
  scanCanvas,
  type PreprocessOptions,
  type ScanResult,
} from './scan-pipeline'

export const QrScannerView: React.FC = () => {
  const [mode, setMode] = useState<'file' | 'camera'>('file')
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>(null)
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [isScanning, setIsScanning] = useState<boolean>(false)
  const [copied, setCopied] = useState<boolean>(false)

  const [preprocessOpts, setPreprocessOpts] = useState<PreprocessOptions>({
    contrast: 100,
    brightness: 100,
    blur: 0,
    grayscale: false,
    resize: 1000,
  })

  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const setActiveView = useQrCodeStore((s) => s.setActiveView)
  const setTextContent = useQrCodeStore((s) => s.setTextContent)
  const setContentType = useQrCodeStore((s) => s.setContentType)

  // Paste image from clipboard
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            const url = URL.createObjectURL(file)
            setUploadedImageUrl(url)
            setMode('file')
          }
        }
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [])

  // Process and scan image
  useEffect(() => {
    if (!uploadedImageUrl) {
      setScanResult(null)
      return
    }

    let isMounted = true
    setIsScanning(true)

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = uploadedImageUrl
    img.onload = async () => {
      if (!isMounted) return
      const processedCanvas = preprocessImageToCanvas(img, preprocessOpts)
      const res = await scanCanvas(processedCanvas)

      if (isMounted) {
        setScanResult(res)
        setIsScanning(false)

        // Draw preview with bounding box if detected
        const displayCanvas = previewCanvasRef.current
        if (displayCanvas) {
          displayCanvas.width = processedCanvas.width
          displayCanvas.height = processedCanvas.height
          const ctx = displayCanvas.getContext('2d')!
          ctx.drawImage(processedCanvas, 0, 0)

          if (res?.location) {
            const loc = res.location
            ctx.strokeStyle = '#22c55e'
            ctx.lineWidth = 4
            ctx.beginPath()
            ctx.moveTo(loc.topLeft.x, loc.topLeft.y)
            ctx.lineTo(loc.topRight.x, loc.topRight.y)
            ctx.lineTo(loc.bottomRight.x, loc.bottomRight.y)
            ctx.lineTo(loc.bottomLeft.x, loc.bottomLeft.y)
            ctx.closePath()
            ctx.stroke()

            ctx.fillStyle = 'rgba(34, 197, 94, 0.2)'
            ctx.fill()
          }
        }
      }
    }

    return () => {
      isMounted = false
    }
  }, [uploadedImageUrl, preprocessOpts])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const url = URL.createObjectURL(file)
      setUploadedImageUrl(url)
    }
  }

  const handleCopy = () => {
    if (!scanResult?.text) return
    navigator.clipboard.writeText(scanResult.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleSendToGenerator = () => {
    if (!scanResult?.text) return
    const text = scanResult.text
    if (/^https?:\/\//i.test(text)) {
      setContentType('url')
      useQrCodeStore.getState().setUrlContent(text)
    } else {
      setContentType('text')
      setTextContent(text)
    }
    setActiveView('generator')
  }

  const handleSendToCompare = () => {
    setActiveView('compare' as any)
  }

  const resetFilters = () => {
    setPreprocessOpts({
      contrast: 100,
      brightness: 100,
      blur: 0,
      grayscale: false,
      resize: 1000,
    })
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        {/* Header with Mode Switcher */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-[var(--border-subtle)] pb-4">
          <div>
            <h2 className="text-xl font-bold text-[var(--text-primary)]">
              {t('tools.qrcode.scanner.title')}
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              {t('tools.qrcode.scanner.subtitle')}
            </p>
          </div>

          <div className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-1">
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === 'file'
                  ? 'bg-[var(--accent)] text-white shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <FileImage size={14} />
              <span>{t('tools.qrcode.scanner.mode_file')}</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('camera')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === 'camera'
                  ? 'bg-[var(--accent)] text-white shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Camera size={14} />
              <span>{t('tools.qrcode.scanner.mode_camera')}</span>
            </button>
          </div>
        </div>

        {mode === 'camera' ? (
          <div className="space-y-6">
            <CameraScanner
              onScan={(res) => setScanResult(res)}
              preprocessOptions={preprocessOpts}
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Left: Upload and Viewport */}
            <div className="space-y-4 lg:col-span-7">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />

              {!uploadedImageUrl ? (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="flex min-h-[300px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-6 text-center transition-all hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]"
                >
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
                    <Upload size={28} />
                  </div>
                  <h3 className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
                    {t('tools.qrcode.scanner.upload_prompt')}
                  </h3>
                  <p className="mt-1 text-xs text-[var(--text-tertiary)] max-w-sm">
                    {t('tools.qrcode.scanner.paste_hint')}
                  </p>
                </div>
              ) : (
                <div className="relative flex flex-col items-center overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
                  <canvas
                    ref={previewCanvasRef}
                    className="max-h-[420px] w-auto max-w-full rounded-lg object-contain shadow-xs"
                  />
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    >
                      <Upload size={13} />
                      <span>{t('tools.qrcode.scanner.change_image')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setUploadedImageUrl(null)}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/20"
                    >
                      <span>{t('tools.qrcode.scanner.clear_image')}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Preprocessing Sliders */}
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sliders size={15} className="text-[var(--accent)]" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
                      {t('tools.qrcode.scanner.preprocess_title')}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    title={t('tools.qrcode.scanner.reset_filters')}
                  >
                    <RotateCcw size={12} />
                    <span>{t('tools.qrcode.scanner.reset_filters')}</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-[var(--text-tertiary)]">
                      <span>{t('tools.qrcode.scanner.contrast')}</span>
                      <span>{preprocessOpts.contrast}%</span>
                    </div>
                    <input
                      type="range"
                      min={50}
                      max={200}
                      value={preprocessOpts.contrast}
                      onChange={(e) =>
                        setPreprocessOpts((prev) => ({ ...prev, contrast: Number(e.target.value) }))
                      }
                      className="h-1.5 w-full cursor-pointer accent-[var(--accent)]"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-[var(--text-tertiary)]">
                      <span>{t('tools.qrcode.scanner.brightness')}</span>
                      <span>{preprocessOpts.brightness}%</span>
                    </div>
                    <input
                      type="range"
                      min={50}
                      max={200}
                      value={preprocessOpts.brightness}
                      onChange={(e) =>
                        setPreprocessOpts((prev) => ({ ...prev, brightness: Number(e.target.value) }))
                      }
                      className="h-1.5 w-full cursor-pointer accent-[var(--accent)]"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-[var(--text-tertiary)]">
                      <span>{t('tools.qrcode.scanner.blur')}</span>
                      <span>{`${preprocessOpts.blur}px`}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={8}
                      step={0.5}
                      value={preprocessOpts.blur}
                      onChange={(e) =>
                        setPreprocessOpts((prev) => ({ ...prev, blur: Number(e.target.value) }))
                      }
                      className="h-1.5 w-full cursor-pointer accent-[var(--accent)]"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      checked={Boolean(preprocessOpts.grayscale)}
                      onChange={(e) =>
                        setPreprocessOpts((prev) => ({ ...prev, grayscale: e.target.checked }))
                      }
                      className="rounded accent-[var(--accent)]"
                    />
                    <span>{t('tools.qrcode.scanner.grayscale')}</span>
                  </label>
                </div>
              </div>
            </div>

            {/* Right: Results Card */}
            <div className="space-y-4 lg:col-span-5">
              <div className="flex flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
                  <div className="flex items-center gap-2">
                    <ScanLine size={18} className="text-[var(--accent)]" />
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                      {t('tools.qrcode.scanner.result_title')}
                    </h3>
                  </div>
                  {scanResult && (
                    <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[length:var(--text-11)] font-mono text-green-600 dark:text-green-400">
                      {`${scanResult.durationMs}ms`}
                    </span>
                  )}
                </div>

                {isScanning ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-[var(--text-tertiary)]">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
                    <p className="mt-2">{t('tools.qrcode.scanner.scanning_in_progress')}</p>
                  </div>
                ) : scanResult ? (
                  <div className="space-y-4">
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3.5">
                      <p className="break-all font-mono text-xs text-[var(--text-primary)] leading-relaxed select-all max-h-48 overflow-y-auto">
                        {scanResult.text}
                      </p>
                    </div>

                    <div className="grid grid-cols-1 gap-2">
                      <button
                        type="button"
                        onClick={handleCopy}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      >
                        {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                        <span>{copied ? t('tools.qrcode.export.copied') : t('tools.qrcode.scanner.copy_result')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleSendToGenerator}
                        className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] py-2 text-xs font-medium text-white shadow-xs hover:opacity-95"
                      >
                        <Sparkles size={14} />
                        <span>{t('tools.qrcode.scanner.send_to_generator')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleSendToCompare}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      >
                        <Compass size={14} />
                        <span>{t('tools.qrcode.scanner.send_to_compare')}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-[var(--text-tertiary)]">
                    <ScanLine size={32} className="mb-2 opacity-40" />
                    <p>{t('tools.qrcode.scanner.no_result')}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
