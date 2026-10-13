/**
 * How far into a book a reader is, as a ring.
 *
 * The grid card carries progress on the cover's own edge, but a list row has no cover big enough to
 * read a 3-pixel bar off, so the same number is drawn as a ring there. It is decorative: the row's own
 * label says the percentage in words.
 */
import { Check } from 'lucide-react'
import { t } from '../../lib/i18n'

export function ProgressRing({ fraction, finished, size = 30 }: { fraction: number; finished: boolean; size?: number }) {
  const stroke = 2.5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const part = finished ? 1 : Math.min(1, Math.max(0, fraction))
  const percent = Math.round(part * 100)
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={t('reading.progress_value0', { value0: percent })}
    >
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border-subtle)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={finished ? 'var(--success)' : 'var(--accent)'}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference}`}
          strokeDashoffset={`${circumference * (1 - part)}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {finished ? (
        <Check size={11} className="absolute text-[var(--success)]" aria-hidden="true" />
      ) : (
        <span className="absolute text-[9.5px] font-medium tabular text-[var(--text-secondary)]">{percent}%</span>
      )}
    </span>
  )
}
