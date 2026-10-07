import { useMemo } from 'react'
import { t, type MessageKey } from '../../../i18n'
import type { KanbanItem, KanbanProperty } from '../types'
import { kanbanStableKeys } from './kanban-list-keys'

interface KanbanProgressBarProps {
  items: KanbanItem[]
  statusColumn?: KanbanProperty
  height?: number
  className?: string
}

interface Segment {
  /** A real group shows the name the board author gave it; the catch-all bucket shows a translated label. */
  label?: string
  labelKey?: MessageKey
  color: string
  count: number
  percent: number
}

function segmentLabel(seg: Segment): string {
  return seg.labelKey ? t(seg.labelKey) : seg.label ?? ''
}

function resolveSegmentColor(optionColor?: string): string {
  if (!optionColor) return 'var(--text-quaternary)'
  return `var(--kanban-tag-${optionColor}-fg, var(--accent))`
}

function calculateSegments(items: KanbanItem[], statusColumn?: KanbanProperty): Segment[] {
  if (!items.length) return []
  // The bar reads the column it is handed, not a conventional key: a hand-written board may name
  // its status column anything, and the resolver that picked `statusColumn` already knows where
  // the values live.
  const key = statusColumn?.id ?? 'status'
  const counts = new Map<string, number>()
  for (const item of items) {
    const val = String(item.properties[key] || '__none__')
    counts.set(val, (counts.get(val) || 0) + 1)
  }

  const res: Segment[] = []
  const total = items.length

  if (statusColumn?.options) {
    for (const opt of statusColumn.options) {
      const count = counts.get(opt.id) || counts.get(opt.label) || 0
      if (count > 0) {
        res.push({
          label: opt.label,
          color: resolveSegmentColor(opt.color),
          count,
          percent: (count / total) * 100,
        })
        counts.delete(opt.id)
        counts.delete(opt.label)
      }
    }
  }

  let remaining = 0
  for (const c of counts.values()) remaining += c
  if (remaining > 0) {
    res.push({
      labelKey: 'preview.kanban_status_other',
      color: 'var(--text-quaternary)',
      count: remaining,
      percent: (remaining / total) * 100,
    })
  }

  return res
}

export function KanbanProgressBar({
  items,
  statusColumn,
  height = 8,
  className = '',
}: KanbanProgressBarProps) {
  const segments = useMemo(() => calculateSegments(items, statusColumn), [items, statusColumn])
  const keys = useMemo(
    () => kanbanStableKeys(segments, (s) => [s.labelKey, s.label, s.color]),
    [segments],
  )

  if (!segments.length) return null

  return (
    // An image role with the distribution in its name, because the bar itself is
    // a row of painted divs whose only other channel is a `title` tooltip no
    // screen reader tells: the counts are the content, the colours are the skin.
    <div
      role='img'
      aria-label={t('preview.kanban_status_summary', {
        summary: segments.map((seg) => `${segmentLabel(seg)} ${seg.count}`).join(', '),
      })}
      className={`flex overflow-hidden rounded-[var(--r-full)] bg-[var(--bg-hover)] ${className}`}
      style={{ height }}
    >
      {segments.map((seg, idx) => (
        <div
          key={keys[idx]}
          aria-hidden
          style={{
            width: `${seg.percent}%`,
            backgroundColor: seg.color,
          }}
          title={`${segmentLabel(seg)}: ${seg.count} (${seg.percent.toFixed(0)}%)`}
          className='transition-all duration-[var(--dur-base)] first:rounded-l-[var(--r-full)] last:rounded-r-[var(--r-full)]'
        />
      ))}
    </div>
  )
}
