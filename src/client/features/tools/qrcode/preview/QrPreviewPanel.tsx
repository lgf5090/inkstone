import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Download, Info, Maximize2, QrCode, Upload } from 'lucide-react'
import { useQrCodeStore, useQrPayload } from '../store'
import { QrEngine } from '../engine/qr-engine'
import { assessScannability, decodeRenderedCode, type DecodeCheck } from '../engine/scannability'
import { saveBlobAsFile } from '../engine/export-pipeline'
import { parseQrStylingOptions } from '../../../../../shared/tools/qrcode/schemas'
import { Button, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { t } from '../../../../lib/i18n'

const PREVIEW_SIZE = 320
// Past 2× the extra backing-store pixels are not visible, and a 4K canvas per keystroke is not free.
const PREVIEW_MAX_DPR = 2

export function QrPreviewPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const options = useQrCodeStore((s) => s.options)
  const setOptions = useQrCodeStore((s) => s.setOptions)
  const setInfoModalOpen = useQrCodeStore((s) => s.setInfoModalOpen)
  const setFullscreenModalOpen = useQrCodeStore((s) => s.setFullscreenModalOpen)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const [decode, setDecode] = useState<DecodeCheck>('unknown')
  const exportSize = useQrCodeStore((s) => s.exportSize)

  const payload = useQrPayload()
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
    saveBlobAsFile(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      `qr-config-${Date.now()}.json`
    )
  }

  const handleUploadState = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string)
        const validated = parseQrStylingOptions(parsed && parsed.options ? parsed.options : parsed)
        if (!validated) {
          useUi.getState().toast({ title: t('tools.qrcode.preview.import_error'), tone: 'danger' })
          return
        }
        setOptions(validated)
      } catch {
        useUi.getState().toast({ title: t('tools.qrcode.preview.import_error'), tone: 'danger' })
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  useEffect(() => {
    const container = containerRef.current
    if (!hasContent) {
      container?.replaceChildren()
      setRenderError(null)
      return
    }
    if (!container) return

    // A superseded render must not paint over a newer one: the cleanup below marks every in-flight
    // promise stale, which is what keeps a slow 2000px effect from resurrecting an old payload.
    let stale = false
    setRendering(true)
    const dpr = Math.min(window.devicePixelRatio || 1, PREVIEW_MAX_DPR)
    const engine = new QrEngine(options, payload)

    engine.renderCanvas(PREVIEW_SIZE * dpr, PREVIEW_SIZE * dpr).then((canvas) => {
      if (stale) return
      canvas.style.width = `${PREVIEW_SIZE}px`
      canvas.style.maxWidth = '100%'
      canvas.style.height = 'auto'
      canvas.setAttribute('role', 'img')
      canvas.setAttribute('aria-label', t('tools.qrcode.preview.canvas_label'))
      container.replaceChildren(canvas)
      // The verdict is measured on what was actually drawn; where pixels cannot be read the
      // helper answers unknown and the strip stays quiet rather than guessing.
      setDecode(decodeRenderedCode(canvas))
      setRenderError(null)
    }).catch((err: unknown) => {
      if (stale) return
      container.replaceChildren()
      setRenderError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      if (!stale) setRendering(false)
    })

    return () => {
      stale = true
    }
  }, [hasContent, payload, options, retryToken])

  const report = useMemo(
    () => assessScannability(options, payload, exportSize),
    [options, payload, exportSize]
  )

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
            aria-busy={rendering}
            className="flex min-h-[240px] md:min-h-[280px] w-full items-center justify-center rounded-[var(--r-md)] bg-white p-3 md:p-4 shadow-xs"
          />

          {renderError && (
            <div
              role="alert"
              className="flex w-full items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2"
            >
              <AlertTriangle size={14} className="shrink-0 text-[var(--danger)]" />
              <span className="flex-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">
                {t('tools.qrcode.preview.render_error')}
              </span>
              <Button variant="secondary" size="sm" onClick={() => setRetryToken((n) => n + 1)}>
                {t('tools.qrcode.preview.retry')}
              </Button>
            </div>
          )}

          {(decode === 'unreadable' || mayNotScannable || report.issues.length > 0) && (
            <div
              role="status"
              className="flex w-full items-center gap-2 rounded-[var(--r-md)] border border-warning/30 bg-warning/10 px-3 py-2 text-[length:var(--text-12)] text-warning"
            >
              <AlertTriangle size={14} className="shrink-0" />
              <span className="flex-1">
                {decode === 'unreadable'
                  ? t('tools.qrcode.check.unreadable')
                  : mayNotScannable
                    ? t('tools.qrcode.preview.scannable_warning')
                    : t('tools.qrcode.preview.has_issues')}
              </span>
              <Button variant="secondary" size="sm" onClick={() => setInfoModalOpen(true)}>
                {t('tools.qrcode.preview.view_checks')}
              </Button>
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
