import { AlertTriangle } from 'lucide-react'
import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'

/** The inline failure every panel shows instead of an empty screen. */
export function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-[var(--r-md)] border border-[var(--danger)]/45 bg-[var(--bg-raised)] px-3 py-2"
    >
      <span className="flex min-w-0 items-start gap-2 text-[length:var(--text-12-5)] text-[var(--danger)]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="break-words">{message}</span>
      </span>
      <Button size="sm" variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>
    </div>
  )
}
