import { useRef, useState } from 'react'
import { Copy, Download, Image as ImageIcon } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { copyText } from '../../../../lib/clipboard'
import { useUiStore } from '../../../../lib/ui-store'
import { useShortlinksStore } from '../store'
import {
  copyQrImageToClipboard,
  downloadQrPng,
  downloadQrSvg,
  qrFileName,
} from '../../../share/detail/qr-export'

export function QrCodeModal() {
  const open = useShortlinksStore((s) => s.qrModalOpen)
  const link = useShortlinksStore((s) => s.qrLink)
  const closeQrModal = useShortlinksStore((s) => s.closeQrModal)

  const [size, setSize] = useState<number>(240)
  const plateRef = useRef<HTMLDivElement>(null)

  if (!link) return null

  const primarySlug = link.slugs.find((s) => s.is_primary)?.slug || link.slugs[0]?.slug || ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const shortUrl = `${origin}/l/${primarySlug}`

  const svgOf = () => plateRef.current?.querySelector('svg') ?? null

  const handleCopyUrl = async () => {
    const success = await copyText(shortUrl)
    if (success) {
      useUiStore.getState().toast(t('tools.shortlinks.links.copied'), 'success')
    }
  }

  const handleCopyImage = async () => {
    const svg = svgOf()
    if (!svg) return
    const success = await copyQrImageToClipboard(svg, 800)
    if (success) {
      useUiStore.getState().toast(t('tools.shortlinks.links.copied'), 'success')
    } else {
      useUiStore.getState().toast(t('common.action_failed'), 'error')
    }
  }

  const handleDownloadPng = async () => {
    const svg = svgOf()
    if (!svg) return
    const name = qrFileName(link.label || primarySlug, 'png')
    await downloadQrPng(svg, name, 800)
  }

  const handleDownloadSvg = () => {
    const svg = svgOf()
    if (!svg) return
    const name = qrFileName(link.label || primarySlug, 'svg')
    downloadQrSvg(svg, name)
  }

  return (
    <Modal
      open={open}
      onClose={closeQrModal}
      title={t('tools.shortlinks.modal.qr_title')}
      width={440}
      footer={
        <div className="flex w-full items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.modal.qr_size')}:
            </span>
            {[200, 240, 300].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSize(s)}
                className={`rounded px-1.5 py-0.5 text-[length:var(--text-11)] font-medium ${
                  size === s
                    ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <Button variant="ghost" onClick={closeQrModal}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col items-center py-4 space-y-4">
        {/* QR Plate with white background for readability */}
        <div
          ref={plateRef}
          className="rounded-xl p-4 bg-white shadow-sm border border-[var(--border-subtle)] flex items-center justify-center"
        >
          <QRCodeSVG
            value={shortUrl}
            size={size}
            level="M"
            bgColor="#ffffff"
            fgColor="#000000"
            includeMargin
          />
        </div>

        {/* Short URL text */}
        <div className="flex items-center gap-2 max-w-full px-2">
          <span className="font-mono text-[length:var(--text-12)] text-[var(--text-primary)] truncate">
            {shortUrl}
          </span>
          <button
            type="button"
            onClick={handleCopyUrl}
            className="rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)]"
            title={t('tools.shortlinks.links.copy_shortlink')}
          >
            <Copy size={14} />
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={handleCopyImage}>
            <ImageIcon size={14} className="mr-1" />
            {t('tools.shortlinks.modal.qr_copy')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleDownloadPng}>
            <Download size={14} className="mr-1" />
            {t('tools.shortlinks.modal.qr_download')} {'PNG'}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleDownloadSvg}>
            <Download size={14} className="mr-1" />
            {t('tools.shortlinks.modal.qr_download')} {'SVG'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
