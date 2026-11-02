import type { ReactNode } from 'react'
import { cn } from '../../../../lib/cn'

export type CalcKeyVariant = 'digit' | 'operator' | 'function' | 'equals' | 'memory' | 'danger'

export function CalcKey({
  glyph,
  ariaLabel,
  onPress,
  variant = 'digit',
  active = false,
  disabled = false,
  className,
  title,
  testId,
}: {
  glyph: ReactNode
  ariaLabel: string
  onPress: () => void
  variant?: CalcKeyVariant
  active?: boolean
  disabled?: boolean
  className?: string
  title?: string
  testId?: string
}) {
  const tone =
    variant === 'equals'
      ? 'bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]'
      : variant === 'operator'
        ? 'bg-[var(--bg-inset)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
        : variant === 'function'
          ? 'bg-[var(--bg-sunken)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
          : variant === 'memory'
            ? 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            : variant === 'danger'
              ? 'bg-transparent text-[var(--danger)] hover:bg-[var(--bg-hover)]'
              : 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[0_1px_0_var(--border-subtle)] hover:bg-[var(--bg-hover)]'
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active || undefined}
      title={title}
      data-calc-key={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      onClick={onPress}
      className={cn(
        'inline-flex min-h-11 min-w-0 items-center justify-center rounded-[var(--r-md)] px-2',
        'text-[length:var(--text-15)] font-medium tabular-nums',
        'transition-[background-color,color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'active:translate-y-px disabled:pointer-events-none disabled:opacity-40',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
        tone,
        active && 'ring-2 ring-[var(--accent)] ring-inset',
        className,
      )}
    >
      <span className="truncate">{glyph}</span>
    </button>
  )
}
