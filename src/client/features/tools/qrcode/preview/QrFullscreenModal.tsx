import { useEffect, useRef, useState } from 'react'
import { useQrCodeStore, useQrPayload } from '../store'
import { QrEngine } from '../engine/qr-engine'
import { Modal } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'

const FULLSCREEN_SIZE = 480
const MAX_DPR = 2

export function QrFullscreenModal() {
  const isOpen = useQrCodeStore((s) => s.fullscreenModalOpen)
  const setOpen = useQrCodeStore((s) => s.setFullscreenModalOpen)
  const options = useQrCodeStore((s) => s.options)
  const payload = useQrPayload()
  const [failed, setFailed] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!isOpen || !container || !payload.trim()) return

    let stale = false
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    const engine = new QrEngine(options, payload)

    engine.renderCanvas(FULLSCREEN_SIZE * dpr, FULLSCREEN_SIZE * dpr).then((canvas) => {
      if (stale) return
      canvas.style.width = `${FULLSCREEN_SIZE}px`
      canvas.style.maxWidth = '100%'
      canvas.style.height = 'auto'
      canvas.setAttribute('role', 'img')
      canvas.setAttribute('aria-label', t('tools.qrcode.preview.canvas_label'))
      container.replaceChildren(canvas)
      setFailed(false)
    }).catch(() => {
      if (stale) return
      container.replaceChildren()
      setFailed(true)
    })

    return () => {
      stale = true
    }
  }, [isOpen, options, payload])

  return (
    <Modal
      open={isOpen}
      onClose={() => setOpen(false)}
      title={t('tools.qrcode.fullscreen.modal_title')}
      width={540}
    >
      <div className="flex flex-col items-center justify-center p-6">
        {failed && (
          <p role="alert" className="mb-3 text-[length:var(--text-12)] text-[var(--danger)]">
            {t('tools.qrcode.preview.render_error')}
          </p>
        )}
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
