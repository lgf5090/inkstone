// @vitest-environment jsdom
/**
 * The statistics screen: the range it asks for, the numbers it shows, and the three states.
 *
 * The range is the load-bearing part. A control that changes a label and re-slices the last answer
 * looks right on a fixture and silently answers a different question in the product, so every case
 * here reads the request the fake service received rather than only the words on screen. The view is
 * mounted through the container, because the sidebar and the phone header are where the screen is
 * reached from and a registry entry is only real once both layouts offer it.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localDate } from '@shared/assistant-time'
import type { TaskStatsBucket, TodoStats } from '@shared/todos/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { shiftDay } from './due-range'

interface StatsCall {
  from?: string
  to?: string
  bucket?: TaskStatsBucket
}

const service = vi.hoisted(() => ({
  calls: [] as StatsCall[],
  failNext: false,
  payload: null as TodoStats | null,
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({
        tasks: [],
        total: 0,
        counts: { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} },
        dayEnd: Date.now() + 3_600_000,
        timezone: 'UTC',
      }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async () => ({ task: null, steps: [] }),
      stats: async (params: StatsCall = {}) => {
        service.calls.push(params)
        if (service.failNext) {
          service.failNext = false
          throw new Error('stats unavailable')
        }
        const payload = service.payload
        // The real route echoes the range it measured. A stand-in that always answered the same days
        // would let a client that forgot its own request look right for one press.
        if (!payload || !params.from || !params.to) return payload
        return {
          ...payload,
          range: {
            from: params.from,
            to: params.to,
            bucket: params.bucket ?? payload.range.bucket,
            timezone: payload.range.timezone,
          },
        }
      },
    },
  },
}))

import { TodosApp } from './TodosApp'
import { useTodos } from './store'

const original = useTodos.getState()
let view: RenderedElement | null = null

const RANGE = { from: '2026-10-01', to: '2026-10-30', bucket: 'week' as const }

/** The response the server sends for the fixture account, with every section populated. */
function fullStats(): TodoStats {
  return {
    range: { ...RANGE, timezone: 'UTC' },
    summary: {
      completed: 12,
      created: 9,
      net: 3,
      open: 4,
      completionRate: 0.75,
      onTime: 3,
      onTimeDue: 5,
      onTimeRate: 0.6,
      medianLeadTimeMs: 1.5 * 86_400_000,
      currentStreak: 4,
      longestStreak: 6,
      overdue: 2,
    },
    series: [
      { day: '2026-10-05', completed: 8, created: 6 },
      { day: '2026-10-12', completed: 4, created: 3 },
    ],
    distributions: {
      byList: [
        { id: null, name: null, completed: 3, share: 0.25 },
        { id: 'L1', name: 'Work', completed: 9, share: 0.75 },
      ],
      byTag: [{ id: 'T1', name: 'urgent', completed: 4, share: 1 / 3 }],
      byPriority: [
        { priority: 'low', completed: 1, share: 1 / 12 },
        { priority: 'medium', completed: 5, share: 5 / 12 },
        { priority: 'high', completed: 4, share: 4 / 12 },
        { priority: 'urgent', completed: 2, share: 2 / 12 },
      ],
      byWeekday: [
        { weekday: 1, completed: 9 },
        { weekday: 3, completed: 3 },
      ],
      byHour: [
        { hour: 9, completed: 7 },
        { hour: 17, completed: 5 },
      ],
    },
    leadTime: {
      p50: 1.5 * 86_400_000,
      p90: 3 * 86_400_000,
      byPriority: [
        { priority: 'low', count: 1, averageMs: 86_400_000 },
        { priority: 'medium', count: 5, averageMs: 2 * 86_400_000 },
        { priority: 'high', count: 4, averageMs: 3 * 86_400_000 },
        { priority: 'urgent', count: 2, averageMs: 4 * 86_400_000 },
      ],
    },
    backlog: { under7: 1, days7to30: 2, over30: 3, none: 0 },
  }
}

/** The same shape with no activity in the range: what the empty state is for. */
function emptyStats(): TodoStats {
  const stats = fullStats()
  return {
    ...stats,
    summary: {
      ...stats.summary,
      completed: 0,
      created: 0,
      net: 0,
      completionRate: 0,
      onTime: 0,
      onTimeDue: 0,
      onTimeRate: 0,
      medianLeadTimeMs: null,
      currentStreak: 0,
      longestStreak: 0,
    },
    series: RANGE.bucket === 'week'
      ? [{ day: '2026-10-05', completed: 0, created: 0 }]
      : [],
    distributions: {
      byList: [],
      byTag: [],
      byPriority: stats.distributions.byPriority.map((entry) => ({ ...entry, completed: 0, share: 0 })),
      byWeekday: [],
      byHour: [],
    },
    leadTime: { p50: null, p90: null, byPriority: [] },
    backlog: { under7: 0, days7to30: 0, over30: 0, none: 0 },
  }
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)) })
  await act(async () => { await Promise.resolve() })
}

async function mount(address: string): Promise<HTMLElement> {
  window.history.replaceState(null, '', address)
  await act(async () => { view = renderElement(createElement(TodosApp)) })
  await settle()
  return view!.container
}

