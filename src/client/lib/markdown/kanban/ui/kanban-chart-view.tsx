import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart2,
  CheckCircle2,
  CircleDot,
  Compass,
  Layers,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  TrendingUp,
} from 'lucide-react'
import { Select } from '../../../../components/form'
import { t, useLocaleRepaint } from '../../../i18n'
import { aggregateKanbanChartData, buildChartJsConfig } from '../chart-helpers'
import { readKanbanChartPalette } from '../chart-palette'
import { toggleKanbanQuickFilter } from '../quick-filters'
import { formatKanbanPropertyName } from '../i18n-helpers'
import { isKanbanItemDone } from '../item-status'
import type { KanbanChartType, KanbanData, KanbanFilter, KanbanView } from '../types'

interface KanbanChartViewProps {
  data: KanbanData
  view: KanbanView
  onUpdateView?: (patch: Partial<KanbanView>) => void
}

const CHART_TYPES: Array<{ type: KanbanChartType; labelKey: string; icon: React.ComponentType<{ size?: number }> }> = [
  { type: 'bar', labelKey: 'preview.kanban_chart_bar', icon: BarChart2 },
  { type: 'line', labelKey: 'preview.kanban_chart_line', icon: LineChartIcon },
  { type: 'pie', labelKey: 'preview.kanban_chart_pie', icon: PieChartIcon },
  { type: 'doughnut', labelKey: 'preview.kanban_chart_doughnut', icon: CircleDot },
  { type: 'polarArea', labelKey: 'preview.kanban_chart_polar_area', icon: Compass },
  { type: 'radar', labelKey: 'preview.kanban_chart_radar', icon: Layers },
]

function ChartGroupByControl({
  currentGroupBy,
  columns,
  onChangeGroupBy,
}: {
  currentGroupBy: string
  columns: KanbanData['columns']
  onChangeGroupBy: (propId: string) => void
}) {
  const selectableCols = columns.filter((c) => c.type === 'select' || c.type === 'multi-select' || c.id === 'status' || c.id === 'priority')

  return (
    <div className='flex items-center gap-2 text-[length:var(--text-12)]'>
      <span className='text-[var(--text-tertiary)]'>{t('preview.kanban_chart_group_by')}:</span>
      <Select
        value={currentGroupBy}
        onChange={(e) => onChangeGroupBy(e.target.value)}
        aria-label={t('preview.kanban_chart_group_by')}
        className='h-7 md:h-7 font-medium'
      >
        {selectableCols.map((c) => (
          <option key={c.id} value={c.id}>
            {formatKanbanPropertyName(c)}
          </option>
        ))}
      </Select>
    </div>
  )
}

