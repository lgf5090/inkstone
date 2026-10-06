import { t } from '../../i18n'
import type { KanbanChartPalette } from './chart-palette'
import { KANBAN_COLOR_NAMES } from './colors'
import type {
  KanbanChartDataset,
  KanbanChartType,
  KanbanColorName,
  KanbanData,
  KanbanProperty,
} from './types'

export function resolveChartColorName(colorName?: string, index = 0): KanbanColorName {
  if (colorName && KANBAN_COLOR_NAMES.includes(colorName as KanbanColorName)) {
    return colorName as KanbanColorName
  }
  return KANBAN_COLOR_NAMES[index % KANBAN_COLOR_NAMES.length]!
}

export function aggregateKanbanChartData(
  items: KanbanData['items'],
  groupBy: string,
  groupByProperty: KanbanProperty | undefined,
): KanbanChartDataset {
  const counts = new Map<string, number>()
  const labels: string[] = []
  const data: number[] = []
  const colors: KanbanColorName[] = []
  const values: (string | undefined)[] = []
  const total = items.length

  if (!groupByProperty || !groupByProperty.options || groupByProperty.options.length === 0) {
    const allLabel = t('preview.kanban_chart_all_tasks')
    counts.set(allLabel, total)
    labels.push(allLabel)
    data.push(total)
    colors.push(resolveChartColorName())
    values.push(undefined)
    return { labels, data, colors, total, values }
  }

  const propId = groupByProperty.id || groupBy
  for (const item of items) {
    const val = String(item.properties[propId] || '__none__')
    counts.set(val, (counts.get(val) || 0) + 1)
  }

  groupByProperty.options.forEach((opt, idx) => {
    const count = counts.get(opt.id) || counts.get(opt.label) || 0
    labels.push(opt.label)
    data.push(count)
    colors.push(resolveChartColorName(opt.color, idx))
    values.push(opt.id)
    counts.delete(opt.id)
    counts.delete(opt.label)
  })

  let remaining = 0
  for (const c of counts.values()) remaining += c
  if (remaining > 0) {
    labels.push(t('preview.kanban_chart_no_value'))
    data.push(remaining)
    colors.push('gray')
    values.push(undefined)
  }

  return { labels, data, colors, total, values }
}

function buildChartJsOptions(type: KanbanChartType, palette: KanbanChartPalette) {
  const isCartesian = type === 'bar' || type === 'line'

  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: type === 'pie' || type === 'doughnut' || type === 'polarArea' || type === 'radar',
        labels: { color: palette.text },
      },
      tooltip: {
        backgroundColor: palette.tooltipBg,
        titleColor: palette.tooltipTitle,
        bodyColor: palette.tooltipBody,
        borderColor: palette.tooltipBorder,
        borderWidth: 1,
      },
    },
    scales: isCartesian
      ? {
          x: { ticks: { color: palette.text }, grid: { color: palette.grid } },
          y: {
            beginAtZero: true,
            ticks: { color: palette.text, stepSize: 1 },
            grid: { color: palette.grid },
          },
        }
      : undefined,
  }
}

export function buildChartJsConfig(
  type: KanbanChartType,
  dataset: KanbanChartDataset,
  palette: KanbanChartPalette,
  onSliceClick?: (index: number) => void,
) {
  const options = buildChartJsOptions(type, palette)
  if (onSliceClick) {
    // The drill-down gesture: a click on a slice hands its index back, and the view turns it into the
    // very rule the quick-filter chips write. The pointer learns the slices are alive; the slices that
    // stand for several values at once are filtered out inside the handler, not here.
    const wiring = options as Record<string, unknown>
    wiring.onClick = (_event: unknown, elements: { index?: number }[]) => {
      const index = elements[0]?.index
      if (typeof index === 'number') onSliceClick(index)
    }
    wiring.onHover = (event: { native?: { target?: { style?: { cursor?: string } } } }, elements: unknown[]) => {
      const target = event.native?.target
      if (target?.style) target.style.cursor = elements.length > 0 ? 'pointer' : 'default'
    }
  }
  return {
    type,
    data: {
      labels: dataset.labels,
      datasets: [
        {
          label: t('preview.kanban_chart_dataset_tasks'),
          data: dataset.data,
          backgroundColor: type === 'line' ? palette.lineFill : dataset.colors.map((name) => palette.tagColors[name]),
          borderColor: type === 'line' ? palette.lineBorder : undefined,
          borderWidth: type === 'line' ? 2 : 0,
          fill: type === 'line',
          tension: 0.3,
        },
      ],
    },
    options,
  }
}
