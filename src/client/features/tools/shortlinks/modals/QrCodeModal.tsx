import { useRef, useState } from 'react'
import { Copy, Download, Image as ImageIcon } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { Segmented } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { useUiStore } from '../../../../lib/ui-store'
import { useShortlinksStore } from '../store'
import {
  copyQrImageToClipboard,
  downloadQrPng,
  downloadQrSvg,
  qrFileName,
} from '../../../share/detail/qr-export'
import { copyShortlinkText } from '../copy'

export function QrCodeModal() {
  const open = useShortlinksStore((s) => s.qrModalOpen)
  const link = useShortlinksStore((s) => s.qrLink)
  const closeQrModal = useShortlinksStore((s) => s.closeQrModal)

  const [size, setSize] = useState<number>(240)
  const plateRef = useRef<HTMLDivElement>(null)

  if (!link) return null

  const primarySlug = link.slugs.find((s) => s.is_primary)?.slug || link.slugs[0]?.slug || ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const shortUrl = `${origin}/l/${primarySlug}?utm_medium=qr`

  const svgOf = () => plateRef.current?.querySelector('svg') ?? null

  const requireSvg = (): SVGSVGElement | null => {
    const svg = svgOf()
    if (!svg) useUiStore.getState().toast(t('common.action_failed'), 'error')
    return svg
  }

  const handleCopyUrl = async () => {
    await copyShortlinkText(shortUrl)
  }

  const handleCopyImage = async () => {
    const svg = requireSvg()
    if (!svg) return
    const success = await copyQrImageToClipboard(svg, 800)
    if (success) {
      useUiStore.getState().toast(t('tools.shortlinks.links.copied'), 'success')
    } else {
      useUiStore.getState().toast(t('common.action_failed'), 'error')
    }
  }

  const handleDownloadPng = async () => {
    const svg = requireSvg()
    if (!svg) return
    const name = qrFileName(link.label || primarySlug, 'png')
    await downloadQrPng(svg, name, size * 4)
  }

  const handleDownloadSvg = () => {
    const svg = requireSvg()
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
          <Segmented
            size="sm"
            value={String(size) as '200' | '240' | '300'}
            label={t('tools.shortlinks.modal.qr_size')}
            onChange={(next) => setSize(Number(next))}
            options={[
              { value: '200', label: '200' },
              { value: '240', label: '240' },
              { value: '300', label: '300' },
            ]}
          />
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
          className="rounded-[var(--r-lg)] p-4 bg-white shadow-sm border border-[var(--border-subtle)] flex items-center justify-center"
        >
          <QRCodeSVG
            value={shortUrl}
            size={size}
            level="M"
            bgColor="#ffffff"
            fgColor="#000000"
            marginSize={2}
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
