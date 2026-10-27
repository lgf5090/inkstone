/**
 * The frame every dashboard panel shares, and the two states a panel shows without a table.
 *
 * A panel is a titled section, not a card with its own chrome: the screen stacks four of them, and
 * four competing shadows would read as four dashboards. Errors are inline and offer the retry in the
 * same block, because a failed panel is exactly where the reader wants the button.
 */
import type { ReactNode } from 'react'
import { Button } from '../../../../components/primitives'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      aria-label={typeof title === 'string' ? title : undefined}
      className={cn(
        'rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)]',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{title}</h2>
        {actions}
      </div>
      <div className={cn('p-3', bodyClassName)}>{children}</div>
    </section>
  )
}

export function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2"
    >
      <div className="min-w-0">
        <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
          {t('common.action_failed')}
        </p>
        <p className="mt-0.5 text-[length:var(--text-11-5)] break-words text-[var(--text-tertiary)]">{message}</p>
      </div>
      <Button size="sm" variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>
    </div>
  )
}

export function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{children}</p>
  )
}
