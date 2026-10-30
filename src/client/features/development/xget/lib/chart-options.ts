import type { ChartColors } from '../../../../components/chart-canvas'

export function xgetTooltipOptions(colors: ChartColors) {
  return {
    mode: 'index' as const,
    intersect: false,
    backgroundColor: colors.grid,
    titleColor: colors.text,
    bodyColor: colors.text,
  }
}
