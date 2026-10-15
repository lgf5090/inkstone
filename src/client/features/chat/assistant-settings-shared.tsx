/**
 * What the assistant settings tabs share.
 *
 * The frame they hang in is AssistantSettingsView.tsx; this file is the parts more than one tab draws:
 * the section wrapper a tab groups its rows with, the three protocol names, and the preset row both token
 * editors are built from. They live here rather than in the shell because the shell no longer knows what
 * is inside a tab.
 */
import { type ReactNode } from 'react'
import { formatTokenStep } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'

export function Group({ title, children }: { title: string, children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <p className="px-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{title}</p>
      <div className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3">
        {children}
      </div>
    </section>
  )
}

const CHIP_COLUMNS = { 3: 'grid-cols-3', 5: 'grid-cols-5' } as const

/**
 * One row of preset buttons under a token field: the reader picks 256K rather than typing 262144.
 *
 * Both token editors draw this, because both hold the same ladder — the ceiling a model was given, and the
 * one behind the models that were given none. Pressing the preset that is already taken hands back `null`,
 * which means "take it back": a model's own ceiling can be empty, while the account's number cannot, and
 * that caller simply does not act on it.
 */
export function ChipRow({ label, steps, value, onPick, columns = 5 }: {
  label: string
  steps: readonly number[]
  value: number | null
  onPick: (tokens: number | null) => void
  /** How many picks sit on one line; a fixed count keeps the rows aligned instead of ragged. */
  columns?: 3 | 5
}) {
  return (
    <div role='group' aria-label={label} className={cn('mt-1.5 grid gap-1', CHIP_COLUMNS[columns])}>
      {steps.map((tokens) => (
        <button
          key={tokens}
          type="button"
          aria-pressed={value === tokens}
          onClick={() => onPick(value === tokens ? null : tokens)}
          className={cn(
            'rounded-full border px-1.5 py-1 text-center text-[length:var(--text-10-5)] tabular-nums',
            'transition-[background-color,border-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
            value === tokens
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
              : 'border-[var(--border-subtle)] text-[var(--text-quaternary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
          )}
        >
          {formatTokenStep(tokens)}
        </button>
      ))}
    </div>
  )
}

export const PROTOCOL_LABELS: Record<string, () => string> = {
  openai: () => t('assistant.settings.protocol.openai'),
  anthropic: () => t('assistant.settings.protocol.anthropic'),
  gemini: () => t('assistant.settings.protocol.gemini'),
}

