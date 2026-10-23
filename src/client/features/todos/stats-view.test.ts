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
import { mergeSettings } from '@shared/constants'
import type { TaskStatsBucket, TodoStats, Worklog } from '@shared/todos/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { useSession } from '../../store/session'
import { shiftDay } from './due-range'
import { buildStatsCsv, statsCsvFilename } from './stats-csv'
import { weekdayName } from './stats-format'

interface StatsCall {
  from?: string
  to?: string
  bucket?: TaskStatsBucket
}

const service = vi.hoisted(() => ({
  calls: [] as StatsCall[],
  failNext: false,
  /** Ranges (as `from..to`) whose answer rejects, e.g. only the previous-period read. */
  failRanges: [] as string[],
  /** When set, every answer waits until the test releases it, so parallel requests can be observed. */
  hold: false,
  waiting: [] as Array<() => void>,
  payload: null as TodoStats | null,
  /** Answers keyed by `from..to`; anything absent falls back to `payload`. */
  byRange: {} as Record<string, TodoStats>,
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
      worklog: async () => ({
        range: { from: '2026-03-01', to: '2026-03-07', dimension: 'list' },
        totalMs: 3_600_000,
        entryCount: 1,
        byDay: [{ day: '2026-03-01', trackedMs: 3_600_000 }],
        byGroup: [{ key: 'l1', label: 'Work', trackedMs: 3_600_000 }],
        truncatedGroups: 0,
        estimatedCount: 1,
        overEstimateCount: 0,
        overEstimateRate: 0,
      }),
      stats: async (params: StatsCall = {}) => {
        service.calls.push(params)
        if (service.hold) await new Promise<void>((resolve) => service.waiting.push(resolve))
        const key = `${params.from ?? ''}..${params.to ?? ''}`
        if (service.failRanges.includes(key)) throw new Error('stats unavailable')
        if (service.failNext) {
          service.failNext = false
          throw new Error('stats unavailable')
        }
        const payload = service.byRange[key] ?? service.payload
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
const originalSession = useSession.getState()
let view: RenderedElement | null = null

const RANGE = { from: '2026-10-01', to: '2026-10-30', bucket: 'week' as const }

const DAY_MS = 86_400_000

/** The key the fake service indexes an answer by. */
function rangeKey(range: { from?: string; to?: string }): string {
  return `${range.from ?? ''}..${range.to ?? ''}`
}

/**
 * The equal-length window before a range, spelled here rather than by importing the view's helper:
 * a test that asked the implementation what to expect would agree with it by construction.
 */
function previousKey(range: { from: string; to: string }): string {
  const days = Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS) + 1
  const to = shiftDay(range.from, -1)
  return `${shiftDay(to, -(days - 1))}..${to}`
}

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
      abandoned: 4,
      abandonedRate: 0.2,
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
    flow: [
      { day: '2026-10-05', todo: 5, inProgress: 2, done: 8 },
      { day: '2026-10-12', todo: 3, inProgress: 1, done: 12 },
    ],
    flowTrackedSince: '2026-10-06',
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
      byWeekdayHour: [
        { weekday: 1, hour: 9, completed: 7 },
        { weekday: 3, hour: 17, completed: 3 },
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
      abandoned: 0,
      abandonedRate: 0,
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
    flow: [],
    flowTrackedSince: null,
    distributions: {
      byList: [],
      byTag: [],
      byPriority: stats.distributions.byPriority.map((entry) => ({ ...entry, completed: 0, share: 0 })),
      byWeekday: [],
      byHour: [],
      byWeekdayHour: [],
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

function buttonFor(container: HTMLElement, label: string): HTMLButtonElement {
  // An icon-only control carries its name in `aria-label`; a labelled one carries it as text.
  const button = [...container.querySelectorAll('button')]
    .find((node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  expect(button, `no control labelled ${label}`).not.toBeNull()
  return button as HTMLButtonElement
}

function clickControl(container: HTMLElement, label: string): void {
  const button = buttonFor(container, label)
  act(() => { button.click() })
}

/** A number card: the four headlines, or one of the four small readings below them. */
function kpi(container: HTMLElement, id: string): string {
  return container.querySelector(`[data-stats-kpi="${id}"], [data-stats-secondary="${id}"]`)?.textContent ?? ''
}

function delta(container: HTMLElement, id: string): string {
  return container.querySelector(`[data-stats-delta="${id}"]`)?.textContent?.trim() ?? ''
}

/** Let the requests held by `service.hold` answer, inside an act so their state lands in the render. */
function releaseHeld(): void {
  const waiting = service.waiting.splice(0)
  service.hold = false
  act(() => { for (const resolve of waiting) resolve() })
}

/** The account settings the statistics screen reads its goals from. */
function setGoals(dailyGoal: number | null, weeklyGoal: number | null): void {
  useSession.setState({ settings: mergeSettings({ todo: { dailyGoal, weeklyGoal } }) })
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.calls.length = 0
  service.failNext = false
  service.failRanges = []
  service.hold = false
  service.waiting.length = 0
  service.payload = fullStats()
  service.byRange = {}
  useTodos.setState(original, true)
  useSession.setState(originalSession, true)
  window.history.replaceState(null, '', '/todo')
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/todo')
  vi.unstubAllGlobals()
  useTodos.setState(original, true)
  useSession.setState(originalSession, true)
})

describe('the statistics range', () => {
  it('asks the server for the range the address named, then for the one the reader picks', async () => {
    stubBreakpoint(true)
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    expect(service.calls, 'the shared address was not sent as the request').toContainEqual(RANGE)

    clickControl(container, t('todo.stats.range.7'))
    await settle()

    const today = localDate(Date.now(), 'UTC')
    const pickedRange = { from: shiftDay(today, -6), to: today }
    // The comparison asks for another window at the same time, so the current answer is picked by its
    // days rather than by being the last call on the wire.
    const picked = service.calls.filter((call) => rangeKey(call) === rangeKey(pickedRange)).at(-1)!
    // The label changed in the first implementation bug this pins: the request has to change too.
    expect(picked.from, 'seven days were chosen but the old start was sent').toBe(pickedRange.from)
    expect(picked.to).toBe(today)
    expect(picked.bucket, 'a week-wide range should default to daily buckets').toBe('day')
    expect(window.location.search).toContain(`from=${shiftDay(today, -6)}`)
    expect(window.location.search).toContain(`to=${today}`)

    clickControl(container, t('todo.stats.bucket.month'))
    await settle()
    const regrouped = service.calls.filter((call) => rangeKey(call) === rangeKey(pickedRange)).at(-1)!
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
    // The second rate, spelled with the denominator the first one deliberately left out.
    expect(kpi(container, 'abandoned_rate')).toContain('20%')
    expect(kpi(container, 'abandoned_rate')).toContain(t('todo.stats.abandoned_rate_hint', {
      abandoned: 4,
      total: 20,
    }))
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

  it('spells the three counting rules somewhere a screen reader can reach', async () => {
    // D10: a rate whose denominator moved under the reader is the failure this guards against, so the
    // screen carries the definitions as data rather than only as prose a sighted reader may skip.
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    const table = container.querySelector('table[data-stats-definitions]')
    expect(table, 'the statistics screen states no counting rules').not.toBeNull()
    expect(table!.querySelector('caption')?.textContent).toContain(t('todo.stats.definitions.caption'))
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(table!.textContent).toContain(t('todo.stats.definitions.completion_rate'))
    expect(table!.textContent).toContain(t('todo.stats.definitions.abandoned_rate'))
    expect(table!.textContent).toContain(t('todo.stats.definitions.finished_only'))
  })
})

describe('the previous period', () => {
  it('reports every change as a dash when the previous period held nothing', async () => {
    service.byRange[previousKey(RANGE)] = emptyStats()
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    const values = [...container.querySelectorAll('[data-stats-delta]')].map((node) => node.textContent?.trim())
    expect(values, 'a zero denominator must not become a percentage').toEqual(['—', '—', '—', '—', '—'])
    expect(container.textContent, 'an infinite or undefined change reached the screen').not.toMatch(/∞|Infinity|NaN/)
  })

  it('rounds counts as percentages and rates as percentage points', async () => {
    const prior = fullStats()
    prior.summary = {
      ...prior.summary,
      completed: 9,
      created: 6,
      completionRate: 0.6,
      abandoned: 2,
      abandonedRate: 0.1,
      onTime: 3,
      onTimeDue: 6,
      onTimeRate: 0.5,
    }
    service.byRange[previousKey(RANGE)] = prior
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    // 12 against 9 is +33.33%, rounded to a whole percent; 9 against 6 is +50%.
    expect(delta(container, 'completed')).toBe('+33%')
    expect(delta(container, 'created')).toBe('+50%')
    // A rate is compared in points: 75% against 60% is +15 points, not +25%.
    expect(delta(container, 'completion_rate')).toBe(t('todo.stats.compare.points', { value: '+15' }))
    // 20% against 10% is +10 points on the same reading.
    expect(delta(container, 'abandoned_rate')).toBe(t('todo.stats.compare.points', { value: '+10' }))
    expect(delta(container, 'on_time')).toBe(t('todo.stats.compare.points', { value: '+10' }))
  })

  it('sends both reads together and keeps the KPIs when the previous one fails', async () => {
    service.hold = true
    service.failRanges = [previousKey(RANGE)]
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    // Both requests left before either answered, so the comparison is not waiting on the first page.
    expect(service.calls.map(rangeKey), 'the two reads were not issued in parallel').toEqual(
      expect.arrayContaining([rangeKey(RANGE), previousKey(RANGE)]),
    )
    expect(service.calls).toHaveLength(2)

    releaseHeld()
    await settle()

    expect(kpi(container, 'completed'), 'a failed comparison took the KPIs down with it').toContain('12')
    expect(container.textContent).toContain(t('todo.stats.compare.unavailable'))
    expect(delta(container, 'completed')).toBe('—')
  })
})

describe('the CSV export', () => {
  it('writes stable column names and both tables, with a BOM for spreadsheets', async () => {
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)
    const stats = fullStats()
    const csv = buildStatsCsv(stats)

    expect(csv.charCodeAt(0), 'the file must start with a UTF-8 BOM').toBe(0xfeff)
    expect(csv).toContain('period,completed,created')
    expect(csv).toContain('2026-10-05,8,6')
    expect(csv).toContain('2026-10-12,4,3')
    expect(csv).toContain('distribution,key,label,count')
    expect(csv).toContain(`list,,${t('todo.smart.inbox')},3`)
    expect(csv).toContain('list,L1,Work,9')
    expect(csv).toContain('tag,T1,urgent,4')
    expect(csv).toContain(`priority,high,${t('todo.priority.high')},4`)
    expect(csv).toContain(`weekday,1,${weekdayName(1)},9`)
    expect(csv).toContain('hour,9,09,7')
    expect(statsCsvFilename(stats.range)).toBe('inkstone-todo-stats-2026-10-01_2026-10-30.csv')

    expect(buttonFor(container, t('todo.stats.export.label')).disabled, 'a populated range cannot export').toBe(false)
  })

  // The hours travel with the file, in milliseconds rather than the rounded hours the bars draw: a
  // spreadsheet can divide, and it cannot undo a rounding. And when the read did not arrive the two
  // tables are absent rather than zero-filled — a file that said nobody worked would be a wrong fact,
  // while a missing table is a question the reader can ask again.
  it('carries the tracked time beside the counts, and says what the page left out', async () => {
    const tracked: Worklog = {
      range: { from: '2026-10-01', to: '2026-10-30', dimension: 'tag' },
      totalMs: 5_400_000,
      entryCount: 3,
      byDay: [{ day: '2026-10-05', trackedMs: 5_400_000 }],
      byGroup: [{ key: 'T1', label: 'urgent', trackedMs: 5_400_000 }],
      truncatedGroups: 2,
      estimatedCount: 2,
      overEstimateCount: 1,
      overEstimateRate: 0.5,
    }

    const csv = buildStatsCsv(fullStats(), tracked)

    expect(csv).toContain('period,tracked_ms')
    expect(csv).toContain('2026-10-05,5400000')
    expect(csv).toContain('# dimension,tag')
    expect(csv).toContain('group,key,label,tracked_ms')
    // The label column is the reader's language; the key is what a script joins on.
    expect(csv).toContain('tag,T1,urgent,5400000')
    expect(csv).toContain('# truncated_groups,2')
    expect(csv).toContain('# total_tracked_ms,5400000')

    expect(buildStatsCsv(fullStats())).not.toContain('tracked_ms')
  })

  it('keeps the export disabled and explains why when the range is empty', async () => {
    service.payload = emptyStats()
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    expect(buttonFor(container, t('todo.stats.export.label')).disabled).toBe(true)
    expect(container.textContent).toContain(t('todo.stats.export.empty'))
  })
})

describe('the goals the reader saved', () => {
  it('measures the range against each saved goal and words both states, not only colouring them', async () => {
    // 12 completions over the 30 days of the fixture: 0.4 a day against 1, 2.8 a week against 2.
    setGoals(1, 2)
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    const daily = container.querySelector('[data-stats-goal="daily"]')
    const weekly = container.querySelector('[data-stats-goal="weekly"]')
    expect(daily?.getAttribute('data-stats-goal-state'), '0.4 a day met a goal of 1').toBe('missed')
    expect(daily?.textContent).toContain(t('todo.stats.goal.against', {
      done: t('todo.stats.goal.per_day', { value: '0.4' }),
      goal: t('todo.stats.goal.per_day', { value: '1' }),
    }))
    expect(daily?.textContent).toContain(t('todo.stats.goal.short', {
      value: t('todo.stats.goal.per_day', { value: '0.6' }),
    }))

    expect(weekly?.getAttribute('data-stats-goal-state')).toBe('reached')
    expect(weekly?.textContent).toContain(t('todo.stats.goal.reached'))
    // The reached row says so in words and carries a check glyph, so the bar's colour is not the
    // only thing telling the two states apart.
    expect(weekly?.querySelector('[data-stats-goal-check]'), 'the reached row has no glyph').not.toBeNull()
    expect(daily?.querySelector('[data-stats-goal-check]')).toBeNull()
    expect(container.textContent).toContain(t('todo.stats.goal.hint'))
  })

  it('keeps the block off the screen when the reader saved no goal', async () => {
    const container = await mount(`/todo?view=stats&from=${RANGE.from}&to=${RANGE.to}&bucket=${RANGE.bucket}`)

    expect(container.querySelector('[data-stats-goal]'), 'an empty goal block was drawn').toBeNull()
    expect(container.textContent).not.toContain(t('todo.stats.goal.title'))
  })

  it('draws the trend reference at the daily goal rather than the range average', async () => {
    setGoals(2, null)
    const today = localDate(Date.now(), 'UTC')
    const from = shiftDay(today, -6)
    const container = await mount(`/todo?view=stats&from=${from}&to=${today}&bucket=day`)

    expect(container.textContent).toContain(t('todo.stats.goal.line'))
    expect(
      container.querySelector('svg[role="img"] line[stroke-dasharray="2 4"]'),
      'the trend has no line at the saved daily goal',
    ).not.toBeNull()
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
    expect(tabs?.querySelectorAll('button')).toHaveLength(5)
    expect(tabs?.textContent, 'the assistant is the fifth phone tab, not statistics').not.toContain(t('todo.view.stats'))

    // The phone reaches it from the header's `⋯`: four glyphs plus a title do not fit across 360px.
    const more = [...phone.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.getAttribute('aria-label') === t('todo.action.more'))
    expect(more, 'a phone has no overflow menu').not.toBeNull()
    act(() => { more!.click() })
    await settle()
    const entry = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((node) => (node.textContent ?? '').trim() === t('todo.view.stats'))
    expect(entry, 'a phone has no way into the statistics screen').not.toBeUndefined()

    act(() => { entry!.click() })
    await settle()
    expect(phone.querySelector('[data-stats-view]'), 'the phone entry did not open the screen').not.toBeNull()
    expect(window.location.search).toContain('view=stats')
  })
})