function clickControl(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)
  expect(button, `no control labelled ${label}`).not.toBeNull()
  act(() => { button!.click() })
}

function kpi(container: HTMLElement, id: string): string {
  return container.querySelector(`[data-stats-kpi="${id}"]`)?.textContent ?? ''
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.calls.length = 0
  service.failNext = false
  service.payload = fullStats()
  useTodos.setState(original, true)
  window.history.replaceState(null, '', '/todo')
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/todo')
  vi.unstubAllGlobals()
  useTodos.setState(original, true)
})

describe('the statistics range', () => {
  it('asks the server for the range the address named, then for the one the reader picks', async () => {
    stubBreakpoint(true)
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    expect(service.calls[0], 'the shared address was not sent as the request').toEqual(RANGE)

    clickControl(container, t('todo.stats.range.7'))
    await settle()

    const today = localDate(Date.now(), 'UTC')
    const picked = service.calls.at(-1)!
    // The label changed in the first implementation bug this pins: the request has to change too.
    expect(picked.from, 'seven days were chosen but the old start was sent').toBe(shiftDay(today, -6))
    expect(picked.to).toBe(today)
    expect(picked.bucket, 'a week-wide range should default to daily buckets').toBe('day')
    expect(window.location.search).toContain(`from=${shiftDay(today, -6)}`)
    expect(window.location.search).toContain(`to=${today}`)

    clickControl(container, t('todo.stats.bucket.month'))
    await settle()
    const regrouped = service.calls.at(-1)!
    expect(regrouped.from).toBe(picked.from)
    expect(regrouped.to).toBe(picked.to)
    expect(regrouped.bucket).toBe('month')
  })
})

describe('the three states', () => {
  it('shows an empty state when the range holds no completions or creations', async () => {
    service.payload = emptyStats()
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    expect(container.textContent).toContain(t('todo.stats.empty'))
    expect(container.querySelector('[data-stats-kpi]'), 'an empty range still drew number cards').toBeNull()
  })

  it('shows the failure with a retry that asks again', async () => {
    service.failNext = true
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(t('todo.stats.error'))

    clickControl(container, t('todo.stats.retry'))
    await settle()

    expect(service.calls.length).toBeGreaterThan(1)
    expect(kpi(container, 'completed')).toContain('12')
  })
})

describe('the numbers on the screen', () => {
  it('renders each KPI from the fixture, including the on-time denominator', async () => {
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    expect(kpi(container, 'completed')).toContain('12')
    expect(kpi(container, 'created')).toContain('9')
    expect(kpi(container, 'net')).toContain('+3')
    expect(kpi(container, 'completion_rate')).toContain('75%')
    expect(kpi(container, 'on_time')).toContain('60%')
    // The denominator is the one number a reader would otherwise guess at: it is finished rows that
    // carried a due date, not every finished row and not the open ones.
    expect(kpi(container, 'on_time')).toContain(t('todo.stats.on_time_hint', { onTime: 3, due: 5 }))
    expect(kpi(container, 'median_lead')).toContain(t('todo.stats.duration.days', { value: '1.5' }))
    expect(kpi(container, 'streak')).toContain(t('todo.stats.days', { value: 4 }))
    expect(kpi(container, 'streak')).toContain(t('todo.stats.streak_hint', { days: 6 }))
    expect(kpi(container, 'overdue')).toContain('2')
  })

  it('gives the trend an accessible name and a readable table beside it', async () => {
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    const chart = container.querySelector('svg[role="img"]')
    expect(chart, 'the trend has no accessible name').not.toBeNull()
    expect(chart?.getAttribute('aria-label')).toBe(t('todo.stats.trend.chart_label', {
      from: RANGE.from,
      to: RANGE.to,
      completed: 12,
      created: 9,
    }))

    const table = container.querySelector('table[data-stats-series]')
    expect(table, 'the chart has no text equivalent').not.toBeNull()
    expect(table!.textContent).toContain('2026-10-05')
    expect(table!.textContent).toContain('2026-10-12')
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(2)
  })
})

describe('the way in', () => {
  it('offers statistics in the sidebar but not as a fifth phone tab', async () => {
    stubBreakpoint(true)
    const desktop = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)
    const sidebar = desktop.querySelector(`nav[aria-label="${t('todo.a11y.lists')}"]`)
    expect(sidebar?.textContent, 'the desktop sidebar has no statistics entry').toContain(t('todo.view.stats'))

    act(() => { view?.unmount() })
    view = null
    document.body.innerHTML = ''

    stubBreakpoint(false)
    const phone = await mount('/todo')
    const tabs = phone.querySelector(`nav[aria-label="${t('todo.app.navigation')}"]`)
    expect(tabs?.querySelectorAll('button')).toHaveLength(4)
    expect(tabs?.textContent, 'statistics took a fifth phone tab').not.toContain(t('todo.view.stats'))

    const entry = [...phone.querySelectorAll('button')]
      .find((node) => node.getAttribute('aria-label') === t('todo.view.stats'))
    expect(entry, 'a phone has no way into the statistics screen').not.toBeNull()

    act(() => { entry!.click() })
    await settle()
    expect(phone.querySelector('[data-stats-view]'), 'the phone entry did not open the screen').not.toBeNull()
    expect(window.location.search).toContain('view=stats')
  })
})
