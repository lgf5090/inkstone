// @vitest-environment jsdom
/**
 * The cumulative flow chart and its export.
 *
 * The bands use the trend's geometry, so what a reader can actually check is pinned here: three
 * stacked polygons, a legend that switches one band off, the dashed line that marks where tracking
 * began, an accessible name carrying the range and the closing stock, and the third CSV table with
 * its fixed column names. The one-bucket case is included because it has no width between two x
 * positions and would otherwise write `NaN` into the path data.
 */
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { FlowChart } from './stats-charts'
import { buildStatsCsv } from './stats-csv'
import type { TaskStatsFlowPoint, TodoStats } from '@shared/todos/model'

const RANGE = { from: '2026-10-01', to: '2026-10-30', bucket: 'week' as const, timezone: 'UTC' }

const FLOW: TaskStatsFlowPoint[] = [
  { day: '2026-10-05', todo: 5, inProgress: 2, done: 8 },
  { day: '2026-10-12', todo: 3, inProgress: 1, done: 12 },
  { day: '2026-10-19', todo: 4, inProgress: 3, done: 13 },
]

const STATS: TodoStats = {
  range: RANGE,
  summary: {
    completed: 1,
    created: 1,
    net: 0,
    open: 3,
    completionRate: 0.25,
    abandoned: 0,
    abandonedRate: 0,
    onTime: 0,
    onTimeDue: 0,
    onTimeRate: 0,
    medianLeadTimeMs: null,
    currentStreak: 0,
    longestStreak: 0,
    overdue: 0,
  },
  series: [{ day: '2026-10-05', completed: 1, created: 1 }],
  flow: FLOW,
  flowTrackedSince: '2026-10-06',
  distributions: { byList: [], byTag: [], byPriority: [], byWeekday: [], byHour: [], byWeekdayHour: [] },
  leadTime: { p50: null, p90: null, byPriority: [] },
  backlog: { under7: 0, days7to30: 0, over30: 0, none: 0 },
}

function chart(options: { flow?: TaskStatsFlowPoint[]; trackedSince?: string | null } = {}) {
  return renderElement(createElement(FlowChart, {
    flow: options.flow ?? FLOW,
    bucket: 'week',
    trackedSince: options.trackedSince === undefined ? '2026-10-06' : options.trackedSince,
    from: RANGE.from,
    to: RANGE.to,
  }))
}

beforeEach(async () => {
  await initI18n()
})

describe('the flow chart', () => {
  it('stacks three bands and names the range and the closing stock', () => {
    const view = chart()
    const svg = view.container.querySelector('svg[role="img"]')

    expect(svg?.getAttribute('aria-label')).toBe(t('todo.stats.flow.chart_label', {
      from: RANGE.from,
      to: RANGE.to,
      todo: 4,
      inProgress: 3,
      done: 13,
    }))
    expect(svg?.querySelectorAll('polygon')).toHaveLength(3)
    // The dashed marker is the tracked-since line, not a fourth series.
    expect(svg?.querySelectorAll('line[stroke-dasharray="2 4"]')).toHaveLength(1)
    view.unmount()
  })

  it('switches a band off from its legend', () => {
    const view = chart()
    const done = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(t('todo.stats.flow.done')))
    expect(done, 'the done band has no legend toggle').toBeTruthy()

    act(() => { done!.click() })

    expect(view.container.querySelectorAll('polygon')).toHaveLength(2)
    view.unmount()
  })

  it('leaves the marker out when no start was recorded in the range', () => {
    const view = chart({ trackedSince: null })

    expect(view.container.querySelectorAll('line[stroke-dasharray="2 4"]')).toHaveLength(0)
    view.unmount()
  })

  it('draws a single bucket without writing NaN into its geometry', () => {
    const view = chart({ flow: [{ day: '2026-10-05', todo: 1, inProgress: 0, done: 0 }] })
    const points = [...view.container.querySelectorAll('polygon')].map((node) => node.getAttribute('points') ?? '')

    expect(points.join(' ')).not.toContain('NaN')
    view.unmount()
  })
})

describe('the flow export', () => {
  it('writes a third table with fixed column names', () => {
    const csv = buildStatsCsv(STATS)

    expect(csv).toContain('# table 3: cumulative flow by period')
    expect(csv).toContain('period,todo,in_progress,done')
    expect(csv).toContain('2026-10-05,5,2,8')
    expect(csv).toContain('2026-10-19,4,3,13')
  })
})
