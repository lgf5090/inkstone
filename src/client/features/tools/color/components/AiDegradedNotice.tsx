import { TriangleAlert } from 'lucide-react'
import type { AiFallbackReason } from '@shared/tools/color/contract'
import { t } from '../../../../lib/i18n'

/**
 * Says out loud that no model answered.
 *
 * The color engine has always had an algorithmic fallback for palette generation and poetic naming, and
 * the result looked identical to a model's answer — including the "AI" in the panel title. This is the one
 * line that tells the reader which of the two they are looking at, and why.
 */
export function AiDegradedNotice({ reason }: { reason: AiFallbackReason }) {
  const reasonLabel = t(('tools.color.ai.reason.' + reason) as Parameters<typeof t>[0])

  return (
    <p
      role="status"
      className="flex items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)]"
    >
      <TriangleAlert size={13} className="shrink-0 text-[var(--warning)]" aria-hidden="true" />
      <span>{t('tools.color.ai.degraded_notice', { reason: reasonLabel })}</span>
    </p>
  )
}
