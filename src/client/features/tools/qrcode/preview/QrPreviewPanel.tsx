import { useEffect, useRef } from 'react'
import { Info, Maximize2, QrCode } from 'lucide-react'
import { useQrCodeStore } from '../store'
import { QrEngine } from '../engine/qr-engine'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { QrInfoModal } from './QrInfoModal'
import { QrFullscreenModal } from './QrFullscreenModal'

export function QrPreviewPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const getEncodedPayload = useQrCodeStore((s) => s.getEncodedPayload)
  const options = useQrCodeStore((s) => s.options)
  const setInfoModalOpen = useQrCodeStore((s) => s.setInfoModalOpen)
  const setFullscreenModalOpen = useQrCodeStore((s) => s.setFullscreenModalOpen)

  const payload = getEncodedPayload()
  const hasContent = Boolean(payload.trim())

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
        <div
          ref={containerRef}
          data-testid="qrcode-preview-canvas-container"
          className="flex min-h-[280px] w-full items-center justify-center rounded-[var(--r-md)] bg-white p-4 shadow-xs"
        />
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 text-center py-12">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
            <QrCode size={32} />
          </div>
          <p className="text-[length:var(--text-14)] font-medium text-[var(--text-secondary)]">
            {t('tools.qrcode.preview.empty_placeholder')}
          </p>
        </div>
      )}

      <QrInfoModal />
      <QrFullscreenModal />
    </div>
  )
}
