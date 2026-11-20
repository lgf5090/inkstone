/**
 * The chart: one distribution, chosen by the reader.
 *
 * The reference draws a fixed bar chart of the first select property. This one lets the reader pick the
 * shape, the grouping and the measure, because "how many per status" and "how much effort per person"
 * are the same picture with different axes — and a chart that cannot answer the second is decoration.
 */
import { useCallback, useMemo, type ReactElement } from 'react'
import { BarChart3 } from 'lucide-react'
import type { ProjectCalculation, ProjectCard, ProjectChartType, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import { PROJECT_PROPERTY_CAPABILITIES } from '@shared/project/model'
import { calculationOptionsFor, computeProjectCalculation } from '@shared/project/calculations'
import { projectOptionCssColor } from '@shared/project/option-color'
import { groupProjectCards, projectGroupKeys, projectGroupLabel } from '@shared/project/view-eval'
import { t, useLocale } from '../../../lib/i18n'
import { useProjectPeople } from '../people-context'
import { SelectMenu } from '../../../components/select-menu'
import { ChartCanvas, type ChartColors } from '../../../components/chart-canvas'
import { Seg, ViewEmpty, ViewHead, ViewShell, ViewToolbar } from './shell'

export interface ChartProps {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  fields: ProjectViewFields
  canEdit: boolean
  onPatchFields: (fields: Partial<ProjectViewFields>) => void
}

/**
 * A canvas cannot read a CSS custom property, and chart.js's own parser does not know `oklch`, so an
 * option colour handed over as `var(--kanban-tag-blue-fg)` paints black. Resolve the variable, then
 * let a 1×1 context normalise whatever colour space it names into the rgba the chart understands.
 */
function canvasColor(value: string, fallback: string): string {
  const root = getComputedStyle(document.documentElement)
  const resolved = value.startsWith('var(')
    ? root.getPropertyValue(value.slice(4, value.lastIndexOf(')')).trim()).trim()
    : value
  const probe = document.createElement('canvas')
  probe.width = 1
  probe.height = 1
  const context = probe.getContext('2d')
  if (!context) return fallback
  context.fillStyle = fallback
  if (resolved) context.fillStyle = resolved
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
  return `rgba(${red}, ${green}, ${blue}, ${(alpha ?? 255) / 255})`
}

export function ChartView(props: ChartProps): ReactElement {
  const { cards, properties, fields } = props
  const people = useProjectPeople()
  const locale = useLocale()
  const groupable = properties.filter((property) => PROJECT_PROPERTY_CAPABILITIES[property.type].canGroup)
  const groupProperty = properties.find((property) => property.id === fields.chartGroupById)
    ?? groupable[0]
  const type: ProjectChartType = fields.chartType ?? 'bar'
  const measureProperty = properties.find((property) => property.id === fields.chartPropertyId) ?? groupProperty
  const calculation: ProjectCalculation = fields.chartCalculation ?? 'count'
  const calcOptions = measureProperty ? calculationOptionsFor(measureProperty) : ['count']

  const series = useMemo(() => {
    if (!groupProperty) return []
    const groups = groupProjectCards(cards, groupProperty.id, properties)
    return projectGroupKeys(cards, groupProperty.id, properties).map((key) => {
      const list = groups.get(key) ?? []
      const raw = measureProperty ? computeProjectCalculation(list, measureProperty, calculation) : String(list.length)
      return {
        key,
        label: key === '' ? t('project.view.no_value') : projectGroupLabel(groupProperty, key, people, locale),
        count: list.length,
        value: Number.parseFloat(raw.replace(/[^\d.-]/g, '')) || 0,
        color: (key === '' ? null : projectOptionCssColor(groupProperty.options.find((option) => option.id === key)?.color ?? '')) ?? null,
      }
    }).filter((entry) => entry.count > 0)
  }, [cards, properties, groupProperty, measureProperty, calculation, people, locale])

  const total = series.reduce((sum, entry) => sum + entry.value, 0)
  const labels = series.map((entry) => entry.label)
  const values = series.map((entry) => entry.value)

  const build = useCallback((colors: ChartColors) => {
    const palette = series.map((entry, index) => canvasColor(entry.color ?? colors.palette[index % colors.palette.length]!, colors.palette[index % colors.palette.length]!))
    const round = type === 'pie' || type === 'doughnut'
    return {
      type,
      data: {
        labels,
        datasets: [{
          label: t(`project.calc.${calculation.toLowerCase()}` as Parameters<typeof t>[0]),
          data: values,
          backgroundColor: palette,
          borderColor: round ? 'transparent' : palette,
          borderWidth: round ? 0 : 1,
          borderRadius: type === 'bar' ? 4 : 0,
          tension: 0.3,
          fill: type === 'line',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: round ? {} : {
          y: { beginAtZero: true, ticks: { precision: 0, color: colors.text }, grid: { color: colors.grid } },
          x: { ticks: { color: colors.text }, grid: { display: false } },
        },
      },
    }
  }, [series, labels, values, type, calculation])

  return (
    <ViewShell data-view="chart">
      <ViewHead icon={<BarChart3 size={15} aria-hidden="true" />} title={t('project.view.chart')} count={cards.length} />
      <ViewToolbar>
        <Seg
          value={type}
          label={t('project.view.chart_type')}
          disabled={!props.canEdit}
          onChange={(next) => props.onPatchFields({ chartType: next })}
          options={[
            { value: 'bar', label: t('project.view.chart_bar') },
            { value: 'line', label: t('project.view.chart_line') },
            { value: 'pie', label: t('project.view.chart_pie') },
            { value: 'doughnut', label: t('project.view.chart_doughnut') },
          ]}
        />
        <span className="pv-bar-sep" aria-hidden="true" />
        <SelectMenu
          className="w-36"
          size="sm"
          value={groupProperty?.id ?? ''}
          label={t('project.view.group_by')}
          disabled={!props.canEdit}
          onChange={(value) => props.onPatchFields({ chartGroupById: value })}
          options={groupable.map((property) => ({ value: property.id, label: property.name }))}
        />
        <SelectMenu
          className="w-32"
          size="sm"
          value={calculation}
          label={t('project.view.chart_measure')}
          disabled={!props.canEdit}
          onChange={(value) => props.onPatchFields({ chartCalculation: value as ProjectCalculation })}
          options={calcOptions.map((option) => ({ value: option, label: t(`project.calc.${option.toLowerCase()}` as Parameters<typeof t>[0]) }))}
        />
        {/* Always reachable: "sum" only appears once a numeric property is the measure, so hiding
            this picker until the measure changed made the two controls wait on each other. */}
        <SelectMenu
          className="w-36"
          size="sm"
          value={measureProperty?.id ?? ''}
          label={t('project.view.chart_property')}
          disabled={!props.canEdit}
          onChange={(value) => props.onPatchFields({ chartPropertyId: value, chartCalculation: 'count' })}
          options={properties.map((property) => ({ value: property.id, label: property.name }))}
        />
      </ViewToolbar>
      {series.length === 0
        ? <ViewEmpty title={t('project.board.empty_cards')} hint={t('project.view.chart_empty')} />
        : (
          <div className="pv-insights pv-scroll">
            <div className="pv-panel">
              <ChartCanvas height="h-72" label={t('project.view.chart')} build={build} />
              <div className="pv-chart-legend">
                {series.map((entry) => (
                  <span key={entry.key || 'none'} className="pv-chart-legend-item">
                    <span className="pv-chart-legend-dot" style={{ backgroundColor: entry.color ?? 'var(--accent)' }} aria-hidden="true" />
                    <span>{entry.label}</span>
                    <span className="font-semibold text-[var(--text-primary)]">{entry.value}</span>
                    <span className="text-[var(--text-quaternary)]">{total > 0 ? `${Math.round((entry.value / total) * 100)}%` : '0%'}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
    </ViewShell>
  )
}