import { useEffect, useRef } from 'react'
import { useQrCodeStore } from '../store'
import { QrEngine } from '../engine/qr-engine'
import { Modal } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'

export function QrFullscreenModal() {
  const isOpen = useQrCodeStore((s) => s.fullscreenModalOpen)
  const setOpen = useQrCodeStore((s) => s.setFullscreenModalOpen)
  const options = useQrCodeStore((s) => s.options)
  const getEncodedPayload = useQrCodeStore((s) => s.getEncodedPayload)

  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen || !containerRef.current) return

    const payload = getEncodedPayload() || ' '
    const engine = new QrEngine(options, payload)

    let mounted = true
    engine.renderCanvas(480, 480).then((canvas) => {
      if (mounted && containerRef.current) {
        containerRef.current.innerHTML = ''
        canvas.style.maxWidth = '100%'
        canvas.style.height = 'auto'
        containerRef.current.appendChild(canvas)
      }
    })

    return () => {
      mounted = false
    }
  }, [isOpen, options, getEncodedPayload])

  return (
    <Modal
      open={isOpen}
      onClose={() => setOpen(false)}
      title={t('tools.qrcode.fullscreen.modal_title')}
      width={540}
    >
      <div className="flex flex-col items-center justify-center p-6">
        <div
          ref={containerRef}
          className="flex min-h-[300px] w-full items-center justify-center rounded-[var(--r-lg)] bg-white p-4 shadow-sm"
        />
        <p className="mt-4 text-center text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {t('tools.qrcode.fullscreen.scan_hint')}
        </p>
      </div>
    </Modal>
  )
}
