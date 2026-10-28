import { t } from '../../../../lib/i18n'
import type { ResponseTiming } from '@shared/development/api-tester/types'

const ROW_LABEL = ['DNS', 'Connect', 'TLS', 'TTFB', 'Download'] as const
const ROW_COLOR = [
  'bg-[var(--chart-1)]',
  'bg-[var(--chart-2)]',
  'bg-[var(--chart-3)]',
  'bg-[var(--chart-4)]',
  'bg-[var(--chart-5)]',
] as const

export function TimingView({
  timing,
  totalMs,
}: {
  timing?: ResponseTiming
  totalMs: number
}) {
  if (!timing) {
    return (
      <div className="p-4 text-[length:var(--text-13)] text-[var(--text-tertiary)]">
        {t('development.apitester.no_timing_data')}
      </div>
    )
  }

  const values = [
    timing.dnsMs,
    timing.connectMs,
    timing.tlsMs,
    timing.ttfbMs,
    timing.downloadMs,
  ]
  const offsets = [0, 0, 0, 0, timing.ttfbMs ?? 0]
  const total = timing.totalMs || totalMs

  return (
    <div className="space-y-3 p-3" data-slot="api-tester-timing">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
          {t('development.apitester.timing_title')}
        </span>
        <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('development.apitester.total_time', { ms: total })}
        </span>
      </div>
      <div className="space-y-0.5">
        {ROW_LABEL.map((label, index) => {
          const ms = values[index]
          const value = ms ?? 0
          const missing = value <= 0
          return (
            <div key={label} className="flex items-center gap-2 py-1 text-[length:var(--text-11)]">
              <span className="w-20 shrink-0 text-[var(--text-tertiary)]">{label}</span>
              {missing ? (
                <div className="h-4 flex-1 rounded-[var(--r-xs)] bg-[var(--bg-sunken)]" />
              ) : (
                <div
                  className="relative h-4 flex-1 rounded-[var(--r-xs)] bg-[var(--bg-sunken)]"
                  aria-hidden="true"
                >
                  <div
                    className={`absolute h-full rounded-[var(--r-xs)] ${ROW_COLOR[index]}`}
                    style={{
                      left: `${total > 0 ? ((offsets[index] ?? 0) / total) * 100 : 0}%`,
                      width: `${total > 0 ? Math.max((value / total) * 100, 1) : 100}%`,
                    }}
                  />
                </div>
              )}
              <span className="w-16 shrink-0 text-right font-mono tabular text-[var(--text-secondary)]">
                {missing ? '—' : `${value} ms`}
              </span>
            </div>
          )
        })}
      </div>
      <div className="border-t border-[var(--border-subtle)] pt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        {t('development.apitester.timing_footer')}
      </div>
    </div>
  )
}
