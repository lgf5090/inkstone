/** An inline failure with the one action that can retry it. */
import { Button } from '../../../../components/primitives'
import { t as uiT } from '../../../../lib/i18n'

export function StorageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2"
    >
      <p className="min-w-0 text-[length:var(--text-12)] text-[var(--text-primary)]">{message}</p>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {uiT('common.retry')}
        </Button>
      )}
    </div>
  )
}
