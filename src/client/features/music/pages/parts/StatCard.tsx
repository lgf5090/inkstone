import type { ReactElement } from 'react'

export interface MusicStatCardProps {
  icon: ReactElement
  label: string
  value: string
  hint?: string
}

/** One number in a shelf of statistics; the value is the title the reader came for. */
export function MusicStatCard({ icon, label, value, hint }: MusicStatCardProps): ReactElement {
  return (
    <div className="flex min-w-0 items-start gap-[var(--sp-3)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-4)]">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-[2px]">
        <span className="text-[length:var(--text-10-5)] uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
          {label}
        </span>
        <span className="truncate text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]" title={value}>
          {value}
        </span>
        {hint && (
          <span className="truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]" title={hint}>
            {hint}
          </span>
        )}
      </span>
    </div>
  )
}
