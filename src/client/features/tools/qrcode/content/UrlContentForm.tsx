import { Globe } from 'lucide-react'
import { useQrCodeStore } from '../store'
import { Field, Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'

export function UrlContentForm() {
  const urlContent = useQrCodeStore((s) => s.urlContent)
  const setUrlContent = useQrCodeStore((s) => s.setUrlContent)

  return (
    <div className="flex flex-col gap-2">
      <Field label={t('tools.qrcode.content.url_label')}>
        <Input
          type="url"
          value={urlContent}
          onChange={(e) => setUrlContent(e.target.value)}
          placeholder={t('tools.qrcode.content.url_placeholder')}
          leading={<Globe size={15} className="text-[var(--text-tertiary)]" />}
        />
      </Field>
      <div className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        {t('tools.qrcode.content.url_hint')}
      </div>
    </div>
  )
}
