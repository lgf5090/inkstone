import { Copy } from 'lucide-react'
import { t } from '../lib/i18n'
import { copyText } from '../lib/clipboard'
import { useUi } from '../store/ui'
import { cn } from '../lib/cn'

export function CopyButton({
  text,
  label,
  toastMessage,
  className,
  disabled,
}: {
  text: string
  label?: string
  toastMessage?: string
  className?: string
  disabled?: boolean
}) {
  const accessible = label ?? t('development.apitester.common.copy')
  return (
    <button
      type="button"
      aria-label={accessible}
      title={accessible}
      disabled={disabled}
      onClick={() => {
        void copyText(text).then((ok) => {
          useUi.getState().toast({
            title: ok ? (toastMessage ?? t('development.apitester.common.copied')) : t('development.apitester.common.copy_failed'),
            tone: ok ? 'success' : 'danger',
          })
        })
      }}
      className={cn(
        'inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-[var(--r-sm)] px-1.5',
        'text-[var(--text-tertiary)] transition-colors duration-[var(--dur-fast)]',
        'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        'disabled:pointer-events-none disabled:opacity-45',
        className,
      )}
    >
      <Copy size={13} />
    </button>
  )
}
