import { Phone } from 'lucide-react'
import { useQrCodeStore } from '../store'
import { Field, Input, Textarea } from '../../../../components/form'
import { t } from '../../../../lib/i18n'

export function PhoneContentForm() {
  const phoneContent = useQrCodeStore((s) => s.phoneContent)
  const setPhoneContent = useQrCodeStore((s) => s.setPhoneContent)

  return (
    <div className="flex flex-col gap-2.5">
      <Field label={t('tools.qrcode.content.phone_number')}>
        <Input
          type="tel"
          value={phoneContent.phone}
          onChange={(e) => setPhoneContent({ phone: e.target.value })}
          placeholder="13800138000"
          leading={<Phone size={15} className="text-[var(--text-tertiary)]" />}
        />
      </Field>

      <Field label={t('tools.qrcode.content.phone_sms_message')}>
        <Textarea
          value={phoneContent.message || ''}
          onChange={(e) => setPhoneContent({ message: e.target.value })}
          placeholder={t('tools.qrcode.content.phone_sms_placeholder')}
          rows={3}
          className="resize-none"
        />
      </Field>
    </div>
  )
}
