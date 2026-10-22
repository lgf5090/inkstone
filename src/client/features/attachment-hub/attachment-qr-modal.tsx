import { useState } from 'react'
import { Check, Copy, ExternalLink, QrCode } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { t } from '../../lib/i18n'
import { copyText } from '../../lib/clipboard'
import { useUi } from '../../store/ui'
import { QR_BG_COLOR, QR_FG_COLOR } from './qr-colors'

const MODAL_WIDTH = 400
const COPY_FEEDBACK_MS = 1600

interface AttachmentQrModalProps {
  open: boolean
  onClose: () => void
  url: string
  filename: string
}

export function AttachmentQrModal(props: AttachmentQrModalProps) {
  const { open, onClose, url, filename } = props
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={(
        <div className='flex items-center gap-[var(--sp-2)]'>
          <QrCode size={16} className='text-[var(--accent)]' />
          <span>{t('attachments.qr_code_title')}</span>
        </div>
      )}
      description={filename}
      width={MODAL_WIDTH}
    >
      <QrContent url={url} />
    </Modal>
  )
}

function QrContent({ url }: { url: string }) {
  const [isCopied, setIsCopied] = useState(false)
  const toast = useUi((state) => state.toast)
  const fullUrl = new URL(url, window.location.origin).href

  const handleCopy = async () => {
    if (await copyText(fullUrl)) {
      setIsCopied(true)
      window.setTimeout(() => setIsCopied(false), COPY_FEEDBACK_MS)
      return
    }
    toast({ title: t('preview.could_not_copy'), tone: 'danger' })
  }

  return (
    <div className='flex flex-col items-center gap-[var(--sp-4)] py-[var(--sp-3)]'>
      <div className='rounded-[var(--r-xl)] border border-[var(--border-default)] bg-white p-[var(--sp-3)] shadow-[var(--shadow-soft)]'>
        <QRCodeSVG
          value={fullUrl}
          size={200}
          level='M'
          marginSize={1}
          bgColor={QR_BG_COLOR}
          fgColor={QR_FG_COLOR}
          title={t('attachments.qr_code_title')}
        />
      </div>
      <p className='max-w-xs text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
        {t('attachments.qr_code_hint')}
      </p>
      <div className='flex w-full items-center gap-[var(--sp-2)] pt-[var(--sp-2)]'>
        <Button
          size='sm'
          variant='secondary'
          className='flex-1'
          icon={isCopied ? <Check size={13} className='text-[var(--success)]' /> : <Copy size={13} />}
          onClick={() => void handleCopy()}
        >
          {isCopied ? t('common.copied') : t('attachments.copy_link')}
        </Button>
        <a
          href={fullUrl}
          target='_blank'
          rel='noopener noreferrer'
          className='inline-flex h-9 items-center gap-[var(--sp-1-5)] rounded-[var(--r-sm)] border border-[var(--border-default)] px-[var(--sp-3)] text-[length:var(--text-12)] font-medium whitespace-nowrap text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] md:h-7 md:px-2.5'
        >
          <ExternalLink size={13} />
          <span>{t('preview.open_in_new_tab')}</span>
        </a>
      </div>
    </div>
  )
}
