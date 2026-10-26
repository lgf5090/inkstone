import { Mail } from 'lucide-react'
import { useQrCodeStore } from '../store'
import { Field, Input, Textarea } from '../../../../components/form'
import { t } from '../../../../lib/i18n'

export function EmailContentForm() {
  const emailContent = useQrCodeStore((s) => s.emailContent)
  const setEmailContent = useQrCodeStore((s) => s.setEmailContent)

  return (
    <div className="flex flex-col gap-2.5">
      <Field label={t('tools.qrcode.content.email_to')}>
        <Input
          type="email"
          value={emailContent.to}
          onChange={(e) => setEmailContent({ to: e.target.value })}
          placeholder={t('tools.qrcode.content.email_to_placeholder')}
          leading={<Mail size={15} className="text-[var(--text-tertiary)]" />}
        />
      </Field>

      <Field label={t('tools.qrcode.content.email_subject')}>
        <Input
          value={emailContent.subject || ''}
          onChange={(e) => setEmailContent({ subject: e.target.value })}
          placeholder={t('tools.qrcode.content.email_subject_placeholder')}
        />
      </Field>

      <Field label={t('tools.qrcode.content.email_body')}>
        <Textarea
          value={emailContent.body || ''}
          onChange={(e) => setEmailContent({ body: e.target.value })}
          placeholder={t('tools.qrcode.content.email_body_placeholder')}
          rows={3}
          className="resize-none"
        />
      </Field>
    </div>
  )
}
