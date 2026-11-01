import { analysePalette, CVD_CONFUSION_THRESHOLD, DEFAULT_CHECK_DEFICIENCY } from '@shared/tools/color/health'
import { t } from '../../../../lib/i18n'

export interface PaletteHealthSummaryProps {
  /** The scheme to judge, in the order it is shown. */
  colors: string[]
}

/**
 * One line about whether a scheme works, with the reasons one click open.
 *
 * `<details>` rather than a tooltip: the finding is the kind of thing a reader has to be able to read on a
 * phone, at their own pace, with no hover to hold.
 */
export function PaletteHealthSummary({ colors }: PaletteHealthSummaryProps) {
  if (colors.length < 2) return null
  const health = analysePalette(colors, DEFAULT_CHECK_DEFICIENCY)
  const deficiencyName = t(`tools.color.blindness.type.${DEFAULT_CHECK_DEFICIENCY}`)

  return (
    <details className="group text-[length:var(--text-11)] text-[var(--text-tertiary)]">
      <summary className="cursor-pointer list-none select-none font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
        {health.confused.length === 0
          ? t('tools.color.health.distinct', { deficiency: deficiencyName })
          : t('tools.color.health.confused', { count: health.confused.length, deficiency: deficiencyName })}
        {health.textlessSwatches.length > 0 &&
          ` · ${t('tools.color.health.textless', { count: health.textlessSwatches.length })}`}
        {` · ${t('tools.color.health.readable', { count: health.readable.length })}`}
      </summary>
      <ul className="mt-1.5 space-y-1 pl-1">
        {health.confused.map((pair) => (
          <li key={`${pair.a}-${pair.b}`} className="font-mono text-[length:var(--text-10)]">
            {`${colors[pair.a]} / ${colors[pair.b]} Δ ${pair.distance} < ${CVD_CONFUSION_THRESHOLD}`}
          </li>
        ))}
        {health.textlessSwatches.map((index) => (
          <li key={`textless-${index}`} className="font-mono text-[length:var(--text-10)]">
            {`${colors[index]} ${t('tools.color.health.textless_detail')}`}
          </li>
        ))}
        {health.readable.slice(0, 3).map((pair) => (
          <li key={`${pair.background}-${pair.foreground}`} className="font-mono text-[length:var(--text-10)]">
            {`${colors[pair.foreground]} on ${colors[pair.background]} ${pair.ratio}:1`}
          </li>
        ))}
      </ul>
    </details>
  )
}
