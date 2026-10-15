/**
 * What the assistant settings tabs share.
 *
 * The frame they hang in is AssistantSettingsView.tsx; this file is the parts more than one tab draws:
 * the section wrapper a tab groups its rows with, and the three protocol names. They live here rather than
 * in the shell because the shell no longer knows what is inside a tab.
 */
import { type ReactNode } from 'react'
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

export const PROTOCOL_LABELS: Record<string, () => string> = {
  openai: () => t('assistant.settings.protocol.openai'),
  anthropic: () => t('assistant.settings.protocol.anthropic'),
  gemini: () => t('assistant.settings.protocol.gemini'),
}

