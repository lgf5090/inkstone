import { useMemo, useState } from 'react'
import type { ChartConfiguration, ChartType } from 'chart.js'
import { t } from '../../../lib/i18n'
import { Segmented } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { ChartCanvas, type ChartColors } from '../../../components/chart-canvas'

const MAX_POINTS = 200

type ChartKind = 'bar' | 'line' | 'pie'

export interface ResultChartProps {
  columns: string[]
  rows: unknown[][]
  className?: string
}

function numericColumns(columns: string[], rows: unknown[][]): string[] {
  return columns.filter((_, index) => {
    let seen = 0
    let numeric = 0
    for (const row of rows.slice(0, 100)) {
      const value = row[index]
      if (value === null || value === undefined || value === '') continue
      seen += 1
      if (typeof value === 'number' && Number.isFinite(value)) numeric += 1
    }
    return seen > 0 && numeric === seen
  })
}

export function ResultChart({ columns, rows, className }: ResultChartProps) {
  const numeric = useMemo(() => numericColumns(columns, rows), [columns, rows])
  const [kind, setKind] = useState<ChartKind>('bar')
  const [labelColumn, setLabelColumn] = useState(() => columns.find((column) => !numeric.includes(column)) ?? columns[0] ?? '')
  const [valueColumn, setValueColumn] = useState(() => numeric[0] ?? '')

  const labelIndex = Math.max(0, columns.indexOf(labelColumn))
  const valueIndex = Math.max(0, columns.indexOf(valueColumn))

  const data = useMemo(() => {
    if (!valueColumn) return null
    const points = rows.slice(0, MAX_POINTS)
    return {
      labels: points.map((row, index) => {
        const raw = row[labelIndex]
        const text = raw === null || raw === undefined ? `#${index + 1}` : String(raw)
        return text.length > 24 ? `${text.slice(0, 24)}…` : text
      }),
      values: points.map((row) => {
        const raw = Number(row[valueIndex])
        return Number.isFinite(raw) ? raw : 0
      }),
    }
  }, [labelIndex, rows, valueColumn, valueIndex])

  const build = useMemo(() => {
    if (!data) return null
    return (colors: ChartColors): ChartConfiguration<ChartType> => ({
      type: kind,
      data: {
        labels: data.labels,
        datasets: [{
          label: valueColumn,
          data: data.values,
          backgroundColor: kind === 'pie' ? data.values.map((_, index) => colors.palette[index % colors.palette.length]!) : colors.palette[0]!,
          borderColor: colors.palette[0],
          borderWidth: kind === 'line' ? 2 : 0,
          fill: false,
          tension: 0.25,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: kind === 'pie', labels: { color: colors.text } } },
        scales: kind === 'pie' ? {} : {
          x: { ticks: { color: colors.text, maxRotation: 0, autoSkip: true }, grid: { color: colors.grid } },
          y: { ticks: { color: colors.text }, grid: { color: colors.grid } },
        },
      },
    })
  }, [data, kind, valueColumn])

  if (numeric.length === 0) {
    return <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.database.chart.no_numeric')}</p>
  }

  return (
    <div className={`flex min-h-0 flex-col gap-1.5 p-2 ${className ?? ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Segmented
          value={kind}
          onChange={setKind}
          label={t('development.database.chart.type')}
          options={[
            { value: 'bar', label: t('development.database.chart.bar') },
            { value: 'line', label: t('development.database.chart.line') },
            { value: 'pie', label: t('development.database.chart.pie') },
          ]}
        />
        <SelectMenu
          label={t('development.database.chart.label_column')}
          value={labelColumn}
          options={columns.map((column) => ({ value: column, label: column }))}
          onChange={setLabelColumn}
          className="w-40"
          size="sm"
        />
        <SelectMenu
          label={t('development.database.chart.value_column')}
          value={valueColumn}
          options={numeric.map((column) => ({ value: column, label: column }))}
          onChange={setValueColumn}
          className="w-40"
          size="sm"
        />
        {rows.length > MAX_POINTS && <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.chart.capped', { count: MAX_POINTS })}</span>}
      </div>
      {build ? <ChartCanvas<ChartType> height="240px" label={t('development.database.chart.label', { label: labelColumn, value: valueColumn })} build={build} /> : null}
    </div>
  )
}
