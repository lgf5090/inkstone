import type { ReactNode } from 'react'
import { cn } from '../../../../lib/cn'

const DOT: Record<'success' | 'warning' | 'danger' | 'neutral', string> = {
  success: 'bg-[var(--success)]',
  warning: 'bg-[var(--warning)]',
  danger: 'bg-[var(--danger)]',
  neutral: 'bg-[var(--text-quaternary)]',
}

export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: keyof typeof DOT
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-1.5 py-0.5 font-mono text-[length:var(--text-10)] text-[var(--text-secondary)] tabular',
        className,
      )}
    >
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', DOT[tone])} />
      {children}
    </span>
  )
}