function ChartToolbar({
  currentType,
  currentGroupBy,
  columns,
  onChangeType,
  onChangeGroupBy,
}: {
  currentType: KanbanChartType
  currentGroupBy: string
  columns: KanbanData['columns']
  onChangeType: (type: KanbanChartType) => void
  onChangeGroupBy: (propId: string) => void
}) {
  return (
    <div className='flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3'>
      <div className='flex items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] p-0.5'>
        {CHART_TYPES.map(({ type, labelKey, icon: IconComponent }) => (
          <button
            key={type}
            type='button'
            onClick={() => onChangeType(type)}
            title={t(labelKey as never)}
            className={`flex items-center gap-1.5 rounded-[var(--r-sm)] px-2.5 py-1 text-[length:var(--text-12)] font-medium transition-colors ${
              currentType === type
                ? 'bg-[var(--bg-surface)] text-[var(--accent)] shadow-sm'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <IconComponent size={14} />
            <span className='hidden sm:inline'>{t(labelKey as never)}</span>
          </button>
        ))}
      </div>

      <ChartGroupByControl
        currentGroupBy={currentGroupBy}
        columns={columns}
        onChangeGroupBy={onChangeGroupBy}
      />
    </div>
  )
}

function MetricCards({ total, completedCount }: { total: number; completedCount: number }) {
  const rate = total > 0 ? Math.round((completedCount / total) * 100) : 0
  return (
    <div className='grid grid-cols-2 gap-4 p-4'>
      <div className='rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 shadow-xs'>
        <div className='flex items-center justify-between text-[var(--text-tertiary)]'>
          <span className='text-[length:var(--text-11)] font-medium'>{t('preview.kanban_chart_total_items')}</span>
          <TrendingUp size={14} />
        </div>
        <div className='mt-1 text-[length:var(--text-20)] font-bold text-[var(--text-primary)]'>{total}</div>
      </div>

      <div className='rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 shadow-xs'>
        <div className='flex items-center justify-between text-[var(--text-tertiary)]'>
          <span className='text-[length:var(--text-11)] font-medium'>{t('preview.kanban_chart_completion_rate')}</span>
          <CheckCircle2 size={14} className='text-[var(--accent)]' />
        </div>
        <div className='mt-1 text-[length:var(--text-20)] font-bold text-[var(--accent)]'>{rate}%</div>
      </div>
    </div>
  )
}

// Chart.js bakes colours into the config at creation time, so the palette has
// to be re-read whenever the theme, the accent (the line chart follows
// `--accent`) or the white-background variant rewrites the tokens (ADR-0002).
function useThemeRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => setRevision((r) => r + 1))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent', 'data-background'],
    })
    return () => observer.disconnect()
  }, [])
  return revision
}

function useChartRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  chartType: KanbanChartType,
  dataset: ReturnType<typeof aggregateKanbanChartData>,
  onSliceClick?: (index: number) => void,
) {
  const themeRevision = useThemeRevision()
  // Each token costs a style recalculation, so read the palette per theme revision, not per data change.
  const palette = useMemo(() => readKanbanChartPalette(), [themeRevision])

  useEffect(() => {
    let chartInstance: { destroy: () => void } | null = null
    let active = true

    async function init() {
      const { Chart } = await import('chart.js/auto')
      if (!active || !canvasRef.current) return

      const config = buildChartJsConfig(chartType, dataset, palette, onSliceClick)

      chartInstance = new Chart(canvasRef.current, config as never)
    }

    void init()

    return () => {
      active = false
      if (chartInstance) chartInstance.destroy()
    }
  }, [canvasRef, chartType, dataset, palette, onSliceClick])
}

function chartCanvasAriaLabel(
  groupProp: KanbanData['columns'][number] | undefined,
  dataset: ReturnType<typeof aggregateKanbanChartData>,
): string {
  const groupLabel = groupProp ? formatKanbanPropertyName(groupProp) : t('preview.kanban_chart_no_group')
  const counts = dataset.labels.map((label, i) => `${label}: ${dataset.data[i]}`).join(', ')
  return t('preview.kanban_chart_canvas_aria', { value0: dataset.total, value1: groupLabel, value2: counts })
}

function countCompleted(items: KanbanData['items']): number {
  return items.filter(isKanbanItemDone).length
}

/**
 * The chart's data and its one write-back gesture, kept apart from the drawing. The drill-down:
 * clicking a slice writes (or takes back) the same equals rule a quick-filter chip writes, so the
 * rule shows up in the filter panel as an ordinary row and one more click on the slice takes it off.
 * A slice that stands for several stray values at once is no one rule, and a click on it is left
 * alone. The callback is memoized because the renderer rebuilds the whole Chart.js instance when the
 * wiring changes — an unstable handler would tear the chart down on every render.
 */
function useChartDrilldown(
  data: KanbanData,
  view: KanbanView,
  groupBy: string,
  onUpdateView?: (patch: Partial<KanbanView>) => void,
) {
  const groupProp = data.columns.find((c) => c.id === groupBy)
  // Identity must survive unrelated commits: a fresh dataset object every
  // render tears the Chart.js instance down and rebuilds it.
  const dataset = useMemo(
    () => aggregateKanbanChartData(data.items, groupBy, groupProp),
    [data.items, groupBy, groupProp],
  )
  const handleSliceClick = useCallback(
    (index: number) => {
      const value = dataset.values[index]
      if (value === undefined) return
      const filter: KanbanFilter = { propertyId: groupBy, operator: 'equals', value }
      onUpdateView?.({ filters: toggleKanbanQuickFilter(filter, view.filters ?? []) })
    },
    [dataset, groupBy, view.filters, onUpdateView],
  )
  return { dataset, groupProp, handleSliceClick }
}

export const KanbanChartView = memo(function KanbanChartView({ data, view, onUpdateView }: KanbanChartViewProps) {
  useLocaleRepaint()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [chartType, setChartType] = useState<KanbanChartType>(view.chartType || 'bar')
  const [groupBy, setGroupBy] = useState<string>(view.chartGroupBy || view.groupBy || 'status')

  const { dataset, groupProp, handleSliceClick } = useChartDrilldown(data, view, groupBy, onUpdateView)

  useChartRenderer(canvasRef, chartType, dataset, handleSliceClick)

  const handleTypeChange = (type: KanbanChartType) => {
    setChartType(type)
    onUpdateView?.({ chartType: type })
  }

  const handleGroupByChange = (propId: string) => {
    setGroupBy(propId)
    onUpdateView?.({ chartGroupBy: propId })
  }

  return (
    <div className='flex h-full w-full flex-col overflow-y-auto bg-[var(--bg-inset)]'>
      <ChartToolbar
        currentType={chartType}
        currentGroupBy={groupBy}
        columns={data.columns}
        onChangeType={handleTypeChange}
        onChangeGroupBy={handleGroupByChange}
      />

      <MetricCards total={dataset.total} completedCount={countCompleted(data.items)} />

      <div className='mx-4 mb-6 flex-1 min-h-96 rounded-[var(--r-xl)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 shadow-sm'>
        <div className='relative h-full w-full'>
          <canvas ref={canvasRef} role='img' aria-label={chartCanvasAriaLabel(groupProp, dataset)} />
        </div>
      </div>
    </div>
  )
})
