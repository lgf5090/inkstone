/** The counts above a comparison: what changed, in the reader's language. */
import type { DiffStats } from '@shared/tools/compare/types'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'

export function StatsBar({ stats, identical, className }: { stats: DiffStats; identical: boolean; className?: string }) {
  const items = identical
    ? [{ key: 'same', label: t('tools.compare.stats.unchanged'), value: stats.same, tone: 'neutral' as const }]
    : [
        { key: 'added', label: t('tools.compare.stats.added'), value: stats.added, tone: 'success' as const },
        { key: 'removed', label: t('tools.compare.stats.removed'), value: stats.removed, tone: 'danger' as const },
        { key: 'changed', label: t('tools.compare.stats.changed'), value: stats.changed, tone: 'accent' as const },
        { key: 'blocks', label: t('tools.compare.stats.blocks'), value: stats.changedBlocks, tone: 'neutral' as const },
        { key: 'same', label: t('tools.compare.stats.unchanged'), value: stats.same, tone: 'neutral' as const },
      ]

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)} data-testid="compare-stats">
      {identical && (
        <span className="rounded-full border border-[var(--success)]/40 bg-[var(--success)]/10 px-2 py-0.5 text-[length:var(--text-11)] text-[var(--success)]">
          {t('tools.compare.stats.no_difference')}
        </span>
      )}
      {items.map((item) => (
        <span
          key={item.key}
          className={cn(
            'rounded-full border px-2 py-0.5 text-[length:var(--text-11)] tabular-nums',
            item.tone === 'success' && 'border-[var(--success)]/30 text-[var(--success)]',
            item.tone === 'danger' && 'border-[var(--danger)]/30 text-[var(--danger)]',
            item.tone === 'accent' && 'border-[var(--accent)]/40 text-[var(--accent)]',
            item.tone === 'neutral' && 'border-[var(--border-subtle)] text-[var(--text-secondary)]',
          )}
        >
          {item.label} {item.value}
        </span>
      ))}
    </div>
  )
}
