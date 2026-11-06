/** A tiny shape behind a KPI: the same series the trend draws, without axes. */
export function Sparkline({ values, tone = 'var(--accent)' }: { values: readonly number[]; tone?: string }) {
  if (values.length < 2) return null
  const max = Math.max(1, ...values)
  const width = 88
  const height = 24
  const points = values
    .map((value, index) => `${((index / (values.length - 1)) * width).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`)
    .join(' ')
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-6 w-[88px]">
      <polyline fill="none" stroke={tone} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" points={points} opacity="0.85" />
    </svg>
  )
}
