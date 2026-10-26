import { useEffect, useRef } from 'react'
import { AlertTriangle, Download, Info, Maximize2, QrCode, Upload } from 'lucide-react'
import { useQrCodeStore } from '../store'
import { QrEngine } from '../engine/qr-engine'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'

export function QrPreviewPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const getEncodedPayload = useQrCodeStore((s) => s.getEncodedPayload)
  const options = useQrCodeStore((s) => s.options)
  const setOptions = useQrCodeStore((s) => s.setOptions)
  const setInfoModalOpen = useQrCodeStore((s) => s.setInfoModalOpen)
  const setFullscreenModalOpen = useQrCodeStore((s) => s.setFullscreenModalOpen)

  const payload = getEncodedPayload()
  const hasContent = Boolean(payload.trim())

  const tk = options.toolkitOptions ?? {}
  const mayNotScannable = Boolean(
    (tk.marginNoise && tk.marginNoiseSpace === 'none') ||
      (tk.effect === 'crystalize' && (tk.effectCrystalizeRadius ?? 0) > 12) ||
      (tk.effect === 'liquidify' && (tk.effectLiquidifyRadius ?? 0) > 12) ||
      Math.abs(tk.transformPerspectiveX ?? 0) > 0.15 ||
      Math.abs(tk.transformPerspectiveY ?? 0) > 0.15 ||
      (tk.renderPointsType && tk.renderPointsType !== 'all')
  )

  const handleDownloadState = () => {
    const data = {
      source: 'inkstone-qrcode',
      version: '1.0',
      options,
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `qr-config-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleUploadState = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string)
        if (parsed.options) {
          setOptions(parsed.options)
        } else {
          setOptions(parsed)
        }
      } catch {
        // Safe fallback
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  useEffect(() => {
    if (!hasContent || !containerRef.current) return

    const engine = new QrEngine(options, payload)
    let isMounted = true

    engine.renderCanvas(320, 320).then((canvas) => {
      if (isMounted && containerRef.current) {
        containerRef.current.innerHTML = ''
        canvas.style.maxWidth = '100%'
        canvas.style.height = 'auto'
        containerRef.current.appendChild(canvas)
      }
    })

    return () => {
      isMounted = false
    }
  }, [hasContent, payload, options])

  return (
    <div className="relative flex flex-col items-center justify-center rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 shadow-sm min-h-[360px]">
      <div className="absolute right-3 top-3 flex items-center gap-1">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          onChange={handleUploadState}
          className="hidden"
        />
        <Tooltip label={t('tools.qrcode.preview.import_json')}>
          <IconButton
            size="sm"
            label={t('tools.qrcode.preview.import_json')}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('tools.qrcode.preview.export_json')}>
          <IconButton
            size="sm"
            label={t('tools.qrcode.preview.export_json')}
            onClick={handleDownloadState}
          >
            <Download size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('tools.qrcode.preview.fullscreen')}>
          <IconButton
            size="sm"
            label={t('tools.qrcode.preview.fullscreen')}
            onClick={() => setFullscreenModalOpen(true)}
            disabled={!hasContent}
          >
            <Maximize2 size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('tools.qrcode.preview.info')}>
          <IconButton
            size="sm"
            label={t('tools.qrcode.preview.info')}
            onClick={() => setInfoModalOpen(true)}
          >
            <Info size={15} />
          </IconButton>
        </Tooltip>
      </div>

      {hasContent ? (
        <div className="flex w-full flex-col items-center gap-3">
          <div
            ref={containerRef}
            data-testid="qrcode-preview-canvas-container"
            className="flex min-h-[240px] md:min-h-[280px] w-full items-center justify-center rounded-[var(--r-md)] bg-white p-3 md:p-4 shadow-xs"
          />

          {mayNotScannable && (
            <div className="flex w-full items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle size={14} className="shrink-0" />
              <span>{t('tools.qrcode.preview.scannable_warning')}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 text-center py-10 md:py-12">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[var(--text-tertiary)]">
            <QrCode size={32} />
          </div>
          <p className="text-[length:var(--text-14)] font-medium text-[var(--text-secondary)]">
            {t('tools.qrcode.preview.empty_placeholder')}
          </p>
        </div>
      )}
    </div>
  )
}
