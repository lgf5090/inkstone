import { useQrCodeStore } from '../store'
import { Textarea } from '../../../../components/form'
import { t } from '../../../../lib/i18n'

export function TextContentForm() {
  const textContent = useQrCodeStore((s) => s.textContent)
  const setTextContent = useQrCodeStore((s) => s.setTextContent)

  const isLong = textContent.length > 1500

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={textContent}
        onChange={(e) => setTextContent(e.target.value.slice(0, 3000))}
        placeholder={t('tools.qrcode.content.text_placeholder')}
        rows={4}
        className="resize-none"
      />
      <div className="flex items-center justify-between text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        {isLong ? (
          <span className="text-[var(--warning)] font-medium">
            {t('tools.qrcode.content.long_text_hint')}
          </span>
        ) : <span />}
        <span className="font-mono shrink-0 ml-2">{`${textContent.length} / 3000`}</span>
      </div>
    </div>
  )
}
