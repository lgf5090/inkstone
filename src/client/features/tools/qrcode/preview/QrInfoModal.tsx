import { useQrCodeStore } from '../store'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'

export function QrInfoModal() {
  const isOpen = useQrCodeStore((s) => s.infoModalOpen)
  const setOpen = useQrCodeStore((s) => s.setInfoModalOpen)
  const getEncodedPayload = useQrCodeStore((s) => s.getEncodedPayload)
  const options = useQrCodeStore((s) => s.options)
  const contentType = useQrCodeStore((s) => s.contentType)

  const payload = getEncodedPayload()
  const charLength = payload.length

  const getEstimatedDistance = () => {
    if (charLength === 0) return '0 m'
    if (charLength < 50) return '~ 1.5 - 2.5 m'
    if (charLength < 200) return '~ 1.0 - 1.8 m'
    return '~ 0.5 - 1.0 m'
  }

  return (
    <Modal
      open={isOpen}
      onClose={() => setOpen(false)}
      title={t('tools.qrcode.info.modal_title')}
      width={440}
    >
      <div className="flex flex-col gap-4 p-4 text-[length:var(--text-13)]">
        <div className="grid grid-cols-2 gap-3 rounded-[var(--r-md)] bg-[var(--bg-inset)] p-3 border border-[var(--border-subtle)]">
          <div>
            <span className="text-[var(--text-tertiary)]">{t('tools.qrcode.info.content_type')}</span>
            <p className="font-semibold text-[var(--text-primary)] uppercase">{contentType}</p>
          </div>
          <div>
            <span className="text-[var(--text-tertiary)]">{t('tools.qrcode.info.char_count')}</span>
            <p className="font-semibold text-[var(--text-primary)]">
              {t('tools.qrcode.info.chars_count', { count: charLength })}
            </p>
          </div>
          <div>
            <span className="text-[var(--text-tertiary)]">{t('tools.qrcode.info.error_correction')}</span>
            <p className="font-semibold text-[var(--text-primary)]">{options.errorCorrectionLevel}</p>
          </div>
          <div>
            <span className="text-[var(--text-tertiary)]">{t('tools.qrcode.info.estimated_distance')}</span>
            <p className="font-semibold text-[var(--text-primary)]">{getEstimatedDistance()}</p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[var(--text-secondary)] font-medium">{t('tools.qrcode.info.encoded_payload')}</span>
          <pre className="max-h-32 overflow-y-auto rounded-[var(--r-md)] bg-[var(--bg-inset)] p-2.5 text-[length:var(--text-11)] text-[var(--text-secondary)] font-mono break-all whitespace-pre-wrap border border-[var(--border-subtle)]">
            {payload || t('tools.qrcode.info.empty_payload')}
          </pre>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="primary" onClick={() => setOpen(false)}>
            {t('tools.qrcode.info.close')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
