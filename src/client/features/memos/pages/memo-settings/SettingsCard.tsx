import { useId, type ReactNode } from 'react'

export interface SettingsCardProps {
  id: string
  title: string
  description?: ReactNode
  children: ReactNode
}

export function SettingsCard({ id, title, description, children }: SettingsCardProps) {
  const titleId = useId()
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className="scroll-mt-16 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 md:p-4"
    >
      <header className="border-b border-[var(--border-subtle)] pb-2.5">
        <h3 id={titleId} className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
          {title}
        </h3>
        {description ? (
          <div className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {description}
          </div>
        ) : null}
      </header>
      <div className="pt-1">{children}</div>
    </section>
  )
}
