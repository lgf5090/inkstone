/**
 * What the assistant settings tabs share.
 *
 * The frame they hang in is AssistantSettingsView.tsx; this file is the parts more than one tab draws:
 * the section wrapper a tab groups its rows with, the three protocol names, and the badges a model row
 * wears. They live here rather than in the shell because the shell no longer knows what is inside a tab.
 */
import { type ReactNode } from 'react'
import { type AssistantModel } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { Badge } from '../../components/primitives'

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

/**
 * What the row says the model can do, derived rather than stored: a second list of capabilities would
 * disagree with the switches that set them the first time one of the two is changed.
 */
export function modelBadges(model: AssistantModel): { key: Parameters<typeof t>[0], label: string }[] {
  const badges: { key: Parameters<typeof t>[0], label: string }[] = []
  if (model.reasoning !== 'off') badges.push({ key: 'assistant.model.reasoning_short', label: t('assistant.model.reasoning_short') })
  if (model.supportsTools) badges.push({ key: 'assistant.model.tools_short', label: t('assistant.model.tools_short') })
  if (model.vision) badges.push({ key: 'assistant.model.vision_short', label: t('assistant.model.vision_short') })
  for (const modality of model.modalities) {
    badges.push({
      key: modality === 'audio' ? 'assistant.model.modality.audio' : 'assistant.model.modality.video',
      label: t(modality === 'audio' ? 'assistant.model.modality.audio' : 'assistant.model.modality.video'),
    })
  }
  return badges
}

export function ModelBadges({ model }: { model: AssistantModel }) {
  const badges = modelBadges(model)
  if (badges.length === 0) return null
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {badges.map((badge) => (
        <Badge key={badge.key} className="px-1.5 py-0 text-[length:var(--text-10)] font-normal">{badge.label}</Badge>
      ))}
    </span>
  )
}
