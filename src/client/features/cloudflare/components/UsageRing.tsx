/**
 * A ring that says how much of an allowance is gone.
 *
 * The percentage is also printed in the middle: a ring alone is a colour and an angle, and neither is
 * something every reader can read. The colour only reinforces the number, it never carries it.
 */
import { cn } from '../../../lib/cn'
import { percentLabel, percentOf } from '../lib/format'

export function UsageRing({
  used,
  limit,
  color = 'var(--chart-1)',
  size = 44,
  className,
  label,
}: {
  used: number
  limit: number
  color?: string
  size?: number
  className?: string
  label: string
}) {
  const percent = percentOf(used, limit)
  const shown = percentLabel(used, limit)
  const radius = (size - 8) / 2
  const circumference = 2 * Math.PI * radius
  return (
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: `${size}px`, height: `${size}px` }}
      role="img"
      aria-label={`${label}: ${shown}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border-subtle)" strokeWidth="4" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - percent / 100)}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[length:var(--text-9)] font-semibold tabular-nums text-[var(--text-tertiary)]">
        {shown}
      </span>
    </div>
  )
}
