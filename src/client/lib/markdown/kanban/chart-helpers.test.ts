import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../i18n'
import { aggregateKanbanChartData, buildChartJsConfig, resolveChartColorName } from './chart-helpers'
import type { KanbanChartPalette } from './chart-palette'
import { KANBAN_COLOR_NAMES } from './colors'
import type { KanbanColorName, KanbanItem, KanbanProperty } from './types'

beforeAll(async () => {
  await initI18n()
})

const statusProp: KanbanProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'todo', label: 'To Do', color: 'gray' },
    { id: 'in_progress', label: 'In Progress', color: 'orange' },
    { id: 'done', label: 'Done', color: 'green' },
  ],
}

const items: KanbanItem[] = [
  { id: '1', title: 'Task 1', properties: { status: 'todo' } },
  { id: '2', title: 'Task 2', properties: { status: 'in_progress' } },
  { id: '3', title: 'Task 3', properties: { status: 'done' } },
  { id: '4', title: 'Task 4', properties: { status: 'done' } },
]

const PALETTE: KanbanChartPalette = {
  text: 'P-text',
  grid: 'P-grid',
  tooltipBg: 'P-tooltip-bg',
  tooltipTitle: 'P-tooltip-title',
  tooltipBody: 'P-tooltip-body',
  tooltipBorder: 'P-tooltip-border',
  lineBorder: 'P-line',
  lineFill: 'P-line-fill',
  tagColors: Object.fromEntries(KANBAN_COLOR_NAMES.map((name) => [name, `P-${name}`])) as Record<
    KanbanColorName,
    string
  >,
}

describe('aggregateKanbanChartData', () => {
  it('aggregates item counts by property option accurately', () => {
    const res = aggregateKanbanChartData(items, 'status', statusProp)
    expect(res.total).toBe(4)
    expect(res.labels).toContain('To Do')
    expect(res.labels).toContain('In Progress')
    expect(res.labels).toContain('Done')
    const doneIdx = res.labels.indexOf('Done')
    expect(res.data[doneIdx]).toBe(2)
  })

  it('carries colour names rather than colour values, so the palette stays one decision', () => {
    const res = aggregateKanbanChartData(items, 'status', statusProp)
    expect(res.colors).toEqual(['gray', 'orange', 'green'])
    for (const color of res.colors) expect(KANBAN_COLOR_NAMES).toContain(color)
  })

  it('labels the out-of-option bucket with the muted colour name', () => {
    const looseItems: KanbanItem[] = [
      { id: '1', title: 'Task 1', properties: { status: 'todo' } },
      { id: '5', title: 'Task 5', properties: { status: 'archived' } },
    ]
    const res = aggregateKanbanChartData(looseItems, 'status', statusProp)
    expect(res.labels.at(-1)).toBe(t('preview.kanban_chart_no_value'))
    expect(res.colors.at(-1)).toBe('gray')
  })
})

describe('buildChartJsConfig', () => {
  it('creates valid Chart.js config for bar and pie charts', () => {
    const dataset = aggregateKanbanChartData(items, 'status', statusProp)
    const barConfig = buildChartJsConfig('bar', dataset, PALETTE)
    expect(barConfig.type).toBe('bar')
    expect(barConfig.data.labels).toHaveLength(3)
    expect(barConfig.data.datasets[0]!.backgroundColor).toEqual(['P-gray', 'P-orange', 'P-green'])

    const pieConfig = buildChartJsConfig('pie', dataset, PALETTE)
    expect(pieConfig.type).toBe('pie')
    expect(pieConfig.options.plugins.legend.display).toBe(true)
    expect(pieConfig.options.plugins.legend.labels.color).toBe('P-text')
    expect(pieConfig.options.plugins.tooltip.backgroundColor).toBe('P-tooltip-bg')
    expect(pieConfig.options.plugins.tooltip.titleColor).toBe('P-tooltip-title')
    expect(pieConfig.options.plugins.tooltip.bodyColor).toBe('P-tooltip-body')
    expect(pieConfig.options.plugins.tooltip.borderColor).toBe('P-tooltip-border')
  })

  it('paints a line chart with the accent pair instead of the per-option colours', () => {
    const dataset = aggregateKanbanChartData(items, 'status', statusProp)
    const lineConfig = buildChartJsConfig('line', dataset, PALETTE)
    expect(lineConfig.data.datasets[0]!.backgroundColor).toBe('P-line-fill')
    expect(lineConfig.data.datasets[0]!.borderColor).toBe('P-line')
    expect(lineConfig.options.scales!.x.grid.color).toBe('P-grid')
    expect(lineConfig.options.scales!.y.ticks.color).toBe('P-text')
  })

  it('omits cartesian scales for the radial chart types', () => {
    const dataset = aggregateKanbanChartData(items, 'status', statusProp)
    expect(buildChartJsConfig('doughnut', dataset, PALETTE).options.scales).toBeUndefined()
  })
})

describe('resolveChartColorName', () => {
  it('keeps a colour the user picked', () => {
    expect(resolveChartColorName('teal', 0)).toBe('teal')
  })

  it('rotates over the label palette for an option without a usable colour', () => {
    expect(resolveChartColorName(undefined, 0)).toBe(KANBAN_COLOR_NAMES[0])
    expect(resolveChartColorName('chartreuse', 3)).toBe(KANBAN_COLOR_NAMES[3])
  })

  it('wraps the rotation instead of running off the list', () => {
    expect(resolveChartColorName(undefined, KANBAN_COLOR_NAMES.length)).toBe(KANBAN_COLOR_NAMES[0])
  })
})

describe('aggregateKanbanChartData fallback labels', () => {
  it('uses the localized all-tasks label when grouping has no options', () => {
    const textProp: KanbanProperty = { id: 'assignee', name: 'Assignee', type: 'text' }
    const res = aggregateKanbanChartData(items, 'assignee', textProp)
    expect(res.labels).toEqual([t('preview.kanban_chart_all_tasks')])
    expect(res.data).toEqual([4])
    expect(res.colors).toEqual([KANBAN_COLOR_NAMES[0]])
  })
})
