/** Tag/workspace swatches resolve to theme tokens, never to literal colour values. */
export const TAG_COLOR_VALUES: Record<string, string> = {
  'chart-1': 'var(--chart-1)',
  'chart-2': 'var(--chart-2)',
  'chart-3': 'var(--chart-3)',
  'chart-4': 'var(--chart-4)',
  'chart-5': 'var(--chart-5)',
  zinc: 'var(--color-zinc-400)',
  neutral: 'var(--color-neutral-400)',
  stone: 'var(--color-stone-400)',
  mauve: 'var(--color-stone-400)',
  olive: 'var(--color-lime-400)',
  mist: 'var(--color-sky-400)',
  taupe: 'var(--color-stone-400)',
  amber: 'var(--color-amber-400)',
  blue: 'var(--color-blue-400)',
  cyan: 'var(--color-cyan-400)',
  emerald: 'var(--color-emerald-400)',
  fuchsia: 'var(--color-fuchsia-400)',
  green: 'var(--color-green-400)',
  indigo: 'var(--color-indigo-400)',
  lime: 'var(--color-lime-400)',
  orange: 'var(--color-orange-400)',
  pink: 'var(--color-pink-400)',
  purple: 'var(--color-purple-400)',
  red: 'var(--color-red-400)',
  rose: 'var(--color-rose-400)',
  sky: 'var(--color-sky-400)',
  teal: 'var(--color-teal-400)',
  violet: 'var(--color-violet-400)',
  yellow: 'var(--color-yellow-400)',
}

export const CHART_COLOR_NAMES = Object.keys(TAG_COLOR_VALUES)

export function tagColorValue(color: string | null | undefined): string | null {
  if (!color) return null
  return TAG_COLOR_VALUES[color] ?? color
}
