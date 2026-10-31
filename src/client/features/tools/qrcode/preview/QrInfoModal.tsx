import { useMemo } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { useQrCodeStore, useQrPayload } from '../store'
import { assessScannability } from '../engine/scannability'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { t, type MessageKey } from '../../../../lib/i18n'

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</span>
      <p className="truncate font-semibold text-[var(--text-primary)]">{value}</p>
    </div>
  )
}

export function QrInfoModal() {
  const isOpen = useQrCodeStore((s) => s.infoModalOpen)
  const setOpen = useQrCodeStore((s) => s.setInfoModalOpen)
  const options = useQrCodeStore((s) => s.options)
  const contentType = useQrCodeStore((s) => s.contentType)
  const exportSize = useQrCodeStore((s) => s.exportSize)
  const payload = useQrPayload()

  const charLength = payload.length
  const report = useMemo(
    () => assessScannability(options, payload, exportSize),
    [options, payload, exportSize]
  )

  return (
    <Modal
      open={isOpen}
      onClose={() => setOpen(false)}
      title={t('tools.qrcode.info.modal_title')}
      width={440}
    >
      <div className="flex flex-col gap-4 p-4 text-[length:var(--text-13)]">
        <div className="grid grid-cols-2 gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 sm:grid-cols-3">
          <Fact label={t('tools.qrcode.info.content_type')} value={contentType} />
          <Fact
            label={t('tools.qrcode.info.char_count')}
            value={t('tools.qrcode.info.chars_count', { count: charLength })}
          />
          <Fact label={t('tools.qrcode.info.error_correction')} value={options.errorCorrectionLevel} />
          <Fact
            label={t('tools.qrcode.info.modules')}
            value={`${report.modules} (${report.version})`}
          />
          <Fact
            label={t('tools.qrcode.info.contrast')}
            value={formatContrast(report.contrastRatio)}
          />
          <Fact label={t('tools.qrcode.shape.quiet_zone')} value={String(report.quietCells)} />
        </div>

        {report.issues.length ? (
          <ul className="flex flex-col gap-1.5">
            {report.issues.map((key) => (
              <li
                key={key}
                className="flex items-start gap-2 rounded-[var(--r-md)] border border-warning/30 bg-warning/10 px-3 py-2 text-[length:var(--text-12)] text-[var(--text-secondary)]"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--warning)]" />
                <span>{issueText(key, report)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 rounded-[var(--r-md)] border border-success/30 bg-success/10 px-3 py-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <Check size={14} className="shrink-0 text-success" />
            {t('tools.qrcode.info.all_checks_pass')}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.qrcode.info.encoded_payload')}
          </span>
          <pre className="max-h-32 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5 text-[length:var(--text-11)] text-[var(--text-secondary)] font-mono break-all whitespace-pre-wrap">
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

function formatContrast(ratio: number | null): string {
  return ratio === null ? '—' : `${ratio.toFixed(2)}:1`
}

/** Each message carries the measurement it is complaining about, so the number is never guessed at. */
function issueText(key: MessageKey, report: ReturnType<typeof assessScannability>): string {
  switch (key) {
    case 'tools.qrcode.check.low_contrast':
      return t(key, { ratio: report.contrastRatio === null ? '—' : report.contrastRatio.toFixed(2) })
    case 'tools.qrcode.check.small_quiet_zone':
      return t(key, { cells: report.quietCells })
    case 'tools.qrcode.check.logo_too_large':
      return t(key, {
        percent: Math.round(report.logoAreaRatio * 100),
        ecc: report.ecc,
      })
    case 'tools.qrcode.check.small_module':
      return t(key, { mm: report.moduleMm.toFixed(2) })
    default:
      return t(key)
  }
}
