import type { EmailMessage } from '@shared/email/model'
import { Modal } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { messageFullDate } from './format'

export function SourceDialog({ open, message, onClose }: {
  open: boolean
  message: EmailMessage | null
  onClose: () => void
}) {
  const rows = message
    ? message.rawHeaders.length > 0
      ? message.rawHeaders
      : [
          { key: t('email.detail.header_from'), value: message.sender },
          { key: t('email.detail.header_to'), value: message.recipient },
          ...(message.cc ? [{ key: t('email.detail.header_cc'), value: message.cc }] : []),
          ...(message.bcc ? [{ key: t('email.detail.header_bcc'), value: message.bcc }] : []),
          { key: t('email.detail.header_date'), value: messageFullDate(message.date) },
          { key: t('email.detail.header_subject'), value: message.subject },
          ...(message.messageId ? [{ key: t('email.detail.header_message_id'), value: message.messageId }] : []),
        ]
    : []
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('email.detail.source_title')}
      description={t('email.detail.source_hint')}
      width={640}
    >
      {rows.length === 0 ? (
        <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('email.detail.source_empty')}</p>
      ) : (
        <table className="w-full table-fixed border-collapse text-left text-[length:var(--text-11-5)]">
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.key}-${index}`} className="border-b border-[var(--border-subtle)] last:border-b-0">
                <th scope="row" className="w-36 break-words py-1.5 pr-3 align-top font-medium text-[var(--text-tertiary)]">{row.key}</th>
                <td className="break-all py-1.5 text-[var(--text-primary)]">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}
