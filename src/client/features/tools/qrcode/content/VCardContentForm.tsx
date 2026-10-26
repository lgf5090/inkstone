import { useQrCodeStore } from '../store'
import { Field, Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'

export function VCardContentForm() {
  const vcardContent = useQrCodeStore((s) => s.vcardContent)
  const setVcardContent = useQrCodeStore((s) => s.setVcardContent)

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('tools.qrcode.content.vcard_last_name')}>
          <Input
            value={vcardContent.lastName || ''}
            onChange={(e) => setVcardContent({ lastName: e.target.value })}
            placeholder={t('tools.qrcode.content.vcard_last_name')}
          />
        </Field>
        <Field label={t('tools.qrcode.content.vcard_first_name')}>
          <Input
            value={vcardContent.firstName}
            onChange={(e) => setVcardContent({ firstName: e.target.value })}
            placeholder={t('tools.qrcode.content.vcard_first_name')}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('tools.qrcode.content.vcard_mobile')}>
          <Input
            type="tel"
            value={vcardContent.mobile || ''}
            onChange={(e) => setVcardContent({ mobile: e.target.value })}
            placeholder="13800138000"
          />
        </Field>
        <Field label={t('tools.qrcode.content.vcard_email')}>
          <Input
            type="email"
            value={vcardContent.email || ''}
            onChange={(e) => setVcardContent({ email: e.target.value })}
            placeholder={t('tools.qrcode.content.vcard_email_placeholder')}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('tools.qrcode.content.vcard_organization')}>
          <Input
            value={vcardContent.organization || ''}
            onChange={(e) => setVcardContent({ organization: e.target.value })}
            placeholder={t('tools.qrcode.content.vcard_organization')}
          />
        </Field>
        <Field label={t('tools.qrcode.content.vcard_title')}>
          <Input
            value={vcardContent.title || ''}
            onChange={(e) => setVcardContent({ title: e.target.value })}
            placeholder={t('tools.qrcode.content.vcard_title')}
          />
        </Field>
      </div>

      <Field label={t('tools.qrcode.content.vcard_url')}>
        <Input
          type="url"
          value={vcardContent.url || ''}
          onChange={(e) => setVcardContent({ url: e.target.value })}
          placeholder="https://company.com"
        />
      </Field>

      <Field label={t('tools.qrcode.content.vcard_address')}>
        <Input
          value={vcardContent.address || ''}
          onChange={(e) => setVcardContent({ address: e.target.value })}
          placeholder={t('tools.qrcode.content.vcard_address')}
        />
      </Field>
    </div>
  )
}
