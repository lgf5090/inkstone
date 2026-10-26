import { useQrCodeStore } from '../store'
import { Textarea } from '../../../../components/form'
import { t } from '../../../../lib/i18n'

export function TextContentForm() {
  const textContent = useQrCodeStore((s) => s.textContent)
  const setTextContent = useQrCodeStore((s) => s.setTextContent)

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={textContent}
        onChange={(e) => setTextContent(e.target.value)}
        placeholder={t('tools.qrcode.content.text_placeholder')}
        rows={4}
        className="resize-none"
      />
      <div className="flex justify-end text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <span>{`${textContent.length} / 1000`}</span>
      </div>
    </div>
  )
}
