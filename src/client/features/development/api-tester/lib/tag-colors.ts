export const TAG_COLOR_VALUES: Record<string, string> = {
  'chart-1': 'oklch(0.871 0.006 286.286)',
  'chart-2': 'oklch(0.552 0.016 285.938)',
  'chart-3': 'oklch(0.442 0.017 285.786)',
  'chart-4': 'oklch(0.37 0.013 285.805)',
  'chart-5': 'oklch(0.274 0.006 286.033)',
  zinc: 'oklch(0.871 0.006 286.286)',
  neutral: 'oklch(0.87 0 0)',
  stone: 'oklch(0.869 0.005 56.366)',
  mauve: 'oklch(0.865 0.012 325.68)',
  olive: 'oklch(0.88 0.011 106.6)',
  mist: 'oklch(0.872 0.007 219.6)',
  taupe: 'oklch(0.868 0.007 39.5)',
  amber: 'oklch(0.879 0.169 91.605)',
  blue: 'oklch(0.809 0.105 251.813)',
  cyan: 'oklch(0.865 0.127 207.078)',
  emerald: 'oklch(0.845 0.143 164.978)',
  fuchsia: 'oklch(0.833 0.145 321.434)',
  green: 'oklch(0.871 0.15 154.449)',
  indigo: 'oklch(0.785 0.115 274.713)',
  lime: 'oklch(0.897 0.196 126.665)',
  orange: 'oklch(0.837 0.128 66.29)',
  pink: 'oklch(0.823 0.12 346.018)',
  purple: 'oklch(0.827 0.119 306.383)',
  red: 'oklch(0.808 0.114 19.571)',
  rose: 'oklch(0.81 0.117 11.638)',
  sky: 'oklch(0.828 0.111 230.318)',
  teal: 'oklch(0.855 0.138 181.071)',
  violet: 'oklch(0.811 0.111 293.571)',
  yellow: 'oklch(0.905 0.182 98.111)',
}

export const CHART_COLOR_NAMES = Object.keys(TAG_COLOR_VALUES)

export function tagColorValue(color: string | null | undefined): string | null {
  if (!color) return null
  return TAG_COLOR_VALUES[color] ?? color
}
