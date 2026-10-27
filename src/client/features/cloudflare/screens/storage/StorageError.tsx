/** An inline failure with the one action that can retry it. */
import { Button } from '../../../../components/primitives'
import { t as uiT } from '../../../../lib/i18n'

export function StorageError({ message, detail, onRetry }: { message: string; detail?: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2"
    >
      <div className="min-w-0">
        <p className="text-[length:var(--text-12)] text-[var(--text-primary)]">{message}</p>
        {detail ? (
          <p className="mt-0.5 text-[length:var(--text-10-5)] break-words text-[var(--text-quaternary)]">{detail}</p>
        ) : null}
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {uiT('common.retry')}
        </Button>
      )}
    </div>
  )
}
